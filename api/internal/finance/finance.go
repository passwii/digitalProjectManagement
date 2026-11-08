package finance

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
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

const (
	statusDraft   = "draft"
	statusPending = "pending"
	statusPosted  = "posted"
	statusVoid    = "void"

	periodOpen   = "open"
	periodClosed = "closed"

	maxUploadBytes = 12 << 20
)

var (
	accountCategories = map[string]bool{
		"资产": true, "负债": true, "权益": true, "成本": true, "损益": true,
	}
	auxiliaryKinds = map[string]bool{
		"customer": true, "vendor": true, "department": true,
		"employee": true, "project": true, "cashflow": true,
	}
)

type Handler struct {
	DB *gorm.DB
}

type apiError struct {
	Status  int
	Code    string
	Message string
	Details []map[string]string
}

func (e *apiError) Error() string {
	return e.Message
}

func financeErr(status int, code, message string) error {
	return &apiError{Status: status, Code: code, Message: message, Details: []map[string]string{}}
}

func financeErrDetails(status int, code, message string, details []map[string]string) error {
	return &apiError{Status: status, Code: code, Message: message, Details: details}
}

func writeError(c *gin.Context, err error, fallback string) {
	var apiErr *apiError
	if errors.As(err, &apiErr) {
		c.JSON(apiErr.Status, gin.H{"detail": gin.H{
			"code": apiErr.Code, "message": apiErr.Message, "details": apiErr.Details,
		}})
		return
	}
	if errors.Is(err, gorm.ErrRecordNotFound) {
		c.JSON(http.StatusNotFound, gin.H{"detail": fallback})
		return
	}
	if isDuplicate(err) {
		c.JSON(http.StatusConflict, gin.H{"detail": fallback})
		return
	}
	c.JSON(http.StatusInternalServerError, gin.H{"detail": fallback})
}

func isDuplicate(err error) bool {
	if err == nil {
		return false
	}
	text := strings.ToLower(err.Error())
	return strings.Contains(text, "duplicate key") ||
		strings.Contains(text, "unique constraint") ||
		strings.Contains(text, "violates unique") ||
		strings.Contains(text, "unique index")
}

func badRequest(c *gin.Context, message string) {
	c.JSON(http.StatusBadRequest, gin.H{"detail": message})
}

func notFound(c *gin.Context, message string) {
	c.JSON(http.StatusNotFound, gin.H{"detail": message})
}

func conflict(c *gin.Context, message string) {
	c.JSON(http.StatusConflict, gin.H{"detail": message})
}

func bindJSON(c *gin.Context, dst any) bool {
	if err := c.ShouldBindJSON(dst); err != nil {
		badRequest(c, err.Error())
		return false
	}
	return true
}

func currentUser(c *gin.Context) *model.User {
	user := rbac.GetCurrentUser(c)
	if user == nil {
		c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"detail": "未登录"})
		return nil
	}
	return user
}

func userID(user *model.User) *uint {
	if user == nil {
		return nil
	}
	id := user.ID
	return &id
}

func parseID(c *gin.Context, key string) (uint, bool) {
	value, err := strconv.ParseUint(c.Param(key), 10, 64)
	if err != nil || value == 0 {
		badRequest(c, "编号格式错误")
		return 0, false
	}
	return uint(value), true
}

func queryUint(c *gin.Context, key string, required bool) (uint, bool) {
	raw := strings.TrimSpace(c.Query(key))
	if raw == "" {
		if required {
			badRequest(c, key+" 必须填写")
			return 0, false
		}
		return 0, true
	}
	value, err := strconv.ParseUint(raw, 10, 64)
	if err != nil || value == 0 {
		badRequest(c, key+" 须为正整数")
		return 0, false
	}
	return uint(value), true
}

func parsePage(c *gin.Context, defaultSize, maximum int) (int, int, bool) {
	page, size := 1, defaultSize
	var err error
	if raw := c.Query("page"); raw != "" {
		page, err = strconv.Atoi(raw)
		if err != nil {
			badRequest(c, "page 须为正整数")
			return 0, 0, false
		}
	}
	if raw := c.Query("size"); raw != "" {
		size, err = strconv.Atoi(raw)
		if err != nil {
			badRequest(c, "size 须为正整数")
			return 0, 0, false
		}
	}
	if _, err := paging.ValidatePage(page); err != nil {
		badRequest(c, err.Error())
		return 0, 0, false
	}
	if _, err := paging.ValidateSize(size, maximum); err != nil {
		badRequest(c, err.Error())
		return 0, 0, false
	}
	return page, size, true
}

func (h *Handler) book(c *gin.Context) (*model.AccountBook, bool) {
	code := strings.TrimSpace(c.GetHeader("X-Account-Book"))
	if code == "" {
		c.JSON(http.StatusForbidden, gin.H{"detail": gin.H{
			"code": "F-NO-BOOK-ACCESS", "message": "请通过 X-Account-Book 指定账套 code", "details": []any{},
		}})
		return nil, false
	}
	var book model.AccountBook
	err := h.DB.Where("code = ? AND deleted_at IS NULL", code).First(&book).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		c.JSON(http.StatusForbidden, gin.H{"detail": gin.H{
			"code": "F-NO-BOOK-ACCESS", "message": "账套不存在", "details": []any{},
		}})
		return nil, false
	}
	if err != nil {
		writeError(c, err, "读取账套失败")
		return nil, false
	}
	return &book, true
}

func (h *Handler) period(bookID, periodID uint, tx *gorm.DB, lock bool) (*model.AccountingPeriod, error) {
	if tx == nil {
		tx = h.DB
	}
	q := tx.Where("account_book_id = ? AND id = ?", bookID, periodID)
	if lock {
		q = q.Clauses(clause.Locking{Strength: "UPDATE"})
	}
	var period model.AccountingPeriod
	if err := q.First(&period).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, financeErr(http.StatusBadRequest, "F-PERIOD-CLOSED", "期间不存在或不属于当前账套")
		}
		return nil, err
	}
	return &period, nil
}

func ensureOpen(period *model.AccountingPeriod) error {
	if period == nil || period.Status != periodOpen {
		return financeErr(http.StatusConflict, "F-PERIOD-CLOSED", "会计期间已关闭，不能执行此操作")
	}
	return nil
}

func jsonText(value any) string {
	data, err := json.Marshal(value)
	if err != nil {
		return "{}"
	}
	return string(data)
}

func decodeBoolMap(value string) map[string]bool {
	result := map[string]bool{}
	if strings.TrimSpace(value) == "" {
		return result
	}
	_ = json.Unmarshal([]byte(value), &result)
	return result
}

func parseMoney(value decimal.Decimal, field string) (decimal.Decimal, error) {
	if value.IsNegative() || !value.Equal(value.Truncate(2)) {
		return decimal.Zero, financeErr(http.StatusBadRequest, "F-INVALID-AMOUNT", field+"必须为非负且最多精确到分的金额")
	}
	return value, nil
}

func parseDateQuery(c *gin.Context, key string, fallback time.Time) (timeutil.Date, bool) {
	raw := strings.TrimSpace(c.Query(key))
	if raw == "" {
		return timeutil.NewDate(fallback), true
	}
	parsed, err := time.ParseInLocation("2006-01-02", raw, timeutil.Loc)
	if err != nil {
		badRequest(c, key+" 日期格式须为 YYYY-MM-DD")
		return timeutil.Date{}, false
	}
	return timeutil.NewDate(parsed), true
}

func (h *Handler) audit(tx *gorm.DB, c *gin.Context, user *model.User, action, resource string, resourceID uint, detail string) error {
	id := ""
	if resourceID != 0 {
		id = strconv.FormatUint(uint64(resourceID), 10)
	}
	return audit.CommitAudited(tx, userID(user), action, resource, id, detail, c.ClientIP())
}

type entryInput struct {
	AccountID    uint            `json:"account_id"`
	Summary      string          `json:"summary"`
	Debit        decimal.Decimal `json:"debit"`
	Credit       decimal.Decimal `json:"credit"`
	AuxDetail    map[string]any  `json:"aux_detail"`
	CashflowItem *string         `json:"cashflow_item"`
}

func validateEntryAmounts(lines []entryInput) (decimal.Decimal, decimal.Decimal, error) {
	if len(lines) < 2 {
		return decimal.Zero, decimal.Zero, financeErr(http.StatusBadRequest, "F-INVALID-VOUCHER", "凭证至少需要两条分录")
	}
	debitTotal, creditTotal := decimal.Zero, decimal.Zero
	details := make([]map[string]string, 0)
	for index, line := range lines {
		debit, err := parseMoney(line.Debit, fmt.Sprintf("第%d行借方", index+1))
		if err != nil {
			details = append(details, map[string]string{"field": fmt.Sprintf("lines[%d].debit", index), "reason": err.Error()})
			continue
		}
		credit, err := parseMoney(line.Credit, fmt.Sprintf("第%d行贷方", index+1))
		if err != nil {
			details = append(details, map[string]string{"field": fmt.Sprintf("lines[%d].credit", index), "reason": err.Error()})
			continue
		}
		if (debit.Sign() > 0) == (credit.Sign() > 0) {
			details = append(details, map[string]string{"field": fmt.Sprintf("lines[%d]", index), "reason": "借贷金额必须且只能填写一方"})
			continue
		}
		debitTotal = debitTotal.Add(debit)
		creditTotal = creditTotal.Add(credit)
	}
	if len(details) > 0 {
		return decimal.Zero, decimal.Zero, financeErrDetails(http.StatusBadRequest, "F-INVALID-VOUCHER", "凭证分录校验失败", details)
	}
	if debitTotal.Sign() <= 0 || !debitTotal.Equal(creditTotal) {
		return decimal.Zero, decimal.Zero, financeErr(http.StatusBadRequest, "F-UNBALANCED",
			fmt.Sprintf("凭证借贷不平：借方 %s，贷方 %s", debitTotal.StringFixed(2), creditTotal.StringFixed(2)))
	}
	return debitTotal, creditTotal, nil
}

func (h *Handler) validateEntries(bookID uint, lines []entryInput) ([]model.VoucherEntry, decimal.Decimal, decimal.Decimal, error) {
	return h.validateEntriesWith(h.DB, bookID, lines)
}

func (h *Handler) validateEntriesWith(db *gorm.DB, bookID uint, lines []entryInput) ([]model.VoucherEntry, decimal.Decimal, decimal.Decimal, error) {
	debit, credit, err := validateEntryAmounts(lines)
	if err != nil {
		return nil, decimal.Zero, decimal.Zero, err
	}
	entries := make([]model.VoucherEntry, 0, len(lines))
	details := make([]map[string]string, 0)
	for index, line := range lines {
		var account model.Account
		err := db.Where("id = ? AND account_book_id = ?", line.AccountID, bookID).First(&account).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			details = append(details, map[string]string{"field": fmt.Sprintf("lines[%d].account_id", index), "reason": "科目不存在或不属于当前账套"})
			continue
		}
		if err != nil {
			return nil, decimal.Zero, decimal.Zero, err
		}
		if !account.IsActive || !account.IsLeaf {
			details = append(details, map[string]string{"field": fmt.Sprintf("lines[%d].account_id", index), "reason": "只能使用启用的末级科目"})
			continue
		}
		flags, aux := decodeBoolMap(account.AuxFlags), line.AuxDetail
		if aux == nil {
			aux = map[string]any{}
		}
		for flag, label := range map[string]string{"customer": "客户", "vendor": "供应商", "dept": "部门", "employee": "员工", "project": "项目"} {
			if flags[flag] && aux[flag] == nil {
				details = append(details, map[string]string{"field": fmt.Sprintf("lines[%d].aux_detail.%s", index, flag), "reason": "科目要求填写" + label + "辅助核算"})
			}
			if aux[flag] != nil {
				if flag == "dept" && aux[flag] == "fixed-assets" {
					continue
				}
				kind := flag
				if kind == "dept" {
					kind = "department"
				}
				itemID, ok := parseAuxiliaryID(aux[flag])
				if !ok {
					details = append(details, map[string]string{"field": fmt.Sprintf("lines[%d].aux_detail.%s", index, flag), "reason": "辅助资料编号无效"})
					continue
				}
				var count int64
				if err := db.Model(&model.AuxiliaryItem{}).Where("id = ? AND account_book_id = ? AND kind = ? AND is_active = ?", itemID, bookID, kind, true).Count(&count).Error; err != nil {
					return nil, decimal.Zero, decimal.Zero, err
				}
				if count == 0 {
					details = append(details, map[string]string{"field": fmt.Sprintf("lines[%d].aux_detail.%s", index, flag), "reason": "辅助资料不存在、类型不符或不属于当前账套"})
				}
			}
		}
		if flags["cashflow"] && (line.CashflowItem == nil || strings.TrimSpace(*line.CashflowItem) == "") {
			details = append(details, map[string]string{"field": fmt.Sprintf("lines[%d].cashflow_item", index), "reason": "现金类科目必须填写现金流项目"})
		}
		if line.CashflowItem != nil && strings.TrimSpace(*line.CashflowItem) != "" {
			var count int64
			if err := db.Model(&model.AuxiliaryItem{}).Where("account_book_id = ? AND kind = ? AND code = ? AND is_active = ?", bookID, "cashflow", strings.TrimSpace(*line.CashflowItem), true).Count(&count).Error; err != nil {
				return nil, decimal.Zero, decimal.Zero, err
			}
			if count == 0 {
				details = append(details, map[string]string{"field": fmt.Sprintf("lines[%d].cashflow_item", index), "reason": "现金流项目不属于当前账套"})
			}
		}
		entries = append(entries, model.VoucherEntry{
			AccountBookID: bookID, LineNo: index + 1, AccountID: account.ID,
			Summary: strings.TrimSpace(line.Summary), Debit: line.Debit, Credit: line.Credit,
			AuxDetail: jsonText(aux), CashflowItem: line.CashflowItem,
		})
	}
	if len(details) > 0 {
		return nil, decimal.Zero, decimal.Zero, financeErrDetails(http.StatusBadRequest, "F-INVALID-VOUCHER", "凭证分录校验失败", details)
	}
	return entries, debit, credit, nil
}

func RegisterRoutes(r *gin.RouterGroup, db *gorm.DB) {
	h := &Handler{DB: db}
	api := r.Group("/finance", rbac.AuthMiddleware(db), rbac.RequireModule(rbac.ModuleFinance))

	api.POST("/books", h.createBook)
	api.GET("/books", h.listBooks)
	api.GET("/books/recycle-bin/list", h.listDeletedBooks)
	api.GET("/books/:book_id", h.getBook)
	api.DELETE("/books/:book_id", h.deleteBook)
	api.POST("/books/:book_id/restore", h.restoreBook)

	api.GET("/periods", h.listPeriods)
	api.PATCH("/periods/:period_id", h.updatePeriod)
	api.POST("/periods/:period_id/close", h.closePeriodAlias)
	api.PATCH("/periods/:period_id/close", h.closePeriodAlias)
	api.POST("/periods/:period_id/reopen", h.reopenPeriodAlias)
	api.PATCH("/periods/:period_id/reopen", h.reopenPeriodAlias)

	api.GET("/accounts/tree", h.accountTree)
	api.POST("/accounts", h.createAccount)
	api.PATCH("/accounts/:account_id", h.updateAccount)
	api.GET("/opening-balances/check", h.checkOpening)
	api.GET("/opening-balances", h.listOpening)
	api.POST("/opening-balances", h.upsertOpening)

	api.GET("/auxiliary-items", h.listAuxiliary)
	api.POST("/auxiliary-items", h.createAuxiliary)
	api.GET("/account-auxiliaries", h.listAccountAuxiliaries)
	api.POST("/account-auxiliaries", h.createAccountAuxiliary)
	api.DELETE("/account-auxiliaries/:link_id", h.deleteAccountAuxiliary)

	api.GET("/voucher-templates", h.listVoucherTemplates)
	api.POST("/voucher-templates", h.createVoucherTemplate)
	api.POST("/vouchers/from-template", h.createFromTemplate)
	api.POST("/vouchers/import", h.importVouchers)
	api.GET("/vouchers/export", h.exportVouchers)
	api.GET("/project-expenses", h.listProjectExpenses)
	api.POST("/project-expenses/:expense_id/voucher", h.createProjectExpenseVoucher)

	api.GET("/vouchers/gaps", h.voucherGaps)
	api.GET("/vouchers", h.listVouchers)
	api.POST("/vouchers", h.createVoucher)
	api.GET("/vouchers/:voucher_id", h.getVoucher)
	api.PATCH("/vouchers/:voucher_id", h.updateVoucher)
	api.DELETE("/vouchers/:voucher_id", h.deleteVoucher)
	api.POST("/vouchers/:voucher_id/submit", h.submitVoucher)
	api.POST("/vouchers/:voucher_id/approve", h.approveVoucher)
	api.POST("/vouchers/:voucher_id/reject", h.rejectVoucher)
	api.POST("/vouchers/:voucher_id/post", h.postVoucher)
	api.POST("/vouchers/:voucher_id/void", h.voidVoucher)
	api.POST("/vouchers/:voucher_id/reverse", h.reverseVoucher)

	api.POST("/cash-transactions", h.createCashTransaction)
	api.GET("/fixed-assets", h.listFixedAssets)
	api.POST("/fixed-assets", h.createFixedAsset)
	api.POST("/fixed-assets/depreciate", h.depreciateFixedAssets)
	api.POST("/bank-statements/import", h.importBankStatements)
	api.GET("/bank-statements", h.listBankStatements)
	api.POST("/bank-statements/:statement_id/match", h.matchBankStatement)
	api.GET("/bank-reconciliation", h.bankReconciliation)

	api.GET("/receivables", h.listReceivables)
	api.POST("/receivables", h.createReceivable)
	api.GET("/payables", h.listPayables)
	api.POST("/payables", h.createPayable)
	api.POST("/receivable-collections", h.collectReceivables)
	api.POST("/payable-payments", h.payPayables)
	api.GET("/receivables/aging", h.receivableAging)
	api.GET("/payables/aging", h.payableAging)
	api.GET("/receivables/statement", h.receivableStatement)
	api.GET("/payables/statement", h.payableStatement)

	api.GET("/balances", h.balances)
	api.GET("/ledger/general", h.generalLedger)
	api.GET("/ledger/detail", h.detailLedger)
	api.GET("/reports/balance-sheet", h.balanceSheet)
	api.GET("/reports/income", h.incomeStatement)
	api.GET("/reports/cashflow", h.cashflowStatement)

	api.POST("/close/check", h.closeCheck)
	api.POST("/close/run", h.closeRun)
	api.POST("/close/reverse", h.closeReverse)
}

func uploadRows(c *gin.Context, field string) ([][]string, bool) {
	file, header, err := c.Request.FormFile(field)
	if err != nil {
		badRequest(c, "请上传导入文件")
		return nil, false
	}
	defer file.Close()
	if header.Size > maxUploadBytes {
		c.JSON(http.StatusRequestEntityTooLarge, gin.H{"detail": "文件不能超过 12 MiB"})
		return nil, false
	}
	rows, err := excel.ReadRows(header.Filename, file)
	if err != nil {
		badRequest(c, err.Error())
		return nil, false
	}
	if len(rows) < 1 {
		badRequest(c, "导入文件为空")
		return nil, false
	}
	return rows, true
}

func periodBounds(period model.AccountingPeriod) (time.Time, time.Time) {
	return period.StartDate.Time, period.EndDate.Time
}
