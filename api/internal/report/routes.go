package report

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
	g := r.Group("/reports", rbac.AuthMiddleware(db), rbac.RequireModule(rbac.ProjectScopeModules...))
	g.GET("/cost", h.Cost)
	g.GET("/cost/export", h.ExportCost)
	g.GET("/warnings", h.Warnings)
}
