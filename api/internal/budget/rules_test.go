package budget

import "testing"

func TestAdjustmentDecision(t *testing.T) {
	if status, auto := adjustmentDecision(true); status != "pending" || auto {
		t.Fatalf("approval enabled = (%q, %t), want (pending, false)", status, auto)
	}
	if status, auto := adjustmentDecision(false); status != "approved" || !auto {
		t.Fatalf("approval disabled = (%q, %t), want (approved, true)", status, auto)
	}
}
