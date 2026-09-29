"""Shared PostgreSQL test fixtures.

Tests require an isolated PostgreSQL database through ``TEST_DATABASE_URL``.
They create a temporary schema per fixture and remove it afterwards.
"""
import os
import sys
import tempfile
import uuid
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event, text
from sqlalchemy.orm import sessionmaker

TEST_DATABASE_URL = (os.getenv("TEST_DATABASE_URL") or "").strip()
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

# 附件存储（BLF-1136）：测试固定用**本地临时暂存**后端——不触网、不需要 R2 凭据，
# 也不往应用目录写文件。显式赋值（而非 setdefault）：避免开发机导出了真实 R2 凭据时
# 测试跑去碰真实桶。用例需要验证 r2 / auto 行为时用 monkeypatch 局部覆盖。
os.environ["STORAGE_BACKEND"] = "local"
os.environ["APP_ENV"] = "test"
os.environ.setdefault(
    "STORAGE_LOCAL_ROOT", tempfile.mkdtemp(prefix="pm-test-staging-")
)

if not TEST_DATABASE_URL:
    if os.getenv("CI"):
        # CI 里缺这个变量必须**响亮地失败**，不能往下走。
        # 往下走的后果实测过：`pytest tests -q` 输出 52 passed / 230 skipped、
        # 耗时 0.31s、退出码 0 —— 282 个用例里 82% 根本没执行，套件却判绿。
        # 本地随手跑（没配库就跳过）仍然方便，但 CI 上「跳过」和「通过」必须区分开，
        # 否则这条 CI 守的就不是门，是空气。
        raise RuntimeError(
            "CI 环境下必须设置 TEST_DATABASE_URL。未设置时 conftest 的 db fixture "
            "会静默跳过依赖数据库的用例（约 82%），导致套件在几乎没跑的情况下判绿。"
        )
    # api.main imports the database module at collection time. Keep that import
    # non-connecting; fixtures below skip when no real test database is set.
    os.environ.setdefault("DATABASE_URL", "postgresql+psycopg://test:test@localhost/test")
else:
    os.environ["DATABASE_URL"] = TEST_DATABASE_URL

from api.core.database import Base, get_db  # noqa: E402
from api.core.security import hash_password  # noqa: E402
from api.main import app  # noqa: E402


def _make_schema_engine(schema: str):
    engine = create_engine(TEST_DATABASE_URL, pool_pre_ping=True)

    @event.listens_for(engine, "connect")
    def _set_search_path(dbapi_conn, _record):
        cur = dbapi_conn.cursor()
        cur.execute(f'SET search_path TO "{schema}"')
        cur.close()

    return engine


@pytest.fixture()
def db():
    if not TEST_DATABASE_URL:
        pytest.skip("TEST_DATABASE_URL is not configured")

    schema = f"test_{uuid.uuid4().hex[:12]}"
    admin_engine = create_engine(TEST_DATABASE_URL, pool_pre_ping=True)
    with admin_engine.begin() as conn:
        conn.execute(text(f'CREATE SCHEMA "{schema}"'))

    engine = _make_schema_engine(schema)
    Base.metadata.create_all(bind=engine)
    TestingSession = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    session = TestingSession()
    try:
        from api.models import Department, Role, SysParam, User, UserRole

        dept = Department(name="综合部")
        session.add(dept)
        session.flush()
        for code, name in [
            ("admin", "系统管理员"),
            ("project_manager", "项目负责人"),
            ("member", "项目成员"),
            ("cost_admin", "成本管理员"),
            ("dept_manager", "部门负责人"),
            ("executive", "高层（只读）"),
        ]:
            session.add(Role(code=code, name=name))
        session.flush()
        for key, value in {
            "login_fail_limit": "5",
            "login_lock_minutes": "15",
            "budget_warn_rate": "0.8",
            "budget_approval_on": "0",
            "expense_approval_on": "0",
            "milestone_warn_days": "3",
            "stagnant_days": "7",
            "notify_dedup_days": "1",
        }.items():
            session.add(SysParam(key=key, value=value))

        def mk(username: str, password: str, roles: list[str]):
            user = User(
                username=username,
                pwd_hash=hash_password(password),
                real_name=username,
                dept_id=dept.id,
            )
            session.add(user)
            session.flush()
            for code in roles:
                role = session.query(Role).filter_by(code=code).first()
                session.add(UserRole(user_id=user.id, role_id=role.id))

        mk("admin", "admin123456", ["admin"])
        mk("pm", "pm123456", ["project_manager", "member"])
        mk("outsider", "out123456", ["member"])
        mk("cost", "cost123456", ["cost_admin"])
        mk("exec", "exec123456", ["executive"])
        mk("deptm", "deptm123456", ["dept_manager", "member"])
        session.commit()
    finally:
        session.close()

    def override():
        test_session = TestingSession()
        try:
            yield test_session
        finally:
            test_session.close()

    app.dependency_overrides[get_db] = override
    yield TestingSession
    app.dependency_overrides.clear()
    engine.dispose()
    with admin_engine.begin() as conn:
        conn.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
    admin_engine.dispose()


@pytest.fixture()
def client(db):
    return TestClient(app)
