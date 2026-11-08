package model

import (
	"digitalprojectmanagement/api/pkg/timeutil"
)

type Department struct {
	ID        uint              `gorm:"primaryKey" json:"id"`
	Name      string            `gorm:"size:64;unique;not null" json:"name"`
	ParentID  *uint             `json:"parent_id"`
	CreatedAt timeutil.DateTime `json:"created_at"`
}

func (Department) TableName() string { return "departments" }

type User struct {
	ID              uint               `gorm:"primaryKey" json:"id"`
	Username        string             `gorm:"size:64;unique;not null" json:"username"`
	PwdHash         string             `gorm:"size:128;not null" json:"-"`
	RealName        string             `gorm:"size:64;default:''" json:"real_name"`
	DeptID          *uint              `json:"dept_id"`
	Department      *Department        `gorm:"foreignKey:DeptID" json:"dept,omitempty"`
	Status          string             `gorm:"size:16;default:'active'" json:"status"`
	LoginFailCount  int                `gorm:"column:failed_count;default:0" json:"-"`
	LockedUntil     *timeutil.DateTime `json:"-"`
	MustChangePwd   bool               `gorm:"default:true" json:"must_change_pwd"`
	CreatedAt       timeutil.DateTime  `json:"created_at"`
	SessionVersion  int                `gorm:"default:0;not null" json:"session_version"`
	IsSuperAdmin    bool               `gorm:"default:false;not null" json:"is_super_admin"`
	ModulesAssigned bool               `gorm:"default:false;not null" json:"modules_assigned"`
	Roles           []Role             `gorm:"many2many:user_roles;" json:"roles,omitempty"`
	Modules         []UserModule       `gorm:"foreignKey:UserID" json:"modules,omitempty"`
}

func (User) TableName() string { return "users" }

type Role struct {
	ID   uint   `gorm:"primaryKey" json:"id"`
	Code string `gorm:"size:32;unique;not null" json:"code"`
	Name string `gorm:"size:64;not null" json:"name"`
}

func (Role) TableName() string { return "roles" }

type UserRole struct {
	UserID uint `gorm:"primaryKey" json:"user_id"`
	RoleID uint `gorm:"primaryKey" json:"role_id"`
}

func (UserRole) TableName() string { return "user_roles" }

type UserModule struct {
	UserID uint   `gorm:"primaryKey" json:"user_id"`
	Module string `gorm:"primaryKey;size:32" json:"module"`
}

func (UserModule) TableName() string { return "user_modules" }

type SysParam struct {
	ID    uint   `gorm:"primaryKey" json:"id"`
	Key   string `gorm:"size:64;unique;not null" json:"key"`
	Value string `gorm:"size:255;default:''" json:"value"`
	Desc  string `gorm:"size:255;default:''" json:"desc"`
}

func (SysParam) TableName() string { return "sys_params" }

type Dict struct {
	ID   uint   `gorm:"primaryKey" json:"id"`
	Type string `gorm:"size:32;index" json:"type"`
	Code string `gorm:"size:32" json:"code"`
	Label string `gorm:"size:64" json:"label"`
	Sort int    `gorm:"default:0" json:"sort"`
}

func (Dict) TableName() string { return "dicts" }

type TokenBlacklist struct {
	ID        uint               `gorm:"primaryKey" json:"id"`
	JTI       string             `gorm:"size:64;unique;not null" json:"jti"`
	UserID    *uint              `json:"user_id"`
	ExpiresAt *timeutil.DateTime `json:"expires_at"`
	CreatedAt timeutil.DateTime  `json:"created_at"`
}

func (TokenBlacklist) TableName() string { return "token_blacklist" }

type AuditLog struct {
	ID         uint              `gorm:"primaryKey" json:"id"`
	UserID     *uint             `gorm:"index" json:"user_id"`
	Action     string            `gorm:"size:64;index" json:"action"`
	Resource   string            `gorm:"size:64" json:"resource"`
	ResourceID string            `gorm:"size:64" json:"resource_id"`
	Detail     string            `gorm:"type:text" json:"detail"`
	IP         string            `gorm:"size:64" json:"ip"`
	CreatedAt  timeutil.DateTime `gorm:"index" json:"created_at"`
}

func (AuditLog) TableName() string { return "audit_logs" }
