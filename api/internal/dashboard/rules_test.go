package dashboard

import "testing"

func TestHealthyClassification(t *testing.T) {
	tests := []struct {
		status string
		rate   float64
		late   int
		stale  int
		mile   int
		near   int
		want   string
	}{
		{"cancelled", 0, 0, 0, 0, 0, "closed"},
		{"doing", 1.1, 0, 0, 0, 0, "bad"},
		{"doing", 0.3, 1, 0, 0, 0, "risk"},
		{"doing", 0.3, 0, 14, 0, 0, "bad"},
		{"doing", 0.3, 0, 0, 1, 0, "bad"},
		{"doing", 0.3, 0, 0, 0, 1, "risk"},
		{"doing", 0.2, 0, 0, 0, 0, "ok"},
		{"done", 0.3, 0, 30, 0, 0, "ok"},
	}
	for _, tt := range tests {
		if got := healthy(tt.status, tt.rate, tt.late, tt.stale, tt.mile, tt.near); got != tt.want {
			t.Errorf("healthy(%q, %v, %d, %d, %d, %d) = %q, want %q", tt.status, tt.rate, tt.late, tt.stale, tt.mile, tt.near, got, tt.want)
		}
	}
}
