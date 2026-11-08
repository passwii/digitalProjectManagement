package model

import (
	"digitalprojectmanagement/api/pkg/timeutil"
	"github.com/shopspring/decimal"
)

type Project struct {
	ID           uint               `gorm:"primaryKey" json:"id"`
	Code         string             `gorm:"size:32;unique;not null;index" json:"code"`
	Name         string             `gorm:"size:128;not null" json:"name"`
	Type         string             `gorm:"size:32;default:'other'" json:"type"`
	Status       string             `gorm:"size:16;default:'draft';index" json:"status"`
	Priority     string             `gorm:"size:16;default:'中'" json:"priority"`
	ClientName   string             `gorm:"size:128;default:''" json:"client_name"`
	OwnerID      *uint              `gorm:"index" json:"owner_id"`
	Owner        *User              `gorm:"foreignKey:OwnerID" json:"owner,omitempty"`
	DeptID       *uint              `gorm:"index" json:"dept_id"`
	Department   *Department        `gorm:"foreignKey:DeptID" json:"dept,omitempty"`
	PlanStart    *timeutil.Date     `json:"plan_start"`
	PlanEnd      *timeutil.Date     `json:"plan_end"`
	BudgetTotal  float64            `gorm:"default:0" json:"budget_total"`
	Progress     float64            `gorm:"default:0" json:"progress"`
	Description  string             `gorm:"type:text" json:"description"`
	CreatedAt    timeutil.DateTime  `json:"created_at"`
	UpdatedAt    timeutil.DateTime  `json:"updated_at"`
	DeletedAt    *timeutil.DateTime `gorm:"index" json:"deleted_at"`
	DeletedBy    *uint              `json:"deleted_by"`
	IsDemo       bool               `gorm:"default:false;not null;index" json:"is_demo"`
	Members      []ProjectMember    `gorm:"foreignKey:ProjectID" json:"members,omitempty"`
}

func (Project) TableName() string { return "projects" }

type ProjectMember struct {
	ProjectID uint  `gorm:"primaryKey" json:"project_id"`
	UserID    uint  `gorm:"primaryKey" json:"user_id"`
	User      *User `gorm:"foreignKey:UserID" json:"user,omitempty"`
}

func (ProjectMember) TableName() string { return "project_members" }

type ProjectChange struct {
	ID        uint              `gorm:"primaryKey" json:"id"`
	ProjectID uint              `gorm:"index" json:"project_id"`
	Field     string            `gorm:"size:64;default:''" json:"field"`
	Old       string            `gorm:"type:text;default:''" json:"old"`
	New       string            `gorm:"type:text;default:''" json:"new"`
	ByID      *uint             `json:"by_id"`
	User      *User             `gorm:"foreignKey:ByID" json:"by,omitempty"`
	At        timeutil.DateTime `json:"at"`
}

func (ProjectChange) TableName() string { return "project_changes" }

type Attachment struct {
	ID             uint              `gorm:"primaryKey" json:"id"`
	ProjectID      *uint             `gorm:"index" json:"project_id"`
	Filename       string            `gorm:"size:255;default:''" json:"filename"`
	Path           string            `gorm:"size:512;default:''" json:"path"`
	Size           int64             `gorm:"default:0" json:"size"`
	ContentType    string            `gorm:"size:128;default:''" json:"content_type"`
	UploadedBy     *uint             `json:"uploaded_by"`
	Uploader       *User             `gorm:"foreignKey:UploadedBy" json:"uploader,omitempty"`
	UploadedAt     timeutil.DateTime `json:"uploaded_at"`
	RefType        string            `gorm:"size:32;default:'';index:ix_attachments_ref,priority:1" json:"ref_type"`
	RefID          *uint             `gorm:"index:ix_attachments_ref,priority:2" json:"ref_id"`
	Category       string            `gorm:"size:32;default:''" json:"category"`
	StorageBackend string            `gorm:"size:16;default:'local'" json:"storage_backend"`
	ObjectKey      string            `gorm:"size:512;default:''" json:"object_key"`
	ETag           string            `gorm:"size:128;default:''" json:"etag"`
}

func (Attachment) TableName() string { return "attachments" }

type Followup struct {
	ID          uint               `gorm:"primaryKey" json:"id"`
	ProjectID   uint               `gorm:"index" json:"project_id"`
	UserID      *uint              `gorm:"index" json:"user_id"`
	User        *User              `gorm:"foreignKey:UserID" json:"user,omitempty"`
	HappenedAt  timeutil.DateTime  `json:"happened_at"`
	Method      string             `gorm:"size:32;default:''" json:"method"`
	Content     string             `gorm:"type:text;default:''" json:"content"`
	NextStep    string             `gorm:"type:text;default:''" json:"next_step"`
	RemindAt    *timeutil.DateTime `gorm:"index" json:"remind_at"`
	RemindState string             `gorm:"size:16;default:'pending';index" json:"remind_state"`
	RemindedAt  *timeutil.DateTime `gorm:"index" json:"reminded_at"`
	HandledAt   *timeutil.DateTime `json:"handled_at"`
	HandledBy   *uint              `json:"handled_by"`
	HandleNote  string             `gorm:"type:text;default:''" json:"handle_note"`
	CreatedAt   timeutil.DateTime  `json:"created_at"`
}

func (Followup) TableName() string { return "followups" }

type Milestone struct {
	ID         uint              `gorm:"primaryKey" json:"id"`
	ProjectID  uint              `gorm:"index:ix_milestones_proj_status,priority:1" json:"project_id"`
	Name       string            `gorm:"size:128;not null" json:"name"`
	PlanDate   *timeutil.Date    `json:"plan_date"`
	ActualDate *timeutil.Date    `json:"actual_date"`
	OwnerID    *uint             `json:"owner_id"`
	Owner      *User             `gorm:"foreignKey:OwnerID" json:"owner,omitempty"`
	Status     string            `gorm:"size:16;default:'open';index:ix_milestones_proj_status,priority:2" json:"status"`
	CreatedAt  timeutil.DateTime `json:"created_at"`
}

func (Milestone) TableName() string { return "milestones" }

type Task struct {
	ID            uint              `gorm:"primaryKey" json:"id"`
	ProjectID     uint              `gorm:"index:ix_tasks_proj_status,priority:1" json:"project_id"`
	ParentID      *uint             `json:"parent_id"`
	Level         int               `gorm:"default:1" json:"level"`
	Name          string            `gorm:"size:128;not null" json:"name"`
	OwnerID       *uint             `json:"owner_id"`
	Owner         *User             `gorm:"foreignKey:OwnerID" json:"owner,omitempty"`
	PlanStart     *timeutil.Date    `json:"plan_start"`
	PlanEnd       *timeutil.Date    `json:"plan_end"`
	Weight        float64           `gorm:"default:1" json:"weight"`
	Progress      float64           `gorm:"default:0" json:"progress"`
	Status        string            `gorm:"size:16;default:'todo';index:ix_tasks_proj_status,priority:2" json:"status"`
	PredecessorID *uint             `json:"predecessor_id"`
	CreatedAt     timeutil.DateTime `json:"created_at"`
	UpdatedAt     timeutil.DateTime `json:"updated_at"`
}

func (Task) TableName() string { return "tasks" }

type ProgressLog struct {
	ID            uint              `gorm:"primaryKey" json:"id"`
	TaskID        uint              `gorm:"index" json:"task_id"`
	ProjectID     uint              `gorm:"index:ix_logs_proj_created,priority:1" json:"project_id"`
	UserID        *uint             `json:"user_id"`
	User          *User             `gorm:"foreignKey:UserID" json:"user,omitempty"`
	Progress      float64           `gorm:"default:0" json:"progress"`
	Note          string            `gorm:"type:text;default:''" json:"note"`
	RemainingDays *int              `json:"remaining_days"`
	CreatedAt     timeutil.DateTime `gorm:"index:ix_logs_proj_created,priority:2" json:"created_at"`
}

func (ProgressLog) TableName() string { return "progress_logs" }

type Budget struct {
	ID          uint              `gorm:"primaryKey" json:"id"`
	ProjectID   uint              `gorm:"index:ix_budgets_proj_subject,priority:1" json:"project_id"`
	Subject     string            `gorm:"size:32;not null;index:ix_budgets_proj_subject,priority:2" json:"subject"`
	Amount      float64           `gorm:"default:0;not null" json:"amount"`
	PeriodStart *timeutil.Date    `json:"period_start"`
	PeriodEnd   *timeutil.Date    `json:"period_end"`
	CreatedAt   timeutil.DateTime `json:"created_at"`
	UpdatedAt   timeutil.DateTime `json:"updated_at"`
}

func (Budget) TableName() string { return "budgets" }

type BudgetAdjust struct {
	ID             uint               `gorm:"primaryKey" json:"id"`
	BudgetID       uint               `json:"budget_id"`
	ProjectID      uint               `json:"project_id"`
	OldAmount      float64            `gorm:"default:0" json:"old_amount"`
	NewAmount      float64            `gorm:"default:0" json:"new_amount"`
	Reason         string             `gorm:"type:text;default:''" json:"reason"`
	Status         string             `gorm:"size:16;default:'pending'" json:"status"`
	ByID           *uint              `json:"by_id"`
	User           *User              `gorm:"foreignKey:ByID" json:"by,omitempty"`
	ApprovedBy     *uint              `json:"approved_by"`
	Approver       *User              `gorm:"foreignKey:ApprovedBy" json:"approver,omitempty"`
	DecisionReason string             `gorm:"type:text;default:''" json:"decision_reason"`
	DecidedAt      *timeutil.DateTime `json:"decided_at"`
	CreatedAt      timeutil.DateTime  `json:"created_at"`
}

func (BudgetAdjust) TableName() string { return "budget_adjusts" }

type Expense struct {
	ID             uint               `gorm:"primaryKey" json:"id"`
	ProjectID      uint               `gorm:"index:ix_expenses_proj_status,priority:1;index:ix_expenses_proj_subject,priority:1" json:"project_id"`
	Subject        string             `gorm:"size:32;default:'';index:ix_expenses_proj_subject,priority:2" json:"subject"`
	Amount         float64            `gorm:"not null" json:"amount"`
	ExpDate        *timeutil.Date     `json:"exp_date"`
	Note           string             `gorm:"type:text;default:''" json:"note"`
	Status         string             `gorm:"size:16;default:'approved';index:ix_expenses_proj_status,priority:2" json:"status"`
	ByID           *uint              `json:"by_id"`
	User           *User              `gorm:"foreignKey:ByID" json:"by,omitempty"`
	ApprovedBy     *uint              `json:"approved_by"`
	Approver       *User              `gorm:"foreignKey:ApprovedBy" json:"approver,omitempty"`
	DecisionReason string             `gorm:"type:text;default:''" json:"decision_reason"`
	DecidedAt      *timeutil.DateTime `json:"decided_at"`
	ResubmitCount  int                `gorm:"default:0" json:"resubmit_count"`
	CreatedAt      timeutil.DateTime  `json:"created_at"`
}

func (Expense) TableName() string { return "expenses" }

type ApprovalRecord struct {
	ID         uint              `gorm:"primaryKey" json:"id"`
	Kind       string            `gorm:"size:32;not null;index:ix_approval_records_ref,priority:1" json:"kind"`
	RefID      uint              `gorm:"not null;index:ix_approval_records_ref,priority:2" json:"ref_id"`
	ProjectID  *uint             `gorm:"index" json:"project_id"`
	Action     string            `gorm:"size:32;default:''" json:"action"`
	FromStatus string            `gorm:"size:16;default:''" json:"from_status"`
	ToStatus   string            `gorm:"size:16;default:''" json:"to_status"`
	ActorID    *uint             `json:"actor_id"`
	Actor      *User             `gorm:"foreignKey:ActorID" json:"actor,omitempty"`
	Reason     string            `gorm:"type:text;default:''" json:"reason"`
	CreatedAt  timeutil.DateTime `gorm:"index;index:ix_approval_records_ref,priority:3" json:"created_at"`
}

func (ApprovalRecord) TableName() string { return "approval_records" }

type ProjectReceivable struct {
	ID             uint                        `gorm:"primaryKey" json:"id"`
	ProjectID      uint                        `gorm:"not null;index" json:"project_id"`
	Name           string                      `gorm:"size:128;not null" json:"name"`
	Amount         decimal.Decimal             `gorm:"type:numeric(18,2);not null" json:"amount"`
	ReceivableDate timeutil.Date               `gorm:"not null" json:"receivable_date"`
	DueDate        timeutil.Date               `gorm:"not null" json:"due_date"`
	Note           string                      `gorm:"type:text;default:'';not null" json:"note"`
	CreatedBy      uint                        `gorm:"not null" json:"created_by"`
	Creator        *User                       `gorm:"foreignKey:CreatedBy" json:"creator,omitempty"`
	UpdatedBy      uint                        `gorm:"not null" json:"updated_by"`
	Updater        *User                       `gorm:"foreignKey:UpdatedBy" json:"updater,omitempty"`
	CreatedAt      timeutil.DateTime           `gorm:"not null" json:"created_at"`
	UpdatedAt      timeutil.DateTime           `gorm:"not null" json:"updated_at"`
	DeletedAt      *timeutil.DateTime          `gorm:"index" json:"deleted_at"`
	DeletedBy      *uint                       `json:"deleted_by"`
	Payments       []ProjectReceivablePayment  `gorm:"foreignKey:ReceivableID" json:"payments,omitempty"`
}

func (ProjectReceivable) TableName() string { return "project_receivables" }

type ProjectReceivablePayment struct {
	ID           uint               `gorm:"primaryKey" json:"id"`
	ProjectID    uint               `gorm:"not null;index" json:"project_id"`
	ReceivableID uint               `gorm:"not null;index" json:"receivable_id"`
	Amount       decimal.Decimal    `gorm:"type:numeric(18,2);not null" json:"amount"`
	PaymentDate  timeutil.Date      `gorm:"not null" json:"payment_date"`
	Note         string             `gorm:"type:text;default:'';not null" json:"note"`
	CreatedBy    uint               `gorm:"not null" json:"created_by"`
	Creator      *User              `gorm:"foreignKey:CreatedBy" json:"creator,omitempty"`
	UpdatedBy    uint               `gorm:"not null" json:"updated_by"`
	Updater      *User              `gorm:"foreignKey:UpdatedBy" json:"updater,omitempty"`
	CreatedAt    timeutil.DateTime  `gorm:"not null" json:"created_at"`
	UpdatedAt    timeutil.DateTime  `gorm:"not null" json:"updated_at"`
	DeletedAt    *timeutil.DateTime `gorm:"index" json:"deleted_at"`
	DeletedBy    *uint              `json:"deleted_by"`
}

func (ProjectReceivablePayment) TableName() string { return "project_receivable_payments" }
