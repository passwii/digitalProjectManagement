package dashboard

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
	g := r.Group("/dashboard", rbac.AuthMiddleware(db))
	g.GET("/summary", h.Summary)
	g.GET("/health", h.Health)
	g.GET("/my-weekly", h.MyWeekly)
}
