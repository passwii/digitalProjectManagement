package milestone

import (
	"encoding/json"
	"errors"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"digitalprojectmanagement/api/internal/model"
	projectdomain "digitalprojectmanagement/api/internal/project"
	"digitalprojectmanagement/api/internal/rbac"
	"digitalprojectmanagement/api/pkg/audit"
	"digitalprojectmanagement/api/pkg/paging"
	"digitalprojectmanagement/api/pkg/timeutil"
	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

var milestoneSorts = map[string]string{
	"id": "milestones.id", "project_id": "milestones.project_id",
	"name": "milestones.name", "plan_date": "milestones.plan_date",
	"actual_date": "milestones.actual_date", "status": "milestones.status",
}

func warningState(plan, actual *timeutil.Date, today time.Time, warnDays int) (overdue, near bool) {
	if plan == nil || actual != nil {
		return false, false
	}
	left := int(plan.Sub(today).Hours() / 24)
	if plan.Before(today) {
		return true, false
	}
	return false, left >= 0 && left <= warnDays
}

func warningDays(db *gorm.DB) int {
	var param model.SysParam
	if err := db.Where("key = ?", "milestone_warn_days").First(&param).Error; err != nil {
		return 3
	}
	value, err := strconv.Atoi(param.Value)
	if err != nil || value < 0 || value > 365 {
		return 3
	}
	return value
}

func milestoneRow(row model.Milestone, warnDays int) gin.H {
	today := timeutil.NewDate(timeutil.AppNow())
	overdue, near := warningState(row.PlanDate, row.ActualDate, today.Time, warnDays)
	return gin.H{
		"id": row.ID, "project_id": row.ProjectID, "name": row.Name,
		"plan_date": dateText(row.PlanDate), "actual_date": dateText(row.ActualDate),
		"owner_id": row.OwnerID, "status": row.Status, "overdue": overdue, "near": near,
	}
}

func dateText(value *timeutil.Date) any {
	if value == nil {
		return nil
	}
	return value.Format("2006-01-02")
}

func parseMilestoneID(c *gin.Context) (uint, bool) {
	value, err := strconv.ParseUint(c.Param("mid"), 10, 32)
	if err != nil || value == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "里程碑 ID 无效"})
		return 0, false
	}
	return uint(value), true
}

func (h *Handler) List(c *gin.Context) {
	user := rbac.GetCurrentUser(c)
	q := h.DB.Model(&model.Milestone{})
	projectID, err := strconv.ParseUint(c.DefaultQuery("project_id", "0"), 10, 32)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "project_id 须为正整数"})
		return
	}
	if projectID > 0 {
		if _, err := projectdomain.LoadVisibleProject(h.DB, user, uint(projectID)); err != nil {
			c.JSON(http.StatusNotFound, gin.H{"detail": "项目不存在"})
			return
		}
		q = q.Where("project_id = ?", projectID)
	} else {
		q = q.Where("project_id IN (?)", projectdomain.VisibleProjectIDs(h.DB, user))
	}
	if status := strings.TrimSpace(c.Query("status")); status != "" {
		q = q.Where("status = ?", status)
	}
	page, size, ok := milestonePagination(c)
	if !ok {
		return
	}
	result, err := paging.Paginate[model.Milestone](q, page, size, c.Query("sort"), milestoneSorts, "plan_date")
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"detail": err.Error()})
		return
	}
	items := make([]gin.H, 0, len(result.Items))
	days := warningDays(h.DB)
	for _, row := range result.Items {
		items = append(items, milestoneRow(row, days))
	}
	c.JSON(http.StatusOK, gin.H{"total": result.Total, "page": result.Page, "size": result.Size, "items": items})
}

func milestonePagination(c *gin.Context) (int, int, bool) {
	page, err := strconv.Atoi(c.DefaultQuery("page", "1"))
	if err != nil || page < 1 {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "page 须为正整数"})
		return 0, 0, false
	}
	size, err := strconv.Atoi(c.DefaultQuery("size", "20"))
	if err != nil || size < 1 || size > paging.MaxPageSize {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "size 须为 1-100"})
		return 0, 0, false
	}
	return page, size, true
}

func loadMilestoneProject(db *gorm.DB, user *model.User, projectID uint, write bool) (model.Project, error) {
	row, err := projectdomain.LoadVisibleProject(db, user, projectID)
	if err != nil {
		return row, err
	}
	if write && row.Status == "archived" {
		return row, errMilestoneProjectArchived
	}
	return row, nil
}

func (h *Handler) Create(c *gin.Context) {
	var req struct {
		ProjectID uint           `json:"project_id"`
		Name      string         `json:"name"`
		PlanDate  *timeutil.Date `json:"plan_date"`
		OwnerID   *uint          `json:"owner_id"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || req.ProjectID == 0 || strings.TrimSpace(req.Name) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "project_id 与里程碑名称必填"})
		return
	}
	user := rbac.GetCurrentUser(c)
	projectRow, err := loadMilestoneProject(h.DB, user, req.ProjectID, true)
	if err != nil {
		milestoneError(c, err)
		return
	}
	if projectRow.Status == "archived" {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "已归档项目只读"})
		return
	}
	ownerID := req.OwnerID
	if ownerID == nil {
		ownerID = &user.ID
	}
	if ownerID != nil {
		var owner model.User
		if err := h.DB.First(&owner, *ownerID).Error; err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"detail": "负责人不存在"})
			return
		}
	}
	row := model.Milestone{
		ProjectID: req.ProjectID, Name: strings.TrimSpace(req.Name), PlanDate: req.PlanDate,
		OwnerID: ownerID, Status: "open", CreatedAt: timeutil.NowDateTime(),
	}
	err = h.DB.Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(&row).Error; err != nil {
			return err
		}
		return audit.CommitAudited(tx, &user.ID, "create_milestone", "milestones", strconv.FormatUint(uint64(row.ID), 10), row.Name, c.ClientIP())
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"detail": "创建里程碑失败"})
		return
	}
	c.JSON(http.StatusCreated, milestoneRow(row, warningDays(h.DB)))
}

func (h *Handler) Patch(c *gin.Context) {
	id, ok := parseMilestoneID(c)
	if !ok {
		return
	}
	var body map[string]json.RawMessage
	if err := c.ShouldBindJSON(&body); err != nil || body == nil {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "请求体须为 JSON 对象"})
		return
	}
	user := rbac.GetCurrentUser(c)
	var result model.Milestone
	err := h.DB.Transaction(func(tx *gorm.DB) error {
		var row model.Milestone
		if err := tx.First(&row, id).Error; err != nil {
			return err
		}
		projectRow, err := loadMilestoneProject(tx, user, row.ProjectID, true)
		if err != nil {
			return err
		}
		if projectRow.Status == "archived" {
			return errMilestoneProjectArchived
		}
		for key := range body {
			switch key {
			case "name", "plan_date", "actual_date", "owner_id":
			default:
				return errMilestoneInvalidField
			}
		}
		if raw, exists := body["name"]; exists {
			if json.Unmarshal(raw, &row.Name) != nil || strings.TrimSpace(row.Name) == "" || len([]rune(row.Name)) > 128 {
				return errMilestoneInvalidField
			}
			row.Name = strings.TrimSpace(row.Name)
		}
		if raw, exists := body["plan_date"]; exists {
			row.PlanDate, err = milestoneDate(raw)
			if err != nil {
				return err
			}
		}
		if raw, exists := body["actual_date"]; exists {
			row.ActualDate, err = milestoneDate(raw)
			if err != nil {
				return err
			}
			row.Status = "open"
			if row.ActualDate != nil {
				row.Status = "closed"
			}
		}
		if raw, exists := body["owner_id"]; exists {
			row.OwnerID, err = milestoneUint(raw)
			if err != nil {
				return errMilestoneInvalidField
			}
			if row.OwnerID != nil {
				var owner model.User
				if err := tx.First(&owner, *row.OwnerID).Error; err != nil {
					return errMilestoneInvalidField
				}
			}
		}
		if err := tx.Save(&row).Error; err != nil {
			return err
		}
		if err := audit.CommitAudited(tx, &user.ID, "update_milestone", "milestones", strconv.FormatUint(uint64(row.ID), 10), "fields="+strings.Join(milestoneKeys(body), ","), c.ClientIP()); err != nil {
			return err
		}
		result = row
		return nil
	})
	if err != nil {
		milestoneError(c, err)
		return
	}
	c.JSON(http.StatusOK, milestoneRow(result, warningDays(h.DB)))
}

func (h *Handler) Delete(c *gin.Context) {
	id, ok := parseMilestoneID(c)
	if !ok {
		return
	}
	user := rbac.GetCurrentUser(c)
	err := h.DB.Transaction(func(tx *gorm.DB) error {
		var row model.Milestone
		if err := tx.First(&row, id).Error; err != nil {
			return err
		}
		if _, err := loadMilestoneProject(tx, user, row.ProjectID, true); err != nil {
			return err
		}
		if err := tx.Delete(&row).Error; err != nil {
			return err
		}
		return audit.CommitAudited(tx, &user.ID, "delete_milestone", "milestones", strconv.FormatUint(uint64(row.ID), 10), row.Name, c.ClientIP())
	})
	if err != nil {
		milestoneError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func milestoneDate(raw json.RawMessage) (*timeutil.Date, error) {
	if len(raw) == 0 || string(raw) == "null" || string(raw) == `""` {
		return nil, nil
	}
	var value timeutil.Date
	if err := value.UnmarshalJSON(raw); err != nil {
		return nil, errMilestoneInvalidField
	}
	return &value, nil
}

func milestoneUint(raw json.RawMessage) (*uint, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return nil, nil
	}
	var value uint
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, err
	}
	if value == 0 {
		return nil, nil
	}
	return &value, nil
}

func milestoneKeys(body map[string]json.RawMessage) []string {
	keys := make([]string, 0, len(body))
	for key := range body {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func milestoneError(c *gin.Context, err error) {
	switch err {
	case gorm.ErrRecordNotFound:
		c.JSON(http.StatusNotFound, gin.H{"detail": "里程碑或项目不存在"})
	case errMilestoneProjectArchived:
		c.JSON(http.StatusBadRequest, gin.H{"detail": "已归档项目只读"})
	case errMilestoneInvalidField:
		c.JSON(http.StatusBadRequest, gin.H{"detail": "里程碑字段无效"})
	default:
		c.JSON(http.StatusInternalServerError, gin.H{"detail": "里程碑操作失败"})
	}
}

var (
	errMilestoneProjectArchived = errors.New("milestone project archived")
	errMilestoneInvalidField    = errors.New("invalid milestone field")
)
