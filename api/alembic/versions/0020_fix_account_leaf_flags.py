"""修正无子科目科目的末级标记，保证应收应付等明细科目可记账。"""

from alembic import op

revision = "0020_fix_account_leaf_flags"
down_revision = "0019_finance_arap"
branch_labels = None
depends_on = None


def upgrade():
    op.execute(
        """
        UPDATE accounts AS account
        SET is_leaf = NOT EXISTS (
            SELECT 1 FROM accounts AS child WHERE child.parent_id = account.id
        )
        """
    )


def downgrade():
    pass
