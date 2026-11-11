// Command seed-demo 填充一套「全流程 + 全状态」演示数据，用于演示与验收。
//
// 本命令是 scripts/seed_mock.py 的 Go/GORM 版本，行为对齐：
//
//	· 9 个项目覆盖 8 种状态：草稿 / 待立项审批 / 已立项 / 进行中 / 暂停 /
//	  已完成 / 已归档 / 已取消；
//	· WBS 多级任务 + 前置依赖 + 逾期任务 + 权重加权进度；
//	· 进度填报（含近 7 天记录与「停滞」项目，驱动周报/停滞预警）；
//	· 里程碑：已完成 / 临近 / 逾期；
//	· 预算按科目编制，执行率覆盖健康 / 预警 / 超支；
//	· 支出跨 6 个月，含待审批 / 驳回 / 特批通过；
//	· 预算调整单待审批、跟进记录与到期提醒、附件、变更留痕；
//	· 站内通知（预警 + 审批待办），已读/未读、已处理/待处理混合。
//
// 用法：
//
//	go run ./cmd/seed-demo             # 填充（已有示例数据则跳过）
//	go run ./cmd/seed-demo --reset     # 清理后重新填充
//	go run ./cmd/seed-demo --clean     # 只清理
//
// 数据库连接取 DATABASE_URL。附件写入本地存储（STORAGE_LOCAL_ROOT，缺省为
// 系统临时目录），与 API 的 local 后端读取路径一致。
package main

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"flag"
	"fmt"
	"log"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"digitalprojectmanagement/api/internal/model"
	"digitalprojectmanagement/api/internal/notify"
	"digitalprojectmanagement/api/pkg/database"
	"digitalprojectmanagement/api/pkg/security"
	"digitalprojectmanagement/api/pkg/storage"
	"digitalprojectmanagement/api/pkg/timeutil"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

const (
	demoPassword      = "demo123456"
	demoAdminUsername = "demo_admin"
	maxPerType        = 50 // 每类预警最多写入的通知条数，与 Python 版一致
)

var (
	demoToday      = timeutil.NewDate(timeutil.AppNow())
	demoCodePrefix = fmt.Sprintf("PJ-%d-9", demoToday.Year())
)

var demoDepartments = []string{"产品研发部", "交付实施部", "财务部", "综合部"}

type demoUserSpec struct {
	Username string
	RealName string
	Dept     string
	Roles    []string
}

// 与 Python 版 USERS 保持一致；角色仅作结构字段保留，系统身份由 is_super_admin 决定。
var demoUsers = []demoUserSpec{
	{"demo_admin", "演示管理员", "综合部", []string{"admin"}},
	{"zhangwei", "张伟", "产品研发部", []string{"project_manager", "member"}},
	{"lina", "李娜", "交付实施部", []string{"project_manager", "member"}},
	{"wangqiang", "王强", "产品研发部", []string{"member"}},
	{"zhaomin", "赵敏", "产品研发部", []string{"member"}},
	{"liuyang", "刘洋", "交付实施部", []string{"member"}},
	{"chenjing", "陈静", "财务部", []string{"cost_admin"}},
	{"sunlei", "孙磊", "产品研发部", []string{"dept_manager"}},
	{"zhouzong", "周正", "综合部", []string{"executive"}},
}

type seededProject struct {
	Code string
	Name string
	Desc string
}

type seedResult struct {
	Projects             []seededProject
	Notifications        int
	WarningNotifications int
}

func main() {
	reset := flag.Bool("reset", false, "先清理示例数据再填充")
	cleanOnly := flag.Bool("clean", false, "只清理示例数据")
	flag.Parse()

	dbURL := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if dbURL == "" {
		log.Fatal("未设置 DATABASE_URL 环境变量")
	}

	// database.Init 的第二个参数只影响 GORM 日志级别；别名用 cli 以免刷满 SQL 日志。
	db, err := database.Init(dbURL, "cli")
	if err != nil {
		log.Fatalf("数据库连接失败: %v", err)
	}
	if sqlDB, dbErr := db.DB(); dbErr == nil {
		defer sqlDB.Close()
	}

	if *cleanOnly {
		if err := clean(db); err != nil {
			log.Fatalf("清理示例数据失败: %v", err)
		}
		return
	}

	var exists int64
	if err := db.Model(&model.Project{}).Where("is_demo = ?", true).Count(&exists).Error; err != nil {
		log.Fatalf("检查示例项目失败: %v", err)
	}
	if exists > 0 && !*reset {
		fmt.Printf("检测到已有 %d 个示例项目；如需重建请加 --reset\n", exists)
		return
	}
	if exists > 0 && *reset {
		if err := clean(db); err != nil {
			log.Fatalf("清理示例数据失败: %v", err)
		}
	}

	fmt.Println("开始填充模拟数据 ...")
	result, err := seed(db)
	if err != nil {
		log.Fatalf("填充示例数据失败: %v", err)
	}
	printSummary(db, result)
}

// ---------------------------------------------------------------- 日期与工具

func demoDate(offset int) *timeutil.Date {
	v := timeutil.NewDate(demoToday.Time.AddDate(0, 0, offset))
	return &v
}

func demoTS(offset, hour int) timeutil.DateTime {
	day := demoToday.Time.AddDate(0, 0, offset)
	return timeutil.NewDateTime(time.Date(day.Year(), day.Month(), day.Day(), hour, 0, 0, 0, timeutil.Loc))
}

func demoTodayString() string {
	return demoToday.Format("2006-01-02")
}

func ptrOf[T any](v T) *T {
	return &v
}

func roundTo(value float64, places int) float64 {
	factor := math.Pow(10, float64(places))
	return math.Round(value*factor) / factor
}

func truncateRunes(value string, limit int) string {
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return string(runes[:limit])
}

func uniqueIDs(ids ...*uint) []uint {
	out := make([]uint, 0, len(ids))
	for _, id := range ids {
		if id != nil && *id != 0 {
			out = append(out, *id)
		}
	}
	return uniqueUint(out)
}

func uniqueUint(ids []uint) []uint {
	seen := make(map[uint]struct{}, len(ids))
	out := make([]uint, 0, len(ids))
	for _, id := range ids {
		if id == 0 {
			continue
		}
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		out = append(out, id)
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}

func mergeIDs(base []uint, extra ...uint) []uint {
	merged := make([]uint, 0, len(base)+len(extra))
	merged = append(merged, base...)
	merged = append(merged, extra...)
	return uniqueUint(merged)
}

func contentTypeFor(filename string) string {
	switch strings.ToLower(filepath.Ext(filename)) {
	case ".pdf":
		return "application/pdf"
	case ".docx":
		return "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
	case ".xlsx":
		return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
	case ".png":
		return "image/png"
	case ".jpg", ".jpeg":
		return "image/jpeg"
	default:
		return "application/octet-stream"
	}
}

// ---------------------------------------------------------------- 写入器

// seeder 用「首个错误 + 后续空操作」的方式串联上百条写入，避免每处都写 if err。
// seed() 在事务结束时统一返回 s.err；任何一步失败都会整体回滚。
type seeder struct {
	db                   *gorm.DB
	deptIDs              map[string]uint
	users                map[string]uint
	attachments          *storage.LocalBackend
	notificationIDs      []uint
	warningNotifications int
	err                  error
}

func (s *seeder) fail(context string, err error) {
	if s.err == nil && err != nil {
		s.err = fmt.Errorf("%s: %w", context, err)
	}
}

type taskOpts struct {
	weight   float64
	progress float64
	parent   *uint
	level    int
	pred     *uint
}

func (s *seeder) ensureDepartments() {
	s.deptIDs = map[string]uint{}
	if s.err != nil {
		return
	}
	for _, name := range demoDepartments {
		var dep model.Department
		err := s.db.Where("name = ?", name).First(&dep).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			dep = model.Department{Name: name}
			if createErr := s.db.Create(&dep).Error; createErr != nil {
				s.fail("创建部门 "+name, createErr)
				return
			}
		} else if err != nil {
			s.fail("查询部门 "+name, err)
			return
		}
		s.deptIDs[name] = dep.ID
	}
}

func (s *seeder) ensureUsers() {
	s.users = map[string]uint{}
	if s.err != nil {
		return
	}

	pwdHash, err := security.HashPassword(demoPassword)
	if err != nil {
		s.fail("生成演示账号密码", err)
		return
	}

	var roles []model.Role
	if err := s.db.Find(&roles).Error; err != nil {
		s.fail("查询角色目录", err)
		return
	}
	roleIDs := make(map[string]uint, len(roles))
	for _, role := range roles {
		roleIDs[role.Code] = role.ID
	}
	if len(roleIDs) == 0 {
		log.Println("警告：角色目录为空（请先执行 api/cmd/seed），演示账号将不带角色关联")
	}

	for _, spec := range demoUsers {
		deptID, ok := s.deptIDs[spec.Dept]
		if !ok {
			s.fail("创建演示账号 "+spec.Username, fmt.Errorf("部门 %s 不存在", spec.Dept))
			return
		}

		var user model.User
		err := s.db.Where("username = ?", spec.Username).First(&user).Error
		switch {
		case errors.Is(err, gorm.ErrRecordNotFound):
			user = model.User{
				Username:      spec.Username,
				PwdHash:       pwdHash,
				RealName:      spec.RealName,
				DeptID:        &deptID,
				Status:        "active",
				MustChangePwd: false,
				CreatedAt:     demoTS(-400, 9),
				IsSuperAdmin:  spec.Username == demoAdminUsername,
			}
			if createErr := s.db.Omit(clause.Associations).Create(&user).Error; createErr != nil {
				s.fail("创建演示账号 "+spec.Username, createErr)
				return
			}
		case err != nil:
			s.fail("查询演示账号 "+spec.Username, err)
			return
		default:
			updates := map[string]any{
				"pwd_hash":        pwdHash,
				"real_name":       spec.RealName,
				"dept_id":         deptID,
				"status":          "active",
				"must_change_pwd": false,
			}
			if spec.Username == demoAdminUsername {
				updates["is_super_admin"] = true
			}
			if updateErr := s.db.Model(&model.User{}).Where("id = ?", user.ID).Updates(updates).Error; updateErr != nil {
				s.fail("更新演示账号 "+spec.Username, updateErr)
				return
			}
		}

		for _, code := range spec.Roles {
			roleID, exists := roleIDs[code]
			if !exists {
				log.Printf("警告：角色目录缺少 %s，已跳过 %s 的角色关联", code, spec.Username)
				continue
			}
			link := model.UserRole{UserID: user.ID, RoleID: roleID}
			if linkErr := s.db.Clauses(clause.OnConflict{DoNothing: true}).Create(&link).Error; linkErr != nil {
				s.fail("关联演示账号角色", linkErr)
				return
			}
		}
		s.users[spec.Username] = user.ID
	}
}

func (s *seeder) createProject(seq int, project model.Project) *model.Project {
	project.Code = fmt.Sprintf("%s%03d", demoCodePrefix, seq)
	project.IsDemo = true
	project.UpdatedAt = timeutil.NowDateTime()
	if s.err != nil {
		return &project
	}
	if err := s.db.Omit(clause.Associations).Create(&project).Error; err != nil {
		s.fail("创建演示项目 "+project.Name, err)
	}
	return &project
}

func (s *seeder) addMember(projectID, userID uint) {
	if s.err != nil || projectID == 0 || userID == 0 {
		return
	}
	member := model.ProjectMember{ProjectID: projectID, UserID: userID}
	if err := s.db.Clauses(clause.OnConflict{DoNothing: true}).Create(&member).Error; err != nil {
		s.fail("添加项目成员", err)
	}
}

func (s *seeder) createTask(projectID uint, name string, ownerID uint, start, end *timeutil.Date, opts taskOpts) *model.Task {
	weight := opts.weight
	if weight == 0 {
		weight = 1
	}
	level := opts.level
	if level == 0 {
		level = 1
	}
	status := "todo"
	switch {
	case opts.progress >= 100:
		status = "done"
	case opts.progress > 0:
		status = "doing"
	}

	task := &model.Task{
		ProjectID:     projectID,
		ParentID:      opts.parent,
		Level:         level,
		Name:          name,
		OwnerID:       ptrOf(ownerID),
		PlanStart:     start,
		PlanEnd:       end,
		Weight:        weight,
		Progress:      opts.progress,
		Status:        status,
		PredecessorID: opts.pred,
		CreatedAt:     demoTS(-300, 9),
		UpdatedAt:     demoTS(-3, 9),
	}
	if s.err != nil {
		return task
	}
	if err := s.db.Omit(clause.Associations).Create(task).Error; err != nil {
		s.fail("创建任务 "+name, err)
	}
	return task
}

func (s *seeder) addLog(projectID, taskID uint, progress float64, note string, daysAgo int, userID uint, remaining *int) {
	if s.err != nil {
		return
	}
	row := &model.ProgressLog{
		TaskID:        taskID,
		ProjectID:     projectID,
		UserID:        ptrOf(userID),
		Progress:      progress,
		Note:          note,
		RemainingDays: remaining,
		CreatedAt:     demoTS(-daysAgo, 15),
	}
	if err := s.db.Omit(clause.Associations).Create(row).Error; err != nil {
		s.fail("创建进度填报", err)
	}
}

func (s *seeder) createBudget(projectID uint, subject string, amount float64, start, end *timeutil.Date) *model.Budget {
	budget := &model.Budget{
		ProjectID:   projectID,
		Subject:     subject,
		Amount:      amount,
		PeriodStart: start,
		PeriodEnd:   end,
		CreatedAt:   demoTS(-280, 9),
		UpdatedAt:   demoTS(-280, 9),
	}
	if s.err != nil {
		return budget
	}
	if err := s.db.Create(budget).Error; err != nil {
		s.fail("创建预算 "+subject, err)
	}
	return budget
}

func (s *seeder) findBudget(projectID uint, subject string) model.Budget {
	var budget model.Budget
	if s.err != nil {
		return budget
	}
	if err := s.db.Where("project_id = ? AND subject = ?", projectID, subject).First(&budget).Error; err != nil {
		s.fail("查询预算 "+subject, err)
	}
	return budget
}

func (s *seeder) createExpense(projectID uint, subject string, amount float64, expDate *timeutil.Date, note, status string, byID uint, approvedBy *uint) *model.Expense {
	back := 0
	if expDate != nil {
		back = int(demoToday.Time.Sub(expDate.Time).Hours() / 24)
		if back < 0 {
			back = 0
		}
	}

	var decided *timeutil.DateTime
	if status != "pending" {
		value := demoTS(-back, 17)
		decided = &value
	}
	reason := ""
	switch status {
	case "rejected":
		reason = "金额与合同不符，请核对后重提"
	case "exception":
		reason = "紧急复工需要，特批放行"
	}

	expense := &model.Expense{
		ProjectID:      projectID,
		Subject:        subject,
		Amount:         amount,
		ExpDate:        expDate,
		Note:           note,
		Status:         status,
		ByID:           ptrOf(byID),
		ApprovedBy:     approvedBy,
		DecisionReason: reason,
		DecidedAt:      decided,
		CreatedAt:      demoTS(-back, 16),
	}
	if s.err != nil {
		return expense
	}
	if err := s.db.Omit(clause.Associations).Create(expense).Error; err != nil {
		s.fail("创建支出 "+note, err)
		return expense
	}

	submittedAt := demoTS(-back, 16)
	s.createApprovalRecord("expense", expense.ID, &projectID, "submit", "", status, ptrOf(byID), &submittedAt, "")

	if status != "pending" {
		action := map[string]string{
			"approved":  "approve",
			"exception": "exception",
			"rejected":  "reject",
		}[status]
		actorID := byID
		if approvedBy != nil {
			actorID = *approvedBy
		}
		s.createApprovalRecord("expense", expense.ID, &projectID, action, "pending", status, ptrOf(actorID), decided, "")
	}
	return expense
}

func (s *seeder) createApprovalRecord(kind string, refID uint, projectID *uint, action, fromStatus, toStatus string, actorID *uint, at *timeutil.DateTime, reason string) {
	if s.err != nil {
		return
	}
	createdAt := timeutil.NowDateTime()
	if at != nil {
		createdAt = *at
	}
	row := &model.ApprovalRecord{
		Kind:       kind,
		RefID:      refID,
		ProjectID:  projectID,
		Action:     action,
		FromStatus: fromStatus,
		ToStatus:   toStatus,
		ActorID:    actorID,
		Reason:     reason,
		CreatedAt:  createdAt,
	}
	if err := s.db.Omit(clause.Associations).Create(row).Error; err != nil {
		s.fail("写入审批时间线", err)
	}
}

func (s *seeder) createMilestone(projectID uint, name string, plan *timeutil.Date, ownerID uint, actual *timeutil.Date) *model.Milestone {
	status := "open"
	if actual != nil {
		status = "closed"
	}
	row := &model.Milestone{
		ProjectID:  projectID,
		Name:       name,
		PlanDate:   plan,
		ActualDate: actual,
		OwnerID:    ptrOf(ownerID),
		Status:     status,
		CreatedAt:  demoTS(-290, 9),
	}
	if s.err != nil {
		return row
	}
	if err := s.db.Omit(clause.Associations).Create(row).Error; err != nil {
		s.fail("创建里程碑 "+name, err)
	}
	return row
}

func (s *seeder) createFollowup(projectID, userID uint, daysAgo int, method, content, nextStep string, remindOffset *int) *model.Followup {
	var remindAt *timeutil.DateTime
	state := "none"
	if remindOffset != nil {
		value := demoTS(*remindOffset, 9)
		remindAt = &value
		state = "pending"
	}
	happenedAt := demoTS(-daysAgo, 14)
	row := &model.Followup{
		ProjectID:   projectID,
		UserID:      ptrOf(userID),
		HappenedAt:  happenedAt,
		Method:      method,
		Content:     content,
		NextStep:    nextStep,
		RemindAt:    remindAt,
		RemindState: state,
		CreatedAt:   happenedAt,
	}
	if s.err != nil {
		return row
	}
	if err := s.db.Omit(clause.Associations).Create(row).Error; err != nil {
		s.fail("创建跟进记录", err)
	}
	return row
}

func (s *seeder) createChange(projectID uint, field, oldValue, newValue string, byID uint, daysAgo int) {
	if s.err != nil {
		return
	}
	row := &model.ProjectChange{
		ProjectID: projectID,
		Field:     field,
		Old:       oldValue,
		New:       newValue,
		ByID:      ptrOf(byID),
		At:        demoTS(-daysAgo, 11),
	}
	if err := s.db.Omit(clause.Associations).Create(row).Error; err != nil {
		s.fail("写入项目变更留痕", err)
	}
}

func (s *seeder) createAttachment(projectID uint, filename string, byID uint, daysAgo int, payload []byte) {
	if s.err != nil || s.attachments == nil {
		return
	}
	contentType := contentTypeFor(filename)
	key := fmt.Sprintf("projects/%d/%s", projectID, filename)
	publicURL, etag, err := s.attachments.Upload(context.Background(), key, bytes.NewReader(payload), int64(len(payload)), contentType)
	if err != nil {
		s.fail("写入演示附件 "+filename, err)
		return
	}
	row := &model.Attachment{
		ProjectID:      &projectID,
		Filename:       filename,
		Path:           publicURL,
		Size:           int64(len(payload)),
		ContentType:    contentType,
		UploadedBy:     ptrOf(byID),
		UploadedAt:     demoTS(-daysAgo, 10),
		Category:       "project",
		StorageBackend: s.attachments.Name(),
		ObjectKey:      key,
		ETag:           etag,
	}
	if err := s.db.Omit(clause.Associations).Create(row).Error; err != nil {
		s.fail("写入演示附件记录 "+filename, err)
	}
}

func (s *seeder) recalcProgress(project *model.Project) {
	if s.err != nil || project == nil {
		return
	}
	var tasks []model.Task
	if err := s.db.Where("project_id = ?", project.ID).Find(&tasks).Error; err != nil {
		s.fail("查询项目任务用于计算进度", err)
		return
	}
	if len(tasks) == 0 {
		return
	}
	numerator, denominator := 0.0, 0.0
	for _, task := range tasks {
		weight := task.Weight
		if weight == 0 {
			weight = 1
		}
		numerator += task.Progress * weight
		denominator += weight
	}
	if denominator == 0 {
		denominator = 1
	}
	progress := roundTo(numerator/denominator, 2)
	if err := s.db.Model(&model.Project{}).Where("id = ?", project.ID).Updates(map[string]any{
		"progress":   progress,
		"updated_at": timeutil.NowDateTime(),
	}).Error; err != nil {
		s.fail("更新项目进度", err)
		return
	}
	project.Progress = progress
}

// ---------------------------------------------------------------- 造数主流程

func seed(db *gorm.DB) (*seedResult, error) {
	result := &seedResult{}

	err := db.Transaction(func(tx *gorm.DB) error {
		s := &seeder{db: tx}

		if strings.EqualFold(strings.TrimSpace(os.Getenv("STORAGE_BACKEND")), "r2") {
			log.Println("提示：STORAGE_BACKEND=r2，演示附件仍写入本地存储（storage_backend=local），接口可按行内后端正常读取。")
		}
		backend, backendErr := storage.NewLocalBackend(os.Getenv("STORAGE_LOCAL_ROOT"))
		if backendErr != nil {
			log.Printf("警告：初始化本地附件存储失败，将跳过演示附件：%v", backendErr)
		} else {
			s.attachments = backend
		}

		s.ensureDepartments()
		s.ensureUsers()
		if s.err != nil {
			return s.err
		}

		// ---------- ① 企业官网改版：进行中，健康项目，数据最全 ----------
		p1 := s.createProject(1, model.Project{
			Name:        "企业官网改版",
			Type:        "研发",
			DeptID:      ptrOf(s.deptIDs["产品研发部"]),
			OwnerID:     ptrOf(s.users["zhangwei"]),
			PlanStart:   demoDate(-120),
			PlanEnd:     demoDate(60),
			BudgetTotal: 1200000,
			Priority:    "高",
			Client:      "市场部（内部）",
			Description: "官网整体视觉与信息架构升级，含多语言与 SEO 改造，一期覆盖 PC 与移动端。",
			Status:      "doing",
			CreatedBy:   ptrOf(s.users["zhangwei"]),
			CreatedAt:   demoTS(-125, 9),
		})
		if s.err != nil {
			return s.err
		}
		for _, username := range []string{"zhangwei", "wangqiang", "zhaomin", "sunlei", "chenjing", "zhouzong"} {
			s.addMember(p1.ID, s.users[username])
		}

		t1 := s.createTask(p1.ID, "需求调研与评审", s.users["zhangwei"], demoDate(-120), demoDate(-95), taskOpts{weight: 3, progress: 100})
		t2 := s.createTask(p1.ID, "视觉设计", s.users["zhaomin"], demoDate(-96), demoDate(-70), taskOpts{weight: 2, progress: 100, pred: &t1.ID})
		t3 := s.createTask(p1.ID, "前端开发", s.users["wangqiang"], demoDate(-70), demoDate(12), taskOpts{weight: 4, progress: 72, pred: &t2.ID})
		t4 := s.createTask(p1.ID, "后端接口与 CMS", s.users["wangqiang"], demoDate(-70), demoDate(8), taskOpts{weight: 3, progress: 65, pred: &t2.ID})
		s.createTask(p1.ID, "测试与上线", s.users["zhangwei"], demoDate(-12), demoDate(25), taskOpts{weight: 3, progress: 10, pred: &t3.ID})
		// 二级任务
		s.createTask(p1.ID, "首页与导航", s.users["wangqiang"], demoDate(-70), demoDate(-40), taskOpts{weight: 2, progress: 100, parent: &t3.ID, level: 2})
		s.createTask(p1.ID, "产品详情页", s.users["wangqiang"], demoDate(-45), demoDate(3), taskOpts{weight: 2, progress: 80, parent: &t3.ID, level: 2})
		s.createTask(p1.ID, "响应式适配", s.users["zhaomin"], demoDate(-25), demoDate(10), taskOpts{weight: 2, progress: 45, parent: &t3.ID, level: 2})
		// 逾期任务（计划已过、未完成）→ 逾期预警
		s.createTask(p1.ID, "多语言文案校对", s.users["zhaomin"], demoDate(-30), demoDate(-6), taskOpts{weight: 1, progress: 30})

		s.addLog(p1.ID, t3.ID, 40, "首页与导航完成，开始产品详情页", 6, s.users["wangqiang"], ptrOf(15))
		s.addLog(p1.ID, t3.ID, 60, "产品详情页完成 80%，响应式适配进行中", 3, s.users["wangqiang"], ptrOf(10))
		s.addLog(p1.ID, t3.ID, 72, "详情页完成，适配剩余 3 个断点", 1, s.users["wangqiang"], ptrOf(7))
		s.addLog(p1.ID, t4.ID, 65, "CMS 接口联调完成，剩余权限模块", 2, s.users["wangqiang"], ptrOf(12))

		s.createMilestone(p1.ID, "需求冻结", demoDate(-95), s.users["zhangwei"], demoDate(-93))
		s.createMilestone(p1.ID, "设计交付", demoDate(-70), s.users["zhaomin"], demoDate(-68))
		s.createMilestone(p1.ID, "一期上线", demoDate(2), s.users["zhangwei"], nil) // 临近 → 预警
		s.createMilestone(p1.ID, "验收结项", demoDate(45), s.users["zhangwei"], nil)

		s.createBudget(p1.ID, "人工", 620000, demoDate(-120), demoDate(60))
		s.createBudget(p1.ID, "采购", 300000, demoDate(-120), demoDate(60))
		s.createBudget(p1.ID, "外包", 180000, demoDate(-120), demoDate(60))
		s.createBudget(p1.ID, "差旅", 70000, demoDate(-120), demoDate(60))
		s.createBudget(p1.ID, "其他", 30000, demoDate(-120), demoDate(60))

		for _, item := range []struct {
			offset  int
			subject string
			amount  float64
			note    string
		}{
			{-150, "人工", 96000, "1 月人力成本"},
			{-118, "人工", 98000, "2 月人力成本"},
			{-88, "人工", 92000, "3 月人力成本"},
			{-60, "采购", 120000, "云资源年付"},
			{-45, "人工", 88000, "4 月人力成本"},
			{-30, "外包", 60000, "视觉外包一期"},
			{-18, "差旅", 12000, "客户现场调研差旅"},
			{-8, "人工", 76000, "5 月人力成本"},
			{-4, "其他", 6000, "团队培训"},
		} {
			s.createExpense(p1.ID, item.subject, item.amount, demoDate(item.offset), item.note, "approved", s.users["chenjing"], ptrOf(s.users["chenjing"]))
		}
		s.createExpense(p1.ID, "外包", 45000, demoDate(-2), "外包二期预付款", "pending", s.users["zhangwei"], nil)
		s.createExpense(p1.ID, "其他", 38000, demoDate(-9), "团建费用（超标）", "rejected", s.users["zhangwei"], ptrOf(s.users["chenjing"]))
		s.createExpense(p1.ID, "采购", 52000, demoDate(-6), "显示器与测试机（超预算特批）", "exception", s.users["zhangwei"], ptrOf(s.users["chenjing"]))

		s.createFollowup(p1.ID, s.users["zhangwei"], 21, "会议", "与市场部确认首页信息架构", "输出信息架构终稿", ptrOf(-20)) // 提醒已到期 → 通知
		s.createFollowup(p1.ID, s.users["zhangwei"], 12, "电话", "确认外包二期的交付范围", "等待外包方报价", nil)
		s.createFollowup(p1.ID, s.users["zhaomin"], 5, "现场", "设计走查，收集视觉反馈", "按反馈调整 3 处间距与配色", ptrOf(3)) // 未来提醒

		s.createAttachment(p1.ID, "立项报告.pdf", s.users["zhangwei"], 124, []byte("%PDF-1.4 demo lixiang baogao\n"))
		s.createAttachment(p1.ID, "需求说明书.docx", s.users["zhangwei"], 110, []byte("PK demo requirement doc\n"))
		s.createAttachment(p1.ID, "报价单.xlsx", s.users["chenjing"], 100, []byte("demo quotation\n"))

		s.createChange(p1.ID, "status", "draft", "filed", s.users["zhangwei"], 122)
		s.createChange(p1.ID, "status", "filed", "doing", s.users["zhangwei"], 118)
		s.createChange(p1.ID, "budget_total", "900000", "1200000", s.users["chenjing"], 60)
		s.createChange(p1.ID, "plan_end", demoDate(30).Format("2006-01-02"), demoDate(60).Format("2006-01-02"), s.users["zhangwei"], 30)
		s.createChange(p1.ID, "progress_snapshot", "58.0", "66.4", s.users["zhangwei"], 7)
		s.recalcProgress(p1)
		if s.err != nil {
			return s.err
		}
		result.Projects = append(result.Projects, seededProject{p1.Code, p1.Name, "进行中：任务/里程碑/预算/支出/跟进/附件/留痕齐全，含逾期任务与临近里程碑"})

		// ---------- ② CRM 系统一期实施：停滞 + 预算预警 ----------
		p2 := s.createProject(2, model.Project{
			Name:        "CRM 系统一期实施",
			Type:        "实施",
			DeptID:      ptrOf(s.deptIDs["交付实施部"]),
			OwnerID:     ptrOf(s.users["lina"]),
			PlanStart:   demoDate(-90),
			PlanEnd:     demoDate(90),
			BudgetTotal: 600000,
			Priority:    "高",
			Client:      "销售中心",
			Description: "CRM 一期落地：客户主数据、商机与合同流程上线，覆盖 3 个销售大区。",
			Status:      "doing",
			CreatedBy:   ptrOf(s.users["lina"]),
			CreatedAt:   demoTS(-95, 9),
		})
		if s.err != nil {
			return s.err
		}
		for _, username := range []string{"lina", "liuyang", "chenjing"} {
			s.addMember(p2.ID, s.users[username])
		}

		m1 := s.createTask(p2.ID, "业务蓝图确认", s.users["lina"], demoDate(-90), demoDate(-70), taskOpts{weight: 2, progress: 100})
		m2 := s.createTask(p2.ID, "系统配置与数据迁移", s.users["liuyang"], demoDate(-70), demoDate(-15), taskOpts{weight: 4, progress: 85, pred: &m1.ID})
		s.createTask(p2.ID, "用户培训与试运行", s.users["lina"], demoDate(-15), demoDate(30), taskOpts{weight: 3, progress: 20, pred: &m2.ID})
		s.createTask(p2.ID, "客户主数据清洗", s.users["liuyang"], demoDate(-70), demoDate(-40), taskOpts{weight: 2, progress: 100, parent: &m2.ID, level: 2})
		s.createTask(p2.ID, "商机流程配置", s.users["liuyang"], demoDate(-45), demoDate(-20), taskOpts{weight: 2, progress: 70, parent: &m2.ID, level: 2})
		// 最后一次填报在 9 天前 → 停滞预警
		s.addLog(p2.ID, m2.ID, 70, "商机流程配置完成 70%", 14, s.users["liuyang"], ptrOf(25))
		s.addLog(p2.ID, m2.ID, 85, "数据迁移脚本调试中，遇到编码问题", 9, s.users["liuyang"], ptrOf(20))

		s.createMilestone(p2.ID, "蓝图评审通过", demoDate(-70), s.users["lina"], demoDate(-71))
		s.createMilestone(p2.ID, "系统上线试运行", demoDate(-5), s.users["lina"], nil) // 逾期 → 预警
		s.createMilestone(p2.ID, "一期验收", demoDate(40), s.users["lina"], nil)

		s.createBudget(p2.ID, "人工", 320000, demoDate(-90), demoDate(90))
		s.createBudget(p2.ID, "外包", 180000, demoDate(-90), demoDate(90))
		s.createBudget(p2.ID, "差旅", 60000, demoDate(-90), demoDate(90))
		s.createBudget(p2.ID, "其他", 40000, demoDate(-90), demoDate(90))
		for _, item := range []struct {
			offset  int
			subject string
			amount  float64
			note    string
		}{
			{-88, "人工", 104000, "实施人力 1-3 月"},
			{-60, "人工", 98000, "实施人力 4 月"},
			{-40, "外包", 90000, "数据迁移外包"},
			{-22, "人工", 86000, "实施人力 5 月"},
			{-12, "差旅", 24000, "三地现场差旅"},
			{-5, "外包", 60000, "培训材料制作"},
		} {
			s.createExpense(p2.ID, item.subject, item.amount, demoDate(item.offset), item.note, "approved", s.users["chenjing"], ptrOf(s.users["chenjing"]))
		}

		s.createFollowup(p2.ID, s.users["lina"], 9, "会议", "与销售中心确认上线时间窗口", "等待业务方确认", ptrOf(-30))
		s.createChange(p2.ID, "status", "draft", "filed", s.users["lina"], 92)
		s.createChange(p2.ID, "status", "filed", "doing", s.users["lina"], 88)
		s.recalcProgress(p2)
		if s.err != nil {
			return s.err
		}
		result.Projects = append(result.Projects, seededProject{p2.Code, p2.Name, "进行中但停滞 9 天 + 预算 87% + 里程碑逾期，触发三类预警"})

		// ---------- ③ 数据中台咨询：已立项待开工 ----------
		p3 := s.createProject(3, model.Project{
			Name:        "数据中台建设咨询",
			Type:        "咨询",
			DeptID:      ptrOf(s.deptIDs["产品研发部"]),
			OwnerID:     ptrOf(s.users["sunlei"]),
			PlanStart:   demoDate(7),
			PlanEnd:     demoDate(120),
			BudgetTotal: 380000,
			Priority:    "中",
			Client:      "集团信息中心",
			Description: "数据治理体系与中台建设路线图咨询，输出总体架构与分期实施建议。",
			Status:      "filed",
			CreatedBy:   ptrOf(s.users["sunlei"]),
			CreatedAt:   demoTS(-20, 9),
		})
		if s.err != nil {
			return s.err
		}
		s.addMember(p3.ID, s.users["sunlei"])
		s.addMember(p3.ID, s.users["zhangwei"])
		s.createTask(p3.ID, "现状调研", s.users["zhangwei"], demoDate(7), demoDate(30), taskOpts{weight: 1, progress: 0})
		s.createTask(p3.ID, "架构方案设计", s.users["zhangwei"], demoDate(31), demoDate(80), taskOpts{weight: 1, progress: 0})
		s.createMilestone(p3.ID, "项目启动会", demoDate(8), s.users["sunlei"], nil)
		s.createBudget(p3.ID, "人工", 260000, demoDate(7), demoDate(120))
		s.createBudget(p3.ID, "差旅", 80000, demoDate(7), demoDate(120))
		s.createBudget(p3.ID, "其他", 40000, demoDate(7), demoDate(120))
		s.createExpense(p3.ID, "差旅", 8600, demoDate(-1), "启动会差旅预支", "pending", s.users["sunlei"], nil)
		s.createChange(p3.ID, "status", "draft", "filed", s.users["sunlei"], 18)
		s.createFollowup(p3.ID, s.users["sunlei"], 4, "会议", "与信息中心对齐交付边界", "输出调研提纲", ptrOf(10))
		if s.err != nil {
			return s.err
		}
		result.Projects = append(result.Projects, seededProject{p3.Code, p3.Name, "已立项待开工：有预算与待审批支出（审批中心可处理）"})

		// ---------- ④ 智能仓储改造工程：暂停 + 预算调整待审批 ----------
		p4 := s.createProject(4, model.Project{
			Name:        "智能仓储改造工程",
			Type:        "工程",
			DeptID:      ptrOf(s.deptIDs["交付实施部"]),
			OwnerID:     ptrOf(s.users["lina"]),
			PlanStart:   demoDate(-150),
			PlanEnd:     demoDate(-10),
			BudgetTotal: 1200000,
			Priority:    "高",
			Client:      "供应链中心",
			Description: "一号仓智能化改造：AGV 调度、WMS 对接、库位改造，分两期实施。",
			Status:      "paused",
			CreatedBy:   ptrOf(s.users["lina"]),
			CreatedAt:   demoTS(-155, 9),
		})
		if s.err != nil {
			return s.err
		}
		for _, username := range []string{"lina", "liuyang", "chenjing"} {
			s.addMember(p4.ID, s.users[username])
		}
		g1 := s.createTask(p4.ID, "库位与场地改造", s.users["liuyang"], demoDate(-150), demoDate(-100), taskOpts{weight: 3, progress: 100})
		g2 := s.createTask(p4.ID, "设备采购与到货", s.users["lina"], demoDate(-140), demoDate(-60), taskOpts{weight: 4, progress: 90, pred: &g1.ID})
		s.createTask(p4.ID, "WMS 对接联调", s.users["liuyang"], demoDate(-70), demoDate(-20), taskOpts{weight: 4, progress: 55, pred: &g2.ID})
		s.createTask(p4.ID, "AGV 调度调试", s.users["liuyang"], demoDate(-40), demoDate(-12), taskOpts{weight: 3, progress: 35, pred: &g2.ID})
		s.addLog(p4.ID, g2.ID, 90, "设备到货 90%，剩余一台 AGV 未到", 20, s.users["lina"], ptrOf(10))
		s.createMilestone(p4.ID, "设备到货", demoDate(-60), s.users["lina"], demoDate(-58))
		s.createMilestone(p4.ID, "联调完成", demoDate(-3), s.users["liuyang"], nil) // 逾期
		s.createBudget(p4.ID, "采购", 600000, demoDate(-150), demoDate(-10))
		s.createBudget(p4.ID, "外包", 400000, demoDate(-150), demoDate(-10))
		s.createBudget(p4.ID, "人工", 200000, demoDate(-150), demoDate(-10))
		for _, item := range []struct {
			offset  int
			subject string
			amount  float64
			note    string
		}{
			{-145, "采购", 180000, "货架与输送线"},
			{-120, "采购", 200000, "AGV 首批 4 台"},
			{-95, "外包", 150000, "场地改造外包"},
			{-70, "采购", 120000, "AGV 第二批 + 配件"},
			{-50, "外包", 120000, "WMS 对接外包"},
			{-25, "人工", 60000, "现场实施人力"},
			{-8, "采购", 70000, "备件与耗材（超预算特批）"},
		} {
			status := "approved"
			if strings.HasSuffix(item.note, "特批）") {
				status = "exception"
			}
			s.createExpense(p4.ID, item.subject, item.amount, demoDate(item.offset), item.note, status, s.users["chenjing"], ptrOf(s.users["chenjing"]))
		}
		s.createExpense(p4.ID, "采购", 46000, demoDate(-3), "第三批 AGV 追加（超预算）", "pending", s.users["lina"], nil)

		budget4 := s.findBudget(p4.ID, "采购")
		s.createBudgetAdjust(budget4.ID, p4.ID, 600000, 700000, "AGV 追加一台，采购预算需上调 10 万", s.users["lina"])
		s.createChange(p4.ID, "status", "doing", "paused", s.users["lina"], 12)
		s.createFollowup(p4.ID, s.users["lina"], 12, "现场", "与供应链中心沟通暂停期间的到场安排", "待确认复工时间", ptrOf(-8))
		s.recalcProgress(p4)
		if s.err != nil {
			return s.err
		}
		result.Projects = append(result.Projects, seededProject{p4.Code, p4.Name, "暂停：采购执行率超 80% + 超支特批 + 预算调整待审批（审批中心可处理）"})

		// ---------- ⑤ 移动端 App 重构：已完成 ----------
		p5 := s.createProject(5, model.Project{
			Name:        "移动端 App 重构",
			Type:        "研发",
			DeptID:      ptrOf(s.deptIDs["产品研发部"]),
			OwnerID:     ptrOf(s.users["zhangwei"]),
			PlanStart:   demoDate(-200),
			PlanEnd:     demoDate(-30),
			BudgetTotal: 620000,
			Priority:    "中",
			Client:      "C 端用户",
			Description: "App 架构与交互重构，性能优化与新版设计语言落地，已通过验收。",
			Status:      "done",
			CreatedBy:   ptrOf(s.users["zhangwei"]),
			CreatedAt:   demoTS(-205, 9),
		})
		if s.err != nil {
			return s.err
		}
		for _, username := range []string{"zhangwei", "wangqiang", "zhaomin"} {
			s.addMember(p5.ID, s.users[username])
		}
		k1 := s.createTask(p5.ID, "架构重构", s.users["wangqiang"], demoDate(-200), demoDate(-120), taskOpts{weight: 3, progress: 100})
		k2 := s.createTask(p5.ID, "新版视觉落地", s.users["zhaomin"], demoDate(-140), demoDate(-60), taskOpts{weight: 2, progress: 100, pred: &k1.ID})
		s.createTask(p5.ID, "性能优化与验收", s.users["zhangwei"], demoDate(-60), demoDate(-30), taskOpts{weight: 3, progress: 100, pred: &k2.ID})
		s.createMilestone(p5.ID, "重构完成", demoDate(-120), s.users["zhangwei"], demoDate(-118))
		s.createMilestone(p5.ID, "验收通过", demoDate(-30), s.users["zhangwei"], demoDate(-31))
		s.createBudget(p5.ID, "人工", 520000, demoDate(-200), demoDate(-30))
		s.createBudget(p5.ID, "其他", 100000, demoDate(-200), demoDate(-30))
		for _, item := range []struct {
			offset  int
			subject string
			amount  float64
			note    string
		}{
			{-190, "人工", 150000, "重构人力 1-2 月"},
			{-140, "人工", 140000, "重构人力 3-4 月"},
			{-90, "人工", 120000, "重构人力 5 月"},
			{-60, "其他", 70000, "测试设备与工具"},
		} {
			s.createExpense(p5.ID, item.subject, item.amount, demoDate(item.offset), item.note, "approved", s.users["chenjing"], ptrOf(s.users["chenjing"]))
		}
		for _, change := range []struct {
			oldValue string
			newValue string
			daysAgo  int
		}{
			{"draft", "filed", 200},
			{"filed", "doing", 195},
			{"doing", "done", 30},
		} {
			s.createChange(p5.ID, "status", change.oldValue, change.newValue, s.users["zhangwei"], change.daysAgo)
		}
		s.recalcProgress(p5)
		if s.err != nil {
			return s.err
		}
		result.Projects = append(result.Projects, seededProject{p5.Code, p5.Name, "已完成：全任务 100%，预算执行 92%，可作为结项样板"})

		// ---------- ⑥ 年度运维服务外包：已归档（只读） ----------
		p6 := s.createProject(6, model.Project{
			Name:        "2025 年度运维服务外包",
			Type:        "服务",
			DeptID:      ptrOf(s.deptIDs["交付实施部"]),
			OwnerID:     ptrOf(s.users["lina"]),
			PlanStart:   demoDate(-400),
			PlanEnd:     demoDate(-35),
			BudgetTotal: 300000,
			Priority:    "低",
			Client:      "综合部",
			Description: "上一年度基础设施运维外包服务，已结项归档，仅供查询与追溯。",
			Status:      "archived",
			CreatedBy:   ptrOf(s.users["lina"]),
			CreatedAt:   demoTS(-405, 9),
		})
		if s.err != nil {
			return s.err
		}
		s.addMember(p6.ID, s.users["lina"])
		s.createTask(p6.ID, "日常运维值守", s.users["liuyang"], demoDate(-400), demoDate(-35), taskOpts{weight: 1, progress: 100})
		s.createMilestone(p6.ID, "服务期满", demoDate(-35), s.users["lina"], demoDate(-35))
		s.createBudget(p6.ID, "外包", 300000, demoDate(-400), demoDate(-35))
		s.createExpense(p6.ID, "外包", 290000, demoDate(-40), "全年运维外包结算", "approved", s.users["chenjing"], ptrOf(s.users["chenjing"]))
		s.createChange(p6.ID, "status", "done", "archived", s.users["lina"], 34)
		s.recalcProgress(p6)
		if s.err != nil {
			return s.err
		}
		result.Projects = append(result.Projects, seededProject{p6.Code, p6.Name, "已归档：只读，可在回收站/归档列表中验证只读约束"})

		// ---------- ⑦ 内部工具立项：待立项审批 ----------
		p7 := s.createProject(7, model.Project{
			Name:        "内部效能工具建设",
			Type:        "研发",
			DeptID:      ptrOf(s.deptIDs["产品研发部"]),
			OwnerID:     ptrOf(s.users["zhangwei"]),
			PlanStart:   demoDate(15),
			PlanEnd:     demoDate(150),
			BudgetTotal: 150000,
			Priority:    "低",
			Client:      "内部",
			Description: "面向研发团队的效能度量与自动化工具建设，立项审批中。",
			Status:      "pending",
			CreatedBy:   ptrOf(s.users["zhangwei"]),
			CreatedAt:   demoTS(-2, 9),
		})
		if s.err != nil {
			return s.err
		}
		s.addMember(p7.ID, s.users["zhangwei"])
		result.Projects = append(result.Projects, seededProject{p7.Code, p7.Name, "待立项审批：审批中心有立项待办，通过后进入「已立项」"})

		// ---------- ⑧ 试点失败项目：已取消 ----------
		p8 := s.createProject(8, model.Project{
			Name:        "线下门店数字化试点",
			Type:        "实施",
			DeptID:      ptrOf(s.deptIDs["交付实施部"]),
			OwnerID:     ptrOf(s.users["lina"]),
			PlanStart:   demoDate(-180),
			PlanEnd:     demoDate(-60),
			BudgetTotal: 200000,
			Priority:    "低",
			Client:      "门店运营部",
			Description: "因业务方向调整终止，保留数据用于复盘。",
			Status:      "cancelled",
			CreatedBy:   ptrOf(s.users["lina"]),
			CreatedAt:   demoTS(-185, 9),
		})
		if s.err != nil {
			return s.err
		}
		s.addMember(p8.ID, s.users["lina"])
		s.createTask(p8.ID, "门店调研", s.users["lina"], demoDate(-180), demoDate(-140), taskOpts{weight: 1, progress: 100})
		s.createExpense(p8.ID, "差旅", 18000, demoDate(-150), "门店走访差旅", "approved", s.users["chenjing"], ptrOf(s.users["chenjing"]))
		s.createChange(p8.ID, "status", "filed", "cancelled", s.users["lina"], 100)
		s.createFollowup(p8.ID, s.users["lina"], 100, "会议", "确认试点终止，转入复盘", "输出复盘纪要并归档", nil)
		s.recalcProgress(p8)
		if s.err != nil {
			return s.err
		}
		result.Projects = append(result.Projects, seededProject{p8.Code, p8.Name, "已取消：终态，用于验证状态机与复盘场景"})

		// ---------- ⑨ 智能客服知识库建设：草稿（新建未立项） ----------
		p9 := s.createProject(9, model.Project{
			Name:        "智能客服知识库建设",
			Type:        "研发",
			DeptID:      ptrOf(s.deptIDs["产品研发部"]),
			OwnerID:     ptrOf(s.users["zhangwei"]),
			PlanStart:   demoDate(20),
			PlanEnd:     demoDate(140),
			BudgetTotal: 0,
			Priority:    "低",
			Client:      "客服中心",
			Description: "基于历史工单构建客服知识库，仍在草稿阶段，尚未提交立项审批。",
			Status:      "draft",
			CreatedBy:   ptrOf(s.users["zhangwei"]),
			CreatedAt:   demoTS(-1, 9),
		})
		if s.err != nil {
			return s.err
		}
		s.addMember(p9.ID, s.users["zhangwei"])
		result.Projects = append(result.Projects, seededProject{p9.Code, p9.Name, "草稿：新建未立项，验证「草稿 → 已立项/待审批」流转与未填预算场景"})

		// ---------- 站内通知：预警落库 + 立项待办 ----------
		projects := []*model.Project{p1, p2, p3, p4, p5, p6, p7, p8, p9}
		s.createNotifications(projects, p7)
		if s.err != nil {
			return s.err
		}
		result.Notifications = len(s.notificationIDs)
		result.WarningNotifications = s.warningNotifications
		return nil
	})
	if err != nil {
		return nil, err
	}
	return result, nil
}

func (s *seeder) createBudgetAdjust(budgetID, projectID uint, oldAmount, newAmount float64, reason string, byID uint) {
	if s.err != nil {
		return
	}
	row := &model.BudgetAdjust{
		BudgetID:  budgetID,
		ProjectID: projectID,
		OldAmount: oldAmount,
		NewAmount: newAmount,
		Reason:    reason,
		Status:    "pending",
		ByID:      ptrOf(byID),
		CreatedAt: demoTS(-3, 16),
	}
	if err := s.db.Omit(clause.Associations).Create(row).Error; err != nil {
		s.fail("创建预算调整单", err)
	}
}

// warningNotifications 记录预警通知条数（不含立项待办），用于终端输出。
func (s *seeder) createNotifications(projects []*model.Project, filingProject *model.Project) {
	if s.err != nil || len(projects) == 0 {
		return
	}

	pids := make([]uint, 0, len(projects))
	ownerOf := make(map[uint]*uint, len(projects))
	for _, project := range projects {
		pids = append(pids, project.ID)
		ownerOf[project.ID] = project.OwnerID
	}

	now := timeutil.AppNow()
	today := demoTodayString()
	nowDateTime := timeutil.NewDateTime(now)
	milestoneWarnDays := s.sysParamInt("milestone_warn_days", 3)
	stagnantDays := s.sysParamInt("stagnant_days", 7)
	rateLine := s.sysParamFloat("budget_warn_rate", 0.8)
	if s.err != nil {
		return
	}
	milestoneDeadline := timeutil.NewDate(now.AddDate(0, 0, milestoneWarnDays)).Format("2006-01-02")

	// 1) 逾期任务：任务负责人 + 项目负责人
	var tasks []model.Task
	if err := s.db.Where(
		"project_id IN ? AND plan_end IS NOT NULL AND plan_end < ? AND status <> ? AND progress < ?",
		pids, today, "done", 100,
	).Order("plan_end").Limit(maxPerType).Find(&tasks).Error; err != nil {
		s.fail("查询逾期任务", err)
		return
	}
	for i := range tasks {
		task := &tasks[i]
		body := "计划结束仍未完成"
		if task.PlanEnd != nil {
			body = fmt.Sprintf("计划结束 %s，仍未完成", task.PlanEnd.Format("2006-01-02"))
		}
		title := fmt.Sprintf("任务逾期：%s", task.Name)
		refID, projectID := task.ID, task.ProjectID
		s.warningNotifications += s.pushTo(
			uniqueIDs(task.OwnerID, ownerOf[task.ProjectID]),
			"overdue_task", title, body, "task", &refID, &projectID,
			fmt.Sprintf("overdue_task:%d", task.ID),
		)
	}

	// 2) 里程碑临近/逾期：里程碑负责人 + 项目负责人
	var milestones []model.Milestone
	if err := s.db.Where(
		"project_id IN ? AND status = ? AND actual_date IS NULL AND plan_date IS NOT NULL AND plan_date <= ?",
		pids, "open", milestoneDeadline,
	).Order("plan_date").Limit(maxPerType).Find(&milestones).Error; err != nil {
		s.fail("查询里程碑预警", err)
		return
	}
	for i := range milestones {
		milestone := &milestones[i]
		if milestone.PlanDate == nil {
			continue
		}
		daysLeft := int(milestone.PlanDate.Time.Sub(demoToday.Time).Hours() / 24)
		state := fmt.Sprintf("%d 天后到期", daysLeft)
		if milestone.PlanDate.Before(demoToday.Time) {
			state = "已逾期"
		}
		title := fmt.Sprintf("里程碑%s：%s", state, milestone.Name)
		body := fmt.Sprintf("计划日期 %s", milestone.PlanDate.Format("2006-01-02"))
		refID, projectID := milestone.ID, milestone.ProjectID
		s.warningNotifications += s.pushTo(
			uniqueIDs(milestone.OwnerID, ownerOf[milestone.ProjectID]),
			"milestone", title, body, "milestone", &refID, &projectID,
			fmt.Sprintf("milestone:%d", milestone.ID),
		)
	}

	// 3) 停滞项目：进行中且连续 N 天无填报
	for _, project := range projects {
		if project.Status != "doing" {
			continue
		}
		var last sql.NullTime
		if err := s.db.Raw("SELECT MAX(created_at) FROM progress_logs WHERE project_id = ?", project.ID).Row().Scan(&last); err != nil {
			s.fail("查询项目最近填报", err)
			return
		}
		days := stagnantDays
		if last.Valid {
			lastTime := time.Date(last.Time.Year(), last.Time.Month(), last.Time.Day(), last.Time.Hour(), last.Time.Minute(), last.Time.Second(), 0, timeutil.Loc)
			days = int(now.Sub(lastTime).Hours() / 24)
		}
		if days < stagnantDays {
			continue
		}
		title := fmt.Sprintf("项目停滞 %d 天：%s", days, project.Name)
		refID, projectID := project.ID, project.ID
		s.warningNotifications += s.pushTo(
			uniqueIDs(project.OwnerID),
			"stagnant", title, "连续多日无进度填报，请跟进", "project", &refID, &projectID,
			fmt.Sprintf("stagnant:%d", project.ID),
		)
	}

	// 4) 预算预警：项目负责人 + 超级管理员
	type subjectTotal struct {
		ProjectID uint
		Subject   string
		Total     float64
	}
	var budgetRows []subjectTotal
	if err := s.db.Model(&model.Budget{}).
		Select("project_id, subject, COALESCE(SUM(amount), 0) AS total").
		Where("project_id IN ?", pids).
		Group("project_id, subject").
		Scan(&budgetRows).Error; err != nil {
		s.fail("汇总项目预算", err)
		return
	}
	var spentRows []subjectTotal
	if err := s.db.Model(&model.Expense{}).
		Select("project_id, subject, COALESCE(SUM(amount), 0) AS total").
		Where("project_id IN ? AND status IN ?", pids, []string{"approved", "exception"}).
		Group("project_id, subject").
		Scan(&spentRows).Error; err != nil {
		s.fail("汇总项目已通过支出", err)
		return
	}

	type projectSubject struct {
		ProjectID uint
		Subject   string
	}
	budgets := make(map[projectSubject]float64, len(budgetRows))
	for _, row := range budgetRows {
		budgets[projectSubject{row.ProjectID, row.Subject}] = row.Total
	}
	spent := make(map[projectSubject]float64, len(spentRows))
	for _, row := range spentRows {
		spent[projectSubject{row.ProjectID, row.Subject}] = row.Total
	}
	keys := make([]projectSubject, 0, len(budgets))
	for key := range budgets {
		keys = append(keys, key)
	}
	sort.Slice(keys, func(i, j int) bool {
		if keys[i].ProjectID != keys[j].ProjectID {
			return keys[i].ProjectID < keys[j].ProjectID
		}
		return keys[i].Subject < keys[j].Subject
	})

	admins := s.superAdminIDs()
	for _, key := range keys {
		budgetAmount := budgets[key]
		if budgetAmount <= 0 {
			continue
		}
		spentAmount := spent[key]
		rate := roundTo(spentAmount/budgetAmount, 4)
		warn := rate >= rateLine
		over := spentAmount > budgetAmount
		if !warn && !over {
			continue
		}
		state := fmt.Sprintf("执行率 %.1f%%", roundTo(rate*100, 1))
		if over {
			state = "已超预算"
		}
		title := fmt.Sprintf("预算预警（%s）：%s", key.Subject, state)
		body := fmt.Sprintf("预算 %.1f，已支出 %.1f", budgetAmount, spentAmount)
		refID := key.ProjectID
		recipients := mergeIDs(uniqueIDs(ownerOf[key.ProjectID]), admins...)
		s.warningNotifications += s.pushTo(
			recipients,
			"budget", title, body, "project", &refID, &refID,
			fmt.Sprintf("budget:%d:%s", key.ProjectID, key.Subject),
		)
	}

	// 5) 跟进到期提醒：推送后把跟进标记为已通知（remind_state=done）
	var dueFollowups []model.Followup
	if err := s.db.Where(
		"project_id IN ? AND remind_at IS NOT NULL AND remind_at <= ? AND (remind_state IN ? OR remind_state IS NULL OR remind_state = '')",
		pids, nowDateTime, []string{"pending", "none"},
	).Order("remind_at").Limit(maxPerType).Find(&dueFollowups).Error; err != nil {
		s.fail("查询到期跟进提醒", err)
		return
	}
	var remindedIDs []uint
	for i := range dueFollowups {
		followup := &dueFollowups[i]
		if followup.UserID == nil || followup.ProjectID == 0 {
			continue
		}
		refID, projectID := followup.ID, followup.ProjectID
		s.warningNotifications += s.pushTo(
			[]uint{*followup.UserID},
			"followup", "跟进提醒到期", truncateRunes(followup.Content, 120), "followup", &refID, &projectID,
			fmt.Sprintf("followup:%d", followup.ID),
		)
		remindedIDs = append(remindedIDs, followup.ID)
	}
	if len(remindedIDs) > 0 {
		if err := s.db.Model(&model.Followup{}).Where("id IN ?", remindedIDs).Updates(map[string]any{
			"remind_state": "done",
			"reminded_at":  nowDateTime,
		}).Error; err != nil {
			s.fail("标记跟进提醒已推送", err)
			return
		}
	}

	// 6) 立项审批待办：超级管理员 + 项目负责人
	if filingProject != nil {
		title := fmt.Sprintf("立项审批待处理：%s", filingProject.Name)
		body := fmt.Sprintf("编号 %s，预算 %.1f", filingProject.Code, filingProject.BudgetTotal)
		refID := filingProject.ID
		recipients := mergeIDs(s.superAdminIDs(), s.users["zhangwei"])
		s.pushTo(
			recipients,
			"approval", title, body, "project", &refID, &refID,
			fmt.Sprintf("filing-request:%d", filingProject.ID),
		)
	}
	if s.err != nil {
		return
	}

	// 让通知有已读/未读混合状态，并演示「已处理 / 待处理」两种处理状态。
	s.markNotifications()
}

func (s *seeder) pushTo(recipients []uint, nType, title, body, refType string, refID, projectID *uint, dedupKey string) int {
	if s.err != nil {
		return 0
	}
	count := 0
	for _, userID := range recipients {
		row, err := notify.Push(s.db, userID, nType, title, body, "in_app", refType, refID, projectID, dedupKey)
		if err != nil {
			s.fail("写入站内通知", err)
			return count
		}
		if row != nil {
			s.notificationIDs = append(s.notificationIDs, row.ID)
			count++
		}
	}
	return count
}

func (s *seeder) markNotifications() {
	if s.err != nil || len(s.notificationIDs) == 0 {
		return
	}
	readCount := len(s.notificationIDs) / 3
	if readCount < 1 {
		readCount = 1
	}
	if err := s.db.Model(&model.Notification{}).
		Where("id IN ?", s.notificationIDs[:readCount]).
		Update("read_at", demoTS(-1, 17)).Error; err != nil {
		s.fail("标记通知已读", err)
		return
	}

	handledAt := demoTS(-1, 18)
	handledBy, ok := s.users["zhangwei"]
	if !ok {
		s.fail("标记通知处理状态", errors.New("演示账号 zhangwei 不存在"))
		return
	}
	for i := 1; i < len(s.notificationIDs); i += 4 {
		if err := s.db.Model(&model.Notification{}).Where("id = ?", s.notificationIDs[i]).Updates(map[string]any{
			"state":       "done",
			"handled_at":  handledAt,
			"handled_by":  handledBy,
			"handle_note": "已与项目组确认处理",
		}).Error; err != nil {
			s.fail("标记通知处理状态", err)
			return
		}
	}
}

func (s *seeder) superAdminIDs() []uint {
	if s.err != nil {
		return nil
	}
	var ids []uint
	if err := s.db.Model(&model.User{}).Where("is_super_admin = ?", true).Order("id").Pluck("id", &ids).Error; err != nil {
		s.fail("查询超级管理员", err)
		return nil
	}
	return ids
}

func (s *seeder) sysParamInt(key string, fallback int) int {
	var param model.SysParam
	err := s.db.Where("key = ?", key).First(&param).Error
	if err != nil {
		if !errors.Is(err, gorm.ErrRecordNotFound) {
			s.fail("读取系统参数 "+key, err)
		}
		return fallback
	}
	value, parseErr := strconv.Atoi(strings.TrimSpace(param.Value))
	if parseErr != nil {
		return fallback
	}
	return value
}

func (s *seeder) sysParamFloat(key string, fallback float64) float64 {
	var param model.SysParam
	err := s.db.Where("key = ?", key).First(&param).Error
	if err != nil {
		if !errors.Is(err, gorm.ErrRecordNotFound) {
			s.fail("读取系统参数 "+key, err)
		}
		return fallback
	}
	value, parseErr := strconv.ParseFloat(strings.TrimSpace(param.Value), 64)
	if parseErr != nil {
		return fallback
	}
	return value
}

// ---------------------------------------------------------------- 清理

func clean(db *gorm.DB) error {
	var projects []model.Project
	if err := db.Where("is_demo = ? OR code LIKE ?", true, demoCodePrefix+"%").Find(&projects).Error; err != nil {
		return fmt.Errorf("查询示例项目失败: %w", err)
	}
	pids := make([]uint, 0, len(projects))
	for _, project := range projects {
		pids = append(pids, project.ID)
	}

	removedFiles := 0
	if len(pids) > 0 {
		var attachments []model.Attachment
		if err := db.Where("project_id IN ?", pids).Find(&attachments).Error; err != nil {
			return fmt.Errorf("查询示例附件失败: %w", err)
		}
		dirs := make(map[string]struct{})
		for _, attachment := range attachments {
			removed, dir := removeAttachmentFile(attachment)
			if removed {
				removedFiles++
			}
			if dir != "" {
				dirs[dir] = struct{}{}
			}
		}
		// 只删除空目录；与 Python 版的行为一致。
		for dir := range dirs {
			_ = os.Remove(dir)
		}
	}

	removedUsers := 0
	err := db.Transaction(func(tx *gorm.DB) error {
		if len(pids) > 0 {
			// 先删子表，再删项目；approval_records 也带 project_id，一并清理。
			projectScoped := []any{
				&model.Notification{},
				&model.ApprovalRecord{},
				&model.ProjectChange{},
				&model.Followup{},
				&model.Attachment{},
				&model.ProgressLog{},
				&model.Milestone{},
				&model.Task{},
				&model.BudgetAdjust{},
				&model.Budget{},
				&model.Expense{},
				&model.ProjectMember{},
			}
			for _, value := range projectScoped {
				if err := tx.Where("project_id IN ?", pids).Delete(value).Error; err != nil {
					return fmt.Errorf("清理项目关联数据失败: %w", err)
				}
			}
			if err := tx.Where("id IN ?", pids).Delete(&model.Project{}).Error; err != nil {
				return fmt.Errorf("清理示例项目失败: %w", err)
			}
		}

		usernames := make([]string, 0, len(demoUsers))
		for _, user := range demoUsers {
			usernames = append(usernames, user.Username)
		}
		var userIDs []uint
		if err := tx.Model(&model.User{}).Where("username IN ?", usernames).Pluck("id", &userIDs).Error; err != nil {
			return fmt.Errorf("查询示例用户失败: %w", err)
		}
		removedUsers = len(userIDs)
		if len(userIDs) == 0 {
			return nil
		}

		// 通知的处理人、跟进的处理人也引用这些用户，先置空避免外键阻塞。
		if err := tx.Model(&model.Notification{}).Where("handled_by IN ?", userIDs).Update("handled_by", nil).Error; err != nil {
			return fmt.Errorf("清理示例通知处理人失败: %w", err)
		}
		if err := tx.Model(&model.Followup{}).Where("handled_by IN ?", userIDs).Update("handled_by", nil).Error; err != nil {
			return fmt.Errorf("清理示例跟进处理人失败: %w", err)
		}
		if err := tx.Where("user_id IN ?", userIDs).Delete(&model.Notification{}).Error; err != nil {
			return fmt.Errorf("清理示例通知失败: %w", err)
		}
		if err := tx.Where("user_id IN ?", userIDs).Delete(&model.UserRole{}).Error; err != nil {
			return fmt.Errorf("清理示例用户角色失败: %w", err)
		}
		if err := tx.Model(&model.AuditLog{}).Where("user_id IN ?", userIDs).Update("user_id", nil).Error; err != nil {
			return fmt.Errorf("清理示例用户审计归属失败: %w", err)
		}
		if err := tx.Where("user_id IN ?", userIDs).Delete(&model.TokenBlacklist{}).Error; err != nil {
			return fmt.Errorf("清理示例用户令牌失败: %w", err)
		}
		if err := tx.Where("id IN ?", userIDs).Delete(&model.User{}).Error; err != nil {
			return fmt.Errorf("清理示例用户失败: %w", err)
		}
		return nil
	})
	if err != nil {
		return err
	}

	fmt.Printf("已清理：项目 %d 个、示例用户 %d 个、附件文件 %d 个\n", len(pids), removedUsers, removedFiles)
	return nil
}

func removeAttachmentFile(attachment model.Attachment) (bool, string) {
	if strings.EqualFold(strings.TrimSpace(attachment.StorageBackend), "r2") {
		return false, ""
	}
	path := strings.TrimSpace(attachment.Path)
	if path == "" {
		return false, ""
	}
	err := os.Remove(path)
	removed := err == nil || errors.Is(err, os.ErrNotExist)
	return removed, filepath.Dir(path)
}

// ---------------------------------------------------------------- 终端输出

func printSummary(db *gorm.DB, result *seedResult) {
	fmt.Printf("站内通知已生成（预警 %d 条 + 立项待办）\n", result.WarningNotifications)
	fmt.Println()
	fmt.Printf("完成：%d 个项目、%d 条通知\n", len(result.Projects), result.Notifications)
	for _, project := range result.Projects {
		fmt.Printf("  %s  %s\n      %s\n", project.Code, project.Name, project.Desc)
	}

	fmt.Println()
	fmt.Println("示例账号（密码统一 demo123456）：")
	scopes := map[string]string{
		"demo_admin": "管理员：全部项目 + 审批中心 + 系统管理",
		"zhangwei":   "负责人：9001/9003/9005/9007",
		"lina":       "负责人：9002/9004/9006/9008",
		"wangqiang":  "参与人：9001/9005",
		"zhaomin":    "参与人：9001/9005",
		"liuyang":    "参与人：9002/9004/9006",
		"chenjing":   "参与人：9001/9002/9004（费用登记）",
		"sunlei":     "负责人 9003、参与人 9001",
		"zhouzong":   "参与人：9001（非管理员不再具备全局只读视图）",
	}
	for _, user := range demoUsers {
		fmt.Printf("  %-12s %s（%s） %s\t%s\n", user.Username, user.RealName, user.Dept, strings.Join(user.Roles, "/"), scopes[user.Username])
	}
	fmt.Println("  审批中心与系统管理仅管理员可用 → 用 demo_admin 演示（不影响你自己的 admin 密码）")

	fmt.Println()
	state := "当前隐藏"
	var param model.SysParam
	if err := db.Where("key = ?", "demo_data_on").First(&param).Error; err == nil && param.Value == "1" {
		state = "已显示"
	}
	fmt.Printf("演示数据开关：%s\n", state)
	fmt.Println("  · 打开：项目台账页头「显示演示数据」开关，或 系统管理 → 参数 → demo_data_on")
	fmt.Println("  · 直连：PUT /api/v1/admin/demo-data {\"on\": true}（仅管理员）")
	fmt.Println()
	fmt.Println("建议验收路径：/dashboard → /projects → 项目详情四个 Tab → /progress → /costs → /approvals → 顶栏铃铛")
}
