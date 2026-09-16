"""SQLite 单文件：WAL + busy_timeout 30s + 外键 ON。"""
from pathlib import Path
from sqlalchemy import create_engine, event
from sqlalchemy.orm import declarative_base, sessionmaker

ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = ROOT / "data"
DATA_DIR.mkdir(exist_ok=True)
DB_PATH = DATA_DIR / "app.db"
DB_URL = f"sqlite:///{DB_PATH}"

engine = create_engine(DB_URL, connect_args={"check_same_thread": False, "timeout": 30})


@event.listens_for(engine, "connect")
def _sqlite_pragmas(dbapi_conn, _record):
    cur = dbapi_conn.cursor()
    cur.execute("PRAGMA journal_mode=WAL;")
    cur.execute("PRAGMA busy_timeout=30000;")
    cur.execute("PRAGMA foreign_keys=ON;")
    cur.close()


SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)
Base = declarative_base()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def parse_date(v):
    """PATCH dict 入参的日期字符串转 date（空串→None）。"""
    from datetime import date as _date
    if v is None or v == "":
        return None
    if isinstance(v, str):
        return _date.fromisoformat(v)
    return v


# 项目全文检索（Stage 5）：trigram 分词器支持中文子串，要求查询词 ≥3 字符。
_FTS_DDL = [
    "CREATE VIRTUAL TABLE IF NOT EXISTS projects_fts USING fts5("
    "name, code, client, description, tokenize='trigram', "
    "content='projects', content_rowid='id')",
    """CREATE TRIGGER IF NOT EXISTS projects_ai AFTER INSERT ON projects BEGIN
         INSERT INTO projects_fts(rowid, name, code, client, description)
         VALUES (new.id, new.name, new.code, new.client, new.description);
       END""",
    """CREATE TRIGGER IF NOT EXISTS projects_ad AFTER DELETE ON projects BEGIN
         INSERT INTO projects_fts(projects_fts, rowid, name, code, client, description)
         VALUES ('delete', old.id, old.name, old.code, old.client, old.description);
       END""",
    """CREATE TRIGGER IF NOT EXISTS projects_au AFTER UPDATE ON projects BEGIN
         INSERT INTO projects_fts(projects_fts, rowid, name, code, client, description)
         VALUES ('delete', old.id, old.name, old.code, old.client, old.description);
         INSERT INTO projects_fts(rowid, name, code, client, description)
         VALUES (new.id, new.name, new.code, new.client, new.description);
       END""",
]


def ensure_fts(engine_) -> bool:
    """幂等创建 FTS5 全文检索表与触发器。环境不支持 FTS5/trigram 时返回 False（运行时回退 LIKE）。"""
    from sqlalchemy import text as _text

    with engine_.begin() as conn:
        for ddl in _FTS_DDL:
            try:
                conn.exec_driver_sql(ddl)
            except Exception:
                return False
    return True
