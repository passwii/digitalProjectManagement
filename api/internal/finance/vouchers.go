package finance

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"digitalprojectmanagement/api/internal/model"
	"digitalprojectmanagement/api/internal/rbac"
	"digitalprojectmanagement/api/pkg/audit"
	"digitalprojectmanagement/api/pkg/excel"
	"digitalprojectmanagement/api/pkg/paging"
	"digitalprojectmanagement/api/pkg/timeutil"
	"github.com/gin-gonic/gin"
	"github.com/shopspring/decimal"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

var (
	externalVoucherSources = map[string]bool{"manual": true, "template": true, "import": true}
	internalVoucherSources = map[string]bool{
		"manual": true, "template": true, "import": true, "cash": true,
		"auto-close": true, "auto-reopen": true, "reversal": true,
		"auto-asset": true, "project-expense": true,
	}
	importVoucherHeaders = []string{"凭证号", "凭证日期", "摘要", "科目编码", "分录摘要", "借方", "贷方", "现金流项目", "辅助核算JSON"}
)

type voucherInput struct {
	PeriodID    uint          `json:"period_id" binding:"required"`
	VoucherNo   string        `json:"voucher_no" binding:"required,max=32"`
	VoucherDate timeutil.Date `json:"voucher_date" binding:"required"`
	Summary     string        `json:"summary"`
	Source      string        `json:"source"`
	Lines       []entryInput  `json:"lines" binding:"required,min=2"`
}

type voucherPatchInput struct {
	PeriodID    *uint          `json:"period_id"`
	VoucherNo   *string        `json:"voucher_no"`
	VoucherDate *timeutil.Date `json:"voucher_date"`
	Summary     *string        `json:"summary"`
	Lines       *[]entryInput  `json:"lines"`
}

type reasonInput struct {
	Reason string `json:"reason"`
}

type templateInput struct {
	Code  string       `json:"code" binding:"required,max=32"`
	Name  string       `json:"name" binding:"required,max=128"`
	Lines []entryInput `json:"lines" binding:"required,min=2"`
}

type fromTemplateInput struct {
	TemplateID  uint          `json:"template_id" binding:"required"`
	PeriodID    uint          `json:"period_id" binding:"required"`
	VoucherNo   string        `json:"voucher_no" binding:"required,max=32"`
	VoucherDate timeutil.Date `json:"voucher_date" binding:"required"`
	Summary     string        `json:"summary"`
}

type projectExpenseVoucherInput struct {
	PeriodID    uint          `json:"period_id" binding:"required"`
	VoucherDate timeutil.Date `json:"voucher_date" binding:"required"`
	Summary     string        `json:"summary"`
	Debit       entryInput    `json:"debit"`
	Credit      entryInput    `json:"credit"`
}

func parseAuxiliaryID(value any) (uint, bool) {
	switch item := value.(type) {
	case string:
		parsed, err := strconv.ParseUint(strings.TrimSpace(item), 10, 64)
		return uint(parsed), err == nil && parsed > 0
	case json.Number:
		parsed, err := item.Int64()
		return uint(parsed), err == nil && parsed > 0
	case float64:
		if item <= 0 || item != float64(uint64(item)) {
			return 0, false
		}
		return uint(item), true
	case int:
		return uint(item), item > 0
	case int64:
		return uint(item), item > 0
	case uint:
		return item, item > 0
	default:
		return 0, false
	}
}

func parseDateCell(value string) (timeutil.Date, error) {
	text := strings.TrimSpace(value)
	if text == "" {
		return timeutil.Date{}, fmt.Errorf("凭证日期不能为空")
	}
	for _, layout := range []string{"2006-01-02", "2006/01/02", "2006/1/2", time.RFC3339, "2006-01-02 15:04:05"} {
		if parsed, err := time.ParseInLocation(layout, text, timeutil.Loc); err == nil {
			return timeutil.NewDate(parsed), nil
		}
	}
	return timeutil.Date{}, fmt.Errorf("日期格式错误，请填 YYYY-MM-DD")
}

func entryJSON(entry model.VoucherEntry, account *model.Account) gin.H {
	aux := map[string]any{}
	_ = json.Unmarshal([]byte(entry.AuxDetail), &aux)
	accountCode, accountName := "", ""
	if account != nil {
		accountCode, accountName = account.Code, account.Name
	}
	return gin.H{
		"id": entry.ID, "line_no": entry.LineNo, "account_id": entry.AccountID,
		"account_code": accountCode, "account_name": accountName, "summary": entry.Summary,
		"debit": entry.Debit.StringFixed(2), "credit": entry.Credit.StringFixed(2),
		"aux_detail": aux, "cashflow_item": entry.CashflowItem,
	}
}

func (h *Handler) voucherJSON(db *gorm.DB, voucher model.Voucher) (gin.H, error) {
	var entries []model.VoucherEntry
	if err := db.Where("voucher_id = ? AND account_book_id = ?", voucher.ID, voucher.AccountBookID).Order("line_no").Find(&entries).Error; err != nil {
		return nil, err
	}
	ids := make([]uint, 0, len(entries))
	for _, entry := range entries {
		ids = append(ids, entry.AccountID)
	}
	accounts := map[uint]model.Account{}
	if len(ids) > 0 {
		var rows []model.Account
		if err := db.Where("account_book_id = ? AND id IN ?", voucher.AccountBookID, ids).Find(&rows).Error; err != nil {
			return nil, err
		}
		for _, account := range rows {
			accounts[account.ID] = account
		}
	}
	lines := make([]gin.H, 0, len(entries))
	for _, entry := range entries {
		account, found := accounts[entry.AccountID]
		var accountPtr *model.Account
		if found {
			accountPtr = &account
		}
		lines = append(lines, entryJSON(entry, accountPtr))
	}
	return gin.H{
		"id": voucher.ID, "period_id": voucher.PeriodID, "voucher_no": voucher.VoucherNo,
		"voucher_date": voucher.VoucherDate, "status": voucher.Status, "source": voucher.Source,
		"source_expense_id": voucher.SourceExpenseID, "summary": voucher.Summary,
		"total_debit": voucher.TotalDebit.StringFixed(2), "total_credit": voucher.TotalCredit.StringFixed(2),
		"created_by": voucher.CreatedBy, "reviewed_by": voucher.ReviewedBy,
		"posted_by": voucher.PostedBy, "reversal_of": voucher.ReversalOf,
		"decision_reason": voucher.DecisionReason, "lines": lines,
	}, nil
}

func (h *Handler) createDraftVoucher(tx *gorm.DB, book model.AccountBook, user *model.User, body voucherInput, source string, sourceExpenseID *uint) (*model.Voucher, error) {
	if source == "" {
		source = "manual"
	}
	if !internalVoucherSources[source] {
		return nil, financeErr(http.StatusBadRequest, "F-INVALID-VOUCHER", "凭证来源不合法")
	}
	voucherNo := strings.TrimSpace(body.VoucherNo)
	if voucherNo == "" || len([]rune(voucherNo)) > 32 {
		return nil, financeErr(http.StatusBadRequest, "F-INVALID-VOUCHER", "凭证号长度须为 1-32")
	}
	period, err := h.period(book.ID, body.PeriodID, tx, true)
	if err != nil {
		return nil, err
	}
	if err := ensureOpen(period); err != nil {
		return nil, err
	}
	if body.VoucherDate.IsZero() || body.VoucherDate.Before(period.StartDate.Time) || body.VoucherDate.After(period.EndDate.Time) {
		return nil, financeErr(http.StatusBadRequest, "F-PERIOD-CLOSED", "凭证日期不在所属期间")
	}
	var count int64
	if err := tx.Model(&model.Voucher{}).Where("account_book_id = ? AND period_id = ? AND voucher_no = ?", book.ID, period.ID, voucherNo).Count(&count).Error; err != nil {
		return nil, err
	}
	if count > 0 {
		return nil, financeErr(http.StatusConflict, "F-DUP-VOUCHER-NO", "凭证号在当前期间已存在")
	}
	entries, debit, credit, err := h.validateEntriesWith(tx, book.ID, body.Lines)
	if err != nil {
		return nil, err
	}
	now := timeutil.NowDateTime()
	voucher := &model.Voucher{
		AccountBookID: book.ID, PeriodID: period.ID, VoucherNo: voucherNo,
		VoucherDate: body.VoucherDate, Status: statusDraft, Source: source,
		SourceExpenseID: sourceExpenseID, Summary: strings.TrimSpace(body.Summary),
		TotalDebit: debit, TotalCredit: credit, CreatedBy: userID(user),
		CreatedAt: now, UpdatedAt: now,
	}
	if err := tx.Create(voucher).Error; err != nil {
		return nil, err
	}
	for index := range entries {
		entries[index].VoucherID = voucher.ID
	}
	if err := tx.Create(&entries).Error; err != nil {
		return nil, err
	}
	return voucher, nil
}

func requestFromTemplate(input fromTemplateInput, lines []entryInput) voucherInput {
	return voucherInput{
		PeriodID: input.PeriodID, VoucherNo: input.VoucherNo, VoucherDate: input.VoucherDate,
		Summary: input.Summary, Source: "template", Lines: lines,
	}
}

func (h *Handler) listVoucherTemplates(c *gin.Context) {
	book, ok := h.book(c)
	if !ok {
		return
	}
	var rows []model.VoucherTemplate
	if err := h.DB.Where("account_book_id = ? AND is_active = ?", book.ID, true).Order("code").Find(&rows).Error; err != nil {
		writeError(c, err, "读取凭证模板失败")
		return
	}
	result := make([]gin.H, 0, len(rows))
	for _, row := range rows {
		lines := []entryInput{}
		_ = json.Unmarshal([]byte(row.Lines), &lines)
		result = append(result, gin.H{"id": row.ID, "code": row.Code, "name": row.Name, "lines": lines, "is_active": row.IsActive})
	}
	c.JSON(http.StatusOK, result)
}

func (h *Handler) createVoucherTemplate(c *gin.Context) {
	user := currentUser(c)
	if user == nil {
		return
	}
	book, ok := h.book(c)
	if !ok {
		return
	}
	var input templateInput
	if !bindJSON(c, &input) {
		return
	}
	input.Code, input.Name = strings.TrimSpace(input.Code), strings.TrimSpace(input.Name)
	if input.Code == "" || input.Name == "" {
		badRequest(c, "模板编码和名称不能为空")
		return
	}
	if _, _, _, err := h.validateEntries(book.ID, input.Lines); err != nil {
		writeError(c, err, "模板分录校验失败")
		return
	}
	var row model.VoucherTemplate
	err := h.DB.Transaction(func(tx *gorm.DB) error {
		var count int64
		if err := tx.Model(&model.VoucherTemplate{}).Where("account_book_id = ? AND code = ?", book.ID, input.Code).Count(&count).Error; err != nil {
			return err
		}
		if count > 0 {
			return financeErr(http.StatusConflict, "F-TEMPLATE-DUPLICATE", "模板编码已存在")
		}
		row = model.VoucherTemplate{
			AccountBookID: book.ID, Code: input.Code, Name: input.Name,
			Lines: jsonText(input.Lines), IsActive: true, CreatedBy: userID(user),
			CreatedAt: timeutil.NowDateTime(),
		}
		if err := tx.Create(&row).Error; err != nil {
			return err
		}
		return audit.CommitAudited(tx, userID(user), "create", "voucher_template", row.Code, book.Code, c.ClientIP())
	})
	if err != nil {
		writeError(c, err, "创建凭证模板失败")
		return
	}
	c.JSON(http.StatusCreated, gin.H{"id": row.ID, "code": row.Code, "name": row.Name, "lines": input.Lines, "is_active": row.IsActive})
}

func (h *Handler) createFromTemplate(c *gin.Context) {
	user := currentUser(c)
	if user == nil {
		return
	}
	book, ok := h.book(c)
	if !ok {
		return
	}
	var input fromTemplateInput
	if !bindJSON(c, &input) {
		return
	}
	var template model.VoucherTemplate
	if err := h.DB.Where("id = ? AND account_book_id = ? AND is_active = ?", input.TemplateID, book.ID, true).First(&template).Error; err != nil {
		writeError(c, err, "凭证模板不存在")
		return
	}
	var lines []entryInput
	if err := json.Unmarshal([]byte(template.Lines), &lines); err != nil {
		writeError(c, err, "凭证模板内容损坏")
		return
	}
	var voucher model.Voucher
	err := h.DB.Transaction(func(tx *gorm.DB) error {
		created, err := h.createDraftVoucher(tx, *book, user, requestFromTemplate(input, lines), "template", nil)
		if err != nil {
			return err
		}
		voucher = *created
		return audit.CommitAudited(tx, userID(user), "create_from_template", "voucher", strconv.FormatUint(uint64(voucher.ID), 10), template.Code, c.ClientIP())
	})
	if err != nil {
		writeError(c, err, "从模板生成凭证失败")
		return
	}
	result, err := h.voucherJSON(h.DB, voucher)
	if err != nil {
		writeError(c, err, "读取新凭证失败")
		return
	}
	c.JSON(http.StatusCreated, result)
}

func (h *Handler) importVouchers(c *gin.Context) {
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
	period, err := h.period(book.ID, periodID, h.DB, false)
	if err != nil {
		writeError(c, err, "期间不存在")
		return
	}
	if err := ensureOpen(period); err != nil {
		writeError(c, err, "当前期间不可导入凭证")
		return
	}
	rows, ok := uploadRows(c, "file")
	if !ok {
		return
	}
	if len(rows[0]) < len(importVoucherHeaders) {
		badRequest(c, "Excel 表头不符合凭证导入模板")
		return
	}
	for i, header := range importVoucherHeaders {
		if strings.TrimSpace(rows[0][i]) != header {
			badRequest(c, "Excel 表头不符合凭证导入模板，表头必须为："+strings.Join(importVoucherHeaders, "、"))
			return
		}
	}

	type importGroup struct {
		number  string
		date    timeutil.Date
		summary string
		lines   []entryInput
		start   int
	}
	groups := make([]*importGroup, 0)
	byNumber := map[string]*importGroup{}
	details := make([]map[string]string, 0)
	for index, row := range rows[1:] {
		rowNumber := index + 2
		values := append([]string(nil), row...)
		for len(values) < len(importVoucherHeaders) {
			values = append(values, "")
		}
		if strings.TrimSpace(strings.Join(values[:len(importVoucherHeaders)], "")) == "" {
			continue
		}
		number := strings.TrimSpace(values[0])
		if number == "" {
			details = append(details, map[string]string{"row": strconv.Itoa(rowNumber), "reason": "凭证号不能为空"})
			continue
		}
		date, dateErr := parseDateCell(values[1])
		accountCode := strings.TrimSpace(values[3])
		var account model.Account
		accountErr := h.DB.Where("account_book_id = ? AND code = ?", book.ID, accountCode).First(&account).Error
		debit, debitErr := decimal.NewFromString(strings.TrimSpace(strings.ReplaceAll(values[5], ",", "")))
		credit, creditErr := decimal.NewFromString(strings.TrimSpace(strings.ReplaceAll(values[6], ",", "")))
		aux := map[string]any{}
		auxErr := json.Unmarshal([]byte(strings.TrimSpace(values[8])), &aux)
		if strings.TrimSpace(values[8]) == "" {
			auxErr = nil
		}
		if dateErr != nil {
			details = append(details, map[string]string{"row": strconv.Itoa(rowNumber), "reason": dateErr.Error()})
			continue
		}
		if accountErr != nil {
			details = append(details, map[string]string{"row": strconv.Itoa(rowNumber), "reason": "科目编码不存在：" + accountCode})
			continue
		}
		if debitErr != nil || creditErr != nil {
			details = append(details, map[string]string{"row": strconv.Itoa(rowNumber), "reason": "借方或贷方金额格式错误"})
			continue
		}
		if auxErr != nil {
			details = append(details, map[string]string{"row": strconv.Itoa(rowNumber), "reason": "辅助核算JSON格式错误"})
			continue
		}
		group := byNumber[number]
		if group == nil {
			group = &importGroup{number: number, date: date, summary: strings.TrimSpace(values[2]), start: rowNumber}
			byNumber[number] = group
			groups = append(groups, group)
		} else if !group.date.Equal(date.Time) || group.summary != strings.TrimSpace(values[2]) {
			details = append(details, map[string]string{"row": strconv.Itoa(rowNumber), "reason": "同一凭证的日期和摘要必须一致"})
			continue
		}
		var cashflow *string
		if value := strings.TrimSpace(values[7]); value != "" {
			cashflow = &value
		}
		group.lines = append(group.lines, entryInput{
			AccountID: account.ID, Summary: strings.TrimSpace(values[4]), Debit: debit, Credit: credit,
			AuxDetail: aux, CashflowItem: cashflow,
		})
	}
	if len(details) > 0 {
		writeError(c, financeErrDetails(http.StatusBadRequest, "F-IMPORT-INVALID", "Excel 导入校验失败，未写入任何凭证", details), "")
		return
	}
	if len(groups) == 0 {
		badRequest(c, "导入文件没有凭证数据")
		return
	}
	created := make([]model.Voucher, 0, len(groups))
	err = h.DB.Transaction(func(tx *gorm.DB) error {
		for _, group := range groups {
			payload := voucherInput{PeriodID: period.ID, VoucherNo: group.number, VoucherDate: group.date, Summary: group.summary, Source: "import", Lines: group.lines}
			voucher, err := h.createDraftVoucher(tx, *book, user, payload, "import", nil)
			if err != nil {
				return err
			}
			created = append(created, *voucher)
		}
		return audit.CommitAudited(tx, userID(user), "import_vouchers", "vouchers", strconv.FormatUint(uint64(period.ID), 10), fmt.Sprintf("count=%d", len(created)), c.ClientIP())
	})
	if err != nil {
		writeError(c, err, "凭证导入失败，未写入任何凭证")
		return
	}
	result := make([]gin.H, 0, len(created))
	for _, voucher := range created {
		item, err := h.voucherJSON(h.DB, voucher)
		if err != nil {
			writeError(c, err, "读取导入凭证失败")
			return
		}
		result = append(result, item)
	}
	c.JSON(http.StatusOK, gin.H{"imported": len(result), "vouchers": result})
}

func (h *Handler) exportVouchers(c *gin.Context) {
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
	period, err := h.period(book.ID, periodID, h.DB, false)
	if err != nil {
		writeError(c, err, "期间不存在")
		return
	}
	var vouchers []model.Voucher
	if err := h.DB.Where("account_book_id = ? AND period_id = ?", book.ID, period.ID).Order("voucher_date, id").Find(&vouchers).Error; err != nil {
		writeError(c, err, "读取凭证失败")
		return
	}
	rows := make([][]string, 0)
	for _, voucher := range vouchers {
		var entries []model.VoucherEntry
		if err := h.DB.Where("voucher_id = ?", voucher.ID).Order("line_no").Find(&entries).Error; err != nil {
			writeError(c, err, "读取凭证分录失败")
			return
		}
		for _, entry := range entries {
			var account model.Account
			if err := h.DB.Where("id = ? AND account_book_id = ?", entry.AccountID, book.ID).First(&account).Error; err != nil {
				writeError(c, err, "读取凭证科目失败")
				return
			}
			aux := map[string]any{}
			_ = json.Unmarshal([]byte(entry.AuxDetail), &aux)
			rows = append(rows, []string{
				voucher.VoucherNo, voucher.VoucherDate.Format("2006-01-02"), voucher.Summary,
				account.Code, entry.Summary, entry.Debit.StringFixed(2), entry.Credit.StringFixed(2),
				derefString(entry.CashflowItem), jsonText(aux),
			})
		}
	}
	data, err := excel.GenerateXLSX("凭证", importVoucherHeaders, rows)
	if err != nil {
		writeError(c, err, "生成凭证导出文件失败")
		return
	}
	if err := h.DB.Transaction(func(tx *gorm.DB) error {
		return audit.CommitAudited(tx, userID(user), "export_vouchers", "vouchers", strconv.FormatUint(uint64(period.ID), 10), "book="+book.Code, c.ClientIP())
	}); err != nil {
		writeError(c, err, "导出审计写入失败")
		return
	}
	filename := fmt.Sprintf("vouchers_%04d-%02d.xlsx", period.Year, period.Month)
	c.Header("Content-Disposition", `attachment; filename="`+filename+`"`)
	c.Data(http.StatusOK, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", data)
}

func derefString(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func (h *Handler) listProjectExpenses(c *gin.Context) {
	book, ok := h.book(c)
	if !ok {
		return
	}
	user := currentUser(c)
	if user == nil {
		return
	}
	query := h.DB.Model(&model.Expense{}).
		Select("expenses.*, projects.code AS project_code, projects.name AS project_name").
		Joins("JOIN projects ON projects.id = expenses.project_id").
		Where("expenses.status = ?", "approved").
		Where("expenses.project_id IN (?)", rbac.VisibleProjectSubquery(h.DB, user)).
		Where("NOT EXISTS (SELECT 1 FROM vouchers WHERE vouchers.source_expense_id = expenses.id)")
	type expenseRow struct {
		model.Expense
		ProjectCode string `json:"project_code"`
		ProjectName string `json:"project_name"`
	}
	var rows []expenseRow
	if err := query.Order("expenses.exp_date DESC NULLS LAST, expenses.id DESC").Find(&rows).Error; err != nil {
		writeError(c, err, "读取待转凭证项目支出失败")
		return
	}
	result := make([]gin.H, 0, len(rows))
	for _, row := range rows {
		result = append(result, gin.H{
			"id": row.ID, "project_id": row.ProjectID, "project_code": row.ProjectCode,
			"project_name": row.ProjectName, "subject": row.Subject, "amount": decimal.NewFromFloat(row.Amount).StringFixed(2),
			"exp_date": row.ExpDate, "note": row.Note, "status": row.Status, "account_book_id": book.ID,
		})
	}
	c.JSON(http.StatusOK, gin.H{"total": len(result), "items": result})
}

func (h *Handler) createProjectExpenseVoucher(c *gin.Context) {
	user := currentUser(c)
	if user == nil {
		return
	}
	book, ok := h.book(c)
	if !ok {
		return
	}
	expenseID, ok := parseID(c, "expense_id")
	if !ok {
		return
	}
	var input projectExpenseVoucherInput
	if !bindJSON(c, &input) {
		return
	}
	var voucher model.Voucher
	err := h.DB.Transaction(func(tx *gorm.DB) error {
		var expense model.Expense
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("id = ? AND status = ? AND project_id IN (?)", expenseID, "approved", rbac.VisibleProjectSubquery(tx, user)).First(&expense).Error; err != nil {
			return financeErr(http.StatusNotFound, "F-PROJECT-EXPENSE-NOT-FOUND", "项目支出不存在或不可转换")
		}
		var existing model.Voucher
		err := tx.Where("source_expense_id = ?", expenseID).First(&existing).Error
		if err == nil {
			return financeErr(http.StatusConflict, "F-PROJECT-EXPENSE-LINKED", "项目支出已生成凭证")
		}
		if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
			return err
		}
		amount, err := decimal.NewFromString(strconv.FormatFloat(expense.Amount, 'f', 2, 64))
		if err != nil || amount.Sign() <= 0 {
			return financeErr(http.StatusBadRequest, "F-INVALID-AMOUNT", "项目支出金额无效")
		}
		debit, credit := input.Debit, input.Credit
		if debit.AccountID == 0 || credit.AccountID == 0 {
			return financeErr(http.StatusBadRequest, "F-INVALID-VOUCHER", "借方和贷方科目必须填写")
		}
		debit.Debit, debit.Credit = amount, decimal.Zero
		credit.Debit, credit.Credit = decimal.Zero, amount
		lines := []entryInput{debit, credit}
		number := fmt.Sprintf("支出-%d", expense.ID)
		voucherInput := voucherInput{
			PeriodID: input.PeriodID, VoucherNo: number, VoucherDate: input.VoucherDate,
			Summary: input.Summary, Source: "project-expense", Lines: lines,
		}
		created, err := h.createDraftVoucher(tx, *book, user, voucherInput, "project-expense", &expense.ID)
		if err != nil {
			return err
		}
		voucher = *created
		return audit.CommitAudited(tx, userID(user), "create_project_expense_voucher", "voucher", strconv.FormatUint(uint64(voucher.ID), 10), fmt.Sprintf("expense=%d", expense.ID), c.ClientIP())
	})
	if err != nil {
		writeError(c, err, "项目支出转凭证失败")
		return
	}
	result, err := h.voucherJSON(h.DB, voucher)
	if err != nil {
		writeError(c, err, "读取生成凭证失败")
		return
	}
	c.JSON(http.StatusCreated, result)
}

func (h *Handler) createVoucher(c *gin.Context) {
	user := currentUser(c)
	if user == nil {
		return
	}
	book, ok := h.book(c)
	if !ok {
		return
	}
	var input voucherInput
	if !bindJSON(c, &input) {
		return
	}
	source := strings.TrimSpace(input.Source)
	if source == "" {
		source = "manual"
	}
	if !externalVoucherSources[source] {
		writeError(c, financeErr(http.StatusBadRequest, "F-INVALID-VOUCHER", "凭证来源不合法"), "")
		return
	}
	var voucher model.Voucher
	err := h.DB.Transaction(func(tx *gorm.DB) error {
		created, err := h.createDraftVoucher(tx, *book, user, input, source, nil)
		if err != nil {
			return err
		}
		voucher = *created
		return audit.CommitAudited(tx, userID(user), "create", "voucher", strconv.FormatUint(uint64(voucher.ID), 10), voucher.VoucherNo, c.ClientIP())
	})
	if err != nil {
		writeError(c, err, "创建凭证失败")
		return
	}
	result, err := h.voucherJSON(h.DB, voucher)
	if err != nil {
		writeError(c, err, "读取凭证失败")
		return
	}
	c.JSON(http.StatusCreated, result)
}

func (h *Handler) listVouchers(c *gin.Context) {
	book, ok := h.book(c)
	if !ok {
		return
	}
	page, size, ok := parsePage(c, 20, 100)
	if !ok {
		return
	}
	query := h.DB.Model(&model.Voucher{}).Where("account_book_id = ?", book.ID)
	if status := strings.TrimSpace(c.Query("status")); status != "" {
		if status != statusDraft && status != statusPending && status != statusPosted && status != statusVoid {
			badRequest(c, "凭证状态不合法")
			return
		}
		query = query.Where("status = ?", status)
	}
	if periodID, ok := queryUint(c, "period_id", false); !ok {
		return
	} else if periodID > 0 {
		query = query.Where("period_id = ?", periodID)
	}
	envelope, err := paging.Paginate[model.Voucher](query, page, size, c.Query("sort"),
		map[string]string{"id": "id", "voucher_date": "voucher_date", "voucher_no": "voucher_no", "status": "status"},
		"-voucher_date")
	if err != nil {
		badRequest(c, err.Error())
		return
	}
	items := make([]gin.H, 0, len(envelope.Items))
	for _, voucher := range envelope.Items {
		items = append(items, gin.H{
			"id": voucher.ID, "period_id": voucher.PeriodID, "voucher_no": voucher.VoucherNo,
			"voucher_date": voucher.VoucherDate, "status": voucher.Status, "source": voucher.Source,
			"summary": voucher.Summary, "total_debit": voucher.TotalDebit.StringFixed(2),
			"total_credit": voucher.TotalCredit.StringFixed(2), "created_by": voucher.CreatedBy,
			"reviewed_by": voucher.ReviewedBy, "posted_by": voucher.PostedBy,
		})
	}
	c.JSON(http.StatusOK, gin.H{"total": envelope.Total, "page": envelope.Page, "size": envelope.Size, "items": items})
}

func (h *Handler) getVoucher(c *gin.Context) {
	book, ok := h.book(c)
	if !ok {
		return
	}
	id, ok := parseID(c, "voucher_id")
	if !ok {
		return
	}
	var voucher model.Voucher
	if err := h.DB.Where("id = ? AND account_book_id = ?", id, book.ID).First(&voucher).Error; err != nil {
		writeError(c, err, "凭证不存在")
		return
	}
	result, err := h.voucherJSON(h.DB, voucher)
	if err != nil {
		writeError(c, err, "读取凭证分录失败")
		return
	}
	c.JSON(http.StatusOK, result)
}

func (h *Handler) updateVoucher(c *gin.Context) {
	user := currentUser(c)
	if user == nil {
		return
	}
	book, ok := h.book(c)
	if !ok {
		return
	}
	id, ok := parseID(c, "voucher_id")
	if !ok {
		return
	}
	var input voucherPatchInput
	if !bindJSON(c, &input) {
		return
	}
	var voucher model.Voucher
	err := h.DB.Transaction(func(tx *gorm.DB) error {
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("id = ? AND account_book_id = ?", id, book.ID).First(&voucher).Error; err != nil {
			return err
		}
		if voucher.Status != statusDraft {
			return financeErr(http.StatusConflict, "F-VOUCHER-STATE", "只有草稿凭证可以修改")
		}
		periodID := voucher.PeriodID
		if input.PeriodID != nil {
			periodID = *input.PeriodID
		}
		period, err := h.period(book.ID, periodID, tx, true)
		if err != nil {
			return err
		}
		if err := ensureOpen(period); err != nil {
			return err
		}
		if input.VoucherNo != nil {
			number := strings.TrimSpace(*input.VoucherNo)
			if number == "" || len([]rune(number)) > 32 {
				return financeErr(http.StatusBadRequest, "F-INVALID-VOUCHER", "凭证号长度须为 1-32")
			}
			voucher.VoucherNo = number
		}
		if input.VoucherDate != nil {
			voucher.VoucherDate = *input.VoucherDate
		}
		if voucher.VoucherDate.Before(period.StartDate.Time) || voucher.VoucherDate.After(period.EndDate.Time) {
			return financeErr(http.StatusBadRequest, "F-PERIOD-CLOSED", "凭证日期不在所属期间")
		}
		voucher.PeriodID = period.ID
		if input.Summary != nil {
			voucher.Summary = strings.TrimSpace(*input.Summary)
		}
		var count int64
		if err := tx.Model(&model.Voucher{}).Where("account_book_id = ? AND period_id = ? AND voucher_no = ? AND id <> ?", book.ID, period.ID, voucher.VoucherNo, voucher.ID).Count(&count).Error; err != nil {
			return err
		}
		if count > 0 {
			return financeErr(http.StatusConflict, "F-DUP-VOUCHER-NO", "凭证号在当前期间已存在")
		}
		if input.Lines != nil {
			entries, debit, credit, err := h.validateEntriesWith(tx, book.ID, *input.Lines)
			if err != nil {
				return err
			}
			if err := tx.Where("voucher_id = ?", voucher.ID).Delete(&model.VoucherEntry{}).Error; err != nil {
				return err
			}
			for index := range entries {
				entries[index].VoucherID = voucher.ID
			}
			if err := tx.Create(&entries).Error; err != nil {
				return err
			}
			voucher.TotalDebit, voucher.TotalCredit = debit, credit
		}
		voucher.UpdatedAt = timeutil.NowDateTime()
		if err := tx.Save(&voucher).Error; err != nil {
			return err
		}
		return audit.CommitAudited(tx, userID(user), "update", "voucher", strconv.FormatUint(uint64(voucher.ID), 10), voucher.VoucherNo, c.ClientIP())
	})
	if err != nil {
		writeError(c, err, "更新凭证失败")
		return
	}
	result, err := h.voucherJSON(h.DB, voucher)
	if err != nil {
		writeError(c, err, "读取凭证失败")
		return
	}
	c.JSON(http.StatusOK, result)
}

func (h *Handler) deleteVoucher(c *gin.Context) {
	user := currentUser(c)
	if user == nil {
		return
	}
	book, ok := h.book(c)
	if !ok {
		return
	}
	id, ok := parseID(c, "voucher_id")
	if !ok {
		return
	}
	err := h.DB.Transaction(func(tx *gorm.DB) error {
		var voucher model.Voucher
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("id = ? AND account_book_id = ?", id, book.ID).First(&voucher).Error; err != nil {
			return err
		}
		if voucher.Status != statusDraft {
			return financeErr(http.StatusConflict, "F-VOUCHER-STATE", "只有草稿凭证可以删除")
		}
		if err := releaseARAPAllocations(tx, book.ID, voucher.ID, user.ID, "凭证已删除", nil); err != nil {
			return err
		}
		if err := tx.Where("voucher_id = ?", voucher.ID).Delete(&model.VoucherEntry{}).Error; err != nil {
			return err
		}
		if err := tx.Delete(&voucher).Error; err != nil {
			return err
		}
		return audit.CommitAudited(tx, userID(user), "delete", "voucher", strconv.FormatUint(uint64(id), 10), voucher.VoucherNo, c.ClientIP())
	})
	if err != nil {
		writeError(c, err, "删除草稿凭证失败")
		return
	}
	c.JSON(http.StatusOK, gin.H{"deleted": true, "id": id})
}

func (h *Handler) transitionVoucher(c *gin.Context, target, reasonRequired string) (*model.Voucher, error) {
	user := currentUser(c)
	if user == nil {
		return nil, nil
	}
	book, ok := h.book(c)
	if !ok {
		return nil, nil
	}
	id, ok := parseID(c, "voucher_id")
	if !ok {
		return nil, nil
	}
	var input reasonInput
	if reasonRequired != "" && !bindJSON(c, &input) {
		return nil, nil
	}
	var voucher model.Voucher
	err := h.DB.Transaction(func(tx *gorm.DB) error {
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("id = ? AND account_book_id = ?", id, book.ID).First(&voucher).Error; err != nil {
			return err
		}
		action := target
		switch target {
		case statusPending:
			if voucher.Status != statusDraft {
				return financeErr(http.StatusConflict, "F-VOUCHER-STATE", "只有草稿凭证可以提交审核")
			}
			voucher.Status = statusPending
			voucher.DecisionReason = ""
		case "approve":
			if voucher.Status != statusPending {
				return financeErr(http.StatusConflict, "F-VOUCHER-STATE", "只有待审核凭证可以审核")
			}
			voucher.ReviewedBy = userID(user)
			action = "approve"
		case statusDraft:
			if voucher.Status != statusPending {
				return financeErr(http.StatusConflict, "F-VOUCHER-STATE", "只有待审核凭证可以驳回")
			}
			if strings.TrimSpace(input.Reason) == "" {
				return financeErr(http.StatusBadRequest, "F-REASON-REQUIRED", "驳回凭证必须填写理由")
			}
			voucher.Status, voucher.ReviewedBy = statusDraft, nil
			voucher.DecisionReason = strings.TrimSpace(input.Reason)
			action = "reject"
		case statusVoid:
			if voucher.Status != statusDraft && voucher.Status != statusPending {
				return financeErr(http.StatusConflict, "F-VOUCHER-STATE", "已过账凭证不能作废，请使用红字冲销")
			}
			if strings.TrimSpace(input.Reason) == "" {
				return financeErr(http.StatusBadRequest, "F-REASON-REQUIRED", "作废凭证必须填写原因")
			}
			voucher.Status, voucher.VoidedBy = statusVoid, userID(user)
			voucher.DecisionReason = strings.TrimSpace(input.Reason)
			if err := releaseARAPAllocations(tx, book.ID, voucher.ID, user.ID, voucher.DecisionReason, nil); err != nil {
				return err
			}
			action = "void"
		}
		voucher.UpdatedAt = timeutil.NowDateTime()
		if err := tx.Save(&voucher).Error; err != nil {
			return err
		}
		return audit.CommitAudited(tx, userID(user), action, "voucher", strconv.FormatUint(uint64(voucher.ID), 10), voucher.DecisionReason, c.ClientIP())
	})
	return &voucher, err
}

func (h *Handler) submitVoucher(c *gin.Context) {
	voucher, err := h.transitionVoucher(c, statusPending, "")
	if err != nil {
		writeError(c, err, "提交凭证失败")
		return
	}
	if voucher == nil {
		return
	}
	result, err := h.voucherJSON(h.DB, *voucher)
	if err != nil {
		writeError(c, err, "读取凭证失败")
		return
	}
	c.JSON(http.StatusOK, result)
}

func (h *Handler) approveVoucher(c *gin.Context) {
	voucher, err := h.transitionVoucher(c, "approve", "")
	if err != nil {
		writeError(c, err, "审核凭证失败")
		return
	}
	if voucher == nil {
		return
	}
	result, err := h.voucherJSON(h.DB, *voucher)
	if err != nil {
		writeError(c, err, "读取凭证失败")
		return
	}
	c.JSON(http.StatusOK, result)
}

func (h *Handler) rejectVoucher(c *gin.Context) {
	voucher, err := h.transitionVoucher(c, statusDraft, "reason")
	if err != nil {
		writeError(c, err, "驳回凭证失败")
		return
	}
	if voucher == nil {
		return
	}
	result, err := h.voucherJSON(h.DB, *voucher)
	if err != nil {
		writeError(c, err, "读取凭证失败")
		return
	}
	c.JSON(http.StatusOK, result)
}

func (h *Handler) voidVoucher(c *gin.Context) {
	voucher, err := h.transitionVoucher(c, statusVoid, "reason")
	if err != nil {
		writeError(c, err, "作废凭证失败")
		return
	}
	if voucher == nil {
		return
	}
	result, err := h.voucherJSON(h.DB, *voucher)
	if err != nil {
		writeError(c, err, "读取凭证失败")
		return
	}
	c.JSON(http.StatusOK, result)
}

func updateAccountBalance(tx *gorm.DB, voucher model.Voucher) error {
	var period model.AccountingPeriod
	if err := tx.Where("id = ? AND account_book_id = ?", voucher.PeriodID, voucher.AccountBookID).First(&period).Error; err != nil {
		return financeErr(http.StatusBadRequest, "F-PERIOD-CLOSED", "凭证期间不存在")
	}
	var entries []model.VoucherEntry
	if err := tx.Where("voucher_id = ? AND account_book_id = ?", voucher.ID, voucher.AccountBookID).Order("line_no").Find(&entries).Error; err != nil {
		return err
	}
	for _, entry := range entries {
		// Serialize projection creation by account, including the empty-row case.
		var account model.Account
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("id = ? AND account_book_id = ?", entry.AccountID, voucher.AccountBookID).First(&account).Error; err != nil {
			return err
		}
		auxKey := canonicalAuxKey(entry.AuxDetail)
		var balance model.AccountBalance
		err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("account_book_id = ? AND period_id = ? AND account_id = ? AND aux_key = ?", voucher.AccountBookID, period.ID, entry.AccountID, auxKey).
			First(&balance).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			var previous model.AccountBalance
			previousErr := tx.Table("account_balances").
				Select("account_balances.*").
				Joins("JOIN accounting_periods ON accounting_periods.id = account_balances.period_id").
				Where("account_balances.account_book_id = ? AND account_balances.account_id = ? AND account_balances.aux_key = ? AND accounting_periods.period_index < ?", voucher.AccountBookID, entry.AccountID, auxKey, period.PeriodIndex).
				Order("accounting_periods.period_index DESC").Limit(1).Take(&previous).Error
			openingDebit, openingCredit := decimal.Zero, decimal.Zero
			if previousErr == nil {
				openingDebit, openingCredit = previous.EndingDebit, previous.EndingCredit
			} else if !errors.Is(previousErr, gorm.ErrRecordNotFound) {
				return previousErr
			} else {
				var openingRows []model.OpeningBalance
				if err := tx.Where("account_book_id = ? AND account_id = ? AND aux_key = ?", voucher.AccountBookID, entry.AccountID, auxKey).Find(&openingRows).Error; err != nil {
					return err
				}
				for _, row := range openingRows {
					openingDebit = openingDebit.Add(row.Debit)
					openingCredit = openingCredit.Add(row.Credit)
				}
			}
			balance = model.AccountBalance{
				AccountBookID: voucher.AccountBookID, PeriodID: period.ID,
				AccountID: entry.AccountID, AuxKey: auxKey,
				OpeningDebit: openingDebit, OpeningCredit: openingCredit,
			}
		} else if err != nil {
			return err
		}
		balance.DebitTotal = balance.DebitTotal.Add(entry.Debit)
		balance.CreditTotal = balance.CreditTotal.Add(entry.Credit)
		net := balance.OpeningDebit.Sub(balance.OpeningCredit).Add(balance.DebitTotal).Sub(balance.CreditTotal)
		balance.EndingDebit, balance.EndingCredit = decimal.Zero, decimal.Zero
		if net.Sign() >= 0 {
			balance.EndingDebit = net
		} else {
			balance.EndingCredit = net.Abs()
		}
		if balance.ID == 0 {
			if err := tx.Create(&balance).Error; err != nil {
				return err
			}
		} else if err := tx.Save(&balance).Error; err != nil {
			return err
		}
	}
	return nil
}

func canonicalAuxKey(raw string) string {
	var data map[string]any
	if json.Unmarshal([]byte(raw), &data) != nil || len(data) == 0 {
		return ""
	}
	keys := make([]string, 0, len(data))
	for key := range data {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, key := range keys {
		parts = append(parts, key+"="+fmt.Sprint(data[key]))
	}
	value := strings.Join(parts, "|")
	if len(value) > 128 {
		digest := sha256.Sum256([]byte(value))
		return fmt.Sprintf("sha256:%x", digest)
	}
	return value
}

func (h *Handler) postVoucher(c *gin.Context) {
	user := currentUser(c)
	if user == nil {
		return
	}
	book, ok := h.book(c)
	if !ok {
		return
	}
	id, ok := parseID(c, "voucher_id")
	if !ok {
		return
	}
	var voucher model.Voucher
	err := h.DB.Transaction(func(tx *gorm.DB) error {
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("id = ? AND account_book_id = ?", id, book.ID).First(&voucher).Error; err != nil {
			return err
		}
		if voucher.Status != statusPending {
			return financeErr(http.StatusConflict, "F-VOUCHER-STATE", "只有待审核凭证可以过账")
		}
		if voucher.ReviewedBy == nil {
			return financeErr(http.StatusBadRequest, "F-SOD", "凭证必须先审核后过账")
		}
		period, err := h.period(book.ID, voucher.PeriodID, tx, true)
		if err != nil {
			return err
		}
		if err := ensureOpen(period); err != nil {
			return err
		}
		if voucher.ReversalOf != nil {
			if err := ensureNoOpenARAPAllocations(tx, book.ID, *voucher.ReversalOf); err != nil {
				return err
			}
		}
		voucher.Status, voucher.PostedBy, voucher.UpdatedAt = statusPosted, userID(user), timeutil.NowDateTime()
		if err := tx.Save(&voucher).Error; err != nil {
			return err
		}
		if err := updateAccountBalance(tx, voucher); err != nil {
			return err
		}
		released := 0
		if voucher.ReversalOf != nil {
			released, err = releaseARAPAllocationsCount(tx, book.ID, *voucher.ReversalOf, user.ID, "冲销凭证 "+voucher.VoucherNo+" 已过账", &voucher.ID)
			if err != nil {
				return err
			}
		}
		detail := voucher.VoucherNo
		if released > 0 {
			detail += fmt.Sprintf("；冲销后释放核销分配 %d 笔", released)
		}
		return audit.CommitAudited(tx, userID(user), "post", "voucher", strconv.FormatUint(uint64(voucher.ID), 10), detail, c.ClientIP())
	})
	if err != nil {
		writeError(c, err, "凭证过账失败")
		return
	}
	result, err := h.voucherJSON(h.DB, voucher)
	if err != nil {
		writeError(c, err, "读取凭证失败")
		return
	}
	c.JSON(http.StatusOK, result)
}

func (h *Handler) reverseVoucher(c *gin.Context) {
	user := currentUser(c)
	if user == nil {
		return
	}
	book, ok := h.book(c)
	if !ok {
		return
	}
	id, ok := parseID(c, "voucher_id")
	if !ok {
		return
	}
	var reversal model.Voucher
	err := h.DB.Transaction(func(tx *gorm.DB) error {
		var original model.Voucher
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("id = ? AND account_book_id = ?", id, book.ID).First(&original).Error; err != nil {
			return err
		}
		if original.Status != statusPosted || original.ReversalOf != nil {
			return financeErr(http.StatusBadRequest, "F-VOUCHER-STATE", "只有原始已过账凭证可以红字冲销")
		}
		if err := ensureNoOpenARAPAllocations(tx, book.ID, original.ID); err != nil {
			return err
		}
		var existing int64
		if err := tx.Model(&model.Voucher{}).Where("account_book_id = ? AND reversal_of = ? AND status <> ?", book.ID, original.ID, statusVoid).Count(&existing).Error; err != nil {
			return err
		}
		if existing > 0 {
			return financeErr(http.StatusConflict, "F-VOUCHER-STATE", "该凭证已有未作废的冲销凭证，不能重复冲销")
		}
		period, err := h.period(book.ID, original.PeriodID, tx, true)
		if err != nil {
			return err
		}
		if err := ensureOpen(period); err != nil {
			return err
		}
		var entries []model.VoucherEntry
		if err := tx.Where("voucher_id = ?", original.ID).Order("line_no").Find(&entries).Error; err != nil {
			return err
		}
		var count int64
		if err := tx.Model(&model.Voucher{}).Where("account_book_id = ? AND period_id = ? AND voucher_no LIKE ?", book.ID, period.ID, "红-%").Count(&count).Error; err != nil {
			return err
		}
		number := fmt.Sprintf("红-%04d", count+1)
		for {
			var duplicate int64
			if err := tx.Model(&model.Voucher{}).Where("account_book_id = ? AND period_id = ? AND voucher_no = ?", book.ID, period.ID, number).Count(&duplicate).Error; err != nil {
				return err
			}
			if duplicate == 0 {
				break
			}
			count++
			number = fmt.Sprintf("红-%04d", count+1)
		}
		reversal = model.Voucher{
			AccountBookID: book.ID, PeriodID: period.ID, VoucherNo: number,
			VoucherDate: original.VoucherDate, Status: statusDraft, Source: "reversal",
			Summary: "红字冲销：" + original.Summary, TotalDebit: original.TotalDebit,
			TotalCredit: original.TotalCredit, CreatedBy: userID(user), ReversalOf: &original.ID,
			CreatedAt: timeutil.NowDateTime(), UpdatedAt: timeutil.NowDateTime(),
		}
		if err := tx.Create(&reversal).Error; err != nil {
			return err
		}
		for _, entry := range entries {
			reverseEntry := model.VoucherEntry{
				AccountBookID: book.ID, VoucherID: reversal.ID, LineNo: entry.LineNo,
				AccountID: entry.AccountID, Summary: entry.Summary, Debit: entry.Credit,
				Credit: entry.Debit, AuxDetail: entry.AuxDetail, CashflowItem: entry.CashflowItem,
			}
			if err := tx.Create(&reverseEntry).Error; err != nil {
				return err
			}
		}
		return audit.CommitAudited(tx, userID(user), "reverse", "voucher", strconv.FormatUint(uint64(original.ID), 10), strconv.FormatUint(uint64(reversal.ID), 10), c.ClientIP())
	})
	if err != nil {
		writeError(c, err, "红字冲销凭证失败")
		return
	}
	result, err := h.voucherJSON(h.DB, reversal)
	if err != nil {
		writeError(c, err, "读取冲销凭证失败")
		return
	}
	c.JSON(http.StatusCreated, result)
}

func (h *Handler) voucherGaps(c *gin.Context) {
	book, ok := h.book(c)
	if !ok {
		return
	}
	periodID, ok := queryUint(c, "period_id", true)
	if !ok {
		return
	}
	if _, err := h.period(book.ID, periodID, h.DB, false); err != nil {
		writeError(c, err, "期间不存在")
		return
	}
	var rows []model.Voucher
	if err := h.DB.Select("voucher_no").Where("account_book_id = ? AND period_id = ?", book.ID, periodID).Find(&rows).Error; err != nil {
		writeError(c, err, "凭证断号检查失败")
		return
	}
	used := map[int]bool{}
	maximum := 0
	for _, row := range rows {
		number := strings.TrimPrefix(row.VoucherNo, "记-")
		value, err := strconv.Atoi(number)
		if err == nil && value > 0 {
			used[value], maximum = true, max(maximum, value)
		}
	}
	gaps := make([]string, 0)
	for number := 1; number <= maximum; number++ {
		if !used[number] {
			gaps = append(gaps, fmt.Sprintf("记-%04d", number))
		}
	}
	c.JSON(http.StatusOK, gin.H{"period_id": periodID, "gaps": gaps, "blocked": len(gaps) > 0})
}
