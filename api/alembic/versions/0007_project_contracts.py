"""项目合同与负责人名称字段。

项目编号继续复用 `projects.code`，新项目允许手工录入，留空仍自动取号。
本迁移补齐项目负责人显示名称及合同状态、前后向合同字段。
"""
from alembic import op
import sqlalchemy as sa

revision = "0007_project_contracts"
down_revision = "0006_closure_loop"
branch_labels = None
depends_on = None


def _has_column(table: str, col: str) -> bool:
    return col in [c["name"] for c in sa.inspect(op.get_bind()).get_columns(table)]


def upgrade():
    if not _has_column("projects", "owner_name"):
        op.add_column("projects", sa.Column("owner_name", sa.String(64), server_default=""))
    if not _has_column("projects", "contract_status"):
        op.add_column("projects", sa.Column("contract_status", sa.String(16), server_default=""))
    if not _has_column("projects", "forward_contract"):
        op.add_column("projects", sa.Column("forward_contract", sa.String(128), server_default=""))
    if not _has_column("projects", "backward_contract"):
        op.add_column("projects", sa.Column("backward_contract", sa.String(128), server_default=""))


def downgrade():
    for col in ("backward_contract", "forward_contract", "contract_status", "owner_name"):
        if _has_column("projects", col):
            op.drop_column("projects", col)
