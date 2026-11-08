package partner

import (
	"errors"
	"math"
	"net/http"
	"strconv"
	"strings"
	"unicode/utf8"

	"digitalprojectmanagement/api/internal/model"
	"digitalprojectmanagement/api/internal/rbac"
	"digitalprojectmanagement/api/pkg/audit"
	"digitalprojectmanagement/api/pkg/timeutil"
	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

type contractInput struct {
	ProjectName field[string]         `json:"project_name"`
	Amount      field[*float64]       `json:"amount"`
	SignedDate  field[*timeutil.Date] `json:"signed_date"`
	Remark      field[string]         `json:"remark"`
}

func (h *Handler) listContracts(c *gin.Context) {
	partnerID, ok := parseID(c, "pid")
	if !ok {
		return
	}
	if err := partnerExists(h.DB, partnerID); err != nil {
		writePartnerError(c, err, "友商不存在")
		return
	}
	var rows []model.PartnerContract
	if err := h.DB.Where("partner_id = ?", partnerID).Order("id ASC").Find(&rows).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"detail": "查询业绩合同失败"})
		return
	}
	items := make([]contractResponse, 0, len(rows))
	for _, row := range rows {
		items = append(items, serializeContract(row))
	}
	c.JSON(http.StatusOK, items)
}

func (h *Handler) createContract(c *gin.Context) {
	user := rbac.GetCurrentUser(c)
	if user == nil {
		c.JSON(http.StatusUnauthorized, gin.H{"detail": "未登录"})
		return
	}
	partnerID, ok := parseID(c, "pid")
	if !ok {
		return
	}
	var input contractInput
	if err := c.ShouldBindJSON(&input); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "请求格式错误"})
		return
	}

	var contract model.PartnerContract
	err := h.DB.Transaction(func(tx *gorm.DB) error {
		if err := partnerExists(tx, partnerID); err != nil {
			return err
		}
		contract = model.PartnerContract{PartnerID: partnerID}
		if err := applyContractInput(&contract, input, true); err != nil {
			return err
		}
		contract.CreatedAt = timeutil.NowDateTime()
		if err := tx.Create(&contract).Error; err != nil {
			return err
		}
		return audit.CommitAudited(
			tx,
			&user.ID,
			"create_partner_contract",
			"partner_contracts",
			strconv.FormatUint(uint64(contract.ID), 10),
			contract.ProjectName,
			c.ClientIP(),
		)
	})
	if err != nil {
		writeContractError(c, err, "创建业绩合同失败")
		return
	}
	c.JSON(http.StatusOK, serializeContract(contract))
}

func (h *Handler) updateContract(c *gin.Context) {
	user := rbac.GetCurrentUser(c)
	if user == nil {
		c.JSON(http.StatusUnauthorized, gin.H{"detail": "未登录"})
		return
	}
	partnerID, ok := parseID(c, "pid")
	if !ok {
		return
	}
	contractID, ok := parseID(c, "cid")
	if !ok {
		return
	}
	var input contractInput
	if err := c.ShouldBindJSON(&input); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "请求格式错误"})
		return
	}

	var contract model.PartnerContract
	err := h.DB.Transaction(func(tx *gorm.DB) error {
		if err := partnerExists(tx, partnerID); err != nil {
			return err
		}
		if err := tx.Where("id = ? AND partner_id = ?", contractID, partnerID).First(&contract).Error; err != nil {
			return err
		}
		if err := applyContractInput(&contract, input, false); err != nil {
			return err
		}
		if err := tx.Save(&contract).Error; err != nil {
			return err
		}
		return audit.CommitAudited(
			tx,
			&user.ID,
			"update_partner_contract",
			"partner_contracts",
			strconv.FormatUint(uint64(contract.ID), 10),
			contract.ProjectName,
			c.ClientIP(),
		)
	})
	if err != nil {
		writeContractError(c, err, "更新业绩合同失败")
		return
	}
	c.JSON(http.StatusOK, serializeContract(contract))
}

func (h *Handler) deleteContract(c *gin.Context) {
	user := rbac.GetCurrentUser(c)
	if user == nil {
		c.JSON(http.StatusUnauthorized, gin.H{"detail": "未登录"})
		return
	}
	partnerID, ok := parseID(c, "pid")
	if !ok {
		return
	}
	contractID, ok := parseID(c, "cid")
	if !ok {
		return
	}
	err := h.DB.Transaction(func(tx *gorm.DB) error {
		if err := partnerExists(tx, partnerID); err != nil {
			return err
		}
		var contract model.PartnerContract
		if err := tx.Where("id = ? AND partner_id = ?", contractID, partnerID).First(&contract).Error; err != nil {
			return err
		}
		if err := tx.Delete(&contract).Error; err != nil {
			return err
		}
		return audit.CommitAudited(
			tx,
			&user.ID,
			"delete_partner_contract",
			"partner_contracts",
			strconv.FormatUint(uint64(contract.ID), 10),
			contract.ProjectName,
			c.ClientIP(),
		)
	})
	if err != nil {
		writeContractError(c, err, "删除业绩合同失败")
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func applyContractInput(contract *model.PartnerContract, input contractInput, creating bool) error {
	if input.ProjectName.Set || creating {
		name := strings.TrimSpace(input.ProjectName.Value)
		if name == "" {
			return partnerInputError("项目名称不能为空")
		}
		if utf8.RuneCountInString(name) > 128 {
			return partnerInputError("项目名称最多 128 个字符")
		}
		contract.ProjectName = name
	}
	if input.Amount.Set {
		if input.Amount.Value == nil || !validPartnerAmount(*input.Amount.Value) {
			return partnerInputError("合同金额须为大于等于 0 的有效数字")
		}
		contract.Amount = *input.Amount.Value
	}
	if input.SignedDate.Set {
		contract.SignedDate = input.SignedDate.Value
	}
	if input.Remark.Set {
		remark := strings.TrimSpace(input.Remark.Value)
		if utf8.RuneCountInString(remark) > 1000 {
			return partnerInputError("remark 最多 1000 个字符")
		}
		contract.Remark = remark
	}
	return nil
}

func validPartnerAmount(amount float64) bool {
	return !math.IsNaN(amount) && !math.IsInf(amount, 0) && amount >= 0
}

func partnerExists(db *gorm.DB, id uint) error {
	var count int64
	if err := db.Model(&model.Partner{}).Where("id = ?", id).Count(&count).Error; err != nil {
		return err
	}
	if count == 0 {
		return gorm.ErrRecordNotFound
	}
	return nil
}

func writeContractError(c *gin.Context, err error, fallback string) {
	if errors.Is(err, gorm.ErrRecordNotFound) {
		c.JSON(http.StatusNotFound, gin.H{"detail": "友商或业绩合同不存在"})
		return
	}
	var inputErr partnerInputError
	if errors.As(err, &inputErr) {
		c.JSON(http.StatusBadRequest, gin.H{"detail": inputErr.Error()})
		return
	}
	if isPartnerUniqueViolation(err) {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "业绩合同信息重复"})
		return
	}
	c.JSON(http.StatusInternalServerError, gin.H{"detail": fallback})
}
