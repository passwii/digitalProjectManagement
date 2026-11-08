package task

import "testing"

func TestTaskTransitionAllowed(t *testing.T) {
	tests := []struct {
		from, to string
		want     bool
	}{
		{"todo", "doing", true},
		{"doing", "paused", true},
		{"paused", "done", true},
		{"done", "doing", true},
		{"done", "paused", false},
		{"unknown", "todo", false},
	}
	for _, tt := range tests {
		if got := taskTransitionAllowed(tt.from, tt.to); got != tt.want {
			t.Errorf("taskTransitionAllowed(%q, %q) = %t, want %t", tt.from, tt.to, got, tt.want)
		}
	}
}

func TestTaskLevelEnforcesFiveLevelLimit(t *testing.T) {
	if got, err := taskLevel(0); got != 1 || err != nil {
		t.Fatalf("root level = %d, %v; want 1, nil", got, err)
	}
	if got, err := taskLevel(4); got != 5 || err != nil {
		t.Fatalf("child level = %d, %v; want 5, nil", got, err)
	}
	if _, err := taskLevel(5); err == nil {
		t.Fatal("sixth level must be rejected")
	}
}

func TestDependencyCycle(t *testing.T) {
	two := uint(2)
	three := uint(3)
	predecessors := map[uint]*uint{2: &three}
	if !dependencyCycle(3, &two, predecessors) {
		t.Fatal("dependency path returning to current task must be detected")
	}
	if dependencyCycle(1, &two, predecessors) {
		t.Fatal("acyclic dependency path must be accepted")
	}
}
