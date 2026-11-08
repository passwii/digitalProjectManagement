package project

import (
	"encoding/json"
	"net/http"
	"sort"
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

var followupMethods = map[string]bool{"电话": true, "会议": true, "现场": true, "邮件": true, "其他": true}
var followupStates = map[string]bool{"pending": true, "done": true, "ignored": true}

func (h *Handler) ListFollowups(c *gin.Context) {
	projectID, ok := parseID(c, "pid")
	if !ok {
		return
	}
	if _, err := LoadVisibleProject(h.DB, rbac.GetCurrentUser(c), projectID); err != nil {
		writeError(c, http.StatusNotFound, "项目不存在")
		return
	}
	page, size, ok := pagination(c)
	if !ok {
		return
	}
	q := h.DB.Model(&model.Followup{}).Where("project_id = ?", projectID)
	if userID, ok := queryInt(c, "user_id", 0); !ok {
		return
	} else if userID > 0 {
		q = q.Where("user_id = ?", userID)
	}
	if state := strings.TrimSpace(c.Query("remind_state")); state != "" {
		if !followupStates[state] {
			writeError(c, http.StatusBadRequest, "remind_state 无效")
			return
		}
		q = q.Where("remind_state = ?", state)
	}
	for _, filter := range []struct {
		name     string
		operator string
	}{
		{"date_from", ">="}, {"date_to", "<="},
	} {
		if raw := strings.TrimSpace(c.Query(filter.name)); raw != "" {
			date, err := parseQueryDate(raw)
			if err != nil {
				writeError(c, http.StatusBadRequest, filter.name+" 格式须为 YYYY-MM-DD")
				return
			}
			q = q.Where("happened_at "+filter.operator+" ?", date.Time)
		}
	}
	allowed := map[string]string{
		"id": "followups.id", "happened_at": "followups.happened_at",
		"remind_at": "followups.remind_at", "user_id": "followups.user_id",
	}
	result, err := paging.Paginate[model.Followup](q, page, size, c.Query("sort"), allowed, "-id")
	if err != nil {
		writeError(c, http.StatusBadRequest, err.Error())
		return
	}
	c.JSON(http.StatusOK, result)
}

func parseQueryDate(raw string) (timeutil.Date, error) {
	var value timeutil.Date
	err := value.UnmarshalJSON([]byte(`"` + raw + `"`))
	return value, err
}

func (h *Handler) CreateFollowup(c *gin.Context) {
	projectID, ok := parseID(c, "pid")
	if !ok {
		return
	}
	var req struct {
		HappenedAt *timeutil.DateTime `json:"happened_at"`
		Method     string             `json:"method"`
		Content    string             `json:"content"`
		NextStep   string             `json:"next_step"`
		RemindAt   *timeutil.DateTime `json:"remind_at"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		writeError(c, http.StatusBadRequest, "请求格式错误")
		return
	}
	projectRow, err := loadWritableProject(h.DB, rbac.GetCurrentUser(c), projectID)
	if err != nil {
		if err == gorm.ErrRecordNotFound {
			writeError(c, http.StatusNotFound, "项目不存在")
		} else {
			writeError(c, http.StatusBadRequest, err.Error())
		}
		return
	}
	_ = projectRow
	req.Method = strings.TrimSpace(req.Method)
	if req.Method != "" && !followupMethods[req.Method] {
		writeError(c, http.StatusBadRequest, "跟进方式无效")
		return
	}
	now := timeutil.NowDateTime()
	happened := now
	if req.HappenedAt != nil && !req.HappenedAt.IsZero() {
		happened = *req.HappenedAt
	}
	if req.RemindAt != nil && req.RemindAt.Before(happened.Time) {
		writeError(c, http.StatusBadRequest, "提醒时间不能早于跟进时间")
		return
	}
	state := "none"
	if req.RemindAt != nil {
		state = "pending"
	}
	user := rbac.GetCurrentUser(c)
	row := model.Followup{
		ProjectID: projectID, UserID: &user.ID, HappenedAt: happened,
		Method: req.Method, Content: req.Content, NextStep: req.NextStep,
		RemindAt: req.RemindAt, RemindState: state, CreatedAt: now,
	}
	err = h.DB.Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(&row).Error; err != nil {
			return err
		}
		return audit.CommitAudited(tx, &user.ID, "create_followup", "followups", strconv.FormatUint(uint64(row.ID), 10), strconv.FormatUint(uint64(projectID), 10), c.ClientIP())
	})
	if err != nil {
		writeError(c, http.StatusInternalServerError, "创建跟进记录失败")
		return
	}
	c.JSON(http.StatusCreated, gin.H{"id": row.ID, "remind_state": row.RemindState})
}

func (h *Handler) followup(c *gin.Context, projectID, followupID uint, lock bool) (model.Followup, error) {
	q := h.DB
	if lock {
		q = q.Clauses(clauseUpdateLock)
	}
	var row model.Followup
	err := q.Where("id = ? AND project_id = ?", followupID, projectID).First(&row).Error
	return row, err
}

func (h *Handler) PatchFollowup(c *gin.Context) {
	projectID, ok := parseID(c, "pid")
	if !ok {
		return
	}
	followupID, ok := parseID(c, "fid")
	if !ok {
		return
	}
	var body map[string]json.RawMessage
	if err := c.ShouldBindJSON(&body); err != nil {
		writeError(c, http.StatusBadRequest, "请求格式错误")
		return
	}
	if body == nil {
		writeError(c, http.StatusBadRequest, "请求体须为 JSON 对象")
		return
	}
	user := rbac.GetCurrentUser(c)
	var response gin.H
	err := h.DB.Transaction(func(tx *gorm.DB) error {
		projectRow, err := loadWritableProject(tx, user, projectID)
		if err != nil {
			return err
		}
		if projectRow.Status == "archived" {
			return errProjectArchived
		}
		var row model.Followup
		if err := tx.Clauses(clauseUpdateLock).Where("id = ? AND project_id = ?", followupID, projectID).First(&row).Error; err != nil {
			return err
		}
		if !user.IsSuperAdmin && (row.UserID == nil || *row.UserID != user.ID) {
			return errFollowupForbidden
		}
		for key := range body {
			switch key {
			case "happened_at", "method", "content", "next_step", "remind_at":
			default:
				return errInvalidField
			}
		}
		if raw, exists := body["method"]; exists {
			if err := json.Unmarshal(raw, &row.Method); err != nil {
				return errInvalidField
			}
			row.Method = strings.TrimSpace(row.Method)
			if row.Method != "" && !followupMethods[row.Method] {
				return errInvalidFollowupMethod
			}
		}
		if raw, exists := body["content"]; exists {
			if err := json.Unmarshal(raw, &row.Content); err != nil {
				return errInvalidField
			}
		}
		if raw, exists := body["next_step"]; exists {
			if err := json.Unmarshal(raw, &row.NextStep); err != nil {
				return errInvalidField
			}
		}
		if raw, exists := body["happened_at"]; exists {
			value, err := dateTimeValue(raw)
			if err != nil || value == nil {
				return errInvalidField
			}
			row.HappenedAt = *value
		}
		if raw, exists := body["remind_at"]; exists {
			value, err := dateTimeValue(raw)
			if err != nil {
				return err
			}
			row.RemindAt = value
			if value == nil {
				row.RemindState = "none"
				row.RemindedAt, row.HandledAt, row.HandledBy, row.HandleNote = nil, nil, nil, ""
			} else if row.RemindState == "" || row.RemindState == "none" {
				row.RemindState = "pending"
				row.RemindedAt, row.HandledAt, row.HandledBy, row.HandleNote = nil, nil, nil, ""
			}
		}
		if row.RemindAt != nil && row.RemindAt.Before(row.HappenedAt.Time) {
			return errInvalidReminderTime
		}
		if err := tx.Save(&row).Error; err != nil {
			return err
		}
		if err := audit.CommitAudited(tx, &user.ID, "update_followup", "followups", strconv.FormatUint(uint64(followupID), 10), strings.Join(sortedKeys(body), ","), c.ClientIP()); err != nil {
			return err
		}
		response = gin.H{
			"id": row.ID, "content": row.Content, "next_step": row.NextStep,
			"method": row.Method, "remind_state": row.RemindState,
			"happened_at": timeText(&row.HappenedAt), "remind_at": timeText(row.RemindAt),
		}
		return nil
	})
	if err != nil {
		switch err {
		case gorm.ErrRecordNotFound:
			writeError(c, http.StatusNotFound, "跟进记录不存在")
		case errFollowupForbidden:
			writeError(c, http.StatusForbidden, "仅记录人或超级管理员可修改")
		case errProjectArchived, errInvalidField, errInvalidReminderTime, errInvalidFollowupMethod:
			detail := "跟进记录字段无效"
			if err == errProjectArchived {
				detail = "已归档项目只读"
			} else if err == errInvalidReminderTime {
				detail = "提醒时间不能早于跟进时间"
			} else if err == errInvalidFollowupMethod {
				detail = "跟进方式无效"
			}
			writeError(c, http.StatusBadRequest, detail)
		default:
			writeError(c, http.StatusInternalServerError, "更新跟进记录失败")
		}
		return
	}
	c.JSON(http.StatusOK, response)
}

func (h *Handler) HandleFollowupReminder(c *gin.Context) {
	projectID, ok := parseID(c, "pid")
	if !ok {
		return
	}
	followupID, ok := parseID(c, "fid")
	if !ok {
		return
	}
	var req struct {
		State string `json:"state"`
		Note  string `json:"note"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		writeError(c, http.StatusBadRequest, "请求格式错误")
		return
	}
	if req.State == "" {
		req.State = "done"
	}
	if !followupStates[req.State] {
		writeError(c, http.StatusBadRequest, "提醒状态无效")
		return
	}
	user := rbac.GetCurrentUser(c)
	var response gin.H
	err := h.DB.Transaction(func(tx *gorm.DB) error {
		if _, err := loadWritableProject(tx, user, projectID); err != nil {
			return err
		}
		var row model.Followup
		if err := tx.Clauses(clauseUpdateLock).Where("id = ? AND project_id = ?", followupID, projectID).First(&row).Error; err != nil {
			return err
		}
		if !user.IsSuperAdmin && (row.UserID == nil || *row.UserID != user.ID) {
			return errFollowupForbidden
		}
		if row.RemindAt == nil {
			return errNoReminder
		}
		now := timeutil.NowDateTime()
		row.RemindState = req.State
		row.HandledAt = &now
		row.HandledBy = &user.ID
		row.HandleNote = strings.TrimSpace(req.Note)
		if req.State == "pending" {
			row.HandledAt, row.HandledBy, row.HandleNote = nil, nil, ""
		}
		if req.State == "done" {
			row.RemindedAt = &now
		}
		if err := tx.Save(&row).Error; err != nil {
			return err
		}
		if err := audit.CommitAudited(tx, &user.ID, "handle_followup_remind", "followups", strconv.FormatUint(uint64(followupID), 10), "state="+req.State, c.ClientIP()); err != nil {
			return err
		}
		response = gin.H{"id": row.ID, "remind_state": row.RemindState, "handled_at": timeText(row.HandledAt), "handled_by": row.HandledBy, "handle_note": row.HandleNote}
		return nil
	})
	if err != nil {
		switch err {
		case gorm.ErrRecordNotFound:
			writeError(c, http.StatusNotFound, "跟进记录不存在")
		case errFollowupForbidden:
			writeError(c, http.StatusForbidden, "仅记录人或超级管理员可处理提醒")
		case errNoReminder:
			writeError(c, http.StatusBadRequest, "该跟进没有设置提醒时间")
		default:
			writeError(c, http.StatusInternalServerError, "处理跟进提醒失败")
		}
		return
	}
	c.JSON(http.StatusOK, response)
}

func (h *Handler) DeleteFollowup(c *gin.Context) {
	projectID, ok := parseID(c, "pid")
	if !ok {
		return
	}
	followupID, ok := parseID(c, "fid")
	if !ok {
		return
	}
	user := rbac.GetCurrentUser(c)
	err := h.DB.Transaction(func(tx *gorm.DB) error {
		if _, err := loadWritableProject(tx, user, projectID); err != nil {
			return err
		}
		var row model.Followup
		if err := tx.Clauses(clauseUpdateLock).Where("id = ? AND project_id = ?", followupID, projectID).First(&row).Error; err != nil {
			return err
		}
		if !user.IsSuperAdmin && (row.UserID == nil || *row.UserID != user.ID) {
			return errFollowupForbidden
		}
		if err := tx.Delete(&row).Error; err != nil {
			return err
		}
		return audit.CommitAudited(tx, &user.ID, "delete_followup", "followups", strconv.FormatUint(uint64(followupID), 10), strconv.FormatUint(uint64(projectID), 10), c.ClientIP())
	})
	if err != nil {
		if err == gorm.ErrRecordNotFound {
			writeError(c, http.StatusNotFound, "跟进记录不存在")
		} else if err == errFollowupForbidden {
			writeError(c, http.StatusForbidden, "仅记录人或超级管理员可删除")
		} else {
			writeError(c, http.StatusInternalServerError, "删除跟进记录失败")
		}
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func sortedFollowupKeys(body map[string]json.RawMessage) []string {
	keys := make([]string, 0, len(body))
	for key := range body {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

var (
	errFollowupForbidden     = gorm.ErrInvalidTransaction
	errInvalidFollowupMethod = gorm.ErrInvalidData
	errInvalidReminderTime   = gorm.ErrInvalidDB
	errNoReminder            = gorm.ErrEmptySlice
)
