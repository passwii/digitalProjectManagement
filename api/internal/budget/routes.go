package budget

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
	g.GET("/budgets", h.List)
	g.POST("/budgets", h.Create)
	g.PATCH("/budgets/:bid", h.SubmitAdjustment)
	g.GET("/budget-adjusts", h.ListAdjustments)
	g.GET("/budget-adjusts/:aid/timeline", h.AdjustmentTimeline)
	g.POST("/budget-adjusts/:aid/approve", rbac.RequireModule(rbac.ModuleApprovals), h.DecideAdjustment)
}
