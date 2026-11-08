package finance

import (
	"testing"

	"digitalprojectmanagement/api/internal/model"
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

func TestJsonTextNormalizesNilToEmptyObject(t *testing.T) {
	if got := jsonText(nil); got != "{}" {
		t.Fatalf("jsonText(nil) = %s, want {}", got)
	}
	var m map[string]bool
	if got := jsonText(m); got != "{}" {
		t.Fatalf("jsonText(nil map) = %s, want {}", got)
	}
}

func TestCalculateBalanceSheetTotalsDoesNotRepeatChildActivity(t *testing.T) {
	parentID, childID := uint(1), uint(2)
	accounts := []model.Account{
		{ID: parentID, Name: "主营业务成本", Category: "损益", Direction: "D"},
		{ID: childID, ParentID: &parentID, Name: "直接成本", Category: "损益", Direction: "D"},
	}
	opening := map[uint]ledgerTotals{}
	through := map[uint]ledgerTotals{
		parentID: {AccountID: parentID, Debit: decimal.NewFromInt(20)},
		childID:  {AccountID: childID, Debit: decimal.NewFromInt(100)},
	}

	got := calculateBalanceSheetTotals(accounts, opening, through)

	if !got.profit.Equal(decimal.NewFromInt(120)) {
		t.Fatalf("profit = %s, want 120 without counting the child twice", got.profit)
	}
}
