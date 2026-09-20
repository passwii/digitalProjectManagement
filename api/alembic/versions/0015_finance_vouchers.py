"""P0-B/C/D：财务凭证、分录与凭证模板。"""

import sqlalchemy as sa
from alembic import op

revision = "0015_finance_vouchers"
down_revision = "0014_finance_p0a_review"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "vouchers",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("account_book_id", sa.Integer(), sa.ForeignKey("account_books.id", ondelete="CASCADE"), nullable=False),
        sa.Column("period_id", sa.Integer(), nullable=False),
        sa.Column("voucher_no", sa.String(32), nullable=False),
        sa.Column("voucher_date", sa.Date(), nullable=False),
        sa.Column("status", sa.String(16), nullable=False, server_default="draft"),
        sa.Column("source", sa.String(16), nullable=False, server_default="manual"),
        sa.Column("summary", sa.String(255), nullable=False, server_default=""),
        sa.Column("total_debit", sa.Numeric(18, 2), nullable=False, server_default="0"),
        sa.Column("total_credit", sa.Numeric(18, 2), nullable=False, server_default="0"),
        sa.Column("created_by", sa.Integer(), sa.ForeignKey("users.id")),
        sa.Column("reviewed_by", sa.Integer(), sa.ForeignKey("users.id")),
        sa.Column("posted_by", sa.Integer(), sa.ForeignKey("users.id")),
        sa.Column("voided_by", sa.Integer(), sa.ForeignKey("users.id")),
        sa.Column("reversal_of", sa.Integer(), sa.ForeignKey("vouchers.id")),
        sa.Column("decision_reason", sa.Text(), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("account_book_id", "period_id", "voucher_no", name="uq_voucher_book_period_no"),
        sa.UniqueConstraint("account_book_id", "id", name="uq_voucher_book_id"),
        sa.ForeignKeyConstraint(
            ["account_book_id", "period_id"],
            ["accounting_periods.account_book_id", "accounting_periods.id"],
            name="fk_voucher_period_same_book",
            ondelete="CASCADE",
        ),
        sa.CheckConstraint("status IN ('draft','pending','posted','void')", name="ck_voucher_status"),
        sa.CheckConstraint("total_debit >= 0 AND total_credit >= 0 AND total_debit = total_credit", name="ck_voucher_balanced"),
    )
    op.create_index("ix_vouchers_book_status", "vouchers", ["account_book_id", "status"])
    op.create_table(
        "voucher_entries",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("voucher_id", sa.Integer(), sa.ForeignKey("vouchers.id", ondelete="CASCADE"), nullable=False),
        sa.Column("line_no", sa.Integer(), nullable=False),
        sa.Column("account_id", sa.Integer(), sa.ForeignKey("accounts.id"), nullable=False),
        sa.Column("summary", sa.String(255), nullable=False, server_default=""),
        sa.Column("debit", sa.Numeric(18, 2), nullable=False, server_default="0"),
        sa.Column("credit", sa.Numeric(18, 2), nullable=False, server_default="0"),
        sa.Column("aux_detail", sa.JSON(), nullable=False, server_default="{}"),
        sa.Column("cashflow_item", sa.String(32)),
        sa.UniqueConstraint("voucher_id", "line_no", name="uq_voucher_entry_line"),
        sa.CheckConstraint("debit >= 0 AND credit >= 0", name="ck_voucher_entry_nonneg"),
        sa.CheckConstraint("(debit > 0) <> (credit > 0)", name="ck_voucher_entry_one_side"),
    )
    op.create_index("ix_voucher_entries_account", "voucher_entries", ["account_id"])
    op.create_table(
        "voucher_templates",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("account_book_id", sa.Integer(), sa.ForeignKey("account_books.id", ondelete="CASCADE"), nullable=False),
        sa.Column("code", sa.String(32), nullable=False),
        sa.Column("name", sa.String(128), nullable=False),
        sa.Column("lines", sa.JSON(), nullable=False, server_default="[]"),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_by", sa.Integer(), sa.ForeignKey("users.id")),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("account_book_id", "code", name="uq_voucher_template_book_code"),
    )


def downgrade():
    op.drop_table("voucher_templates")
    op.drop_index("ix_voucher_entries_account", table_name="voucher_entries")
    op.drop_table("voucher_entries")
    op.drop_index("ix_vouchers_book_status", table_name="vouchers")
    op.drop_table("vouchers")
