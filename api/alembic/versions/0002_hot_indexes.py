"""Stage4：高频索引复查补齐。"""
from alembic import op
import sqlalchemy as sa

revision = "0002_hot_indexes"
down_revision = "0001_initial"
branch_labels = None
depends_on = None


def _add_index(name, table, cols):
    existing = {i["name"] for i in sa.inspect(op.get_bind()).get_indexes(table)}
    if name not in existing:
        op.create_index(name, table, cols)


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
    # These indexes are part of the frozen 0001 baseline. This revision remains
    # as an idempotent compatibility step for databases that predate the
    # snapshot; downgrading must not remove objects owned by 0001.
    pass
