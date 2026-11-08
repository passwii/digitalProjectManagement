package expense

import "testing"

func TestInitialExpenseStatus(t *testing.T) {
	tests := []struct {
		approvalOn, overBudget bool
		want                   string
	}{
		{false, false, "approved"},
		{false, true, "pending"},
		{true, false, "pending"},
		{true, true, "pending"},
	}
	for _, tt := range tests {
		if got := initialExpenseStatus(tt.approvalOn, tt.overBudget); got != tt.want {
			t.Errorf("initialExpenseStatus(%t, %t) = %q, want %q", tt.approvalOn, tt.overBudget, got, tt.want)
		}
	}
}
