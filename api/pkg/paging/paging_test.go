package paging

import (
	"testing"
)

func TestBuildOrderBy(t *testing.T) {
	allowed := map[string]string{
		"id":         "id",
		"created_at": "created_at",
		"amount":     "amount",
	}
	clauses, err := BuildOrderBy("-amount,created_at", allowed, "-id")
	if err != nil {
		t.Fatalf("build order by failed: %v", err)
	}
	// 期望 amount DESC, created_at ASC, id ASC
	if len(clauses) != 3 || clauses[0] != "amount DESC" || clauses[1] != "created_at ASC" || clauses[2] != "id ASC" {
		t.Fatalf("unexpected clauses: %v", clauses)
	}

	_, err = BuildOrderBy("invalid_field", allowed, "-id")
	if err == nil {
		t.Fatalf("expected error for invalid field")
	}
}
