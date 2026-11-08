package receivable

import (
	"testing"

	"github.com/shopspring/decimal"
)

func TestPaymentWithinReceivable(t *testing.T) {
	total := decimal.NewFromInt(90)
	if !paymentWithinReceivable(total, decimal.NewFromInt(10), decimal.NewFromInt(100)) {
		t.Fatal("payment that exactly reaches receivable should be accepted")
	}
	if paymentWithinReceivable(total, decimal.NewFromInt(11), decimal.NewFromInt(100)) {
		t.Fatal("payment that exceeds receivable should be rejected")
	}
}
