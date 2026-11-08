package rbac

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"digitalprojectmanagement/api/internal/model"
	"github.com/gin-gonic/gin"
)

func TestRBACModuleGuard(t *testing.T) {
	gin.SetMode(gin.TestMode)

	r := gin.New()
	r.Use(func(c *gin.Context) {
		// 模拟普通用户，只拥有 contacts 模块
		user := &model.User{
			ID:              10,
			Username:        "13800000001",
			ModulesAssigned: true,
			Modules: []model.UserModule{
				{UserID: 10, Module: ModuleContacts},
			},
		}
		c.Set(CurrentUserKey, user)
		c.Next()
	})

	r.GET("/protected-reports", RequireModule(ProjectScopeModules...), func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"ok": true})
	})
	r.GET("/protected-contacts", RequireModule(ModuleContacts), func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"ok": true})
	})

	// 测试访问无权限模块 -> 403
	w1 := httptest.NewRecorder()
	req1, _ := http.NewRequest("GET", "/protected-reports", nil)
	r.ServeHTTP(w1, req1)
	if w1.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for unauthorized module, got %d", w1.Code)
	}

	// 测试访问有权限模块 -> 200
	w2 := httptest.NewRecorder()
	req2, _ := http.NewRequest("GET", "/protected-contacts", nil)
	r.ServeHTTP(w2, req2)
	if w2.Code != http.StatusOK {
		t.Fatalf("expected 200 for authorized module, got %d", w2.Code)
	}
}

func TestSuperAdminBypassesModuleGuard(t *testing.T) {
	gin.SetMode(gin.TestMode)

	r := gin.New()
	r.Use(func(c *gin.Context) {
		// 模拟超级管理员
		user := &model.User{
			ID:           1,
			Username:     "15796280534",
			IsSuperAdmin: true,
		}
		c.Set(CurrentUserKey, user)
		c.Next()
	})

	r.GET("/protected-reports", RequireModule(ProjectScopeModules...), func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"ok": true})
	})

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("GET", "/protected-reports", nil)
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 for super admin, got %d", w.Code)
	}
}
