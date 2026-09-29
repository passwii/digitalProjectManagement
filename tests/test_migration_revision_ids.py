from __future__ import annotations

import ast
import uuid
from pathlib import Path

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.exc import IntegrityError


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
