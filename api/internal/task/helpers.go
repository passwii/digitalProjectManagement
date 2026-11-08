package task

import (
	"encoding/json"
	"errors"

	"math"
	"net/http"
	"strconv"
	"strings"

	"digitalprojectmanagement/api/internal/model"
	projectdomain "digitalprojectmanagement/api/internal/project"
	"digitalprojectmanagement/api/pkg/paging"
	"digitalprojectmanagement/api/pkg/timeutil"
	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

const maxTaskLevel = 5

var taskTransitions = map[string]map[string]bool{
	"todo":   {"doing": true, "paused": true, "done": true},
	"doing":  {"todo": true, "paused": true, "done": true},
	"paused": {"todo": true, "doing": true, "done": true},
	"done":   {"doing": true, "todo": true},
}

func taskTransitionAllowed(from, to string) bool {
	if from == to {
		return true
	}
	return taskTransitions[from][to]
}

func taskLevel(parentLevel int) (int, error) {
	level := parentLevel + 1
	if level < 1 || level > maxTaskLevel {
		return 0, errTaskTooDeep
	}
	return level, nil
}

func dependencyCycle(taskID uint, predecessorID *uint, predecessors map[uint]*uint) bool {
	seen := map[uint]bool{}
	current := predecessorID
	for current != nil {
		if *current == taskID || seen[*current] {
			return true
		}
		seen[*current] = true
		current = predecessors[*current]
	}
	return false
}

var (
	errTaskTooDeep     = errors.New("task tree exceeds maximum depth")
	errInvalidTask     = errors.New("invalid task")
	errTaskCycle       = errors.New("task dependency cycle")
	errTaskParent      = errors.New("invalid task parent")
	errTaskPredecessor = errors.New("invalid task predecessor")
	errTaskDates       = errors.New("invalid task date range")
	errTaskTransition  = errors.New("invalid task status transition")
	errTaskDependency  = errors.New("task predecessor is incomplete")
	errTaskOwner       = errors.New("invalid task owner")
	errTaskForbidden   = errors.New("task action forbidden")
	errProjectArchived = errors.New("project archived")
)

func taskError(c *gin.Context, err error) {
	switch err {
	case gorm.ErrRecordNotFound:
		c.JSON(http.StatusNotFound, gin.H{"detail": "项目或任务不存在"})
	case errProjectArchived:
		c.JSON(http.StatusBadRequest, gin.H{"detail": "已归档项目只读"})
	case errTaskTooDeep:
		c.JSON(http.StatusBadRequest, gin.H{"detail": "任务层级最多 5 级"})
	case errTaskParent:
		c.JSON(http.StatusBadRequest, gin.H{"detail": "父任务不存在或不属于本项目"})
	case errTaskPredecessor:
		c.JSON(http.StatusBadRequest, gin.H{"detail": "前置任务须为同一项目"})
	case errTaskCycle:
		c.JSON(http.StatusBadRequest, gin.H{"detail": "前置依赖存在环，已拦截"})
	case errTaskDates:
		c.JSON(http.StatusBadRequest, gin.H{"detail": "任务计划日期无效或超出项目计划期"})
	case errTaskTransition:
		c.JSON(http.StatusBadRequest, gin.H{"detail": "不允许该任务状态流转"})
	case errTaskDependency:
		c.JSON(http.StatusBadRequest, gin.H{"detail": "前置任务尚未完成，不能将本任务标记为完成"})
	case errTaskOwner:
		c.JSON(http.StatusBadRequest, gin.H{"detail": "任务负责人不存在"})
	case errTaskForbidden:
		c.JSON(http.StatusForbidden, gin.H{"detail": "无权操作该任务"})
	default:
		c.JSON(http.StatusInternalServerError, gin.H{"detail": "任务操作失败"})
	}
}

func loadTaskProject(db *gorm.DB, user *model.User, projectID uint, write bool) (model.Project, error) {
	row, err := projectdomain.LoadVisibleProject(db, user, projectID)
	if err != nil {
		return row, err
	}
	if write && row.Status == "archived" {
		return row, errProjectArchived
	}
	return row, nil
}

func parsePathID(c *gin.Context, name string) (uint, bool) {
	id, err := strconv.ParseUint(c.Param(name), 10, 32)
	if err != nil || id == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "ID 格式无效"})
		return 0, false
	}
	return uint(id), true
}

func parseQueryID(c *gin.Context, name string) (uint, bool) {
	raw := strings.TrimSpace(c.Query(name))
	if raw == "" {
		return 0, true
	}
	id, err := strconv.ParseUint(raw, 10, 32)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"detail": name + " 须为正整数"})
		return 0, false
	}
	return uint(id), true
}

func parsePagination(c *gin.Context) (int, int, bool) {
	page, err := strconv.Atoi(c.DefaultQuery("page", "1"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "page 须为整数"})
		return 0, 0, false
	}
	size, err := strconv.Atoi(c.DefaultQuery("size", strconv.Itoa(paging.DefaultPageSize)))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "size 须为整数"})
		return 0, 0, false
	}
	if _, err := paging.ValidatePage(page); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"detail": err.Error()})
		return 0, 0, false
	}
	if _, err := paging.ValidateSize(size); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"detail": err.Error()})
		return 0, 0, false
	}
	return page, size, true
}

func dateFromJSON(raw json.RawMessage) (*timeutil.Date, error) {
	if len(raw) == 0 || string(raw) == "null" || string(raw) == `""` {
		return nil, nil
	}
	var value timeutil.Date
	if err := value.UnmarshalJSON(raw); err != nil {
		return nil, errTaskDates
	}
	return &value, nil
}

func datePtrText(value *timeutil.Date) string {
	if value == nil || value.IsZero() {
		return ""
	}
	return value.Format("2006-01-02")
}

func number(raw json.RawMessage, defaultValue float64) (float64, error) {
	var value float64
	if len(raw) == 0 {
		return defaultValue, nil
	}
	if err := json.Unmarshal(raw, &value); err != nil || math.IsNaN(value) || math.IsInf(value, 0) {
		return 0, errInvalidTask
	}
	return value, nil
}

func checkTaskDates(start, end *timeutil.Date, project model.Project) error {
	if start != nil && end != nil && start.After(end.Time) {
		return errTaskDates
	}
	if start != nil && project.PlanStart != nil && start.Before(project.PlanStart.Time) {
		return errTaskDates
	}
	if end != nil && project.PlanEnd != nil && end.After(project.PlanEnd.Time) {
		return errTaskDates
	}
	return nil
}

func taskWritableStatus(project model.Project) error {
	if project.Status == "archived" {
		return errProjectArchived
	}
	return nil
}

func validateParent(db *gorm.DB, parentID *uint, projectID, taskID uint) (*model.Task, int, error) {
	if parentID == nil || *parentID == 0 {
		return nil, 1, nil
	}
	if *parentID == taskID {
		return nil, 0, errTaskParent
	}
	var parent model.Task
	if err := db.Where("id = ? AND project_id = ?", *parentID, projectID).First(&parent).Error; err != nil {
		return nil, 0, errTaskParent
	}
	level := 1
	seen := map[uint]bool{parent.ID: true}
	current := parent
	for current.ParentID != nil && *current.ParentID > 0 {
		if *current.ParentID == taskID || seen[*current.ParentID] {
			return nil, 0, errTaskParent
		}
		seen[*current.ParentID] = true
		level++
		var ancestor model.Task
		if err := db.Where("id = ? AND project_id = ?", *current.ParentID, projectID).First(&ancestor).Error; err != nil {
			return nil, 0, errTaskParent
		}
		current = ancestor
	}
	level++
	if level > maxTaskLevel {
		return nil, 0, errTaskTooDeep
	}
	return &parent, level, nil
}

func validatePredecessor(db *gorm.DB, taskID uint, predecessorID *uint, projectID uint) error {
	if predecessorID == nil || *predecessorID == 0 {
		return nil
	}
	seen := map[uint]bool{}
	current := predecessorID
	for current != nil && *current > 0 {
		if *current == taskID || seen[*current] {
			return errTaskCycle
		}
		seen[*current] = true
		var row model.Task
		if err := db.Where("id = ? AND project_id = ?", *current, projectID).First(&row).Error; err != nil {
			return errTaskPredecessor
		}
		current = row.PredecessorID
	}
	return nil
}

func checkDependencyReady(db *gorm.DB, row model.Task, status string, progress *float64) error {
	finishing := status == "done" || (progress != nil && *progress >= 100)
	if !finishing || row.PredecessorID == nil || *row.PredecessorID == 0 {
		return nil
	}
	var predecessor model.Task
	if err := db.First(&predecessor, *row.PredecessorID).Error; err != nil {
		return errTaskPredecessor
	}
	if predecessor.Status != "done" && predecessor.Progress < 100 {
		return errTaskDependency
	}
	return nil
}

var taskUpdateLock = clause.Locking{Strength: clause.LockingStrengthUpdate}
