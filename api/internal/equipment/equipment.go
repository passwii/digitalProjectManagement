package equipment

import (
	"errors"
	"net/http"
	"strconv"
	"strings"

	"digitalprojectmanagement/api/internal/model"
	"digitalprojectmanagement/api/internal/rbac"
	"digitalprojectmanagement/api/pkg/audit"
	"digitalprojectmanagement/api/pkg/paging"
	"digitalprojectmanagement/api/pkg/timeutil"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/shopspring/decimal"
	"gorm.io/gorm"
)

const (
	statusPendingAcceptance = "pending_acceptance"
	statusAvailable         = "available"
	statusClaimed           = "claimed"
	statusBorrowed          = "borrowed"
	statusMaintenance       = "maintenance"
	statusScrapped          = "scrapped"
	statusVoid              = "void"

	batchAccepted          = "accepted"
	batchPendingAcceptance = "pending_acceptance"
)

var (
	errAudit = errors.New("审计写入失败，本次操作已回滚，请重试或联系管理员")
)

type equipmentError struct {
	status int
	detail string
}

func (e *equipmentError) Error() string {
	return e.detail
}

func invalidEquipment(detail string) error {
	return &equipmentError{status: http.StatusBadRequest, detail: detail}
}

func missingEquipment(detail string) error {
	return &equipmentError{status: http.StatusNotFound, detail: detail}
}

func conflictEquipment(detail string) error {
	return &equipmentError{status: http.StatusConflict, detail: detail}
}

func forbiddenEquipment(detail string) error {
	return &equipmentError{status: http.StatusForbidden, detail: detail}
}

func writeEquipmentError(c *gin.Context, err error, fallback string) {
	var apiErr *equipmentError
	if errors.As(err, &apiErr) {
		c.JSON(apiErr.status, gin.H{"detail": apiErr.detail})
		return
	}
	if errors.Is(err, gorm.ErrRecordNotFound) {
		notFound(c, fallback)
		return
	}
	if isUniqueViolation(err) {
		conflict(c, fallback)
		return
	}
	if strings.Contains(err.Error(), errAudit.Error()) {
		internalError(c, errAudit.Error())
		return
	}
	internalError(c, fallback)
}

type Handler struct {
	DB *gorm.DB
}

// RegisterRoutes mounts the complete equipment API behind authentication and
// the assets module gate. Management routes add the super-admin gate locally.
func RegisterRoutes(r *gin.RouterGroup, db *gorm.DB) {
	h := &Handler{DB: db}
	api := r.Group("/equipment-assets", rbac.AuthMiddleware(db), rbac.RequireModule(rbac.ModuleAssets))

	api.GET("", h.listAssets)
	api.GET("/overview", h.overview)
	api.GET("/overdue", h.overdue)
	api.GET("/statistics", h.statistics)

	api.GET("/categories", h.listCategories)
	api.POST("/categories", rbac.RequireAdmin(), h.createCategory)
	api.PATCH("/categories/:code", rbac.RequireAdmin(), h.updateCategory)
	api.DELETE("/categories/:code", rbac.RequireAdmin(), h.deleteCategory)

	api.POST("/inbound", h.inbound)
	api.GET("/batches", h.listBatches)
	api.GET("/batches/:batch_id", h.batchDetail)
	api.PATCH("/batches/:batch_id", rbac.RequireAdmin(), h.renameBatch)
	api.DELETE("/batches/:batch_id", rbac.RequireAdmin(), h.deleteBatch)
	api.POST("/batches/:batch_id/accept", rbac.RequireAdmin(), h.acceptBatch)

	api.POST("", rbac.RequireAdmin(), h.createAsset)
	api.GET("/export", rbac.RequireAdmin(), h.exportAssets)
	api.GET("/import-template", rbac.RequireAdmin(), h.importTemplate)
	api.POST("/import", rbac.RequireAdmin(), h.importAssets)
	api.GET("/outbounds", h.listOutbounds)

	api.GET("/:asset_id/delete-check", rbac.RequireAdmin(), h.deleteCheck)
	api.DELETE("/:asset_id", rbac.RequireAdmin(), h.deleteAsset)
	api.GET("/:asset_id", h.assetDetail)
	api.PATCH("/:asset_id", rbac.RequireAdmin(), h.updateAsset)
	api.GET("/:asset_id/events", h.assetEvents)
	api.POST("/:asset_id/outbound", rbac.RequireAdmin(), h.outbound)
	api.POST("/:asset_id/claim", h.transition("claim"))
	api.POST("/:asset_id/borrow", h.transition("borrow"))
	api.POST("/:asset_id/return", h.transition("return"))
	api.POST("/:asset_id/maintenance", rbac.RequireAdmin(), h.transition("maintenance"))
	api.POST("/:asset_id/restore", rbac.RequireAdmin(), h.transition("restore"))
	api.POST("/:asset_id/scrap", rbac.RequireAdmin(), h.transition("scrap"))
	api.POST("/:asset_id/void", rbac.RequireAdmin(), h.transition("void"))
}

func badRequest(c *gin.Context, detail string) {
	c.JSON(http.StatusBadRequest, gin.H{"detail": detail})
}

func notFound(c *gin.Context, detail string) {
	c.JSON(http.StatusNotFound, gin.H{"detail": detail})
}

func conflict(c *gin.Context, detail string) {
	c.JSON(http.StatusConflict, gin.H{"detail": detail})
}

func forbidden(c *gin.Context, detail string) {
	c.JSON(http.StatusForbidden, gin.H{"detail": detail})
}

func internalError(c *gin.Context, detail string) {
	c.JSON(http.StatusInternalServerError, gin.H{"detail": detail})
}

func bindJSON(c *gin.Context, destination any) bool {
	if err := c.ShouldBindJSON(destination); err != nil {
		badRequest(c, err.Error())
		return false
	}
	return true
}

func currentUser(c *gin.Context) *model.User {
	user := rbac.GetCurrentUser(c)
	if user == nil {
		c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"detail": "未登录"})
	}
	return user
}

func parsePathID(c *gin.Context, key string) (uint, bool) {
	id, err := strconv.ParseUint(c.Param(key), 10, 64)
	if err != nil || id == 0 {
		badRequest(c, "编号格式错误")
		return 0, false
	}
	return uint(id), true
}

func parsePage(c *gin.Context, defaultSize, maximum int) (int, int, bool) {
	page := 1
	size := defaultSize
	var err error
	if raw := c.Query("page"); raw != "" {
		page, err = strconv.Atoi(raw)
		if err != nil {
			badRequest(c, "page 须为正整数")
			return 0, 0, false
		}
	}
	if raw := c.Query("size"); raw != "" {
		size, err = strconv.Atoi(raw)
		if err != nil {
			badRequest(c, "size 须为正整数")
			return 0, 0, false
		}
	}
	if _, err := paging.ValidatePage(page); err != nil {
		badRequest(c, err.Error())
		return 0, 0, false
	}
	if _, err := paging.ValidateSize(size, maximum); err != nil {
		badRequest(c, err.Error())
		return 0, 0, false
	}
	return page, size, true
}

func isAdmin(user *model.User) bool {
	return rbac.IsSuperAdmin(user)
}

func isUniqueViolation(err error) bool {
	if err == nil {
		return false
	}
	text := strings.ToLower(err.Error())
	return strings.Contains(text, "duplicate key") ||
		strings.Contains(text, "unique constraint") ||
		strings.Contains(text, "violates unique")
}

func assetResponse(asset model.EquipmentAsset) gin.H {
	var purchasePrice any
	if asset.PurchasePrice != nil {
		value, _ := asset.PurchasePrice.Float64()
		purchasePrice = value
	}
	return gin.H{
		"id":                 asset.ID,
		"code":               asset.Code,
		"name":               asset.Name,
		"category_code":      asset.CategoryCode,
		"serial_number":      asset.SerialNumber,
		"brand":              asset.Brand,
		"model":              asset.Model,
		"location":           asset.Location,
		"note":               asset.Note,
		"purchase_date":      asset.PurchaseDate,
		"purchase_price":     purchasePrice,
		"status":             asset.Status,
		"holder_id":          asset.HolderID,
		"due_date":           asset.DueDate,
		"batch_id":           asset.BatchID,
		"quantity":           asset.Quantity,
		"available_quantity": asset.AvailableQuantity,
		"inventory_managed":  asset.InventoryManaged,
		"created_by":         asset.CreatedBy,
		"created_at":         asset.CreatedAt,
		"updated_at":         asset.UpdatedAt,
	}
}

func eventResponse(event model.EquipmentEvent) gin.H {
	return gin.H{
		"id":          event.ID,
		"asset_id":    event.AssetID,
		"batch_id":    event.BatchID,
		"action":      event.Action,
		"from_status": event.FromStatus,
		"to_status":   event.ToStatus,
		"actor_id":    event.ActorID,
		"holder_id":   event.HolderID,
		"due_date":    event.DueDate,
		"quantity":    event.Quantity,
		"customer":    event.Customer,
		"destination": event.Destination,
		"shipped_at":  event.ShippedAt,
		"note":        event.Note,
		"created_at":  event.CreatedAt,
	}
}

func batchResponse(batch model.EquipmentBatch, items []model.EquipmentAsset, assetCount int64, includeItems bool) gin.H {
	result := gin.H{
		"id":                batch.ID,
		"name":              batch.Name,
		"source":            batch.Source,
		"supplier":          batch.Supplier,
		"purchase_order_no": batch.PurchaseOrderNo,
		"invoice_no":        batch.InvoiceNo,
		"acceptance_status": batch.AcceptanceStatus,
		"note":              batch.Note,
		"created_by":        batch.CreatedBy,
		"created_at":        batch.CreatedAt,
		"asset_count":       assetCount,
	}
	if includeItems {
		rows := make([]gin.H, 0, len(items))
		for _, item := range items {
			row := assetResponse(item)
			if item.InventoryManaged {
				row["inbound_quantity"] = item.Quantity
			}
			rows = append(rows, row)
		}
		result["items"] = rows
	}
	return result
}

func createAssetCode() string {
	id := strings.ReplaceAll(uuid.NewString(), "-", "")
	return "EQ-" + timeutil.AppNow().Format("2006") + "-" + strings.ToUpper(id[:12])
}

func toDateValue(date *timeutil.Date) *timeutil.Date {
	if date == nil || date.IsZero() {
		return nil
	}
	copy := *date
	return &copy
}

func toDateTimeValue(dateTime *timeutil.DateTime) *timeutil.DateTime {
	if dateTime == nil || dateTime.IsZero() {
		return nil
	}
	copy := *dateTime
	return &copy
}

func isValidPurchasePrice(price *decimal.Decimal) bool {
	return price == nil || !price.IsNegative()
}

func auditCommit(tx *gorm.DB, c *gin.Context, actorID uint, action, resource, resourceID, detail string) error {
	return audit.CommitAudited(tx, &actorID, action, resource, resourceID, detail, c.ClientIP())
}
