package finance

import (
	"testing"

	"github.com/shopspring/decimal"
)

func TestValidateEntryAmountsAcceptsBalancedVoucher(t *testing.T) {
	lines := []entryInput{
		{Debit: decimal.RequireFromString("12.50")},
		{Credit: decimal.RequireFromString("12.50")},
	}

	debit, credit, err := validateEntryAmounts(lines)
	if err != nil {
		t.Fatalf("validateEntryAmounts() error = %v", err)
	}
	if !debit.Equal(decimal.RequireFromString("12.50")) {
		t.Fatalf("debit = %s, want 12.50", debit)
	}
	if !credit.Equal(decimal.RequireFromString("12.50")) {
		t.Fatalf("credit = %s, want 12.50", credit)
	}
}

func TestValidateEntryAmountsRejectsUnbalancedVoucher(t *testing.T) {
	lines := []entryInput{
		{Debit: decimal.RequireFromString("12.50")},
		{Credit: decimal.RequireFromString("12.49")},
	}

	if _, _, err := validateEntryAmounts(lines); err == nil {
		t.Fatal("validateEntryAmounts() accepted an unbalanced voucher")
	}
}

func TestValidateEntryAmountsRejectsLineWithBothSides(t *testing.T) {
	lines := []entryInput{
		{Debit: decimal.NewFromInt(5), Credit: decimal.NewFromInt(1)},
		{Credit: decimal.NewFromInt(4)},
	}

	if _, _, err := validateEntryAmounts(lines); err == nil {
		t.Fatal("validateEntryAmounts() accepted a line with debit and credit")
	}
}

func TestValidateEntryAmountsRequiresTwoLines(t *testing.T) {
	lines := []entryInput{{Debit: decimal.NewFromInt(1)}}

	if _, _, err := validateEntryAmounts(lines); err == nil {
		t.Fatal("validateEntryAmounts() accepted fewer than two lines")
	}
}
