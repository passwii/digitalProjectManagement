package test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"testing"

	"digitalprojectmanagement/api/internal/model"
	"digitalprojectmanagement/api/pkg/timeutil"
	"github.com/google/uuid"
)

// projects_name_key 是全局唯一索引（不区分软删），应用层查重必须与之一致；
// 否则存在同名软删项目时，新建/改名会绕过应用层检查、撞上 23505，最终返回 500。
func TestProjectNameUniquenessIncludesSoftDeleted(t *testing.T) {
	app, db := setupTestApp(t)
	_, adminToken := seedAdminAndLogin(t, app, db)
	now := timeutil.NowDateTime()

	name := fmt.Sprintf("软删重名回归-%s", uuid.NewString()[:8])
	first := model.Project{
		Code:      fmt.Sprintf("PRJ-%s", uuid.NewString()[:8]),
		Name:      name,
		Type:      "internal",
		Status:    "draft",
		Priority:  "中",
		CreatedAt: now,
		UpdatedAt: now,
	}
	if err := db.Create(&first).Error; err != nil {
		t.Fatalf("create first project: %v", err)
	}

	recorder := requestJSON(t, app, http.MethodDelete, fmt.Sprintf("/api/v1/projects/%d", first.ID), nil, adminToken)
	if recorder.Code != http.StatusOK {
		t.Fatalf("soft delete project status = %d: %s", recorder.Code, recorder.Body.String())
	}
	var deleted model.Project
	if err := db.First(&deleted, first.ID).Error; err != nil {
		t.Fatalf("reload soft-deleted project: %v", err)
	}
	if deleted.DeletedAt == nil {
		t.Fatal("delete project did not set deleted_at")
	}

	// 1) 新建项目与软删项目同名：应返回 400，而不是撞唯一索引变 500。
	recorder = requestJSON(t, app, http.MethodPost, "/api/v1/projects", map[string]any{
		"code":     fmt.Sprintf("PRJ-%s", uuid.NewString()[:8]),
		"name":     name,
		"type":     "internal",
		"priority": "中",
	}, adminToken)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("create project with soft-deleted name status = %d, want 400: %s", recorder.Code, recorder.Body.String())
	}
	var createErr struct {
		Detail string `json:"detail"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &createErr); err != nil {
		t.Fatalf("decode create error: %v", err)
	}
	if createErr.Detail != "项目名称已存在" {
		t.Fatalf("create error detail = %q, want 项目名称已存在", createErr.Detail)
	}

	// 2) 活动项目改名为软删项目名：同样应返回 400，并保持原名称不变。
	second := model.Project{
		Code:      fmt.Sprintf("PRJ-%s", uuid.NewString()[:8]),
		Name:      fmt.Sprintf("活动项目-%s", uuid.NewString()[:8]),
		Type:      "internal",
		Status:    "draft",
		Priority:  "中",
		CreatedAt: now,
		UpdatedAt: now,
	}
	if err := db.Create(&second).Error; err != nil {
		t.Fatalf("create second project: %v", err)
	}
	recorder = requestJSON(t, app, http.MethodPatch, fmt.Sprintf("/api/v1/projects/%d", second.ID), map[string]any{
		"name": name,
	}, adminToken)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("rename project to soft-deleted name status = %d, want 400: %s", recorder.Code, recorder.Body.String())
	}
	var reloaded model.Project
	if err := db.First(&reloaded, second.ID).Error; err != nil {
		t.Fatalf("reload renamed project: %v", err)
	}
	if reloaded.Name != second.Name {
		t.Fatalf("project name changed to %q despite 400, want %q", reloaded.Name, second.Name)
	}
}
