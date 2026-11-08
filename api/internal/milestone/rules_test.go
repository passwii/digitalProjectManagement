package milestone

import (
	"testing"
	"time"

	"digitalprojectmanagement/api/pkg/timeutil"
)

func TestWarningState(t *testing.T) {
	today := time.Date(2026, 11, 8, 0, 0, 0, 0, timeutil.Loc)
	yesterday := timeutil.NewDate(today.AddDate(0, 0, -1))
	tomorrow := timeutil.NewDate(today.AddDate(0, 0, 1))
	nextWeek := timeutil.NewDate(today.AddDate(0, 0, 7))

	if overdue, near := warningState(&yesterday, nil, today, 3); !overdue || near {
		t.Fatalf("overdue result = (%t, %t), want (true, false)", overdue, near)
	}
	if overdue, near := warningState(&tomorrow, nil, today, 3); overdue || !near {
		t.Fatalf("near result = (%t, %t), want (false, true)", overdue, near)
	}
	if overdue, near := warningState(&yesterday, &yesterday, today, 3); overdue || near {
		t.Fatalf("completed milestone result = (%t, %t), want (false, false)", overdue, near)
	}
	if overdue, near := warningState(&nextWeek, nil, today, 3); overdue || near {
		t.Fatalf("distant milestone result = (%t, %t), want (false, false)", overdue, near)
	}
}
