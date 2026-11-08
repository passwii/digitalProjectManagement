package test

import (
	"fmt"
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"digitalprojectmanagement/api/internal/admin"
	"digitalprojectmanagement/api/internal/approval"
	"digitalprojectmanagement/api/internal/auth"
	"digitalprojectmanagement/api/internal/budget"
	"digitalprojectmanagement/api/internal/contact"
	"digitalprojectmanagement/api/internal/dashboard"
	"digitalprojectmanagement/api/internal/equipment"
	"digitalprojectmanagement/api/internal/expense"
	"digitalprojectmanagement/api/internal/finance"
	"digitalprojectmanagement/api/internal/meta"
	"digitalprojectmanagement/api/internal/milestone"
	"digitalprojectmanagement/api/internal/model"
	"digitalprojectmanagement/api/internal/notify"
	"digitalprojectmanagement/api/internal/opportunity"
	"digitalprojectmanagement/api/internal/partner"
	"digitalprojectmanagement/api/internal/project"
	"digitalprojectmanagement/api/internal/receivable"
	"digitalprojectmanagement/api/internal/report"
	"digitalprojectmanagement/api/internal/task"
	"digitalprojectmanagement/api/pkg/database"
	"digitalprojectmanagement/api/pkg/security"
	"digitalprojectmanagement/api/pkg/storage"
	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

func setupTestApp(t *testing.T) (*gin.Engine, *gorm.DB) {
	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		dbURL = os.Getenv("TEST_DATABASE_URL")
	}
	if dbURL == "" {
		t.Skip("DATABASE_URL / TEST_DATABASE_URL not set; skipping database integration tests")
	}

	security.Init("test-integration-secret-key-12345")
	db, err := database.Init(dbURL, "test")
	if err != nil {
		t.Skipf("cannot connect to database: %v", err)
	}

	// AutoMigrate models if needed
	_ = db.AutoMigrate(
		&model.Department{}, &model.User{}, &model.Role{}, &model.UserRole{}, &model.UserModule{},
		&model.SysParam{}, &model.Dict{}, &model.AuditLog{}, &model.TokenBlacklist{},
		&model.Project{}, &model.ProjectMember{}, &model.ProjectChange{}, &model.Attachment{},
		&model.Followup{}, &model.Milestone{}, &model.Task{}, &model.ProgressLog{},
		&model.Budget{}, &model.BudgetAdjust{}, &model.Expense{}, &model.ApprovalRecord{},
		&model.ProjectReceivable{}, &model.ProjectReceivablePayment{},
		&model.ContactProfile{}, &model.Partner{}, &model.PartnerContract{}, &model.Opportunity{},
		&model.Notification{}, &model.EquipmentBatch{}, &model.EquipmentAsset{}, &model.EquipmentEvent{},
		&model.AccountBook{}, &model.AccountBookMember{}, &model.AccountingPeriod{}, &model.Account{},
		&model.OpeningBalance{}, &model.AuxiliaryItem{}, &model.AccountAuxiliary{}, &model.AccountBalance{},
		&model.Voucher{}, &model.VoucherEntry{}, &model.VoucherTemplate{}, &model.CashTransaction{},
		&model.BankStatement{}, &model.FixedAsset{}, &model.AssetDepreciation{},
		&model.ARAPTransaction{}, &model.ARAPAllocation{},
	)

	loc, _ := storage.NewLocalBackend(os.TempDir())
	storage.InitGlobal(loc)

	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(gin.Recovery())

	v1 := r.Group("/api/v1")
	{
		auth.RegisterRoutes(v1, db)
		meta.RegisterRoutes(v1, db)
		admin.RegisterRoutes(v1, db)
		project.RegisterRoutes(v1, db)
		task.RegisterRoutes(v1, db)
		milestone.RegisterRoutes(v1, db)
		budget.RegisterRoutes(v1, db)
		expense.RegisterRoutes(v1, db)
		receivable.RegisterRoutes(v1, db)
		approval.RegisterRoutes(v1, db)
		dashboard.RegisterRoutes(v1, db)
		report.RegisterRoutes(v1, db)
		notify.RegisterRoutes(v1, db)
		contact.RegisterRoutes(v1, db)
		partner.RegisterRoutes(v1, db)
		opportunity.RegisterRoutes(v1, db)
		equipment.RegisterRoutes(v1, db)
		finance.RegisterRoutes(v1, db)
	}

	return r, db
}

func TestDatabaseIntegrationWorkflow(t *testing.T) {
	app, db := setupTestApp(t)

	// 1. 未认证访问 -> 401
	w := httptest.NewRecorder()
	req, _ := http.NewRequest("GET", "/api/v1/auth/me", nil)
	app.ServeHTTP(w, req)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 for unauthenticated request, got %d", w.Code)
	}

	// 2. 初始化一个测试超级管理员
	pwdHash, _ := security.HashPassword("admin123456")
	testUser := model.User{
		Username:        "15796280599",
		PwdHash:         pwdHash,
		RealName:        "测试超管",
		Status:          "active",
		IsSuperAdmin:    true,
		ModulesAssigned: true,
	}
	db.Where("username = ?", testUser.Username).FirstOrCreate(&testUser)

	// 3. 登录请求
	loginBody, _ := json.Marshal(map[string]string{
		"username": "15796280599",
		"password": "admin123456",
	})
	w = httptest.NewRecorder()
	req, _ = http.NewRequest("POST", "/api/v1/auth/login", bytes.NewReader(loginBody))
	req.Header.Set("Content-Type", "application/json")
	app.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 for login, got %d: %s", w.Code, w.Body.String())
	}

	var loginResp struct {
		AccessToken string `json:"access_token"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &loginResp)
	if loginResp.AccessToken == "" {
		t.Fatalf("login did not return access token")
	}

	tokenHeader := "Bearer " + loginResp.AccessToken

	// 4. 用 token 访问 /auth/me
	w = httptest.NewRecorder()
	req, _ = http.NewRequest("GET", "/api/v1/auth/me", nil)
	req.Header.Set("Authorization", tokenHeader)
	app.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 for /auth/me, got %d: %s", w.Code, w.Body.String())
	}

	// 5. 访问项目列表 /projects (验证统一分页信封)
	w = httptest.NewRecorder()
	req, _ = http.NewRequest("GET", "/api/v1/projects?page=1&size=10", nil)
	req.Header.Set("Authorization", tokenHeader)
	app.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 for /projects, got %d: %s", w.Code, w.Body.String())
	}

	var pagedResp struct {
		Total int64            `json:"total"`
		Page  int              `json:"page"`
		Size  int              `json:"size"`
		Items []map[string]any `json:"items"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &pagedResp); err != nil {
		t.Fatalf("failed to decode paging envelope: %v", err)
	}
	if pagedResp.Page != 1 || pagedResp.Size != 10 {
		t.Fatalf("paging envelope mismatch: page=%d, size=%d", pagedResp.Page, pagedResp.Size)
	}

	// 6. 验证审计日志留痕
	var auditCount int64
	db.Model(&model.AuditLog{}).Where("action = ? AND resource = ?", "login", "auth").Count(&auditCount)
	if auditCount == 0 {
		t.Fatalf("expected login audit log to be committed in database")
	}

	// 7. 测试项目创建与字段映射 (client, contract_status, owner_name)
	createProjBody, _ := json.Marshal(map[string]any{
		"name":            "集成测试项目-001",
		"type":            "internal",
		"priority":        "高",
		"client":          "测试大客户",
		"client_contact":  "张三",
		"client_phone":    "13800138000",
		"contract_status": "已签订",
		"owner_name":      "测试超管",
		"budget_total":    100000,
	})
	w = httptest.NewRecorder()
	req, _ = http.NewRequest("POST", "/api/v1/projects", bytes.NewReader(createProjBody))
	req.Header.Set("Authorization", tokenHeader)
	req.Header.Set("Content-Type", "application/json")
	app.ServeHTTP(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("expected 201 for project creation, got %d: %s", w.Code, w.Body.String())
	}
	var createdProj struct {
		ID             uint   `json:"id"`
		Client         string `json:"client"`
		ContractStatus string `json:"contract_status"`
		OwnerName      string `json:"owner_name"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &createdProj)
	if createdProj.ID == 0 || createdProj.Client != "测试大客户" || createdProj.ContractStatus != "已签订" {
		t.Fatalf("project creation field mismatch: %+v", createdProj)
	}

	// 8. 测试项目修改 (Patch: client, client_contact, contract_status)
	patchBody, _ := json.Marshal(map[string]any{
		"client":          "更新后的客户名",
		"client_contact":  "李四",
		"contract_status": "未签订",
	})
	w = httptest.NewRecorder()
	req, _ = http.NewRequest("PATCH", fmt.Sprintf("/api/v1/projects/%d", createdProj.ID), bytes.NewReader(patchBody))
	req.Header.Set("Authorization", tokenHeader)
	req.Header.Set("Content-Type", "application/json")
	app.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 for project patch, got %d: %s", w.Code, w.Body.String())
	}

	// 9. 测试附件 ETag 映射
	testAttach := model.Attachment{
		ProjectID:      &createdProj.ID,
		Filename:       "test.pdf",
		Path:           "/tmp/test.pdf",
		Size:           1024,
		ContentType:    "application/pdf",
		StorageBackend: "local",
		ObjectKey:      "project/2026/test.pdf",
		ETag:           "etag-123456",
	}
	if err := db.Create(&testAttach).Error; err != nil {
		t.Fatalf("failed to create attachment with ETag mapping: %v", err)
	}
	var loadedAttach model.Attachment
	if err := db.First(&loadedAttach, testAttach.ID).Error; err != nil || loadedAttach.ETag != "etag-123456" {
		t.Fatalf("loaded attachment ETag mismatch: %+v, err: %v", loadedAttach, err)
	}

	// 10. 测试项目软删除与回收站恢复 (无 deleted_by 列错误)
	w = httptest.NewRecorder()
	req, _ = http.NewRequest("DELETE", fmt.Sprintf("/api/v1/projects/%d", createdProj.ID), nil)
	req.Header.Set("Authorization", tokenHeader)
	app.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 for project soft-delete, got %d: %s", w.Code, w.Body.String())
	}

	w = httptest.NewRecorder()
	req, _ = http.NewRequest("POST", fmt.Sprintf("/api/v1/projects/%d/restore", createdProj.ID), nil)
	req.Header.Set("Authorization", tokenHeader)
	app.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 for project restore, got %d: %s", w.Code, w.Body.String())
	}

	// 11. 测试按负责人姓名过滤与 /projects/owners 列表
	w = httptest.NewRecorder()
	req, _ = http.NewRequest("GET", "/api/v1/projects?owner=测试超管", nil)
	req.Header.Set("Authorization", tokenHeader)
	app.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 for project owner filter, got %d: %s", w.Code, w.Body.String())
	}

	w = httptest.NewRecorder()
	req, _ = http.NewRequest("GET", "/api/v1/projects/owners", nil)
	req.Header.Set("Authorization", tokenHeader)
	app.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 for /projects/owners, got %d: %s", w.Code, w.Body.String())
	}
	var ownerList []struct {
		Name  string `json:"name"`
		Count int64  `json:"count"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &ownerList); err != nil {
		t.Fatalf("failed to parse /projects/owners response: %v", err)
	}

	// 12. 验证部门模型无 created_at 列，可直接插入
	dept := model.Department{Name: "综合运营部"}
	if err := db.Where("name = ?", dept.Name).FirstOrCreate(&dept).Error; err != nil {
		t.Fatalf("failed to insert department without created_at: %v", err)
	}

	// 13. 测试按项目编号子串筛选 (前端年份选择器)
	w = httptest.NewRecorder()
	req, _ = http.NewRequest("GET", "/api/v1/projects?code=001", nil)
	req.Header.Set("Authorization", tokenHeader)
	app.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 for project code filter, got %d: %s", w.Code, w.Body.String())
	}

	// 14. 验证错误密码登录只原子递增 failed_count，不破坏 session_version
	var preUser model.User
	db.Where("username = ?", testUser.Username).First(&preUser)
	preVersion := preUser.SessionVersion

	wrongLoginBody, _ := json.Marshal(map[string]string{
		"username": testUser.Username,
		"password": "wrongpassword999",
	})
	w = httptest.NewRecorder()
	req, _ = http.NewRequest("POST", "/api/v1/auth/login", bytes.NewReader(wrongLoginBody))
	req.Header.Set("Content-Type", "application/json")
	app.ServeHTTP(w, req)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 for wrong password, got %d", w.Code)
	}

	var postUser model.User
	db.Where("username = ?", testUser.Username).First(&postUser)
	if postUser.SessionVersion != preVersion {
		t.Fatalf("session_version changed after failed login: %d -> %d", preVersion, postUser.SessionVersion)
	}
	if postUser.LoginFailCount != preUser.LoginFailCount+1 {
		t.Fatalf("failed_count not incremented: %d -> %d", preUser.LoginFailCount, postUser.LoginFailCount)
	}
	var failAuditCount int64
	db.Model(&model.AuditLog{}).Where("action = ? AND resource = ?", "login_fail", "auth").Count(&failAuditCount)
	if failAuditCount == 0 {
		t.Fatalf("expected login_fail audit log in database")
	}

	// 15. 验证 /projects/:pid/changes 返回数组契约
	w = httptest.NewRecorder()
	req, _ = http.NewRequest("GET", fmt.Sprintf("/api/v1/projects/%d/changes", createdProj.ID), nil)
	req.Header.Set("Authorization", tokenHeader)
	app.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 for project changes, got %d: %s", w.Code, w.Body.String())
	}
	var changeList []map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &changeList); err != nil {
		t.Fatalf("project changes must be an array: %v", err)
	}

	// 16. 验证通知轮询触发懒同步
	w = httptest.NewRecorder()
	req, _ = http.NewRequest("GET", "/api/v1/notifications?page=1&size=20", nil)
	req.Header.Set("Authorization", tokenHeader)
	app.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 for notifications list, got %d: %s", w.Code, w.Body.String())
	}

	// 17. 验证安全退出登录与审计留痕
	w = httptest.NewRecorder()
	req, _ = http.NewRequest("POST", "/api/v1/auth/logout", nil)
	req.Header.Set("Authorization", tokenHeader)
	app.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 for logout, got %d: %s", w.Code, w.Body.String())
	}
	var logoutAudit int64
	db.Model(&model.AuditLog{}).Where("action = ? AND resource = ?", "logout", "auth").Count(&logoutAudit)
	if logoutAudit == 0 {
		t.Fatalf("expected logout audit log in database")
	}
}




