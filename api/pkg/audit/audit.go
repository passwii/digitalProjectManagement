package audit

import (
	"errors"
	"fmt"

	"digitalprojectmanagement/api/pkg/timeutil"
	"gorm.io/gorm"
)

const AuditFailMsg = "审计写入失败，本次操作已回滚，请重试或联系管理员"

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

func (AuditLog) TableName() string {
	return "audit_logs"
}

func CreateAuditRow(userID *uint, action, resource, resourceID, detail, ip string) *AuditLog {
	return &AuditLog{
		UserID:     userID,
		Action:     action,
		Resource:   resource,
		ResourceID: resourceID,
		Detail:     detail,
		IP:         ip,
		CreatedAt:  timeutil.NowDateTime(),
	}
}

// CommitAudited 在现有事务 tx 中写入审计行并由调用方统一提交，或在此直接执行
func CommitAudited(tx *gorm.DB, userID *uint, action, resource, resourceID, detail, ip string) error {
	row := CreateAuditRow(userID, action, resource, resourceID, detail, ip)
	if err := tx.Create(row).Error; err != nil {
		return errors.New(AuditFailMsg)
	}
	return nil
}

// WriteAudit 在独立事务中写入审计行
func WriteAudit(db *gorm.DB, userID *uint, action, resource, resourceID, detail, ip string) error {
	row := CreateAuditRow(userID, action, resource, resourceID, detail, ip)
	if err := db.Create(row).Error; err != nil {
		return fmt.Errorf("%s: %w", AuditFailMsg, err)
	}
	return nil
}
