package finance

import (
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"digitalprojectmanagement/api/internal/model"
	"digitalprojectmanagement/api/pkg/timeutil"
	"github.com/gin-gonic/gin"
	"github.com/shopspring/decimal"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

type arapInput struct {
	PeriodID            uint            `json:"period_id" binding:"required"`
	TransactionDate     timeutil.Date   `json:"transaction_date" binding:"required"`
	DueDate             timeutil.Date   `json:"due_date"`
	PartyID             *uint           `json:"party_id"`
	CustomerID          *uint           `json:"customer_id"`
	VendorID            *uint           `json:"vendor_id"`
	Amount              decimal.Decimal `json:"amount"`
	AccountID           *uint           `json:"account_id"`
	OffsetAccountID     *uint           `json:"offset_account_id"`
	ReceivableAccountID *uint           `json:"receivable_account_id"`
	PayableAccountID    *uint           `json:"payable_account_id"`
	RevenueAccountID    *uint           `json:"revenue_account_id"`
	ExpenseAccountID    *uint           `json:"expense_account_id"`
	Summary             string          `json:"summary"`
}

type arapAllocationInput struct {
	TargetID uint            `json:"target_id" binding:"required"`
	Amount   decimal.Decimal `json:"amount"`
}

type arapPaymentInput struct {
	PeriodID        uint                  `json:"period_id" binding:"required"`
	TransactionDate timeutil.Date         `json:"transaction_date" binding:"required"`
	PartyID         *uint                 `json:"party_id"`
	CustomerID      *uint                 `json:"customer_id"`
	VendorID        *uint                 `json:"vendor_id"`
	Amount          decimal.Decimal       `json:"amount"`
	CashAccountID   uint                  `json:"cash_account_id" binding:"required"`
	AccountID       *uint                 `json:"account_id"`
	CashflowItem    *string               `json:"cashflow_item"`
	Summary         string                `json:"summary"`
	Allocations     []arapAllocationInput `json:"allocations"`
}

type arapEvent struct {
	TransactionID uint
	PartyID       uint
	AccountID     uint
	Date          timeutil.Date
	VoucherID     uint
	VoucherNo     string
	EventType     string
	Summary       string
	Signed        decimal.Decimal
	Priority      int
}

func selectedParty(kind string, partyID, customerID, vendorID *uint) (uint, string, bool) {
	if kind == "receivable" {
		if customerID != nil && *customerID > 0 {
			return *customerID, "customer", true
		}
		if partyID != nil && *partyID > 0 {
			return *partyID, "customer", true
		}
	} else {
		if vendorID != nil && *vendorID > 0 {
			return *vendorID, "vendor", true
		}
		if partyID != nil && *partyID > 0 {
			return *partyID, "vendor", true
		}
	}
	return 0, "", false
}

func firstNonzero(values ...*uint) uint {
	for _, value := range values {
		if value != nil && *value > 0 {
			return *value
		}
	}
	return 0
}

func (h *Handler) createARAP(c *gin.Context, kind string) {
	user := currentUser(c)
	if user == nil {
		return
	}
	book, ok := h.book(c)
	if !ok {
		return
	}
	var input arapInput
	if !bindJSON(c, &input) {
		return
	}
	partyID, partyKind, ok := selectedParty(kind, input.PartyID, input.CustomerID, input.VendorID)
	if !ok {
		badRequest(c, "往来主体不能为空")
		return
	}
	amount, err := parseMoney(input.Amount, "金额")
	if err != nil || amount.Sign() <= 0 {
		if err != nil {
			writeError(c, err, "金额无效")
		} else {
			badRequest(c, "往来金额必须大于零")
		}
		return
	}
	accountID := firstNonzero(input.AccountID, input.ReceivableAccountID, input.PayableAccountID)
	offsetID := firstNonzero(input.OffsetAccountID, input.RevenueAccountID, input.ExpenseAccountID)
	if accountID == 0 || offsetID == 0 {
		badRequest(c, "往来科目和对方科目不能为空")
		return
	}
	var voucher model.Voucher
	var transaction model.ARAPTransaction
	err = h.DB.Transaction(func(tx *gorm.DB) error {
		period, err := h.period(book.ID, input.PeriodID, tx, true)
		if err != nil {
			return err
		}
		if err := ensureOpen(period); err != nil {
			return err
		}
		if input.TransactionDate.IsZero() || input.TransactionDate.Before(period.StartDate.Time) || input.TransactionDate.After(period.EndDate.Time) {
			return financeErr(http.StatusBadRequest, "F-PERIOD-CLOSED", "往来单据日期不在所属期间")
		}
		dueDate := input.DueDate
		if dueDate.IsZero() {
			dueDate = input.TransactionDate
		}
		if !dueDate.IsZero() && dueDate.Before(input.TransactionDate.Time) {
			return financeErr(http.StatusBadRequest, "F-ARAP-DATE-RANGE", "到期日期不能早于单据日期")
		}
		var party model.AuxiliaryItem
		if err := tx.Where("id = ? AND account_book_id = ? AND kind = ? AND is_active = ?", partyID, book.ID, partyKind, true).First(&party).Error; err != nil {
			return financeErr(http.StatusBadRequest, "F-ARAP-INVALID", "往来主体不存在或类型不符")
		}
		var account, offset model.Account
		if err := tx.Where("id = ? AND account_book_id = ? AND is_active = ? AND is_leaf = ?", accountID, book.ID, true, true).First(&account).Error; err != nil {
			return financeErr(http.StatusBadRequest, "F-ARAP-INVALID", "往来科目必须是当前账套启用的末级科目")
		}
		if err := tx.Where("id = ? AND account_book_id = ? AND is_active = ? AND is_leaf = ?", offsetID, book.ID, true, true).First(&offset).Error; err != nil {
			return financeErr(http.StatusBadRequest, "F-ARAP-INVALID", "对方科目必须是当前账套启用的末级科目")
		}
		partyAux := map[string]any{partyKind: partyID}
		var lines []entryInput
		if kind == "receivable" {
			lines = []entryInput{
				{AccountID: account.ID, Summary: input.Summary, Debit: amount, AuxDetail: partyAux},
				{AccountID: offset.ID, Summary: input.Summary, Credit: amount, AuxDetail: map[string]any{}},
			}
		} else {
			lines = []entryInput{
				{AccountID: offset.ID, Summary: input.Summary, Debit: amount, AuxDetail: map[string]any{}},
				{AccountID: account.ID, Summary: input.Summary, Credit: amount, AuxDetail: partyAux},
			}
		}
		now := timeutil.AppNow()
		payload := voucherInput{
			PeriodID: period.ID, VoucherNo: fmt.Sprintf("arap-%d", now.UnixNano()),
			VoucherDate: input.TransactionDate, Summary: strings.TrimSpace(input.Summary),
			Source: "manual", Lines: lines,
		}
		created, err := h.createDraftVoucher(tx, *book, user, payload, "manual", nil)
		if err != nil {
			return err
		}
		voucher = *created
		transaction = model.ARAPTransaction{
			AccountBookID: book.ID, PeriodID: period.ID, Direction: kind,
			CounterpartyKind: partyKind, CounterpartyID: partyID,
			TransactionDate: input.TransactionDate, DueDate: dueDate,
			Amount: amount, AppliedAmount: decimal.Zero, AccountID: account.ID,
			VoucherID: &voucher.ID, Summary: strings.TrimSpace(input.Summary),
			Status: "open", CreatedBy: userID(user), CreatedAt: timeutil.NowDateTime(),
		}
		if err := tx.Create(&transaction).Error; err != nil {
			return err
		}
		return h.audit(tx, c, user, "create_arap", "arap_transaction", transaction.ID, fmt.Sprintf("voucher=%d", voucher.ID))
	})
	if err != nil {
		writeError(c, err, "创建往来单据失败")
		return
	}
	voucherResult, err := h.voucherJSON(h.DB, voucher)
	if err != nil {
		writeError(c, err, "读取往来凭证失败")
		return
	}
	c.JSON(http.StatusCreated, gin.H{
		"id": transaction.ID, "kind": transaction.Direction, "party_id": transaction.CounterpartyID,
		"amount": transaction.Amount.StringFixed(2), "outstanding": transaction.Amount.StringFixed(2),
		"status": transaction.Status, "voucher": voucherResult,
	})
}

func (h *Handler) createReceivable(c *gin.Context) {
	h.createARAP(c, "receivable")
}

func (h *Handler) createPayable(c *gin.Context) {
	h.createARAP(c, "payable")
}

func (h *Handler) listARAP(c *gin.Context, kind string) {
	book, ok := h.book(c)
	if !ok {
		return
	}
	query := h.DB.Where("account_book_id = ? AND direction = ?", book.ID, kind)
	if raw := c.Query("party_id"); raw != "" {
		partyID, err := strconv.ParseUint(raw, 10, 64)
		if err != nil || partyID == 0 {
			badRequest(c, "party_id 须为正整数")
			return
		}
		query = query.Where("counterparty_id = ?", partyID)
	}
	var rows []model.ARAPTransaction
	if err := query.Order("transaction_date, id").Find(&rows).Error; err != nil {
		writeError(c, err, "读取往来单据失败")
		return
	}
	items := make([]gin.H, 0, len(rows))
	for _, row := range rows {
		item, err := arapItemJSON(h.DB, book.ID, row)
		if err != nil {
			writeError(c, err, "读取往来单据状态失败")
			return
		}
		items = append(items, item)
	}
	c.JSON(http.StatusOK, gin.H{"total": len(items), "items": items})
}

func (h *Handler) listReceivables(c *gin.Context) { h.listARAP(c, "receivable") }
func (h *Handler) listPayables(c *gin.Context)    { h.listARAP(c, "payable") }

func arapItemJSON(db *gorm.DB, bookID uint, row model.ARAPTransaction) (gin.H, error) {
	var voucher model.Voucher
	var voucherPtr *model.Voucher
	if row.VoucherID != nil {
		err := db.Where("id = ? AND account_book_id = ?", *row.VoucherID, bookID).First(&voucher).Error
		if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, err
		}
		if err == nil {
			voucherPtr = &voucher
		}
	}
	reversed, reversing := false, false
	if row.VoucherID != nil {
		var count int64
		if err := db.Model(&model.Voucher{}).Where("account_book_id = ? AND reversal_of = ? AND status = ?", bookID, *row.VoucherID, statusPosted).Count(&count).Error; err != nil {
			return nil, err
		}
		reversed = count > 0
		if err := db.Model(&model.Voucher{}).Where("account_book_id = ? AND reversal_of = ? AND status IN ?", bookID, *row.VoucherID, []string{statusDraft, statusPending}).Count(&count).Error; err != nil {
			return nil, err
		}
		reversing = count > 0
	}
	outstanding := row.Amount.Sub(row.AppliedAmount)
	if reversed {
		outstanding = decimal.Zero
	}
	var voucherDate, voucherNo, voucherStatus any
	if voucherPtr != nil {
		voucherDate, voucherNo, voucherStatus = voucher.VoucherDate, voucher.VoucherNo, voucher.Status
	}
	return gin.H{
		"id": row.ID, "period_id": row.PeriodID, "direction": row.Direction, "kind": row.Direction,
		"transaction_date": row.TransactionDate, "due_date": row.DueDate, "voucher_date": voucherDate,
		"party_id": row.CounterpartyID, "counterparty_id": row.CounterpartyID,
		"counterparty_kind": row.CounterpartyKind, "account_id": row.AccountID,
		"amount": row.Amount.StringFixed(2), "applied_amount": row.AppliedAmount.StringFixed(2),
		"outstanding": outstanding.StringFixed(2), "summary": row.Summary, "voucher_id": row.VoucherID,
		"voucher_no": voucherNo, "voucher_status": voucherStatus, "status": row.Status,
		"is_reversed": reversed, "is_reversing": reversing,
	}, nil
}

func (h *Handler) applyARAPPayment(c *gin.Context, kind string) {
	user := currentUser(c)
	if user == nil {
		return
	}
	book, ok := h.book(c)
	if !ok {
		return
	}
	var input arapPaymentInput
	if !bindJSON(c, &input) {
		return
	}
	partyID, partyKind, ok := selectedParty(kind, input.PartyID, input.CustomerID, input.VendorID)
	if !ok {
		badRequest(c, "往来主体不能为空")
		return
	}
	amount, err := parseMoney(input.Amount, "收付款金额")
	if err != nil || amount.Sign() <= 0 {
		if err != nil {
			writeError(c, err, "收付款金额无效")
		} else {
			badRequest(c, "收付款金额必须大于零")
		}
		return
	}
	var voucher model.Voucher
	var applied []model.ARAPAllocation
	err = h.DB.Transaction(func(tx *gorm.DB) error {
		period, err := h.period(book.ID, input.PeriodID, tx, true)
		if err != nil {
			return err
		}
		if err := ensureOpen(period); err != nil {
			return err
		}
		if input.TransactionDate.IsZero() || input.TransactionDate.Before(period.StartDate.Time) || input.TransactionDate.After(period.EndDate.Time) {
			return financeErr(http.StatusBadRequest, "F-PERIOD-CLOSED", "收付款日期不在所属期间")
		}
		var party model.AuxiliaryItem
		if err := tx.Where("id = ? AND account_book_id = ? AND kind = ? AND is_active = ?", partyID, book.ID, partyKind, true).First(&party).Error; err != nil {
			return financeErr(http.StatusBadRequest, "F-ARAP-INVALID", "往来主体不存在或类型不符")
		}
		var candidates []model.ARAPTransaction
		targetQuery := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("account_book_id = ? AND direction = ? AND counterparty_id = ? AND counterparty_kind = ?", book.ID, kind, partyID, partyKind)
		if input.AccountID != nil && *input.AccountID > 0 {
			targetQuery = targetQuery.Where("account_id = ?", *input.AccountID)
		}
		if len(input.Allocations) > 0 {
			targetIDs := make([]uint, 0, len(input.Allocations))
			seen := map[uint]bool{}
			for _, allocation := range input.Allocations {
				if seen[allocation.TargetID] {
					return financeErr(http.StatusBadRequest, "F-ARAP-INVALID", "核销目标不能重复")
				}
				seen[allocation.TargetID] = true
				targetIDs = append(targetIDs, allocation.TargetID)
			}
			targetQuery = targetQuery.Where("id IN ?", targetIDs)
		}
		if err := targetQuery.Order("transaction_date, id").Find(&candidates).Error; err != nil {
			return err
		}
		valid := make([]model.ARAPTransaction, 0, len(candidates))
		voucherDates := map[uint]time.Time{}
		for _, candidate := range candidates {
			if candidate.VoucherID == nil {
				continue
			}
			var source model.Voucher
			if err := tx.Where("id = ? AND account_book_id = ? AND status = ?", *candidate.VoucherID, book.ID, statusPosted).First(&source).Error; err != nil {
				continue
			}
			if source.VoucherDate.After(input.TransactionDate.Time) {
				continue
			}
			var activeReversals int64
			if err := tx.Model(&model.Voucher{}).Where("account_book_id = ? AND reversal_of = ? AND status <> ?", book.ID, source.ID, statusVoid).Count(&activeReversals).Error; err != nil {
				return err
			}
			if activeReversals > 0 {
				continue
			}
			valid = append(valid, candidate)
			voucherDates[candidate.ID] = source.VoucherDate.Time
		}
		if len(valid) == 0 {
			return financeErr(http.StatusBadRequest, "F-ARAP-INVALID", "没有符合条件的已过账往来单据")
		}
		allocations := make([]struct {
			target model.ARAPTransaction
			amount decimal.Decimal
		}, 0)
		if len(input.Allocations) > 0 {
			byID := make(map[uint]model.ARAPTransaction, len(valid))
			for _, target := range valid {
				byID[target.ID] = target
			}
			if len(byID) != len(input.Allocations) {
				return financeErr(http.StatusBadRequest, "F-ARAP-INVALID", "目标单据不符合当前核销条件")
			}
			accountIDs := map[uint]bool{}
			total := decimal.Zero
			for _, req := range input.Allocations {
				target, ok := byID[req.TargetID]
				if !ok {
					return financeErr(http.StatusBadRequest, "F-ARAP-INVALID", "目标单据不符合当前核销条件")
				}
				value, err := parseMoney(req.Amount, "核销明细金额")
				if err != nil || value.Sign() <= 0 {
					return financeErr(http.StatusBadRequest, "F-ARAP-INVALID", "核销明细金额必须大于零且最多精确到分")
				}
				outstanding := target.Amount.Sub(target.AppliedAmount)
				if value.GreaterThan(outstanding) {
					return financeErr(http.StatusBadRequest, "F-ARAP-OVER-APPLY", "核销金额超过目标单据未核销余额")
				}
				accountIDs[target.AccountID] = true
				total = total.Add(value)
				allocations = append(allocations, struct {
					target model.ARAPTransaction
					amount decimal.Decimal
				}{target, value})
			}
			if len(accountIDs) != 1 {
				return financeErr(http.StatusBadRequest, "F-ARAP-INVALID", "一笔收付款只能核销同一往来科目")
			}
			if !total.Equal(amount) {
				return financeErr(http.StatusBadRequest, "F-ARAP-INVALID", "核销明细合计必须等于收付款金额")
			}
		} else {
			sort.Slice(valid, func(i, j int) bool {
				if voucherDates[valid[i].ID].Equal(voucherDates[valid[j].ID]) {
					return valid[i].ID < valid[j].ID
				}
				return voucherDates[valid[i].ID].Before(voucherDates[valid[j].ID])
			})
			selectedAccount := uint(0)
			for _, target := range valid {
				if target.Amount.GreaterThan(target.AppliedAmount) {
					selectedAccount = target.AccountID
					break
				}
			}
			if input.AccountID != nil && *input.AccountID > 0 {
				selectedAccount = *input.AccountID
			}
			remaining := amount
			for _, target := range valid {
				if target.AccountID != selectedAccount {
					continue
				}
				outstanding := target.Amount.Sub(target.AppliedAmount)
				if outstanding.Sign() <= 0 {
					continue
				}
				value := remaining
				if value.GreaterThan(outstanding) {
					value = outstanding
				}
				allocations = append(allocations, struct {
					target model.ARAPTransaction
					amount decimal.Decimal
				}{target, value})
				remaining = remaining.Sub(value)
				if remaining.Sign() == 0 {
					break
				}
			}
			if remaining.Sign() > 0 {
				return financeErr(http.StatusBadRequest, "F-ARAP-OVER-APPLY", "收付款金额超过同一往来科目的未核销余额")
			}
		}
		if len(allocations) == 0 {
			return financeErr(http.StatusBadRequest, "F-ARAP-INVALID", "没有可核销的单据")
		}
		targetAccountID := allocations[0].target.AccountID
		var cashAccount model.Account
		if err := tx.Where("id = ? AND account_book_id = ? AND is_active = ? AND is_leaf = ?", input.CashAccountID, book.ID, true, true).First(&cashAccount).Error; err != nil {
			return financeErr(http.StatusBadRequest, "F-ARAP-INVALID", "资金科目必须是当前账套启用的末级科目")
		}
		isCash := strings.HasPrefix(cashAccount.Code, "1001") || strings.HasPrefix(cashAccount.Code, "1002") || strings.HasPrefix(cashAccount.Code, "1012")
		if !isCash {
			return financeErr(http.StatusBadRequest, "F-ARAP-INVALID", "资金科目编码须属于现金、银行存款或其他货币资金")
		}
		var targetAccount model.Account
		if err := tx.Where("id = ? AND account_book_id = ?", targetAccountID, book.ID).First(&targetAccount).Error; err != nil {
			return err
		}
		summary := strings.TrimSpace(input.Summary)
		lines := make([]entryInput, 0, 2)
		partyAux := map[string]any{partyKind: partyID}
		if kind == "receivable" {
			lines = append(lines,
				entryInput{AccountID: cashAccount.ID, Summary: summary, Debit: amount, AuxDetail: map[string]any{}, CashflowItem: input.CashflowItem},
				entryInput{AccountID: targetAccount.ID, Summary: summary, Credit: amount, AuxDetail: partyAux},
			)
		} else {
			lines = append(lines,
				entryInput{AccountID: targetAccount.ID, Summary: summary, Debit: amount, AuxDetail: partyAux},
				entryInput{AccountID: cashAccount.ID, Summary: summary, Credit: amount, AuxDetail: map[string]any{}, CashflowItem: input.CashflowItem},
			)
		}
		now := timeutil.AppNow()
		payload := voucherInput{
			PeriodID: period.ID, VoucherNo: fmt.Sprintf("arap-pay-%d", now.UnixNano()),
			VoucherDate: input.TransactionDate, Summary: summary, Source: "cash", Lines: lines,
		}
		created, err := h.createDraftVoucher(tx, *book, user, payload, "cash", nil)
		if err != nil {
			return err
		}
		voucher = *created
		for _, allocation := range allocations {
			target := allocation.target
			target.AppliedAmount = target.AppliedAmount.Add(allocation.amount)
			target.Status = arapStatus(target.Amount, target.AppliedAmount)
			if err := tx.Model(&model.ARAPTransaction{}).Where("id = ? AND account_book_id = ?", target.ID, book.ID).Updates(map[string]any{"applied_amount": target.AppliedAmount, "status": target.Status}).Error; err != nil {
				return err
			}
			row := model.ARAPAllocation{
				AccountBookID: book.ID, PeriodID: period.ID, SourceID: voucher.ID,
				TargetID: target.ID, Amount: allocation.amount, CreatedBy: userID(user),
				CreatedAt: timeutil.NowDateTime(),
			}
			if err := tx.Create(&row).Error; err != nil {
				return err
			}
			applied = append(applied, row)
		}
		return h.audit(tx, c, user, "apply_arap", "arap_transaction", allocations[0].target.ID, fmt.Sprintf("voucher=%d,amount=%s", voucher.ID, amount.StringFixed(2)))
	})
	if err != nil {
		writeError(c, err, "收付款核销失败")
		return
	}
	voucherResult, err := h.voucherJSON(h.DB, voucher)
	if err != nil {
		writeError(c, err, "读取收付款凭证失败")
		return
	}
	key := "receivable_id"
	if kind == "payable" {
		key = "payable_id"
	}
	allocationResults := make([]gin.H, 0, len(applied))
	for _, row := range applied {
		allocationResults = append(allocationResults, gin.H{key: row.TargetID, "amount": row.Amount.StringFixed(2)})
	}
	c.JSON(http.StatusCreated, gin.H{"allocations": allocationResults, "voucher": voucherResult})
}

func (h *Handler) collectReceivables(c *gin.Context) { h.applyARAPPayment(c, "receivable") }
func (h *Handler) payPayables(c *gin.Context)        { h.applyARAPPayment(c, "payable") }

func arapStatus(amount, applied decimal.Decimal) string {
	if applied.Sign() <= 0 {
		return "open"
	}
	if applied.GreaterThanOrEqual(amount) {
		return "settled"
	}
	return "partial"
}

func ensureNoOpenARAPAllocations(tx *gorm.DB, bookID, voucherID uint) error {
	var targetIDs []uint
	if err := tx.Model(&model.ARAPTransaction{}).Where("account_book_id = ? AND voucher_id = ?", bookID, voucherID).Pluck("id", &targetIDs).Error; err != nil {
		return err
	}
	if len(targetIDs) == 0 {
		return nil
	}
	var allocation model.ARAPAllocation
	err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
		Where("account_book_id = ? AND target_id IN ? AND released_at IS NULL", bookID, targetIDs).
		First(&allocation).Error
	if err == nil {
		return financeErr(http.StatusConflict, "F-ARAP-OPEN-ALLOCATIONS", "该往来单据仍有收付款核销，请先处理相关收付款")
	}
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil
	}
	return err
}

func releaseARAPAllocations(tx *gorm.DB, bookID, sourceVoucherID, userID uint, reason string, releaseVoucherID *uint) error {
	_, err := releaseARAPAllocationsCount(tx, bookID, sourceVoucherID, userID, reason, releaseVoucherID)
	return err
}

func releaseARAPAllocationsCount(tx *gorm.DB, bookID, sourceVoucherID, userID uint, reason string, releaseVoucherID *uint) (int, error) {
	var allocations []model.ARAPAllocation
	if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
		Where("account_book_id = ? AND source_id = ? AND released_at IS NULL", bookID, sourceVoucherID).
		Order("target_id, id").Find(&allocations).Error; err != nil {
		return 0, err
	}
	if len(allocations) == 0 {
		return 0, nil
	}
	now := timeutil.NowDateTime()
	for _, allocation := range allocations {
		var target model.ARAPTransaction
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("account_book_id = ? AND id = ?", bookID, allocation.TargetID).First(&target).Error; err != nil {
			return 0, financeErr(http.StatusConflict, "F-ARAP-ALLOCATION-STATE", "核销目标单据不存在，无法安全释放分配")
		}
		if target.AppliedAmount.LessThan(allocation.Amount) {
			return 0, financeErr(http.StatusConflict, "F-ARAP-ALLOCATION-STATE", "已核销余额小于待释放金额，请联系管理员核对账套数据")
		}
		target.AppliedAmount = target.AppliedAmount.Sub(allocation.Amount)
		target.Status = arapStatus(target.Amount, target.AppliedAmount)
		if err := tx.Model(&target).Updates(map[string]any{"applied_amount": target.AppliedAmount, "status": target.Status}).Error; err != nil {
			return 0, err
		}
		updates := map[string]any{
			"released_at": now, "release_reason": strings.TrimSpace(reason),
			"release_voucher_id": releaseVoucherID,
		}
		if err := tx.Model(&model.ARAPAllocation{}).Where("id = ?", allocation.ID).Updates(updates).Error; err != nil {
			return 0, err
		}
	}
	return len(allocations), nil
}

func (h *Handler) arapEvents(bookID uint, kind string) ([]arapEvent, error) {
	var transactions []model.ARAPTransaction
	if err := h.DB.Where("account_book_id = ? AND direction = ?", bookID, kind).Find(&transactions).Error; err != nil {
		return nil, err
	}
	byID := make(map[uint]model.ARAPTransaction, len(transactions))
	voucherTransactions := map[uint][]model.ARAPTransaction{}
	voucherIDs := make([]uint, 0, len(transactions))
	events := make([]arapEvent, 0)
	for _, row := range transactions {
		if row.VoucherID == nil {
			continue
		}
		var source model.Voucher
		err := h.DB.Where("id = ? AND account_book_id = ?", *row.VoucherID, bookID).First(&source).Error
		if err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				continue
			}
			return nil, err
		}
		if source.Status != statusPosted {
			continue
		}
		byID[row.ID] = row
		voucherIDs = append(voucherIDs, source.ID)
		voucherTransactions[source.ID] = append(voucherTransactions[source.ID], row)
		events = append(events, arapEvent{
			TransactionID: row.ID, PartyID: row.CounterpartyID, AccountID: row.AccountID,
			Date: source.VoucherDate, VoucherID: source.ID, VoucherNo: source.VoucherNo,
			EventType: "单据", Summary: firstNonEmpty(source.Summary, row.Summary),
			Signed: row.Amount, Priority: 10,
		})
	}
	if len(voucherIDs) == 0 {
		return events, nil
	}
	var reversals []model.Voucher
	if err := h.DB.Where("account_book_id = ? AND status = ? AND reversal_of IN ?", bookID, statusPosted, voucherIDs).Find(&reversals).Error; err != nil {
		return nil, err
	}
	for _, reversal := range reversals {
		for _, transaction := range voucherTransactions[*reversal.ReversalOf] {
			events = append(events, arapEvent{
				TransactionID: transaction.ID, PartyID: transaction.CounterpartyID,
				AccountID: transaction.AccountID, Date: reversal.VoucherDate,
				VoucherID: reversal.ID, VoucherNo: reversal.VoucherNo,
				EventType: "单据冲销", Summary: firstNonEmpty(reversal.Summary, transaction.Summary),
				Signed: transaction.Amount.Neg(), Priority: 40,
			})
		}
	}
	targetIDs := make([]uint, 0, len(byID))
	for id := range byID {
		targetIDs = append(targetIDs, id)
	}
	var allocations []model.ARAPAllocation
	if err := h.DB.Where("account_book_id = ? AND target_id IN ?", bookID, targetIDs).Find(&allocations).Error; err != nil {
		return nil, err
	}
	for _, allocation := range allocations {
		transaction, ok := byID[allocation.TargetID]
		if !ok {
			continue
		}
		var payment model.Voucher
		err := h.DB.Where("id = ? AND account_book_id = ? AND status = ?", allocation.SourceID, bookID, statusPosted).First(&payment).Error
		if err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				continue
			}
			return nil, err
		}
		events = append(events, arapEvent{
			TransactionID: transaction.ID, PartyID: transaction.CounterpartyID,
			AccountID: transaction.AccountID, Date: payment.VoucherDate,
			VoucherID: payment.ID, VoucherNo: payment.VoucherNo,
			EventType: "收付款", Summary: firstNonEmpty(payment.Summary, transaction.Summary),
			Signed: allocation.Amount.Neg(), Priority: 20,
		})
		if allocation.ReleaseVoucherID != nil {
			var release model.Voucher
			err := h.DB.Where("id = ? AND account_book_id = ? AND status = ?", *allocation.ReleaseVoucherID, bookID, statusPosted).First(&release).Error
			if err == nil {
				events = append(events, arapEvent{
					TransactionID: transaction.ID, PartyID: transaction.CounterpartyID,
					AccountID: transaction.AccountID, Date: release.VoucherDate,
					VoucherID: release.ID, VoucherNo: release.VoucherNo,
					EventType: "收付款冲销恢复", Summary: firstNonEmpty(release.Summary, transaction.Summary),
					Signed: allocation.Amount, Priority: 30,
				})
			} else if !errors.Is(err, gorm.ErrRecordNotFound) {
				return nil, err
			}
		}
	}
	sort.Slice(events, func(i, j int) bool {
		if !events[i].Date.Equal(events[j].Date.Time) {
			return events[i].Date.Before(events[j].Date.Time)
		}
		if events[i].Priority != events[j].Priority {
			return events[i].Priority < events[j].Priority
		}
		if events[i].VoucherNo != events[j].VoucherNo {
			return events[i].VoucherNo < events[j].VoucherNo
		}
		return events[i].TransactionID < events[j].TransactionID
	})
	return events, nil
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func parseRequiredDate(c *gin.Context, key string) (timeutil.Date, bool) {
	raw := strings.TrimSpace(c.Query(key))
	if raw == "" {
		badRequest(c, key+" 必须填写")
		return timeutil.Date{}, false
	}
	parsed, err := time.ParseInLocation("2006-01-02", raw, timeutil.Loc)
	if err != nil {
		badRequest(c, key+" 日期格式须为 YYYY-MM-DD")
		return timeutil.Date{}, false
	}
	return timeutil.NewDate(parsed), true
}

func (h *Handler) arapAging(c *gin.Context, kind string) {
	book, ok := h.book(c)
	if !ok {
		return
	}
	asOf, ok := parseRequiredDate(c, "as_of")
	if !ok {
		return
	}
	partyID, ok := queryUint(c, "party_id", false)
	if !ok {
		return
	}
	accountID, ok := queryUint(c, "account_id", false)
	if !ok {
		return
	}
	var transactions []model.ARAPTransaction
	if err := h.DB.Where("account_book_id = ? AND direction = ?", book.ID, kind).Find(&transactions).Error; err != nil {
		writeError(c, err, "读取账龄单据失败")
		return
	}
	transactionByID := map[uint]model.ARAPTransaction{}
	for _, row := range transactions {
		transactionByID[row.ID] = row
	}
	events, err := h.arapEvents(book.ID, kind)
	if err != nil {
		writeError(c, err, "计算账龄失败")
		return
	}
	balances := map[uint]decimal.Decimal{}
	for _, event := range events {
		if event.Date.After(asOf.Time) || (partyID > 0 && event.PartyID != partyID) || (accountID > 0 && event.AccountID != accountID) {
			continue
		}
		balances[event.TransactionID] = balances[event.TransactionID].Add(event.Signed)
	}
	buckets := map[string]decimal.Decimal{
		"0_30": decimal.Zero, "31_60": decimal.Zero,
		"61_90": decimal.Zero, "90_plus": decimal.Zero,
	}
	for id, balance := range balances {
		if balance.Sign() <= 0 {
			continue
		}
		transaction := transactionByID[id]
		age := int(asOf.Sub(transaction.DueDate.Time).Hours() / 24)
		switch {
		case age <= 30:
			buckets["0_30"] = buckets["0_30"].Add(balance)
		case age <= 60:
			buckets["31_60"] = buckets["31_60"].Add(balance)
		case age <= 90:
			buckets["61_90"] = buckets["61_90"].Add(balance)
		default:
			buckets["90_plus"] = buckets["90_plus"].Add(balance)
		}
	}
	total := decimal.Zero
	out := gin.H{}
	for key, value := range buckets {
		total = total.Add(value)
		out[key] = value.StringFixed(2)
	}
	c.JSON(http.StatusOK, gin.H{"as_of": asOf, "age_basis": "due_date", "total_outstanding": total.StringFixed(2), "buckets": out})
}

func (h *Handler) receivableAging(c *gin.Context) { h.arapAging(c, "receivable") }
func (h *Handler) payableAging(c *gin.Context)    { h.arapAging(c, "payable") }

func (h *Handler) arapStatement(c *gin.Context, kind string) {
	book, ok := h.book(c)
	if !ok {
		return
	}
	partyID, ok := queryUint(c, "party_id", true)
	if !ok {
		return
	}
	accountID, ok := queryUint(c, "account_id", false)
	if !ok {
		return
	}
	fromDate, ok := parseRequiredDate(c, "from_date")
	if !ok {
		return
	}
	toDate, ok := parseRequiredDate(c, "to_date")
	if !ok {
		return
	}
	if fromDate.After(toDate.Time) {
		writeError(c, financeErr(http.StatusBadRequest, "F-ARAP-DATE-RANGE", "开始日期不能晚于结束日期"), "")
		return
	}
	page, size, ok := parsePage(c, 50, 200)
	if !ok {
		return
	}
	events, err := h.arapEvents(book.ID, kind)
	if err != nil {
		writeError(c, err, "生成往来对账单失败")
		return
	}
	filtered := make([]arapEvent, 0)
	opening := decimal.Zero
	increase, decrease := decimal.Zero, decimal.Zero
	running := decimal.Zero
	for _, event := range events {
		if event.PartyID != partyID || (accountID > 0 && event.AccountID != accountID) {
			continue
		}
		if event.Date.Before(fromDate.Time) {
			opening = opening.Add(event.Signed)
			continue
		}
		if event.Date.After(toDate.Time) {
			continue
		}
		filtered = append(filtered, event)
	}
	running = opening
	items := make([]gin.H, 0, len(filtered))
	for _, event := range filtered {
		running = running.Add(event.Signed)
		item := gin.H{
			"transaction_id": event.TransactionID, "transaction_date": event.Date,
			"voucher_id": event.VoucherID, "voucher_no": event.VoucherNo,
			"event_type": event.EventType, "summary": event.Summary,
			"direction": "increase", "amount": event.Signed.Abs().StringFixed(2),
			"balance_after": running.StringFixed(2),
		}
		if event.Signed.Sign() < 0 {
			item["direction"] = "decrease"
			decrease = decrease.Add(event.Signed.Abs())
		} else {
			increase = increase.Add(event.Signed)
		}
		items = append(items, item)
	}
	total := len(items)
	start := (page - 1) * size
	if start > total {
		start = total
	}
	end := start + size
	if end > total {
		end = total
	}
	c.JSON(http.StatusOK, gin.H{
		"kind": kind, "party_id": partyID, "account_id": optionalUint(accountID),
		"from_date": fromDate, "to_date": toDate,
		"opening_balance": opening.StringFixed(2), "period_increase": increase.StringFixed(2),
		"period_decrease": decrease.StringFixed(2), "closing_balance": opening.Add(increase).Sub(decrease).StringFixed(2),
		"total_lines": total, "page": page, "page_size": size, "items": items[start:end],
	})
}

func optionalUint(value uint) any {
	if value == 0 {
		return nil
	}
	return value
}

func (h *Handler) receivableStatement(c *gin.Context) { h.arapStatement(c, "receivable") }
func (h *Handler) payableStatement(c *gin.Context)    { h.arapStatement(c, "payable") }
