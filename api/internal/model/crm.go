package model

import (
	"digitalprojectmanagement/api/pkg/timeutil"
)

type ContactProfile struct {
	ID                uint              `gorm:"primaryKey" json:"id"`
	UserID            *uint             `gorm:"uniqueIndex" json:"user_id"`
	User              *User             `gorm:"foreignKey:UserID" json:"-"`
	Name              string            `gorm:"size:64;not null;default:''" json:"name"`
	Mobile            string            `gorm:"size:32;default:''" json:"mobile"`
	DeptID            *uint             `gorm:"index" json:"dept_id"`
	Department        *Department       `gorm:"foreignKey:DeptID" json:"-"`
	EmployeeNo        *string           `gorm:"size:32;uniqueIndex" json:"employee_no"`
	Position          string            `gorm:"size:64;default:''" json:"position"`
	ManagerID         *uint             `gorm:"index" json:"manager_id"`
	Manager           *ContactProfile   `gorm:"foreignKey:ManagerID" json:"-"`
	EmploymentType    string            `gorm:"size:32;default:'正式'" json:"employment_type"`
	EmploymentStatus  string            `gorm:"size:16;default:'active';index" json:"employment_status"`
	HireDate          *timeutil.Date    `json:"hire_date"`
	RegularDate       *timeutil.Date    `json:"regular_date"`
	LeaveDate         *timeutil.Date    `json:"leave_date"`
	WorkEmail         string            `gorm:"size:128;default:''" json:"work_email"`
	OfficePhone       string            `gorm:"size:32;default:''" json:"office_phone"`
	WorkLocation      string            `gorm:"size:128;default:''" json:"work_location"`
	ContractType      string            `gorm:"size:32;default:''" json:"contract_type"`
	ContractStart     *timeutil.Date    `json:"contract_start"`
	ContractEnd       *timeutil.Date    `json:"contract_end"`
	Gender            string            `gorm:"size:8;default:''" json:"gender"`
	BirthDate         *timeutil.Date    `json:"birth_date"`
	IDCardNo          string            `gorm:"size:32;default:''" json:"id_card_no"`
	NativePlace       string            `gorm:"size:64;default:''" json:"native_place"`
	PoliticalStatus   string            `gorm:"size:32;default:''" json:"political_status"`
	MaritalStatus     string            `gorm:"size:16;default:''" json:"marital_status"`
	Address           string            `gorm:"size:255;default:''" json:"address"`
	HighestEducation  string            `gorm:"size:32;default:''" json:"highest_education"`
	School            string            `gorm:"size:128;default:''" json:"school"`
	Major             string            `gorm:"size:128;default:''" json:"major"`
	GraduationDate    *timeutil.Date    `json:"graduation_date"`
	Degree            string            `gorm:"size:32;default:''" json:"degree"`
	EmergencyContact  string            `gorm:"size:64;default:''" json:"emergency_contact"`
	EmergencyRelation string            `gorm:"size:32;default:''" json:"emergency_relation"`
	EmergencyPhone    string            `gorm:"size:32;default:''" json:"emergency_phone"`
	Remark            string            `gorm:"type:text;default:''" json:"remark"`
	UpdatedBy         *uint             `json:"updated_by"`
	CreatedAt         timeutil.DateTime `json:"created_at"`
	UpdatedAt         timeutil.DateTime `json:"updated_at"`
}

func (ContactProfile) TableName() string { return "contact_profiles" }

type Partner struct {
	ID          uint              `gorm:"primaryKey" json:"id"`
	Name        string            `gorm:"size:128;unique;not null;index" json:"name"`
	ContactName string            `gorm:"size:64;default:''" json:"contact_name"`
	Phone       string            `gorm:"size:64;default:''" json:"phone"`
	Email       string            `gorm:"size:128;default:''" json:"email"`
	Address     string            `gorm:"size:255;default:''" json:"address"`
	Remark      string            `gorm:"type:text;default:''" json:"remark"`
	CreatedBy   *uint             `json:"created_by"`
	UpdatedBy   *uint             `json:"updated_by"`
	CreatedAt   timeutil.DateTime `json:"created_at"`
	UpdatedAt   timeutil.DateTime `json:"updated_at"`
	Contracts   []PartnerContract `gorm:"foreignKey:PartnerID" json:"contracts,omitempty"`
}

func (Partner) TableName() string { return "partners" }

type PartnerContract struct {
	ID          uint              `gorm:"primaryKey" json:"id"`
	PartnerID   uint              `gorm:"not null;index" json:"partner_id"`
	ProjectName string            `gorm:"size:128;not null;default:''" json:"project_name"`
	Amount      float64           `gorm:"default:0" json:"amount"`
	SignedDate  *timeutil.Date    `json:"signed_date"`
	Remark      string            `gorm:"type:text;default:''" json:"remark"`
	CreatedAt   timeutil.DateTime `json:"created_at"`
}

func (PartnerContract) TableName() string { return "partner_contracts" }

type Opportunity struct {
	ID            uint               `gorm:"primaryKey" json:"id"`
	Code          string             `gorm:"size:32;unique;not null;index" json:"code"`
	Name          string             `gorm:"size:128;not null" json:"name"`
	Client        string             `gorm:"column:client;size:128;default:''" json:"client"`
	OwnerID       *uint              `gorm:"index" json:"owner_id"`
	OwnerName     string             `gorm:"size:64;default:''" json:"owner_name"`
	BudgetTotal   float64            `gorm:"column:budget_total;default:0" json:"budget_total"`
	Stage         string             `gorm:"size:16;default:'new';index" json:"stage"`
	ExpectedClose *timeutil.Date     `gorm:"column:expected_close" json:"expected_close"`
	Description   string             `gorm:"type:text;default:''" json:"description"`
	DeletedAt     *timeutil.DateTime `gorm:"index" json:"deleted_at,omitempty"`
	CreatedBy     *uint              `json:"created_by"`
	CreatedAt     timeutil.DateTime  `json:"created_at"`
	UpdatedAt     timeutil.DateTime  `json:"updated_at"`
}

func (Opportunity) TableName() string { return "opportunities" }

type Notification struct {
	ID         uint               `gorm:"primaryKey" json:"id"`
	UserID     uint               `gorm:"not null;index" json:"user_id"`
	Type       string             `gorm:"size:32;index" json:"type"`
	Title      string             `gorm:"size:128;default:''" json:"title"`
	Body       string             `gorm:"type:text;default:''" json:"body"`
	Channel    string             `gorm:"size:16;default:'inapp'" json:"channel"`
	RefType    string             `gorm:"size:32;default:''" json:"ref_type"`
	RefID      *uint              `json:"ref_id"`
	ProjectID  *uint              `gorm:"index" json:"project_id"`
	DedupKey   string             `gorm:"size:128;index" json:"dedup_key"`
	ReadAt     *timeutil.DateTime `gorm:"index" json:"read_at"`
	State      string             `gorm:"size:16;default:'pending';index" json:"state"`
	HandledAt  *timeutil.DateTime `json:"handled_at"`
	HandledBy  *uint              `json:"handled_by"`
	HandleNote string             `gorm:"type:text;default:''" json:"handle_note"`
	CreatedAt  timeutil.DateTime  `gorm:"index" json:"created_at"`
}

func (Notification) TableName() string { return "notifications" }
