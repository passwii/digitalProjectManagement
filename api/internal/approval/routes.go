package approval

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
	g := r.Group("/approvals", rbac.AuthMiddleware(db), rbac.RequireModule(rbac.ModuleApprovals))
	g.GET("/pending", h.Pending)
	g.GET("/:kind/:aid/timeline", h.Timeline)
	g.POST("/:kind/:aid/decide", h.Decide)
	g.POST("/expense/:eid/exception", h.ExpenseException)
}
