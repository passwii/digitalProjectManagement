package finance

import (
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"digitalprojectmanagement/api/internal/model"
	"digitalprojectmanagement/api/pkg/audit"
	"digitalprojectmanagement/api/pkg/timeutil"
	"github.com/gin-gonic/gin"
	"github.com/shopspring/decimal"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

var bankImportHeaders = []string{"流水号", "交易日期", "方向", "金额", "银行账户", "摘要", "对方"}

type cashTransactionInput struct {
	PeriodID        uint            `json:"period_id" binding:"required"`
	Kind            string          `json:"kind" binding:"required"`
	TransactionDate timeutil.Date   `json:"transaction_date" binding:"required"`
	Amount          decimal.Decimal `json:"amount"`
	AccountID       uint            `json:"account_id" binding:"required"`
	OffsetAccountID uint            `json:"offset_account_id" binding:"required"`
	Summary         string          `json:"summary"`
	Counterparty    string          `json:"counterparty"`
	CashflowItem    *string         `json:"cashflow_item"`
}

type fixedAssetInput struct {
	Code                  string          `json:"code" binding:"required,max=64"`
	Name                  string          `json:"name" binding:"required,max=128"`
	Category              string          `json:"category"`
	AcquisitionDate       timeutil.Date   `json:"acquisition_date" binding:"required"`
	OriginalCost          decimal.Decimal `json:"original_cost"`
	ResidualRate          decimal.Decimal `json:"residual_rate"`
	UsefulLifeMonths      int             `json:"useful_life_months" binding:"required"`
	AssetAccountID        uint            `json:"asset_account_id" binding:"required"`
	DepreciationAccountID uint            `json:"depreciation_account_id" binding:"required"`
	ExpenseAccountID      uint            `json:"expense_account_id" binding:"required"`
}

type bankMatchInput struct {
	VoucherID uint `json:"voucher_id" binding:"required"`
}

func (h *Handler) createCashTransaction(c *gin.Context) {
	user := currentUser(c)
	if user == nil {
		return
	}
	book, ok := h.book(c)
	if !ok {
		return
	}
	var input cashTransactionInput
	if !bindJSON(c, &input) {
		return
	}
	input.Kind = strings.TrimSpace(input.Kind)
	if input.Kind != "receipt" && input.Kind != "payment" && input.Kind != "expense" {
		badRequest(c, "kind 必须为 receipt、payment 或 expense")
		return
	}
	amount, err := parseMoney(input.Amount, "金额")
	if err != nil || amount.Sign() <= 0 {
		if err != nil {
			writeError(c, err, "金额无效")
		} else {
			badRequest(c, "金额必须大于 0")
		}
		return
	}
	var transaction model.CashTransaction
	var voucher model.Voucher
	err = h.DB.Transaction(func(tx *gorm.DB) error {
		period, err := h.period(book.ID, input.PeriodID, tx, true)
		if err != nil {
			return err
		}
		if err := ensureOpen(period); err != nil {
			return err
		}
		if input.TransactionDate.IsZero() || input.TransactionDate.Before(period.StartDate.Time) || input.TransactionDate.After(period.EndDate.Time) {
			return financeErr(http.StatusBadRequest, "F-PERIOD-CLOSED", "交易日期不在所属期间")
		}
		var cashAccount, offsetAccount model.Account
		if err := tx.Where("id = ? AND account_book_id = ? AND is_active = ? AND is_leaf = ?", input.AccountID, book.ID, true, true).First(&cashAccount).Error; err != nil {
			return financeErr(http.StatusBadRequest, "F-ACCT-INACTIVE", "资金科目必须是当前账套启用的末级科目")
		}
		if !strings.HasPrefix(cashAccount.Code, "1001") && !strings.HasPrefix(cashAccount.Code, "1002") && !strings.HasPrefix(cashAccount.Code, "1012") {
			return financeErr(http.StatusBadRequest, "F-ACCT-INACTIVE", "资金科目编码须属于现金、银行存款或其他货币资金")
		}
		if err := tx.Where("id = ? AND account_book_id = ? AND is_active = ? AND is_leaf = ?", input.OffsetAccountID, book.ID, true, true).First(&offsetAccount).Error; err != nil {
			return financeErr(http.StatusBadRequest, "F-ACCT-INACTIVE", "对方科目必须是当前账套启用的末级科目")
		}
		lines := make([]entryInput, 2)
		summary := strings.TrimSpace(input.Summary)
		if input.Kind == "receipt" {
			lines[0] = entryInput{AccountID: cashAccount.ID, Summary: summary, Debit: amount, AuxDetail: map[string]any{}, CashflowItem: input.CashflowItem}
			lines[1] = entryInput{AccountID: offsetAccount.ID, Summary: summary, Credit: amount, AuxDetail: map[string]any{}}
		} else {
			lines[0] = entryInput{AccountID: offsetAccount.ID, Summary: summary, Debit: amount, AuxDetail: map[string]any{}}
			lines[1] = entryInput{AccountID: cashAccount.ID, Summary: summary, Credit: amount, AuxDetail: map[string]any{}, CashflowItem: input.CashflowItem}
		}
		now := timeutil.AppNow()
		voucherNo := fmt.Sprintf("cash-%d", now.UnixNano())
		payload := voucherInput{
			PeriodID: period.ID, VoucherNo: voucherNo, VoucherDate: input.TransactionDate,
			Summary: summary, Source: "cash", Lines: lines,
		}
		created, err := h.createDraftVoucher(tx, *book, user, payload, "cash", nil)
		if err != nil {
			return err
		}
		voucher = *created
		transaction = model.CashTransaction{
			AccountBookID: book.ID, PeriodID: period.ID, Kind: input.Kind,
			TransactionDate: input.TransactionDate, Amount: amount, AccountID: cashAccount.ID,
			OffsetAccountID: offsetAccount.ID, Summary: summary,
			Counterparty: strings.TrimSpace(input.Counterparty), CashflowItem: input.CashflowItem,
			Status: statusDraft, VoucherID: &voucher.ID, CreatedBy: userID(user),
			CreatedAt: timeutil.NowDateTime(),
		}
		if err := tx.Create(&transaction).Error; err != nil {
			return err
		}
		return audit.CommitAudited(tx, userID(user), "create_cash_transaction", "cash_transaction", strconv.FormatUint(uint64(transaction.ID), 10), fmt.Sprintf("voucher=%d", voucher.ID), c.ClientIP())
	})
	if err != nil {
		writeError(c, err, "录入现金流水失败")
		return
	}
	voucherJSON, err := h.voucherJSON(h.DB, voucher)
	if err != nil {
		writeError(c, err, "读取自动生成凭证失败")
		return
	}
	c.JSON(http.StatusCreated, gin.H{
		"id": transaction.ID, "kind": transaction.Kind, "status": transaction.Status,
		"amount": transaction.Amount.StringFixed(2), "voucher": voucherJSON,
	})
}

func assetJSON(asset model.FixedAsset) gin.H {
	return gin.H{
		"id": asset.ID, "code": asset.Code, "name": asset.Name, "category": asset.Category,
		"acquisition_date": asset.AcquisitionDate, "original_cost": asset.OriginalCost.StringFixed(2),
		"residual_rate": asset.ResidualRate.String(), "useful_life_months": asset.UsefulLifeMonths,
		"accumulated_depreciation": asset.AccumulatedDepreciation.StringFixed(2),
		"net_book_value":           asset.OriginalCost.Sub(asset.AccumulatedDepreciation).StringFixed(2),
		"status":                   asset.Status,
	}
}

func (h *Handler) listFixedAssets(c *gin.Context) {
	book, ok := h.book(c)
	if !ok {
		return
	}
	var rows []model.FixedAsset
	if err := h.DB.Where("account_book_id = ?", book.ID).Order("code").Find(&rows).Error; err != nil {
		writeError(c, err, "读取固定资产失败")
		return
	}
	items := make([]gin.H, 0, len(rows))
	for _, row := range rows {
		items = append(items, assetJSON(row))
	}
	c.JSON(http.StatusOK, gin.H{"total": len(items), "items": items})
}

func (h *Handler) createFixedAsset(c *gin.Context) {
	user := currentUser(c)
	if user == nil {
		return
	}
	book, ok := h.book(c)
	if !ok {
		return
	}
	var input fixedAssetInput
	if !bindJSON(c, &input) {
		return
	}
	input.Code, input.Name = strings.TrimSpace(input.Code), strings.TrimSpace(input.Name)
	if input.Code == "" || input.Name == "" || input.AcquisitionDate.IsZero() || input.UsefulLifeMonths <= 0 {
		badRequest(c, "资产编码、名称、购置日期和使用年限必须有效")
		return
	}
	cost, err := parseMoney(input.OriginalCost, "原值")
	if err != nil || cost.Sign() <= 0 {
		if err != nil {
			writeError(c, err, "固定资产原值无效")
		} else {
			badRequest(c, "固定资产原值必须大于 0")
		}
		return
	}
	if input.ResidualRate.IsNegative() || input.ResidualRate.Cmp(decimal.NewFromInt(1)) >= 0 {
		writeError(c, financeErr(http.StatusBadRequest, "F-ASSET-INVALID", "残值率必须在 0 到 1 之间"), "")
		return
	}
	var asset model.FixedAsset
	err = h.DB.Transaction(func(tx *gorm.DB) error {
		ids := []uint{input.AssetAccountID, input.DepreciationAccountID, input.ExpenseAccountID}
		var accounts []model.Account
		if err := tx.Where("account_book_id = ? AND is_active = ? AND is_leaf = ? AND id IN ?", book.ID, true, true, ids).Find(&accounts).Error; err != nil {
			return err
		}
		if len(accounts) != 3 {
			return financeErr(http.StatusBadRequest, "F-ASSET-INVALID", "固定资产科目必须是当前账套启用的末级科目")
		}
		var count int64
		if err := tx.Model(&model.FixedAsset{}).Where("account_book_id = ? AND code = ?", book.ID, input.Code).Count(&count).Error; err != nil {
			return err
		}
		if count > 0 {
			return financeErr(http.StatusConflict, "F-ASSET-DUPLICATE", "资产编码已存在")
		}
		asset = model.FixedAsset{
			AccountBookID: book.ID, Code: input.Code, Name: input.Name,
			Category: strings.TrimSpace(input.Category), AcquisitionDate: input.AcquisitionDate,
			OriginalCost: cost, ResidualRate: input.ResidualRate,
			UsefulLifeMonths: input.UsefulLifeMonths, AssetAccountID: input.AssetAccountID,
			DepreciationAccountID: input.DepreciationAccountID, ExpenseAccountID: input.ExpenseAccountID,
			AccumulatedDepreciation: decimal.Zero, Status: "active", CreatedBy: userID(user),
			CreatedAt: timeutil.NowDateTime(),
		}
		if err := tx.Create(&asset).Error; err != nil {
			return err
		}
		return audit.CommitAudited(tx, userID(user), "create_fixed_asset", "fixed_asset", asset.Code, book.Code, c.ClientIP())
	})
	if err != nil {
		writeError(c, err, "创建固定资产失败")
		return
	}
	c.JSON(http.StatusCreated, assetJSON(asset))
}

func (h *Handler) depreciateFixedAssets(c *gin.Context) {
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
	type createdDepreciation struct {
		asset   model.FixedAsset
		voucher model.Voucher
		amount  decimal.Decimal
	}
	generated := make([]createdDepreciation, 0)
	total := decimal.Zero
	err := h.DB.Transaction(func(tx *gorm.DB) error {
		period, err := h.period(book.ID, periodID, tx, true)
		if err != nil {
			return err
		}
		if err := ensureOpen(period); err != nil {
			return err
		}
		var assets []model.FixedAsset
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("account_book_id = ? AND status = ?", book.ID, "active").Order("id").Find(&assets).Error; err != nil {
			return err
		}
		for _, asset := range assets {
			if !asset.AcquisitionDate.Before(period.StartDate.Time) {
				continue
			}
			var existing int64
			if err := tx.Model(&model.AssetDepreciation{}).Where("account_book_id = ? AND asset_id = ? AND period_id = ?", book.ID, asset.ID, period.ID).Count(&existing).Error; err != nil {
				return err
			}
			if existing > 0 {
				continue
			}
			depreciable := asset.OriginalCost.Mul(decimal.NewFromInt(1).Sub(asset.ResidualRate))
			monthly := depreciable.Div(decimal.NewFromInt(int64(asset.UsefulLifeMonths))).Round(2)
			remaining := depreciable.Sub(asset.AccumulatedDepreciation)
			if remaining.Sign() <= 0 {
				continue
			}
			amount := monthly
			if amount.GreaterThan(remaining) {
				amount = remaining
			}
			if amount.Sign() <= 0 {
				continue
			}
			voucherNo := fmt.Sprintf("折旧-%s-%04d%02d", asset.Code, period.Year, period.Month)
			lines := []entryInput{
				{AccountID: asset.ExpenseAccountID, Summary: asset.Name + "折旧", Debit: amount, AuxDetail: map[string]any{"dept": "fixed-assets"}},
				{AccountID: asset.DepreciationAccountID, Summary: asset.Name + "折旧", Credit: amount, AuxDetail: map[string]any{}},
			}
			payload := voucherInput{
				PeriodID: period.ID, VoucherNo: voucherNo, VoucherDate: period.EndDate,
				Summary: "计提" + asset.Name + "折旧", Source: "auto-asset", Lines: lines,
			}
			voucher, err := h.createDraftVoucher(tx, *book, user, payload, "auto-asset", nil)
			if err != nil {
				return err
			}
			voucher.Status, voucher.ReviewedBy, voucher.PostedBy = statusPosted, userID(user), userID(user)
			voucher.UpdatedAt = timeutil.NowDateTime()
			if err := tx.Save(voucher).Error; err != nil {
				return err
			}
			if err := updateAccountBalance(tx, *voucher); err != nil {
				return err
			}
			depreciation := model.AssetDepreciation{
				AccountBookID: book.ID, PeriodID: period.ID, AssetID: asset.ID,
				Amount: amount, VoucherID: &voucher.ID, CreatedBy: userID(user),
				CreatedAt: timeutil.NowDateTime(),
			}
			if err := tx.Create(&depreciation).Error; err != nil {
				return err
			}
			asset.AccumulatedDepreciation = asset.AccumulatedDepreciation.Add(amount)
			if err := tx.Model(&model.FixedAsset{}).Where("id = ? AND account_book_id = ?", asset.ID, book.ID).Update("accumulated_depreciation", asset.AccumulatedDepreciation).Error; err != nil {
				return err
			}
			total = total.Add(amount)
			generated = append(generated, createdDepreciation{asset: asset, voucher: *voucher, amount: amount})
		}
		return audit.CommitAudited(tx, userID(user), "depreciate_fixed_assets", "fixed_assets", strconv.FormatUint(uint64(period.ID), 10), fmt.Sprintf("count=%d,amount=%s", len(generated), total.StringFixed(2)), c.ClientIP())
	})
	if err != nil {
		writeError(c, err, "固定资产折旧失败")
		return
	}
	items := make([]gin.H, 0, len(generated))
	for _, item := range generated {
		items = append(items, gin.H{"id": item.voucher.ID, "asset_id": item.asset.ID, "amount": item.amount.StringFixed(2), "source": item.voucher.Source, "status": item.voucher.Status})
	}
	c.JSON(http.StatusOK, gin.H{"period_id": periodID, "depreciated": len(items), "total_amount": total.StringFixed(2), "vouchers": items})
}

func parseBankStatementRows(rows [][]string) ([]model.BankStatement, []map[string]string) {
	if len(rows) == 0 || len(rows[0]) < len(bankImportHeaders) {
		return nil, []map[string]string{{"row": "1", "reason": "银行流水表头不符合模板"}}
	}
	for index, header := range bankImportHeaders {
		if strings.TrimSpace(rows[0][index]) != header {
			return nil, []map[string]string{{"row": "1", "reason": "表头必须为：" + strings.Join(bankImportHeaders, "、")}}
		}
	}
	statements := make([]model.BankStatement, 0)
	details := make([]map[string]string, 0)
	seen := map[string]bool{}
	for index, raw := range rows[1:] {
		rowNumber := strconv.Itoa(index + 2)
		values := append([]string(nil), raw...)
		for len(values) < len(bankImportHeaders) {
			values = append(values, "")
		}
		if strings.TrimSpace(strings.Join(values[:len(bankImportHeaders)], "")) == "" {
			continue
		}
		externalID := strings.TrimSpace(values[0])
		if externalID == "" {
			details = append(details, map[string]string{"row": rowNumber, "reason": "流水号不能为空"})
			continue
		}
		if seen[externalID] {
			details = append(details, map[string]string{"row": rowNumber, "reason": "文件内流水号重复：" + externalID})
			continue
		}
		seen[externalID] = true
		date, err := parseDateCell(values[1])
		if err != nil {
			details = append(details, map[string]string{"row": rowNumber, "reason": err.Error()})
			continue
		}
		direction := strings.TrimSpace(values[2])
		if direction == "流入" {
			direction = "inflow"
		} else if direction == "流出" {
			direction = "outflow"
		}
		if direction != "inflow" && direction != "outflow" {
			details = append(details, map[string]string{"row": rowNumber, "reason": "方向必须为流入或流出"})
			continue
		}
		amount, err := decimal.NewFromString(strings.ReplaceAll(strings.TrimSpace(values[3]), ",", ""))
		if err != nil || amount.Sign() <= 0 || !amount.Equal(amount.Truncate(2)) {
			details = append(details, map[string]string{"row": rowNumber, "reason": "金额必须为大于 0 且最多精确到分的数字"})
			continue
		}
		statements = append(statements, model.BankStatement{
			ExternalID: externalID, TransactionDate: date, Direction: direction,
			Amount: amount, AccountCode: strings.TrimSpace(values[4]),
			Summary: strings.TrimSpace(values[5]), Counterparty: strings.TrimSpace(values[6]),
			Status: "unmatched",
		})
	}
	return statements, details
}

func (h *Handler) importBankStatements(c *gin.Context) {
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
	rows, ok := uploadRows(c, "file")
	if !ok {
		return
	}
	statements, details := parseBankStatementRows(rows)
	if len(details) > 0 {
		writeError(c, financeErrDetails(http.StatusBadRequest, "F-IMPORT-INVALID", "银行流水导入校验失败，未写入任何流水", details), "")
		return
	}
	if len(statements) == 0 {
		badRequest(c, "导入文件没有银行流水数据")
		return
	}
	err := h.DB.Transaction(func(tx *gorm.DB) error {
		period, err := h.period(book.ID, periodID, tx, true)
		if err != nil {
			return err
		}
		if err := ensureOpen(period); err != nil {
			return err
		}
		for index := range statements {
			row := &statements[index]
			if row.TransactionDate.Before(period.StartDate.Time) || row.TransactionDate.After(period.EndDate.Time) {
				return financeErrDetails(http.StatusBadRequest, "F-IMPORT-INVALID", "银行流水日期不属于指定期间", []map[string]string{{"row": strconv.Itoa(index + 2), "reason": "交易日期不在所属期间"}})
			}
			var count int64
			if err := tx.Model(&model.BankStatement{}).Where("account_book_id = ? AND external_id = ?", book.ID, row.ExternalID).Count(&count).Error; err != nil {
				return err
			}
			if count > 0 {
				return financeErr(http.StatusConflict, "F-IMPORT-DUPLICATE", "流水号已存在："+row.ExternalID)
			}
			row.AccountBookID, row.PeriodID = book.ID, period.ID
			row.CreatedBy, row.CreatedAt = userID(user), timeutil.NowDateTime()
		}
		if err := tx.Create(&statements).Error; err != nil {
			return err
		}
		return audit.CommitAudited(tx, userID(user), "import_bank_statements", "bank_statements", strconv.FormatUint(uint64(periodID), 10), fmt.Sprintf("count=%d", len(statements)), c.ClientIP())
	})
	if err != nil {
		writeError(c, err, "银行流水导入失败，未写入任何流水")
		return
	}
	items := make([]gin.H, 0, len(statements))
	for _, row := range statements {
		items = append(items, gin.H{"id": row.ID, "external_id": row.ExternalID, "status": row.Status, "amount": row.Amount.StringFixed(2), "direction": row.Direction})
	}
	c.JSON(http.StatusOK, gin.H{"imported": len(items), "items": items})
}

func (h *Handler) listBankStatements(c *gin.Context) {
	book, ok := h.book(c)
	if !ok {
		return
	}
	query := h.DB.Where("account_book_id = ?", book.ID)
	if periodID, ok := queryUint(c, "period_id", false); !ok {
		return
	} else if periodID > 0 {
		query = query.Where("period_id = ?", periodID)
	}
	var rows []model.BankStatement
	if err := query.Order("transaction_date DESC, id DESC").Find(&rows).Error; err != nil {
		writeError(c, err, "读取银行流水失败")
		return
	}
	items := make([]gin.H, 0, len(rows))
	for _, row := range rows {
		items = append(items, gin.H{
			"id": row.ID, "external_id": row.ExternalID, "transaction_date": row.TransactionDate,
			"direction": row.Direction, "amount": row.Amount.StringFixed(2), "account_code": row.AccountCode,
			"summary": row.Summary, "counterparty": row.Counterparty, "status": row.Status,
			"matched_voucher_id": row.MatchedVoucherID,
		})
	}
	c.JSON(http.StatusOK, gin.H{"total": len(items), "items": items})
}

func (h *Handler) matchBankStatement(c *gin.Context) {
	user := currentUser(c)
	if user == nil {
		return
	}
	book, ok := h.book(c)
	if !ok {
		return
	}
	id, ok := parseID(c, "statement_id")
	if !ok {
		return
	}
	var input bankMatchInput
	if !bindJSON(c, &input) {
		return
	}
	var statement model.BankStatement
	err := h.DB.Transaction(func(tx *gorm.DB) error {
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("id = ? AND account_book_id = ?", id, book.ID).First(&statement).Error; err != nil {
			return err
		}
		if statement.Status != "unmatched" {
			return financeErr(http.StatusConflict, "F-BANK-STATEMENT-STATE", "只有未匹配的银行流水可以匹配")
		}
		var voucher model.Voucher
		if err := tx.Where("id = ? AND account_book_id = ? AND period_id = ? AND status = ?", input.VoucherID, book.ID, statement.PeriodID, statusPosted).First(&voucher).Error; err != nil {
			return financeErr(http.StatusBadRequest, "F-BANK-MATCH-INVALID", "只能匹配当前账套当前期间的已过账凭证")
		}
		var entries []model.VoucherEntry
		if err := tx.Where("voucher_id = ? AND account_book_id = ?", voucher.ID, book.ID).Find(&entries).Error; err != nil {
			return err
		}
		var cashAmount decimal.Decimal
		for _, entry := range entries {
			var account model.Account
			if err := tx.Where("id = ? AND account_book_id = ?", entry.AccountID, book.ID).First(&account).Error; err != nil {
				return err
			}
			isCash := strings.HasPrefix(account.Code, "1001") || strings.HasPrefix(account.Code, "1002") || strings.HasPrefix(account.Code, "1012")
			if !isCash || (statement.AccountCode != "" && account.Code != statement.AccountCode) || entry.CashflowItem == nil {
				continue
			}
			if statement.Direction == "inflow" {
				cashAmount = cashAmount.Add(entry.Debit)
			} else {
				cashAmount = cashAmount.Add(entry.Credit)
			}
		}
		if !cashAmount.Equal(statement.Amount) {
			return financeErr(http.StatusBadRequest, "F-BANK-MATCH-INVALID", "银行流水金额与凭证现金金额不一致")
		}
		now := timeutil.NowDateTime()
		statement.Status, statement.MatchedVoucherID = "matched", &voucher.ID
		statement.MatchedBy, statement.MatchedAt = userID(user), &now
		if err := tx.Save(&statement).Error; err != nil {
			return err
		}
		return audit.CommitAudited(tx, userID(user), "match_bank_statement", "bank_statement", strconv.FormatUint(uint64(statement.ID), 10), fmt.Sprintf("voucher=%d", voucher.ID), c.ClientIP())
	})
	if err != nil {
		writeError(c, err, "银行流水匹配失败")
		return
	}
	c.JSON(http.StatusOK, gin.H{"id": statement.ID, "status": statement.Status, "matched_voucher_id": statement.MatchedVoucherID})
}

func (h *Handler) bankReconciliation(c *gin.Context) {
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
	var statements []model.BankStatement
	if err := h.DB.Where("account_book_id = ? AND period_id = ?", book.ID, period.ID).Order("transaction_date, id").Find(&statements).Error; err != nil {
		writeError(c, err, "读取银行流水失败")
		return
	}
	bankMovement, unmatchedMovement := decimal.Zero, decimal.Zero
	unmatchedCount := 0
	items := make([]gin.H, 0, len(statements))
	for _, row := range statements {
		signed := row.Amount
		if row.Direction == "outflow" {
			signed = signed.Neg()
		}
		bankMovement = bankMovement.Add(signed)
		if row.Status == "unmatched" {
			unmatchedCount++
			unmatchedMovement = unmatchedMovement.Add(signed)
		}
		items = append(items, gin.H{"id": row.ID, "external_id": row.ExternalID, "amount": row.Amount.StringFixed(2), "direction": row.Direction, "status": row.Status})
	}
	var bankAccounts []model.Account
	if err := h.DB.Where("account_book_id = ? AND (code LIKE ? OR code LIKE ? OR code LIKE ?)", book.ID, "1001%", "1002%", "1012%").Find(&bankAccounts).Error; err != nil {
		writeError(c, err, "读取资金科目失败")
		return
	}
	accountIDs := make([]uint, 0, len(bankAccounts))
	for _, account := range bankAccounts {
		accountIDs = append(accountIDs, account.ID)
	}
	bookMovement := decimal.Zero
	if len(accountIDs) > 0 {
		var entries []model.VoucherEntry
		err := h.DB.Table("voucher_entries").
			Select("voucher_entries.debit, voucher_entries.credit").
			Joins("JOIN vouchers ON vouchers.id = voucher_entries.voucher_id").
			Where("vouchers.account_book_id = ? AND vouchers.period_id = ? AND vouchers.status = ? AND voucher_entries.account_id IN ?", book.ID, period.ID, statusPosted, accountIDs).
			Find(&entries).Error
		if err != nil {
			writeError(c, err, "读取账面资金发生额失败")
			return
		}
		for _, entry := range entries {
			bookMovement = bookMovement.Add(entry.Debit).Sub(entry.Credit)
		}
	}
	c.JSON(http.StatusOK, gin.H{
		"period_id": period.ID, "statement_movement": bankMovement.StringFixed(2),
		"book_movement": bookMovement.StringFixed(2), "difference": bankMovement.Sub(bookMovement).StringFixed(2),
		"unmatched_count": unmatchedCount, "unmatched_amount": unmatchedMovement.StringFixed(2), "items": items,
	})
}
