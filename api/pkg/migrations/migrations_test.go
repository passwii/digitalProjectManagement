package migrations

import (
	"context"
	"database/sql"
	"net/url"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"
	_ "github.com/jackc/pgx/v5/stdlib"
)

func testDB(t *testing.T) *sql.DB {
	t.Helper()
	raw := strings.TrimSpace(os.Getenv("TEST_DATABASE_URL"))
	if raw == "" {
		t.Skip("TEST_DATABASE_URL not set; skipping migration integration tests")
	}
	adminDSN := strings.Replace(raw, "postgresql+psycopg://", "postgresql://", 1)
	admin, err := sql.Open("pgx", adminDSN)
	if err != nil {
		t.Fatalf("open admin database: %v", err)
	}
	if err := admin.Ping(); err != nil {
		t.Fatalf("ping admin database: %v", err)
	}
	schema := "migration_test_" + strings.ReplaceAll(uuid.NewString()[:8], "-", "")
	if _, err := admin.Exec("CREATE SCHEMA " + schema); err != nil {
		t.Fatalf("create test schema: %v", err)
	}
	t.Cleanup(func() {
		_, _ = admin.Exec("DROP SCHEMA IF EXISTS " + schema + " CASCADE")
		_ = admin.Close()
	})

	db, err := sql.Open("pgx", withSearchPath(adminDSN, schema))
	if err != nil {
		t.Fatalf("open schema database: %v", err)
	}
	if err := db.Ping(); err != nil {
		t.Fatalf("ping schema database: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

func withSearchPath(raw, schema string) string {
	parsed, err := url.Parse(raw)
	if err != nil {
		return raw
	}
	query := parsed.Query()
	query.Set("search_path", schema)
	parsed.RawQuery = query.Encode()
	return parsed.String()
}

func mustExec(t *testing.T, db *sql.DB, statements ...string) {
	t.Helper()
	for _, statement := range statements {
		if _, err := db.Exec(statement); err != nil {
			t.Fatalf("exec %q: %v", statement, err)
		}
	}
}

func gooseVersion(t *testing.T, db *sql.DB) int64 {
	t.Helper()
	var version int64
	if err := db.QueryRow("SELECT COALESCE(MAX(version_id), 0) FROM goose_db_version WHERE is_applied").Scan(&version); err != nil {
		t.Fatalf("read goose version: %v", err)
	}
	return version
}

func relationExists(t *testing.T, db *sql.DB, name string) bool {
	t.Helper()
	var exists bool
	if err := db.QueryRow("SELECT to_regclass($1) IS NOT NULL", name).Scan(&exists); err != nil {
		t.Fatalf("check relation %s: %v", name, err)
	}
	return exists
}

func TestUpCreatesBaselineOnEmptySchema(t *testing.T) {
	db := testDB(t)
	if err := Up(context.Background(), db); err != nil {
		t.Fatalf("Up on empty schema: %v", err)
	}
	if version := gooseVersion(t, db); version != 1 {
		t.Fatalf("goose version = %d, want 1", version)
	}
	for _, table := range []string{"users", "vouchers", "equipment_events", "project_receivables"} {
		if !relationExists(t, db, table) {
			t.Fatalf("baseline did not create %s", table)
		}
	}
	var columnExists bool
	if err := db.QueryRow(`SELECT EXISTS (
		SELECT 1 FROM information_schema.columns
		WHERE table_schema = current_schema() AND table_name = 'vouchers' AND column_name = 'source_expense_id'
	)`).Scan(&columnExists); err != nil {
		t.Fatalf("check vouchers column: %v", err)
	}
	if !columnExists {
		t.Fatal("baseline is missing vouchers.source_expense_id")
	}
}

func TestUpAdoptsLegacyHeadWithoutApplyingBaseline(t *testing.T) {
	db := testDB(t)
	mustExec(t, db,
		"CREATE TABLE alembic_version (version_num varchar(32) PRIMARY KEY)",
		"INSERT INTO alembic_version (version_num) VALUES ('0035_merge_superadmin_inventory')",
		"CREATE TABLE users (id integer PRIMARY KEY, is_super_admin boolean NOT NULL DEFAULT false)",
		"CREATE TABLE equipment_assets (id integer PRIMARY KEY, available_quantity integer NOT NULL DEFAULT 1, inventory_managed boolean NOT NULL DEFAULT false)",
		"CREATE TABLE project_receivable_payments (id integer PRIMARY KEY, updated_by integer NOT NULL DEFAULT 0)",
	)
	if err := Up(context.Background(), db); err != nil {
		t.Fatalf("Up adopting legacy head: %v", err)
	}
	if version := gooseVersion(t, db); version != 1 {
		t.Fatalf("goose version = %d, want 1", version)
	}
	if relationExists(t, db, "projects") {
		t.Fatal("baseline DDL ran against an adopted legacy database")
	}
	var columns int
	if err := db.QueryRow(`SELECT count(*) FROM information_schema.columns
		WHERE table_schema = current_schema() AND table_name = 'users'`).Scan(&columns); err != nil {
		t.Fatalf("count users columns: %v", err)
	}
	if columns != 2 {
		t.Fatalf("users columns = %d, want 2 (adoption must not run baseline DDL)", columns)
	}
}

func TestUpRejectsWrongLegacyHead(t *testing.T) {
	db := testDB(t)
	mustExec(t, db,
		"CREATE TABLE alembic_version (version_num varchar(32) PRIMARY KEY)",
		"INSERT INTO alembic_version (version_num) VALUES ('0001_initial')",
	)
	err := Up(context.Background(), db)
	if err == nil || !strings.Contains(err.Error(), "expected Alembic head") {
		t.Fatalf("error = %v, want Alembic head refusal", err)
	}
}

func TestUpRejectsMissingSentinelColumn(t *testing.T) {
	db := testDB(t)
	mustExec(t, db,
		"CREATE TABLE alembic_version (version_num varchar(32) PRIMARY KEY)",
		"INSERT INTO alembic_version (version_num) VALUES ('0035_merge_superadmin_inventory')",
		"CREATE TABLE users (id integer PRIMARY KEY, is_super_admin boolean NOT NULL DEFAULT false)",
		"CREATE TABLE equipment_assets (id integer PRIMARY KEY, available_quantity integer NOT NULL DEFAULT 1)",
		"CREATE TABLE project_receivable_payments (id integer PRIMARY KEY, updated_by integer NOT NULL DEFAULT 0)",
	)
	err := Up(context.Background(), db)
	if err == nil || !strings.Contains(err.Error(), "equipment_assets.inventory_managed") {
		t.Fatalf("error = %v, want missing sentinel refusal", err)
	}
}

func TestUpRejectsUnrecognizedObjects(t *testing.T) {
	db := testDB(t)
	mustExec(t, db, "CREATE TABLE random_table (id integer PRIMARY KEY)")
	err := Up(context.Background(), db)
	if err == nil || !strings.Contains(err.Error(), "unrecognized objects") || !strings.Contains(err.Error(), "random_table") {
		t.Fatalf("error = %v, want unrecognized-object refusal naming random_table", err)
	}
}

func TestUpRetriesAfterFailedBootstrapLeftGooseSequence(t *testing.T) {
	db := testDB(t)
	mustExec(t, db,
		`CREATE TABLE goose_db_version (
			id integer PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY,
			version_id bigint NOT NULL,
			is_applied boolean NOT NULL,
			tstamp timestamp NOT NULL DEFAULT now()
		)`,
		"INSERT INTO goose_db_version (version_id, is_applied) VALUES (0, true)",
	)
	if !relationExists(t, db, "goose_db_version_id_seq") {
		t.Fatal("test setup did not create goose_db_version_id_seq")
	}
	if err := Up(context.Background(), db); err != nil {
		t.Fatalf("Up after failed bootstrap: %v", err)
	}
	if version := gooseVersion(t, db); version != 1 {
		t.Fatalf("goose version = %d, want 1", version)
	}
	if !relationExists(t, db, "users") {
		t.Fatal("retry did not apply baseline")
	}
}

func TestBaselineDefinitionsAreCompleteAndForwardOnly(t *testing.T) {
	data, err := migrationFiles.ReadFile("00001_current_schema.sql")
	if err != nil {
		t.Fatalf("read embedded baseline: %v", err)
	}
	up := strings.SplitN(string(data), "-- +goose Down", 2)[0]
	tables, sequences, open := 0, 0, false
	for _, line := range strings.Split(up, "\n") {
		trimmed := strings.TrimSpace(line)
		switch {
		case strings.HasPrefix(trimmed, "CREATE TABLE "):
			if open {
				t.Fatalf("CREATE TABLE before previous definition closed: %s", trimmed)
			}
			open = true
			tables++
		case open && trimmed == ");":
			open = false
		case strings.HasPrefix(trimmed, "CREATE SEQUENCE "):
			sequences++
		}
	}
	if open {
		t.Fatal("last CREATE TABLE is missing its closing );")
	}
	if tables != 48 {
		t.Fatalf("baseline CREATE TABLE count = %d, want 48", tables)
	}
	if sequences != 45 {
		t.Fatalf("baseline CREATE SEQUENCE count = %d, want 45", sequences)
	}
	if strings.Contains(up, "DROP TABLE") {
		t.Fatal("baseline Up must not contain DROP TABLE")
	}
	if strings.Contains(up, "SET transaction_timeout") {
		t.Fatal("baseline Up must not require PostgreSQL 17+ transaction_timeout")
	}
	down := strings.SplitN(string(data), "-- +goose Down", 2)
	if len(down) != 2 || !strings.Contains(down[1], "RAISE EXCEPTION") || strings.Contains(down[1], "DROP TABLE") {
		t.Fatal("baseline Down must fail closed without dropping application tables")
	}
}
