from __future__ import annotations

import ast
import importlib.util
import io
import os
import uuid
from pathlib import Path

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.exc import IntegrityError


def _super_admin_migration():
    path = Path(__file__).parents[1] / "api" / "alembic" / "versions" / "0034_superadmin_modules.py"
    assert path.exists(), "Task 1 super-admin migration is missing"
    spec = importlib.util.spec_from_file_location("super_admin_migration", path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def test_super_admin_migration_contract():
    migration = _super_admin_migration()
    assert migration.revision == "0034_superadmin_modules"
    assert migration.down_revision == "0033_project_receivable_updaters"

    from alembic.migration import MigrationContext
    from alembic.operations import Operations

    output = io.StringIO()
    context = MigrationContext.configure(
        dialect_name="postgresql", opts={"as_sql": True, "output_buffer": output}
    )
    with Operations.context(context):
        migration.upgrade()
    sql = output.getvalue()
    assert "ADD COLUMN is_super_admin BOOLEAN DEFAULT false NOT NULL" in sql
    assert "CREATE UNIQUE INDEX uq_users_single_super_admin ON users (is_super_admin)" in sql
    assert "WHERE is_super_admin = true" in sql
    assert "15796280534" in sql
    assert "account_book_members" not in sql
    assert "INSERT" not in sql.upper()

    output.seek(0)
    output.truncate(0)
    with Operations.context(context):
        migration.downgrade()
    assert output.getvalue().strip().split(";\n\n") == [
        "DROP INDEX uq_users_single_super_admin",
        "ALTER TABLE users DROP COLUMN is_super_admin;",
    ]


@pytest.mark.parametrize("initial_present", [True, False])
def test_super_admin_migration_upgrades_minimal_schema_and_downgrades(initial_present):
    migration = _super_admin_migration()
    database_url = (os.getenv("TEST_DATABASE_URL") or "").strip()
    if not database_url:
        pytest.skip("TEST_DATABASE_URL is not configured")

    from alembic.migration import MigrationContext
    from alembic.operations import Operations

    engine = create_engine(database_url)
    try:
        with engine.connect() as connection:
            transaction = connection.begin()
            try:
                schema = f"migration_{uuid.uuid4().hex[:12]}"
                connection.execute(text(f'CREATE SCHEMA "{schema}"'))
                connection.execute(text(f'SET LOCAL search_path TO "{schema}"'))
                for ddl in (
                    "CREATE TABLE users (id integer PRIMARY KEY, username text UNIQUE NOT NULL)",
                    "CREATE TABLE roles (id integer PRIMARY KEY, code text NOT NULL)",
                    "CREATE TABLE user_roles (user_id integer, role_id integer)",
                    "CREATE TABLE user_modules (user_id integer, module text)",
                ):
                    connection.execute(text(ddl))
                connection.execute(text("INSERT INTO users VALUES (2, '13900000001')"))
                if initial_present:
                    connection.execute(text("INSERT INTO users VALUES (1, '15796280534')"))
                    connection.execute(text("INSERT INTO user_roles VALUES (1, 1)"))
                    connection.execute(text("INSERT INTO user_modules VALUES (1, 'admin')"))
                connection.execute(text("INSERT INTO roles VALUES (1, 'admin'), (2, 'member')"))
                connection.execute(text("INSERT INTO user_roles VALUES (2, 1), (2, 2)"))
                connection.execute(text("INSERT INTO user_modules VALUES (2, 'admin'), (2, 'projects')"))
                context = MigrationContext.configure(connection)
                with Operations.context(context):
                    migration.upgrade()

                expected_users = [(1, True), (2, False)] if initial_present else [(2, False)]
                assert connection.execute(text("SELECT id, is_super_admin FROM users ORDER BY id")).all() == expected_users
                expected_roles = [(1, 1), (2, 2)] if initial_present else [(2, 2)]
                expected_modules = [(1, "admin"), (2, "projects")] if initial_present else [(2, "projects")]
                assert connection.execute(text("SELECT * FROM user_roles ORDER BY user_id, role_id")).all() == expected_roles
                assert connection.execute(text("SELECT * FROM user_modules ORDER BY user_id, module")).all() == expected_modules
                column = connection.execute(text(
                    "SELECT is_nullable, column_default FROM information_schema.columns "
                    "WHERE table_schema=:schema AND table_name='users' AND column_name='is_super_admin'"
                ), {"schema": schema}).one()
                assert column == ("NO", "false")
                indexes = connection.execute(text(
                    "SELECT indexdef FROM pg_indexes WHERE schemaname=:schema "
                    "AND indexname='uq_users_single_super_admin'"
                ), {"schema": schema}).scalar_one()
                assert "UNIQUE INDEX" in indexes
                assert "(is_super_admin)" in indexes and "WHERE" in indexes
                connection.execute(text("INSERT INTO users (id, username) VALUES (3, 'ordinary')"))
                assert connection.execute(text("SELECT is_super_admin FROM users WHERE id=3")).scalar_one() is False
                if not initial_present:
                    connection.execute(text("UPDATE users SET is_super_admin=true WHERE id=2"))
                with pytest.raises(IntegrityError):
                    with connection.begin_nested():
                        connection.execute(text("UPDATE users SET is_super_admin=true WHERE id=3"))
                with pytest.raises(IntegrityError):
                    with connection.begin_nested():
                        connection.execute(text("UPDATE users SET is_super_admin=NULL WHERE id=3"))

                with Operations.context(context):
                    migration.downgrade()
                assert connection.execute(text(
                    "SELECT count(*) FROM information_schema.columns WHERE table_schema=:schema "
                    "AND table_name='users' AND column_name='is_super_admin'"
                ), {"schema": schema}).scalar_one() == 0
                assert connection.execute(text(
                    "SELECT count(*) FROM pg_indexes WHERE schemaname=:schema "
                    "AND indexname='uq_users_single_super_admin'"
                ), {"schema": schema}).scalar_one() == 0
                assert connection.execute(text("SELECT * FROM user_roles ORDER BY user_id, role_id")).all() == expected_roles
                assert connection.execute(text("SELECT * FROM user_modules ORDER BY user_id, module")).all() == expected_modules
            finally:
                transaction.rollback()
    finally:
        engine.dispose()


def _revision_ids() -> list[tuple[Path, str]]:
    migrations_dir = Path(__file__).parents[1] / "api" / "alembic" / "versions"
    revisions: list[tuple[Path, str]] = []
    for path in sorted(migrations_dir.glob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in tree.body:
            if isinstance(node, ast.Assign) and len(node.targets) == 1:
                target = node.targets[0]
                if isinstance(target, ast.Name) and target.id == "revision":
                    value = ast.literal_eval(node.value)
                    if isinstance(value, str):
                        revisions.append((path, value))
                    break
    return revisions


def test_alembic_revision_ids_fit_default_version_column():
    oversized = [(path.name, revision) for path, revision in _revision_ids() if len(revision) > 32]

    assert oversized == []


def test_equipment_batch_name_migration_backfills_legacy_rows_and_adds_case_insensitive_unique_index():
    migration_path = Path(__file__).parents[1] / "api" / "alembic" / "versions" / "0031_equipment_batch_names.py"
    source = migration_path.read_text(encoding="utf-8")

    assert 'down_revision = "0030_equipment_event_purge_gate"' in source
    assert "UPDATE equipment_batches SET name = '批次 #' || id::text" in source
    assert 'uq_equipment_batches_name_lower' in source
    assert "lower(name)" in source
    assert "nullable=False" in source

    pytest.importorskip("alembic")
    import importlib.util
    import os
    import sys

    database_url = (os.getenv("TEST_DATABASE_URL") or "").strip()
    if not database_url:
        pytest.skip("TEST_DATABASE_URL is not configured")
    sys.path.insert(0, str(Path(__file__).parents[1]))
    from alembic.migration import MigrationContext
    from alembic.operations import Operations
    spec = importlib.util.spec_from_file_location("equipment_batch_name_migration", migration_path)
    migration_module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(migration_module)

    schema = f"migration_{uuid.uuid4().hex[:12]}"
    engine = create_engine(database_url)
    with engine.begin() as connection:
        connection.execute(text(f'CREATE SCHEMA "{schema}"'))
        connection.execute(text(f'SET LOCAL search_path TO "{schema}"'))
        try:
            connection.execute(text("CREATE TABLE equipment_batches (id integer PRIMARY KEY)"))
            connection.execute(text("INSERT INTO equipment_batches (id) VALUES (7), (29)"))
            context = MigrationContext.configure(connection)
            with Operations.context(context):
                migration_module.upgrade()
            assert connection.execute(text("SELECT id, name FROM equipment_batches ORDER BY id")).all() == [
                (7, "批次 #7"), (29, "批次 #29"),
            ]
            assert connection.execute(text("SELECT is_nullable FROM information_schema.columns WHERE table_schema=:schema AND table_name='equipment_batches' AND column_name='name'"), {"schema": schema}).scalar_one() == "NO"
            connection.execute(text("INSERT INTO equipment_batches (id, name) VALUES (30, 'Batch Name')"))
            savepoint = connection.begin_nested()
            try:
                connection.execute(text("INSERT INTO equipment_batches (id, name) VALUES (31, 'batch name')"))
            except IntegrityError:
                savepoint.rollback()
            else:
                savepoint.commit()
                pytest.fail("case-insensitive batch name index accepted a duplicate")
        finally:
            connection.execute(text("SELECT 1"))
    with engine.begin() as connection:
        connection.execute(text(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE'))
    engine.dispose()
