package approval

import "testing"

func TestKnownApprovalKind(t *testing.T) {
	for _, kind := range []string{"project_filing", "budget_adjust", "expense"} {
		if !knownApprovalKind(kind) {
			t.Errorf("%q should be a supported approval kind", kind)
		}
	}
	if knownApprovalKind("unknown") {
		t.Fatal("unknown approval kind must be rejected")
	}
}
