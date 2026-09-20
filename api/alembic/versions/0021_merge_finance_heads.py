"""合并认证与财务往来两条迁移 head，恢复单一生产迁移链。"""

revision = "0021_merge_finance_heads"
down_revision = ("0019_merge_auth_finance", "0020_fix_account_leaf_flags")
branch_labels = None
depends_on = None


def upgrade():
    pass


def downgrade():
    pass
