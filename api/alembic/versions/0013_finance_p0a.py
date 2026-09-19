"""P0-A 财务账套、期间、科目、期初及辅助核算底座。

所有财务主数据按 account_book_id 隔离；金额使用 NUMERIC(18,2)。
"""

import sqlalchemy as sa

from alembic import op

revision = "0013_finance_p0a"
down_revision = "0012_partners"
branch_labels = None
depends_on = None


def _has_table(name: str) -> bool:
    return name in sa.inspect(op.get_bind()).get_table_names()


def upgrade():
    if not _has_table("account_books"):
        op.create_table(
            "account_books",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("code", sa.String(32), nullable=False),
            sa.Column("name", sa.String(128), nullable=False),
            sa.Column(
                "base_currency", sa.String(3), nullable=False, server_default="CNY"
            ),
            sa.Column(
                "currencies", sa.JSON(), nullable=False, server_default='["CNY"]'
            ),
            sa.Column(
                "fiscal_year_start",
                sa.String(5),
                nullable=False,
                server_default="01-01",
            ),
            sa.Column("status", sa.String(16), nullable=False, server_default="active"),
            sa.Column("created_by", sa.Integer(), sa.ForeignKey("users.id")),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.CheckConstraint(
                "status IN ('active','archived')", name="ck_book_status"
            ),
            sa.CheckConstraint("base_currency ~ '^[A-Z]{3}$'", name="ck_book_currency"),
        )
        op.create_index("ix_account_books_code", "account_books", ["code"], unique=True)

    if not _has_table("account_book_members"):
        op.create_table(
            "account_book_members",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column(
                "account_book_id",
                sa.Integer(),
                sa.ForeignKey("account_books.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column(
                "user_id",
                sa.Integer(),
                sa.ForeignKey("users.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column("role", sa.String(32), nullable=False, server_default="member"),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.UniqueConstraint("account_book_id", "user_id", name="uq_book_member"),
        )
        op.create_index("ix_book_members_user", "account_book_members", ["user_id"])

    if not _has_table("accounting_periods"):
        op.create_table(
            "accounting_periods",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column(
                "account_book_id",
                sa.Integer(),
                sa.ForeignKey("account_books.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column("year", sa.Integer(), nullable=False),
            sa.Column("month", sa.Integer(), nullable=False),
            sa.Column("period_index", sa.Integer(), nullable=False),
            sa.Column(
                "is_adjustment", sa.Boolean(), nullable=False, server_default=sa.false()
            ),
            sa.Column("status", sa.String(16), nullable=False, server_default="open"),
            sa.Column("start_date", sa.Date(), nullable=False),
            sa.Column("end_date", sa.Date(), nullable=False),
            sa.Column("closed_by", sa.Integer(), sa.ForeignKey("users.id")),
            sa.Column("closed_at", sa.DateTime()),
            sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
            sa.UniqueConstraint(
                "account_book_id", "year", "month", name="uq_period_book_year_month"
            ),
            sa.UniqueConstraint(
                "account_book_id", "period_index", name="uq_period_book_index"
            ),
            sa.CheckConstraint("month BETWEEN 1 AND 13", name="ck_period_month"),
            sa.CheckConstraint(
                "(month = 13) = is_adjustment", name="ck_period_adjustment"
            ),
            sa.CheckConstraint("start_date <= end_date", name="ck_period_range"),
            sa.CheckConstraint(
                "status IN ('open','closed','locked')", name="ck_period_status"
            ),
        )
        op.create_index(
            "ix_periods_book_status",
            "accounting_periods",
            ["account_book_id", "status"],
        )

    if not _has_table("accounts"):
        op.create_table(
            "accounts",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column(
                "account_book_id",
                sa.Integer(),
                sa.ForeignKey("account_books.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column("code", sa.String(32), nullable=False),
            sa.Column("name", sa.String(128), nullable=False),
            sa.Column("level", sa.Integer(), nullable=False),
            sa.Column("parent_id", sa.Integer(), nullable=True),
            sa.Column("direction", sa.String(1), nullable=False),
            sa.Column("category", sa.String(16), nullable=False),
            sa.Column("aux_flags", sa.JSON(), nullable=False, server_default="{}"),
            sa.Column(
                "is_leaf", sa.Boolean(), nullable=False, server_default=sa.true()
            ),
            sa.Column(
                "is_active", sa.Boolean(), nullable=False, server_default=sa.true()
            ),
            sa.UniqueConstraint("account_book_id", "id", name="uq_accounts_book_id"),
            sa.UniqueConstraint("account_book_id", "code", name="uq_account_book_code"),
            sa.ForeignKeyConstraint(
                ["account_book_id", "parent_id"],
                ["accounts.account_book_id", "accounts.id"],
                name="fk_accounts_parent_same_book",
            ),
            sa.CheckConstraint("level BETWEEN 1 AND 4", name="ck_account_level"),
            sa.CheckConstraint("direction IN ('D','C')", name="ck_account_direction"),
            sa.CheckConstraint(
                "category IN ('资产','负债','权益','成本','损益')",
                name="ck_account_category",
            ),
            sa.CheckConstraint(
                "code ~ '^[0-9]{4}([0-9]{2}){0,3}$'", name="ck_account_code"
            ),
            sa.CheckConstraint(
                "jsonb_typeof(aux_flags::jsonb) = 'object'", name="ck_account_aux_flags"
            ),
        )
        op.create_index("ix_accounts_account_book_id", "accounts", ["account_book_id"])
        op.create_index(
            "ix_accounts_book_parent", "accounts", ["account_book_id", "parent_id"]
        )

    if not _has_table("opening_balances"):
        op.create_table(
            "opening_balances",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column(
                "account_book_id",
                sa.Integer(),
                sa.ForeignKey("account_books.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column("account_id", sa.Integer(), nullable=False),
            sa.Column("aux_key", sa.String(128), nullable=False, server_default=""),
            sa.Column("aux_detail", sa.JSON(), nullable=False, server_default="{}"),
            sa.Column("debit", sa.Numeric(18, 2), nullable=False, server_default="0"),
            sa.Column("credit", sa.Numeric(18, 2), nullable=False, server_default="0"),
            sa.UniqueConstraint(
                "account_book_id",
                "account_id",
                "aux_key",
                name="uq_opening_book_account_aux",
            ),
            sa.ForeignKeyConstraint(
                ["account_book_id", "account_id"],
                ["accounts.account_book_id", "accounts.id"],
                name="fk_opening_account_same_book",
            ),
            sa.CheckConstraint("debit >= 0 AND credit >= 0", name="ck_opening_nonneg"),
            sa.CheckConstraint(
                "NOT (debit > 0 AND credit > 0)", name="ck_opening_one_side"
            ),
        )
        op.create_index(
            "ix_opening_balances_account_book_id",
            "opening_balances",
            ["account_book_id"],
        )

    if not _has_table("auxiliary_items"):
        op.create_table(
            "auxiliary_items",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column(
                "account_book_id",
                sa.Integer(),
                sa.ForeignKey("account_books.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column("kind", sa.String(16), nullable=False),
            sa.Column("code", sa.String(64), nullable=False),
            sa.Column("name", sa.String(128), nullable=False),
            sa.Column("metadata", sa.JSON(), nullable=False, server_default="{}"),
            sa.Column(
                "is_active", sa.Boolean(), nullable=False, server_default=sa.true()
            ),
            sa.Column("created_at", sa.DateTime(), nullable=False),
            sa.UniqueConstraint(
                "account_book_id", "kind", "code", name="uq_aux_book_kind_code"
            ),
            sa.UniqueConstraint(
                "account_book_id", "id", name="uq_auxiliary_items_book_id"
            ),
            sa.CheckConstraint(
                "kind IN ('customer','vendor','department','employee','project','cashflow')",
                name="ck_aux_kind",
            ),
        )
        op.create_index(
            "ix_auxiliary_items_account_book_id", "auxiliary_items", ["account_book_id"]
        )

    if not _has_table("account_auxiliaries"):
        op.create_table(
            "account_auxiliaries",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column(
                "account_book_id",
                sa.Integer(),
                sa.ForeignKey("account_books.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column("account_id", sa.Integer(), nullable=False),
            sa.Column("auxiliary_item_id", sa.Integer(), nullable=False),
            sa.UniqueConstraint(
                "account_book_id", "id", name="uq_account_auxiliaries_book_id"
            ),
            sa.ForeignKeyConstraint(
                ["account_book_id", "account_id"],
                ["accounts.account_book_id", "accounts.id"],
                name="fk_account_auxiliary_account_same_book",
                ondelete="CASCADE",
            ),
            sa.ForeignKeyConstraint(
                ["account_book_id", "auxiliary_item_id"],
                ["auxiliary_items.account_book_id", "auxiliary_items.id"],
                name="fk_account_auxiliary_item_same_book",
                ondelete="CASCADE",
            ),
            sa.UniqueConstraint(
                "account_book_id",
                "account_id",
                "auxiliary_item_id",
                name="uq_account_auxiliary_link",
            ),
        )
        op.create_index(
            "ix_account_auxiliary_book", "account_auxiliaries", ["account_book_id"]
        )


def downgrade():
    for table in (
        "account_auxiliaries",
        "auxiliary_items",
        "opening_balances",
        "accounts",
        "accounting_periods",
        "account_book_members",
        "account_books",
    ):
        if _has_table(table):
            op.drop_table(table)
