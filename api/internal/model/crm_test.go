package model

import (
	"sync"
	"testing"

	"gorm.io/gorm/schema"
)

func modelColumns(t *testing.T, value any) map[string]bool {
	t.Helper()
	parsed, err := schema.Parse(value, &sync.Map{}, schema.NamingStrategy{})
	if err != nil {
		t.Fatal(err)
	}
	columns := make(map[string]bool, len(parsed.Fields))
	for _, field := range parsed.Fields {
		if field.DBName != "" {
			columns[field.DBName] = true
		}
	}
	return columns
}

func TestContactProfileUsesExistingRosterColumns(t *testing.T) {
	columns := modelColumns(t, &ContactProfile{})
	for _, name := range []string{
		"mobile", "regular_date", "leave_date", "office_phone", "work_location",
		"contract_start", "contract_end", "school", "graduation_date",
		"emergency_contact", "emergency_relation", "emergency_phone", "updated_by",
	} {
		if !columns[name] {
			t.Errorf("contact_profiles model is missing database column %q", name)
		}
	}
	for _, name := range []string{"phone", "personal_email", "probation_end_date"} {
		if columns[name] {
			t.Errorf("contact_profiles model must not target non-existent column %q", name)
		}
	}
}

func TestOpportunityUsesExistingColumnsAndDeletedBy(t *testing.T) {
	columns := modelColumns(t, &Opportunity{})
	for _, name := range []string{
		"client", "owner_id", "budget_total", "expected_close", "created_by",
		"deleted_at",
	} {
		if !columns[name] {
			t.Errorf("opportunities model is missing database column %q", name)
		}
	}
	for _, name := range []string{"customer_name", "amount", "expected_sign"} {
		if columns[name] {
			t.Errorf("opportunities model must not target non-existent column %q", name)
		}
	}
}
