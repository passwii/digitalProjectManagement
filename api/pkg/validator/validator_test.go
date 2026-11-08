package validator

import (
	"math"
	"testing"
)

func TestValidator(t *testing.T) {
	_, err := AsNumber(math.NaN(), "test", true)
	if err == nil {
		t.Fatalf("expected error for NaN")
	}

	p, err := CheckProgress(50.5)
	if err != nil || p != 50.5 {
		t.Fatalf("check progress failed: %v", err)
	}
	_, err = CheckProgress(101)
	if err == nil {
		t.Fatalf("expected error for progress > 100")
	}

	w, err := CheckWeight("2.5")
	if err != nil || w != 2.5 {
		t.Fatalf("check weight failed: %v", err)
	}
	_, err = CheckWeight(0)
	if err == nil {
		t.Fatalf("expected error for weight 0")
	}
}
