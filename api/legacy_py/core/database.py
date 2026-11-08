"""数据库连接：仅支持 PostgreSQL，必须通过 DATABASE_URL 显式配置。"""
import os
import shlex
from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.orm import declarative_base, sessionmaker

ROOT = Path(__file__).resolve().parents[2]


def _load_env_file(path: Path) -> None:
    """Load simple KEY=VALUE entries without overriding the process environment."""
    if not path.exists():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        key, sep, value = line.partition("=")
        key = key.strip()
        if not sep or not key:
            continue
        value = value.strip()
        if value and value[0] in {"'", '"'}:
            parsed = shlex.split(value)
            value = parsed[0] if parsed else ""
        os.environ.setdefault(key, value)


_load_env_file(ROOT / ".env")

DATA_DIR = ROOT / "data"
DATA_DIR.mkdir(exist_ok=True)


def _database_url() -> str:
    raw = (os.getenv("DATABASE_URL") or "").strip()
    if not raw:
        raise RuntimeError(
            "DATABASE_URL is required. SQLite is no longer supported; "
            "configure a PostgreSQL connection before starting the API."
        )
    if raw.startswith("sqlite"):
        raise RuntimeError(
            "SQLite is no longer supported. Configure PostgreSQL via DATABASE_URL."
        )
    # 兼容常见 PaaS 的 postgres:// 前缀，统一落到 psycopg3 驱动。
    if raw.startswith("postgres://"):
        raw = "postgresql+psycopg://" + raw[len("postgres://"):]
    elif raw.startswith("postgresql://"):
        raw = "postgresql+psycopg://" + raw[len("postgresql://"):]
    if not raw.startswith("postgresql"):
        raise RuntimeError("DATABASE_URL must point to PostgreSQL.")
    return raw


DB_URL = _database_url()


def _positive_int_env(name: str, default: int) -> int:
    raw = (os.getenv(name) or "").strip()
    try:
        value = int(raw) if raw else default
    except ValueError:
        value = default
    return max(value, 0)


engine = create_engine(
    DB_URL,
    pool_pre_ping=True,
    pool_size=max(_positive_int_env("DB_POOL_SIZE", 5), 1),
    max_overflow=_positive_int_env("DB_MAX_OVERFLOW", 10),
)


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
