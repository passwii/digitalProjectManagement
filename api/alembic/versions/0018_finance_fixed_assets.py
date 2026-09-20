"""P1-D：固定资产卡片和折旧记录。"""

import sqlalchemy as sa
from alembic import op

revision = "0018_finance_fixed_assets"
down_revision = "0017_finance_cashier"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "fixed_assets",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("account_book_id", sa.Integer(), sa.ForeignKey("account_books.id", ondelete="CASCADE"), nullable=False),
        sa.Column("code", sa.String(64), nullable=False),
        sa.Column("name", sa.String(128), nullable=False),
        sa.Column("category", sa.String(64), nullable=False, server_default=""),
        sa.Column("acquisition_date", sa.Date(), nullable=False),
        sa.Column("original_cost", sa.Numeric(18, 2), nullable=False),
        sa.Column("residual_rate", sa.Numeric(8, 6), nullable=False, server_default="0"),
        sa.Column("useful_life_months", sa.Integer(), nullable=False),
        sa.Column("asset_account_id", sa.Integer(), nullable=False),
        sa.Column("depreciation_account_id", sa.Integer(), nullable=False),
        sa.Column("expense_account_id", sa.Integer(), nullable=False),
        sa.Column("accumulated_depreciation", sa.Numeric(18, 2), nullable=False, server_default="0"),
        sa.Column("status", sa.String(16), nullable=False, server_default="active"),
        sa.Column("created_by", sa.Integer(), sa.ForeignKey("users.id")),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("account_book_id", "code", name="uq_fixed_asset_book_code"),
        sa.UniqueConstraint("account_book_id", "id", name="uq_fixed_asset_book_id"),
        sa.CheckConstraint("original_cost > 0", name="ck_fixed_asset_cost"),
        sa.CheckConstraint("residual_rate >= 0 AND residual_rate < 1", name="ck_fixed_asset_residual_rate"),
        sa.CheckConstraint("useful_life_months > 0", name="ck_fixed_asset_life"),
        sa.CheckConstraint("status IN ('active','disposed')", name="ck_fixed_asset_status"),
        sa.ForeignKeyConstraint(["account_book_id", "asset_account_id"], ["accounts.account_book_id", "accounts.id"], name="fk_fixed_asset_asset_account"),
        sa.ForeignKeyConstraint(["account_book_id", "depreciation_account_id"], ["accounts.account_book_id", "accounts.id"], name="fk_fixed_asset_depreciation_account"),
        sa.ForeignKeyConstraint(["account_book_id", "expense_account_id"], ["accounts.account_book_id", "accounts.id"], name="fk_fixed_asset_expense_account"),
    )
    op.create_table(
        "asset_depreciations",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("account_book_id", sa.Integer(), sa.ForeignKey("account_books.id", ondelete="CASCADE"), nullable=False),
        sa.Column("asset_id", sa.Integer(), sa.ForeignKey("fixed_assets.id", ondelete="CASCADE"), nullable=False),
        sa.Column("period_id", sa.Integer(), nullable=False),
        sa.Column("amount", sa.Numeric(18, 2), nullable=False),
        sa.Column("voucher_id", sa.Integer(), sa.ForeignKey("vouchers.id")),
        sa.Column("created_by", sa.Integer(), sa.ForeignKey("users.id")),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("account_book_id", "asset_id", "period_id", name="uq_asset_depreciation_period"),
        sa.ForeignKeyConstraint(["account_book_id", "asset_id"], ["fixed_assets.account_book_id", "fixed_assets.id"], name="fk_asset_depreciation_asset_same_book", ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["account_book_id", "period_id"], ["accounting_periods.account_book_id", "accounting_periods.id"], name="fk_asset_depreciation_period_same_book", ondelete="CASCADE"),
        sa.CheckConstraint("amount > 0", name="ck_asset_depreciation_amount"),
    )
    op.create_index("ix_fixed_assets_book_status", "fixed_assets", ["account_book_id", "status"])


def downgrade():
    op.drop_index("ix_fixed_assets_book_status", table_name="fixed_assets")
    op.drop_table("asset_depreciations")
    op.drop_table("fixed_assets")
