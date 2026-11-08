package meta

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

type Handler struct {
	DB *gorm.DB
}

func RegisterRoutes(r *gin.RouterGroup, db *gorm.DB) {
	h := &Handler{DB: db}
	metaGroup := r.Group("/meta", rbac.AuthMiddleware(db))
	{
		metaGroup.GET("/users", h.GetUsers)
		metaGroup.GET("/users/search", h.SearchUsers)
		metaGroup.GET("/depts", h.GetDepts)
		metaGroup.GET("/dicts", h.GetDicts)
		metaGroup.GET("/me/menus", h.GetMenus)
	}
}

type UserBrief struct {
	ID        uint     `json:"id"`
	Username  string   `json:"username"`
	RealName  string   `json:"real_name"`
	DeptID    *uint    `json:"dept_id"`
	Status    string   `json:"status"`
	RoleCodes []string `json:"role_codes"`
}

func (h *Handler) GetUsers(c *gin.Context) {
	q := h.DB.Model(&model.User{}).Preload("Roles")

	if kw := strings.TrimSpace(c.Query("keyword")); kw != "" {
		q = q.Where("username LIKE ? OR real_name LIKE ?", "%"+kw+"%", "%"+kw+"%")
	}
	if deptID := c.Query("dept_id"); deptID != "" {
		if id, err := strconv.Atoi(deptID); err == nil {
			q = q.Where("dept_id = ?", id)
		}
	}
	if status := c.Query("status"); status != "" {
		q = q.Where("status = ?", status)
	}
	if idsParam := c.Query("ids"); idsParam != "" {
		var ids []int
		for _, part := range strings.Split(idsParam, ",") {
			if id, err := strconv.Atoi(strings.TrimSpace(part)); err == nil {
				ids = append(ids, id)
			}
		}
		if len(ids) > 0 {
			q = q.Where("id IN ?", ids)
		}
	}

	var users []model.User
	if err := q.Limit(500).Find(&users).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"detail": "查询用户失败"})
		return
	}

	var res []UserBrief
	for _, u := range users {
		var roles []string
		for _, r := range u.Roles {
			roles = append(roles, r.Code)
		}
		if roles == nil {
			roles = []string{}
		}
		res = append(res, UserBrief{
			ID:        u.ID,
			Username:  u.Username,
			RealName:  u.RealName,
			DeptID:    u.DeptID,
			Status:    u.Status,
			RoleCodes: roles,
		})
	}
	if res == nil {
		res = []UserBrief{}
	}

	c.JSON(http.StatusOK, res)
}

func (h *Handler) SearchUsers(c *gin.Context) {
	q := h.DB.Model(&model.User{}).Preload("Roles")

	if kw := strings.TrimSpace(c.Query("keyword")); kw != "" {
		q = q.Where("username LIKE ? OR real_name LIKE ?", "%"+kw+"%", "%"+kw+"%")
	}
	if deptID := c.Query("dept_id"); deptID != "" {
		if id, err := strconv.Atoi(deptID); err == nil {
			q = q.Where("dept_id = ?", id)
		}
	}
	if status := c.Query("status"); status != "" {
		q = q.Where("status = ?", status)
	}

	page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
	size, _ := strconv.Atoi(c.DefaultQuery("size", "20"))
	sortParam := c.Query("sort")

	allowed := map[string]string{
		"id":        "id",
		"username":  "username",
		"real_name": "real_name",
		"status":    "status",
		"dept_id":   "dept_id",
	}

	env, err := paging.Paginate[model.User](q, page, size, sortParam, allowed, "id")
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"detail": err.Error()})
		return
	}

	var briefItems []UserBrief
	for _, u := range env.Items {
		var roles []string
		for _, r := range u.Roles {
			roles = append(roles, r.Code)
		}
		if roles == nil {
			roles = []string{}
		}
		briefItems = append(briefItems, UserBrief{
			ID:        u.ID,
			Username:  u.Username,
			RealName:  u.RealName,
			DeptID:    u.DeptID,
			Status:    u.Status,
			RoleCodes: roles,
		})
	}
	if briefItems == nil {
		briefItems = []UserBrief{}
	}

	c.JSON(http.StatusOK, gin.H{
		"total": env.Total,
		"page":  env.Page,
		"size":  env.Size,
		"items": briefItems,
	})
}

func (h *Handler) GetDepts(c *gin.Context) {
	q := h.DB.Model(&model.Department{})
	if kw := strings.TrimSpace(c.Query("keyword")); kw != "" {
		q = q.Where("name LIKE ?", "%"+kw+"%")
	}
	var depts []model.Department
	if err := q.Limit(500).Find(&depts).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"detail": "查询部门失败"})
		return
	}
	if depts == nil {
		depts = []model.Department{}
	}
	c.JSON(http.StatusOK, depts)
}

func (h *Handler) GetDicts(c *gin.Context) {
	q := h.DB.Model(&model.Dict{}).Order("sort ASC, id ASC")
	if t := strings.TrimSpace(c.Query("type")); t != "" {
		q = q.Where("type = ?", t)
	}
	var dicts []model.Dict
	if err := q.Limit(500).Find(&dicts).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"detail": "查询字典失败"})
		return
	}
	if dicts == nil {
		dicts = []model.Dict{}
	}
	c.JSON(http.StatusOK, dicts)
}

func (h *Handler) GetMenus(c *gin.Context) {
	u := rbac.GetCurrentUser(c)
	effective := rbac.EffectiveModules(u)
	effectiveMap := make(map[string]bool)
	for _, m := range effective {
		effectiveMap[m] = true
	}

	var menus []rbac.CatalogItem
	for _, item := range rbac.ModuleCatalog {
		if effectiveMap[item.Key] {
			menus = append(menus, item)
		}
	}

	isSuper := rbac.IsSuperAdmin(u)
	if isSuper {
		menus = append(menus, rbac.CatalogItem{
			Key:   "admin",
			Label: "系统管理",
			Href:  "/admin",
		})
	}
	if menus == nil {
		menus = []rbac.CatalogItem{}
	}

	var roleCodes []string
	for _, r := range u.Roles {
		roleCodes = append(roleCodes, r.Code)
	}
	if roleCodes == nil {
		roleCodes = []string{}
	}

	demoOn := rbac.DemoDataOn(h.DB)

	c.JSON(http.StatusOK, gin.H{
		"roles":           roleCodes,
		"is_admin":        isSuper,
		"is_super_admin":  isSuper,
		"can_approve":     rbac.CanApprove(u),
		"can_finance":     rbac.HasModule(u, rbac.ModuleFinance),
		"menus":           menus,
		"readonly":        false,
		"demo_on":         demoOn,
		"can_toggle_demo": isSuper,
	})
}
