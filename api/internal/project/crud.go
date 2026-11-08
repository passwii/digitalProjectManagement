package project

import (
	"encoding/json"
	"fmt"
	"math"
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
	"github.com/google/uuid"
	"gorm.io/gorm"
)

type createProjectRequest struct {
	Code        string         `json:"code"`
	Name        string         `json:"name"`
	Type        string         `json:"type"`
	Status      string         `json:"status"`
	Priority    string         `json:"priority"`
	ClientName  string         `json:"client_name"`
	OwnerID     *uint          `json:"owner_id"`
	DeptID      *uint          `json:"dept_id"`
	PlanStart   *timeutil.Date `json:"plan_start"`
	PlanEnd     *timeutil.Date `json:"plan_end"`
	BudgetTotal float64        `json:"budget_total"`
	Description string         `json:"description"`
	MemberIDs   []uint         `json:"member_ids"`
}

func generatedProjectCode() string {
	return "PRJ-" + timeutil.AppNow().Format("20060102") + "-" + strings.ToUpper(uuid.NewString()[:8])
}

func (h *Handler) Create(c *gin.Context) {
	var req createProjectRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		writeError(c, http.StatusBadRequest, "请求格式错误")
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" {
		writeError(c, http.StatusBadRequest, "项目名称必填")
		return
	}
	if len([]rune(req.Name)) > 128 {
		writeError(c, http.StatusBadRequest, "项目名称最多 128 个字符")
		return
	}
	if req.BudgetTotal < 0 || math.IsNaN(req.BudgetTotal) || math.IsInf(req.BudgetTotal, 0) {
		writeError(c, http.StatusBadRequest, "项目预算须为大于等于 0 的有效数字")
		return
	}
	if req.PlanStart != nil && req.PlanEnd != nil && req.PlanStart.After(req.PlanEnd.Time) {
		writeError(c, http.StatusBadRequest, "计划开始不能晚于结束")
		return
	}
	user := rbac.GetCurrentUser(c)
	now := timeutil.NowDateTime()
	var created model.Project
	err := h.DB.Transaction(func(tx *gorm.DB) error {
		if tx.Where("name = ? AND deleted_at IS NULL", req.Name).First(&model.Project{}).Error == nil {
			return errDuplicateProjectName
		}
		code := strings.TrimSpace(req.Code)
		if code == "" {
			code = generatedProjectCode()
		}
		if len(code) > 32 {
			return errProjectCodeTooLong
		}
		var count int64
		if err := tx.Model(&model.Project{}).Where("code = ?", code).Count(&count).Error; err != nil {
			return err
		}
		if count > 0 {
			return errDuplicateProjectCode
		}

		ownerID := user.ID
		if req.OwnerID != nil && *req.OwnerID > 0 {
			ownerID = *req.OwnerID
		}
		var owner model.User
		if err := tx.First(&owner, ownerID).Error; err != nil {
			return errInvalidOwner
		}
		deptID := req.DeptID
		if deptID == nil {
			deptID = user.DeptID
		}
		if deptID != nil {
			var department model.Department
			if err := tx.First(&department, *deptID).Error; err != nil {
				return errInvalidDepartment
			}
		}
		var approval model.SysParam
		approvalOn := tx.Where("key = ?", "project_approval_on").First(&approval).Error == nil && approval.Value == "1"
		status := "draft"
		if approvalOn {
			status = "pending"
		}
		if req.Type == "" {
			req.Type = "other"
		}
		if req.Priority == "" {
			req.Priority = "中"
		}
		created = model.Project{
			Code: code, Name: req.Name, Type: req.Type, Status: status,
			Priority: req.Priority, ClientName: strings.TrimSpace(req.ClientName),
			OwnerID: &ownerID, DeptID: deptID, PlanStart: req.PlanStart,
			PlanEnd: req.PlanEnd, BudgetTotal: req.BudgetTotal,
			Description: req.Description, CreatedAt: now, UpdatedAt: now,
		}
		if err := tx.Create(&created).Error; err != nil {
			return err
		}
		memberIDs := map[uint]struct{}{ownerID: {}}
		for _, id := range req.MemberIDs {
			if id > 0 {
				memberIDs[id] = struct{}{}
			}
		}
		for id := range memberIDs {
			var member model.User
			if err := tx.First(&member, id).Error; err != nil {
				return errInvalidMember
			}
			if err := tx.Create(&model.ProjectMember{ProjectID: created.ID, UserID: id}).Error; err != nil {
				return err
			}
		}
		if err := projectChange(tx, created.ID, "created", "", created.Code+" "+created.Name, user.ID, now); err != nil {
			return err
		}
		if approvalOn {
			projectID := created.ID
			if err := tx.Create(&model.ApprovalRecord{
				Kind: "project_filing", RefID: created.ID, ProjectID: &projectID,
				Action: "submit", FromStatus: "draft", ToStatus: "pending",
				ActorID: &user.ID, CreatedAt: now,
			}).Error; err != nil {
				return err
			}
		}
		return audit.CommitAudited(tx, &user.ID, "create_project", "projects", strconv.FormatUint(uint64(created.ID), 10), created.Code, c.ClientIP())
	})
	if err != nil {
		switch err {
		case errDuplicateProjectName:
			writeError(c, http.StatusBadRequest, "项目名称已存在")
		case errProjectCodeTooLong:
			writeError(c, http.StatusBadRequest, "项目编号最多 32 个字符")
		case errDuplicateProjectCode:
			writeError(c, http.StatusBadRequest, "项目编号已存在")
		case errInvalidOwner:
			writeError(c, http.StatusBadRequest, "项目负责人不存在")
		case errInvalidDepartment:
			writeError(c, http.StatusBadRequest, "项目部门不存在")
		case errInvalidMember:
			writeError(c, http.StatusBadRequest, "项目成员不存在")
		default:
			writeError(c, http.StatusInternalServerError, "创建项目失败")
		}
		return
	}
	var result model.Project
	if err := h.DB.Preload("Owner").Preload("Department").First(&result, created.ID).Error; err != nil {
		result = created
	}
	c.JSON(http.StatusCreated, result)
}

var (
	errDuplicateProjectName = fmt.Errorf("duplicate project name")
	errProjectCodeTooLong   = fmt.Errorf("project code too long")
	errDuplicateProjectCode = fmt.Errorf("duplicate project code")
	errInvalidOwner         = fmt.Errorf("invalid project owner")
	errInvalidDepartment    = fmt.Errorf("invalid project department")
	errInvalidMember        = fmt.Errorf("invalid project member")
)

func (h *Handler) Patch(c *gin.Context) {
	id, ok := parseID(c, "pid")
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
	allowed := map[string]bool{
		"code": true, "name": true, "type": true, "priority": true,
		"client_name": true, "owner_id": true, "dept_id": true,
		"plan_start": true, "plan_end": true, "budget_total": true, "description": true,
	}
	for field := range body {
		if !allowed[field] {
			writeError(c, http.StatusBadRequest, "不支持的字段："+field)
			return
		}
	}
	user := rbac.GetCurrentUser(c)
	now := timeutil.NowDateTime()
	var result model.Project
	err := h.DB.Transaction(func(tx *gorm.DB) error {
		row, err := LoadVisibleProject(tx, user, id)
		if err != nil {
			return err
		}
		if row.Status == "archived" {
			return errProjectArchived
		}
		changes := make([]model.ProjectChange, 0, len(body))
		record := func(field, oldValue, newValue string) {
			if oldValue == newValue {
				return
			}
			changes = append(changes, model.ProjectChange{
				ProjectID: id, Field: field, Old: oldValue, New: newValue,
				ByID: &user.ID, At: now,
			})
		}
		for field, raw := range body {
			switch field {
			case "code", "name", "type", "priority", "client_name", "description":
				var value string
				if string(raw) != "null" {
					if err := json.Unmarshal(raw, &value); err != nil {
						return errInvalidField
					}
				}
				value = strings.TrimSpace(value)
				if field == "name" && value == "" {
					return errInvalidField
				}
				if field == "code" {
					if value == "" || len(value) > 32 {
						return errInvalidField
					}
					var count int64
					if err := tx.Model(&model.Project{}).Where("code = ? AND id <> ?", value, id).Count(&count).Error; err != nil {
						return err
					}
					if count > 0 {
						return errDuplicateProjectCode
					}
				}
				if field == "name" {
					var count int64
					if err := tx.Model(&model.Project{}).Where("name = ? AND id <> ? AND deleted_at IS NULL", value, id).Count(&count).Error; err != nil {
						return err
					}
					if count > 0 {
						return errDuplicateProjectName
					}
				}
				var old string
				switch field {
				case "code":
					old = row.Code
					row.Code = value
				case "name":
					old = row.Name
					row.Name = value
				case "type":
					old = row.Type
					row.Type = value
				case "priority":
					old = row.Priority
					row.Priority = value
				case "client_name":
					old = row.ClientName
					row.ClientName = value
				case "description":
					old = row.Description
					row.Description = value
				}
				record(field, old, value)
			case "owner_id", "dept_id":
				var value *uint
				if string(raw) != "null" {
					var numeric uint
					if err := json.Unmarshal(raw, &numeric); err != nil {
						return errInvalidField
					}
					if numeric > 0 {
						value = &numeric
						if field == "owner_id" {
							var userRow model.User
							if err := tx.First(&userRow, numeric).Error; err != nil {
								return errInvalidOwner
							}
						} else {
							var department model.Department
							if err := tx.First(&department, numeric).Error; err != nil {
								return errInvalidDepartment
							}
						}
					}
				}
				var oldValue string
				var oldPtr *uint
				if field == "owner_id" {
					oldPtr = row.OwnerID
					row.OwnerID = value
					if value != nil {
						if err := tx.Where("project_id = ? AND user_id = ?", id, *value).FirstOrCreate(&model.ProjectMember{}, model.ProjectMember{ProjectID: id, UserID: *value}).Error; err != nil {
							return err
						}
					}
				} else {
					oldPtr = row.DeptID
					row.DeptID = value
				}
				if oldPtr != nil {
					oldValue = strconv.FormatUint(uint64(*oldPtr), 10)
				}
				newValue := ""
				if value != nil {
					newValue = strconv.FormatUint(uint64(*value), 10)
				}
				record(field, oldValue, newValue)
			case "plan_start", "plan_end":
				value, err := dateValue(raw)
				if err != nil {
					return err
				}
				var oldValue string
				if field == "plan_start" {
					oldValue = dateText(row.PlanStart)
					row.PlanStart = value
				} else {
					oldValue = dateText(row.PlanEnd)
					row.PlanEnd = value
				}
				record(field, oldValue, dateText(value))
			case "budget_total":
				var value float64
				if err := json.Unmarshal(raw, &value); err != nil || math.IsNaN(value) || math.IsInf(value, 0) || value < 0 {
					return errInvalidField
				}
				oldValue := strconv.FormatFloat(row.BudgetTotal, 'f', -1, 64)
				row.BudgetTotal = value
				record(field, oldValue, strconv.FormatFloat(value, 'f', -1, 64))
			}
		}
		if row.PlanStart != nil && row.PlanEnd != nil && row.PlanStart.After(row.PlanEnd.Time) {
			return errInvalidProjectDates
		}
		row.UpdatedAt = now
		if err := tx.Save(&row).Error; err != nil {
			return err
		}
		if len(changes) > 0 {
			if err := tx.Create(&changes).Error; err != nil {
				return err
			}
		}
		if err := audit.CommitAudited(tx, &user.ID, "update_project", "projects", strconv.FormatUint(uint64(id), 10), strings.Join(sortedKeys(body), ","), c.ClientIP()); err != nil {
			return err
		}
		result = row
		return nil
	})
	if err != nil {
		switch err {
		case gorm.ErrRecordNotFound:
			writeError(c, http.StatusNotFound, "项目不存在")
		case errProjectArchived, errInvalidField, errInvalidProjectDates, errDuplicateProjectCode, errDuplicateProjectName, errInvalidOwner, errInvalidDepartment:
			detail := "项目字段无效"
			switch err {
			case errProjectArchived:
				detail = "已归档项目只读"
			case errInvalidProjectDates:
				detail = "计划开始不能晚于结束"
			case errDuplicateProjectCode:
				detail = "项目编号已存在"
			case errDuplicateProjectName:
				detail = "项目名称已存在"
			case errInvalidOwner:
				detail = "项目负责人不存在"
			case errInvalidDepartment:
				detail = "项目部门不存在"
			}
			writeError(c, http.StatusBadRequest, detail)
		default:
			writeError(c, http.StatusInternalServerError, "更新项目失败")
		}
		return
	}
	c.JSON(http.StatusOK, result)
}

var (
	errInvalidField        = fmt.Errorf("invalid field")
	errInvalidProjectDates = fmt.Errorf("invalid project date range")
)

func sortedKeys(values map[string]json.RawMessage) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func (h *Handler) Delete(c *gin.Context) {
	id, ok := parseID(c, "pid")
	if !ok {
		return
	}
	user := rbac.GetCurrentUser(c)
	now := timeutil.NowDateTime()
	err := h.DB.Transaction(func(tx *gorm.DB) error {
		var row model.Project
		if err := tx.Where("id = ? AND deleted_at IS NULL", id).First(&row).Error; err != nil {
			return err
		}
		row.DeletedAt = &now
		row.DeletedBy = &user.ID
		row.UpdatedAt = now
		if err := tx.Save(&row).Error; err != nil {
			return err
		}
		return audit.CommitAudited(tx, &user.ID, "delete_project", "projects", strconv.FormatUint(uint64(id), 10), row.Code, c.ClientIP())
	})
	if err != nil {
		if err == gorm.ErrRecordNotFound {
			writeError(c, http.StatusNotFound, "项目不存在")
			return
		}
		writeError(c, http.StatusInternalServerError, "删除项目失败")
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "id": id})
}

func (h *Handler) Restore(c *gin.Context) {
	id, ok := parseID(c, "pid")
	if !ok {
		return
	}
	user := rbac.GetCurrentUser(c)
	var result model.Project
	err := h.DB.Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("id = ? AND deleted_at IS NOT NULL", id).First(&result).Error; err != nil {
			return err
		}
		result.DeletedAt = nil
		result.DeletedBy = nil
		result.UpdatedAt = timeutil.NowDateTime()
		if err := tx.Save(&result).Error; err != nil {
			return err
		}
		return audit.CommitAudited(tx, &user.ID, "restore_project", "projects", strconv.FormatUint(uint64(id), 10), result.Code, c.ClientIP())
	})
	if err != nil {
		if err == gorm.ErrRecordNotFound {
			writeError(c, http.StatusNotFound, "回收站中无此项目")
			return
		}
		writeError(c, http.StatusInternalServerError, "恢复项目失败")
		return
	}
	c.JSON(http.StatusOK, result)
}

func (h *Handler) RecycleBin(c *gin.Context) {
	page, size, ok := pagination(c)
	if !ok {
		return
	}
	type recycleItem struct {
		ID        uint               `json:"id"`
		Code      string             `json:"code"`
		Name      string             `json:"name"`
		Status    string             `json:"status"`
		DeletedAt *timeutil.DateTime `json:"deleted_at"`
	}
	allowed := map[string]string{
		"id": "projects.id", "code": "projects.code", "name": "projects.name",
		"deleted_at": "projects.deleted_at",
	}
	q := h.DB.Model(&model.Project{}).Where("deleted_at IS NOT NULL")
	result, err := paging.Paginate[recycleItem](q, page, size, c.Query("sort"), allowed, "-deleted_at")
	if err != nil {
		writeError(c, http.StatusBadRequest, err.Error())
		return
	}
	c.JSON(http.StatusOK, result)
}
