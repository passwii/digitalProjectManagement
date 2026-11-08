package project

import (
	"net/http"
	"sort"
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
	if code := strings.TrimSpace(c.Query("code")); code != "" {
		q = q.Where("projects.code LIKE ?", "%"+code+"%")
	}
	if name := strings.TrimSpace(c.Query("name")); name != "" {
		q = q.Where("projects.name LIKE ?", "%"+name+"%")
	}
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
	if owner := strings.TrimSpace(c.Query("owner")); owner != "" {
		var sameNameIDs []uint
		h.DB.Model(&model.User{}).Where("real_name = ? OR username = ?", owner, owner).Pluck("id", &sameNameIDs)
		if len(sameNameIDs) > 0 {
			q = q.Where("(projects.owner_name = ? OR (COALESCE(projects.owner_name, '') = '' AND projects.owner_id IN ?))", owner, sameNameIDs)
		} else {
			q = q.Where("projects.owner_name = ?", owner)
		}
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
	Name  string `json:"name"`
	Count int64  `json:"count"`
}

func (h *Handler) Owners(c *gin.Context) {
	counts := map[string]int64{}
	user := rbac.GetCurrentUser(c)
	base := visibleProjects(h.DB, user)

	type namedRow struct {
		OwnerName string `gorm:"column:owner_name"`
		Count     int64  `gorm:"column:count"`
	}
	var namedRows []namedRow
	_ = h.DB.Table("(?) as p", base).
		Select("COALESCE(p.owner_name, '') as owner_name, COUNT(*) as count").
		Where("COALESCE(p.owner_name, '') <> ''").
		Group("COALESCE(p.owner_name, '')").
		Scan(&namedRows).Error
	for _, r := range namedRows {
		counts[r.OwnerName] += r.Count
	}

	type linkedRow struct {
		RealName string `gorm:"column:real_name"`
		Username string `gorm:"column:username"`
		Count    int64  `gorm:"column:count"`
	}
	var linkedRows []linkedRow
	_ = h.DB.Table("(?) as p", base).
		Select("u.real_name, u.username, COUNT(*) as count").
		Joins("JOIN users u ON u.id = p.owner_id").
		Where("COALESCE(p.owner_name, '') = ''").
		Group("u.real_name, u.username").
		Scan(&linkedRows).Error
	for _, r := range linkedRows {
		name := strings.TrimSpace(r.RealName)
		if name == "" {
			name = strings.TrimSpace(r.Username)
		}
		if name != "" {
			counts[name] += r.Count
		}
	}

	items := make([]OwnerOption, 0, len(counts))
	for name, count := range counts {
		items = append(items, OwnerOption{Name: name, Count: count})
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].Count != items[j].Count {
			return items[i].Count > items[j].Count
		}
		return items[i].Name < items[j].Name
	})
	if len(items) > 200 {
		items = items[:200]
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
