"""合并认证与财务两条迁移分支。"""

revision = "0019_merge_auth_and_finance_heads"
down_revision = ("0013_single_session_auth", "0018_finance_fixed_assets")
branch_labels = None
depends_on = None


def upgrade():
    pass


def downgrade():
    pass
