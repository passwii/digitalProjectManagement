package database

import (
	"strings"
	"testing"
)

func TestNormalizeDatabaseURL(t *testing.T) {
	t.Setenv("DB_FORWARD_HOST", "")

	tests := []struct {
		name    string
		input   string
		want    string
		wantErr string
	}{
		{
			name:  "sqlalchemy psycopg prefix",
			input: "postgresql+psycopg://app:app@localhost:5432/app_test",
			want:  "postgresql://app:app@localhost:5432/app_test",
		},
		{
			name:  "postgres prefix",
			input: "postgres://app:app@localhost:5432/app_test",
			want:  "postgres://app:app@localhost:5432/app_test",
		},
		{
			name:  "percent encoded password",
			input: "postgresql://app:p%40ss@localhost:5432/app_test",
			want:  "postgresql://app:p%40ss@localhost:5432/app_test",
		},
		{
			name:  "keyword dsn passthrough",
			input: "host=localhost user=app dbname=app_test",
			want:  "host=localhost user=app dbname=app_test",
		},
		{
			name:    "unsupported scheme",
			input:   "mysql://app:app@localhost:3306/app_test",
			wantErr: "unsupported database URL scheme",
		},
		{
			name:    "missing host",
			input:   "postgresql:///app_test",
			wantErr: "database URL has no host",
		},
		{
			name:    "empty",
			input:   "   ",
			wantErr: "database URL is empty",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := normalizeDatabaseURL(tt.input)
			if tt.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("normalizeDatabaseURL(%q) error = %v, want containing %q", tt.input, err, tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("normalizeDatabaseURL(%q): %v", tt.input, err)
			}
			if got != tt.want {
				t.Fatalf("normalizeDatabaseURL(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}

func TestNormalizeDatabaseURLForwardsHost(t *testing.T) {
	t.Setenv("DB_FORWARD_HOST", "db-tunnel")
	got, err := normalizeDatabaseURL("postgresql+psycopg://app:secret@host.docker.internal:5432/app_test?sslmode=disable")
	if err != nil {
		t.Fatalf("normalizeDatabaseURL: %v", err)
	}
	want := "postgresql://app:secret@db-tunnel:5432/app_test?sslmode=disable"
	if got != want {
		t.Fatalf("normalizeDatabaseURL = %q, want %q", got, want)
	}
}

func TestNormalizeDatabaseURLForwardsIPv6Host(t *testing.T) {
	t.Setenv("DB_FORWARD_HOST", "::1")
	got, err := normalizeDatabaseURL("postgresql://app:secret@localhost:5432/app_test")
	if err != nil {
		t.Fatalf("normalizeDatabaseURL: %v", err)
	}
	want := "postgresql://app:secret@[::1]:5432/app_test"
	if got != want {
		t.Fatalf("normalizeDatabaseURL = %q, want %q", got, want)
	}
}

func TestNormalizeDatabaseURLRejectsForwardHostForKeywordDSN(t *testing.T) {
	t.Setenv("DB_FORWARD_HOST", "db-tunnel")
	_, err := normalizeDatabaseURL("host=localhost user=app dbname=app_test")
	if err == nil || !strings.Contains(err.Error(), "DB_FORWARD_HOST requires") {
		t.Fatalf("error = %v, want DB_FORWARD_HOST requirement", err)
	}
}
