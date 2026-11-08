package project

import "testing"

func TestAllowedStatusTransition(t *testing.T) {
	tests := []struct {
		from, to string
		admin    bool
		want     bool
	}{
		{"draft", "pending", false, true},
		{"draft", "filed", false, true},
		{"pending", "cancelled", false, true},
		{"filed", "doing", false, true},
		{"doing", "paused", false, true},
		{"paused", "done", false, true},
		{"done", "archived", false, true},
		{"archived", "doing", false, false},
		{"archived", "doing", true, true},
		{"done", "doing", true, false},
	}
	for _, tt := range tests {
		if got := allowedStatusTransition(tt.from, tt.to, tt.admin); got != tt.want {
			t.Errorf("allowedStatusTransition(%q, %q, %t) = %t, want %t", tt.from, tt.to, tt.admin, got, tt.want)
		}
	}
}
