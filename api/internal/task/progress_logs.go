package task

import (
	"math"
	"net/http"
	"strconv"

	"digitalprojectmanagement/api/internal/model"
	projectdomain "digitalprojectmanagement/api/internal/project"
	"digitalprojectmanagement/api/internal/rbac"
	"digitalprojectmanagement/api/pkg/audit"
	"digitalprojectmanagement/api/pkg/paging"
	"digitalprojectmanagement/api/pkg/timeutil"
	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

var logSorts = map[string]string{
	"id": "progress_logs.id", "task_id": "progress_logs.task_id",
	"project_id": "progress_logs.project_id", "progress": "progress_logs.progress",
	"created_at": "progress_logs.created_at",
}

func progressLogRow(row model.ProgressLog) gin.H {
	return gin.H{
		"id": row.ID, "task_id": row.TaskID, "project_id": row.ProjectID,
		"user_id": row.UserID, "progress": row.Progress, "note": row.Note,
		"remaining_days": row.RemainingDays, "created_at": row.CreatedAt,
	}
}

func (h *Handler) ListLogs(c *gin.Context) {
	user := rbac.GetCurrentUser(c)
	taskID, ok := parseQueryID(c, "task_id")
	if !ok {
		return
	}
	projectID, ok := parseQueryID(c, "project_id")
	if !ok {
		return
	}
	q := h.DB.Model(&model.ProgressLog{})
	if taskID > 0 {
		var task model.Task
		if err := h.DB.First(&task, taskID).Error; err != nil {
			c.JSON(http.StatusNotFound, gin.H{"detail": "任务不存在"})
			return
		}
		if _, err := loadTaskProject(h.DB, user, task.ProjectID, false); err != nil {
			taskError(c, err)
			return
		}
		q = q.Where("task_id = ?", taskID)
	}
	if projectID > 0 {
		if _, err := loadTaskProject(h.DB, user, projectID, false); err != nil {
			taskError(c, err)
			return
		}
		q = q.Where("project_id = ?", projectID)
	}
	if taskID == 0 && projectID == 0 {
		q = q.Where("project_id IN (?)", projectdomain.VisibleProjectIDs(h.DB, user))
	}
	page, size, ok := parsePagination(c)
	if !ok {
		return
	}
	result, err := paging.Paginate[model.ProgressLog](q.Preload("User"), page, size, c.Query("sort"), logSorts, "-id")
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"detail": err.Error()})
		return
	}
	items := make([]gin.H, 0, len(result.Items))
	for _, row := range result.Items {
		items = append(items, progressLogRow(row))
	}
	c.JSON(http.StatusOK, gin.H{"total": result.Total, "page": result.Page, "size": result.Size, "items": items})
}

func (h *Handler) CreateLog(c *gin.Context) {
	var req struct {
		TaskID        uint    `json:"task_id"`
		Progress      float64 `json:"progress"`
		Note          string  `json:"note"`
		RemainingDays *int    `json:"remaining_days"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "请求格式错误"})
		return
	}
	if req.TaskID == 0 || req.Progress < 0 || req.Progress > 100 || math.IsNaN(req.Progress) || math.IsInf(req.Progress, 0) {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "task_id 须有效且进度须为 0-100"})
		return
	}
	if req.RemainingDays != nil && (*req.RemainingDays < 0 || *req.RemainingDays > 3650) {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "剩余天数须为 0-3650 的整数"})
		return
	}
	user := rbac.GetCurrentUser(c)
	var response gin.H
	err := h.DB.Transaction(func(tx *gorm.DB) error {
		var task model.Task
		if err := tx.Clauses(taskUpdateLock).First(&task, req.TaskID).Error; err != nil {
			return err
		}
		projectRow, err := loadTaskProject(tx, user, task.ProjectID, true)
		if err != nil {
			return err
		}
		if !user.IsSuperAdmin && (projectRow.OwnerID == nil || *projectRow.OwnerID != user.ID) && (task.OwnerID == nil || *task.OwnerID != user.ID) {
			return errTaskForbidden
		}
		if err := checkDependencyReady(tx, task, "", &req.Progress); err != nil {
			return err
		}
		oldStatus := task.Status
		task.Progress = req.Progress
		if req.Progress >= 100 {
			task.Status = "done"
		} else if req.Progress > 0 && (task.Status == "todo" || task.Status == "done") {
			task.Status = "doing"
		}
		now := timeutil.NowDateTime()
		task.UpdatedAt = now
		if err := tx.Save(&task).Error; err != nil {
			return err
		}
		logRow := model.ProgressLog{
			TaskID: task.ID, ProjectID: task.ProjectID, UserID: &user.ID,
			Progress: req.Progress, Note: req.Note, RemainingDays: req.RemainingDays,
			CreatedAt: now,
		}
		if err := tx.Create(&logRow).Error; err != nil {
			return err
		}
		if err := audit.CommitAudited(tx, &user.ID, "report_progress", "progress_logs", strconv.FormatUint(uint64(logRow.ID), 10), "task="+strconv.FormatUint(uint64(task.ID), 10), c.ClientIP()); err != nil {
			return err
		}
		response = gin.H{"id": logRow.ID, "progress": task.Progress, "status": task.Status, "from_status": oldStatus}
		return nil
	})
	if err != nil {
		taskError(c, err)
		return
	}
	c.JSON(http.StatusCreated, response)
}

func (h *Handler) GetLog(c *gin.Context) {
	id, ok := parsePathID(c, "lid")
	if !ok {
		return
	}
	var row model.ProgressLog
	if err := h.DB.First(&row, id).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"detail": "填报记录不存在"})
		return
	}
	if _, err := loadTaskProject(h.DB, rbac.GetCurrentUser(c), row.ProjectID, false); err != nil {
		taskError(c, err)
		return
	}
	c.JSON(http.StatusOK, progressLogRow(row))
}
