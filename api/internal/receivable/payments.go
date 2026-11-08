package receivable

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"digitalprojectmanagement/api/internal/model"
	projectdomain "digitalprojectmanagement/api/internal/project"
	"digitalprojectmanagement/api/internal/rbac"
	"digitalprojectmanagement/api/pkg/audit"
	"digitalprojectmanagement/api/pkg/paging"
	"digitalprojectmanagement/api/pkg/timeutil"
	"github.com/gin-gonic/gin"
	"github.com/shopspring/decimal"
	"gorm.io/gorm"
)

func (h *Handler) ListPayments(c *gin.Context) {
	projectID, ok := receivablePathID(c, "pid")
	if !ok {
		return
	}
	receivableID, ok := receivablePathID(c, "rid")
	if !ok {
		return
	}
	if _, err := projectdomain.LoadVisibleProject(h.DB, rbac.GetCurrentUser(c), projectID); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"detail": "项目不存在"})
		return
	}
	var receivable model.ProjectReceivable
	if err := h.DB.Where("id = ? AND project_id = ? AND deleted_at IS NULL", receivableID, projectID).First(&receivable).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"detail": "应收记录不存在"})
		return
	}
	page, size, ok := receivablePagination(c)
	if !ok {
		return
	}
	q := h.DB.Model(&model.ProjectReceivablePayment{}).
		Where("project_id = ? AND receivable_id = ? AND deleted_at IS NULL", projectID, receivableID)
	result, err := paging.Paginate[model.ProjectReceivablePayment](q, page, size, c.Query("sort"), paymentSorts, "-payment_date")
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"detail": err.Error()})
		return
	}
	items := make([]gin.H, 0, len(result.Items))
	for _, row := range result.Items {
		items = append(items, paymentRow(row))
	}
	c.JSON(http.StatusOK, gin.H{"total": result.Total, "page": result.Page, "size": result.Size, "items": items})
}

func (h *Handler) CreatePayment(c *gin.Context) {
	projectID, ok := receivablePathID(c, "pid")
	if !ok {
		return
	}
	receivableID, ok := receivablePathID(c, "rid")
	if !ok {
		return
	}
	var body map[string]json.RawMessage
	if err := c.ShouldBindJSON(&body); err != nil || body == nil {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "请求体须为 JSON 对象"})
		return
	}
	user := rbac.GetCurrentUser(c)
	var result model.ProjectReceivablePayment
	err := h.DB.Transaction(func(tx *gorm.DB) error {
		projectRow, err := lockProject(tx, user, projectID)
		if err != nil {
			return err
		}
		if projectRow.Status == "archived" {
			return errReceivableProjectArchived
		}
		var receivable model.ProjectReceivable
		if err := tx.Clauses(updateLock).Where("id = ? AND project_id = ? AND deleted_at IS NULL", receivableID, projectID).First(&receivable).Error; err != nil {
			return err
		}
		amount, paymentDate, note, err := parsePaymentFields(body, nil)
		if err != nil {
			return err
		}
		totals, err := h.paymentTotalsWith(tx, projectID, receivableID, nil)
		if err != nil {
			return err
		}
		if !paymentWithinReceivable(totals.Amount, amount, receivable.Amount) {
			return errPaymentExceeded
		}
		now := timeutil.NowDateTime()
		result = model.ProjectReceivablePayment{
			ProjectID: projectID, ReceivableID: receivableID, Amount: amount,
			PaymentDate: paymentDate, Note: note,
			CreatedBy: user.ID, UpdatedBy: user.ID, CreatedAt: now, UpdatedAt: now,
		}
		if err := tx.Create(&result).Error; err != nil {
			return err
		}
		if err := tx.Create(&model.ProjectChange{
			ProjectID: projectID, Field: "receivable_payment",
			New:  fmt.Sprintf("登记 %s 元（应收「%s」，回款日期 %s）", moneyText(amount), receivable.Name, dateText(paymentDate)),
			ByID: &user.ID, At: now,
		}).Error; err != nil {
			return err
		}
		return audit.CommitAudited(tx, &user.ID, "create_project_receivable_payment", "project_receivable_payment", strconv.FormatUint(uint64(result.ID), 10), fmt.Sprintf("receivable=%d amount=%s", receivableID, moneyText(amount)), c.ClientIP())
	})
	if err != nil {
		receivableError(c, err)
		return
	}
	c.JSON(http.StatusCreated, paymentRow(result))
}

func (h *Handler) PatchPayment(c *gin.Context) {
	projectID, ok := receivablePathID(c, "pid")
	if !ok {
		return
	}
	receivableID, ok := receivablePathID(c, "rid")
	if !ok {
		return
	}
	paymentID, ok := receivablePathID(c, "payment_id")
	if !ok {
		return
	}
	var body map[string]json.RawMessage
	if err := c.ShouldBindJSON(&body); err != nil || body == nil {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "请求体须为 JSON 对象"})
		return
	}
	user := rbac.GetCurrentUser(c)
	var result model.ProjectReceivablePayment
	err := h.DB.Transaction(func(tx *gorm.DB) error {
		projectRow, err := lockProject(tx, user, projectID)
		if err != nil {
			return err
		}
		if projectRow.Status == "archived" {
			return errReceivableProjectArchived
		}
		var receivable model.ProjectReceivable
		if err := tx.Clauses(updateLock).Where("id = ? AND project_id = ? AND deleted_at IS NULL", receivableID, projectID).First(&receivable).Error; err != nil {
			return err
		}
		var payment model.ProjectReceivablePayment
		if err := tx.Clauses(updateLock).Where("id = ? AND project_id = ? AND receivable_id = ? AND deleted_at IS NULL", paymentID, projectID, receivableID).First(&payment).Error; err != nil {
			return err
		}
		amount, paymentDate, note, err := parsePaymentFields(body, &payment)
		if err != nil {
			return err
		}
		exclude := paymentID
		others, err := h.paymentTotalsWith(tx, projectID, receivableID, &exclude)
		if err != nil {
			return err
		}
		if !paymentWithinReceivable(others.Amount, amount, receivable.Amount) {
			return errPaymentExceeded
		}
		payment.Amount, payment.PaymentDate, payment.Note = amount, paymentDate, note
		payment.UpdatedBy, payment.UpdatedAt = user.ID, timeutil.NowDateTime()
		if err := tx.Save(&payment).Error; err != nil {
			return err
		}
		if err := tx.Create(&model.ProjectChange{
			ProjectID: projectID, Field: "receivable_payment",
			New:  fmt.Sprintf("更正「%s」下的回款为 %s 元", receivable.Name, moneyText(amount)),
			ByID: &user.ID, At: payment.UpdatedAt,
		}).Error; err != nil {
			return err
		}
		if err := audit.CommitAudited(tx, &user.ID, "update_project_receivable_payment", "project_receivable_payment", strconv.FormatUint(uint64(payment.ID), 10), "fields="+strings.Join(rawKeys(body), ","), c.ClientIP()); err != nil {
			return err
		}
		result = payment
		return nil
	})
	if err != nil {
		receivableError(c, err)
		return
	}
	c.JSON(http.StatusOK, paymentRow(result))
}

func (h *Handler) DeletePayment(c *gin.Context) {
	projectID, ok := receivablePathID(c, "pid")
	if !ok {
		return
	}
	receivableID, ok := receivablePathID(c, "rid")
	if !ok {
		return
	}
	paymentID, ok := receivablePathID(c, "payment_id")
	if !ok {
		return
	}
	user := rbac.GetCurrentUser(c)
	err := h.DB.Transaction(func(tx *gorm.DB) error {
		projectRow, err := lockProject(tx, user, projectID)
		if err != nil {
			return err
		}
		if projectRow.Status == "archived" {
			return errReceivableProjectArchived
		}
		var receivable model.ProjectReceivable
		if err := tx.Clauses(updateLock).Where("id = ? AND project_id = ? AND deleted_at IS NULL", receivableID, projectID).First(&receivable).Error; err != nil {
			return err
		}
		var payment model.ProjectReceivablePayment
		if err := tx.Clauses(updateLock).Where("id = ? AND project_id = ? AND receivable_id = ? AND deleted_at IS NULL", paymentID, projectID, receivableID).First(&payment).Error; err != nil {
			return err
		}
		now := timeutil.NowDateTime()
		payment.DeletedAt, payment.DeletedBy = &now, &user.ID
		payment.UpdatedBy, payment.UpdatedAt = user.ID, now
		if err := tx.Save(&payment).Error; err != nil {
			return err
		}
		if err := tx.Create(&model.ProjectChange{
			ProjectID: projectID, Field: "receivable_payment",
			New:  fmt.Sprintf("删除「%s」下的一笔回款 %s 元", receivable.Name, moneyText(payment.Amount)),
			ByID: &user.ID, At: now,
		}).Error; err != nil {
			return err
		}
		return audit.CommitAudited(tx, &user.ID, "delete_project_receivable_payment", "project_receivable_payment", strconv.FormatUint(uint64(payment.ID), 10), moneyText(payment.Amount), c.ClientIP())
	})
	if err != nil {
		receivableError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "id": paymentID})
}

func parsePaymentFields(body map[string]json.RawMessage, existing *model.ProjectReceivablePayment) (decimal.Decimal, timeutil.Date, string, error) {
	amount := decimal.Zero
	var paymentDate timeutil.Date
	note := ""
	if existing != nil {
		amount, paymentDate, note = existing.Amount, existing.PaymentDate, existing.Note
	}
	if raw, exists := body["amount"]; exists {
		var value json.Number
		if json.Unmarshal(raw, &value) != nil {
			return decimal.Zero, paymentDate, "", errReceivableMoney
		}
		parsed, err := decimal.NewFromString(value.String())
		if err != nil || parsed.LessThanOrEqual(decimal.Zero) || !parsed.Equal(parsed.Round(2)) {
			return decimal.Zero, paymentDate, "", errReceivableMoney
		}
		amount = parsed
	}
	if amount.LessThanOrEqual(decimal.Zero) {
		return decimal.Zero, paymentDate, "", errReceivableMoney
	}
	if raw, exists := body["payment_date"]; exists {
		parsed, err := parseDate(raw)
		if err != nil {
			return decimal.Zero, paymentDate, "", errReceivableInvalid
		}
		paymentDate = parsed
	} else if existing == nil {
		return decimal.Zero, paymentDate, "", errReceivableInvalid
	}
	if raw, exists := body["note"]; exists {
		if string(raw) == "null" {
			note = ""
		} else if json.Unmarshal(raw, &note) != nil {
			return decimal.Zero, paymentDate, "", errReceivableInvalid
		}
		note = strings.TrimSpace(note)
	}
	for key := range body {
		switch key {
		case "amount", "payment_date", "note":
		default:
			return decimal.Zero, paymentDate, "", errReceivableInvalid
		}
	}
	return amount, paymentDate, note, nil
}

func paymentRow(row model.ProjectReceivablePayment) gin.H {
	return gin.H{
		"id": row.ID, "project_id": row.ProjectID, "receivable_id": row.ReceivableID,
		"amount": moneyText(row.Amount), "payment_date": dateText(row.PaymentDate),
		"note": row.Note, "created_at": row.CreatedAt,
	}
}
