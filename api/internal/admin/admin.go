package admin

import (
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"unicode"

	"digitalprojectmanagement/api/internal/model"
	"digitalprojectmanagement/api/internal/rbac"
	"digitalprojectmanagement/api/pkg/audit"
	"digitalprojectmanagement/api/pkg/excel"
	"digitalprojectmanagement/api/pkg/paging"
	"digitalprojectmanagement/api/pkg/security"
	"digitalprojectmanagement/api/pkg/timeutil"
	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

type Handler struct {
	DB *gorm.DB
}

func RegisterRoutes(r *gin.RouterGroup, db *gorm.DB) {
	h := &Handler{DB: db}
	adminGroup := r.Group("/admin", rbac.AuthMiddleware(db), rbac.RequireAdmin())
	{
		adminGroup.GET("/users", h.GetUsers)
		adminGroup.POST("/users", h.CreateUser)
		adminGroup.PATCH("/users/:uid", h.UpdateUser)
		adminGroup.GET("/demo-data", h.GetDemoData)
		adminGroup.PUT("/demo-data", h.UpdateDemoData)
		adminGroup.GET("/roles", h.GetRoles)
		adminGroup.GET("/modules", h.GetModules)
		adminGroup.GET("/dicts", h.GetDicts)
		adminGroup.POST("/dicts", h.CreateDict)
		adminGroup.GET("/params", h.GetParams)
		adminGroup.PUT("/params", h.UpdateParams)
		adminGroup.GET("/logs/export", h.ExportLogs)
		adminGroup.GET("/logs", h.GetLogs)
	}
}

type UserDetail struct {
	ID              uint     `json:"id"`
	Username        string   `json:"username"`
	RealName        string   `json:"real_name"`
	DeptID          *uint    `json:"dept_id"`
	DepartmentName  string   `json:"dept_name"`
	Status          string   `json:"status"`
	IsSuperAdmin    bool     `json:"is_super_admin"`
	MustChangePwd   bool     `json:"must_change_pwd"`
	ModulesAssigned bool     `json:"modules_assigned"`
	Modules         []string `json:"modules"`
	RoleCodes       []string `json:"role_codes"`
	CreatedAt       string   `json:"created_at"`
}

func serializeUser(u *model.User) UserDetail {
	var roles []string
	for _, r := range u.Roles {
		roles = append(roles, r.Code)
	}
	if roles == nil {
		roles = []string{}
	}
	var mods []string
	for _, m := range u.Modules {
		mods = append(mods, m.Module)
	}
	if mods == nil {
		mods = []string{}
	}
	deptName := ""
	if u.Department != nil {
		deptName = u.Department.Name
	}
	return UserDetail{
		ID:              u.ID,
		Username:        u.Username,
		RealName:        u.RealName,
		DeptID:          u.DeptID,
		DepartmentName:  deptName,
		Status:          u.Status,
		IsSuperAdmin:    u.IsSuperAdmin,
		MustChangePwd:   u.MustChangePwd,
		ModulesAssigned: u.ModulesAssigned,
		Modules:         mods,
		RoleCodes:       roles,
		CreatedAt:       u.CreatedAt.Format("2006-01-02 15:04:05"),
	}
}

func (h *Handler) GetUsers(c *gin.Context) {
	q := h.DB.Model(&model.User{}).Preload("Department").Preload("Roles").Preload("Modules")

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
		"id":         "id",
		"username":   "username",
		"real_name":  "real_name",
		"status":     "status",
		"dept_id":    "dept_id",
		"created_at": "created_at",
	}

	env, err := paging.Paginate[model.User](q, page, size, sortParam, allowed, "id")
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"detail": err.Error()})
		return
	}

	var items []UserDetail
	for i := range env.Items {
		items = append(items, serializeUser(&env.Items[i]))
	}
	if items == nil {
		items = []UserDetail{}
	}

	c.JSON(http.StatusOK, gin.H{
		"total": env.Total,
		"page":  env.Page,
		"size":  env.Size,
		"items": items,
	})
}

var phoneRegex = regexp.MustCompile(`^\d{11}$`)

type CreateUserReq struct {
	Username string   `json:"username"`
	Password string   `json:"password"`
	RealName string   `json:"real_name"`
	DeptID   *uint    `json:"dept_id"`
	Modules  []string `json:"modules"`
}

func (h *Handler) CreateUser(c *gin.Context) {
	currentUser := rbac.GetCurrentUser(c)
	var req CreateUserReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "请求格式错误"})
		return
	}

	req.Username = strings.TrimSpace(req.Username)
	if !phoneRegex.MatchString(req.Username) {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "用户名须为11位手机号"})
		return
	}

	// 密码校验：如果传了必须合规，没传默认初始密码
	pwd := strings.TrimSpace(req.Password)
	if pwd == "" {
		pwd = "User" + req.Username[len(req.Username)-4:] + "123"
	}
	if len(pwd) < 8 {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "密码至少8位，且包含字母和数字"})
		return
	}
	hasLetter, hasNumber := false, false
	for _, ch := range pwd {
		if unicode.IsLetter(ch) {
			hasLetter = true
		} else if unicode.IsNumber(ch) {
			hasNumber = true
		}
	}
	if !hasLetter || !hasNumber {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "密码至少8位，且包含字母和数字"})
		return
	}

	// 重复检查
	var exists int64
	h.DB.Model(&model.User{}).Where("username = ?", req.Username).Count(&exists)
	if exists > 0 {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "账号已存在"})
		return
	}

	hash, err := security.HashPassword(pwd)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"detail": "密码处理失败"})
		return
	}

	user := model.User{
		Username:        req.Username,
		PwdHash:         hash,
		RealName:        req.RealName,
		DeptID:          req.DeptID,
		Status:          "active",
		MustChangePwd:   true,
		ModulesAssigned: true,
		CreatedAt:       timeutil.NowDateTime(),
	}

	err = h.DB.Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(&user).Error; err != nil {
			return err
		}
		// 写入模块
		for _, m := range req.Modules {
			mod := model.UserModule{UserID: user.ID, Module: m}
			if err := tx.Create(&mod).Error; err != nil {
				return err
			}
		}
		// 关联或创建通讯录档案
		var contact model.ContactProfile
		if err := tx.Where("mobile = ? OR user_id = ?", user.Username, user.ID).First(&contact).Error; err == nil {
			contact.UserID = &user.ID
			contact.Name = user.RealName
			contact.DeptID = user.DeptID
			tx.Save(&contact)
		} else {
			contact = model.ContactProfile{
				UserID:    &user.ID,
				Name:      user.RealName,
				Mobile:    user.Username,
				DeptID:    user.DeptID,
				CreatedAt: timeutil.NowDateTime(),
				UpdatedAt: timeutil.NowDateTime(),
			}
			tx.Create(&contact)
		}

		return audit.CommitAudited(tx, &currentUser.ID, "create", "user", strconv.Itoa(int(user.ID)), fmt.Sprintf("创建用户 %s", user.Username), c.ClientIP())
	})

	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"detail": "创建用户失败"})
		return
	}

	_ = h.DB.Preload("Department").Preload("Roles").Preload("Modules").First(&user, user.ID)
	c.JSON(http.StatusOK, serializeUser(&user))
}

type UpdateUserReq struct {
	RealName *string   `json:"real_name"`
	Status   *string   `json:"status"`
	DeptID   *uint     `json:"dept_id"`
	Password *string   `json:"password"`
	Modules  *[]string `json:"modules"`
}

func (h *Handler) UpdateUser(c *gin.Context) {
	currentUser := rbac.GetCurrentUser(c)
	uid, err := strconv.Atoi(c.Param("uid"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "无效的用户 ID"})
		return
	}

	var user model.User
	if err := h.DB.Preload("Department").Preload("Roles").Preload("Modules").First(&user, uid).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"detail": "用户不存在"})
		return
	}

	var req UpdateUserReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "请求格式错误"})
		return
	}

	if user.IsSuperAdmin && req.Status != nil && *req.Status != "active" {
		c.JSON(http.StatusConflict, gin.H{"detail": "不可停用超级管理员"})
		return
	}

	err = h.DB.Transaction(func(tx *gorm.DB) error {
		if req.RealName != nil {
			user.RealName = *req.RealName
		}
		if req.DeptID != nil {
			user.DeptID = req.DeptID
		}
		if req.Status != nil {
			user.Status = *req.Status
			if user.Status == "active" {
				user.LoginFailCount = 0
				user.LockedUntil = nil
			}
		}
		if req.Password != nil && strings.TrimSpace(*req.Password) != "" {
			pwd := strings.TrimSpace(*req.Password)
			if len(pwd) < 8 {
				return fmt.Errorf("密码至少8位，且包含字母和数字")
			}
			hash, err := security.HashPassword(pwd)
			if err != nil {
				return err
			}
			user.PwdHash = hash
			user.MustChangePwd = false
		}
		if err := tx.Save(&user).Error; err != nil {
			return err
		}

		if req.Modules != nil {
			user.ModulesAssigned = true
			tx.Save(&user)
			tx.Where("user_id = ?", user.ID).Delete(&model.UserModule{})
			for _, m := range *req.Modules {
				tx.Create(&model.UserModule{UserID: user.ID, Module: m})
			}
		}

		// 同步通讯录
		var contact model.ContactProfile
		if err := tx.Where("user_id = ?", user.ID).First(&contact).Error; err == nil {
			if req.RealName != nil {
				contact.Name = *req.RealName
			}
			if req.DeptID != nil {
				contact.DeptID = req.DeptID
			}
			contact.UpdatedAt = timeutil.NowDateTime()
			tx.Save(&contact)
		}

		return audit.CommitAudited(tx, &currentUser.ID, "update", "user", strconv.Itoa(int(user.ID)), fmt.Sprintf("更新用户 %s", user.Username), c.ClientIP())
	})

	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"detail": err.Error()})
		return
	}

	_ = h.DB.Preload("Department").Preload("Roles").Preload("Modules").First(&user, user.ID)
	c.JSON(http.StatusOK, serializeUser(&user))
}

func (h *Handler) GetDemoData(c *gin.Context) {
	on := rbac.DemoDataOn(h.DB)
	var activeCount, deletedCount int64
	h.DB.Model(&model.Project{}).Where("is_demo = ? AND deleted_at IS NULL", true).Count(&activeCount)
	h.DB.Model(&model.Project{}).Where("is_demo = ? AND deleted_at IS NOT NULL", true).Count(&deletedCount)

	c.JSON(http.StatusOK, gin.H{
		"on":                    on,
		"demo_projects":         activeCount,
		"demo_projects_deleted": deletedCount,
	})
}

type DemoDataReq struct {
	On bool `json:"on"`
}

func (h *Handler) UpdateDemoData(c *gin.Context) {
	currentUser := rbac.GetCurrentUser(c)
	var req DemoDataReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "请求格式错误"})
		return
	}

	val := "0"
	if req.On {
		val = "1"
	}

	var param model.SysParam
	err := h.DB.Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("key = ?", "demo_data_on").First(&param).Error; err == nil {
			param.Value = val
			tx.Save(&param)
		} else {
			param = model.SysParam{
				Key:   "demo_data_on",
				Value: val,
				Desc:  "演示数据开关 0隐藏/1显示",
			}
			tx.Create(&param)
		}
		return audit.CommitAudited(tx, &currentUser.ID, "update", "sys_param", "demo_data_on", fmt.Sprintf("设置演示数据开关为 %s", val), c.ClientIP())
	})

	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"detail": "更新演示数据开关失败"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"on": req.On})
}

func (h *Handler) GetRoles(c *gin.Context) {
	var roles []model.Role
	h.DB.Find(&roles)
	c.JSON(http.StatusOK, roles)
}

func (h *Handler) GetModules(c *gin.Context) {
	c.JSON(http.StatusOK, rbac.ModuleCatalog)
}

func (h *Handler) GetDicts(c *gin.Context) {
	q := h.DB.Model(&model.Dict{}).Order("sort ASC, id ASC")
	if t := strings.TrimSpace(c.Query("type")); t != "" {
		q = q.Where("type = ?", t)
	}
	var dicts []model.Dict
	h.DB.Limit(500).Find(&dicts)
	c.JSON(http.StatusOK, dicts)
}

type CreateDictReq struct {
	Type  string `json:"type"`
	Code  string `json:"code"`
	Label string `json:"label"`
	Sort  int    `json:"sort"`
}

func (h *Handler) CreateDict(c *gin.Context) {
	currentUser := rbac.GetCurrentUser(c)
	var req CreateDictReq
	if err := c.ShouldBindJSON(&req); err != nil || req.Type == "" || req.Code == "" {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "type 和 code 必填"})
		return
	}
	dict := model.Dict{
		Type:  req.Type,
		Code:  req.Code,
		Label: req.Label,
		Sort:  req.Sort,
	}
	err := h.DB.Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(&dict).Error; err != nil {
			return err
		}
		return audit.CommitAudited(tx, &currentUser.ID, "create_dict", "dicts", strconv.Itoa(int(dict.ID)), dict.Type+":"+dict.Code, c.ClientIP())
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"detail": "创建字典失败"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"id": dict.ID})
}

func (h *Handler) GetParams(c *gin.Context) {
	var params []model.SysParam
	h.DB.Find(&params)
	res := make(map[string]string)
	for _, p := range params {
		res[p.Key] = p.Value
	}
	c.JSON(http.StatusOK, res)
}

func (h *Handler) UpdateParams(c *gin.Context) {
	currentUser := rbac.GetCurrentUser(c)
	var req map[string]interface{}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "请求格式错误"})
		return
	}

	err := h.DB.Transaction(func(tx *gorm.DB) error {
		for k, v := range req {
			strVal := fmt.Sprintf("%v", v)
			var p model.SysParam
			if err := tx.Where("key = ?", k).First(&p).Error; err == nil {
				p.Value = strVal
				tx.Save(&p)
			} else {
				tx.Create(&model.SysParam{Key: k, Value: strVal})
			}
		}
		return audit.CommitAudited(tx, &currentUser.ID, "update", "sys_param", "batch", "批量更新系统参数", c.ClientIP())
	})

	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"detail": "更新系统参数失败"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (h *Handler) ExportLogs(c *gin.Context) {
	currentUser := rbac.GetCurrentUser(c)
	q := h.DB.Model(&model.AuditLog{}).Order("id DESC")

	if act := strings.TrimSpace(c.Query("action")); act != "" {
		q = q.Where("action = ?", act)
	}
	if uidStr := strings.TrimSpace(c.Query("user_id")); uidStr != "" {
		if uid, err := strconv.Atoi(uidStr); err == nil {
			q = q.Where("user_id = ?", uid)
		}
	}

	limit, _ := strconv.Atoi(c.DefaultQuery("limit", "5000"))
	if limit < 1 {
		limit = 1
	}
	if limit > 20000 {
		limit = 20000
	}

	var logs []model.AuditLog
	q.Limit(limit).Find(&logs)

	// 获取涉及的用户姓名
	userMap := make(map[uint]string)
	var uids []uint
	for _, l := range logs {
		if l.UserID != nil {
			uids = append(uids, *l.UserID)
		}
	}
	if len(uids) > 0 {
		var users []model.User
		h.DB.Where("id IN ?", uids).Find(&users)
		for _, u := range users {
			name := u.RealName
			if name == "" {
				name = u.Username
			}
			userMap[u.ID] = name
		}
	}

	headers := []string{"ID", "时间", "操作人", "动作", "资源类型", "资源ID", "详情", "IP"}
	var rows [][]string
	for _, l := range logs {
		userName := "系统"
		if l.UserID != nil {
			if n, ok := userMap[*l.UserID]; ok {
				userName = n
			} else {
				userName = fmt.Sprintf("用户 #%d", *l.UserID)
			}
		}
		rows = append(rows, []string{
			strconv.Itoa(int(l.ID)),
			l.CreatedAt.Format("2006-01-02 15:04:05"),
			userName,
			l.Action,
			l.Resource,
			l.ResourceID,
			l.Detail,
			l.IP,
		})
	}

	data, err := excel.GenerateXLSX("审计日志", headers, rows)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"detail": "生成日志导出失败"})
		return
	}

	_ = audit.WriteAudit(h.DB, &currentUser.ID, "export", "audit_log", "", fmt.Sprintf("导出 %d 条审计日志", len(logs)), c.ClientIP())

	c.Header("Content-Disposition", "attachment; filename=audit_logs.xlsx")
	c.Data(http.StatusOK, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", data)
}

type LogItem struct {
	ID         uint              `json:"id"`
	UserID     *uint             `json:"user_id"`
	UserName   string            `json:"user_name"`
	Action     string            `json:"action"`
	Resource   string            `json:"resource"`
	ResourceID string            `json:"resource_id"`
	Detail     string            `json:"detail"`
	IP         string            `json:"ip"`
	CreatedAt  timeutil.DateTime `json:"created_at"`
}

func (h *Handler) GetLogs(c *gin.Context) {
	q := h.DB.Model(&model.AuditLog{})

	if act := strings.TrimSpace(c.Query("action")); act != "" {
		q = q.Where("action = ?", act)
	}
	if uidStr := strings.TrimSpace(c.Query("user_id")); uidStr != "" {
		if uid, err := strconv.Atoi(uidStr); err == nil {
			q = q.Where("user_id = ?", uid)
		}
	}

	page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
	size, _ := strconv.Atoi(c.DefaultQuery("size", "20"))
	sortParam := c.Query("sort")

	allowed := map[string]string{
		"id":         "id",
		"created_at": "created_at",
		"action":     "action",
		"resource":   "resource",
	}

	env, err := paging.Paginate[model.AuditLog](q, page, size, sortParam, allowed, "-id")
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"detail": err.Error()})
		return
	}

	// 补全用户名
	var uids []uint
	for _, l := range env.Items {
		if l.UserID != nil {
			uids = append(uids, *l.UserID)
		}
	}
	userMap := make(map[uint]string)
	if len(uids) > 0 {
		var users []model.User
		h.DB.Where("id IN ?", uids).Find(&users)
		for _, u := range users {
			name := u.RealName
			if name == "" {
				name = u.Username
			}
			userMap[u.ID] = name
		}
	}

	var items []LogItem
	for _, l := range env.Items {
		name := "未知用户"
		if l.UserID != nil {
			if n, ok := userMap[*l.UserID]; ok {
				name = n
			} else {
				name = fmt.Sprintf("用户 #%d", *l.UserID)
			}
		}
		items = append(items, LogItem{
			ID:         l.ID,
			UserID:     l.UserID,
			UserName:   name,
			Action:     l.Action,
			Resource:   l.Resource,
			ResourceID: l.ResourceID,
			Detail:     l.Detail,
			IP:         l.IP,
			CreatedAt:  l.CreatedAt,
		})
	}
	if items == nil {
		items = []LogItem{}
	}

	c.JSON(http.StatusOK, gin.H{
		"total": env.Total,
		"page":  env.Page,
		"size":  env.Size,
		"items": items,
	})
}
