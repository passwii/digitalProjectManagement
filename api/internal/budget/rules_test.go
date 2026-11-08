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

func TestCalculateSubjectMetricsUsesAggregatedBudget(t *testing.T) {
	key := budgetKey{projectID: 7, subject: "采购"}
	budgets := map[budgetKey]float64{key: 200}
	spent := map[budgetKey]float64{key: 150}

	got := calculateSubjectMetrics([]budgetKey{key, key}, budgets, spent, 0.8)
	metrics := got[key]

	if metrics.balance != 50 || metrics.rate != 0.75 || metrics.warn || metrics.over {
		t.Fatalf("metrics = %+v, want balance=50 rate=0.75 warn=false over=false", metrics)
	}
}
