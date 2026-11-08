package receivable

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
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
	"gorm.io/gorm/clause"
)

var receivableSorts = map[string]string{
	"id": "project_receivables.id", "name": "project_receivables.name",
	"amount": "project_receivables.amount", "receivable_date": "project_receivables.receivable_date",
	"due_date": "project_receivables.due_date", "created_at": "project_receivables.created_at",
}
var paymentSorts = map[string]string{
	"id": "project_receivable_payments.id", "amount": "project_receivable_payments.amount",
	"payment_date": "project_receivable_payments.payment_date",
	"created_at":   "project_receivable_payments.created_at",
}

func paymentWithinReceivable(received, amount, total decimal.Decimal) bool {
	return received.Add(amount).LessThanOrEqual(total)
}

func (h *Handler) ListReceivables(c *gin.Context) {
	projectID, ok := receivablePathID(c, "pid")
	if !ok {
		return
	}
	if _, err := projectdomain.LoadVisibleProject(h.DB, rbac.GetCurrentUser(c), projectID); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"detail": "项目不存在"})
		return
	}
	page, size, ok := receivablePagination(c)
	if !ok {
		return
	}
	q := h.DB.Model(&model.ProjectReceivable{}).Where("project_id = ? AND deleted_at IS NULL", projectID)
	result, err := paging.Paginate[model.ProjectReceivable](q, page, size, c.Query("sort"), receivableSorts, "-id")
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"detail": err.Error()})
		return
	}
	totals := h.paymentTotals(projectID, receivableIDs(result.Items))
	items := make([]gin.H, 0, len(result.Items))
	for _, row := range result.Items {
		items = append(items, receivableRow(row, totals[row.ID]))
	}
	summary := h.receivableSummary(projectID)
	c.JSON(http.StatusOK, gin.H{"total": result.Total, "page": result.Page, "size": result.Size, "items": items, "summary": summary})
}

func (h *Handler) CreateReceivable(c *gin.Context) {
	projectID, ok := receivablePathID(c, "pid")
	if !ok {
		return
	}
	var body map[string]json.RawMessage
	if err := c.ShouldBindJSON(&body); err != nil || body == nil {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "请求体须为 JSON 对象"})
		return
	}
	user := rbac.GetCurrentUser(c)
	var result model.ProjectReceivable
	err := h.DB.Transaction(func(tx *gorm.DB) error {
		projectRow, err := lockProject(tx, user, projectID)
		if err != nil {
			return err
		}
		if projectRow.Status == "archived" {
			return errReceivableProjectArchived
		}
		name, amount, receivableDate, dueDate, note, err := parseReceivableFields(body, nil)
		if err != nil {
			return err
		}
		if dueDate.Before(receivableDate.Time) {
			return errReceivableDates
		}
		now := timeutil.NowDateTime()
		result = model.ProjectReceivable{
			ProjectID: projectID, Name: name, Amount: amount,
			ReceivableDate: receivableDate, DueDate: dueDate, Note: note,
			CreatedBy: user.ID, UpdatedBy: user.ID, CreatedAt: now, UpdatedAt: now,
		}
		if err := tx.Create(&result).Error; err != nil {
			return err
		}
		if err := tx.Create(&model.ProjectChange{
			ProjectID: projectID, Field: "receivable",
			New:  fmt.Sprintf("新增「%s」%s 元", name, moneyText(amount)),
			ByID: &user.ID, At: now,
		}).Error; err != nil {
			return err
		}
		return audit.CommitAudited(tx, &user.ID, "create_project_receivable", "project_receivable", strconv.FormatUint(uint64(result.ID), 10), name, c.ClientIP())
	})
	if err != nil {
		receivableError(c, err)
		return
	}
	c.JSON(http.StatusCreated, receivableRow(result, paymentTotal{}))
}

func (h *Handler) PatchReceivable(c *gin.Context) {
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
	var result model.ProjectReceivable
	err := h.DB.Transaction(func(tx *gorm.DB) error {
		projectRow, err := lockProject(tx, user, projectID)
		if err != nil {
			return err
		}
		if projectRow.Status == "archived" {
			return errReceivableProjectArchived
		}
		var row model.ProjectReceivable
		if err := tx.Clauses(updateLock).Where("id = ? AND project_id = ? AND deleted_at IS NULL", receivableID, projectID).First(&row).Error; err != nil {
			return err
		}
		name, amount, receivableDate, dueDate, note, err := parseReceivableFields(body, &row)
		if err != nil {
			return err
		}
		if dueDate.Before(receivableDate.Time) {
			return errReceivableDates
		}
		received, _ := h.paymentTotalsWith(tx, projectID, receivableID, nil)
		if amount.LessThan(received.Amount) {
			return errReceivableBelowPaid
		}
		row.Name, row.Amount = name, amount
		row.ReceivableDate, row.DueDate, row.Note = receivableDate, dueDate, note
		row.UpdatedBy, row.UpdatedAt = user.ID, timeutil.NowDateTime()
		if err := tx.Save(&row).Error; err != nil {
			return err
		}
		if err := tx.Create(&model.ProjectChange{
			ProjectID: projectID, Field: "receivable",
			New:  fmt.Sprintf("修改「%s」为 %s 元", row.Name, moneyText(row.Amount)),
			ByID: &user.ID, At: row.UpdatedAt,
		}).Error; err != nil {
			return err
		}
		if err := audit.CommitAudited(tx, &user.ID, "update_project_receivable", "project_receivable", strconv.FormatUint(uint64(row.ID), 10), "fields="+strings.Join(rawKeys(body), ","), c.ClientIP()); err != nil {
			return err
		}
		result = row
		return nil
	})
	if err != nil {
		receivableError(c, err)
		return
	}
	totals, _ := h.paymentTotalsWith(h.DB, projectID, receivableID, nil)
	c.JSON(http.StatusOK, receivableRow(result, totals))
}

func (h *Handler) DeleteReceivable(c *gin.Context) {
	projectID, ok := receivablePathID(c, "pid")
	if !ok {
		return
	}
	receivableID, ok := receivablePathID(c, "rid")
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
		var row model.ProjectReceivable
		if err := tx.Clauses(updateLock).Where("id = ? AND project_id = ? AND deleted_at IS NULL", receivableID, projectID).First(&row).Error; err != nil {
			return err
		}
		now := timeutil.NowDateTime()
		row.DeletedAt, row.DeletedBy = &now, &user.ID
		row.UpdatedBy, row.UpdatedAt = user.ID, now
		if err := tx.Save(&row).Error; err != nil {
			return err
		}
		if err := tx.Create(&model.ProjectChange{ProjectID: projectID, Field: "receivable", New: "删除「" + row.Name + "」", ByID: &user.ID, At: now}).Error; err != nil {
			return err
		}
		return audit.CommitAudited(tx, &user.ID, "delete_project_receivable", "project_receivable", strconv.FormatUint(uint64(row.ID), 10), row.Name, c.ClientIP())
	})
	if err != nil {
		receivableError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "id": receivableID})
}

type paymentTotal struct {
	Amount decimal.Decimal
	Count  int64
}

func (h *Handler) paymentTotals(projectID uint, ids []uint) map[uint]paymentTotal {
	result := make(map[uint]paymentTotal, len(ids))
	if len(ids) == 0 {
		return result
	}
	type row struct {
		ReceivableID uint            `gorm:"column:receivable_id"`
		Amount       decimal.Decimal `gorm:"column:amount"`
		Count        int64           `gorm:"column:count"`
	}
	var rows []row
	h.DB.Model(&model.ProjectReceivablePayment{}).
		Select("receivable_id, COALESCE(SUM(amount), 0) AS amount, COUNT(*) AS count").
		Where("project_id = ? AND receivable_id IN ? AND deleted_at IS NULL", projectID, ids).
		Group("receivable_id").Scan(&rows)
	for _, item := range rows {
		result[item.ReceivableID] = paymentTotal{Amount: item.Amount, Count: item.Count}
	}
	for _, id := range ids {
		if _, exists := result[id]; !exists {
			result[id] = paymentTotal{Amount: decimal.Zero, Count: 0}
		}
	}
	return result
}

func (h *Handler) paymentTotalsWith(db *gorm.DB, projectID, receivableID uint, excluded *uint) (paymentTotal, error) {
	query := db.Model(&model.ProjectReceivablePayment{}).
		Where("project_id = ? AND receivable_id = ? AND deleted_at IS NULL", projectID, receivableID)
	if excluded != nil {
		query = query.Where("id <> ?", *excluded)
	}
	var result paymentTotal
	err := query.Select("COALESCE(SUM(amount), 0) AS amount, COUNT(*) AS count").Scan(&result).Error
	return result, err
}

func (h *Handler) receivableSummary(projectID uint) gin.H {
	var totalAmount, totalReceived decimal.Decimal
	h.DB.Model(&model.ProjectReceivable{}).Select("COALESCE(SUM(amount), 0)").Where("project_id = ? AND deleted_at IS NULL", projectID).Scan(&totalAmount)
	h.DB.Model(&model.ProjectReceivablePayment{}).Select("COALESCE(SUM(amount), 0)").
		Where("project_id = ? AND deleted_at IS NULL AND receivable_id IN (?)", projectID,
			h.DB.Model(&model.ProjectReceivable{}).Select("id").Where("project_id = ? AND deleted_at IS NULL", projectID)).
		Scan(&totalReceived)
	return gin.H{"amount": moneyText(totalAmount), "received_amount": moneyText(totalReceived), "outstanding_amount": moneyText(maxDecimal(totalAmount.Sub(totalReceived), decimal.Zero))}
}

func receivableIDs(rows []model.ProjectReceivable) []uint {
	ids := make([]uint, 0, len(rows))
	for _, row := range rows {
		ids = append(ids, row.ID)
	}
	return ids
}

func receivableRow(row model.ProjectReceivable, totals paymentTotal) gin.H {
	outstanding := maxDecimal(row.Amount.Sub(totals.Amount), decimal.Zero)
	return gin.H{
		"id": row.ID, "project_id": row.ProjectID, "name": row.Name,
		"amount": moneyText(row.Amount), "received_amount": moneyText(totals.Amount),
		"outstanding_amount": moneyText(outstanding), "receivable_date": dateText(row.ReceivableDate),
		"due_date": dateText(row.DueDate), "note": row.Note,
		"status":        receivableStatus(row.Amount, totals.Amount, row.DueDate),
		"payment_count": totals.Count,
	}
}

func receivableStatus(amount, received decimal.Decimal, due timeutil.Date) string {
	if received.GreaterThanOrEqual(amount) {
		return "paid"
	}
	today := timeutil.NewDate(timeutil.AppNow())
	if due.Before(today.Time) {
		return "overdue"
	}
	if received.GreaterThan(decimal.Zero) {
		return "partial"
	}
	return "unpaid"
}

func dateText(value timeutil.Date) string {
	return value.Format("2006-01-02")
}

func maxDecimal(a, b decimal.Decimal) decimal.Decimal {
	if a.GreaterThan(b) {
		return a
	}
	return b
}

func lockProject(tx *gorm.DB, user *model.User, projectID uint) (model.Project, error) {
	var row model.Project
	err := tx.Clauses(updateLock).
		Where("id = ? AND id IN (?)", projectID, projectdomain.VisibleProjectIDs(tx, user)).
		First(&row).Error
	return row, err
}

func parseReceivableFields(body map[string]json.RawMessage, existing *model.ProjectReceivable) (string, decimal.Decimal, timeutil.Date, timeutil.Date, string, error) {
	name := ""
	amount := decimal.Zero
	var receivableDate, dueDate timeutil.Date
	note := ""
	if existing != nil {
		name, amount, receivableDate, dueDate, note = existing.Name, existing.Amount, existing.ReceivableDate, existing.DueDate, existing.Note
	}
	if raw, exists := body["name"]; exists {
		if json.Unmarshal(raw, &name) != nil {
			return "", decimal.Zero, receivableDate, dueDate, "", errReceivableInvalid
		}
		name = strings.TrimSpace(name)
	}
	if name == "" || len([]rune(name)) > 128 {
		return "", decimal.Zero, receivableDate, dueDate, "", errReceivableInvalid
	}
	if raw, exists := body["amount"]; exists {
		var value json.Number
		if json.Unmarshal(raw, &value) != nil {
			return "", decimal.Zero, receivableDate, dueDate, "", errReceivableMoney
		}
		parsed, err := decimal.NewFromString(value.String())
		if err != nil || parsed.LessThanOrEqual(decimal.Zero) || !parsed.Equal(parsed.Round(2)) {
			return "", decimal.Zero, receivableDate, dueDate, "", errReceivableMoney
		}
		amount = parsed
	}
	if existing == nil && amount.LessThanOrEqual(decimal.Zero) {
		return "", decimal.Zero, receivableDate, dueDate, "", errReceivableMoney
	}
	if raw, exists := body["receivable_date"]; exists {
		value, err := parseDate(raw)
		if err != nil {
			return "", decimal.Zero, receivableDate, dueDate, "", errReceivableInvalid
		}
		receivableDate = value
	} else if existing == nil {
		return "", decimal.Zero, receivableDate, dueDate, "", errReceivableInvalid
	}
	if raw, exists := body["due_date"]; exists {
		value, err := parseDate(raw)
		if err != nil {
			return "", decimal.Zero, receivableDate, dueDate, "", errReceivableInvalid
		}
		dueDate = value
	} else if existing == nil {
		return "", decimal.Zero, receivableDate, dueDate, "", errReceivableInvalid
	}
	if raw, exists := body["note"]; exists {
		if string(raw) == "null" {
			note = ""
		} else if json.Unmarshal(raw, &note) != nil {
			return "", decimal.Zero, receivableDate, dueDate, "", errReceivableInvalid
		}
		note = strings.TrimSpace(note)
	}
	for key := range body {
		switch key {
		case "name", "amount", "receivable_date", "due_date", "note":
		default:
			return "", decimal.Zero, receivableDate, dueDate, "", errReceivableInvalid
		}
	}
	return name, amount, receivableDate, dueDate, note, nil
}

func parseDate(raw json.RawMessage) (timeutil.Date, error) {
	var value timeutil.Date
	if err := value.UnmarshalJSON(raw); err != nil {
		return value, err
	}
	return value, nil
}

func moneyText(value decimal.Decimal) string {
	return value.Round(2).StringFixed(2)
}

func receivablePathID(c *gin.Context, key string) (uint, bool) {
	value, err := strconv.ParseUint(c.Param(key), 10, 32)
	if err != nil || value == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "ID 格式无效"})
		return 0, false
	}
	return uint(value), true
}

func receivablePagination(c *gin.Context) (int, int, bool) {
	page, err := strconv.Atoi(c.DefaultQuery("page", "1"))
	if err != nil || page < 1 {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "page 须为正整数"})
		return 0, 0, false
	}
	size, err := strconv.Atoi(c.DefaultQuery("size", "20"))
	if err != nil || size < 1 || size > paging.MaxPageSize {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "size 须为 1-100"})
		return 0, 0, false
	}
	return page, size, true
}

func rawKeys(values map[string]json.RawMessage) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func receivableError(c *gin.Context, err error) {
	switch err {
	case gorm.ErrRecordNotFound:
		c.JSON(http.StatusNotFound, gin.H{"detail": "项目或应收记录不存在"})
	case errReceivableProjectArchived:
		c.JSON(http.StatusBadRequest, gin.H{"detail": "已归档项目只读"})
	case errReceivableInvalid:
		c.JSON(http.StatusBadRequest, gin.H{"detail": "应收字段无效"})
	case errReceivableMoney:
		c.JSON(http.StatusBadRequest, gin.H{"detail": "金额须为正数且最多保留两位小数"})
	case errReceivableDates:
		c.JSON(http.StatusBadRequest, gin.H{"detail": "到期日不能早于应收日期"})
	case errReceivableBelowPaid:
		c.JSON(http.StatusBadRequest, gin.H{"detail": "应收金额不能低于已回款金额"})
	case errPaymentExceeded:
		c.JSON(http.StatusBadRequest, gin.H{"detail": "回款累计不能超过应收金额"})
	default:
		c.JSON(http.StatusInternalServerError, gin.H{"detail": "应收台账操作失败"})
	}
}

var updateLock = clause.Locking{Strength: clause.LockingStrengthUpdate}

var (
	errReceivableProjectArchived = errors.New("receivable project archived")
	errReceivableInvalid         = errors.New("invalid receivable")
	errReceivableMoney           = errors.New("invalid receivable amount")
	errReceivableDates           = errors.New("invalid receivable dates")
	errReceivableBelowPaid       = errors.New("receivable amount below payments")
	errPaymentExceeded           = errors.New("payment total exceeded")
)
