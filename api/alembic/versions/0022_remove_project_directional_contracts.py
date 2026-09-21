"""移除项目台账的前向合同与后向合同字段。"""

from alembic import op
import sqlalchemy as sa


revision = "0022_project_contracts"
down_revision = "0021_merge_finance_heads"
branch_labels = None
depends_on = None


def _has_column(table: str, column: str) -> bool:
    return column in {item["name"] for item in sa.inspect(op.get_bind()).get_columns(table)}


def upgrade():
    for column in ("backward_contract", "forward_contract"):
        if _has_column("projects", column):
            op.drop_column("projects", column)


def downgrade():
    for column in ("forward_contract", "backward_contract"):
        if not _has_column("projects", column):
            op.add_column("projects", sa.Column(column, sa.String(128), server_default=""))
