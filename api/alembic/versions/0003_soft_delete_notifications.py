"""Stage2：项目软删除 + Stage3：站内通知表。"""
from alembic import op
import sqlalchemy as sa

revision = "0003_soft_delete_notifications"
down_revision = "0002_hot_indexes"
branch_labels = None
depends_on = None


def _has_column(table: str, col: str) -> bool:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    return col in [c["name"] for c in insp.get_columns(table)]


def _has_table(table: str) -> bool:
    bind = op.get_bind()
    return table in sa.inspect(bind).get_table_names()


def upgrade():
    if not _has_column("projects", "deleted_at"):
        op.add_column("projects", sa.Column("deleted_at", sa.DateTime(), nullable=True))
        op.create_index("ix_projects_deleted_at", "projects", ["deleted_at"])

    if not _has_table("notifications"):
        op.create_table(
            "notifications",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id"), nullable=False),
            sa.Column("type", sa.String(32)),
            sa.Column("title", sa.String(128), server_default=""),
            sa.Column("body", sa.Text(), server_default=""),
            sa.Column("channel", sa.String(16), server_default="inapp"),
            sa.Column("ref_type", sa.String(32), server_default=""),
            sa.Column("ref_id", sa.Integer(), nullable=True),
            sa.Column("project_id", sa.Integer(), sa.ForeignKey("projects.id"), nullable=True),
            sa.Column("dedup_key", sa.String(128)),
            sa.Column("read_at", sa.DateTime(), nullable=True),
            sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
        )
        op.create_index("ix_notifications_user_id", "notifications", ["user_id"])
        op.create_index("ix_notifications_type", "notifications", ["type"])
        op.create_index("ix_notifications_project_id", "notifications", ["project_id"])
        op.create_index("ix_notifications_dedup_key", "notifications", ["dedup_key"])
        op.create_index("ix_notifications_read_at", "notifications", ["read_at"])
        op.create_index("ix_notifications_created_at", "notifications", ["created_at"])
        op.create_index("ix_notif_user_read", "notifications", ["user_id", "read_at"])


def downgrade():
    # notifications and projects.deleted_at are part of the frozen 0001
    # baseline. This revision remains idempotent for databases that predate
    # the snapshot, so its downgrade must preserve those baseline objects.
    pass
