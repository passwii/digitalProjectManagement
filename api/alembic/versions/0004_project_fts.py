"""Stage5：项目全文检索（FTS5 trigram + 触发器）。

注意（已实测）：FTS5 默认 unicode61 分词器不切分中文，MATCH 全部落空；
trigram 分词器可支持中文子串检索，但要求查询词 ≥3 字符。
因此实现为混合策略：
  · 关键词 ≥3 字符 → 走 FTS5 trigram（命中快、带高亮片段）
  · 关键词 1-2 字符 → 回退 LIKE（trigram 无法覆盖，LIKE 在分页+索引下足够）
  · FTS5 不可用环境 → 全部回退 LIKE
"""
from alembic import op
import sqlalchemy as sa

revision = "0004_project_fts"
down_revision = "0003_soft_delete_notifications"
branch_labels = None
depends_on = None


def _rebuild_triggers(bind):
    for name in ("projects_ai", "projects_ad", "projects_au"):
        bind.exec_driver_sql(f"DROP TRIGGER IF EXISTS {name}")
    bind.exec_driver_sql("""
        CREATE TRIGGER IF NOT EXISTS projects_ai AFTER INSERT ON projects BEGIN
          INSERT INTO projects_fts(rowid, name, code, client, description)
          VALUES (new.id, new.name, new.code, new.client, new.description);
        END
    """)
    bind.exec_driver_sql("""
        CREATE TRIGGER IF NOT EXISTS projects_ad AFTER DELETE ON projects BEGIN
          INSERT INTO projects_fts(projects_fts, rowid, name, code, client, description)
          VALUES ('delete', old.id, old.name, old.code, old.client, old.description);
        END
    """)
    bind.exec_driver_sql("""
        CREATE TRIGGER IF NOT EXISTS projects_au AFTER UPDATE ON projects BEGIN
          INSERT INTO projects_fts(projects_fts, rowid, name, code, client, description)
          VALUES ('delete', old.id, old.name, old.code, old.client, old.description);
          INSERT INTO projects_fts(rowid, name, code, client, description)
          VALUES (new.id, new.name, new.code, new.client, new.description);
        END
    """)


def upgrade():
    bind = op.get_bind()
    if bind.dialect.name != "sqlite":
        return  # PostgreSQL 等数据库使用普通 LIKE 检索，不创建 SQLite FTS5 对象
    bind.exec_driver_sql("DROP TABLE IF EXISTS projects_fts")
    try:
        bind.exec_driver_sql(
            "CREATE VIRTUAL TABLE projects_fts USING fts5("
            "name, code, client, description, tokenize='trigram', "
            "content='projects', content_rowid='id')"
        )
    except Exception:
        return  # 环境不支持 FTS5/trigram：运行时自动回退 LIKE
    _rebuild_triggers(bind)
    # 存量数据回填
    bind.exec_driver_sql("""
        INSERT INTO projects_fts(rowid, name, code, client, description)
        SELECT id, name, code, client, description FROM projects
    """)


def downgrade():
    bind = op.get_bind()
    if bind.dialect.name != "sqlite":
        return
    for name in ("projects_ai", "projects_ad", "projects_au"):
        bind.exec_driver_sql(f"DROP TRIGGER IF EXISTS {name}")
    bind.exec_driver_sql("DROP TABLE IF EXISTS projects_fts")
