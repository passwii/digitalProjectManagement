"""首个 revision：按冻结的历史结构建立最早版本的 20 张表。"""
from alembic import op

from api.alembic.initial_schema import Base as InitialBase

revision = "0001_initial"
down_revision = None
branch_labels = None
depends_on = None

_INITIAL_TABLES = (
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
)


def initial_tables():
    """返回初始迁移冻结的表名。"""
    return _INITIAL_TABLES


def _metadata_tables():
    return [initial_metadata.tables[name] for name in initial_tables()]


initial_metadata = InitialBase.metadata


def upgrade():
    initial_metadata.create_all(bind=op.get_bind(), tables=_metadata_tables())


def downgrade():
    initial_metadata.drop_all(bind=op.get_bind(), tables=_metadata_tables())
