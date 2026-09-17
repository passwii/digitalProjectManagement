"""Shared PostgreSQL test fixtures.

Tests require an isolated PostgreSQL database through ``TEST_DATABASE_URL``.
They create a temporary schema per fixture and remove it afterwards.
"""
import os
import sys
import uuid
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event, text
from sqlalchemy.orm import sessionmaker

TEST_DATABASE_URL = (os.getenv("TEST_DATABASE_URL") or "").strip()
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
if not TEST_DATABASE_URL:
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
