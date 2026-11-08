package finance

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
	"github.com/shopspring/decimal"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

type ledgerTotals struct {
	AccountID uint            `gorm:"column:account_id"`
	Debit     decimal.Decimal `gorm:"column:debit"`
	Credit    decimal.Decimal `gorm:"column:credit"`
}

type reportNode struct {
	Account  model.Account
	Balance  decimal.Decimal
	Children []uint
}

func accountTotals(db *gorm.DB, bookID uint, period model.AccountingPeriod, scope string, excludeClose bool) (map[uint]ledgerTotals, error) {
	query := db.Table("voucher_entries").
		Select("voucher_entries.account_id, COALESCE(SUM(voucher_entries.debit), 0) AS debit, COALESCE(SUM(voucher_entries.credit), 0) AS credit").
		Joins("JOIN vouchers ON vouchers.id = voucher_entries.voucher_id").
		Joins("JOIN accounting_periods ON accounting_periods.id = vouchers.period_id").
		Where("vouchers.account_book_id = ? AND vouchers.status = ?", bookID, statusPosted)
	switch scope {
	case "current":
		query = query.Where("vouchers.period_id = ?", period.ID)
	case "before":
		query = query.Where("accounting_periods.period_index < ?", period.PeriodIndex)
	case "through":
		query = query.Where("accounting_periods.period_index <= ?", period.PeriodIndex)
	default:
		return nil, fmt.Errorf("unsupported period scope %q", scope)
	}
	if excludeClose {
		query = query.Where("vouchers.source NOT IN ?", []string{"auto-close", "auto-reopen"})
	}
	var rows []ledgerTotals
	if err := query.Group("voucher_entries.account_id").Scan(&rows).Error; err != nil {
		return nil, err
	}
	result := make(map[uint]ledgerTotals, len(rows))
	for _, row := range rows {
		result[row.AccountID] = row
	}
	return result, nil
}

func openingTotals(db *gorm.DB, bookID uint) (map[uint]ledgerTotals, decimal.Decimal, decimal.Decimal, error) {
	var rows []model.OpeningBalance
	if err := db.Where("account_book_id = ?", bookID).Find(&rows).Error; err != nil {
		return nil, decimal.Zero, decimal.Zero, err
	}
	result := map[uint]ledgerTotals{}
	debitTotal, creditTotal := decimal.Zero, decimal.Zero
	for _, row := range rows {
		total := result[row.AccountID]
		total.AccountID = row.AccountID
		total.Debit = total.Debit.Add(row.Debit)
		total.Credit = total.Credit.Add(row.Credit)
		result[row.AccountID] = total
		debitTotal = debitTotal.Add(row.Debit)
		creditTotal = creditTotal.Add(row.Credit)
	}
	return result, debitTotal, creditTotal, nil
}

func signedBalance(totals ledgerTotals) decimal.Decimal {
	return totals.Debit.Sub(totals.Credit)
}

func balanceSides(net decimal.Decimal) (decimal.Decimal, decimal.Decimal) {
	if net.Sign() >= 0 {
		return net, decimal.Zero
	}
	return decimal.Zero, net.Abs()
}

func (h *Handler) balances(c *gin.Context) {
	book, ok := h.book(c)
	if !ok {
		return
	}
	periodID, ok := queryUint(c, "period_id", true)
	if !ok {
		return
	}
	period, err := h.period(book.ID, periodID, h.DB, false)
	if err != nil {
		writeError(c, err, "期间不存在")
		return
	}
	opening, _, _, err := openingTotals(h.DB, book.ID)
	if err != nil {
		writeError(c, err, "读取期初余额失败")
		return
	}
	prior, err := accountTotals(h.DB, book.ID, *period, "before", false)
	if err != nil {
		writeError(c, err, "读取以前期间发生额失败")
		return
	}
	current, err := accountTotals(h.DB, book.ID, *period, "current", false)
	if err != nil {
		writeError(c, err, "读取本期发生额失败")
		return
	}
	var accounts []model.Account
	if err := h.DB.Where("account_book_id = ?", book.ID).Order("code").Find(&accounts).Error; err != nil {
		writeError(c, err, "读取科目失败")
		return
	}
	items := make([]gin.H, 0, len(accounts))
	for _, account := range accounts {
		beginNet := signedBalance(opening[account.ID]).Add(signedBalance(prior[account.ID]))
		beginDebit, beginCredit := balanceSides(beginNet)
		movement := current[account.ID]
		endDebit, endCredit := balanceSides(beginNet.Add(signedBalance(movement)))
		items = append(items, gin.H{
			"account_id": account.ID, "account_code": account.Code, "account_name": account.Name,
			"level": account.Level, "parent_id": account.ParentID, "direction": account.Direction,
			"category": account.Category, "opening_debit": beginDebit.StringFixed(2),
			"opening_credit": beginCredit.StringFixed(2), "debit_total": movement.Debit.StringFixed(2),
			"credit_total": movement.Credit.StringFixed(2), "ending_debit": endDebit.StringFixed(2),
			"ending_credit": endCredit.StringFixed(2),
		})
	}
	c.JSON(http.StatusOK, gin.H{"period_id": period.ID, "items": items})
}

func (h *Handler) generalLedger(c *gin.Context) {
	book, ok := h.book(c)
	if !ok {
		return
	}
	periodID, ok := queryUint(c, "period_id", true)
	if !ok {
		return
	}
	var period model.AccountingPeriod
	if err := h.DB.Where("id = ? AND account_book_id = ?", periodID, book.ID).First(&period).Error; err != nil {
		writeError(c, err, "期间不存在")
		return
	}
	var accounts []model.Account
	if err := h.DB.Where("account_book_id = ?", book.ID).Order("code").Find(&accounts).Error; err != nil {
		writeError(c, err, "读取科目失败")
		return
	}
	opening, _, _, err := openingTotals(h.DB, book.ID)
	if err != nil {
		writeError(c, err, "读取期初余额失败")
		return
	}
	prior, err := accountTotals(h.DB, book.ID, period, "before", false)
	if err != nil {
		writeError(c, err, "读取以前期间发生额失败")
		return
	}
	current, err := accountTotals(h.DB, book.ID, period, "current", false)
	if err != nil {
		writeError(c, err, "读取本期发生额失败")
		return
	}
	items := make([]gin.H, 0, len(accounts))
	for _, account := range accounts {
		begin := signedBalance(opening[account.ID]).Add(signedBalance(prior[account.ID]))
		movement := current[account.ID]
		ending := begin.Add(signedBalance(movement))
		items = append(items, gin.H{
			"account_id": account.ID, "account_code": account.Code, "account_name": account.Name,
			"category": account.Category, "direction": account.Direction,
			"opening_balance": begin.StringFixed(2), "debit_total": movement.Debit.StringFixed(2),
			"credit_total": movement.Credit.StringFixed(2), "ending_balance": ending.StringFixed(2),
		})
	}
	c.JSON(http.StatusOK, gin.H{"period_id": period.ID, "items": items})
}

func (h *Handler) detailLedger(c *gin.Context) {
	book, ok := h.book(c)
	if !ok {
		return
	}
	periodID, ok := queryUint(c, "period_id", true)
	if !ok {
		return
	}
	accountID, ok := queryUint(c, "account_id", true)
	if !ok {
		return
	}
	period, err := h.period(book.ID, periodID, h.DB, false)
	if err != nil {
		writeError(c, err, "期间不存在")
		return
	}
	var account model.Account
	if err := h.DB.Where("id = ? AND account_book_id = ?", accountID, book.ID).First(&account).Error; err != nil {
		writeError(c, err, "科目不存在")
		return
	}
	opening, _, _, err := openingTotals(h.DB, book.ID)
	if err != nil {
		writeError(c, err, "读取期初余额失败")
		return
	}
	prior, err := accountTotals(h.DB, book.ID, *period, "before", false)
	if err != nil {
		writeError(c, err, "读取以前期间发生额失败")
		return
	}
	running := signedBalance(opening[account.ID]).Add(signedBalance(prior[account.ID]))
	beginDebit, beginCredit := balanceSides(running)
	var entries []model.VoucherEntry
	err = h.DB.Table("voucher_entries").
		Select("voucher_entries.*").
		Joins("JOIN vouchers ON vouchers.id = voucher_entries.voucher_id").
		Where("vouchers.account_book_id = ? AND vouchers.period_id = ? AND vouchers.status = ? AND voucher_entries.account_id = ?", book.ID, period.ID, statusPosted, account.ID).
		Order("vouchers.voucher_date, vouchers.id, voucher_entries.line_no").
		Find(&entries).Error
	if err != nil {
		writeError(c, err, "读取科目明细失败")
		return
	}
	items := make([]gin.H, 0, len(entries))
	for _, entry := range entries {
		var voucher model.Voucher
		if err := h.DB.Where("id = ? AND account_book_id = ?", entry.VoucherID, book.ID).First(&voucher).Error; err != nil {
			writeError(c, err, "读取明细凭证失败")
			return
		}
		running = running.Add(entry.Debit).Sub(entry.Credit)
		aux := map[string]any{}
		_ = jsonUnmarshal(entry.AuxDetail, &aux)
		items = append(items, gin.H{
			"voucher_id": voucher.ID, "voucher_no": voucher.VoucherNo,
			"voucher_date": voucher.VoucherDate, "line_no": entry.LineNo,
			"summary": entry.Summary, "debit": entry.Debit.StringFixed(2),
			"credit": entry.Credit.StringFixed(2), "balance_after": running.StringFixed(2),
			"aux_detail": aux,
		})
	}
	c.JSON(http.StatusOK, gin.H{
		"period_id": period.ID, "account_id": account.ID, "account_code": account.Code,
		"account_name": account.Name, "opening_debit": beginDebit.StringFixed(2),
		"opening_credit": beginCredit.StringFixed(2), "items": items,
	})
}

func jsonUnmarshal(value string, target any) error {
	return json.Unmarshal([]byte(value), target)
}

func normalBalance(account model.Account, totals ledgerTotals) decimal.Decimal {
	net := signedBalance(totals)
	if account.Direction == "C" {
		return net.Neg()
	}
	return net
}

func (h *Handler) balanceSheet(c *gin.Context) {
	book, ok := h.book(c)
	if !ok {
		return
	}
	periodID, ok := queryUint(c, "period_id", true)
	if !ok {
		return
	}
	period, err := h.period(book.ID, periodID, h.DB, false)
	if err != nil {
		writeError(c, err, "期间不存在")
		return
	}
	opening, _, _, err := openingTotals(h.DB, book.ID)
	if err != nil {
		writeError(c, err, "读取期初余额失败")
		return
	}
	through, err := accountTotals(h.DB, book.ID, *period, "through", false)
	if err != nil {
		writeError(c, err, "读取科目发生额失败")
		return
	}
	var accounts []model.Account
	if err := h.DB.Where("account_book_id = ?", book.ID).Order("code").Find(&accounts).Error; err != nil {
		writeError(c, err, "读取科目树失败")
		return
	}
	nodes := make(map[uint]*reportNode, len(accounts))
	for _, account := range accounts {
		own := opening[account.ID]
		activity := through[account.ID]
		own.Debit = own.Debit.Add(activity.Debit)
		own.Credit = own.Credit.Add(activity.Credit)
		nodes[account.ID] = &reportNode{Account: account, Balance: normalBalance(account, own)}
	}
	for index := len(accounts) - 1; index >= 0; index-- {
		account := accounts[index]
		if account.ParentID != nil {
			if parent := nodes[*account.ParentID]; parent != nil {
				parent.Children = append(parent.Children, account.ID)
				parent.Balance = parent.Balance.Add(nodes[account.ID].Balance)
			}
		}
	}
	assets, liabilities, equity, profit := decimal.Zero, decimal.Zero, decimal.Zero, decimal.Zero
	for _, account := range accounts {
		value := nodes[account.ID].Balance
		switch account.Category {
		case "资产":
			assets = assets.Add(normalBalance(account, combineTotals(opening[account.ID], through[account.ID])))
		case "负债":
			liabilities = liabilities.Add(normalBalance(account, combineTotals(opening[account.ID], through[account.ID])))
		case "权益":
			equity = equity.Add(normalBalance(account, combineTotals(opening[account.ID], through[account.ID])))
		case "损益":
			profit = profit.Add(value)
		}
	}
	items := make([]gin.H, 0, len(accounts))
	for _, account := range accounts {
		node := nodes[account.ID]
		items = append(items, gin.H{
			"account_id": account.ID, "account_code": account.Code, "account_name": account.Name,
			"parent_id": account.ParentID, "level": account.Level, "category": account.Category,
			"balance": node.Balance.StringFixed(2),
		})
	}
	totalEquity := equity.Add(profit)
	c.JSON(http.StatusOK, gin.H{
		"period_id": period.ID, "items": items,
		"totals": gin.H{
			"assets": assets.StringFixed(2), "liabilities": liabilities.StringFixed(2),
			"equity": totalEquity.StringFixed(2), "profit_before_close": profit.StringFixed(2),
			"balanced": assets.Equal(liabilities.Add(totalEquity)),
		},
	})
}

func combineTotals(a, b ledgerTotals) ledgerTotals {
	return ledgerTotals{AccountID: a.AccountID, Debit: a.Debit.Add(b.Debit), Credit: a.Credit.Add(b.Credit)}
}

func (h *Handler) incomeStatement(c *gin.Context) {
	book, ok := h.book(c)
	if !ok {
		return
	}
	periodID, ok := queryUint(c, "period_id", true)
	if !ok {
		return
	}
	period, err := h.period(book.ID, periodID, h.DB, false)
	if err != nil {
		writeError(c, err, "期间不存在")
		return
	}
	totals, err := accountTotals(h.DB, book.ID, *period, "current", true)
	if err != nil {
		writeError(c, err, "读取本期损益发生额失败")
		return
	}
	var accounts []model.Account
	if err := h.DB.Where("account_book_id = ? AND category = ?", book.ID, "损益").Order("code").Find(&accounts).Error; err != nil {
		writeError(c, err, "读取损益科目失败")
		return
	}
	income, expense := decimal.Zero, decimal.Zero
	items := make([]gin.H, 0, len(accounts))
	for _, account := range accounts {
		current := totals[account.ID]
		value := normalBalance(account, current)
		if value.IsZero() {
			continue
		}
		if account.Direction == "C" {
			income = income.Add(value)
		} else {
			expense = expense.Add(value)
		}
		items = append(items, gin.H{
			"account_id": account.ID, "account_code": account.Code,
			"account_name": account.Name, "balance": value.StringFixed(2),
			"direction": account.Direction,
		})
	}
	c.JSON(http.StatusOK, gin.H{
		"period_id": period.ID, "items": items,
		"totals": gin.H{"income": income.StringFixed(2), "expense": expense.StringFixed(2), "profit": income.Sub(expense).StringFixed(2)},
	})
}

func (h *Handler) cashflowStatement(c *gin.Context) {
	book, ok := h.book(c)
	if !ok {
		return
	}
	periodID, ok := queryUint(c, "period_id", true)
	if !ok {
		return
	}
	period, err := h.period(book.ID, periodID, h.DB, false)
	if err != nil {
		writeError(c, err, "期间不存在")
		return
	}
	type cashflowTotal struct {
		Item   *string         `gorm:"column:cashflow_item"`
		Debit  decimal.Decimal `gorm:"column:debit"`
		Credit decimal.Decimal `gorm:"column:credit"`
	}
	var rows []cashflowTotal
	err = h.DB.Table("voucher_entries").
		Select("voucher_entries.cashflow_item, COALESCE(SUM(voucher_entries.debit), 0) AS debit, COALESCE(SUM(voucher_entries.credit), 0) AS credit").
		Joins("JOIN vouchers ON vouchers.id = voucher_entries.voucher_id").
		Joins("JOIN accounts ON accounts.id = voucher_entries.account_id").
		Where("vouchers.account_book_id = ? AND vouchers.period_id = ? AND vouchers.status = ?", book.ID, period.ID, statusPosted).
		Where("(accounts.code LIKE ? OR accounts.code LIKE ? OR accounts.code LIKE ?)", "1001%", "1002%", "1012%").
		Group("voucher_entries.cashflow_item").Order("voucher_entries.cashflow_item").Scan(&rows).Error
	if err != nil {
		writeError(c, err, "生成现金流量表失败")
		return
	}
	unclassified := decimal.Zero
	items := make([]gin.H, 0, len(rows))
	for _, row := range rows {
		itemName := "UNCLASSIFIED"
		if row.Item != nil && strings.TrimSpace(*row.Item) != "" {
			itemName = *row.Item
		} else {
			unclassified = unclassified.Add(row.Debit).Add(row.Credit)
		}
		items = append(items, gin.H{"cashflow_item": itemName, "inflow": row.Debit.StringFixed(2), "outflow": row.Credit.StringFixed(2)})
	}
	c.JSON(http.StatusOK, gin.H{"period_id": period.ID, "items": items, "unclassified_amount": unclassified.StringFixed(2), "ready": unclassified.IsZero()})
}

func (h *Handler) closeCheck(c *gin.Context) {
	book, ok := h.book(c)
	if !ok {
		return
	}
	periodID, ok := queryUint(c, "period_id", true)
	if !ok {
		return
	}
	period, err := h.period(book.ID, periodID, h.DB, false)
	if err != nil {
		writeError(c, err, "期间不存在")
		return
	}
	if period.Status != periodOpen {
		writeError(c, financeErr(http.StatusBadRequest, "F-PERIOD-CLOSED", "只有开放期间可以执行结账检查"), "")
		return
	}
	issues, err := h.closeIssues(h.DB, book.ID, *period)
	if err != nil {
		writeError(c, err, "结账检查失败")
		return
	}
	c.JSON(http.StatusOK, gin.H{"period_id": period.ID, "ready": len(issues) == 0, "issues": issues})
}

func (h *Handler) closeIssues(db *gorm.DB, bookID uint, period model.AccountingPeriod) ([]map[string]string, error) {
	issues := make([]map[string]string, 0)
	var pending, drafts int64
	if err := db.Model(&model.Voucher{}).Where("account_book_id = ? AND period_id = ? AND status = ?", bookID, period.ID, statusPending).Count(&pending).Error; err != nil {
		return nil, err
	}
	if err := db.Model(&model.Voucher{}).Where("account_book_id = ? AND period_id = ? AND status = ?", bookID, period.ID, statusDraft).Count(&drafts).Error; err != nil {
		return nil, err
	}
	if pending > 0 {
		issues = append(issues, map[string]string{"code": "F-UNREVIEWED-VOUCHER", "message": fmt.Sprintf("有 %d 张凭证待审核", pending)})
	}
	if drafts > 0 {
		issues = append(issues, map[string]string{"code": "F-UNPOSTED-VOUCHER", "message": fmt.Sprintf("有 %d 张凭证仍为草稿", drafts)})
	}
	_, openingDebit, openingCredit, err := openingTotals(db, bookID)
	if err != nil {
		return nil, err
	}
	if !openingDebit.Equal(openingCredit) {
		issues = append(issues, map[string]string{"code": "F-OPENING-UNBALANCED", "message": "账套期初余额借贷不平"})
	}
	var vouchers []model.Voucher
	if err := db.Where("account_book_id = ? AND period_id = ?", bookID, period.ID).Order("voucher_no").Find(&vouchers).Error; err != nil {
		return nil, err
	}
	used := map[int]bool{}
	maximum := 0
	for _, voucher := range vouchers {
		number := strings.TrimPrefix(voucher.VoucherNo, "记-")
		value, parseErr := strconv.Atoi(number)
		if parseErr == nil && value > 0 {
			used[value] = true
			if value > maximum {
				maximum = value
			}
		}
		if voucher.Status == statusPosted {
			var entries []model.VoucherEntry
			if err := db.Where("voucher_id = ?", voucher.ID).Find(&entries).Error; err != nil {
				return nil, err
			}
			debit, credit := decimal.Zero, decimal.Zero
			for _, entry := range entries {
				debit = debit.Add(entry.Debit)
				credit = credit.Add(entry.Credit)
			}
			if !debit.Equal(credit) {
				issues = append(issues, map[string]string{"code": "F-UNBALANCED", "message": "凭证 " + voucher.VoucherNo + " 借贷不平"})
			}
		}
	}
	missing := make([]string, 0)
	for value := 1; value <= maximum; value++ {
		if !used[value] {
			missing = append(missing, fmt.Sprintf("记-%04d", value))
		}
	}
	if len(missing) > 0 {
		issues = append(issues, map[string]string{"code": "F-VOUCHER-GAP", "message": "存在断号：" + strings.Join(missing, ", ")})
	}
	var unclassified int64
	if err := db.Table("voucher_entries").
		Joins("JOIN vouchers ON vouchers.id = voucher_entries.voucher_id").
		Joins("JOIN accounts ON accounts.id = voucher_entries.account_id").
		Where("vouchers.account_book_id = ? AND vouchers.period_id = ? AND vouchers.status = ? AND voucher_entries.cashflow_item IS NULL", bookID, period.ID, statusPosted).
		Where("(accounts.code LIKE ? OR accounts.code LIKE ? OR accounts.code LIKE ?)", "1001%", "1002%", "1012%").
		Count(&unclassified).Error; err != nil {
		return nil, err
	}
	if unclassified > 0 {
		issues = append(issues, map[string]string{"code": "F-CASHFLOW-UNCLASSIFIED", "message": "存在未分类现金流分录"})
	}
	return issues, nil
}

func (h *Handler) closeRun(c *gin.Context) {
	user := currentUser(c)
	if user == nil {
		return
	}
	book, ok := h.book(c)
	if !ok {
		return
	}
	periodID, ok := queryUint(c, "period_id", true)
	if !ok {
		return
	}
	var period model.AccountingPeriod
	var closeVoucher *model.Voucher
	err := h.DB.Transaction(func(tx *gorm.DB) error {
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("id = ? AND account_book_id = ?", periodID, book.ID).First(&period).Error; err != nil {
			return err
		}
		if raw := strings.Trim(strings.TrimSpace(c.GetHeader("If-Match")), `"`); raw != "" {
			version, err := strconv.Atoi(raw)
			if err != nil {
				return financeErr(http.StatusBadRequest, "F-PERIOD-CLOSED", "If-Match 必须为期间 version")
			}
			if version != period.Version {
				return financeErr(http.StatusConflict, "F-PERIOD-CLOSED", "期间已被其他请求更新，请刷新后重试")
			}
		}
		if period.Status != periodOpen {
			return financeErr(http.StatusBadRequest, "F-PERIOD-CLOSED", "当前期间不可结账")
		}
		issues, err := h.closeIssues(tx, book.ID, period)
		if err != nil {
			return err
		}
		if len(issues) > 0 {
			return financeErrDetails(http.StatusBadRequest, "F-CLOSE-BLOCKED", "结账前置检查未通过", issues)
		}
		voucher, err := h.createProfitCarryForward(tx, *book, period, user)
		if err != nil {
			return err
		}
		closeVoucher = voucher
		now := timeutil.NowDateTime()
		period.Status, period.Version, period.ClosedBy = periodClosed, period.Version+1, userID(user)
		period.ClosedAt = &now
		if err := tx.Save(&period).Error; err != nil {
			return err
		}
		detail := fmt.Sprintf("period=%04d-%02d", period.Year, period.Month)
		if closeVoucher != nil {
			detail += ",voucher=" + closeVoucher.VoucherNo
		}
		return h.audit(tx, c, user, "close", "accounting_period", period.ID, detail)
	})
	if err != nil {
		writeError(c, err, "正式结账失败")
		return
	}
	response := gin.H{"id": period.ID, "status": period.Status, "version": period.Version}
	if closeVoucher != nil {
		response["voucher_id"] = closeVoucher.ID
		response["voucher_no"] = closeVoucher.VoucherNo
	}
	c.JSON(http.StatusOK, response)
}

func (h *Handler) createProfitCarryForward(tx *gorm.DB, book model.AccountBook, period model.AccountingPeriod, user *model.User) (*model.Voucher, error) {
	var profitAccount model.Account
	if err := tx.Where("account_book_id = ? AND code = ? AND is_active = ? AND is_leaf = ?", book.ID, "3103", true, true).First(&profitAccount).Error; err != nil {
		return nil, financeErr(http.StatusBadRequest, "F-CLOSE-BLOCKED", "未找到可用的本年利润科目")
	}
	totals, err := accountTotals(tx, book.ID, period, "current", true)
	if err != nil {
		return nil, err
	}
	var accounts []model.Account
	if err := tx.Where("account_book_id = ? AND category = ?", book.ID, "损益").Order("code").Find(&accounts).Error; err != nil {
		return nil, err
	}
	lines := make([]model.VoucherEntry, 0)
	for _, account := range accounts {
		net := signedBalance(totals[account.ID])
		if net.IsZero() {
			continue
		}
		if net.Sign() > 0 {
			lines = append(lines,
				model.VoucherEntry{AccountBookID: book.ID, LineNo: len(lines) + 1, AccountID: account.ID, Summary: "结转损益", Credit: net, AuxDetail: "{}"},
				model.VoucherEntry{AccountBookID: book.ID, LineNo: len(lines) + 2, AccountID: profitAccount.ID, Summary: "结转损益", Debit: net, AuxDetail: "{}"},
			)
		} else {
			amount := net.Abs()
			lines = append(lines,
				model.VoucherEntry{AccountBookID: book.ID, LineNo: len(lines) + 1, AccountID: account.ID, Summary: "结转损益", Debit: amount, AuxDetail: "{}"},
				model.VoucherEntry{AccountBookID: book.ID, LineNo: len(lines) + 2, AccountID: profitAccount.ID, Summary: "结转损益", Credit: amount, AuxDetail: "{}"},
			)
		}
	}
	if len(lines) == 0 {
		return nil, nil
	}
	number, err := nextVoucherNumber(tx, book.ID, period.ID, "结-")
	if err != nil {
		return nil, err
	}
	total := decimal.Zero
	for _, line := range lines {
		total = total.Add(line.Debit)
	}
	voucher := &model.Voucher{
		AccountBookID: book.ID, PeriodID: period.ID, VoucherNo: number,
		VoucherDate: period.EndDate, Status: statusPosted, Source: "auto-close",
		Summary: "结转损益", TotalDebit: total, TotalCredit: total,
		CreatedBy: userID(user), ReviewedBy: userID(user), PostedBy: userID(user),
		CreatedAt: timeutil.NowDateTime(), UpdatedAt: timeutil.NowDateTime(),
	}
	if err := tx.Create(voucher).Error; err != nil {
		return nil, err
	}
	for index := range lines {
		lines[index].VoucherID = voucher.ID
	}
	if err := tx.Create(&lines).Error; err != nil {
		return nil, err
	}
	if err := updateAccountBalance(tx, *voucher); err != nil {
		return nil, err
	}
	return voucher, nil
}

func nextVoucherNumber(tx *gorm.DB, bookID, periodID uint, prefix string) (string, error) {
	var rows []model.Voucher
	if err := tx.Select("voucher_no").Where("account_book_id = ? AND period_id = ?", bookID, periodID).Find(&rows).Error; err != nil {
		return "", err
	}
	used := make(map[string]bool, len(rows))
	maximum := 0
	for _, row := range rows {
		used[row.VoucherNo] = true
		if strings.HasPrefix(row.VoucherNo, prefix) {
			number, err := strconv.Atoi(strings.TrimPrefix(row.VoucherNo, prefix))
			if err == nil && number > maximum {
				maximum = number
			}
		}
	}
	for number := maximum + 1; ; number++ {
		candidate := fmt.Sprintf("%s%04d", prefix, number)
		if !used[candidate] {
			return candidate, nil
		}
	}
}

type closeReverseInput struct {
	Confirm bool `json:"confirm"`
}

func (h *Handler) closeReverse(c *gin.Context) {
	user := currentUser(c)
	if user == nil {
		return
	}
	book, ok := h.book(c)
	if !ok {
		return
	}
	periodID, ok := queryUint(c, "period_id", true)
	if !ok {
		return
	}
	confirmed := strings.EqualFold(c.Query("confirm"), "true")
	if c.Request.ContentLength != 0 {
		var input closeReverseInput
		if err := c.ShouldBindJSON(&input); err == nil && input.Confirm {
			confirmed = true
		}
	}
	if !confirmed {
		writeError(c, financeErr(http.StatusBadRequest, "F-PERIOD-CLOSED", "反结账必须二次确认"), "")
		return
	}
	var period model.AccountingPeriod
	var reversal *model.Voucher
	err := h.DB.Transaction(func(tx *gorm.DB) error {
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("id = ? AND account_book_id = ?", periodID, book.ID).First(&period).Error; err != nil {
			return err
		}
		if raw := strings.Trim(strings.TrimSpace(c.GetHeader("If-Match")), `"`); raw != "" {
			version, err := strconv.Atoi(raw)
			if err != nil {
				return financeErr(http.StatusBadRequest, "F-PERIOD-CLOSED", "If-Match 必须为期间 version")
			}
			if version != period.Version {
				return financeErr(http.StatusConflict, "F-PERIOD-CLOSED", "期间已被其他请求更新，请刷新后重试")
			}
		}
		if period.Status != periodClosed {
			return financeErr(http.StatusBadRequest, "F-PERIOD-CLOSED", "只有已结账期间可以反结账")
		}
		var later model.AccountingPeriod
		err := tx.Where("account_book_id = ? AND period_index > ? AND status <> ?", book.ID, period.PeriodIndex, periodOpen).Order("period_index").First(&later).Error
		if err == nil {
			return financeErr(http.StatusBadRequest, "F-REVERSE-ORDER", "反结账必须按期间倒序执行")
		}
		if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
			return err
		}
		var closeVoucher model.Voucher
		err = tx.Where("account_book_id = ? AND period_id = ? AND source = ? AND status = ?", book.ID, period.ID, "auto-close", statusPosted).Order("id DESC").First(&closeVoucher).Error
		if err == nil {
			var duplicate int64
			if err := tx.Model(&model.Voucher{}).Where("account_book_id = ? AND source = ? AND reversal_of = ? AND status = ?", book.ID, "auto-reopen", closeVoucher.ID, statusPosted).Count(&duplicate).Error; err != nil {
				return err
			}
			if duplicate > 0 {
				return financeErr(http.StatusConflict, "F-PERIOD-CLOSED", "该期间的结转已反冲")
			}
			var entries []model.VoucherEntry
			if err := tx.Where("voucher_id = ?", closeVoucher.ID).Order("line_no").Find(&entries).Error; err != nil {
				return err
			}
			number, err := nextVoucherNumber(tx, book.ID, period.ID, "反结-")
			if err != nil {
				return err
			}
			row := &model.Voucher{
				AccountBookID: book.ID, PeriodID: period.ID, VoucherNo: number,
				VoucherDate: period.EndDate, Status: statusPosted, Source: "auto-reopen",
				Summary: "反结账冲回结转损益", TotalDebit: closeVoucher.TotalDebit,
				TotalCredit: closeVoucher.TotalCredit, CreatedBy: userID(user),
				ReviewedBy: userID(user), PostedBy: userID(user), ReversalOf: &closeVoucher.ID,
				CreatedAt: timeutil.NowDateTime(), UpdatedAt: timeutil.NowDateTime(),
			}
			if err := tx.Create(row).Error; err != nil {
				return err
			}
			for _, entry := range entries {
				reverseEntry := model.VoucherEntry{
					AccountBookID: book.ID, VoucherID: row.ID, LineNo: entry.LineNo,
					AccountID: entry.AccountID, Summary: entry.Summary,
					Debit: entry.Credit, Credit: entry.Debit,
					AuxDetail: entry.AuxDetail, CashflowItem: entry.CashflowItem,
				}
				if err := tx.Create(&reverseEntry).Error; err != nil {
					return err
				}
			}
			if err := updateAccountBalance(tx, *row); err != nil {
				return err
			}
			reversal = row
		} else if !errors.Is(err, gorm.ErrRecordNotFound) {
			return err
		}
		period.Status, period.Version, period.ClosedBy, period.ClosedAt = periodOpen, period.Version+1, nil, nil
		if err := tx.Save(&period).Error; err != nil {
			return err
		}
		detail := fmt.Sprintf("period=%04d-%02d", period.Year, period.Month)
		if reversal != nil {
			detail += ",voucher=" + reversal.VoucherNo
		}
		return h.audit(tx, c, user, "reopen", "accounting_period", period.ID, detail)
	})
	if err != nil {
		writeError(c, err, "反结账失败")
		return
	}
	result := gin.H{"id": period.ID, "status": period.Status, "version": period.Version}
	if reversal != nil {
		result["voucher_id"], result["voucher_no"] = reversal.ID, reversal.VoucherNo
	}
	c.JSON(http.StatusOK, result)
}
