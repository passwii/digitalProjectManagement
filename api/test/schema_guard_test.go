package test

import (
	"fmt"
	"strings"
	"testing"

	"digitalprojectmanagement/api/internal/model"
	"gorm.io/gorm"
)

// G1 防复发守卫：GORM model 与真实迁移 schema 全量对照。
// 每个 model 用 Statement.Schema.DBNames 拼 SELECT "col1", "col2", ... FROM "table" LIMIT 0，
// 任何“model 有、DB 没有”的列都会以 SQLSTATE 42703 让本用例失败（#198 的模型侧表现）。
// setupTestApp 会在随机 schema 上执行真实 Goose 迁移（与生产同一套 SQL），守护的是部署时实际 schema。
func TestModelsMatchMigratedSchema(t *testing.T) {
	_, db := setupTestApp(t)

	models := []struct {
		table string
		model any
	}{
		{"departments", &model.Department{}},
		{"users", &model.User{}},
		{"roles", &model.Role{}},
		{"user_roles", &model.UserRole{}},
		{"user_modules", &model.UserModule{}},
		{"sys_params", &model.SysParam{}},
		{"dicts", &model.Dict{}},
		{"token_blacklist", &model.TokenBlacklist{}},
		{"audit_logs", &model.AuditLog{}},
		{"contact_profiles", &model.ContactProfile{}},
		{"partners", &model.Partner{}},
		{"partner_contracts", &model.PartnerContract{}},
		{"opportunities", &model.Opportunity{}},
		{"notifications", &model.Notification{}},
		{"projects", &model.Project{}},
		{"project_members", &model.ProjectMember{}},
		{"project_changes", &model.ProjectChange{}},
		{"attachments", &model.Attachment{}},
		{"followups", &model.Followup{}},
		{"milestones", &model.Milestone{}},
		{"tasks", &model.Task{}},
		{"progress_logs", &model.ProgressLog{}},
		{"budgets", &model.Budget{}},
		{"budget_adjusts", &model.BudgetAdjust{}},
		{"expenses", &model.Expense{}},
		{"approval_records", &model.ApprovalRecord{}},
		{"project_receivables", &model.ProjectReceivable{}},
		{"project_receivable_payments", &model.ProjectReceivablePayment{}},
		{"account_books", &model.AccountBook{}},
		{"account_book_members", &model.AccountBookMember{}},
		{"accounting_periods", &model.AccountingPeriod{}},
		{"accounts", &model.Account{}},
		{"opening_balances", &model.OpeningBalance{}},
		{"auxiliary_items", &model.AuxiliaryItem{}},
		{"account_auxiliaries", &model.AccountAuxiliary{}},
		{"account_balances", &model.AccountBalance{}},
		{"vouchers", &model.Voucher{}},
		{"voucher_entries", &model.VoucherEntry{}},
		{"voucher_templates", &model.VoucherTemplate{}},
		{"cash_transactions", &model.CashTransaction{}},
		{"bank_statements", &model.BankStatement{}},
		{"fixed_assets", &model.FixedAsset{}},
		{"asset_depreciations", &model.AssetDepreciation{}},
		{"arap_transactions", &model.ARAPTransaction{}},
		{"arap_allocations", &model.ARAPAllocation{}},
		{"equipment_batches", &model.EquipmentBatch{}},
		{"equipment_assets", &model.EquipmentAsset{}},
		{"equipment_events", &model.EquipmentEvent{}},
	}
	if len(models) < 48 {
		t.Fatalf("schema guard 覆盖 model 数 = %d，少于 48，疑似漏表", len(models))
	}

	totalColumns := 0
	for _, m := range models {
		stmt := &gorm.Statement{DB: db}
		if err := stmt.Parse(m.model); err != nil {
			t.Errorf("parse model %s: %v", m.table, err)
			continue
		}
		if stmt.Schema.Table != m.table {
			t.Errorf("model 表名 = %q，期望 %q", stmt.Schema.Table, m.table)
		}
		columns := stmt.Schema.DBNames
		if len(columns) == 0 {
			t.Errorf("model %s 解析不出任何列", m.table)
			continue
		}
		quoted := make([]string, len(columns))
		for i, column := range columns {
			quoted[i] = "\"" + column + "\""
		}
		query := fmt.Sprintf("SELECT %s FROM %q LIMIT 0", strings.Join(quoted, ", "), stmt.Schema.Table)
		rows, err := db.Raw(query).Rows()
		if err != nil {
			t.Errorf("model %s 与真实 schema 不一致: %v", m.table, err)
			continue
		}
		_ = rows.Close()
		totalColumns += len(columns)
	}

	// 防止“空转通过”：49 张表合计 500+ 列，明显少于这个量级说明扫描没有生效。
	if totalColumns < 500 {
		t.Fatalf("schema guard 扫描列数 = %d，少于 500，疑似未覆盖真实 model", totalColumns)
	}
	t.Logf("schema guard: %d models, %d columns 全部存在于真实迁移 schema", len(models), totalColumns)
}
