package main

import (
	"log"
	"os"

	"digitalprojectmanagement/api/internal/model"
	"digitalprojectmanagement/api/pkg/database"
	"digitalprojectmanagement/api/pkg/security"
	"digitalprojectmanagement/api/pkg/timeutil"
	"gorm.io/gorm"
)

var departments = []string{"综合部", "行销部", "交付与服务部", "市场部", "总经办"}

var roles = []struct {
	Code string
	Name string
}{
	{"admin", "系统管理员"},
	{"finance_clerk", "制单会计"},
	{"finance_reviewer", "审核会计"},
	{"cashier", "出纳"},
	{"finance_manager", "财务主管"},
	{"finance_auditor", "审计员"},
	{"project_manager", "项目负责人"},
	{"dept_manager", "部门负责人"},
	{"member", "项目成员"},
	{"cost_admin", "成本管理员"},
	{"executive", "高层（只读）"},
}

var dicts = []struct {
	Type  string
	Code  string
	Label string
}{
	{"equipment_category", "computer", "电脑"},
	{"equipment_category", "monitor", "显示器"},
	{"equipment_category", "printer", "打印机"},
	{"equipment_category", "network", "网络设备"},
	{"equipment_category", "instrument", "工具仪器"},
	{"equipment_category", "other", "其他"},
	{"project_type", "research", "科研"},
	{"project_type", "construct", "工程"},
	{"project_type", "service", "服务"},
	{"project_type", "other", "其他"},
	{"priority", "高", "高"},
	{"priority", "中", "中"},
	{"priority", "低", "低"},
	{"expense_subject", "人工", "人工"},
	{"expense_subject", "采购", "采购"},
	{"expense_subject", "外包", "外包"},
	{"expense_subject", "差旅", "差旅"},
	{"expense_subject", "其他", "其他"},
	{"project_status", "draft", "草稿"},
	{"project_status", "filed", "已立项"},
	{"project_status", "pending", "待立项审批"},
	{"project_status", "doing", "进行中"},
	{"project_status", "paused", "暂停"},
	{"project_status", "done", "已完成"},
	{"project_status", "archived", "已归档"},
	{"project_status", "cancelled", "已取消"},
}

var params = map[string]struct {
	Val  string
	Desc string
}{
	"login_fail_limit":    {"5", "连续失败锁定阈值"},
	"login_lock_minutes":  {"15", "锁定分钟数"},
	"budget_warn_rate":    {"0.8", "预算执行率预警线"},
	"budget_approval_on":  {"0", "预算调整审批开关 0关/1开"},
	"expense_approval_on": {"0", "支出审批开关 0关/1开"},
	"milestone_warn_days": {"3", "里程碑到期预警天数"},
	"stagnant_days":       {"7", "项目停滞无填报天数"},
	"project_approval_on": {"0", "立项审批开关 0关/1开"},
	"demo_data_on":        {"0", "演示数据开关 0隐藏/1显示"},
	"notify_dedup_days":   {"1", "预警通知去重窗口（天），同一引用在窗口内不重复推送"},
}

const (
	initialAdminUsername = "15796280534"
	initialAdminPassword = "admin123456"
)

func Seed(db *gorm.DB) error {
	// 部门
	for _, name := range departments {
		var dept model.Department
		if err := db.Where("name = ?", name).First(&dept).Error; err != nil {
			db.Create(&model.Department{
				Name: name,
			})
		}
	}

	// 角色
	for _, r := range roles {
		var role model.Role
		if err := db.Where("code = ?", r.Code).First(&role).Error; err != nil {
			db.Create(&model.Role{
				Code: r.Code,
				Name: r.Name,
			})
		}
	}

	// 字典
	for _, d := range dicts {
		var dict model.Dict
		if err := db.Where("type = ? AND code = ?", d.Type, d.Code).First(&dict).Error; err != nil {
			db.Create(&model.Dict{
				Type:  d.Type,
				Code:  d.Code,
				Label: d.Label,
			})
		}
	}

	// 系统参数
	for k, p := range params {
		var sp model.SysParam
		if err := db.Where("key = ?", k).First(&sp).Error; err != nil {
			db.Create(&model.SysParam{
				Key:   k,
				Value: p.Val,
				Desc:  p.Desc,
			})
		}
	}

	// 初始超管用户
	var adminUser model.User
	if err := db.Where("username = ?", initialAdminUsername).First(&adminUser).Error; err != nil {
		hash, err := security.HashPassword(initialAdminPassword)
		if err != nil {
			return err
		}
		var firstDept model.Department
		db.First(&firstDept)

		adminUser = model.User{
			Username:        initialAdminUsername,
			PwdHash:         hash,
			RealName:        "系统管理员",
			DeptID:          &firstDept.ID,
			Status:          "active",
			MustChangePwd:   true,
			IsSuperAdmin:    true,
			ModulesAssigned: true,
			CreatedAt:       timeutil.NowDateTime(),
			
		}
		if err := db.Create(&adminUser).Error; err != nil {
			return err
		}

		var adminRole model.Role
		if err := db.Where("code = ?", "admin").First(&adminRole).Error; err == nil {
			db.Create(&model.UserRole{UserID: adminUser.ID, RoleID: adminRole.ID})
		}
	}

	return nil
}

func main() {
	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		dbURL = "postgresql://app:app@localhost:5432/app_test"
	}

	db, err := database.Init(dbURL, "development")
	if err != nil {
		log.Fatalf("failed to connect to database: %v", err)
	}

	if err := Seed(db); err != nil {
		log.Fatalf("failed to seed database: %v", err)
	}
	log.Println("seed completed successfully")
}
