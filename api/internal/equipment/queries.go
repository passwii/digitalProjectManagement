package equipment

import (
	"errors"
	"net/http"
	"strconv"
	"strings"

	"digitalprojectmanagement/api/internal/model"
	"digitalprojectmanagement/api/pkg/timeutil"
	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

func (h *Handler) listAssets(c *gin.Context) {
	page, size, ok := parsePage(c, 20, 100)
	if !ok {
		return
	}

	query := h.DB.Model(&model.EquipmentAsset{})
	if keyword := strings.TrimSpace(c.Query("keyword")); keyword != "" {
		pattern := "%" + keyword + "%"
		query = query.Where("(name ILIKE ? OR code ILIKE ? OR serial_number ILIKE ?)", pattern, pattern, pattern)
	}
	if category := strings.TrimSpace(c.Query("category_code")); category != "" {
		query = query.Where("category_code = ?", category)
	}
	if status := strings.TrimSpace(c.Query("status")); status != "" {
		query = query.Where("status = ?", status)
	}
	if holderID := strings.TrimSpace(c.Query("holder_id")); holderID != "" {
		id, err := strconv.ParseUint(holderID, 10, 64)
		if err != nil {
			badRequest(c, "holder_id 须为正整数")
			return
		}
		query = query.Where("holder_id = ?", id)
	}

	var total int64
	if err := query.Count(&total).Error; err != nil {
		internalError(c, "设备列表查询失败")
		return
	}
	var assets []model.EquipmentAsset
	if err := query.Order("id DESC").Offset((page - 1) * size).Limit(size).Find(&assets).Error; err != nil {
		internalError(c, "设备列表查询失败")
		return
	}
	items := make([]gin.H, 0, len(assets))
	for _, asset := range assets {
		items = append(items, assetResponse(asset))
	}
	c.JSON(http.StatusOK, gin.H{"total": total, "page": page, "size": size, "items": items})
}

func (h *Handler) overview(c *gin.Context) {
	type statusCount struct {
		Status string `gorm:"column:status"`
		Count  int64  `gorm:"column:count"`
	}
	var rows []statusCount
	err := h.DB.Model(&model.EquipmentAsset{}).
		Select("status, SUM(CASE WHEN inventory_managed THEN quantity ELSE 1 END) AS count").
		Group("status").Scan(&rows).Error
	if err != nil {
		internalError(c, "设备概览查询失败")
		return
	}
	byStatus := make(map[string]int64, len(rows))
	var total int64
	for _, row := range rows {
		byStatus[row.Status] = row.Count
		total += row.Count
	}
	var overdue int64
	if err := h.DB.Model(&model.EquipmentAsset{}).
		Where("status = ? AND due_date < ?", statusBorrowed, timeutil.AppToday()).
		Count(&overdue).Error; err != nil {
		internalError(c, "逾期设备查询失败")
		return
	}
	c.JSON(http.StatusOK, gin.H{"total": total, "by_status": byStatus, "overdue": overdue})
}

func (h *Handler) overdue(c *gin.Context) {
	page, size, ok := parsePage(c, 20, 100)
	if !ok {
		return
	}
	query := h.DB.Model(&model.EquipmentAsset{}).
		Where("status = ? AND due_date < ?", statusBorrowed, timeutil.AppToday())
	var total int64
	if err := query.Count(&total).Error; err != nil {
		internalError(c, "逾期设备查询失败")
		return
	}
	var assets []model.EquipmentAsset
	if err := query.Order("id DESC").Offset((page - 1) * size).Limit(size).Find(&assets).Error; err != nil {
		internalError(c, "逾期设备查询失败")
		return
	}
	items := make([]gin.H, 0, len(assets))
	for _, asset := range assets {
		items = append(items, assetResponse(asset))
	}
	c.JSON(http.StatusOK, gin.H{"total": total, "page": page, "size": size, "items": items})
}

type categoryCount struct {
	CategoryCode string `json:"category_code" gorm:"column:category_code"`
	Count        int64  `json:"count" gorm:"column:count"`
}

type equipmentStatusCount struct {
	Status string `json:"status" gorm:"column:status"`
	Count  int64  `json:"count" gorm:"column:count"`
}

type monthlyCount struct {
	Month    string `json:"month" gorm:"column:month"`
	Inbound  int64  `json:"inbound" gorm:"column:inbound"`
	Outbound int64  `json:"outbound" gorm:"column:outbound"`
}

type holderCount struct {
	UserID uint   `json:"user_id" gorm:"column:user_id"`
	Name   string `json:"name" gorm:"column:name"`
	Count  int64  `json:"count" gorm:"column:count"`
}

func (h *Handler) statistics(c *gin.Context) {
	var byCategory []categoryCount
	if err := h.DB.Model(&model.EquipmentAsset{}).
		Select("category_code, SUM(CASE WHEN inventory_managed THEN quantity ELSE 1 END) AS count").
		Group("category_code").Scan(&byCategory).Error; err != nil {
		internalError(c, "设备分类统计查询失败")
		return
	}

	var byStatus []equipmentStatusCount
	if err := h.DB.Model(&model.EquipmentAsset{}).
		Select("status, SUM(CASE WHEN inventory_managed THEN quantity ELSE 1 END) AS count").
		Group("status").Scan(&byStatus).Error; err != nil {
		internalError(c, "设备状态统计查询失败")
		return
	}

	var byMonth []monthlyCount
	monthExpr := "to_char(COALESCE(shipped_at, created_at), 'YYYY-MM')"
	err := h.DB.Model(&model.EquipmentEvent{}).
		Select(monthExpr + " AS month, " +
			"SUM(CASE WHEN action IN ('create','inbound','import','return') THEN COALESCE(quantity, 1) ELSE 0 END) AS inbound, " +
			"SUM(CASE WHEN action IN ('claim','borrow','outbound') THEN COALESCE(quantity, 1) ELSE 0 END) AS outbound").
		Group(monthExpr).Order("month ASC").Scan(&byMonth).Error
	if err != nil {
		internalError(c, "设备月度统计查询失败")
		return
	}

	var byHolder []holderCount
	err = h.DB.Model(&model.EquipmentAsset{}).
		Select("users.id AS user_id, users.real_name AS name, COUNT(*) AS count").
		Joins("JOIN users ON users.id = equipment_assets.holder_id").
		Group("users.id, users.real_name").Scan(&byHolder).Error
	if err != nil {
		internalError(c, "设备持有人统计查询失败")
		return
	}
	if byCategory == nil {
		byCategory = []categoryCount{}
	}
	if byStatus == nil {
		byStatus = []equipmentStatusCount{}
	}
	if byMonth == nil {
		byMonth = []monthlyCount{}
	}
	if byHolder == nil {
		byHolder = []holderCount{}
	}
	c.JSON(http.StatusOK, gin.H{
		"by_category": byCategory,
		"by_status":   byStatus,
		"by_month":    byMonth,
		"by_holder":   byHolder,
	})
}

func (h *Handler) listCategories(c *gin.Context) {
	var categories []model.Dict
	if err := h.DB.Where("type = ?", "equipment_category").Order("sort ASC").Order("id ASC").Find(&categories).Error; err != nil {
		internalError(c, "设备分类查询失败")
		return
	}
	items := make([]gin.H, 0, len(categories))
	for _, category := range categories {
		items = append(items, gin.H{"code": category.Code, "label": category.Label, "sort": category.Sort})
	}
	c.JSON(http.StatusOK, items)
}

type categoryCreateInput struct {
	Code  string `json:"code"`
	Label string `json:"label"`
	Sort  int    `json:"sort"`
}

type categoryPatchInput struct {
	Label string `json:"label"`
	Sort  *int   `json:"sort"`
}

func (h *Handler) createCategory(c *gin.Context) {
	user := currentUser(c)
	if user == nil {
		return
	}
	var body categoryCreateInput
	if !bindJSON(c, &body) {
		return
	}
	body.Code = strings.TrimSpace(body.Code)
	body.Label = strings.TrimSpace(body.Label)
	if body.Code == "" || body.Label == "" || len(body.Code) > 32 || len([]rune(body.Label)) > 64 {
		badRequest(c, "分类编码或名称无效，或编码已存在")
		return
	}

	err := h.DB.Transaction(func(tx *gorm.DB) error {
		var count int64
		if err := tx.Model(&model.Dict{}).Where("type = ? AND code = ?", "equipment_category", body.Code).Count(&count).Error; err != nil {
			return err
		}
		if count > 0 {
			return invalidEquipment("分类编码或名称无效，或编码已存在")
		}
		category := model.Dict{Type: "equipment_category", Code: body.Code, Label: body.Label, Sort: body.Sort}
		if err := tx.Create(&category).Error; err != nil {
			return err
		}
		return auditCommit(tx, c, user.ID, "create_equipment_category", "equipment_categories", body.Code, body.Label)
	})
	if err != nil {
		writeEquipmentError(c, err, "设备分类创建失败")
		return
	}
	c.JSON(http.StatusOK, gin.H{"code": body.Code, "label": body.Label, "sort": body.Sort})
}

func (h *Handler) updateCategory(c *gin.Context) {
	user := currentUser(c)
	if user == nil {
		return
	}
	code := c.Param("code")
	var body categoryPatchInput
	if !bindJSON(c, &body) {
		return
	}
	body.Label = strings.TrimSpace(body.Label)
	if body.Label == "" || len([]rune(body.Label)) > 64 {
		badRequest(c, "分类名称必填")
		return
	}
	var result model.Dict
	err := h.DB.Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("type = ? AND code = ?", "equipment_category", code).First(&result).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return missingEquipment("分类不存在")
			}
			return err
		}
		updates := map[string]any{"label": body.Label}
		if body.Sort != nil {
			updates["sort"] = *body.Sort
		}
		if err := tx.Model(&result).Updates(updates).Error; err != nil {
			return err
		}
		result.Label = body.Label
		if body.Sort != nil {
			result.Sort = *body.Sort
		}
		return auditCommit(tx, c, user.ID, "update_equipment_category", "equipment_categories", code, body.Label)
	})
	if err != nil {
		writeEquipmentError(c, err, "设备分类更新失败")
		return
	}
	c.JSON(http.StatusOK, gin.H{"code": result.Code, "label": result.Label, "sort": result.Sort})
}

func (h *Handler) deleteCategory(c *gin.Context) {
	user := currentUser(c)
	if user == nil {
		return
	}
	code := c.Param("code")
	err := h.DB.Transaction(func(tx *gorm.DB) error {
		var category model.Dict
		if err := tx.Where("type = ? AND code = ?", "equipment_category", code).First(&category).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return missingEquipment("分类不存在")
			}
			return err
		}
		var count int64
		if err := tx.Model(&model.EquipmentAsset{}).Where("category_code = ?", code).Count(&count).Error; err != nil {
			return err
		}
		if count > 0 {
			return conflictEquipment("分类已有设备，不能删除")
		}
		if err := tx.Delete(&category).Error; err != nil {
			return err
		}
		return auditCommit(tx, c, user.ID, "delete_equipment_category", "equipment_categories", code, "")
	})
	if err != nil {
		writeEquipmentError(c, err, "设备分类删除失败")
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}
