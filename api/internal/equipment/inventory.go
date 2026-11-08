package equipment

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"

	"digitalprojectmanagement/api/internal/model"
	"digitalprojectmanagement/api/pkg/timeutil"
	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

func (h *Handler) listOutbounds(c *gin.Context) {
	page, size, ok := parsePage(c, 20, 100)
	if !ok {
		return
	}
	query := h.DB.Model(&model.EquipmentEvent{}).
		Joins("JOIN equipment_assets ON equipment_assets.id = equipment_events.asset_id").
		Where("equipment_events.action = ?", "outbound")
	if rawAssetID := strings.TrimSpace(c.Query("asset_id")); rawAssetID != "" {
		assetID, err := strconv.ParseUint(rawAssetID, 10, 64)
		if err != nil || assetID == 0 {
			badRequest(c, "asset_id 须为正整数")
			return
		}
		query = query.Where("equipment_events.asset_id = ?", assetID)
	}
	var total int64
	if err := query.Count(&total).Error; err != nil {
		internalError(c, "库存出库流水查询失败")
		return
	}
	type outboundRow struct {
		model.EquipmentEvent
		AssetName         string `gorm:"column:asset_name"`
		AssetCode         string `gorm:"column:asset_code"`
		AvailableQuantity int    `gorm:"column:available_quantity"`
	}
	var rows []outboundRow
	err := query.Select("equipment_events.*, equipment_assets.name AS asset_name, " +
		"equipment_assets.code AS asset_code, equipment_assets.available_quantity AS available_quantity").
		Order("equipment_events.shipped_at DESC").Order("equipment_events.id DESC").
		Offset((page - 1) * size).Limit(size).Scan(&rows).Error
	if err != nil {
		internalError(c, "库存出库流水查询失败")
		return
	}
	items := make([]gin.H, 0, len(rows))
	for _, row := range rows {
		item := eventResponse(row.EquipmentEvent)
		item["asset_name"] = row.AssetName
		item["asset_code"] = row.AssetCode
		item["available_quantity"] = row.AvailableQuantity
		items = append(items, item)
	}
	c.JSON(http.StatusOK, gin.H{"total": total, "page": page, "size": size, "items": items})
}

type outboundInput struct {
	Quantity    int                `json:"quantity"`
	Customer    string             `json:"customer"`
	Destination string             `json:"destination"`
	ShippedAt   *timeutil.DateTime `json:"shipped_at"`
	Note        string             `json:"note"`
}

func (h *Handler) outbound(c *gin.Context) {
	user := currentUser(c)
	if user == nil {
		return
	}
	assetID, ok := parsePathID(c, "asset_id")
	if !ok {
		return
	}
	var body outboundInput
	if !bindJSON(c, &body) {
		return
	}
	body.Customer = strings.TrimSpace(body.Customer)
	body.Destination = strings.TrimSpace(body.Destination)
	body.Note = strings.TrimSpace(body.Note)
	if body.Quantity <= 0 {
		badRequest(c, "出库数量必须大于 0")
		return
	}
	if len([]rune(body.Customer)) > 255 || len([]rune(body.Destination)) > 255 {
		badRequest(c, "客户或去向不能超过 255 个字符")
		return
	}
	if body.Customer == "" && body.Destination == "" {
		badRequest(c, "请填写发货客户或去向")
		return
	}
	if body.ShippedAt == nil || body.ShippedAt.IsZero() {
		badRequest(c, "发货时间必填")
		return
	}

	var event model.EquipmentEvent
	var availableQuantity int
	err := h.DB.Transaction(func(tx *gorm.DB) error {
		asset, err := getAsset(tx, assetID, true)
		if err != nil {
			return err
		}
		if !asset.InventoryManaged {
			return invalidEquipment("仅库存型物料支持出库")
		}
		if asset.Status != statusAvailable {
			return invalidEquipment("该库存记录当前不可出库")
		}
		if body.Quantity > asset.AvailableQuantity {
			return invalidEquipment("可用库存不足，当前仅剩 " + strconv.Itoa(asset.AvailableQuantity))
		}
		asset.AvailableQuantity -= body.Quantity
		asset.UpdatedAt = timeutil.NowDateTime()
		if err := tx.Model(&asset).Updates(map[string]any{
			"available_quantity": asset.AvailableQuantity,
			"updated_at":         asset.UpdatedAt,
		}).Error; err != nil {
			return err
		}
		shippedAt := timeutil.NewDateTime(body.ShippedAt.Time)
		quantity := body.Quantity
		event = model.EquipmentEvent{
			AssetID: asset.ID, BatchID: asset.BatchID, Action: "outbound",
			FromStatus: &asset.Status, ToStatus: asset.Status, ActorID: user.ID,
			Quantity: &quantity, Customer: optionalString(body.Customer),
			Destination: optionalString(body.Destination), ShippedAt: &shippedAt,
			Note: body.Note, CreatedAt: timeutil.NowDateTime(),
		}
		if err := tx.Create(&event).Error; err != nil {
			return err
		}
		availableQuantity = asset.AvailableQuantity
		detail, err := json.Marshal(map[string]any{
			"quantity": body.Quantity, "customer": body.Customer,
			"destination": body.Destination, "shipped_at": shippedAt,
		})
		if err != nil {
			return err
		}
		return auditCommit(tx, c, user.ID, "outbound_equipment_inventory", "equipment_assets",
			strconv.FormatUint(uint64(asset.ID), 10), string(detail))
	})
	if err != nil {
		writeEquipmentError(c, err, "库存出库失败")
		return
	}
	result := eventResponse(event)
	result["available_quantity"] = availableQuantity
	c.JSON(http.StatusOK, result)
}
