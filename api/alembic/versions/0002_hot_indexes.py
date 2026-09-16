"""Stage4：高频索引复查补齐。"""
from alembic import op

revision = "0002_hot_indexes"
down_revision = "0001_initial"
branch_labels = None
depends_on = None


def _add_index(name, table, cols):
    try:
        op.create_index(name, table, cols)
    except Exception:
        pass  # 已存在/旧库兼容


def upgrade():
    _add_index("ix_projects_dept_id", "projects", ["dept_id"])
    _add_index("ix_projects_owner_id", "projects", ["owner_id"])
    _add_index("ix_followups_user_id", "followups", ["user_id"])
    _add_index("ix_followups_remind_at", "followups", ["remind_at"])
    _add_index("ix_tasks_proj_status", "tasks", ["project_id", "status"])
    _add_index("ix_logs_proj_created", "progress_logs", ["project_id", "created_at"])
    _add_index("ix_milestones_proj_status", "milestones", ["project_id", "status"])
    _add_index("ix_expenses_proj_subject", "expenses", ["project_id", "subject"])
    _add_index("ix_expenses_proj_status", "expenses", ["project_id", "status"])
    _add_index("ix_budgets_proj_subject", "budgets", ["project_id", "subject"])


def downgrade():
    for n, t in [("ix_projects_dept_id", "projects"), ("ix_projects_owner_id", "projects"),
                 ("ix_followups_user_id", "followups"), ("ix_followups_remind_at", "followups"),
                 ("ix_tasks_proj_status", "tasks"), ("ix_logs_proj_created", "progress_logs"),
                 ("ix_milestones_proj_status", "milestones"),
                 ("ix_expenses_proj_subject", "expenses"), ("ix_expenses_proj_status", "expenses"),
                 ("ix_budgets_proj_subject", "budgets")]:
        try:
            op.drop_index(n, table_name=t)
        except Exception:
            pass
