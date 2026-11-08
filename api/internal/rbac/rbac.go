package rbac

import (
	"net/http"
	"strings"

	"digitalprojectmanagement/api/internal/model"
	"digitalprojectmanagement/api/pkg/security"
	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

const (
	ModuleOpportunities = "opportunities"
	ModuleProjects      = "projects"
	ModuleAssets        = "assets"
	ModuleReports       = "reports"
	ModuleContacts      = "contacts"
	ModulePartners      = "partners"
	ModuleApprovals     = "approvals"
	ModuleFinance       = "finance"
)

type CatalogItem struct {
	Key   string `json:"key"`
	Label string `json:"label"`
	Href  string `json:"href"`
}

var ModuleCatalog = []CatalogItem{
	{ModuleOpportunities, "商机管理", "/opportunities"},
	{ModuleProjects, "项目台账", "/projects"},
	{ModuleAssets, "资产管理", "/assets"},
	{ModuleReports, "支出报表", "/reports"},
	{ModuleContacts, "通讯录", "/contacts"},
	{ModulePartners, "我的友商", "/partners"},
	{ModuleApprovals, "审批中心", "/approvals"},
	{ModuleFinance, "财务管理", "/finance"},
}

var AllModules = []string{
	ModuleOpportunities,
	ModuleProjects,
	ModuleAssets,
	ModuleReports,
	ModuleContacts,
	ModulePartners,
	ModuleApprovals,
	ModuleFinance,
}

var DefaultModules = []string{
	ModuleOpportunities,
	ModuleProjects,
	ModuleAssets,
	ModuleReports,
}

var ProjectScopeModules = []string{
	ModuleOpportunities,
	ModuleProjects,
	ModuleAssets,
	ModuleReports,
}

func IsSuperAdmin(u *model.User) bool {
	return u != nil && u.IsSuperAdmin
}

func EffectiveModules(u *model.User) []string {
	if u == nil {
		return []string{}
	}
	if IsSuperAdmin(u) {
		return AllModules
	}
	if u.ModulesAssigned {
		var res []string
		assigned := make(map[string]bool)
		for _, m := range u.Modules {
			assigned[m.Module] = true
		}
		for _, mod := range AllModules {
			if assigned[mod] {
				res = append(res, mod)
			}
		}
		if res == nil {
			res = []string{}
		}
		return res
	}
	return DefaultModules
}

func HasModule(u *model.User, module string) bool {
	for _, m := range EffectiveModules(u) {
		if m == module {
			return true
		}
	}
	return false
}

func HasProjectScope(u *model.User) bool {
	if IsSuperAdmin(u) {
		return true
	}
	for _, m := range ProjectScopeModules {
		if HasModule(u, m) {
			return true
		}
	}
	return false
}

func CanApprove(u *model.User) bool {
	return HasModule(u, ModuleApprovals)
}

func DemoDataOn(db *gorm.DB) bool {
	var param model.SysParam
	if err := db.Where("key = ?", "demo_data_on").First(&param).Error; err != nil {
		return false
	}
	return param.Value == "1"
}

// VisibleProjectSubquery 返回 (Project.deleted_at IS NULL AND (权限范围 ∩ 演示数据开关))
func VisibleProjectSubquery(db *gorm.DB, u *model.User) *gorm.DB {
	q := db.Model(&model.Project{}).Select("id").Where("deleted_at IS NULL")
	if !DemoDataOn(db) {
		q = q.Where("is_demo = ?", false)
	}
	if HasProjectScope(u) {
		return q
	}
	// 普通用户：负责人 或 项目成员
	return q.Where("owner_id = ? OR id IN (SELECT project_id FROM project_members WHERE user_id = ?)", u.ID, u.ID)
}

// CurrentUserKey gin context key
const CurrentUserKey = "current_user"

func GetCurrentUser(c *gin.Context) *model.User {
	if val, ok := c.Get(CurrentUserKey); ok {
		if u, ok := val.(*model.User); ok {
			return u
		}
	}
	return nil
}

// AuthMiddleware 登录态校验中间件
func AuthMiddleware(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		authHeader := c.GetHeader("Authorization")
		if authHeader == "" {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"detail": "未登录"})
			return
		}
		parts := strings.SplitN(authHeader, " ", 2)
		if len(parts) != 2 || !strings.EqualFold(parts[0], "bearer") {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"detail": "未登录"})
			return
		}

		claims, err := security.DecodeToken(parts[1], "access")
		if err != nil {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"detail": "登录已过期"})
			return
		}

		// 检查黑名单
		var count int64
		db.Model(&model.TokenBlacklist{}).Where("jti = ?", claims.JTI).Count(&count)
		if count > 0 {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"detail": "会话已失效"})
			return
		}

		// 查询用户
		var user model.User
		if err := db.Preload("Roles").Preload("Modules").First(&user, "id = ?", claims.Sub).Error; err != nil {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"detail": "用户不存在"})
			return
		}

		if claims.SessionVersion != user.SessionVersion {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"detail": "会话已失效"})
			return
		}

		if user.Status != "active" {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"detail": "账号不可用"})
			return
		}

		c.Set(CurrentUserKey, &user)
		c.Next()
	}
}

// RequireAdmin 超管门禁中间件
func RequireAdmin() gin.HandlerFunc {
	return func(c *gin.Context) {
		u := GetCurrentUser(c)
		if u == nil {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"detail": "未登录"})
			return
		}
		if !IsSuperAdmin(u) {
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"detail": "仅超级管理员可操作"})
			return
		}
		c.Next()
	}
}

// RequireModule 模块门禁中间件 (拥有任一模块即可放行)
func RequireModule(modules ...string) gin.HandlerFunc {
	return func(c *gin.Context) {
		u := GetCurrentUser(c)
		if u == nil {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"detail": "未登录"})
			return
		}
		if IsSuperAdmin(u) {
			c.Next()
			return
		}
		allowed := false
		for _, m := range modules {
			if HasModule(u, m) {
				allowed = true
				break
			}
		}
		if !allowed {
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"detail": "无权访问该功能模块"})
			return
		}
		c.Next()
	}
}
