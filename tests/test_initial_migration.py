"""初始迁移的建表范围不能随当前模型增长。"""

from importlib import import_module

from api.core.database import Base
from api import models  # noqa: F401 - register live ORM tables


def test_initial_tables_are_frozen_to_original_twenty():
    migration = import_module("api.alembic.versions.0001_initial")
    expected = {
        "departments",
        "users",
        "roles",
        "user_roles",
        "projects",
        "project_members",
        "project_changes",
        "attachments",
        "followups",
        "milestones",
        "tasks",
        "progress_logs",
        "budgets",
        "budget_adjusts",
        "expenses",
        "audit_logs",
        "sys_params",
        "dicts",
        "token_blacklist",
        "notifications",
    }

    tables = tuple(migration.initial_tables())

    assert len(tables) == 20
    assert set(tables) == expected
    assert set(tables).isdisjoint(
        {"partners", "vouchers", "voucher_entries", "arap_transactions"}
    )


def test_initial_schema_does_not_depend_on_live_model_columns():
    migration = import_module("api.alembic.versions.0001_initial")
    historical = migration.initial_metadata

    assert historical is not Base.metadata
    assert set(historical.tables) == set(migration.initial_tables())
    assert "owner_name" not in historical.tables["projects"].c
    assert "deleted_at" in historical.tables["projects"].c
    assert "decision_reason" not in historical.tables["expenses"].c
    assert "ref_type" not in historical.tables["attachments"].c
    assert "state" not in historical.tables["notifications"].c
    assert "owner_name" in Base.metadata.tables["projects"].c
    assert "ix_projects_dept_id" in {index.name for index in historical.tables["projects"].indexes}
