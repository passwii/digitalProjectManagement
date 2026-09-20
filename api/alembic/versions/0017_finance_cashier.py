"""P1-B：出纳资金单据、银行流水和对账关系。"""

import sqlalchemy as sa
from alembic import op

revision = "0017_finance_cashier"
down_revision = "0016_finance_entry_book_scope"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "cash_transactions",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("account_book_id", sa.Integer(), sa.ForeignKey("account_books.id", ondelete="CASCADE"), nullable=False),
        sa.Column("period_id", sa.Integer(), nullable=False),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("transaction_date", sa.Date(), nullable=False),
        sa.Column("amount", sa.Numeric(18, 2), nullable=False),
        sa.Column("account_id", sa.Integer(), nullable=False),
        sa.Column("offset_account_id", sa.Integer(), nullable=False),
        sa.Column("summary", sa.String(255), nullable=False, server_default=""),
        sa.Column("counterparty", sa.String(128), nullable=False, server_default=""),
        sa.Column("cashflow_item", sa.String(32)),
        sa.Column("status", sa.String(16), nullable=False, server_default="draft"),
        sa.Column("voucher_id", sa.Integer(), sa.ForeignKey("vouchers.id")),
        sa.Column("created_by", sa.Integer(), sa.ForeignKey("users.id")),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["account_book_id", "period_id"], ["accounting_periods.account_book_id", "accounting_periods.id"], name="fk_cash_transaction_period_same_book"),
        sa.ForeignKeyConstraint(["account_book_id", "account_id"], ["accounts.account_book_id", "accounts.id"], name="fk_cash_transaction_account_same_book"),
        sa.ForeignKeyConstraint(["account_book_id", "offset_account_id"], ["accounts.account_book_id", "accounts.id"], name="fk_cash_transaction_offset_same_book"),
        sa.CheckConstraint("kind IN ('receipt','payment','expense')", name="ck_cash_transaction_kind"),
        sa.CheckConstraint("amount > 0", name="ck_cash_transaction_amount"),
    )
    op.create_index("ix_cash_transactions_book_period", "cash_transactions", ["account_book_id", "period_id"])
    op.create_table(
        "bank_statements",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("account_book_id", sa.Integer(), sa.ForeignKey("account_books.id", ondelete="CASCADE"), nullable=False),
        sa.Column("period_id", sa.Integer(), nullable=False),
        sa.Column("external_id", sa.String(128), nullable=False),
        sa.Column("transaction_date", sa.Date(), nullable=False),
        sa.Column("direction", sa.String(16), nullable=False),
        sa.Column("amount", sa.Numeric(18, 2), nullable=False),
        sa.Column("account_code", sa.String(32), nullable=False, server_default=""),
        sa.Column("summary", sa.String(255), nullable=False, server_default=""),
        sa.Column("counterparty", sa.String(128), nullable=False, server_default=""),
        sa.Column("status", sa.String(16), nullable=False, server_default="unmatched"),
        sa.Column("matched_voucher_id", sa.Integer(), sa.ForeignKey("vouchers.id")),
        sa.Column("matched_at", sa.DateTime()),
        sa.Column("matched_by", sa.Integer(), sa.ForeignKey("users.id")),
        sa.Column("created_by", sa.Integer(), sa.ForeignKey("users.id")),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("account_book_id", "external_id", name="uq_bank_statement_book_external"),
        sa.CheckConstraint("direction IN ('inflow','outflow')", name="ck_bank_statement_direction"),
        sa.CheckConstraint("amount > 0", name="ck_bank_statement_amount"),
        sa.CheckConstraint("status IN ('unmatched','matched','ignored')", name="ck_bank_statement_status"),
    )
    op.create_index("ix_bank_statements_book_period_status", "bank_statements", ["account_book_id", "period_id", "status"])


def downgrade():
    op.drop_index("ix_bank_statements_book_period_status", table_name="bank_statements")
    op.drop_table("bank_statements")
    op.drop_index("ix_cash_transactions_book_period", table_name="cash_transactions")
    op.drop_table("cash_transactions")
