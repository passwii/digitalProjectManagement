package test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"

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
	"digitalprojectmanagement/api/internal/rbac"
	"digitalprojectmanagement/api/internal/receivable"
	"digitalprojectmanagement/api/internal/report"
	"digitalprojectmanagement/api/internal/task"
	"digitalprojectmanagement/api/pkg/database"
	"digitalprojectmanagement/api/pkg/security"
	"digitalprojectmanagement/api/pkg/storage"
	"digitalprojectmanagement/api/pkg/timeutil"
	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

func withSearchPath(databaseURL, schema string) string {
	cleanURL := strings.Replace(databaseURL, "postgresql+psycopg://", "postgresql://", 1)
	parsed, err := url.Parse(cleanURL)
	if err != nil {
		return databaseURL
	}
	query := parsed.Query()
	query.Set("search_path", schema)
	parsed.RawQuery = query.Encode()
	return parsed.String()
}

func applyAlembicMigrations(t *testing.T, databaseURL, schema string) {
	t.Helper()
	workingDir, err := os.Getwd()
	if err != nil {
		t.Fatalf("failed to resolve test working directory: %v", err)
	}
	apiDir := filepath.Dir(workingDir)
	repoRoot := filepath.Dir(apiDir)
	cmd := exec.Command("python3", "-m", "alembic", "upgrade", "head")
	cmd.Dir = apiDir
	cmd.Env = append(os.Environ(),
		"DATABASE_URL="+databaseURL,
		"PGOPTIONS=-c search_path="+schema,
		"PYTHONPATH="+repoRoot,
	)
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("alembic upgrade head failed: %v\n%s", err, output)
	}
}

func setupTestApp(t *testing.T) (*gin.Engine, *gorm.DB) {
	t.Helper()
	testDBURL := strings.TrimSpace(os.Getenv("TEST_DATABASE_URL"))
	if testDBURL == "" {
		t.Skip("TEST_DATABASE_URL not set; skipping database integration tests")
	}

	adminDB, err := database.Init(testDBURL, "test")
	if err != nil {
		t.Fatalf("cannot connect to test database: %v", err)
	}

	schema := fmt.Sprintf("test_%s", strings.ReplaceAll(uuid.NewString()[:12], "-", ""))
	if err := adminDB.Exec(fmt.Sprintf("CREATE SCHEMA %q", schema)).Error; err != nil {
		t.Fatalf("failed to create test schema: %v", err)
	}
	t.Cleanup(func() {
		_ = adminDB.Exec(fmt.Sprintf("DROP SCHEMA %q CASCADE", schema))
		if sqlDB, err := adminDB.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})

	applyAlembicMigrations(t, testDBURL, schema)
	schemaDBURL := withSearchPath(testDBURL, schema)

	security.Init("test-integration-secret-key-12345")
	db, err := database.Init(schemaDBURL, "test")
	if err != nil {
		t.Fatalf("cannot connect to schema database: %v", err)
	}
	t.Cleanup(func() {
		if sqlDB, err := db.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})

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

func seedUserAndLogin(t *testing.T, app *gin.Engine, db *gorm.DB, realName string, modules []string, isSuperAdmin bool) (model.User, string) {
	t.Helper()
	pwdHash, err := security.HashPassword("admin123456")
	if err != nil {
		t.Fatalf("hash test password: %v", err)
	}
	user := model.User{
		Username:        fmt.Sprintf("test_user_%s", strings.ReplaceAll(uuid.NewString()[:8], "-", "")),
		PwdHash:         pwdHash,
		RealName:        realName,
		Status:          "active",
		IsSuperAdmin:    isSuperAdmin,
		ModulesAssigned: true,
		CreatedAt:       timeutil.NowDateTime(),
	}
	if err := db.Create(&user).Error; err != nil {
		t.Fatalf("create test admin: %v", err)
	}

	loginBody, _ := json.Marshal(map[string]string{
		"username": user.Username,
		"password": "admin123456",
	})
	recorder := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", bytes.NewReader(loginBody))
	req.Header.Set("Content-Type", "application/json")
	app.ServeHTTP(recorder, req)
	if recorder.Code != http.StatusOK {
		t.Fatalf("login status = %d: %s", recorder.Code, recorder.Body.String())
	}
	var response struct {
		AccessToken string `json:"access_token"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode login response: %v", err)
	}
	if response.AccessToken == "" {
		t.Fatal("login response did not include an access token")
	}
	for _, module := range modules {
		if err := db.Create(&model.UserModule{UserID: user.ID, Module: module}).Error; err != nil {
			t.Fatalf("create user module %q: %v", module, err)
		}
	}
	return user, "Bearer " + response.AccessToken
}

func seedAdminAndLogin(t *testing.T, app *gin.Engine, db *gorm.DB) (model.User, string) {
	t.Helper()
	return seedUserAndLogin(t, app, db, "测试超管", nil, true)
}

func requestJSON(t *testing.T, app *gin.Engine, method, path string, body any, token string) *httptest.ResponseRecorder {
	t.Helper()
	return requestJSONWithHeaders(t, app, method, path, body, token, nil)
}

func requestJSONWithHeaders(t *testing.T, app *gin.Engine, method, path string, body any, token string, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	var reader *bytes.Reader
	if body == nil {
		reader = bytes.NewReader(nil)
	} else {
		payload, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal request body: %v", err)
		}
		reader = bytes.NewReader(payload)
	}
	recorder := httptest.NewRecorder()
	req := httptest.NewRequest(method, path, reader)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", token)
	}
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	app.ServeHTTP(recorder, req)
	return recorder
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

	// 2. 初始化并登录测试超级管理员
	testUser, tokenHeader := seedAdminAndLogin(t, app, db)

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
	projectName := fmt.Sprintf("集成测试项目-%s", strings.ReplaceAll(uuid.NewString()[:8], "-", ""))
	projectCode := fmt.Sprintf("PRJ-%s", strings.ReplaceAll(uuid.NewString()[:8], "-", ""))
	createProjBody, _ := json.Marshal(map[string]any{
		"code":            projectCode,
		"name":            projectName,
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
		Code           string `json:"code"`
		Client         string `json:"client"`
		ContractStatus string `json:"contract_status"`
		OwnerName      string `json:"owner_name"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &createdProj)
	if createdProj.ID == 0 || createdProj.Client != "测试大客户" || createdProj.ContractStatus != "已签订" {
		t.Fatalf("project creation field mismatch: %+v", createdProj)
	}

	// 8. 测试项目修改 (Patch: client, client_contact, contract_status, owner_id)
	user2 := model.User{
		Username:  fmt.Sprintf("test_user_%s", strings.ReplaceAll(uuid.NewString()[:8], "-", "")),
		PwdHash:   testUser.PwdHash,
		RealName:  "项目经理二号",
		Status:    "active",
		CreatedAt: timeutil.NowDateTime(),
	}
	if err := db.Create(&user2).Error; err != nil {
		t.Fatalf("create second user: %v", err)
	}

	patchBody, _ := json.Marshal(map[string]any{
		"client":          "更新后的客户名",
		"client_contact":  "李四",
		"contract_status": "未签订",
		"owner_id":        user2.ID,
		"member_ids":      []uint{user2.ID},
	})
	w = httptest.NewRecorder()
	req, _ = http.NewRequest("PATCH", fmt.Sprintf("/api/v1/projects/%d", createdProj.ID), bytes.NewReader(patchBody))
	req.Header.Set("Authorization", tokenHeader)
	req.Header.Set("Content-Type", "application/json")
	app.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 for project patch, got %d: %s", w.Code, w.Body.String())
	}
	var patchedProj struct {
		ID      uint  `json:"id"`
		OwnerID *uint `json:"owner_id"`
		Owner   struct {
			ID uint `json:"id"`
		} `json:"owner"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &patchedProj)
	if patchedProj.OwnerID == nil || *patchedProj.OwnerID != user2.ID || patchedProj.Owner.ID != user2.ID {
		t.Fatalf("project patch owner_id association mismatch: %+v, expected %d", patchedProj, user2.ID)
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
	req, _ = http.NewRequest("GET", fmt.Sprintf("/api/v1/projects?code=%s", projectCode[4:]), nil)
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

func TestAdminUpdateUserChangesDepartmentAssociation(t *testing.T) {
	app, db := setupTestApp(t)
	admin, adminToken := seedAdminAndLogin(t, app, db)
	now := timeutil.NowDateTime()
	deptA := model.Department{Name: fmt.Sprintf("测试部门A-%s", uuid.NewString()[:8])}
	deptB := model.Department{Name: fmt.Sprintf("测试部门B-%s", uuid.NewString()[:8])}
	if err := db.Create(&deptA).Error; err != nil {
		t.Fatalf("create department A: %v", err)
	}
	if err := db.Create(&deptB).Error; err != nil {
		t.Fatalf("create department B: %v", err)
	}
	pwdHash, err := security.HashPassword("user123456")
	if err != nil {
		t.Fatalf("hash target user password: %v", err)
	}
	target := model.User{
		Username:  fmt.Sprintf("target_%s", strings.ReplaceAll(uuid.NewString()[:8], "-", "")),
		PwdHash:   pwdHash,
		RealName:  "部门变更用户",
		DeptID:    &deptA.ID,
		Status:    "active",
		CreatedAt: now,
	}
	if err := db.Create(&target).Error; err != nil {
		t.Fatalf("create target user: %v", err)
	}
	contact := model.ContactProfile{
		UserID:    &target.ID,
		Name:      target.RealName,
		Mobile:    target.Username,
		DeptID:    &deptA.ID,
		CreatedAt: now,
		UpdatedAt: now,
	}
	if err := db.Create(&contact).Error; err != nil {
		t.Fatalf("create target contact: %v", err)
	}

	recorder := requestJSON(t, app, http.MethodPatch, fmt.Sprintf("/api/v1/admin/users/%d", target.ID), map[string]any{
		"dept_id": deptB.ID,
	}, adminToken)
	if recorder.Code != http.StatusOK {
		t.Fatalf("update user status = %d: %s", recorder.Code, recorder.Body.String())
	}
	var detail struct {
		Modules []string `json:"modules"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &detail); err != nil {
		t.Fatalf("decode updated user: %v", err)
	}
	if strings.Join(detail.Modules, ",") != strings.Join(rbac.DefaultModules, ",") {
		t.Fatalf("effective modules = %v, want defaults %v", detail.Modules, rbac.DefaultModules)
	}

	var updatedUser model.User
	if err := db.Preload("Department").First(&updatedUser, target.ID).Error; err != nil {
		t.Fatalf("reload user: %v", err)
	}
	if updatedUser.DeptID == nil || *updatedUser.DeptID != deptB.ID || updatedUser.Department == nil || updatedUser.Department.ID != deptB.ID {
		t.Fatalf("user department = %+v, want department %d", updatedUser.Department, deptB.ID)
	}
	var updatedContact model.ContactProfile
	if err := db.First(&updatedContact, contact.ID).Error; err != nil {
		t.Fatalf("reload contact: %v", err)
	}
	if updatedContact.DeptID == nil || *updatedContact.DeptID != deptB.ID {
		t.Fatalf("contact department = %v, want %d", updatedContact.DeptID, deptB.ID)
	}

	recorder = requestJSON(t, app, http.MethodPatch, fmt.Sprintf("/api/v1/admin/users/%d", target.ID), map[string]any{
		"real_name": "仅修改姓名",
	}, adminToken)
	if recorder.Code != http.StatusOK {
		t.Fatalf("rename user status = %d: %s", recorder.Code, recorder.Body.String())
	}
	if err := db.First(&updatedUser, target.ID).Error; err != nil {
		t.Fatalf("reload user after omitted department: %v", err)
	}
	if updatedUser.DeptID == nil || *updatedUser.DeptID != deptB.ID {
		t.Fatalf("omitted department changed user department to %v, want %d", updatedUser.DeptID, deptB.ID)
	}

	recorder = requestJSON(t, app, http.MethodPatch, fmt.Sprintf("/api/v1/admin/users/%d", target.ID), map[string]any{
		"dept_id": nil,
	}, adminToken)
	if recorder.Code != http.StatusOK {
		t.Fatalf("clear user department status = %d: %s", recorder.Code, recorder.Body.String())
	}
	if err := db.First(&updatedUser, target.ID).Error; err != nil {
		t.Fatalf("reload user after clearing department: %v", err)
	}
	if updatedUser.DeptID != nil {
		t.Fatalf("user department = %v, want nil", updatedUser.DeptID)
	}
	if err := db.First(&updatedContact, contact.ID).Error; err != nil {
		t.Fatalf("reload contact after clearing department: %v", err)
	}
	if updatedContact.DeptID != nil {
		t.Fatalf("contact department = %v, want nil", updatedContact.DeptID)
	}

	recorder = requestJSON(t, app, http.MethodGet, "/api/v1/admin/logs?action=update&page=1&size=20", nil, adminToken)
	if recorder.Code != http.StatusOK {
		t.Fatalf("list audit logs status = %d: %s", recorder.Code, recorder.Body.String())
	}
	var logs struct {
		Items []struct {
			OperatorName string `json:"operator_name"`
		} `json:"items"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &logs); err != nil {
		t.Fatalf("decode audit logs: %v", err)
	}
	if len(logs.Items) == 0 || logs.Items[0].OperatorName != admin.RealName {
		t.Fatalf("audit log operator_name = %+v, want %q", logs.Items, admin.RealName)
	}
}

func TestBudgetMetricsAggregateByProjectAndSubject(t *testing.T) {
	app, db := setupTestApp(t)
	admin, adminToken := seedAdminAndLogin(t, app, db)
	now := timeutil.NowDateTime()
	project := model.Project{
		Code:      fmt.Sprintf("PRJ-%s", strings.ReplaceAll(uuid.NewString()[:8], "-", "")),
		Name:      fmt.Sprintf("预算聚合项目-%s", uuid.NewString()[:8]),
		Type:      "other",
		Status:    "doing",
		Priority:  "中",
		OwnerID:   &admin.ID,
		CreatedAt: now,
		UpdatedAt: now,
	}
	if err := db.Create(&project).Error; err != nil {
		t.Fatalf("create project: %v", err)
	}
	for _, amount := range []float64{100, 100} {
		row := model.Budget{
			ProjectID: project.ID,
			Subject:   "采购",
			Amount:    amount,
			CreatedAt: now,
			UpdatedAt: now,
		}
		if err := db.Create(&row).Error; err != nil {
			t.Fatalf("create budget row: %v", err)
		}
	}
	if err := db.Create(&model.Expense{
		ProjectID: project.ID,
		Subject:   "采购",
		Amount:    150,
		Status:    "approved",
		ByID:      &admin.ID,
		CreatedAt: now,
	}).Error; err != nil {
		t.Fatalf("create expense: %v", err)
	}

	recorder := requestJSON(t, app, http.MethodGet, fmt.Sprintf("/api/v1/budgets?project_id=%d&page=1&size=20", project.ID), nil, adminToken)
	if recorder.Code != http.StatusOK {
		t.Fatalf("list budgets status = %d: %s", recorder.Code, recorder.Body.String())
	}
	var response struct {
		Items []struct {
			Amount  float64 `json:"amount"`
			Spent   float64 `json:"spent"`
			Balance float64 `json:"balance"`
			Rate    float64 `json:"rate"`
			Warn    bool    `json:"warn"`
			Over    bool    `json:"over"`
		} `json:"items"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode budget response: %v", err)
	}
	if len(response.Items) != 2 {
		t.Fatalf("budget item count = %d, want 2", len(response.Items))
	}
	for _, item := range response.Items {
		if item.Amount != 100 || item.Spent != 150 || item.Balance != 50 || item.Rate != 0.75 || item.Warn || item.Over {
			t.Fatalf("budget metrics = %+v, want amount=100 spent=150 balance=50 rate=0.75 warn=false over=false", item)
		}
	}
}

func TestFinanceProjectExpensesPreserveContractAndFilters(t *testing.T) {
	app, db := setupTestApp(t)
	admin, adminToken := seedAdminAndLogin(t, app, db)
	now := timeutil.NowDateTime()
	book := model.AccountBook{
		Code:            fmt.Sprintf("BOOK-%s", strings.ReplaceAll(uuid.NewString()[:8], "-", "")),
		Name:            "项目支出回归账套",
		BaseCurrency:    "CNY",
		Currencies:      `["CNY"]`,
		FiscalYearStart: "01-01",
		Status:          "active",
		CreatedBy:       &admin.ID,
		CreatedAt:       now,
	}
	if err := db.Create(&book).Error; err != nil {
		t.Fatalf("create account book: %v", err)
	}
	periodStart := timeutil.NewDate(time.Date(2026, 2, 1, 0, 0, 0, 0, timeutil.Loc))
	periodEnd := timeutil.NewDate(time.Date(2026, 2, 28, 0, 0, 0, 0, timeutil.Loc))
	period := model.AccountingPeriod{
		AccountBookID: book.ID,
		Year:          2026,
		Month:         2,
		PeriodIndex:   2,
		Status:        "open",
		StartDate:     periodStart,
		EndDate:       periodEnd,
		Version:       1,
	}
	if err := db.Create(&period).Error; err != nil {
		t.Fatalf("create accounting period: %v", err)
	}
	project := model.Project{
		Code:      fmt.Sprintf("PRJ-%s", strings.ReplaceAll(uuid.NewString()[:8], "-", "")),
		Name:      fmt.Sprintf("财务项目-%s", uuid.NewString()[:8]),
		Type:      "other",
		Status:    "doing",
		Priority:  "中",
		OwnerID:   &admin.ID,
		CreatedAt: now,
		UpdatedAt: now,
	}
	if err := db.Create(&project).Error; err != nil {
		t.Fatalf("create project: %v", err)
	}
	dateApproved := timeutil.NewDate(time.Date(2026, 2, 10, 0, 0, 0, 0, timeutil.Loc))
	dateException := timeutil.NewDate(time.Date(2026, 2, 20, 0, 0, 0, 0, timeutil.Loc))
	approved := model.Expense{
		ProjectID: project.ID,
		Subject:   "采购",
		Amount:    10,
		ExpDate:   &dateApproved,
		Status:    "approved",
		ByID:      &admin.ID,
		CreatedAt: now,
	}
	exception := model.Expense{
		ProjectID: project.ID,
		Subject:   "差旅",
		Amount:    20,
		ExpDate:   &dateException,
		Status:    "exception",
		ByID:      &admin.ID,
		CreatedAt: now,
	}
	if err := db.Create(&approved).Error; err != nil {
		t.Fatalf("create approved expense: %v", err)
	}
	if err := db.Create(&exception).Error; err != nil {
		t.Fatalf("create exception expense: %v", err)
	}
	voucherDate := timeutil.NewDate(time.Date(2026, 2, 10, 0, 0, 0, 0, timeutil.Loc))
	linkedVoucher := model.Voucher{
		AccountBookID:   book.ID,
		PeriodID:        period.ID,
		VoucherNo:       "记-0001",
		VoucherDate:     voucherDate,
		Status:          "draft",
		Source:          "project-expense",
		SourceExpenseID: &approved.ID,
		Summary:         "已转换项目支出",
		TotalDebit:      decimal.NewFromInt(10),
		TotalCredit:     decimal.NewFromInt(10),
		CreatedBy:       &admin.ID,
		CreatedAt:       now,
		UpdatedAt:       now,
	}
	if err := db.Create(&linkedVoucher).Error; err != nil {
		t.Fatalf("create linked voucher: %v", err)
	}

	bookHeaders := map[string]string{"X-Account-Book": book.Code}
	recorder := requestJSONWithHeaders(t, app, http.MethodGet,
		fmt.Sprintf("/api/v1/finance/project-expenses?project_id=%d&status=exception&date_from=2026-02-01&date_to=2026-02-28&page=1&size=1", project.ID),
		nil, adminToken, bookHeaders)
	if recorder.Code != http.StatusOK {
		t.Fatalf("filtered project expenses status = %d: %s", recorder.Code, recorder.Body.String())
	}
	var filtered struct {
		Total int64 `json:"total"`
		Page  int   `json:"page"`
		Size  int   `json:"size"`
		Items []struct {
			ID      uint   `json:"id"`
			Status  string `json:"status"`
			Project struct {
				ID   uint   `json:"id"`
				Code string `json:"code"`
				Name string `json:"name"`
			} `json:"project"`
			SourceVoucherSummary any `json:"source_voucher_summary"`
		} `json:"items"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &filtered); err != nil {
		t.Fatalf("decode filtered project expenses: %v", err)
	}
	if filtered.Total != 1 || filtered.Page != 1 || filtered.Size != 1 || len(filtered.Items) != 1 {
		t.Fatalf("filtered envelope = %+v, want one exception expense", filtered)
	}
	if filtered.Items[0].ID != exception.ID || filtered.Items[0].Status != "exception" || filtered.Items[0].Project.ID != project.ID || filtered.Items[0].Project.Name == "" {
		t.Fatalf("filtered item = %+v, want exception with nested project", filtered.Items[0])
	}
	if filtered.Items[0].SourceVoucherSummary != nil {
		t.Fatalf("unexpected source voucher summary for exception expense: %+v", filtered.Items[0].SourceVoucherSummary)
	}

	recorder = requestJSONWithHeaders(t, app, http.MethodGet,
		fmt.Sprintf("/api/v1/finance/project-expenses?project_id=%d&status=approved&page=1&size=20", project.ID),
		nil, adminToken, bookHeaders)
	if recorder.Code != http.StatusOK {
		t.Fatalf("linked project expenses status = %d: %s", recorder.Code, recorder.Body.String())
	}
	var linkedResponse struct {
		Total int64 `json:"total"`
		Items []struct {
			SourceVoucherSummary *struct {
				ID        uint   `json:"id"`
				VoucherNo string `json:"voucher_no"`
			} `json:"source_voucher_summary"`
		} `json:"items"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &linkedResponse); err != nil {
		t.Fatalf("decode linked project expenses: %v", err)
	}
	if linkedResponse.Total != 1 || len(linkedResponse.Items) != 1 || linkedResponse.Items[0].SourceVoucherSummary == nil || linkedResponse.Items[0].SourceVoucherSummary.ID != linkedVoucher.ID {
		t.Fatalf("linked voucher summary = %+v, want voucher %d", linkedResponse, linkedVoucher.ID)
	}

	recorder = requestJSONWithHeaders(t, app, http.MethodPost,
		fmt.Sprintf("/api/v1/finance/project-expenses/%d/voucher", exception.ID),
		map[string]any{
			"period_id": period.ID, "voucher_date": "2026-02-20", "summary": "特批支出入账",
			"debit":  map[string]any{"account_id": 0, "aux_detail": map[string]any{}},
			"credit": map[string]any{"account_id": 0, "aux_detail": map[string]any{}},
		}, adminToken, bookHeaders)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("exception conversion status = %d, want 400 after status acceptance: %s", recorder.Code, recorder.Body.String())
	}

	recorder = requestJSONWithHeaders(t, app, http.MethodPost,
		fmt.Sprintf("/api/v1/finance/project-expenses/%d/voucher", approved.ID),
		map[string]any{
			"period_id": period.ID, "voucher_date": "2026-02-10", "summary": "重复入账",
			"debit":  map[string]any{"account_id": 1, "aux_detail": map[string]any{}},
			"credit": map[string]any{"account_id": 2, "aux_detail": map[string]any{}},
		}, adminToken, bookHeaders)
	if recorder.Code != http.StatusConflict {
		t.Fatalf("linked conversion status = %d, want 409: %s", recorder.Code, recorder.Body.String())
	}
	var conflictResponse struct {
		Detail struct {
			Code                 string `json:"code"`
			SourceVoucherSummary struct {
				ID uint `json:"id"`
			} `json:"source_voucher_summary"`
		} `json:"detail"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &conflictResponse); err != nil {
		t.Fatalf("decode linked conversion conflict: %v", err)
	}
	if conflictResponse.Detail.Code != "F-PROJECT-EXPENSE-LINKED" || conflictResponse.Detail.SourceVoucherSummary.ID != linkedVoucher.ID {
		t.Fatalf("linked conversion conflict = %+v", conflictResponse)
	}
}

func TestProjectAndApprovalPermissionsWithoutBaseModules(t *testing.T) {
	app, db := setupTestApp(t)
	admin, _ := seedAdminAndLogin(t, app, db)
	now := timeutil.NowDateTime()
	project := model.Project{
		Code:      fmt.Sprintf("PRJ-%s", strings.ReplaceAll(uuid.NewString()[:8], "-", "")),
		Name:      fmt.Sprintf("权限回归项目-%s", uuid.NewString()[:8]),
		Type:      "other",
		Status:    "doing",
		Priority:  "中",
		OwnerID:   &admin.ID,
		CreatedAt: now,
		UpdatedAt: now,
	}
	if err := db.Create(&project).Error; err != nil {
		t.Fatalf("create project: %v", err)
	}

	member, memberToken := seedUserAndLogin(t, app, db, "通讯录模块项目成员", []string{"contacts"}, false)
	if err := db.Create(&model.ProjectMember{ProjectID: project.ID, UserID: member.ID}).Error; err != nil {
		t.Fatalf("create project member: %v", err)
	}
	recorder := requestJSON(t, app, http.MethodGet, fmt.Sprintf("/api/v1/projects/%d", project.ID), nil, memberToken)
	if recorder.Code != http.StatusOK {
		t.Fatalf("project member detail status = %d: %s", recorder.Code, recorder.Body.String())
	}

	_, outsiderToken := seedUserAndLogin(t, app, db, "通讯录模块非成员", []string{"contacts"}, false)
	recorder = requestJSON(t, app, http.MethodGet, fmt.Sprintf("/api/v1/projects/%d", project.ID), nil, outsiderToken)
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("non-member project detail status = %d, want 404: %s", recorder.Code, recorder.Body.String())
	}

	budget := model.Budget{ProjectID: project.ID, Subject: "采购", Amount: 100, CreatedAt: now, UpdatedAt: now}
	if err := db.Create(&budget).Error; err != nil {
		t.Fatalf("create budget: %v", err)
	}
	adjustment := model.BudgetAdjust{
		BudgetID:  budget.ID,
		ProjectID: project.ID,
		OldAmount: 100,
		NewAmount: 120,
		Reason:    "权限回归",
		Status:    "pending",
		ByID:      &admin.ID,
		CreatedAt: now,
	}
	if err := db.Create(&adjustment).Error; err != nil {
		t.Fatalf("create budget adjustment: %v", err)
	}
	_, approvalToken := seedUserAndLogin(t, app, db, "仅审批模块用户", []string{"approvals"}, false)
	recorder = requestJSON(t, app, http.MethodPost, fmt.Sprintf("/api/v1/approvals/budget_adjust/%d/decide", adjustment.ID), map[string]any{
		"approve": true,
	}, approvalToken)
	if recorder.Code != http.StatusOK {
		t.Fatalf("approvals-only decision status = %d: %s", recorder.Code, recorder.Body.String())
	}
	var decided model.BudgetAdjust
	if err := db.First(&decided, adjustment.ID).Error; err != nil {
		t.Fatalf("reload budget adjustment: %v", err)
	}
	if decided.Status != "approved" {
		t.Fatalf("budget adjustment status = %q, want approved", decided.Status)
	}
}
