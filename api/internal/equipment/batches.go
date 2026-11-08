package equipment

import (
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"digitalprojectmanagement/api/internal/model"
	"digitalprojectmanagement/api/pkg/timeutil"
	"github.com/gin-gonic/gin"
	"github.com/shopspring/decimal"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

type assetInput struct {
	Name             string           `json:"name"`
	CategoryCode     string           `json:"category_code"`
	SerialNumber     string           `json:"serial_number"`
	Brand            string           `json:"brand"`
	Model            string           `json:"model"`
	Location         string           `json:"location"`
	Note             string           `json:"note"`
	PurchaseDate     *timeutil.Date   `json:"purchase_date"`
	PurchasePrice    *decimal.Decimal `json:"purchase_price"`
	Quantity         int              `json:"quantity"`
	InventoryManaged bool             `json:"inventory_managed"`
	BatchID          *uint            `json:"batch_id"`
}

type inboundInput struct {
	Name             string       `json:"name"`
	BatchID          *uint        `json:"batch_id"`
	InventoryManaged bool         `json:"inventory_managed"`
	Source           string       `json:"source"`
	Supplier         string       `json:"supplier"`
	PurchaseOrderNo  string       `json:"purchase_order_no"`
	InvoiceNo        string       `json:"invoice_no"`
	AcceptanceStatus string       `json:"acceptance_status"`
	Note             string       `json:"note"`
	Items            []assetInput `json:"items"`
}

type batchNameInput struct {
	Name string `json:"name"`
}

func normalizeBatchName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return "", invalidEquipment("批次名称必填")
	}
	if len([]rune(name)) > 128 {
		return "", invalidEquipment("批次名称不能超过 128 个字符")
	}
	return name, nil
}

func validateAcceptanceStatus(status string) (string, error) {
	if status == "" {
		status = batchAccepted
	}
	if status != batchAccepted && status != batchPendingAcceptance {
		return "", invalidEquipment("验收状态只能为 pending_acceptance 或 accepted")
	}
	return status, nil
}

func validateAssetInput(db *gorm.DB, input *assetInput, excludeID *uint) (string, error) {
	input.Name = strings.TrimSpace(input.Name)
	input.CategoryCode = strings.TrimSpace(input.CategoryCode)
	input.SerialNumber = strings.TrimSpace(input.SerialNumber)
	input.Brand = strings.TrimSpace(input.Brand)
	input.Model = strings.TrimSpace(input.Model)
	input.Location = strings.TrimSpace(input.Location)
	input.Note = strings.TrimSpace(input.Note)

	if input.Name == "" {
		return "", invalidEquipment("设备名称必填")
	}
	if len([]rune(input.Name)) > 128 || len([]rune(input.CategoryCode)) > 32 ||
		len([]rune(input.SerialNumber)) > 128 || len([]rune(input.Brand)) > 128 ||
		len([]rune(input.Model)) > 128 || len([]rune(input.Location)) > 128 {
		return "", invalidEquipment("设备基础资料超出字段长度限制")
	}
	if input.CategoryCode == "" {
		return "", invalidEquipment("设备分类必填")
	}
	var categoryCount int64
	if err := db.Model(&model.Dict{}).
		Where("type = ? AND code = ?", "equipment_category", input.CategoryCode).
		Count(&categoryCount).Error; err != nil {
		return "", err
	}
	if categoryCount == 0 {
		return "", invalidEquipment(fmt.Sprintf("设备分类「%s」不存在，请使用已有分类", input.CategoryCode))
	}
	if !isValidPurchasePrice(input.PurchasePrice) {
		return "", invalidEquipment("采购金额必须为非负有限数")
	}
	if input.Quantity == 0 {
		input.Quantity = 1
	}
	if !input.InventoryManaged && input.Quantity != 1 {
		return "", invalidEquipment("非库存设备数量必须为 1")
	}
	if input.InventoryManaged && input.SerialNumber != "" {
		return "", invalidEquipment("库存物料不能填写单件序列号")
	}
	if input.Quantity < 1 {
		return "", invalidEquipment("设备数量必须大于 0")
	}
	if input.SerialNumber != "" {
		query := db.Model(&model.EquipmentAsset{}).Where("serial_number = ?", input.SerialNumber)
		if excludeID != nil {
			query = query.Where("id <> ?", *excludeID)
		}
		var count int64
		if err := query.Count(&count).Error; err != nil {
			return "", err
		}
		if count > 0 {
			return "", invalidEquipment("设备序列号已存在")
		}
	}
	return "", nil
}

func checkBatchType(db *gorm.DB, batchID uint, inventoryManaged bool) error {
	var count int64
	if err := db.Model(&model.EquipmentAsset{}).
		Where("batch_id = ? AND inventory_managed <> ?", batchID, inventoryManaged).
		Count(&count).Error; err != nil {
		return err
	}
	if count > 0 {
		return invalidEquipment("不能在同一批次混合单件设备和库存物料")
	}
	return nil
}

func findBatch(db *gorm.DB, batchID uint, lock bool) (model.EquipmentBatch, error) {
	var batch model.EquipmentBatch
	query := db
	if lock {
		query = query.Clauses(clause.Locking{Strength: clause.LockingStrengthUpdate})
	}
	err := query.First(&batch, "id = ?", batchID).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return model.EquipmentBatch{}, missingEquipment("入库批次不存在")
	}
	return batch, err
}

func createBatch(db *gorm.DB, actorID uint, input *inboundInput) (model.EquipmentBatch, error) {
	name, err := normalizeBatchName(input.Name)
	if err != nil {
		return model.EquipmentBatch{}, err
	}
	var count int64
	if err := db.Model(&model.EquipmentBatch{}).
		Where("LOWER(name) = LOWER(?)", name).Count(&count).Error; err != nil {
		return model.EquipmentBatch{}, err
	}
	if count > 0 {
		return model.EquipmentBatch{}, invalidEquipment("批次名称已存在，请选择已有批次或更换名称")
	}
	if len([]rune(input.Source)) > 255 || len([]rune(input.Supplier)) > 255 ||
		len([]rune(input.PurchaseOrderNo)) > 128 || len([]rune(input.InvoiceNo)) > 128 {
		return model.EquipmentBatch{}, invalidEquipment("批次采购信息超出字段长度限制")
	}
	status, err := validateAcceptanceStatus(input.AcceptanceStatus)
	if err != nil {
		return model.EquipmentBatch{}, err
	}
	batch := model.EquipmentBatch{
		Name:             name,
		Source:           strings.TrimSpace(input.Source),
		Supplier:         strings.TrimSpace(input.Supplier),
		PurchaseOrderNo:  strings.TrimSpace(input.PurchaseOrderNo),
		InvoiceNo:        strings.TrimSpace(input.InvoiceNo),
		AcceptanceStatus: status,
		Note:             strings.TrimSpace(input.Note),
		CreatedBy:        actorID,
		CreatedAt:        timeutil.NowDateTime(),
	}
	if err := db.Create(&batch).Error; err != nil {
		return model.EquipmentBatch{}, err
	}
	return batch, nil
}

func createAssetRecord(tx *gorm.DB, input assetInput, actorID uint, batchID *uint, status, action string) (model.EquipmentAsset, error) {
	quantity := input.Quantity
	if quantity == 0 {
		quantity = 1
	}
	now := timeutil.NowDateTime()
	asset := model.EquipmentAsset{
		Code:              createAssetCode(),
		Name:              input.Name,
		CategoryCode:      input.CategoryCode,
		SerialNumber:      optionalString(input.SerialNumber),
		Brand:             input.Brand,
		Model:             input.Model,
		Location:          input.Location,
		Note:              input.Note,
		PurchaseDate:      toDateValue(input.PurchaseDate),
		PurchasePrice:     input.PurchasePrice,
		Status:            status,
		BatchID:           batchID,
		Quantity:          quantity,
		AvailableQuantity: quantity,
		InventoryManaged:  input.InventoryManaged,
		CreatedBy:         actorID,
		CreatedAt:         now,
		UpdatedAt:         now,
	}
	if err := tx.Create(&asset).Error; err != nil {
		return model.EquipmentAsset{}, err
	}
	eventAction := action
	if input.InventoryManaged && action == "create" {
		eventAction = "inbound"
	}
	var eventQuantity *int
	if input.InventoryManaged {
		eventQuantity = &quantity
	}
	event := model.EquipmentEvent{
		AssetID:   asset.ID,
		BatchID:   batchID,
		Action:    eventAction,
		ToStatus:  status,
		ActorID:   actorID,
		Note:      input.Note,
		Quantity:  eventQuantity,
		CreatedAt: now,
	}
	if err := tx.Create(&event).Error; err != nil {
		return model.EquipmentAsset{}, err
	}
	return asset, nil
}

func optionalString(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

func (h *Handler) inbound(c *gin.Context) {
	user := currentUser(c)
	if user == nil {
		return
	}
	var body inboundInput
	if !bindJSON(c, &body) {
		return
	}
	if len(body.Items) == 0 {
		badRequest(c, "入库设备不能为空")
		return
	}
	body.Name = strings.TrimSpace(body.Name)
	if (body.BatchID != nil && body.Name != "") || (body.BatchID == nil && body.Name == "") {
		badRequest(c, "请选择已有批次，或填写新批次名称")
		return
	}
	acceptanceStatus, err := validateAcceptanceStatus(body.AcceptanceStatus)
	if err != nil {
		badRequest(c, err.Error())
		return
	}
	body.AcceptanceStatus = acceptanceStatus

	serials := make(map[string]struct{})
	for i := range body.Items {
		body.Items[i].InventoryManaged = body.InventoryManaged
		if body.Items[i].Quantity == 0 && !body.InventoryManaged {
			body.Items[i].Quantity = 1
		}
		message, err := validateAssetInput(h.DB, &body.Items[i], nil)
		if err != nil {
			if details, ok := err.(*equipmentError); ok {
				badRequest(c, details.detail)
			} else {
				internalError(c, "入库资料校验失败")
			}
			return
		}
		if message != "" {
			badRequest(c, message)
			return
		}
		if body.Items[i].SerialNumber != "" {
			if _, exists := serials[body.Items[i].SerialNumber]; exists {
				badRequest(c, "入库文件中设备序列号重复")
				return
			}
			serials[body.Items[i].SerialNumber] = struct{}{}
		}
	}

	var batch model.EquipmentBatch
	var added []model.EquipmentAsset
	err = h.DB.Transaction(func(tx *gorm.DB) error {
		var createErr error
		if body.BatchID != nil {
			batch, createErr = findBatch(tx, *body.BatchID, true)
			if createErr != nil {
				return createErr
			}
			if createErr = checkBatchType(tx, batch.ID, body.InventoryManaged); createErr != nil {
				return createErr
			}
		} else {
			batch, createErr = createBatch(tx, user.ID, &body)
			if createErr != nil {
				return createErr
			}
		}
		if body.InventoryManaged && batch.AcceptanceStatus == batchPendingAcceptance {
			return invalidEquipment("库存物料入库不支持待验收状态")
		}
		status := statusAvailable
		if batch.AcceptanceStatus == batchPendingAcceptance {
			status = statusPendingAcceptance
		}
		added = make([]model.EquipmentAsset, 0, len(body.Items))
		for _, item := range body.Items {
			asset, err := createAssetRecord(tx, item, user.ID, &batch.ID, status, "inbound")
			if err != nil {
				return err
			}
			added = append(added, asset)
		}
		action := "inbound_equipment"
		if body.BatchID != nil {
			action = "add_equipment_to_batch"
		}
		if err := auditCommit(tx, c, user.ID, action, "equipment_batches", strconv.FormatUint(uint64(batch.ID), 10), fmt.Sprintf("count=%d", len(added))); err != nil {
			return err
		}
		return nil
	})
	if err != nil {
		writeEquipmentError(c, err, "设备入库失败")
		return
	}
	var assetCount int64
	if err := h.DB.Model(&model.EquipmentAsset{}).Where("batch_id = ?", batch.ID).Count(&assetCount).Error; err != nil {
		internalError(c, "批次入库完成，但批次详情查询失败")
		return
	}
	c.JSON(http.StatusOK, batchResponse(batch, added, assetCount, true))
}

type batchCountRow struct {
	model.EquipmentBatch
	AssetCount int64 `gorm:"column:asset_count"`
}

func (h *Handler) listBatches(c *gin.Context) {
	page, size, ok := parsePage(c, 20, 100)
	if !ok {
		return
	}
	query := h.DB.Model(&model.EquipmentBatch{})
	if keyword := strings.TrimSpace(c.Query("keyword")); keyword != "" {
		pattern := "%" + keyword + "%"
		conditions := "name ILIKE ? OR source ILIKE ?"
		args := []any{pattern, pattern}
		idText := strings.TrimPrefix(keyword, "#")
		if id, err := strconv.ParseUint(idText, 10, 64); err == nil {
			conditions += " OR id = ?"
			args = append(args, id)
		}
		query = query.Where(conditions, args...)
	}
	var total int64
	if err := query.Count(&total).Error; err != nil {
		internalError(c, "设备批次查询失败")
		return
	}
	var rows []batchCountRow
	err := query.Select("equipment_batches.*, COUNT(equipment_assets.id) AS asset_count").
		Joins("LEFT JOIN equipment_assets ON equipment_assets.batch_id = equipment_batches.id").
		Group("equipment_batches.id").
		Order("equipment_batches.id DESC").
		Offset((page - 1) * size).Limit(size).Scan(&rows).Error
	if err != nil {
		internalError(c, "设备批次查询失败")
		return
	}
	items := make([]gin.H, 0, len(rows))
	for _, row := range rows {
		items = append(items, batchResponse(row.EquipmentBatch, nil, row.AssetCount, false))
	}
	c.JSON(http.StatusOK, gin.H{"total": total, "page": page, "size": size, "items": items})
}

func (h *Handler) batchDetail(c *gin.Context) {
	batchID, ok := parsePathID(c, "batch_id")
	if !ok {
		return
	}
	batch, err := findBatch(h.DB, batchID, false)
	if err != nil {
		writeEquipmentError(c, err, "入库批次不存在")
		return
	}
	var assets []model.EquipmentAsset
	if err := h.DB.Where("batch_id = ?", batchID).Order("id ASC").Find(&assets).Error; err != nil {
		internalError(c, "批次设备查询失败")
		return
	}
	c.JSON(http.StatusOK, batchResponse(batch, assets, int64(len(assets)), true))
}

func (h *Handler) renameBatch(c *gin.Context) {
	user := currentUser(c)
	if user == nil {
		return
	}
	batchID, ok := parsePathID(c, "batch_id")
	if !ok {
		return
	}
	var body batchNameInput
	if !bindJSON(c, &body) {
		return
	}
	name, err := normalizeBatchName(body.Name)
	if err != nil {
		badRequest(c, err.Error())
		return
	}
	var batch model.EquipmentBatch
	var assetCount int64
	err = h.DB.Transaction(func(tx *gorm.DB) error {
		var err error
		batch, err = findBatch(tx, batchID, true)
		if err != nil {
			return err
		}
		var count int64
		if err := tx.Model(&model.EquipmentBatch{}).
			Where("LOWER(name) = LOWER(?) AND id <> ?", name, batchID).Count(&count).Error; err != nil {
			return err
		}
		if count > 0 {
			return invalidEquipment("批次名称已存在，请选择已有批次或更换名称")
		}
		if err := tx.Model(&batch).Update("name", name).Error; err != nil {
			return err
		}
		batch.Name = name
		if err := tx.Model(&model.EquipmentAsset{}).Where("batch_id = ?", batchID).Count(&assetCount).Error; err != nil {
			return err
		}
		return auditCommit(tx, c, user.ID, "rename_equipment_batch", "equipment_batches", strconv.FormatUint(uint64(batch.ID), 10), name)
	})
	if err != nil {
		writeEquipmentError(c, err, "设备批次重命名失败")
		return
	}
	c.JSON(http.StatusOK, batchResponse(batch, nil, assetCount, false))
}

func (h *Handler) deleteBatch(c *gin.Context) {
	user := currentUser(c)
	if user == nil {
		return
	}
	batchID, ok := parsePathID(c, "batch_id")
	if !ok {
		return
	}
	err := h.DB.Transaction(func(tx *gorm.DB) error {
		batch, err := findBatch(tx, batchID, true)
		if err != nil {
			return err
		}
		var assetCount, eventCount int64
		if err := tx.Model(&model.EquipmentAsset{}).Where("batch_id = ?", batchID).Count(&assetCount).Error; err != nil {
			return err
		}
		if err := tx.Model(&model.EquipmentEvent{}).Where("batch_id = ?", batchID).Count(&eventCount).Error; err != nil {
			return err
		}
		if assetCount > 0 || eventCount > 0 {
			return conflictEquipment("批次仍有关联设备或流水，不能删除")
		}
		if err := tx.Delete(&batch).Error; err != nil {
			return err
		}
		return auditCommit(tx, c, user.ID, "delete_equipment_batch", "equipment_batches", strconv.FormatUint(uint64(batchID), 10), batch.Name)
	})
	if err != nil {
		writeEquipmentError(c, err, "设备批次删除失败")
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "id": batchID})
}

type transitionInput struct {
	DueDate *timeutil.Date `json:"due_date"`
	Note    string         `json:"note"`
}

func (h *Handler) acceptBatch(c *gin.Context) {
	user := currentUser(c)
	if user == nil {
		return
	}
	batchID, ok := parsePathID(c, "batch_id")
	if !ok {
		return
	}
	var body transitionInput
	if c.Request.ContentLength != 0 && !bindJSON(c, &body) {
		return
	}
	var batch model.EquipmentBatch
	var assets []model.EquipmentAsset
	err := h.DB.Transaction(func(tx *gorm.DB) error {
		var err error
		batch, err = findBatch(tx, batchID, true)
		if err != nil {
			return err
		}
		if batch.AcceptanceStatus != batchPendingAcceptance {
			return invalidEquipment("入库批次无需验收")
		}
		if err := tx.Clauses(clause.Locking{Strength: clause.LockingStrengthUpdate}).
			Where("batch_id = ? AND status = ?", batchID, statusPendingAcceptance).
			Order("id ASC").Find(&assets).Error; err != nil {
			return err
		}
		batch.AcceptanceStatus = batchAccepted
		if err := tx.Model(&batch).Update("acceptance_status", batchAccepted).Error; err != nil {
			return err
		}
		note := strings.TrimSpace(body.Note)
		for i := range assets {
			from := assets[i].Status
			assets[i].Status = statusAvailable
			assets[i].UpdatedAt = timeutil.NowDateTime()
			if err := tx.Model(&assets[i]).Updates(map[string]any{
				"status": statusAvailable, "updated_at": assets[i].UpdatedAt,
			}).Error; err != nil {
				return err
			}
			event := model.EquipmentEvent{
				AssetID: assets[i].ID, BatchID: assets[i].BatchID, Action: "acceptance",
				FromStatus: &from, ToStatus: statusAvailable, ActorID: user.ID,
				Note: note, CreatedAt: timeutil.NowDateTime(),
			}
			if err := tx.Create(&event).Error; err != nil {
				return err
			}
		}
		return auditCommit(tx, c, user.ID, "accept_equipment_batch", "equipment_batches",
			strconv.FormatUint(uint64(batchID), 10), fmt.Sprintf("count=%d;note=%s", len(assets), note))
	})
	if err != nil {
		writeEquipmentError(c, err, "设备批次验收失败")
		return
	}
	c.JSON(http.StatusOK, batchResponse(batch, assets, int64(len(assets)), true))
}
