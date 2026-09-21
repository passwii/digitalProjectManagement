"""新增商机管理主表。"""

from alembic import op
import sqlalchemy as sa


revision = "0024_opportunities"
down_revision = "0023_partner_cleanup"
branch_labels = None
depends_on = None


def upgrade():
  inspector = sa.inspect(op.get_bind())
  if "opportunities" in inspector.get_table_names():
    return
  op.create_table(
    "opportunities",
    sa.Column("id", sa.Integer(), primary_key=True),
    sa.Column("code", sa.String(32), nullable=False),
    sa.Column("name", sa.String(128), nullable=False),
    sa.Column("client", sa.String(128), server_default=""),
    sa.Column("owner_id", sa.Integer(), sa.ForeignKey("users.id"), nullable=True),
    sa.Column("owner_name", sa.String(64), server_default=""),
    sa.Column("budget_total", sa.Float(), server_default="0"),
    sa.Column("stage", sa.String(16), server_default="new"),
    sa.Column("expected_close", sa.Date(), nullable=True),
    sa.Column("description", sa.Text(), server_default=""),
    sa.Column("deleted_at", sa.DateTime(), nullable=True),
    sa.Column("created_by", sa.Integer(), sa.ForeignKey("users.id"), nullable=True),
    sa.Column("created_at", sa.DateTime(), nullable=True),
    sa.Column("updated_at", sa.DateTime(), nullable=True),
  )
  op.create_index("ix_opportunities_code", "opportunities", ["code"], unique=True)
  op.create_index("ix_opportunities_owner_id", "opportunities", ["owner_id"])
  op.create_index("ix_opportunities_stage", "opportunities", ["stage"])
  op.create_index("ix_opportunities_deleted_at", "opportunities", ["deleted_at"])


def downgrade():
  inspector = sa.inspect(op.get_bind())
  if "opportunities" in inspector.get_table_names():
    op.drop_table("opportunities")
