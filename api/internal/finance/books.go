package finance

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"digitalprojectmanagement/api/internal/model"
	"digitalprojectmanagement/api/pkg/audit"
	"digitalprojectmanagement/api/pkg/timeutil"
	"github.com/gin-gonic/gin"
	"github.com/shopspring/decimal"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

type bookInput struct {
	Code         string `json:"code" binding:"required,max=32"`
	Name         string `json:"name" binding:"required,max=128"`
	BaseCurrency string `json:"base_currency"`
}

type bookDeleteInput struct {
	ConfirmationCode      string `json:"confirmation_code" binding:"required,max=32"`
	AcknowledgedRetention bool   `json:"acknowledged_retention"`
}

type periodStatusInput struct {
	Status string `json:"status" binding:"required"`
}

type accountInput struct {
	Code      string          `json:"code" binding:"required,min=4,max=32"`
	Name      string          `json:"name" binding:"required,max=128"`
	Direction string          `json:"direction" binding:"required"`
	Category  string          `json:"category" binding:"required"`
	ParentID  *uint           `json:"parent_id"`
	AuxFlags  map[string]bool `json:"aux_flags"`
}

type accountPatchInput struct {
	Name      *string         `json:"name"`
	Direction *string         `json:"direction"`
	Category  *string         `json:"category"`
	AuxFlags  map[string]bool `json:"aux_flags"`
	IsActive  *bool           `json:"is_active"`
	Active    *bool           `json:"active"`
}

type openingInput struct {
	AccountID uint            `json:"account_id" binding:"required"`
	AuxKey    string          `json:"aux_key"`
	AuxDetail map[string]any  `json:"aux_detail"`
	Debit     decimal.Decimal `json:"debit"`
	Credit    decimal.Decimal `json:"credit"`
}

type auxiliaryInput struct {
	Kind     string         `json:"kind" binding:"required"`
	Code     string         `json:"code" binding:"required,max=64"`
	Name     string         `json:"name" binding:"required,max=128"`
	Metadata map[string]any `json:"metadata"`
}

type accountAuxiliaryInput struct {
	AccountID       uint `json:"account_id" binding:"required"`
	AuxiliaryItemID uint `json:"auxiliary_item_id" binding:"required"`
}

type seededAccount struct {
	code, name, direction, category, parent string
	flags                                   map[string]bool
}

var defaultAccounts = []seededAccount{
	{"1001", "库存现金", "D", "资产", "", map[string]bool{"cashflow": true}},
	{"1002", "银行存款", "D", "资产", "", map[string]bool{"cashflow": true}},
	{"100201", "银行存款-基本户", "D", "资产", "1002", map[string]bool{"cashflow": true}},
	{"10020101", "银行存款-基本户-人民币", "D", "资产", "100201", map[string]bool{"cashflow": true}},
	{"1012", "其他货币资金", "D", "资产", "", map[string]bool{"cashflow": true}},
	{"1101", "交易性金融资产", "D", "资产", "", nil},
	{"1121", "应收票据", "D", "资产", "", nil},
	{"1122", "应收账款", "D", "资产", "", map[string]bool{"customer": true}},
	{"112201", "应收账款-国内客户", "D", "资产", "1122", map[string]bool{"customer": true}},
	{"11220101", "应收账款-国内客户-一般客户", "D", "资产", "112201", map[string]bool{"customer": true}},
	{"1123", "预付账款", "D", "资产", "", map[string]bool{"vendor": true}},
	{"1221", "其他应收款", "D", "资产", "", nil},
	{"1231", "坏账准备", "C", "资产", "", nil},
	{"1401", "材料采购", "D", "资产", "", nil},
	{"1403", "原材料", "D", "资产", "", nil},
	{"1405", "库存商品", "D", "资产", "", nil},
	{"1471", "存货跌价准备", "C", "资产", "", nil},
	{"1501", "持有至到期投资", "D", "资产", "", nil},
	{"1511", "长期股权投资", "D", "资产", "", nil},
	{"1601", "固定资产", "D", "资产", "", nil},
	{"1602", "累计折旧", "C", "资产", "", nil},
	{"1603", "固定资产减值准备", "C", "资产", "", nil},
	{"1604", "在建工程", "D", "资产", "", nil},
	{"1701", "无形资产", "D", "资产", "", nil},
	{"1702", "累计摊销", "C", "资产", "", nil},
	{"1801", "长期待摊费用", "D", "资产", "", nil},
	{"1901", "待处理财产损溢", "D", "资产", "", nil},
	{"2001", "短期借款", "C", "负债", "", nil},
	{"2201", "应付票据", "C", "负债", "", nil},
	{"2202", "应付账款", "C", "负债", "", map[string]bool{"vendor": true}},
	{"220201", "应付账款-国内供应商", "C", "负债", "2202", map[string]bool{"vendor": true}},
	{"22020101", "应付账款-国内供应商-一般供应商", "C", "负债", "220201", map[string]bool{"vendor": true}},
	{"2203", "预收账款", "C", "负债", "", nil},
	{"2211", "应付职工薪酬", "C", "负债", "", nil},
	{"2221", "应交税费", "C", "负债", "", nil},
	{"222101", "应交税费-应交增值税", "C", "负债", "2221", nil},
	{"22210101", "应交税费-增值税进项税额", "C", "负债", "222101", nil},
	{"2231", "应付利息", "C", "负债", "", nil},
	{"2241", "其他应付款", "C", "负债", "", nil},
	{"2401", "递延收益", "C", "负债", "", nil},
	{"2501", "长期借款", "C", "负债", "", nil},
	{"2801", "预计负债", "C", "负债", "", nil},
	{"2901", "递延所得税负债", "C", "负债", "", nil},
	{"3001", "实收资本", "C", "权益", "", nil},
	{"3002", "资本公积", "C", "权益", "", nil},
	{"3101", "盈余公积", "C", "权益", "", nil},
	{"3103", "本年利润", "C", "权益", "", nil},
	{"3104", "利润分配", "C", "权益", "", nil},
	{"4001", "生产成本", "D", "成本", "", nil},
	{"4101", "制造费用", "D", "成本", "", nil},
	{"5001", "开发成本", "D", "成本", "", nil},
	{"5101", "研发支出", "D", "成本", "", nil},
	{"6001", "主营业务收入", "C", "损益", "", nil},
	{"6051", "其他业务收入", "C", "损益", "", nil},
	{"6101", "公允价值变动损益", "C", "损益", "", nil},
	{"6111", "投资收益", "C", "损益", "", nil},
	{"6301", "营业外收入", "C", "损益", "", nil},
	{"6401", "主营业务成本", "D", "成本", "", nil},
	{"6402", "其他业务成本", "D", "成本", "", nil},
	{"6601", "销售费用", "D", "损益", "", map[string]bool{"dept": true}},
	{"6602", "管理费用", "D", "损益", "", map[string]bool{"dept": true}},
	{"660201", "管理费用-办公费", "D", "损益", "6602", map[string]bool{"dept": true}},
	{"66020101", "管理费用-办公费-日常", "D", "损益", "660201", map[string]bool{"dept": true}},
	{"6603", "财务费用", "D", "损益", "", map[string]bool{"dept": true}},
	{"6711", "营业外支出", "D", "损益", "", nil},
	{"6801", "所得税费用", "D", "损益", "", nil},
	{"6901", "以前年度损益调整", "D", "损益", "", nil},
}

func periodDates(year, month int) (time.Time, time.Time) {
	first := time.Date(year, time.Month(month), 1, 0, 0, 0, 0, timeutil.Loc)
	last := first.AddDate(0, 1, -1)
	return first, last
}

func serializeBook(book model.AccountBook) gin.H {
	currencies := []string{"CNY"}
	if book.Currencies != "" {
		_ = json.Unmarshal([]byte(book.Currencies), &currencies)
	}
	return gin.H{
		"id": book.ID, "code": book.Code, "name": book.Name,
		"base_currency": book.BaseCurrency, "currencies": currencies, "status": book.Status,
	}
}

func seedBook(tx *gorm.DB, bookID uint) error {
	byCode := make(map[string]model.Account, len(defaultAccounts))
	for _, seed := range defaultAccounts {
		var parentID *uint
		if seed.parent != "" {
			parent, ok := byCode[seed.parent]
			if !ok {
				return fmt.Errorf("default account parent %s is missing", seed.parent)
			}
			parentID = &parent.ID
		}
		row := model.Account{
			AccountBookID: bookID, Code: seed.code, Name: seed.name,
			Level: len(seed.code)/2 - 1, ParentID: parentID,
			Direction: seed.direction, Category: seed.category,
			AuxFlags: jsonText(seed.flags), SubjectVersion: "2022",
			IsLeaf: true, IsActive: true,
		}
		if err := tx.Create(&row).Error; err != nil {
			return err
		}
		if parentID != nil {
			if err := tx.Model(&model.Account{}).Where("id = ?", *parentID).Update("is_leaf", false).Error; err != nil {
				return err
			}
		}
		byCode[seed.code] = row
	}
	return nil
}

func (h *Handler) createBook(c *gin.Context) {
	user := currentUser(c)
	if user == nil {
		return
	}
	var input bookInput
	if !bindJSON(c, &input) {
		return
	}
	code, name := strings.TrimSpace(input.Code), strings.TrimSpace(input.Name)
	currency := strings.ToUpper(strings.TrimSpace(input.BaseCurrency))
	if currency == "" {
		currency = "CNY"
	}
	if code == "" || name == "" {
		badRequest(c, "账套编码和名称不能为空")
		return
	}
	if currency != "CNY" {
		writeError(c, financeErr(http.StatusBadRequest, "F-BOOK-CURRENCY", "财务账套仅支持人民币（CNY）"), "")
		return
	}
	var created model.AccountBook
	err := h.DB.Transaction(func(tx *gorm.DB) error {
		var count int64
		if err := tx.Model(&model.AccountBook{}).Where("code = ?", code).Count(&count).Error; err != nil {
			return err
		}
		if count > 0 {
			return financeErr(http.StatusConflict, "F-NO-BOOK-ACCESS", "账套 code 已存在")
		}
		created = model.AccountBook{
			Code: code, Name: name, BaseCurrency: currency, Currencies: `["CNY"]`,
			FiscalYearStart: "01-01", Status: "active", CreatedBy: userID(user),
			CreatedAt: timeutil.NowDateTime(),
		}
		if err := tx.Create(&created).Error; err != nil {
			return err
		}
		now := timeutil.AppNow()
		for month := 1; month <= 12; month++ {
			start, end := periodDates(now.Year(), month)
			period := model.AccountingPeriod{
				AccountBookID: created.ID, Year: now.Year(), Month: month,
				PeriodIndex: now.Year()*100 + month,
				StartDate:   timeutil.NewDate(start), EndDate: timeutil.NewDate(end),
				Status: periodOpen, Version: 1,
			}
			if err := tx.Create(&period).Error; err != nil {
				return err
			}
		}
		if err := seedBook(tx, created.ID); err != nil {
			return err
		}
		return audit.CommitAudited(tx, userID(user), "create", "account_book", strconv.FormatUint(uint64(created.ID), 10), code, c.ClientIP())
	})
	if err != nil {
		writeError(c, err, "账套创建失败")
		return
	}
	c.JSON(http.StatusCreated, serializeBook(created))
}

func (h *Handler) listBooks(c *gin.Context) {
	var books []model.AccountBook
	if err := h.DB.Where("deleted_at IS NULL").Order("id").Find(&books).Error; err != nil {
		writeError(c, err, "读取账套失败")
		return
	}
	result := make([]gin.H, 0, len(books))
	for _, book := range books {
		result = append(result, serializeBook(book))
	}
	c.JSON(http.StatusOK, result)
}

func (h *Handler) listDeletedBooks(c *gin.Context) {
	var books []model.AccountBook
	if err := h.DB.Where("deleted_at IS NOT NULL").Order("deleted_at DESC, id DESC").Find(&books).Error; err != nil {
		writeError(c, err, "读取回收站失败")
		return
	}
	result := make([]gin.H, 0, len(books))
	for _, book := range books {
		item := serializeBook(book)
		item["deleted_at"], item["deleted_by"] = book.DeletedAt, book.DeletedBy
		result = append(result, item)
	}
	c.JSON(http.StatusOK, result)
}

func (h *Handler) getBook(c *gin.Context) {
	id, ok := parseID(c, "book_id")
	if !ok {
		return
	}
	var book model.AccountBook
	if err := h.DB.Where("id = ? AND deleted_at IS NULL", id).First(&book).Error; err != nil {
		writeError(c, err, "账套不存在")
		return
	}
	c.JSON(http.StatusOK, serializeBook(book))
}

func (h *Handler) deleteBook(c *gin.Context) {
	user := currentUser(c)
	if user == nil {
		return
	}
	id, ok := parseID(c, "book_id")
	if !ok {
		return
	}
	var input bookDeleteInput
	if !bindJSON(c, &input) {
		return
	}
	var book model.AccountBook
	err := h.DB.Transaction(func(tx *gorm.DB) error {
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("id = ? AND deleted_at IS NULL", id).First(&book).Error; err != nil {
			return err
		}
		if strings.TrimSpace(input.ConfirmationCode) != book.Code || !input.AcknowledgedRetention {
			return financeErr(http.StatusBadRequest, "F-BOOK-DELETE-CONFIRM", "账套编码确认不匹配，或未确认数据保留与恢复")
		}
		now := timeutil.NowDateTime()
		if err := tx.Model(&book).Updates(map[string]any{"deleted_at": now, "deleted_by": user.ID}).Error; err != nil {
			return err
		}
		book.DeletedAt, book.DeletedBy = &now, userID(user)
		return audit.CommitAudited(tx, userID(user), "soft_delete", "account_book", strconv.FormatUint(uint64(id), 10), "移入回收站："+book.Code, c.ClientIP())
	})
	if err != nil {
		writeError(c, err, "账套不存在或删除失败")
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "id": id, "deleted_at": book.DeletedAt})
}

func (h *Handler) restoreBook(c *gin.Context) {
	user := currentUser(c)
	if user == nil {
		return
	}
	id, ok := parseID(c, "book_id")
	if !ok {
		return
	}
	var book model.AccountBook
	err := h.DB.Transaction(func(tx *gorm.DB) error {
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("id = ? AND deleted_at IS NOT NULL", id).First(&book).Error; err != nil {
			return err
		}
		if err := tx.Model(&book).Updates(map[string]any{"deleted_at": nil, "deleted_by": nil}).Error; err != nil {
			return err
		}
		book.DeletedAt, book.DeletedBy = nil, nil
		return audit.CommitAudited(tx, userID(user), "restore", "account_book", strconv.FormatUint(uint64(id), 10), "恢复账套："+book.Code, c.ClientIP())
	})
	if err != nil {
		writeError(c, err, "回收站中不存在该账套")
		return
	}
	c.JSON(http.StatusOK, serializeBook(book))
}

func (h *Handler) listPeriods(c *gin.Context) {
	book, ok := h.book(c)
	if !ok {
		return
	}
	query := h.DB.Where("account_book_id = ?", book.ID)
	if raw := c.Query("year"); raw != "" {
		year, err := strconv.Atoi(raw)
		if err != nil || year < 1 || year > 9999 {
			badRequest(c, "year 须为 1-9999")
			return
		}
		query = query.Where("year = ?", year)
	}
	var rows []model.AccountingPeriod
	if err := query.Order("period_index").Find(&rows).Error; err != nil {
		writeError(c, err, "读取会计期间失败")
		return
	}
	result := make([]gin.H, 0, len(rows))
	for _, row := range rows {
		result = append(result, gin.H{
			"id": row.ID, "year": row.Year, "month": row.Month,
			"period": fmt.Sprintf("%04d-%02d", row.Year, row.Month),
			"status": row.Status, "start_date": row.StartDate, "end_date": row.EndDate, "version": row.Version,
		})
	}
	c.JSON(http.StatusOK, result)
}

func (h *Handler) updatePeriod(c *gin.Context) {
	user := currentUser(c)
	if user == nil {
		return
	}
	book, ok := h.book(c)
	if !ok {
		return
	}
	id, ok := parseID(c, "period_id")
	if !ok {
		return
	}
	var input periodStatusInput
	if !bindJSON(c, &input) {
		return
	}
	if input.Status != periodOpen && input.Status != periodClosed && input.Status != "locked" {
		badRequest(c, "期间状态只能为 open、closed 或 locked")
		return
	}
	if err := h.changePeriodStatus(c, user, book, id, input.Status); err != nil {
		writeError(c, err, "更新会计期间失败")
		return
	}
	var row model.AccountingPeriod
	if err := h.DB.Where("id = ? AND account_book_id = ?", id, book.ID).First(&row).Error; err != nil {
		writeError(c, err, "读取会计期间失败")
		return
	}
	c.JSON(http.StatusOK, gin.H{"id": row.ID, "status": row.Status, "version": row.Version})
}

func (h *Handler) closePeriodAlias(c *gin.Context) {
	h.periodAlias(c, periodClosed)
}

func (h *Handler) reopenPeriodAlias(c *gin.Context) {
	h.periodAlias(c, periodOpen)
}

func (h *Handler) periodAlias(c *gin.Context, status string) {
	user := currentUser(c)
	if user == nil {
		return
	}
	book, ok := h.book(c)
	if !ok {
		return
	}
	id, ok := parseID(c, "period_id")
	if !ok {
		return
	}
	if err := h.changePeriodStatus(c, user, book, id, status); err != nil {
		writeError(c, err, "更新会计期间失败")
		return
	}
	var row model.AccountingPeriod
	if err := h.DB.Where("id = ? AND account_book_id = ?", id, book.ID).First(&row).Error; err != nil {
		writeError(c, err, "读取会计期间失败")
		return
	}
	c.JSON(http.StatusOK, gin.H{"id": row.ID, "status": row.Status, "version": row.Version})
}

func (h *Handler) changePeriodStatus(c *gin.Context, user *model.User, book *model.AccountBook, id uint, target string) error {
	return h.DB.Transaction(func(tx *gorm.DB) error {
		var row model.AccountingPeriod
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("id = ? AND account_book_id = ?", id, book.ID).First(&row).Error; err != nil {
			return err
		}
		allowed := map[string]map[string]bool{
			"open":   {"open": true, "closed": true},
			"closed": {"closed": true, "locked": true, "open": true},
			"locked": {"locked": true},
		}
		if !allowed[row.Status][target] {
			return financeErr(http.StatusBadRequest, "F-PERIOD-CLOSED", "期间状态只能按 open→closed→locked 流转")
		}
		if raw := strings.Trim(strings.TrimSpace(c.GetHeader("If-Match")), `"`); raw != "" {
			version, err := strconv.Atoi(raw)
			if err != nil {
				return financeErr(http.StatusBadRequest, "F-PERIOD-CLOSED", "If-Match 必须为期间 version")
			}
			if version != row.Version {
				return financeErr(http.StatusConflict, "F-PERIOD-CLOSED", "期间已被其他请求更新，请刷新后重试")
			}
		}
		if row.Status == "locked" && target != "locked" {
			return financeErr(http.StatusBadRequest, "F-PERIOD-CLOSED", "已锁定期间不能重新打开或结账")
		}
		if row.Status == periodClosed && target == periodOpen {
			if !strings.EqualFold(c.GetHeader("X-Reopen-Period"), "confirm") {
				return financeErr(http.StatusBadRequest, "F-PERIOD-CLOSED", "已结账期间不能直接重新打开；反结账需二次确认")
			}
			var later model.AccountingPeriod
			err := tx.Where("account_book_id = ? AND period_index > ? AND status <> ?", book.ID, row.PeriodIndex, periodOpen).Order("period_index").First(&later).Error
			if err == nil {
				return financeErr(http.StatusBadRequest, "F-REVERSE-ORDER", "反结账必须按期间倒序，后一期间尚未打开")
			}
			if err != nil && err != gorm.ErrRecordNotFound {
				return err
			}
		}
		if target == "locked" && row.Status != periodClosed {
			return financeErr(http.StatusBadRequest, "F-PERIOD-CLOSED", "只能锁定已结账期间")
		}
		updates := map[string]any{"status": target, "version": row.Version + 1}
		if target == periodClosed || target == "locked" {
			updates["closed_by"] = user.ID
			if row.ClosedAt == nil {
				now := timeutil.NowDateTime()
				updates["closed_at"] = now
			}
		} else {
			updates["closed_by"], updates["closed_at"] = nil, nil
		}
		if err := tx.Model(&row).Updates(updates).Error; err != nil {
			return err
		}
		return audit.CommitAudited(tx, userID(user), "update", "accounting_period", strconv.FormatUint(uint64(row.ID), 10), target, c.ClientIP())
	})
}

func (h *Handler) accountTree(c *gin.Context) {
	book, ok := h.book(c)
	if !ok {
		return
	}
	var rows []model.Account
	if err := h.DB.Where("account_book_id = ?", book.ID).Order("code").Find(&rows).Error; err != nil {
		writeError(c, err, "读取科目树失败")
		return
	}
	result := make([]gin.H, 0, len(rows))
	for _, row := range rows {
		result = append(result, gin.H{
			"id": row.ID, "code": row.Code, "name": row.Name, "level": row.Level,
			"parent_id": row.ParentID, "direction": row.Direction, "category": row.Category,
			"subject_version": row.SubjectVersion, "aux_flags": decodeBoolMap(row.AuxFlags),
			"is_leaf": row.IsLeaf, "is_active": row.IsActive,
		})
	}
	c.JSON(http.StatusOK, result)
}

func validateAccountInput(input accountInput) error {
	if input.Direction != "D" && input.Direction != "C" {
		return financeErr(http.StatusBadRequest, "F-ACCT-INACTIVE", "科目方向必须为 D 或 C")
	}
	if !accountCategories[input.Category] {
		return financeErr(http.StatusBadRequest, "F-ACCT-INACTIVE", "科目类别不合法")
	}
	if len(input.Code) != 4 && len(input.Code) != 6 && len(input.Code) != 8 && len(input.Code) != 10 {
		return financeErr(http.StatusBadRequest, "F-ACCT-INACTIVE", "科目编码必须符合 4-2-2 层级")
	}
	allowedFlags := map[string]bool{"customer": true, "vendor": true, "dept": true, "employee": true, "project": true, "cashflow": true}
	for key := range input.AuxFlags {
		if !allowedFlags[key] {
			return financeErr(http.StatusBadRequest, "F-ACCT-INACTIVE", "辅助核算开关包含不支持的维度")
		}
	}
	return nil
}

func (h *Handler) createAccount(c *gin.Context) {
	user := currentUser(c)
	if user == nil {
		return
	}
	book, ok := h.book(c)
	if !ok {
		return
	}
	var input accountInput
	if !bindJSON(c, &input) {
		return
	}
	input.Code, input.Name = strings.TrimSpace(input.Code), strings.TrimSpace(input.Name)
	if input.AuxFlags == nil {
		input.AuxFlags = map[string]bool{}
	}
	if input.Name == "" {
		badRequest(c, "科目名称不能为空")
		return
	}
	if err := validateAccountInput(input); err != nil {
		writeError(c, err, "科目信息无效")
		return
	}
	var created model.Account
	err := h.DB.Transaction(func(tx *gorm.DB) error {
		level := len(input.Code)/2 - 1
		var parent model.Account
		if input.ParentID == nil {
			if len(input.Code) != 4 {
				return financeErr(http.StatusBadRequest, "F-ACCT-INACTIVE", "一级科目编码必须为 4 位")
			}
		} else {
			if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("id = ? AND account_book_id = ?", *input.ParentID, book.ID).First(&parent).Error; err != nil {
				return financeErr(http.StatusBadRequest, "F-ACCT-INACTIVE", "父科目不存在或不属于当前账套")
			}
			if !parent.IsActive {
				return financeErr(http.StatusBadRequest, "F-ACCT-INACTIVE", "父科目已停用，不能新增下级")
			}
			if parent.Direction != input.Direction || parent.Category != input.Category {
				return financeErr(http.StatusBadRequest, "F-ACCT-INACTIVE", "父子科目方向和类别必须一致")
			}
			if len(input.Code) != len(parent.Code)+2 || !strings.HasPrefix(input.Code, parent.Code) || level != parent.Level+1 {
				return financeErr(http.StatusBadRequest, "F-ACCT-INACTIVE", "子科目编码必须为父科目编码加两位")
			}
			var openingCount, balanceCount int64
			if err := tx.Model(&model.OpeningBalance{}).Where("account_book_id = ? AND account_id = ? AND (debit <> 0 OR credit <> 0)", book.ID, parent.ID).Count(&openingCount).Error; err != nil {
				return err
			}
			if err := tx.Model(&model.AccountBalance{}).Where("account_book_id = ? AND account_id = ? AND (opening_debit <> 0 OR opening_credit <> 0 OR debit_total <> 0 OR credit_total <> 0 OR ending_debit <> 0 OR ending_credit <> 0)", book.ID, parent.ID).Count(&balanceCount).Error; err != nil {
				return err
			}
			if openingCount+balanceCount > 0 {
				return financeErr(http.StatusBadRequest, "F-ACCT-INACTIVE", "父科目已有余额或发生额，不能新增下级")
			}
		}
		var count int64
		if err := tx.Model(&model.Account{}).Where("account_book_id = ? AND code = ?", book.ID, input.Code).Count(&count).Error; err != nil {
			return err
		}
		if count > 0 {
			return financeErr(http.StatusConflict, "F-ACCT-INACTIVE", "科目编码已存在")
		}
		created = model.Account{
			AccountBookID: book.ID, Code: input.Code, Name: input.Name, Level: level,
			ParentID: input.ParentID, Direction: input.Direction, Category: input.Category,
			AuxFlags: jsonText(input.AuxFlags), SubjectVersion: "2022", IsLeaf: true, IsActive: true,
		}
		if err := tx.Create(&created).Error; err != nil {
			return err
		}
		if input.ParentID != nil {
			if err := tx.Model(&model.Account{}).Where("id = ?", *input.ParentID).Update("is_leaf", false).Error; err != nil {
				return err
			}
		}
		return audit.CommitAudited(tx, userID(user), "create", "account", input.Code, book.Code, c.ClientIP())
	})
	if err != nil {
		writeError(c, err, "创建科目失败")
		return
	}
	c.JSON(http.StatusCreated, gin.H{"id": created.ID, "code": created.Code, "name": created.Name, "level": created.Level, "is_leaf": created.IsLeaf, "is_active": created.IsActive})
}

func (h *Handler) updateAccount(c *gin.Context) {
	user := currentUser(c)
	if user == nil {
		return
	}
	book, ok := h.book(c)
	if !ok {
		return
	}
	id, ok := parseID(c, "account_id")
	if !ok {
		return
	}
	var input accountPatchInput
	if !bindJSON(c, &input) {
		return
	}
	if input.Active != nil && input.IsActive == nil {
		input.IsActive = input.Active
	}
	updates := map[string]any{}
	if input.Name != nil {
		name := strings.TrimSpace(*input.Name)
		if name == "" || len([]rune(name)) > 128 {
			badRequest(c, "科目名称长度须为 1-128")
			return
		}
		updates["name"] = name
	}
	if input.Direction != nil {
		if *input.Direction != "D" && *input.Direction != "C" {
			badRequest(c, "科目方向必须为 D 或 C")
			return
		}
		updates["direction"] = *input.Direction
	}
	if input.Category != nil {
		if !accountCategories[*input.Category] {
			badRequest(c, "科目类别不合法")
			return
		}
		updates["category"] = *input.Category
	}
	if input.AuxFlags != nil {
		if err := validateAccountInput(accountInput{Code: "1001", Direction: "D", Category: "资产", AuxFlags: input.AuxFlags}); err != nil {
			writeError(c, err, "辅助核算开关无效")
			return
		}
		updates["aux_flags"] = jsonText(input.AuxFlags)
	}
	if input.IsActive != nil {
		updates["is_active"] = *input.IsActive
	}
	if len(updates) == 0 {
		badRequest(c, "至少提供一个可修改字段")
		return
	}
	err := h.DB.Transaction(func(tx *gorm.DB) error {
		var account model.Account
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("id = ? AND account_book_id = ?", id, book.ID).First(&account).Error; err != nil {
			return err
		}
		if input.IsActive != nil && !*input.IsActive {
			var childCount, openingCount, balanceCount int64
			if err := tx.Model(&model.Account{}).Where("account_book_id = ? AND parent_id = ?", book.ID, id).Count(&childCount).Error; err != nil {
				return err
			}
			if err := tx.Model(&model.OpeningBalance{}).Where("account_book_id = ? AND account_id = ? AND (debit <> 0 OR credit <> 0)", book.ID, id).Count(&openingCount).Error; err != nil {
				return err
			}
			if err := tx.Model(&model.AccountBalance{}).Where("account_book_id = ? AND account_id = ? AND (opening_debit <> 0 OR opening_credit <> 0 OR debit_total <> 0 OR credit_total <> 0 OR ending_debit <> 0 OR ending_credit <> 0)", book.ID, id).Count(&balanceCount).Error; err != nil {
				return err
			}
			if childCount > 0 || openingCount+balanceCount > 0 {
				return financeErr(http.StatusBadRequest, "F-ACCT-INACTIVE", "科目有下级、余额或本期发生额，不能停用")
			}
		}
		nextDirection, nextCategory := account.Direction, account.Category
		if input.Direction != nil {
			nextDirection = *input.Direction
		}
		if input.Category != nil {
			nextCategory = *input.Category
		}
		if nextDirection != account.Direction || nextCategory != account.Category {
			var childCount, balanceCount int64
			if err := tx.Model(&model.Account{}).Where("account_book_id = ? AND parent_id = ?", book.ID, id).Count(&childCount).Error; err != nil {
				return err
			}
			if err := tx.Model(&model.AccountBalance{}).Where("account_book_id = ? AND account_id = ?", book.ID, id).Count(&balanceCount).Error; err != nil {
				return err
			}
			if childCount+balanceCount > 0 {
				return financeErr(http.StatusBadRequest, "F-ACCT-INACTIVE", "已有下级或余额的科目不能修改方向和类别")
			}
		}
		if err := tx.Model(&account).Updates(updates).Error; err != nil {
			return err
		}
		return audit.CommitAudited(tx, userID(user), "update", "account", strconv.FormatUint(uint64(id), 10), jsonText(updates), c.ClientIP())
	})
	if err != nil {
		writeError(c, err, "更新科目失败")
		return
	}
	var account model.Account
	if err := h.DB.Where("id = ? AND account_book_id = ?", id, book.ID).First(&account).Error; err != nil {
		writeError(c, err, "读取科目失败")
		return
	}
	c.JSON(http.StatusOK, gin.H{"id": account.ID, "name": account.Name, "direction": account.Direction, "category": account.Category, "aux_flags": decodeBoolMap(account.AuxFlags), "is_active": account.IsActive})
}

func (h *Handler) listOpening(c *gin.Context) {
	book, ok := h.book(c)
	if !ok {
		return
	}
	var rows []model.OpeningBalance
	if err := h.DB.Where("account_book_id = ?", book.ID).Order("account_id, aux_key").Find(&rows).Error; err != nil {
		writeError(c, err, "读取期初余额失败")
		return
	}
	result := make([]gin.H, 0, len(rows))
	for _, row := range rows {
		detail := map[string]any{}
		_ = json.Unmarshal([]byte(row.AuxDetail), &detail)
		result = append(result, gin.H{"id": row.ID, "account_id": row.AccountID, "aux_key": row.AuxKey, "aux_detail": detail, "debit": row.Debit.StringFixed(2), "credit": row.Credit.StringFixed(2)})
	}
	c.JSON(http.StatusOK, result)
}

func (h *Handler) upsertOpening(c *gin.Context) {
	user := currentUser(c)
	if user == nil {
		return
	}
	book, ok := h.book(c)
	if !ok {
		return
	}
	var input openingInput
	if !bindJSON(c, &input) {
		return
	}
	if len(input.AuxKey) > 128 {
		badRequest(c, "aux_key 最多 128 个字符")
		return
	}
	debit, err := parseMoney(input.Debit, "借方期初")
	if err != nil {
		writeError(c, err, "期初金额无效")
		return
	}
	credit, err := parseMoney(input.Credit, "贷方期初")
	if err != nil {
		writeError(c, err, "期初金额无效")
		return
	}
	if debit.Sign() > 0 && credit.Sign() > 0 {
		badRequest(c, "期初借贷只能填写一方")
		return
	}
	detail := input.AuxDetail
	if detail == nil {
		detail = map[string]any{}
	}
	var row model.OpeningBalance
	err = h.DB.Transaction(func(tx *gorm.DB) error {
		var account model.Account
		if err := tx.Where("id = ? AND account_book_id = ?", input.AccountID, book.ID).First(&account).Error; err != nil {
			return financeErr(http.StatusBadRequest, "F-ACCT-INACTIVE", "科目不存在或不属于当前账套")
		}
		if !account.IsActive || !account.IsLeaf {
			return financeErr(http.StatusBadRequest, "F-ACCT-INACTIVE", "期初余额只能录入启用的末级科目")
		}
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("account_book_id = ? AND account_id = ? AND aux_key = ?", book.ID, input.AccountID, input.AuxKey).First(&row).Error; err != nil {
			if err != gorm.ErrRecordNotFound {
				return err
			}
			row = model.OpeningBalance{AccountBookID: book.ID, AccountID: input.AccountID, AuxKey: input.AuxKey}
		}
		row.AuxDetail, row.Debit, row.Credit = jsonText(detail), debit, credit
		if row.ID == 0 {
			if err := tx.Create(&row).Error; err != nil {
				return err
			}
		} else if err := tx.Save(&row).Error; err != nil {
			return err
		}
		return audit.CommitAudited(tx, userID(user), "upsert", "opening_balance", strconv.FormatUint(uint64(row.ID), 10), book.Code, c.ClientIP())
	})
	if err != nil {
		writeError(c, err, "录入期初余额失败")
		return
	}
	c.JSON(http.StatusOK, gin.H{"id": row.ID, "debit": row.Debit.StringFixed(2), "credit": row.Credit.StringFixed(2)})
}

func (h *Handler) checkOpening(c *gin.Context) {
	book, ok := h.book(c)
	if !ok {
		return
	}
	var rows []model.OpeningBalance
	if err := h.DB.Where("account_book_id = ?", book.ID).Find(&rows).Error; err != nil {
		writeError(c, err, "期初试算失败")
		return
	}
	debit, credit := decimal.Zero, decimal.Zero
	for _, row := range rows {
		debit = debit.Add(row.Debit)
		credit = credit.Add(row.Credit)
	}
	c.JSON(http.StatusOK, gin.H{"balanced": debit.Equal(credit), "debit": debit.StringFixed(2), "credit": credit.StringFixed(2), "difference": debit.Sub(credit).StringFixed(2)})
}

func auxiliaryJSON(row model.AuxiliaryItem) gin.H {
	metadata := map[string]any{}
	_ = json.Unmarshal([]byte(row.Metadata), &metadata)
	return gin.H{"id": row.ID, "kind": row.Kind, "code": row.Code, "name": row.Name, "metadata": metadata, "is_active": row.IsActive}
}

func (h *Handler) listAuxiliary(c *gin.Context) {
	book, ok := h.book(c)
	if !ok {
		return
	}
	query := h.DB.Where("account_book_id = ?", book.ID)
	if kind := strings.TrimSpace(c.Query("kind")); kind != "" {
		if !auxiliaryKinds[kind] {
			badRequest(c, "辅助资料类型不合法")
			return
		}
		query = query.Where("kind = ?", kind)
	}
	var rows []model.AuxiliaryItem
	if err := query.Order("id").Find(&rows).Error; err != nil {
		writeError(c, err, "读取辅助资料失败")
		return
	}
	result := make([]gin.H, 0, len(rows))
	for _, row := range rows {
		result = append(result, auxiliaryJSON(row))
	}
	c.JSON(http.StatusOK, result)
}

func (h *Handler) createAuxiliary(c *gin.Context) {
	user := currentUser(c)
	if user == nil {
		return
	}
	book, ok := h.book(c)
	if !ok {
		return
	}
	var input auxiliaryInput
	if !bindJSON(c, &input) {
		return
	}
	input.Kind, input.Code, input.Name = strings.TrimSpace(input.Kind), strings.TrimSpace(input.Code), strings.TrimSpace(input.Name)
	if !auxiliaryKinds[input.Kind] || input.Code == "" || input.Name == "" {
		badRequest(c, "辅助资料类型、编码和名称必须有效")
		return
	}
	metadata := input.Metadata
	if metadata == nil {
		metadata = map[string]any{}
	}
	row := model.AuxiliaryItem{AccountBookID: book.ID, Kind: input.Kind, Code: input.Code, Name: input.Name, Metadata: jsonText(metadata), IsActive: true, CreatedAt: timeutil.NowDateTime()}
	err := h.DB.Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(&row).Error; err != nil {
			return err
		}
		return audit.CommitAudited(tx, userID(user), "create", "auxiliary_item", input.Code, book.Code, c.ClientIP())
	})
	if err != nil {
		writeError(c, err, "辅助资料编码已存在或创建失败")
		return
	}
	c.JSON(http.StatusCreated, auxiliaryJSON(row))
}

func (h *Handler) listAccountAuxiliaries(c *gin.Context) {
	book, ok := h.book(c)
	if !ok {
		return
	}
	query := h.DB.Where("account_book_id = ?", book.ID)
	if accountID, ok := queryUint(c, "account_id", false); !ok {
		return
	} else if accountID != 0 {
		query = query.Where("account_id = ?", accountID)
	}
	var rows []model.AccountAuxiliary
	if err := query.Order("id").Find(&rows).Error; err != nil {
		writeError(c, err, "读取科目辅助核算关联失败")
		return
	}
	result := make([]gin.H, 0, len(rows))
	for _, row := range rows {
		result = append(result, gin.H{"id": row.ID, "account_id": row.AccountID, "auxiliary_item_id": row.AuxiliaryItemID})
	}
	c.JSON(http.StatusOK, result)
}

func (h *Handler) createAccountAuxiliary(c *gin.Context) {
	user := currentUser(c)
	if user == nil {
		return
	}
	book, ok := h.book(c)
	if !ok {
		return
	}
	var input accountAuxiliaryInput
	if !bindJSON(c, &input) {
		return
	}
	err := h.DB.Transaction(func(tx *gorm.DB) error {
		var account model.Account
		var item model.AuxiliaryItem
		if err := tx.Where("id = ? AND account_book_id = ?", input.AccountID, book.ID).First(&account).Error; err != nil {
			return financeErr(http.StatusBadRequest, "F-ACCT-INACTIVE", "科目或辅助资料不存在或不属于当前账套")
		}
		if err := tx.Where("id = ? AND account_book_id = ? AND is_active = ?", input.AuxiliaryItemID, book.ID, true).First(&item).Error; err != nil {
			return financeErr(http.StatusBadRequest, "F-ACCT-INACTIVE", "科目或辅助资料不存在或不属于当前账套")
		}
		flag := item.Kind
		if flag == "department" {
			flag = "dept"
		}
		if !decodeBoolMap(account.AuxFlags)[flag] {
			return financeErr(http.StatusBadRequest, "F-ACCT-INACTIVE", "该科目未启用此辅助核算维度")
		}
		var count int64
		if err := tx.Model(&model.AccountAuxiliary{}).Where("account_book_id = ? AND account_id = ? AND auxiliary_item_id = ?", book.ID, account.ID, item.ID).Count(&count).Error; err != nil {
			return err
		}
		if count > 0 {
			return financeErr(http.StatusConflict, "F-ACCT-INACTIVE", "科目辅助核算关联已存在")
		}
		row := model.AccountAuxiliary{AccountBookID: book.ID, AccountID: account.ID, AuxiliaryItemID: item.ID}
		if err := tx.Create(&row).Error; err != nil {
			return err
		}
		if err := audit.CommitAudited(tx, userID(user), "create", "account_auxiliary", strconv.FormatUint(uint64(row.ID), 10), book.Code, c.ClientIP()); err != nil {
			return err
		}
		c.Set("created_account_auxiliary", row)
		return nil
	})
	if err != nil {
		writeError(c, err, "创建科目辅助核算关联失败")
		return
	}
	value, _ := c.Get("created_account_auxiliary")
	row := value.(model.AccountAuxiliary)
	c.JSON(http.StatusCreated, gin.H{"id": row.ID, "account_id": row.AccountID, "auxiliary_item_id": row.AuxiliaryItemID})
}

func (h *Handler) deleteAccountAuxiliary(c *gin.Context) {
	user := currentUser(c)
	if user == nil {
		return
	}
	book, ok := h.book(c)
	if !ok {
		return
	}
	id, ok := parseID(c, "link_id")
	if !ok {
		return
	}
	err := h.DB.Transaction(func(tx *gorm.DB) error {
		var row model.AccountAuxiliary
		if err := tx.Where("id = ? AND account_book_id = ?", id, book.ID).First(&row).Error; err != nil {
			return err
		}
		if err := tx.Delete(&row).Error; err != nil {
			return err
		}
		return audit.CommitAudited(tx, userID(user), "delete", "account_auxiliary", strconv.FormatUint(uint64(id), 10), book.Code, c.ClientIP())
	})
	if err != nil {
		writeError(c, err, "科目辅助核算关联不存在")
		return
	}
	c.JSON(http.StatusOK, gin.H{"deleted": true, "id": id})
}
