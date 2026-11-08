package model

import (
	"digitalprojectmanagement/api/pkg/timeutil"
	"github.com/shopspring/decimal"
)

type AccountBook struct {
	ID              uint               `gorm:"primaryKey" json:"id"`
	Code            string             `gorm:"size:32;unique;not null;index" json:"code"`
	Name            string             `gorm:"size:128;not null" json:"name"`
	BaseCurrency    string             `gorm:"size:3;not null;default:'CNY'" json:"base_currency"`
	Currencies      string             `gorm:"type:json;not null;default:'[\"CNY\"]'" json:"currencies"`
	FiscalYearStart string             `gorm:"size:5;not null;default:'01-01'" json:"fiscal_year_start"`
	Status          string             `gorm:"size:16;not null;default:'active'" json:"status"`
	CreatedBy       *uint              `json:"created_by"`
	CreatedAt       timeutil.DateTime  `gorm:"not null" json:"created_at"`
	DeletedAt       *timeutil.DateTime `gorm:"index" json:"deleted_at"`
	DeletedBy       *uint              `json:"deleted_by"`
}

func (AccountBook) TableName() string { return "account_books" }

type AccountBookMember struct {
	ID            uint              `gorm:"primaryKey" json:"id"`
	AccountBookID uint              `gorm:"not null" json:"account_book_id"`
	UserID        uint              `gorm:"not null;index" json:"user_id"`
	Role          string            `gorm:"size:32;not null;default:'member'" json:"role"`
	CreatedAt     timeutil.DateTime `gorm:"not null" json:"created_at"`
}

func (AccountBookMember) TableName() string { return "account_book_members" }

type AccountingPeriod struct {
	ID            uint               `gorm:"primaryKey" json:"id"`
	AccountBookID uint               `gorm:"not null;index:ix_periods_book_status,priority:1" json:"account_book_id"`
	Year          int                `gorm:"not null" json:"year"`
	Month         int                `gorm:"not null" json:"month"`
	PeriodIndex   int                `gorm:"not null" json:"period_index"`
	IsAdjustment  bool               `gorm:"not null;default:false" json:"is_adjustment"`
	Status        string             `gorm:"size:16;not null;default:'open';index:ix_periods_book_status,priority:2" json:"status"`
	StartDate     timeutil.Date      `gorm:"not null" json:"start_date"`
	EndDate       timeutil.Date      `gorm:"not null" json:"end_date"`
	ClosedBy      *uint              `json:"closed_by"`
	ClosedAt      *timeutil.DateTime `json:"closed_at"`
	Version       int                `gorm:"not null;default:1" json:"version"`
}

func (AccountingPeriod) TableName() string { return "accounting_periods" }

type Account struct {
	ID             uint   `gorm:"primaryKey" json:"id"`
	AccountBookID  uint   `gorm:"not null;index" json:"account_book_id"`
	Code           string `gorm:"size:32;not null" json:"code"`
	Name           string `gorm:"size:128;not null" json:"name"`
	Level          int    `gorm:"not null" json:"level"`
	ParentID       *uint  `json:"parent_id"`
	Direction      string `gorm:"size:1;not null" json:"direction"`
	Category       string `gorm:"size:16;not null" json:"category"`
	AuxFlags       string `gorm:"type:json;not null;default:'{}'" json:"aux_flags"`
	SubjectVersion string `gorm:"size:16;not null;default:'2022'" json:"subject_version"`
	IsLeaf         bool   `gorm:"not null;default:true" json:"is_leaf"`
	IsActive       bool   `gorm:"not null;default:true" json:"is_active"`
}

func (Account) TableName() string { return "accounts" }

type OpeningBalance struct {
	ID            uint            `gorm:"primaryKey" json:"id"`
	AccountBookID uint            `gorm:"not null;index" json:"account_book_id"`
	AccountID     uint            `gorm:"not null" json:"account_id"`
	AuxKey        string          `gorm:"size:128;not null;default:''" json:"aux_key"`
	AuxDetail     string          `gorm:"type:json;not null;default:'{}'" json:"aux_detail"`
	Debit         decimal.Decimal `gorm:"type:numeric(18,2);not null;default:0" json:"debit"`
	Credit        decimal.Decimal `gorm:"type:numeric(18,2);not null;default:0" json:"credit"`
}

func (OpeningBalance) TableName() string { return "opening_balances" }

type AuxiliaryItem struct {
	ID            uint              `gorm:"primaryKey" json:"id"`
	AccountBookID uint              `gorm:"not null;index" json:"account_book_id"`
	Kind          string            `gorm:"size:16;not null" json:"kind"`
	Code          string            `gorm:"size:64;not null" json:"code"`
	Name          string            `gorm:"size:128;not null" json:"name"`
	Metadata      string            `gorm:"column:metadata;type:json;not null;default:'{}'" json:"metadata"`
	IsActive      bool              `gorm:"not null;default:true" json:"is_active"`
	CreatedAt     timeutil.DateTime `gorm:"not null" json:"created_at"`
}

func (AuxiliaryItem) TableName() string { return "auxiliary_items" }

type AccountAuxiliary struct {
	ID              uint `gorm:"primaryKey" json:"id"`
	AccountBookID   uint `gorm:"not null;index" json:"account_book_id"`
	AccountID       uint `gorm:"not null" json:"account_id"`
	AuxiliaryItemID uint `gorm:"not null" json:"auxiliary_item_id"`
}

func (AccountAuxiliary) TableName() string { return "account_auxiliaries" }

type AccountBalance struct {
	ID            uint            `gorm:"primaryKey" json:"id"`
	AccountBookID uint            `gorm:"not null;index" json:"account_book_id"`
	PeriodID      uint            `gorm:"not null" json:"period_id"`
	AccountID     uint            `gorm:"not null;index:ix_account_balances_account,priority:2" json:"account_id"`
	AuxKey        string          `gorm:"size:128;not null;default:''" json:"aux_key"`
	OpeningDebit  decimal.Decimal `gorm:"type:numeric(18,2);not null;default:0" json:"opening_debit"`
	OpeningCredit decimal.Decimal `gorm:"type:numeric(18,2);not null;default:0" json:"opening_credit"`
	DebitTotal    decimal.Decimal `gorm:"type:numeric(18,2);not null;default:0" json:"debit_total"`
	CreditTotal   decimal.Decimal `gorm:"type:numeric(18,2);not null;default:0" json:"credit_total"`
	EndingDebit   decimal.Decimal `gorm:"type:numeric(18,2);not null;default:0" json:"ending_debit"`
	EndingCredit  decimal.Decimal `gorm:"type:numeric(18,2);not null;default:0" json:"ending_credit"`
}

func (AccountBalance) TableName() string { return "account_balances" }

type Voucher struct {
	ID              uint              `gorm:"primaryKey" json:"id"`
	AccountBookID   uint              `gorm:"not null;index" json:"account_book_id"`
	PeriodID        uint              `gorm:"not null" json:"period_id"`
	VoucherNo       string            `gorm:"size:32;not null" json:"voucher_no"`
	VoucherDate     timeutil.Date     `gorm:"not null" json:"voucher_date"`
	Status          string            `gorm:"size:16;not null;default:'draft';index" json:"status"`
	Source          string            `gorm:"size:16;not null;default:'manual'" json:"source"`
	SourceExpenseID *uint             `gorm:"unique" json:"source_expense_id"`
	Summary         string            `gorm:"size:255;not null;default:''" json:"summary"`
	TotalDebit      decimal.Decimal   `gorm:"type:numeric(18,2);not null;default:0" json:"total_debit"`
	TotalCredit     decimal.Decimal   `gorm:"type:numeric(18,2);not null;default:0" json:"total_credit"`
	CreatedBy       *uint             `json:"created_by"`
	ReviewedBy      *uint             `json:"reviewed_by"`
	PostedBy        *uint             `json:"posted_by"`
	VoidedBy        *uint             `json:"voided_by"`
	ReversalOf      *uint             `json:"reversal_of"`
	DecisionReason  string            `gorm:"type:text;not null;default:''" json:"decision_reason"`
	CreatedAt       timeutil.DateTime `gorm:"not null" json:"created_at"`
	UpdatedAt       timeutil.DateTime `gorm:"not null" json:"updated_at"`
	Entries         []VoucherEntry    `gorm:"foreignKey:VoucherID" json:"entries,omitempty"`
}

func (Voucher) TableName() string { return "vouchers" }

type VoucherEntry struct {
	ID            uint            `gorm:"primaryKey" json:"id"`
	AccountBookID uint            `gorm:"not null" json:"account_book_id"`
	VoucherID     uint            `gorm:"not null;index" json:"voucher_id"`
	LineNo        int             `gorm:"not null" json:"line_no"`
	AccountID     uint            `gorm:"not null" json:"account_id"`
	Summary       string          `gorm:"size:255;not null;default:''" json:"summary"`
	Debit         decimal.Decimal `gorm:"type:numeric(18,2);not null;default:0" json:"debit"`
	Credit        decimal.Decimal `gorm:"type:numeric(18,2);not null;default:0" json:"credit"`
	AuxDetail     string          `gorm:"type:json;not null;default:'{}'" json:"aux_detail"`
	CashflowItem  *string         `gorm:"size:32" json:"cashflow_item"`
}

func (VoucherEntry) TableName() string { return "voucher_entries" }

type VoucherTemplate struct {
	ID            uint              `gorm:"primaryKey" json:"id"`
	AccountBookID uint              `gorm:"not null;index" json:"account_book_id"`
	Code          string            `gorm:"size:32;not null" json:"code"`
	Name          string            `gorm:"size:128;not null" json:"name"`
	Lines         string            `gorm:"type:json;not null;default:'[]'" json:"lines"`
	IsActive      bool              `gorm:"not null;default:true" json:"is_active"`
	CreatedBy     *uint             `json:"created_by"`
	CreatedAt     timeutil.DateTime `gorm:"not null" json:"created_at"`
}

func (VoucherTemplate) TableName() string { return "voucher_templates" }

type CashTransaction struct {
	ID              uint              `gorm:"primaryKey" json:"id"`
	AccountBookID   uint              `gorm:"not null;index" json:"account_book_id"`
	PeriodID        uint              `gorm:"not null" json:"period_id"`
	Kind            string            `gorm:"size:16;not null" json:"kind"`
	TransactionDate timeutil.Date     `gorm:"not null" json:"transaction_date"`
	Amount          decimal.Decimal   `gorm:"type:numeric(18,2);not null" json:"amount"`
	AccountID       uint              `gorm:"not null" json:"account_id"`
	OffsetAccountID uint              `gorm:"not null" json:"offset_account_id"`
	Summary         string            `gorm:"size:255;not null;default:''" json:"summary"`
	Counterparty    string            `gorm:"size:128;not null;default:''" json:"counterparty"`
	CashflowItem    *string           `gorm:"size:32" json:"cashflow_item"`
	Status          string            `gorm:"size:16;not null;default:'draft'" json:"status"`
	VoucherID       *uint             `json:"voucher_id"`
	CreatedBy       *uint             `json:"created_by"`
	CreatedAt       timeutil.DateTime `gorm:"not null" json:"created_at"`
}

func (CashTransaction) TableName() string { return "cash_transactions" }

type BankStatement struct {
	ID               uint               `gorm:"primaryKey" json:"id"`
	AccountBookID    uint               `gorm:"not null;index" json:"account_book_id"`
	PeriodID         uint               `gorm:"not null" json:"period_id"`
	ExternalID       string             `gorm:"size:128;not null" json:"external_id"`
	TransactionDate  timeutil.Date      `gorm:"not null" json:"transaction_date"`
	Direction        string             `gorm:"size:16;not null" json:"direction"`
	Amount           decimal.Decimal    `gorm:"type:numeric(18,2);not null" json:"amount"`
	AccountCode      string             `gorm:"size:32;not null;default:''" json:"account_code"`
	Summary          string             `gorm:"size:255;not null;default:''" json:"summary"`
	Counterparty     string             `gorm:"size:128;not null;default:''" json:"counterparty"`
	Status           string             `gorm:"size:16;not null;default:'unmatched'" json:"status"`
	MatchedVoucherID *uint              `json:"matched_voucher_id"`
	MatchedAt        *timeutil.DateTime `json:"matched_at"`
	MatchedBy        *uint              `json:"matched_by"`
	CreatedBy        *uint              `json:"created_by"`
	CreatedAt        timeutil.DateTime  `gorm:"not null" json:"created_at"`
}

func (BankStatement) TableName() string { return "bank_statements" }

type FixedAsset struct {
	ID                      uint              `gorm:"primaryKey" json:"id"`
	AccountBookID           uint              `gorm:"not null;index" json:"account_book_id"`
	Code                    string            `gorm:"size:64;not null" json:"code"`
	Name                    string            `gorm:"size:128;not null" json:"name"`
	Category                string            `gorm:"size:64;not null;default:''" json:"category"`
	AcquisitionDate         timeutil.Date     `gorm:"not null" json:"acquisition_date"`
	OriginalCost            decimal.Decimal   `gorm:"type:numeric(18,2);not null" json:"original_cost"`
	ResidualRate            decimal.Decimal   `gorm:"type:numeric(8,6);not null;default:0" json:"residual_rate"`
	UsefulLifeMonths        int               `gorm:"not null" json:"useful_life_months"`
	AssetAccountID          uint              `gorm:"not null" json:"asset_account_id"`
	DepreciationAccountID   uint              `gorm:"not null" json:"depreciation_account_id"`
	ExpenseAccountID        uint              `gorm:"not null" json:"expense_account_id"`
	AccumulatedDepreciation decimal.Decimal   `gorm:"type:numeric(18,2);not null;default:0" json:"accumulated_depreciation"`
	Status                  string            `gorm:"size:16;not null;default:'active'" json:"status"`
	CreatedBy               *uint             `json:"created_by"`
	CreatedAt               timeutil.DateTime `gorm:"not null" json:"created_at"`
}

func (FixedAsset) TableName() string { return "fixed_assets" }

type AssetDepreciation struct {
	ID            uint              `gorm:"primaryKey" json:"id"`
	AccountBookID uint              `gorm:"not null" json:"account_book_id"`
	PeriodID      uint              `gorm:"not null" json:"period_id"`
	AssetID       uint              `gorm:"not null;index" json:"asset_id"`
	Amount        decimal.Decimal   `gorm:"type:numeric(18,2);not null" json:"amount"`
	VoucherID     *uint             `json:"voucher_id"`
	CreatedBy     *uint             `json:"created_by"`
	CreatedAt     timeutil.DateTime `gorm:"not null" json:"created_at"`
}

func (AssetDepreciation) TableName() string { return "asset_depreciations" }

type ARAPTransaction struct {
	ID              uint              `gorm:"primaryKey" json:"id"`
	AccountBookID   uint              `gorm:"not null;index" json:"account_book_id"`
	PeriodID        uint              `gorm:"not null" json:"period_id"`
	Direction       string            `gorm:"size:16;not null" json:"direction"`
	CounterpartyKind string           `gorm:"size:16;not null" json:"counterparty_kind"`
	CounterpartyID  uint              `gorm:"not null" json:"counterparty_id"`
	TransactionDate timeutil.Date     `gorm:"not null" json:"transaction_date"`
	DueDate         timeutil.Date     `gorm:"not null" json:"due_date"`
	Amount          decimal.Decimal   `gorm:"type:numeric(18,2);not null" json:"amount"`
	AppliedAmount   decimal.Decimal   `gorm:"type:numeric(18,2);not null;default:0" json:"applied_amount"`
	AccountID       uint              `gorm:"not null" json:"account_id"`
	VoucherID       *uint             `json:"voucher_id"`
	Summary         string            `gorm:"size:255;not null;default:''" json:"summary"`
	Status          string            `gorm:"size:16;not null;default:'open'" json:"status"`
	CreatedBy       *uint             `json:"created_by"`
	CreatedAt       timeutil.DateTime `gorm:"not null" json:"created_at"`
}

func (ARAPTransaction) TableName() string { return "arap_transactions" }

type ARAPAllocation struct {
	ID                uint               `gorm:"primaryKey" json:"id"`
	AccountBookID     uint               `gorm:"not null;index" json:"account_book_id"`
	PeriodID          uint               `gorm:"not null" json:"period_id"`
	SourceID          uint               `gorm:"not null" json:"source_id"`
	TargetID          uint               `gorm:"not null" json:"target_id"`
	Amount            decimal.Decimal    `gorm:"type:numeric(18,2);not null" json:"amount"`
	CreatedBy         *uint              `json:"created_by"`
	CreatedAt         timeutil.DateTime  `gorm:"not null" json:"created_at"`
	ReleasedAt        *timeutil.DateTime `json:"released_at"`
	ReleaseReason     string             `gorm:"type:text;not null;default:''" json:"release_reason"`
	ReleaseVoucherID  *uint              `json:"release_voucher_id"`
}

func (ARAPAllocation) TableName() string { return "arap_allocations" }
