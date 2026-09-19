"""Complete P0-A review contracts: chart version and persisted balances."""

import sqlalchemy as sa

from alembic import op

revision = "0014_finance_p0a_review"
down_revision = "0013_finance_p0a"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "accounts",
        sa.Column("subject_version", sa.String(16), nullable=False, server_default="2022"),
    )
    op.create_table(
        "account_balances",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "account_book_id",
            sa.Integer(),
            sa.ForeignKey("account_books.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("period_id", sa.Integer(), nullable=False),
        sa.Column("account_id", sa.Integer(), nullable=False),
        sa.Column("aux_key", sa.String(128), nullable=False, server_default=""),
        sa.Column("opening_debit", sa.Numeric(18, 2), nullable=False, server_default="0"),
        sa.Column("opening_credit", sa.Numeric(18, 2), nullable=False, server_default="0"),
        sa.Column("debit_total", sa.Numeric(18, 2), nullable=False, server_default="0"),
        sa.Column("credit_total", sa.Numeric(18, 2), nullable=False, server_default="0"),
        sa.Column("ending_debit", sa.Numeric(18, 2), nullable=False, server_default="0"),
        sa.Column("ending_credit", sa.Numeric(18, 2), nullable=False, server_default="0"),
        sa.UniqueConstraint("account_book_id", "id", name="uq_account_balance_book_id"),
        sa.UniqueConstraint(
            "account_book_id", "period_id", "account_id", "aux_key",
            name="uq_account_balance_scope",
        ),
        sa.ForeignKeyConstraint(
            ["account_book_id", "period_id"],
            ["accounting_periods.account_book_id", "accounting_periods.id"],
            name="fk_account_balance_period_same_book",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["account_book_id", "account_id"],
            ["accounts.account_book_id", "accounts.id"],
            name="fk_account_balance_account_same_book",
            ondelete="CASCADE",
        ),
        sa.CheckConstraint(
            "opening_debit >= 0 AND opening_credit >= 0 AND "
            "debit_total >= 0 AND credit_total >= 0 AND "
            "ending_debit >= 0 AND ending_credit >= 0",
            name="ck_account_balance_nonneg",
        ),
    )
    op.create_index(
        "ix_account_balances_account", "account_balances", ["account_book_id", "account_id"]
    )


def downgrade():
    op.drop_index("ix_account_balances_account", table_name="account_balances")
    op.drop_table("account_balances")
    op.drop_column("accounts", "subject_version")
