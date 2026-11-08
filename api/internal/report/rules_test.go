package report

import "testing"

func TestAggregateCosts(t *testing.T) {
	budgets := []costAmount{
		{ProjectID: 1, Subject: "人工", Amount: 100},
		{ProjectID: 1, Subject: "采购", Amount: 50},
	}
	expenses := []costAmount{
		{ProjectID: 1, ProjectCode: "P-1", ProjectName: "项目一", DeptID: 2, Subject: "人工", Amount: 40},
		{ProjectID: 1, ProjectCode: "P-1", ProjectName: "项目一", DeptID: 2, Subject: "外包", Amount: 10},
	}
	got := aggregateCosts([]costProject{{ID: 1, Code: "P-1", Name: "项目一", DeptID: 2}}, budgets, expenses, "")
	if len(got) != 3 {
		t.Fatalf("got %d rows, want 3", len(got))
	}
	var labor costRow
	for _, row := range got {
		if row.Subject == "人工" {
			labor = row
		}
	}
	if labor.Budget != 100 || labor.Spent != 40 || labor.Balance != 60 {
		t.Fatalf("labor row = %#v, want budget=100 spent=40 balance=60", labor)
	}
}
