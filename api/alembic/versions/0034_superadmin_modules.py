"""Introduce an explicit, single super-admin identity and remove legacy grants."""

import sqlalchemy as sa
from alembic import op

revision = "0034_superadmin_modules"
down_revision = "0033_project_receivable_updaters"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "users",
        sa.Column("is_super_admin", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.execute("UPDATE users SET is_super_admin = true WHERE username = '15796280534'")
    op.create_index(
        "uq_users_single_super_admin", "users", ["is_super_admin"],
        unique=True, postgresql_where=sa.text("is_super_admin = true"),
    )
    op.execute(
        "DELETE FROM user_roles "
        "WHERE user_id IN (SELECT id FROM users WHERE username <> '15796280534') "
        "AND role_id IN (SELECT id FROM roles WHERE code = 'admin')"
    )
    op.execute(
        "DELETE FROM user_modules "
        "WHERE user_id IN (SELECT id FROM users WHERE username <> '15796280534') "
        "AND module = 'admin'"
    )


def downgrade():
    op.drop_index("uq_users_single_super_admin", table_name="users")
    op.drop_column("users", "is_super_admin")
