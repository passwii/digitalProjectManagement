package equipment

import (
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"digitalprojectmanagement/api/internal/model"
	"digitalprojectmanagement/api/pkg/timeutil"
	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

func (h *Handler) transition(action string) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := currentUser(c)
		if user == nil {
			return
		}
		assetID, ok := parsePathID(c, "asset_id")
		if !ok {
			return
		}
		var body transitionInput
		if c.Request.ContentLength != 0 && !bindJSON(c, &body) {
			return
		}

		var asset model.EquipmentAsset
		err := h.DB.Transaction(func(tx *gorm.DB) error {
			var err error
			asset, err = getAsset(tx, assetID, true)
			if err != nil {
				return err
			}
			if asset.InventoryManaged {
				return invalidEquipment("库存物料请使用出库操作，不支持单件领用、借用或状态流转")
			}
			oldStatus := asset.Status
			nextStatus, allowed := transitionTarget(action, oldStatus)
			if !allowed {
				switch action {
				case "claim", "borrow":
					return invalidEquipment("设备当前不可领用或借用")
				case "return":
					return invalidEquipment("设备当前无需归还")
				default:
					return invalidEquipment("设备当前状态不允许此操作")
				}
			}
			if action == "borrow" && body.DueDate != nil &&
				body.DueDate.Format("2006-01-02") < timeutil.AppToday() {
				return invalidEquipment("归还日期不能早于今天")
			}
			if action == "return" && !isAdmin(user) {
				if oldStatus != statusBorrowed || asset.HolderID == nil || *asset.HolderID != user.ID {
					return forbiddenEquipment("普通用户只能归还本人借用设备")
				}
			}

			fromStatus := oldStatus
			asset.Status = nextStatus
			switch action {
			case "claim":
				asset.HolderID = uintPointer(user.ID)
				asset.DueDate = nil
			case "borrow":
				asset.HolderID = uintPointer(user.ID)
				asset.DueDate = toDateValue(body.DueDate)
			case "return":
				asset.HolderID = nil
				asset.DueDate = nil
			case "void":
				asset.HolderID = nil
				asset.DueDate = nil
			}
			asset.UpdatedAt = timeutil.NowDateTime()
			if err := tx.Model(&asset).Updates(map[string]any{
				"status": asset.Status, "holder_id": asset.HolderID,
				"due_date": asset.DueDate, "updated_at": asset.UpdatedAt,
			}).Error; err != nil {
				return err
			}
			event := model.EquipmentEvent{
				AssetID: asset.ID, BatchID: asset.BatchID, Action: action,
				FromStatus: &fromStatus, ToStatus: asset.Status, ActorID: user.ID,
				HolderID: asset.HolderID, DueDate: asset.DueDate,
				Note: strings.TrimSpace(body.Note), CreatedAt: timeutil.NowDateTime(),
			}
			if err := tx.Create(&event).Error; err != nil {
				return err
			}
			return auditCommit(tx, c, user.ID, action+"_equipment", "equipment_assets",
				strconv.FormatUint(uint64(asset.ID), 10), fmt.Sprintf("%s->%s", fromStatus, asset.Status))
		})
		if err != nil {
			writeEquipmentError(c, err, "设备状态流转失败")
			return
		}
		c.JSON(http.StatusOK, assetResponse(asset))
	}
}

func uintPointer(value uint) *uint {
	return &value
}
