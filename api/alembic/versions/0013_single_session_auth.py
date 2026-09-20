"""为用户增加单账号单会话版本号。"""

import sqlalchemy as sa

from alembic import op

revision = "0013_single_session_auth"
down_revision = "0012_partners"
branch_labels = None
depends_on = None


def _has_column(table: str, column: str) -> bool:
    return column in {item["name"] for item in sa.inspect(op.get_bind()).get_columns(table)}


def upgrade():
    if not _has_column("users", "session_version"):
        op.add_column(
            "users",
            sa.Column("session_version", sa.Integer(), nullable=False, server_default="0"),
        )


def downgrade():
    if _has_column("users", "session_version"):
        op.drop_column("users", "session_version")
