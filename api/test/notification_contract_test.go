package test

import (
	"encoding/json"
	"net/http"
	"testing"

	"digitalprojectmanagement/api/internal/model"
	"digitalprojectmanagement/api/pkg/timeutil"
)

// 归档基线返回 {ok, read}，前端类型同样声明 read；
// Go 侧不能只返回 {ok}，否则契约漂移且调用方拿不到标记条数。
func TestNotificationReadAllReturnsCount(t *testing.T) {
	app, db := setupTestApp(t)
	admin, adminToken := seedAdminAndLogin(t, app, db)
	now := timeutil.NowDateTime()
	for i := 0; i < 2; i++ {
		if err := db.Create(&model.Notification{
			UserID:    admin.ID,
			Type:      "audit",
			Title:     "read-all 回归通知",
			CreatedAt: now,
		}).Error; err != nil {
			t.Fatalf("seed notification %d: %v", i, err)
		}
	}

	recorder := requestJSON(t, app, http.MethodPost, "/api/v1/notifications/read-all", nil, adminToken)
	if recorder.Code != http.StatusOK {
		t.Fatalf("read-all status = %d: %s", recorder.Code, recorder.Body.String())
	}
	var body struct {
		OK   bool  `json:"ok"`
		Read int64 `json:"read"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode read-all response: %v", err)
	}
	if !body.OK || body.Read != 2 {
		t.Fatalf("read-all response = %+v, want ok=true read=2", body)
	}
}
