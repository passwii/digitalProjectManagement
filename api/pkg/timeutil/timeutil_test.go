package timeutil

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestTimeutil(t *testing.T) {
	now := NowDateTime()
	b, err := json.Marshal(now)
	if err != nil {
		t.Fatalf("marshal failed: %v", err)
	}
	s := string(b)
	if !strings.Contains(s, "+08:00") {
		t.Fatalf("expected +08:00 in formatted datetime, got %s", s)
	}

	var d DateTime
	if err := json.Unmarshal([]byte(`"2026-11-08T12:00:00+08:00"`), &d); err != nil {
		t.Fatalf("unmarshal failed: %v", err)
	}
	if d.Hour() != 12 {
		t.Fatalf("expected hour 12, got %d", d.Hour())
	}

	date := NewDate(time.Date(2026, 11, 8, 0, 0, 0, 0, Loc))
	db, err := json.Marshal(date)
	if err != nil {
		t.Fatalf("marshal date failed: %v", err)
	}
	if string(db) != `"2026-11-08"` {
		t.Fatalf("expected 2026-11-08, got %s", string(db))
	}
}
