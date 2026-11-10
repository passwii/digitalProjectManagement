package migrations

import (
	"context"
	"database/sql"
	"embed"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/pressly/goose/v3"
)

const (
	legacyAlembicHead = "0035_merge_superadmin_inventory"
	baselineVersion   = int64(1)
	versionTable      = "goose_db_version"
)

// migrationFiles contains the immutable schema baseline and all later Goose migrations.
//
//go:embed *.sql
var migrationFiles embed.FS

// Up adopts databases already migrated by Alembic at its current head, then applies
// any pending Goose migrations. Unknown or partially migrated schemas are rejected.
func Up(ctx context.Context, db *sql.DB) error {
	if err := goose.SetDialect("postgres"); err != nil {
		return fmt.Errorf("set Goose PostgreSQL dialect: %w", err)
	}

	release, err := acquireMigrationLock(ctx, db)
	if err != nil {
		return err
	}
	defer release()

	provider, err := goose.NewProvider(goose.DialectPostgres, db, migrationFiles)
	if err != nil {
		return fmt.Errorf("create Goose migration provider: %w", err)
	}
	// The provider is intentionally not closed here: it closes the caller-owned
	// *sql.DB, which cmd/migrate and the integration harness still own.

	if err := adoptLegacyDatabase(ctx, db, provider); err != nil {
		return err
	}
	if _, err := provider.Up(ctx); err != nil {
		return fmt.Errorf("apply Goose migrations: %w", err)
	}
	return nil
}

// migrationLockKey serializes adoption and migration runs across API processes.
// It is a fixed 64-bit advisory-lock key (the ASCII bytes "goose").
const migrationLockKey int64 = 0x676f6f7365

func acquireMigrationLock(ctx context.Context, db *sql.DB) (func(), error) {
	conn, err := db.Conn(ctx)
	if err != nil {
		return nil, fmt.Errorf("acquire migration lock connection: %w", err)
	}
	if _, err := conn.ExecContext(ctx, "SELECT pg_advisory_lock($1)", migrationLockKey); err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("acquire migration lock: %w", err)
	}
	return func() {
		unlockCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_, _ = conn.ExecContext(unlockCtx, "SELECT pg_advisory_unlock($1)", migrationLockKey)
		_ = conn.Close()
	}, nil
}

func adoptLegacyDatabase(ctx context.Context, db *sql.DB, provider *goose.Provider) error {
	hasGoose, err := tableExists(ctx, db, versionTable)
	if err != nil {
		return err
	}
	if hasGoose {
		version, err := provider.GetDBVersion(ctx)
		if err != nil {
			return fmt.Errorf("read Goose migration version: %w", err)
		}
		if version > 0 {
			return nil
		}
	}

	hasAlembic, err := tableExists(ctx, db, "alembic_version")
	if err != nil {
		return err
	}
	if hasAlembic {
		if err := verifyLegacyHead(ctx, db); err != nil {
			return err
		}
		if err := stampBaseline(ctx, db); err != nil {
			return err
		}
		return nil
	}

	objects, err := unrecognizedObjects(ctx, db)
	if err != nil {
		return err
	}
	if len(objects) > 0 {
		return fmt.Errorf("database has unrecognized objects but no Goose/Alembic migration state (refusing to apply baseline): %s", strings.Join(objects, ", "))
	}
	return nil
}

func verifyLegacyHead(ctx context.Context, db *sql.DB) error {
	rows, err := db.QueryContext(ctx, "SELECT version_num FROM alembic_version ORDER BY version_num")
	if err != nil {
		return fmt.Errorf("read Alembic migration head: %w", err)
	}
	defer rows.Close()

	var heads []string
	for rows.Next() {
		var head string
		if err := rows.Scan(&head); err != nil {
			return fmt.Errorf("read Alembic migration head: %w", err)
		}
		heads = append(heads, head)
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("read Alembic migration head: %w", err)
	}
	if len(heads) != 1 || heads[0] != legacyAlembicHead {
		return fmt.Errorf("refusing Goose adoption: expected Alembic head %q, found %v; upgrade with the legacy migrator before switching", legacyAlembicHead, heads)
	}

	for _, required := range [][2]string{
		{"users", "is_super_admin"},
		{"equipment_assets", "available_quantity"},
		{"equipment_assets", "inventory_managed"},
		{"project_receivable_payments", "updated_by"},
	} {
		found, err := columnExists(ctx, db, required[0], required[1])
		if err != nil {
			return err
		}
		if !found {
			return fmt.Errorf("refusing Goose adoption: Alembic head is %q but required column %s.%s is missing", legacyAlembicHead, required[0], required[1])
		}
	}
	return nil
}

func stampBaseline(ctx context.Context, db *sql.DB) error {
	version, err := goose.EnsureDBVersionContext(ctx, db)
	if err != nil && !errors.Is(err, goose.ErrNoNextVersion) {
		return fmt.Errorf("initialize Goose version table: %w", err)
	}
	if version >= baselineVersion {
		return nil
	}

	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin Goose baseline adoption: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, "INSERT INTO goose_db_version (version_id, is_applied) VALUES ($1, TRUE)", baselineVersion); err != nil {
		return fmt.Errorf("record Goose baseline adoption: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit Goose baseline adoption: %w", err)
	}
	return nil
}

func tableExists(ctx context.Context, db *sql.DB, table string) (bool, error) {
	const query = `SELECT EXISTS (
		SELECT 1
		FROM pg_catalog.pg_class AS c
		JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
		WHERE n.nspname = current_schema()
		  AND c.relname = $1
		  AND c.relkind IN ('r', 'p')
	)`
	var exists bool
	if err := db.QueryRowContext(ctx, query, table).Scan(&exists); err != nil {
		return false, fmt.Errorf("check migration table %s: %w", table, err)
	}
	return exists, nil
}

func columnExists(ctx context.Context, db *sql.DB, table, column string) (bool, error) {
	const query = `SELECT EXISTS (
		SELECT 1
		FROM pg_catalog.pg_attribute AS a
		JOIN pg_catalog.pg_class AS c ON c.oid = a.attrelid
		JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
		WHERE n.nspname = current_schema()
		  AND c.relname = $1
		  AND a.attname = $2
		  AND a.attnum > 0
		  AND NOT a.attisdropped
	)`
	var exists bool
	if err := db.QueryRowContext(ctx, query, table, column).Scan(&exists); err != nil {
		return false, fmt.Errorf("check legacy schema column %s.%s: %w", table, column, err)
	}
	return exists, nil
}

func unrecognizedObjects(ctx context.Context, db *sql.DB) ([]string, error) {
	const query = `SELECT c.relname
		FROM pg_catalog.pg_class AS c
		JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
		WHERE n.nspname = current_schema()
		  AND (
			c.relkind IN ('r', 'p', 'v', 'm', 'f')
			OR (
				c.relkind = 'S'
				AND NOT EXISTS (
					SELECT 1
					FROM pg_catalog.pg_depend AS d
					JOIN pg_catalog.pg_class AS t ON t.oid = d.refobjid
					JOIN pg_catalog.pg_namespace AS tn ON tn.oid = t.relnamespace
					WHERE d.objid = c.oid
					  AND d.deptype = 'i'
					  AND tn.nspname = current_schema()
					  AND t.relname = $1
				)
			)
		  )
		  AND c.relname NOT IN ('alembic_version', $1)
		ORDER BY c.relname`
	rows, err := db.QueryContext(ctx, query, versionTable)
	if err != nil {
		return nil, fmt.Errorf("check for untracked application objects: %w", err)
	}
	defer rows.Close()

	var objects []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, fmt.Errorf("check for untracked application objects: %w", err)
		}
		objects = append(objects, name)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("check for untracked application objects: %w", err)
	}
	return objects, nil
}
