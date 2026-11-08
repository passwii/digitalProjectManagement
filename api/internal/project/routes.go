package project

import (
	"digitalprojectmanagement/api/internal/rbac"
	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

type Handler struct {
	DB *gorm.DB
}

func RegisterRoutes(r *gin.RouterGroup, db *gorm.DB) {
	h := &Handler{DB: db}
	g := r.Group("/projects", rbac.AuthMiddleware(db), rbac.RequireModule(rbac.ProjectScopeModules...))

	g.GET("", h.List)
	g.GET("/options", h.Options)
	g.GET("/owners", h.Owners)
	g.GET("/recycle-bin/list", rbac.RequireAdmin(), h.RecycleBin)
	g.POST("", h.Create)

	g.GET("/:pid", h.Get)
	g.PATCH("/:pid", h.Patch)
	g.POST("/:pid/status", h.ChangeStatus)
	g.GET("/:pid/changes", h.Changes)
	g.POST("/:pid/attachments", h.UploadAttachment)
	g.GET("/:pid/attachments", h.ListAttachments)
	g.GET("/:pid/attachments/:aid/download", h.DownloadAttachment)
	g.DELETE("/:pid/attachments/:aid", h.DeleteAttachment)
	g.PUT("/:pid/members", h.SetMembers)
	g.DELETE("/:pid", rbac.RequireAdmin(), h.Delete)
	g.POST("/:pid/restore", rbac.RequireAdmin(), h.Restore)
	g.GET("/:pid/followups", h.ListFollowups)
	g.POST("/:pid/followups", h.CreateFollowup)
	g.PATCH("/:pid/followups/:fid", h.PatchFollowup)
	g.DELETE("/:pid/followups/:fid", h.DeleteFollowup)
	g.POST("/:pid/followups/:fid/remind", h.HandleFollowupReminder)
	g.GET("/:pid/progress", h.Progress)
	g.POST("/:pid/progress/confirm", h.ConfirmProgress)
}
