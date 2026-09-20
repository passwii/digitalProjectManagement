"""P1-E：应收应付、收付款核销和账龄分析。"""

import sqlalchemy as sa
from alembic import op

revision = "0019_finance_arap"
down_revision = "0018_finance_fixed_assets"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "arap_transactions",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("account_book_id", sa.Integer(), sa.ForeignKey("account_books.id", ondelete="CASCADE"), nullable=False),
        sa.Column("period_id", sa.Integer(), nullable=False),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("transaction_date", sa.Date(), nullable=False),
        sa.Column("party_id", sa.Integer(), nullable=False),
        sa.Column("amount", sa.Numeric(18, 2), nullable=False),
        sa.Column("applied_amount", sa.Numeric(18, 2), nullable=False, server_default="0"),
        sa.Column("account_id", sa.Integer(), nullable=False),
        sa.Column("offset_account_id", sa.Integer(), nullable=False),
        sa.Column("summary", sa.String(255), nullable=False, server_default=""),
        sa.Column("voucher_id", sa.Integer(), sa.ForeignKey("vouchers.id")),
        sa.Column("created_by", sa.Integer(), sa.ForeignKey("users.id")),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.CheckConstraint("kind IN ('receivable','payable')", name="ck_arap_kind"),
        sa.CheckConstraint("amount > 0 AND applied_amount >= 0 AND applied_amount <= amount", name="ck_arap_amounts"),
        sa.ForeignKeyConstraint(["account_book_id", "period_id"], ["accounting_periods.account_book_id", "accounting_periods.id"], name="fk_arap_period_same_book"),
    )
    op.create_index("ix_arap_transactions_book_party_kind", "arap_transactions", ["account_book_id", "party_id", "kind"])
    op.create_table(
        "arap_allocations",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("account_book_id", sa.Integer(), sa.ForeignKey("account_books.id", ondelete="CASCADE"), nullable=False),
        sa.Column("source_id", sa.Integer(), nullable=False),
        sa.Column("target_id", sa.Integer(), nullable=False),
        sa.Column("amount", sa.Numeric(18, 2), nullable=False),
        sa.Column("created_by", sa.Integer(), sa.ForeignKey("users.id")),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("account_book_id", "source_id", "target_id", name="uq_arap_allocation_pair"),
        sa.CheckConstraint("amount > 0", name="ck_arap_allocation_amount"),
    )


def downgrade():
    op.drop_table("arap_allocations")
    op.drop_index("ix_arap_transactions_book_party_kind", table_name="arap_transactions")
    op.drop_table("arap_transactions")
