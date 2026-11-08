package task

import (
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"sort"
	"strconv"
	"strings"

	"digitalprojectmanagement/api/internal/model"
	projectdomain "digitalprojectmanagement/api/internal/project"
	"digitalprojectmanagement/api/internal/rbac"
	"digitalprojectmanagement/api/pkg/audit"
	"digitalprojectmanagement/api/pkg/paging"
	"digitalprojectmanagement/api/pkg/timeutil"
	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

var taskSorts = map[string]string{
	"id": "tasks.id", "project_id": "tasks.project_id", "name": "tasks.name",
	"level": "tasks.level", "status": "tasks.status", "progress": "tasks.progress",
	"weight": "tasks.weight", "plan_start": "tasks.plan_start",
	"plan_end": "tasks.plan_end", "owner_id": "tasks.owner_id",
}

type taskRequest struct {
	ProjectID     uint           `json:"project_id"`
	ParentID      *uint          `json:"parent_id"`
	Name          string         `json:"name"`
	OwnerID       *uint          `json:"owner_id"`
	PlanStart     *timeutil.Date `json:"plan_start"`
	PlanEnd       *timeutil.Date `json:"plan_end"`
	Weight        float64        `json:"weight"`
	PredecessorID *uint          `json:"predecessor_id"`
}

func taskRow(row model.Task) gin.H {
	return gin.H{
		"id": row.ID, "project_id": row.ProjectID, "parent_id": row.ParentID,
		"level": row.Level, "name": row.Name, "owner_id": row.OwnerID,
		"plan_start": datePtrText(row.PlanStart), "plan_end": datePtrText(row.PlanEnd),
		"weight": row.Weight, "progress": row.Progress, "status": row.Status,
		"predecessor_id": row.PredecessorID, "created_at": row.CreatedAt,
	}
}

func (h *Handler) List(c *gin.Context) {
	user := rbac.GetCurrentUser(c)
	projectID, ok := parseQueryID(c, "project_id")
	if !ok {
		return
	}
	q := h.DB.Model(&model.Task{})
	if projectID > 0 {
		if _, err := loadTaskProject(h.DB, user, projectID, false); err != nil {
			taskError(c, err)
			return
		}
		q = q.Where("tasks.project_id = ?", projectID)
	} else {
		q = q.Where("tasks.project_id IN (?)", projectdomain.VisibleProjectIDs(h.DB, user))
	}
	if status := strings.TrimSpace(c.Query("status")); status != "" {
		q = q.Where("tasks.status = ?", status)
	}
	ownerID, ok := parseQueryID(c, "owner_id")
	if !ok {
		return
	}
	if ownerID > 0 {
		q = q.Where("tasks.owner_id = ?", ownerID)
	}
	if keyword := strings.TrimSpace(c.Query("keyword")); keyword != "" {
		q = q.Where("tasks.name ILIKE ?", "%"+keyword+"%")
	}
	if c.Query("view") == "tree" || c.Query("tree") == "1" {
		var rows []model.Task
		if err := q.Preload("Owner").Order("tasks.project_id ASC, tasks.level ASC, tasks.id ASC").Limit(5000).Find(&rows).Error; err != nil {
			taskError(c, err)
			return
		}
		c.JSON(http.StatusOK, gin.H{"items": taskTree(rows)})
		return
	}
	page, size, ok := parsePagination(c)
	if !ok {
		return
	}
	q = q.Preload("Owner")
	result, err := paging.Paginate[model.Task](q, page, size, c.Query("sort"), taskSorts, "id")
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"detail": err.Error()})
		return
	}
	items := make([]gin.H, 0, len(result.Items))
	for _, row := range result.Items {
		items = append(items, taskRow(row))
	}
	c.JSON(http.StatusOK, gin.H{"total": result.Total, "page": result.Page, "size": result.Size, "items": items})
}

type taskNode struct {
	ID            uint           `json:"id"`
	ProjectID     uint           `json:"project_id"`
	ParentID      *uint          `json:"parent_id"`
	Level         int            `json:"level"`
	Name          string         `json:"name"`
	OwnerID       *uint          `json:"owner_id"`
	PlanStart     *timeutil.Date `json:"plan_start"`
	PlanEnd       *timeutil.Date `json:"plan_end"`
	Weight        float64        `json:"weight"`
	Progress      float64        `json:"progress"`
	Status        string         `json:"status"`
	PredecessorID *uint          `json:"predecessor_id"`
	Children      []*taskNode    `json:"children"`
}

func taskTree(rows []model.Task) []*taskNode {
	nodes := make(map[uint]*taskNode, len(rows))
	for _, row := range rows {
		nodes[row.ID] = &taskNode{
			ID: row.ID, ProjectID: row.ProjectID, ParentID: row.ParentID, Level: row.Level,
			Name: row.Name, OwnerID: row.OwnerID, PlanStart: row.PlanStart, PlanEnd: row.PlanEnd,
			Weight: row.Weight, Progress: row.Progress, Status: row.Status,
			PredecessorID: row.PredecessorID, Children: []*taskNode{},
		}
	}
	roots := make([]*taskNode, 0)
	for _, row := range rows {
		node := nodes[row.ID]
		if row.ParentID != nil && nodes[*row.ParentID] != nil {
			nodes[*row.ParentID].Children = append(nodes[*row.ParentID].Children, node)
		} else {
			roots = append(roots, node)
		}
	}
	sort.Slice(roots, func(i, j int) bool { return roots[i].ID < roots[j].ID })
	return roots
}

func (h *Handler) Create(c *gin.Context) {
	var req taskRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "请求格式错误"})
		return
	}
	user := rbac.GetCurrentUser(c)
	projectRow, err := loadTaskProject(h.DB, user, req.ProjectID, true)
	if err != nil {
		taskError(c, err)
		return
	}
	if err := taskWritableStatus(projectRow); err != nil {
		taskError(c, err)
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" || len([]rune(req.Name)) > 128 {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "任务名称必填且最多 128 个字符"})
		return
	}
	if req.Weight == 0 {
		req.Weight = 1
	}
	if req.Weight <= 0 || math.IsNaN(req.Weight) || math.IsInf(req.Weight, 0) {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "任务权重须为大于 0 的有效数字"})
		return
	}
	if err := checkTaskDates(req.PlanStart, req.PlanEnd, projectRow); err != nil {
		taskError(c, err)
		return
	}
	_, level, err := validateParent(h.DB, req.ParentID, req.ProjectID, 0)
	if err != nil {
		taskError(c, err)
		return
	}
	if err := validatePredecessor(h.DB, 0, req.PredecessorID, req.ProjectID); err != nil {
		taskError(c, err)
		return
	}
	ownerID := user.ID
	if req.OwnerID != nil && *req.OwnerID > 0 {
		ownerID = *req.OwnerID
		var owner model.User
		if err := h.DB.First(&owner, ownerID).Error; err != nil {
			taskError(c, errTaskOwner)
			return
		}
	}
	now := timeutil.NowDateTime()
	row := model.Task{
		ProjectID: req.ProjectID, ParentID: req.ParentID, Level: level,
		Name: req.Name, OwnerID: &ownerID, PlanStart: req.PlanStart, PlanEnd: req.PlanEnd,
		Weight: req.Weight, Status: "todo", PredecessorID: req.PredecessorID,
		CreatedAt: now, UpdatedAt: now,
	}
	err = h.DB.Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(&row).Error; err != nil {
			return err
		}
		return audit.CommitAudited(tx, &user.ID, "create_task", "tasks", strconv.FormatUint(uint64(row.ID), 10), row.Name, c.ClientIP())
	})
	if err != nil {
		taskError(c, err)
		return
	}
	c.JSON(http.StatusCreated, taskRow(row))
}

func (h *Handler) Patch(c *gin.Context) {
	id, ok := parsePathID(c, "tid")
	if !ok {
		return
	}
	var body map[string]json.RawMessage
	if err := c.ShouldBindJSON(&body); err != nil || body == nil {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "请求体须为 JSON 对象"})
		return
	}
	allowed := map[string]bool{
		"project_id": true, "name": true, "owner_id": true, "plan_start": true,
		"plan_end": true, "weight": true, "status": true, "predecessor_id": true,
		"parent_id": true, "progress": true, "note": true,
	}
	for key := range body {
		if !allowed[key] {
			c.JSON(http.StatusBadRequest, gin.H{"detail": "不支持的字段：" + key})
			return
		}
	}
	user := rbac.GetCurrentUser(c)
	var result model.Task
	err := h.DB.Transaction(func(tx *gorm.DB) error {
		var row model.Task
		if err := tx.Clauses(taskUpdateLock).First(&row, id).Error; err != nil {
			return err
		}
		projectRow, err := loadTaskProject(tx, user, row.ProjectID, true)
		if err != nil {
			return err
		}
		if raw := body["project_id"]; len(raw) > 0 {
			var requested uint
			if json.Unmarshal(raw, &requested) != nil || requested != row.ProjectID {
				return errInvalidTask
			}
		}
		newName := row.Name
		if raw := body["name"]; len(raw) > 0 {
			if json.Unmarshal(raw, &newName) != nil {
				return errInvalidTask
			}
			newName = strings.TrimSpace(newName)
			if newName == "" || len([]rune(newName)) > 128 {
				return errInvalidTask
			}
		}
		newWeight := row.Weight
		if raw := body["weight"]; len(raw) > 0 {
			newWeight, err = number(raw, row.Weight)
			if err != nil || newWeight <= 0 {
				return errInvalidTask
			}
		}
		newProgress := row.Progress
		progressChanged := false
		var progressValue *float64
		if raw := body["progress"]; len(raw) > 0 {
			newProgress, err = number(raw, row.Progress)
			if err != nil || newProgress < 0 || newProgress > 100 {
				return errInvalidTask
			}
			progressChanged = newProgress != row.Progress
			if progressChanged {
				progressValue = &newProgress
			}
		}
		newStart, newEnd := row.PlanStart, row.PlanEnd
		if raw, exists := body["plan_start"]; exists {
			newStart, err = dateFromJSON(raw)
			if err != nil {
				return err
			}
		}
		if raw, exists := body["plan_end"]; exists {
			newEnd, err = dateFromJSON(raw)
			if err != nil {
				return err
			}
		}
		if err := checkTaskDates(newStart, newEnd, projectRow); err != nil {
			return err
		}
		newParentID := row.ParentID
		oldParentID := row.ParentID
		newLevel := row.Level
		if raw, exists := body["parent_id"]; exists {
			newParentID, err = optionalUint(raw)
			if err != nil {
				return errTaskParent
			}
		}
		if !sameUint(newParentID, row.ParentID) {
			_, newLevel, err = validateParent(tx, newParentID, row.ProjectID, row.ID)
			if err != nil {
				return err
			}
			if err := validateParentSubtreeDepth(tx, row.ID, row.ProjectID, newParentID); err != nil {
				return err
			}
		}
		newPredecessor := row.PredecessorID
		if raw, exists := body["predecessor_id"]; exists {
			newPredecessor, err = optionalUint(raw)
			if err != nil {
				return errTaskPredecessor
			}
		}
		if err := validatePredecessor(tx, row.ID, newPredecessor, row.ProjectID); err != nil {
			return err
		}
		newStatus := row.Status
		if raw := body["status"]; len(raw) > 0 {
			if json.Unmarshal(raw, &newStatus) != nil || !taskTransitionAllowed(row.Status, newStatus) {
				return errTaskTransition
			}
		}
		if _, exists := body["owner_id"]; exists {
			ownerID, err := optionalUint(body["owner_id"])
			if err != nil {
				return errTaskOwner
			}
			if ownerID != nil {
				var owner model.User
				if err := tx.First(&owner, *ownerID).Error; err != nil {
					return errTaskOwner
				}
			}
		}
		dependencyRow := row
		dependencyRow.PredecessorID = newPredecessor
		if err := checkDependencyReady(tx, dependencyRow, newStatus, progressValue); err != nil {
			return err
		}

		row.Name, row.Weight = newName, newWeight
		row.PlanStart, row.PlanEnd = newStart, newEnd
		row.ParentID, row.PredecessorID, row.Status = newParentID, newPredecessor, newStatus
		if !sameUint(newParentID, oldParentID) {
			row.Level = newLevel
		}
		if _, exists := body["owner_id"]; exists {
			row.OwnerID, err = optionalUint(body["owner_id"])
			if err != nil {
				return errTaskOwner
			}
		}
		if progressChanged {
			row.Progress = newProgress
			note := ""
			if raw := body["note"]; len(raw) > 0 {
				if json.Unmarshal(raw, &note) != nil {
					return errInvalidTask
				}
			}
			now := timeutil.NowDateTime()
			log := model.ProgressLog{TaskID: row.ID, ProjectID: row.ProjectID, UserID: &user.ID, Progress: newProgress, Note: note, CreatedAt: now}
			if err := tx.Create(&log).Error; err != nil {
				return err
			}
		}
		row.UpdatedAt = timeutil.NowDateTime()
		if err := tx.Save(&row).Error; err != nil {
			return err
		}
		if err := audit.CommitAudited(tx, &user.ID, "update_task", "tasks", strconv.FormatUint(uint64(row.ID), 10), strings.Join(sortedRawKeys(body), ","), c.ClientIP()); err != nil {
			return err
		}
		result = row
		return nil
	})
	if err != nil {
		taskError(c, err)
		return
	}
	c.JSON(http.StatusOK, taskRow(result))
}

func optionalUint(raw json.RawMessage) (*uint, error) {
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

func sameUint(a, b *uint) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

func validateParentSubtreeDepth(db *gorm.DB, taskID, projectID uint, parentID *uint) error {
	base := 1
	if parentID != nil {
		_, level, err := validateParent(db, parentID, projectID, taskID)
		if err != nil {
			return err
		}
		base = level
	}
	type depthNode struct {
		id    uint
		depth int
	}
	queue := []depthNode{{id: taskID}}
	for len(queue) > 0 {
		current := queue[0]
		queue = queue[1:]
		if base+current.depth > maxTaskLevel {
			return errTaskTooDeep
		}
		var children []model.Task
		if err := db.Where("parent_id = ?", current.id).Find(&children).Error; err != nil {
			return err
		}
		for _, child := range children {
			queue = append(queue, depthNode{id: child.ID, depth: current.depth + 1})
		}
	}
	return nil
}

func sortedRawKeys(body map[string]json.RawMessage) []string {
	keys := make([]string, 0, len(body))
	for key := range body {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func (h *Handler) Delete(c *gin.Context) {
	id, ok := parsePathID(c, "tid")
	if !ok {
		return
	}
	user := rbac.GetCurrentUser(c)
	err := h.DB.Transaction(func(tx *gorm.DB) error {
		var row model.Task
		if err := tx.Clauses(taskUpdateLock).First(&row, id).Error; err != nil {
			return err
		}
		if _, err := loadTaskProject(tx, user, row.ProjectID, true); err != nil {
			return err
		}
		var childCount int64
		if err := tx.Model(&model.Task{}).Where("parent_id = ?", row.ID).Count(&childCount).Error; err != nil {
			return err
		}
		if childCount > 0 {
			return errTaskHasChildren
		}
		if err := tx.Model(&model.Task{}).Where("predecessor_id = ?", row.ID).Update("predecessor_id", nil).Error; err != nil {
			return err
		}
		if err := tx.Delete(&row).Error; err != nil {
			return err
		}
		return audit.CommitAudited(tx, &user.ID, "delete_task", "tasks", strconv.FormatUint(uint64(row.ID), 10), row.Name, c.ClientIP())
	})
	if err != nil {
		if err == errTaskHasChildren {
			c.JSON(http.StatusConflict, gin.H{"detail": "请先删除子任务"})
			return
		}
		taskError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

var errTaskHasChildren = fmt.Errorf("task has child tasks")
