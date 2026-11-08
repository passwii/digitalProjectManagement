package auth

import (
	"fmt"
	"errors"
	
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode"

	"digitalprojectmanagement/api/internal/model"
	"digitalprojectmanagement/api/internal/rbac"
	"digitalprojectmanagement/api/pkg/audit"
	"digitalprojectmanagement/api/pkg/security"
	"digitalprojectmanagement/api/pkg/timeutil"
	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

type Handler struct {
	DB *gorm.DB
}

func RegisterRoutes(r *gin.RouterGroup, db *gorm.DB) {
	h := &Handler{DB: db}
	authGroup := r.Group("/auth")
	{
		authGroup.POST("/login", h.Login)
		authGroup.POST("/refresh", h.Refresh)
		authGroup.POST("/logout", rbac.AuthMiddleware(db), h.Logout)
		authGroup.POST("/change-password", rbac.AuthMiddleware(db), h.ChangePassword)
		authGroup.GET("/me", rbac.AuthMiddleware(db), h.Me)
	}
}

type LoginReq struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

func (h *Handler) Login(c *gin.Context) {
	var req LoginReq
	if err := c.ShouldBindJSON(&req); err != nil || strings.TrimSpace(req.Username) == "" || strings.TrimSpace(req.Password) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "账号和密码不能为空"})
		return
	}

	var user model.User
	err := h.DB.Preload("Roles").Preload("Modules").Where("username = ?", req.Username).First(&user).Error

	now := timeutil.AppNow()

	// 查参数：连续失败阈值和锁定分钟数
	failLimit := 5
	lockMinutes := 15
	var paramLimit model.SysParam
	if err := h.DB.Where("key = ?", "login_fail_limit").First(&paramLimit).Error; err == nil {
		if v, e := strconv.Atoi(paramLimit.Value); e == nil && v > 0 {
			failLimit = v
		}
	}
	var paramLock model.SysParam
	if err := h.DB.Where("key = ?", "login_lock_minutes").First(&paramLock).Error; err == nil {
		if v, e := strconv.Atoi(paramLock.Value); e == nil && v > 0 {
			lockMinutes = v
		}
	}

	if err != nil {
		_ = audit.WriteAudit(h.DB, nil, "login_fail", "auth", req.Username, "用户不存在", c.ClientIP())
		c.JSON(http.StatusUnauthorized, gin.H{"detail": "账号或密码错误"})
		return
	}

	if user.Status == "disabled" {
		c.JSON(http.StatusForbidden, gin.H{"detail": "账号已停用"})
		return
	}

	// 检查锁定
	if user.LockedUntil != nil && user.LockedUntil.After(now) {
		c.JSON(http.StatusForbidden, gin.H{"detail": "账号已被锁定，请稍后再试"})
		return
	}

	// 验证密码
	if !security.VerifyPassword(req.Password, user.PwdHash) {
		msg := "账号或密码错误"
		_ = h.DB.Transaction(func(tx *gorm.DB) error {
			var lockedUser model.User
			if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("id = ?", user.ID).First(&lockedUser).Error; err != nil {
				return err
			}
			lockedUser.LoginFailCount++
			updates := map[string]any{
				"failed_count": lockedUser.LoginFailCount,
			}
			locked := false
			if lockedUser.LoginFailCount >= failLimit {
				lockedTime := timeutil.NewDateTime(now.Add(time.Duration(lockMinutes) * time.Minute))
				updates["locked_until"] = &lockedTime
				updates["status"] = "locked"
				locked = true
			}
			if err := tx.Model(&model.User{}).Where("id = ?", lockedUser.ID).Updates(updates).Error; err != nil {
				return err
			}
			if locked {
				msg = fmt.Sprintf("密码错误，已锁定%d分钟", lockMinutes)
			}
			return audit.CommitAudited(tx, &lockedUser.ID, "login_fail", "auth", req.Username, "密码错误", c.ClientIP())
		})
		c.JSON(http.StatusUnauthorized, gin.H{"detail": msg})
		return
	}

	// 登录成功：在行锁事务中更新会话版本号与审计，保证并发登录获得不同的版本号
	err = h.DB.Transaction(func(tx *gorm.DB) error {
		var lockedUser model.User
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("id = ?", user.ID).First(&lockedUser).Error; err != nil {
			return err
		}
		if lockedUser.Status == "disabled" {
			return errors.New("user_disabled")
		}
		lockedUser.LoginFailCount = 0
		lockedUser.LockedUntil = nil
		if lockedUser.Status == "locked" {
			lockedUser.Status = "active"
		}
		lockedUser.SessionVersion++
		if err := tx.Save(&lockedUser).Error; err != nil {
			return err
		}
		user = lockedUser
		subStr := strconv.Itoa(int(user.ID))
		return audit.WriteAudit(tx, &user.ID, "login", "auth", subStr, "用户登录", c.ClientIP())
	})
	if err != nil {
		if err.Error() == "user_disabled" {
			c.JSON(http.StatusForbidden, gin.H{"detail": "账号已停用"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"detail": "保存用户会话状态失败"})
		return
	}

	subStr := strconv.Itoa(int(user.ID))
	accessToken, err := security.CreateAccessToken(subStr, user.SessionVersion)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"detail": "生成令牌失败"})
		return
	}
	refreshToken, err := security.CreateRefreshToken(subStr, user.SessionVersion)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"detail": "生成令牌失败"})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"access_token":    accessToken,
		"refresh_token":   refreshToken,
		"token_type":      "bearer",
		"must_change_pwd": user.MustChangePwd,
	})
}

func (h *Handler) Logout(c *gin.Context) {
	u := rbac.GetCurrentUser(c)
	authHeader := c.GetHeader("Authorization")
	parts := strings.SplitN(authHeader, " ", 2)

	err := h.DB.Transaction(func(tx *gorm.DB) error {
		var lockedUser model.User
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("id = ?", u.ID).First(&lockedUser).Error; err != nil {
			return err
		}
		lockedUser.SessionVersion++
		if err := tx.Save(&lockedUser).Error; err != nil {
			return err
		}
		if len(parts) == 2 {
			if claims, err := security.DecodeToken(parts[1], "access"); err == nil {
				expTime := timeutil.NewDateTime(claims.ExpiresAt.Time)
				blacklist := model.TokenBlacklist{
					JTI:       claims.JTI,
					UserID:    &lockedUser.ID,
					ExpiresAt: &expTime,
					CreatedAt: timeutil.NowDateTime(),
				}
				if err := tx.Create(&blacklist).Error; err != nil {
					return err
				}
			}
		}
		subStr := strconv.Itoa(int(lockedUser.ID))
		return audit.CommitAudited(tx, &lockedUser.ID, "logout", "auth", subStr, "登出成功", c.ClientIP())
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"detail": "退出登录失败"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"ok": true, "detail": "已退出登录"})
}

type RefreshReq struct {
	RefreshToken string `json:"refresh_token"`
}

func (h *Handler) Refresh(c *gin.Context) {
	var req RefreshReq
	if err := c.ShouldBindJSON(&req); err != nil || strings.TrimSpace(req.RefreshToken) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "缺少 refresh_token"})
		return
	}

	claims, err := security.DecodeToken(req.RefreshToken, "refresh")
	if err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"detail": "刷新令牌无效或已过期"})
		return
	}

	var count int64
	h.DB.Model(&model.TokenBlacklist{}).Where("jti = ?", claims.JTI).Count(&count)
	if count > 0 {
		c.JSON(http.StatusUnauthorized, gin.H{"detail": "令牌已失效"})
		return
	}

	var user model.User
	if err := h.DB.First(&user, "id = ?", claims.Sub).Error; err != nil || user.Status != "active" {
		c.JSON(http.StatusUnauthorized, gin.H{"detail": "用户不可用"})
		return
	}

	if claims.SessionVersion != user.SessionVersion {
		c.JSON(http.StatusUnauthorized, gin.H{"detail": "会话已过期"})
		return
	}

	newAccessToken, err := security.CreateAccessToken(claims.Sub, user.SessionVersion)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"detail": "生成令牌失败"})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"access_token": newAccessToken,
		"token_type":   "bearer",
	})
}

type ChangePwdReq struct {
	OldPassword string `json:"old_password"`
	NewPassword string `json:"new_password"`
}

func (h *Handler) ChangePassword(c *gin.Context) {
	u := rbac.GetCurrentUser(c)
	var req ChangePwdReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "请求格式错误"})
		return
	}

	if !security.VerifyPassword(req.OldPassword, u.PwdHash) {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "原密码错误"})
		return
	}

	if req.NewPassword == req.OldPassword {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "新密码不能与原密码相同"})
		return
	}

	if len(req.NewPassword) < 8 {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "新密码至少8位，且包含字母和数字"})
		return
	}

	hasLetter, hasNumber := false, false
	for _, ch := range req.NewPassword {
		if unicode.IsLetter(ch) {
			hasLetter = true
		} else if unicode.IsNumber(ch) {
			hasNumber = true
		}
	}
	if !hasLetter || !hasNumber {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "新密码至少8位，且包含字母和数字"})
		return
	}

	newHash, err := security.HashPassword(req.NewPassword)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"detail": "密码哈希失败"})
		return
	}

	err = h.DB.Transaction(func(tx *gorm.DB) error {
		var lockedUser model.User
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("id = ?", u.ID).First(&lockedUser).Error; err != nil {
			return err
		}
		if !security.VerifyPassword(req.OldPassword, lockedUser.PwdHash) {
			return errors.New("old_password_wrong")
		}
		updates := map[string]any{
			"pwd_hash":        newHash,
			"must_change_pwd": false,
			"failed_count":    0,
			"locked_until":    nil,
		}
		if err := tx.Model(&model.User{}).Where("id = ?", lockedUser.ID).Updates(updates).Error; err != nil {
			return err
		}
		return audit.CommitAudited(tx, &lockedUser.ID, "change_password", "auth", strconv.Itoa(int(lockedUser.ID)), "修改密码", c.ClientIP())
	})
	if err != nil {
		if err.Error() == "old_password_wrong" {
			c.JSON(http.StatusBadRequest, gin.H{"detail": "原密码错误"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"detail": "修改密码失败"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (h *Handler) Me(c *gin.Context) {
	u := rbac.GetCurrentUser(c)
	type RoleItem struct {
		Code string `json:"code"`
		Name string `json:"name"`
	}
	var roles []RoleItem
	for _, r := range u.Roles {
		roles = append(roles, RoleItem{Code: r.Code, Name: r.Name})
	}
	if roles == nil {
		roles = []RoleItem{}
	}

	c.JSON(http.StatusOK, gin.H{
		"id":              u.ID,
		"username":        u.Username,
		"real_name":       u.RealName,
		"dept_id":         u.DeptID,
		"status":          u.Status,
		"roles":           roles,
		"must_change_pwd": u.MustChangePwd,
		"is_super_admin":  u.IsSuperAdmin,
	})
}
