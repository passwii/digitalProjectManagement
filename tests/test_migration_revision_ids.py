from __future__ import annotations

import ast
from pathlib import Path


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
    migration = Path(__file__).parents[1] / "api" / "alembic" / "versions" / "0031_equipment_batch_names.py"
    source = migration.read_text(encoding="utf-8")

    assert 'down_revision = "0030_equipment_event_purge_gate"' in source
    assert "UPDATE equipment_batches SET name = '批次 #' || id::text" in source
    assert 'uq_equipment_batches_name_lower' in source
    assert "lower(name)" in source
    assert "nullable=False" in source
