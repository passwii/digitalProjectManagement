"""补齐凭证分录的账套隔离约束。"""

import sqlalchemy as sa
from alembic import op

revision = "0016_finance_entry_book_scope"
down_revision = "0015_finance_vouchers"
branch_labels = None
depends_on = None


def upgrade():
    inspector = sa.inspect(op.get_bind())
    for constraint in inspector.get_foreign_keys("voucher_entries"):
        if constraint.get("constrained_columns") == ["account_id"] and constraint.get("referred_table") == "accounts":
            op.drop_constraint(constraint["name"], "voucher_entries", type_="foreignkey")
    op.add_column("voucher_entries", sa.Column("account_book_id", sa.Integer(), nullable=True))
    op.execute(
        """
        UPDATE voucher_entries AS entry
        SET account_book_id = voucher.account_book_id
        FROM vouchers AS voucher
        WHERE entry.voucher_id = voucher.id
        """
    )
    op.alter_column("voucher_entries", "account_book_id", nullable=False)
    op.create_foreign_key(
        "fk_voucher_entry_voucher_same_book", "voucher_entries", "vouchers",
        ["account_book_id", "voucher_id"], ["account_book_id", "id"], ondelete="CASCADE"
    )
    op.create_foreign_key(
        "fk_voucher_entry_account_same_book", "voucher_entries", "accounts",
        ["account_book_id", "account_id"], ["account_book_id", "id"]
    )


def downgrade():
    op.drop_constraint("fk_voucher_entry_account_same_book", "voucher_entries", type_="foreignkey")
    op.drop_constraint("fk_voucher_entry_voucher_same_book", "voucher_entries", type_="foreignkey")
    op.drop_column("voucher_entries", "account_book_id")
