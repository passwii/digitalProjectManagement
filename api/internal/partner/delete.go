package partner

import (
	"errors"
	"net/http"
	"strconv"

	"digitalprojectmanagement/api/internal/model"
	"digitalprojectmanagement/api/internal/rbac"
	"digitalprojectmanagement/api/pkg/attachment"
	"digitalprojectmanagement/api/pkg/audit"
	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

func (h *Handler) deletePartner(c *gin.Context) {
	user := rbac.GetCurrentUser(c)
	if user == nil {
		c.JSON(http.StatusUnauthorized, gin.H{"detail": "未登录"})
		return
	}
	partnerID, ok := parseID(c, "pid")
	if !ok {
		return
	}

	err := h.DB.Transaction(func(tx *gorm.DB) error {
		var partner model.Partner
		if err := tx.Clauses(clause.Locking{Strength: clause.LockingStrengthUpdate}).
			First(&partner, "id = ?", partnerID).Error; err != nil {
			return err
		}
		var files []model.Attachment
		if err := tx.Where(
			"project_id IS NULL AND ref_type = ? AND ref_id = ?",
			"partner",
			partnerID,
		).Find(&files).Error; err != nil {
			return err
		}
		for _, file := range files {
			if err := attachment.DeleteBlob(c.Request.Context(), file); err != nil {
				return err
			}
		}
		if err := tx.Where("partner_id = ?", partnerID).Delete(&model.PartnerContract{}).Error; err != nil {
			return err
		}
		if err := tx.Where(
			"project_id IS NULL AND ref_type = ? AND ref_id = ?",
			"partner",
			partnerID,
		).Delete(&model.Attachment{}).Error; err != nil {
			return err
		}
		if err := tx.Delete(&partner).Error; err != nil {
			return err
		}
		return audit.CommitAudited(
			tx,
			&user.ID,
			"delete_partner",
			"partners",
			strconv.FormatUint(uint64(partnerID), 10),
			partner.Name,
			c.ClientIP(),
		)
	})
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"detail": "友商不存在"})
			return
		}
		var storageErr attachment.StorageError
		if errors.As(err, &storageErr) {
			c.JSON(http.StatusBadGateway, gin.H{"detail": "文件存储不可用，请稍后重试"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"detail": "删除友商失败"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}
