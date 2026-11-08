package project

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"digitalprojectmanagement/api/internal/model"
	"digitalprojectmanagement/api/internal/rbac"
	"digitalprojectmanagement/api/pkg/paging"
	"digitalprojectmanagement/api/pkg/timeutil"
	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

var clauseUpdateLock = clause.Locking{Strength: clause.LockingStrengthUpdate}

var projectTransitions = map[string]map[string]bool{
	"draft":    {"pending": true, "filed": true, "cancelled": true},
	"pending":  {"filed": true, "cancelled": true},
	"filed":    {"doing": true, "cancelled": true},
	"doing":    {"paused": true, "done": true},
	"paused":   {"doing": true, "done": true},
	"done":     {"archived": true},
	"archived": {"doing": true},
}

func allowedStatusTransition(from, to string, isSuperAdmin bool) bool {
	if from == "archived" && to == "doing" {
		return isSuperAdmin
	}
	return projectTransitions[from][to]
}

func writeError(c *gin.Context, status int, detail string) {
	c.JSON(status, gin.H{"detail": detail})
}

func parseID(c *gin.Context, key string) (uint, bool) {
	raw := c.Param(key)
	id, err := strconv.ParseUint(raw, 10, 32)
	if err != nil || id == 0 {
		writeError(c, http.StatusBadRequest, "ID 格式无效")
		return 0, false
	}
	return uint(id), true
}

func queryInt(c *gin.Context, key string, fallback int) (int, bool) {
	raw := strings.TrimSpace(c.Query(key))
	if raw == "" {
		return fallback, true
	}
	value, err := strconv.Atoi(raw)
	if err != nil {
		writeError(c, http.StatusBadRequest, key+" 须为整数")
		return 0, false
	}
	return value, true
}

func visibleProjects(db *gorm.DB, user *model.User) *gorm.DB {
	return db.Model(&model.Project{}).Where("id IN (?)", rbac.VisibleProjectSubquery(db, user))
}

// VisibleProjectIDs is used by child-resource packages to apply the same SQL
// visibility, soft-delete, and demo-data rules as project endpoints.
func VisibleProjectIDs(db *gorm.DB, user *model.User) *gorm.DB {
	return rbac.VisibleProjectSubquery(db, user)
}

// LoadVisibleProject returns 404 for hidden, deleted, or demo-hidden projects.
func LoadVisibleProject(db *gorm.DB, user *model.User, id uint) (model.Project, error) {
	var row model.Project
	err := visibleProjects(db, user).Preload("Owner").Preload("Department").
		Where("projects.id = ?", id).First(&row).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return row, gorm.ErrRecordNotFound
	}
	return row, err
}

func loadWritableProject(db *gorm.DB, user *model.User, id uint) (model.Project, error) {
	row, err := LoadVisibleProject(db, user, id)
	if err != nil {
		return row, err
	}
	if row.Status == "archived" {
		return row, errProjectArchived
	}
	return row, nil
}

var errProjectArchived = errors.New("archived project")

func pagination(c *gin.Context) (int, int, bool) {
	page, ok := queryInt(c, "page", 1)
	if !ok {
		return 0, 0, false
	}
	size, ok := queryInt(c, "size", paging.DefaultPageSize)
	if !ok {
		return 0, 0, false
	}
	if _, err := paging.ValidatePage(page); err != nil {
		writeError(c, http.StatusBadRequest, err.Error())
		return 0, 0, false
	}
	if _, err := paging.ValidateSize(size); err != nil {
		writeError(c, http.StatusBadRequest, err.Error())
		return 0, 0, false
	}
	return page, size, true
}

func jsonText(value any) string {
	raw, err := json.Marshal(value)
	if err != nil {
		return fmt.Sprint(value)
	}
	if string(raw) == "null" {
		return ""
	}
	return string(raw)
}

func dateValue(raw json.RawMessage) (*timeutil.Date, error) {
	if len(raw) == 0 || string(raw) == "null" || string(raw) == `""` {
		return nil, nil
	}
	var value timeutil.Date
	if err := value.UnmarshalJSON(raw); err != nil {
		return nil, fmt.Errorf("日期格式须为 YYYY-MM-DD")
	}
	return &value, nil
}

func dateTimeValue(raw json.RawMessage) (*timeutil.DateTime, error) {
	if len(raw) == 0 || string(raw) == "null" || string(raw) == `""` {
		return nil, nil
	}
	var value timeutil.DateTime
	if err := value.UnmarshalJSON(raw); err != nil {
		return nil, fmt.Errorf("日期时间格式无效")
	}
	return &value, nil
}

func timeText(value *timeutil.DateTime) string {
	if value == nil || value.IsZero() {
		return ""
	}
	return value.In(timeutil.Loc).Format(time.RFC3339)
}

func dateText(value *timeutil.Date) string {
	if value == nil || value.IsZero() {
		return ""
	}
	return value.Format("2006-01-02")
}

func projectChange(tx *gorm.DB, projectID uint, field, oldValue, newValue string, actorID uint, at timeutil.DateTime) error {
	return tx.Create(&model.ProjectChange{
		ProjectID: projectID,
		Field:     field,
		Old:       oldValue,
		New:       newValue,
		ByID:      &actorID,
		At:        at,
	}).Error
}
