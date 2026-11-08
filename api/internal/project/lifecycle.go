package project

import (
	"net/http"
	"strconv"
	"strings"

	"digitalprojectmanagement/api/internal/model"
	"digitalprojectmanagement/api/internal/rbac"
	"digitalprojectmanagement/api/pkg/audit"
	"digitalprojectmanagement/api/pkg/paging"
	"digitalprojectmanagement/api/pkg/timeutil"
	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

func (h *Handler) ChangeStatus(c *gin.Context) {
	id, ok := parseID(c, "pid")
	if !ok {
		return
	}
	var req struct {
		Status string `json:"status"`
		Reason string `json:"reason"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || strings.TrimSpace(req.Status) == "" {
		writeError(c, http.StatusBadRequest, "status 必填")
		return
	}
	user := rbac.GetCurrentUser(c)
	var result model.Project
	err := h.DB.Transaction(func(tx *gorm.DB) error {
		row, err := LoadVisibleProject(tx, user, id)
		if err != nil {
			return err
		}
		if !allowedStatusTransition(row.Status, req.Status, user.IsSuperAdmin) {
			return errInvalidTransition
		}
		if req.Status == "archived" && !user.IsSuperAdmin && (row.OwnerID == nil || *row.OwnerID != user.ID) {
			return errArchiveForbidden
		}
		old := row.Status
		row.Status = req.Status
		row.UpdatedAt = timeutil.NowDateTime()
		if err := tx.Save(&row).Error; err != nil {
			return err
		}
		if err := projectChange(tx, id, "status", old, req.Status, user.ID, row.UpdatedAt); err != nil {
			return err
		}
		action := "status"
		if old == "pending" && req.Status == "filed" {
			action = "approve"
		} else if req.Status == "cancelled" && (old == "pending" || old == "draft" || old == "filed") {
			action = "reject"
		}
		projectID := id
		if err := tx.Create(&model.ApprovalRecord{
			Kind: "project_filing", RefID: id, ProjectID: &projectID,
			Action: action, FromStatus: old, ToStatus: req.Status,
			ActorID: &user.ID, Reason: strings.TrimSpace(req.Reason),
			CreatedAt: row.UpdatedAt,
		}).Error; err != nil {
			return err
		}
		if err := audit.CommitAudited(tx, &user.ID, "project_status", "projects", strconv.FormatUint(uint64(id), 10), old+"->"+req.Status+" "+strings.TrimSpace(req.Reason), c.ClientIP()); err != nil {
			return err
		}
		result = row
		return nil
	})
	if err != nil {
		switch err {
		case gorm.ErrRecordNotFound:
			writeError(c, http.StatusNotFound, "项目不存在")
		case errInvalidTransition:
			writeError(c, http.StatusBadRequest, "不允许从当前状态流转到目标状态")
		case errArchiveForbidden:
			writeError(c, http.StatusForbidden, "仅负责人或超级管理员可归档")
		default:
			writeError(c, http.StatusInternalServerError, "更新项目状态失败")
		}
		return
	}
	c.JSON(http.StatusOK, result)
}

func (h *Handler) Changes(c *gin.Context) {
	id, ok := parseID(c, "pid")
	if !ok {
		return
	}
	if _, err := LoadVisibleProject(h.DB, rbac.GetCurrentUser(c), id); err != nil {
		if err == gorm.ErrRecordNotFound {
			writeError(c, http.StatusNotFound, "项目不存在")
		} else {
			writeError(c, http.StatusInternalServerError, "查询项目失败")
		}
		return
	}
	page, size, ok := pagination(c)
	if !ok {
		return
	}
	sortFields := map[string]string{"id": "project_changes.id", "at": "project_changes.at", "field": "project_changes.field"}
	q := h.DB.Model(&model.ProjectChange{}).Preload("User").Where("project_id = ?", id)
	result, err := paging.Paginate[model.ProjectChange](q, page, size, c.Query("sort"), sortFields, "-id")
	if err != nil {
		writeError(c, http.StatusBadRequest, err.Error())
		return
	}
	c.JSON(http.StatusOK, result)
}

func (h *Handler) Progress(c *gin.Context) {
	id, ok := parseID(c, "pid")
	if !ok {
		return
	}
	user := rbac.GetCurrentUser(c)
	projectRow, err := LoadVisibleProject(h.DB, user, id)
	if err != nil {
		if err == gorm.ErrRecordNotFound {
			writeError(c, http.StatusNotFound, "项目不存在")
		} else {
			writeError(c, http.StatusInternalServerError, "查询项目失败")
		}
		return
	}
	var tasks []model.Task
	if err := h.DB.Where("project_id = ?", id).Find(&tasks).Error; err != nil {
		writeError(c, http.StatusInternalServerError, "查询任务进度失败")
		return
	}
	progress := weightedProgress(tasks)
	if err := h.DB.Model(&model.Project{}).Where("id = ?", projectRow.ID).Update("progress", progress).Error; err != nil {
		writeError(c, http.StatusInternalServerError, "更新项目进度快照失败")
		return
	}
	c.JSON(http.StatusOK, gin.H{"project_id": id, "progress": progress, "task_count": len(tasks)})
}

func weightedProgress(tasks []model.Task) float64 {
	if len(tasks) == 0 {
		return 0
	}
	var weighted, total float64
	for _, task := range tasks {
		weight := task.Weight
		if weight <= 0 {
			weight = 1
		}
		weighted += task.Progress * weight
		total += weight
	}
	if total == 0 {
		return 0
	}
	return float64(int(weighted/total*100+0.5)) / 100
}

func (h *Handler) ConfirmProgress(c *gin.Context) {
	id, ok := parseID(c, "pid")
	if !ok {
		return
	}
	user := rbac.GetCurrentUser(c)
	var response gin.H
	err := h.DB.Transaction(func(tx *gorm.DB) error {
		row, err := LoadVisibleProject(tx, user, id)
		if err != nil {
			return err
		}
		if !user.IsSuperAdmin && (row.OwnerID == nil || *row.OwnerID != user.ID) {
			return errConfirmForbidden
		}
		var tasks []model.Task
		if err := tx.Where("project_id = ?", id).Find(&tasks).Error; err != nil {
			return err
		}
		old := row.Progress
		value := weightedProgress(tasks)
		now := timeutil.NowDateTime()
		row.Progress, row.UpdatedAt = value, now
		if err := tx.Save(&row).Error; err != nil {
			return err
		}
		if err := projectChange(tx, id, "progress_snapshot", strconv.FormatFloat(old, 'f', -1, 64), strconv.FormatFloat(value, 'f', -1, 64), user.ID, now); err != nil {
			return err
		}
		if err := audit.CommitAudited(tx, &user.ID, "confirm_progress", "projects", strconv.FormatUint(uint64(id), 10), "snapshot confirmed", c.ClientIP()); err != nil {
			return err
		}
		response = gin.H{"project_id": id, "progress": value, "task_count": len(tasks), "confirmed_by": user.ID, "confirmed_at": timeText(&now)}
		return nil
	})
	if err != nil {
		switch err {
		case gorm.ErrRecordNotFound:
			writeError(c, http.StatusNotFound, "项目不存在")
		case errConfirmForbidden:
			writeError(c, http.StatusForbidden, "仅负责人或超级管理员可确认")
		default:
			writeError(c, http.StatusInternalServerError, "确认项目进度失败")
		}
		return
	}
	c.JSON(http.StatusOK, response)
}

var (
	errInvalidTransition = gorm.ErrInvalidData
	errArchiveForbidden  = gorm.ErrInvalidTransaction
	errConfirmForbidden  = gorm.ErrInvalidDB
)
