package expense

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
	g := r.Group("/expenses", rbac.AuthMiddleware(db))
	g.GET("", h.List)
	g.POST("", h.Create)
	g.GET("/:eid/timeline", h.Timeline)
	g.POST("/:eid/resubmit", h.Resubmit)
	g.POST("/:eid/vouchers", h.UploadVoucher)
	g.GET("/:eid/vouchers", h.ListVouchers)
	g.GET("/:eid/vouchers/:aid/download", h.DownloadVoucher)
	g.DELETE("/:eid/vouchers/:aid", h.DeleteVoucher)
	g.POST("/:eid/approve", rbac.RequireModule(rbac.ModuleApprovals), h.Approve)
	g.POST("/:eid/reject", rbac.RequireModule(rbac.ModuleApprovals), h.Reject)
	g.POST("/:eid/exception", rbac.RequireModule(rbac.ModuleApprovals), h.Exception)
}
