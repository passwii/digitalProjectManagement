"""Stage5 全文检索迁移占位。

项目已停止支持 SQLite，原 FTS5 对象不再创建；PostgreSQL 当前使用模糊匹配。
保留此 revision 以维持既有数据库的 Alembic 迁移链连续。
"""

revision = "0004_project_fts"
down_revision = "0003_soft_delete_notifications"
branch_labels = None
depends_on = None


def upgrade():
    pass


def downgrade():
    pass
