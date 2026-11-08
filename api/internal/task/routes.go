package task

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
	g := r.Group("", rbac.AuthMiddleware(db))
	g.GET("/tasks", h.List)
	g.POST("/tasks", h.Create)
	g.PATCH("/tasks/:tid", h.Patch)
	g.DELETE("/tasks/:tid", h.Delete)
	g.POST("/tasks/import", h.Import)
	g.GET("/progress-logs", h.ListLogs)
	g.POST("/progress-logs", h.CreateLog)
	g.GET("/progress-logs/:lid", h.GetLog)
}
