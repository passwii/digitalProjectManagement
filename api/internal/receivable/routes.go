package receivable

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
	g.GET("/:pid/receivables", h.ListReceivables)
	g.POST("/:pid/receivables", h.CreateReceivable)
	g.PATCH("/:pid/receivables/:rid", h.PatchReceivable)
	g.DELETE("/:pid/receivables/:rid", rbac.RequireAdmin(), h.DeleteReceivable)
	g.GET("/:pid/receivables/:rid/payments", h.ListPayments)
	g.POST("/:pid/receivables/:rid/payments", h.CreatePayment)
	g.PATCH("/:pid/receivables/:rid/payments/:payment_id", h.PatchPayment)
	g.DELETE("/:pid/receivables/:rid/payments/:payment_id", rbac.RequireAdmin(), h.DeletePayment)
}
