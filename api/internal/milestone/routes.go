package milestone

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
	g := r.Group("/milestones", rbac.AuthMiddleware(db))
	g.GET("", h.List)
	g.POST("", h.Create)
	g.PATCH("/:mid", h.Patch)
	g.DELETE("/:mid", h.Delete)
}
