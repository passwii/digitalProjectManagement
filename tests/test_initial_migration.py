"""初始迁移的建表范围不能随当前模型增长。"""

from importlib import import_module


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
