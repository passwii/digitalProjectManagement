package equipment

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"digitalprojectmanagement/api/internal/model"
	"digitalprojectmanagement/api/pkg/timeutil"
	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

type assetCreateInput struct {
	assetInput
	BatchID *uint `json:"batch_id"`
}

func getAsset(db *gorm.DB, assetID uint, lock bool) (model.EquipmentAsset, error) {
	var asset model.EquipmentAsset
	query := db
	if lock {
		query = query.Clauses(clause.Locking{Strength: clause.LockingStrengthUpdate})
	}
	err := query.First(&asset, "id = ?", assetID).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return model.EquipmentAsset{}, missingEquipment("设备不存在")
	}
	return asset, err
}

func (h *Handler) createAsset(c *gin.Context) {
	user := currentUser(c)
	if user == nil {
		return
	}
	var body assetCreateInput
	if !bindJSON(c, &body) {
		return
	}
	input := body.assetInput
	if input.InventoryManaged {
		badRequest(c, "库存物料请使用入库登记接口")
		return
	}
	if input.Quantity == 0 {
		input.Quantity = 1
	}
	message, err := validateAssetInput(h.DB, &input, nil)
	if err != nil {
		writeEquipmentError(c, err, "设备资料校验失败")
		return
	}
	if message != "" {
		badRequest(c, message)
		return
	}

	var asset model.EquipmentAsset
	err = h.DB.Transaction(func(tx *gorm.DB) error {
		status := statusAvailable
		if body.BatchID != nil {
			batch, err := findBatch(tx, *body.BatchID, true)
			if err != nil {
				return err
			}
			if err := checkBatchType(tx, batch.ID, false); err != nil {
				return err
			}
			if batch.AcceptanceStatus == batchPendingAcceptance {
				status = statusPendingAcceptance
			}
		}
		asset, err = createAssetRecord(tx, input, user.ID, body.BatchID, status, "create")
		if err != nil {
			return err
		}
		return auditCommit(tx, c, user.ID, "create_equipment", "equipment_assets",
			strconv.FormatUint(uint64(asset.ID), 10), asset.Code)
	})
	if err != nil {
		writeEquipmentError(c, err, "设备创建失败")
		return
	}
	c.JSON(http.StatusOK, assetResponse(asset))
}

func (h *Handler) assetDetail(c *gin.Context) {
	assetID, ok := parsePathID(c, "asset_id")
	if !ok {
		return
	}
	asset, err := getAsset(h.DB, assetID, false)
	if err != nil {
		writeEquipmentError(c, err, "设备不存在")
		return
	}
	c.JSON(http.StatusOK, assetResponse(asset))
}

func (h *Handler) updateAsset(c *gin.Context) {
	user := currentUser(c)
	if user == nil {
		return
	}
	assetID, ok := parsePathID(c, "asset_id")
	if !ok {
		return
	}
	var input assetInput
	if !bindJSON(c, &input) {
		return
	}
	var asset model.EquipmentAsset
	err := h.DB.Transaction(func(tx *gorm.DB) error {
		var err error
		asset, err = getAsset(tx, assetID, true)
		if err != nil {
			return err
		}
		if input.InventoryManaged && !asset.InventoryManaged {
			return invalidEquipment("不能通过档案编辑将单件设备改为库存物料")
		}
		if asset.InventoryManaged {
			input.InventoryManaged = true
			input.Quantity = asset.Quantity
		}
		if asset.Status == statusScrapped || asset.Status == statusVoid {
			return invalidEquipment("终止状态设备不能修改")
		}
		message, err := validateAssetInput(tx, &input, &assetID)
		if err != nil {
			return err
		}
		if message != "" {
			return invalidEquipment(message)
		}
		if asset.InventoryManaged && input.SerialNumber != "" {
			return invalidEquipment("库存物料不能填写单件序列号")
		}
		asset.Name = input.Name
		asset.CategoryCode = input.CategoryCode
		asset.SerialNumber = optionalString(input.SerialNumber)
		asset.Brand = input.Brand
		asset.Model = input.Model
		asset.Location = input.Location
		asset.Note = input.Note
		asset.PurchaseDate = toDateValue(input.PurchaseDate)
		asset.PurchasePrice = input.PurchasePrice
		asset.UpdatedAt = timeutil.NowDateTime()
		if err := tx.Model(&asset).Updates(map[string]any{
			"name": asset.Name, "category_code": asset.CategoryCode,
			"serial_number": asset.SerialNumber, "brand": asset.Brand,
			"model": asset.Model, "location": asset.Location, "note": asset.Note,
			"purchase_date": asset.PurchaseDate, "purchase_price": asset.PurchasePrice,
			"updated_at": asset.UpdatedAt,
		}).Error; err != nil {
			return err
		}
		from := asset.Status
		event := model.EquipmentEvent{
			AssetID: asset.ID, BatchID: asset.BatchID, Action: "update",
			FromStatus: &from, ToStatus: asset.Status, ActorID: user.ID,
			HolderID: asset.HolderID, DueDate: asset.DueDate,
			CreatedAt: timeutil.NowDateTime(),
		}
		if err := tx.Create(&event).Error; err != nil {
			return err
		}
		return auditCommit(tx, c, user.ID, "update_equipment", "equipment_assets",
			strconv.FormatUint(uint64(asset.ID), 10), asset.Code)
	})
	if err != nil {
		writeEquipmentError(c, err, "设备资料更新失败")
		return
	}
	c.JSON(http.StatusOK, assetResponse(asset))
}

func (h *Handler) assetEvents(c *gin.Context) {
	assetID, ok := parsePathID(c, "asset_id")
	if !ok {
		return
	}
	page, size, ok := parsePage(c, 100, 100)
	if !ok {
		return
	}
	if _, err := getAsset(h.DB, assetID, false); err != nil {
		writeEquipmentError(c, err, "设备不存在")
		return
	}
	query := h.DB.Model(&model.EquipmentEvent{}).Where("asset_id = ?", assetID)
	var total int64
	if err := query.Count(&total).Error; err != nil {
		internalError(c, "设备流水查询失败")
		return
	}
	var events []model.EquipmentEvent
	if err := query.Order("id ASC").Offset((page - 1) * size).Limit(size).Find(&events).Error; err != nil {
		internalError(c, "设备流水查询失败")
		return
	}
	items := make([]gin.H, 0, len(events))
	for _, event := range events {
		items = append(items, eventResponse(event))
	}
	c.JSON(http.StatusOK, gin.H{"total": total, "page": page, "size": size, "items": items})
}

type deleteCheckResult struct {
	Allowed          bool     `json:"allowed"`
	AssetID          uint     `json:"asset_id"`
	Code             string   `json:"code"`
	Reason           *string  `json:"reason"`
	EventCount       int64    `json:"event_count"`
	ProtectedActions []string `json:"protected_actions"`
}

var protectedDeleteActions = []string{
	"claim", "borrow", "return", "maintenance", "restore", "scrap", "void", "outbound",
}

var protectedDeleteLabels = map[string]string{
	"claim": "领用", "borrow": "借用", "return": "归还", "maintenance": "维修",
	"restore": "恢复", "scrap": "报废", "void": "作废", "outbound": "出库",
}

func checkAssetDelete(db *gorm.DB, asset model.EquipmentAsset) (deleteCheckResult, error) {
	var actions []string
	if err := db.Model(&model.EquipmentEvent{}).Where("asset_id = ?", asset.ID).
		Pluck("action", &actions).Error; err != nil {
		return deleteCheckResult{}, err
	}
	actionSet := make(map[string]struct{}, len(actions))
	for _, action := range actions {
		actionSet[action] = struct{}{}
	}
	protected := make([]string, 0)
	protectedLabels := make([]string, 0)
	for _, action := range protectedDeleteActions {
		if _, ok := actionSet[action]; ok {
			protected = append(protected, action)
			protectedLabels = append(protectedLabels, protectedDeleteLabels[action])
		}
	}
	var reason *string
	if asset.InventoryManaged {
		text := "库存入库和出库流水需长期保留，不能永久删除该库存记录"
		reason = &text
		return deleteCheckResult{
			Allowed: false, AssetID: asset.ID, Code: asset.Code,
			Reason: reason, EventCount: int64(len(actions)), ProtectedActions: protected,
		}, nil
	}
	statusBlocked := asset.Status != statusPendingAcceptance && asset.Status != statusAvailable
	if len(protectedLabels) > 0 {
		text := "该设备已有" + strings.Join(protectedLabels, "、") + "等业务记录，删除将永久丢失这些历史"
		reason = &text
	} else if statusBlocked {
		text := "设备当前状态为" + statusLabel(asset.Status) + "，删除将永久丢失其流转历史"
		reason = &text
	}
	return deleteCheckResult{
		Allowed: len(protected) == 0 && !statusBlocked,
		AssetID: asset.ID, Code: asset.Code, Reason: reason,
		EventCount: int64(len(actions)), ProtectedActions: protected,
	}, nil
}

func statusLabel(status string) string {
	labels := map[string]string{
		statusPendingAcceptance: "待验收", statusAvailable: "可用",
		statusClaimed: "已领用", statusBorrowed: "借用中",
		statusMaintenance: "维修中", statusScrapped: "已报废", statusVoid: "已作废",
	}
	if label := labels[status]; label != "" {
		return label
	}
	return status
}

func (h *Handler) deleteCheck(c *gin.Context) {
	assetID, ok := parsePathID(c, "asset_id")
	if !ok {
		return
	}
	asset, err := getAsset(h.DB, assetID, false)
	if err != nil {
		writeEquipmentError(c, err, "设备不存在")
		return
	}
	check, err := checkAssetDelete(h.DB, asset)
	if err != nil {
		internalError(c, "设备删除预检失败")
		return
	}
	c.JSON(http.StatusOK, check)
}

type assetDeleteInput struct {
	ConfirmCode string `json:"confirm_code"`
	Reason      string `json:"reason"`
}

func (h *Handler) deleteAsset(c *gin.Context) {
	user := currentUser(c)
	if user == nil {
		return
	}
	assetID, ok := parsePathID(c, "asset_id")
	if !ok {
		return
	}
	var body assetDeleteInput
	if !bindJSON(c, &body) {
		return
	}
	body.ConfirmCode = strings.TrimSpace(body.ConfirmCode)
	body.Reason = strings.TrimSpace(body.Reason)
	if body.Reason == "" {
		badRequest(c, "删除原因必填")
		return
	}
	if len([]rune(body.Reason)) > 500 {
		badRequest(c, "删除原因不能超过 500 个字符")
		return
	}
	var deletedCode string
	err := h.DB.Transaction(func(tx *gorm.DB) error {
		asset, err := getAsset(tx, assetID, true)
		if err != nil {
			return err
		}
		if asset.InventoryManaged {
			return conflictEquipment("库存入库和出库流水需长期保留，不能永久删除该库存记录")
		}
		if body.ConfirmCode != asset.Code {
			return invalidEquipment("设备编号确认不一致")
		}
		check, err := checkAssetDelete(tx, asset)
		if err != nil {
			return err
		}
		snapshot, err := json.Marshal(map[string]any{
			"code": asset.Code, "name": asset.Name, "serial_number": asset.SerialNumber,
			"category_code": asset.CategoryCode, "batch_id": asset.BatchID,
			"status": asset.Status, "purchase_price": asset.PurchasePrice,
			"created_by": asset.CreatedBy, "created_at": asset.CreatedAt,
			"event_count": check.EventCount, "protected_actions": check.ProtectedActions,
			"force_delete": !check.Allowed, "reason": body.Reason,
		})
		if err != nil {
			return err
		}
		if err := tx.Exec("SET LOCAL app.allow_event_purge = 'on'").Error; err != nil {
			return err
		}
		if err := tx.Where("asset_id = ?", asset.ID).Delete(&model.EquipmentEvent{}).Error; err != nil {
			return err
		}
		if err := tx.Delete(&asset).Error; err != nil {
			return err
		}
		deletedCode = asset.Code
		return auditCommit(tx, c, user.ID, "delete_equipment", "equipment_assets",
			strconv.FormatUint(uint64(assetID), 10), fmt.Sprintf("%s", snapshot))
	})
	if err != nil {
		writeEquipmentError(c, err, "设备删除失败")
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "id": assetID, "code": deletedCode})
}
