package project

import (
	"net/http"
	"strconv"
	"strings"

	"digitalprojectmanagement/api/internal/model"
	"digitalprojectmanagement/api/internal/rbac"
	"digitalprojectmanagement/api/pkg/paging"
	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

var projectSorts = map[string]string{
	"id": "projects.id", "code": "projects.code", "name": "projects.name",
	"type": "projects.type", "status": "projects.status", "priority": "projects.priority",
	"owner_id": "projects.owner_id", "dept_id": "projects.dept_id",
	"client": "projects.client", "client_name": "projects.client", "plan_start": "projects.plan_start",
	"plan_end": "projects.plan_end", "created_at": "projects.created_at",
	"updated_at": "projects.updated_at", "progress": "projects.progress",
}

func (h *Handler) List(c *gin.Context) {
	page, size, ok := pagination(c)
	if !ok {
		return
	}
	user := rbac.GetCurrentUser(c)
	q := visibleProjects(h.DB, user)
	if keyword := strings.TrimSpace(c.Query("keyword")); keyword != "" {
		like := "%" + keyword + "%"
		q = q.Where("(projects.name ILIKE ? OR projects.code ILIKE ? OR projects.client ILIKE ?)", like, like, like)
	}
	for _, field := range []string{"status", "type", "priority"} {
		if value := strings.TrimSpace(c.Query(field)); value != "" {
			q = q.Where("projects."+field+" = ?", value)
		}
	}
	if ownerID := strings.TrimSpace(c.Query("owner_id")); ownerID != "" {
		id, err := strconv.ParseUint(ownerID, 10, 32)
		if err != nil {
			writeError(c, http.StatusBadRequest, "owner_id 须为正整数")
			return
		}
		q = q.Where("projects.owner_id = ?", id)
	}
	if deptID := strings.TrimSpace(c.Query("dept_id")); deptID != "" {
		id, err := strconv.ParseUint(deptID, 10, 32)
		if err != nil {
			writeError(c, http.StatusBadRequest, "dept_id 须为正整数")
			return
		}
		q = q.Where("projects.dept_id = ?", id)
	}
	client := strings.TrimSpace(c.Query("client")); if client == "" { client = strings.TrimSpace(c.Query("client_name")) }; if client != "" {
		q = q.Where("projects.client ILIKE ?", "%"+client+"%")
	}
	if yearText := strings.TrimSpace(c.Query("year")); yearText != "" {
		year, err := strconv.Atoi(yearText)
		if err != nil || year < 1 || year > 9999 {
			writeError(c, http.StatusBadRequest, "year 须为有效年份")
			return
		}
		q = q.Where("EXTRACT(YEAR FROM projects.plan_start) = ?", year)
	}
	q = q.Preload("Owner").Preload("Department")
	result, err := paging.Paginate[model.Project](q, page, size, c.Query("sort"), projectSorts, "-id")
	if err != nil {
		writeError(c, http.StatusBadRequest, err.Error())
		return
	}
	c.JSON(http.StatusOK, result)
}

type ProjectOption struct {
	ID   uint   `json:"id"`
	Name string `json:"name"`
	Code string `json:"code"`
}

func (h *Handler) Options(c *gin.Context) {
	page, size, ok := pagination(c)
	if !ok {
		return
	}
	q := visibleProjects(h.DB, rbac.GetCurrentUser(c)).Select("projects.id, projects.name, projects.code")
	if keyword := strings.TrimSpace(c.Query("keyword")); keyword != "" {
		like := "%" + keyword + "%"
		q = q.Where("(projects.name ILIKE ? OR projects.code ILIKE ?)", like, like)
	}
	optionSorts := map[string]string{"id": "projects.id", "name": "projects.name", "code": "projects.code"}
	result, err := paging.Paginate[ProjectOption](q, page, size, c.Query("sort"), optionSorts, "-id")
	if err != nil {
		writeError(c, http.StatusBadRequest, err.Error())
		return
	}
	c.JSON(http.StatusOK, result)
}

type OwnerOption struct {
	ID    uint   `json:"id"`
	Name  string `json:"name"`
	Count int64  `json:"count"`
}

func (h *Handler) Owners(c *gin.Context) {
	type ownerCount struct {
		OwnerID uint  `gorm:"column:owner_id"`
		Count   int64 `gorm:"column:count"`
	}
	var counts []ownerCount
	q := visibleProjects(h.DB, rbac.GetCurrentUser(c)).
		Select("projects.owner_id, COUNT(*) AS count").
		Where("projects.owner_id IS NOT NULL").
		Group("projects.owner_id").
		Order("count DESC, projects.owner_id ASC")
	if err := q.Scan(&counts).Error; err != nil {
		writeError(c, http.StatusInternalServerError, "查询项目负责人失败")
		return
	}
	ids := make([]uint, 0, len(counts))
	for _, row := range counts {
		ids = append(ids, row.OwnerID)
	}
	var users []model.User
	if len(ids) > 0 {
		if err := h.DB.Where("id IN ?", ids).Find(&users).Error; err != nil {
			writeError(c, http.StatusInternalServerError, "查询负责人信息失败")
			return
		}
	}
	names := make(map[uint]string, len(users))
	for _, user := range users {
		name := strings.TrimSpace(user.RealName)
		if name == "" {
			name = user.Username
		}
		names[user.ID] = name
	}
	items := make([]OwnerOption, 0, len(counts))
	for _, row := range counts {
		if name := names[row.OwnerID]; name != "" {
			items = append(items, OwnerOption{ID: row.OwnerID, Name: name, Count: row.Count})
		}
	}
	c.JSON(http.StatusOK, items)
}

func (h *Handler) Get(c *gin.Context) {
	id, ok := parseID(c, "pid")
	if !ok {
		return
	}
	row, err := LoadVisibleProject(h.DB, rbac.GetCurrentUser(c), id)
	if err != nil {
		if err == gorm.ErrRecordNotFound {
			writeError(c, http.StatusNotFound, "项目不存在")
			return
		}
		writeError(c, http.StatusInternalServerError, "查询项目失败")
		return
	}
	c.JSON(http.StatusOK, row)
}
