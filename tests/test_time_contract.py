"""时间口径回归（BLF-1138）：写库 / 读库 / 出参都不再依赖「当前时区」。

背景：31 个时间列是 `timestamp without time zone`，而写入历史给的是带时区的 UTC ——
PostgreSQL 按**会话时区**折算后落库，换库 / 改 `TZ` / 新环境默认 UTC 就会整体偏移 8 小时
且不报错；读取侧又把 naive 值贴回 UTC 标签，导致「配置 15 分钟的登录锁定」实际锁 8 小时 15 分。

本文件把三条不变量钉死（口径定义见 `api/core/timeutil.py`）：
  1. 列里存的是 `Asia/Shanghai` 墙钟，写入值 = 北京时间、**不是** UTC；
  2. 把 DB 会话 `TimeZone` 改成 `UTC` 重跑上传 / 列表 / 登录锁定，落库值与接口出参完全不变；
  3. 对外接口的时间字段一律带偏移量（`+08:00`），而 JWT `exp` 仍是 aware UTC（epoch 语义）。
"""
import os
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import sessionmaker

from api.core.database import get_db
from api.core.security import decode_token
from api.core.timeutil import APP_TZ, APP_TZ_NAME, app_now, app_now_aware, as_app
from api.main import app
from api.models import Attachment, Followup, SysParam, User

TEST_DATABASE_URL = (os.getenv("TEST_DATABASE_URL") or "").strip()

PASSWORDS = {"admin": "admin123456"}
PM_PASSWORD = "pm123456"


def login(client, username, pwd):
    r = client.post("/api/v1/auth/login",
                    json={"username": username, "password": PASSWORDS.get(username, pwd)})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


def pm(client):
    return login(client, "pm", PM_PASSWORD)


def mkproject(client, h, name="PTime"):
    r = client.post("/api/v1/projects", headers=h,
                    json={"name": name, "plan_start": "2026-01-01",
                          "plan_end": "2026-12-31", "budget_total": 10000})
    assert r.status_code == 200, r.text
    return r.json()


def upload(client, h, pid, name="t.png"):
    r = client.post(f"/api/v1/projects/{pid}/attachments", headers=h,
                    files={"file": (name, b"fakepng", "image/png")})
    assert r.status_code == 200, r.text
    return r.json()


class Probe:
    """直读列值的小工具：**绕开接口与 ORM 序列化**，只问「列里到底存了什么」。

    `db` fixture 给的是 Session 工厂（与既有测试一致），这里每次开一个短会话。
    """

    def __init__(self, session_factory):
        self._factory = session_factory

    def _scalar(self, stmt):
        session = self._factory()
        try:
            return session.execute(stmt).scalar()
        finally:
            session.close()

    def uploaded_at(self):
        return self._scalar(
            select(Attachment.uploaded_at).order_by(Attachment.id.desc()).limit(1))

    def remind_at(self):
        return self._scalar(
            select(Followup.remind_at).order_by(Followup.id.desc()).limit(1))

    def timezone(self):
        return self._scalar(select(func.current_setting("TimeZone")))

    def param(self, key):
        session = self._factory()
        try:
            return session.query(SysParam.value).filter_by(key=key).scalar()
        finally:
            session.close()

    def locked_until(self, username):
        session = self._factory()
        try:
            return session.query(User.locked_until).filter_by(username=username).scalar()
        finally:
            session.close()


def assert_beijing_wall_clock(stored):
    """落库值 = 北京时间墙钟（naive），且明显不是 UTC 瞬时。"""
    assert stored is not None
    assert stored.tzinfo is None, "时间列必须是无时区的墙钟值"
    beijing = app_now()
    utc_naive = datetime.now(timezone.utc).replace(tzinfo=None)
    assert abs((stored - beijing).total_seconds()) < 60, (stored, beijing)
    # 旧行为（UTC 瞬时直接落库）会让两者相差约 8 小时，这条断言就是那个 bug 的守卫
    assert abs((stored - utc_naive).total_seconds()) > 3600, (stored, utc_naive)


@pytest.fixture()
def env_utc(client, db):
    """同一 schema 上开两条会话：一条显式 `TimeZone=UTC`，一条显式 `TimeZone=Asia/Shanghai`。

    这是「换库 / 改 TZ / 新环境」的最小可复现形态：旧代码在 UTC 会话下会把 UTC 瞬时
    直接写进 naive 列（偏 8 小时），新代码必须与北京时会话完全一致。

    两条会话的时区都是**显式钉死**的，不继承服务端默认值 —— 部署的 PostgreSQL
    默认时区不受应用控制（本机 Homebrew 是 Asia/Shanghai，CI 的 postgres 容器和
    大多数托管库是 UTC）。断言环境配置而不只断言代码行为，会在应用完全正确时误报。
    """
    if not TEST_DATABASE_URL:
        pytest.skip("TEST_DATABASE_URL is not configured")
    session = db()
    try:
        schema = session.execute(select(func.current_schema())).scalar()
    finally:
        session.close()

    def make(tz):
        # 连接级 GUC 在**建立连接时**就生效：时区改成目标值，search_path 仍指向测试 schema。
        # 不用 connect 事件里 `SET search_path`（那条命令可能被连接回收时的 ROLLBACK 撤掉）。
        engine = create_engine(
            TEST_DATABASE_URL, pool_pre_ping=True,
            connect_args={"options": f"-c timezone={tz} -c search_path={schema}"},
        )
        return engine, sessionmaker(bind=engine, autoflush=False, autocommit=False)

    utc_engine, utc_sessionmaker = make("UTC")
    cn_engine, cn_sessionmaker = make(APP_TZ_NAME)

    def override():
        session = utc_sessionmaker()
        try:
            yield session
        finally:
            session.close()

    previous = app.dependency_overrides.get(get_db)
    app.dependency_overrides[get_db] = override
    try:
        yield SimpleNamespace(client=client, session=utc_sessionmaker,
                              baseline=cn_sessionmaker)
    finally:
        app.dependency_overrides.pop(get_db, None)
        if previous is not None:
            app.dependency_overrides[get_db] = previous
        utc_engine.dispose()
        cn_engine.dispose()


def test_uploaded_at_is_beijing_wall_clock(client, db):
    """列里存的是北京时间墙钟（naive），而不是 UTC 瞬时。"""
    h = pm(client)
    p = mkproject(client, h)
    upload(client, h, p["id"])
    assert_beijing_wall_clock(Probe(db).uploaded_at())


def test_uploaded_at_serialized_with_offset(client, db):
    """接口出参带明确偏移量，且与库里的墙钟值指向同一瞬时。"""
    h = pm(client)
    p = mkproject(client, h)
    upload(client, h, p["id"])

    r = client.get(f"/api/v1/projects/{p['id']}/attachments", headers=h)
    assert r.status_code == 200, r.text
    item = r.json()[0]
    assert item["uploaded_at"].endswith("+08:00"), item["uploaded_at"]

    parsed = datetime.fromisoformat(item["uploaded_at"])
    assert parsed.tzinfo is not None
    assert parsed.utcoffset() == timedelta(hours=8)
    assert parsed.replace(tzinfo=None) == Probe(db).uploaded_at()


def test_write_and_output_unchanged_under_utc_db_session(env_utc):
    """DB 会话时区改成 UTC，落库值与接口出参都不变（核心不变量）。"""
    # 对照组的时区由 fixture 显式钉成 Asia/Shanghai，所以这条断言校验的是「两条会话
    # 确实处在不同时区」——即本测试没有退化成 `test_uploaded_at_is_beijing_wall_clock`
    # 的重复。若这里也钉成 UTC，断言会立刻失败，正是要防的空洞化。
    assert Probe(env_utc.baseline).timezone() == APP_TZ_NAME
    assert Probe(env_utc.session).timezone() == "UTC"

    h = pm(env_utc.client)
    p = mkproject(env_utc.client, h, "PTimeUtc")
    upload(env_utc.client, h, p["id"])

    # 用 UTC 会话自己读：列里的值仍必须是北京时间墙钟
    assert_beijing_wall_clock(Probe(env_utc.session).uploaded_at())
    # 接口出参同样不变
    r = env_utc.client.get(f"/api/v1/projects/{p['id']}/attachments", headers=h)
    assert r.json()[0]["uploaded_at"].endswith("+08:00")


def test_login_lock_duration_is_configured_minutes(client, db):
    """锁定 15 分钟就真的是 15 分钟（修复前库里的 naive 值被当作 UTC，实际锁 8h15m）。"""
    probe = Probe(db)
    limit = int(probe.param("login_fail_limit"))
    minutes = int(probe.param("login_lock_minutes"))
    assert (limit, minutes) == (5, 15)

    for _ in range(limit):
        r = client.post("/api/v1/auth/login",
                        json={"username": "pm", "password": "wrong-password"})
        assert r.status_code == 401, r.text

    locked_until = probe.locked_until("pm")
    assert locked_until is not None and locked_until.tzinfo is None
    remaining = as_app(locked_until) - app_now_aware()
    # 15 分钟上下（留 1 分钟给请求耗时），且远小于旧行为的 8h15m
    assert timedelta(minutes=13, seconds=30) <= remaining <= timedelta(minutes=16), remaining

    # 锁定期间即使密码正确也进不去
    r = client.post("/api/v1/auth/login",
                    json={"username": "pm", "password": PM_PASSWORD})
    assert r.status_code == 403, r.text


def test_jwt_exp_stays_aware_utc(client):
    """JWT `exp` 是 epoch 语义，必须继续是 aware UTC（不能被「顺手统一」成北京时间）。"""
    r = client.post("/api/v1/auth/login",
                    json={"username": "pm", "password": PM_PASSWORD})
    exp = decode_token(r.json()["access_token"])["exp"]
    now = datetime.now(timezone.utc).timestamp()
    assert abs((exp - now) - 8 * 60 * 60) < 120, (exp, now)


def test_followup_remind_at_with_offset_converts_to_beijing(client, db):
    """入参带偏移（`Z`）时按瞬时折算成北京时间墙钟，不让 PG 二次折算。"""
    h = pm(client)
    p = mkproject(client, h, "PTimeFollow")

    r = client.post(f"/api/v1/projects/{p['id']}/followups", headers=h,
                    json={"content": "带偏移的提醒", "remind_at": "2026-09-18T09:00:00Z"})
    assert r.status_code == 200, r.text
    assert Probe(db).remind_at() == datetime(2026, 9, 18, 17, 0, 0)

    rows = client.get(f"/api/v1/projects/{p['id']}/followups", headers=h).json()["items"]
    assert rows[0]["remind_at"] == "2026-09-18T17:00:00+08:00", rows[0]["remind_at"]


def test_naive_input_is_treated_as_beijing(client, db):
    """不带偏移的入参按「已经是北京时间」处理，不做任何折算。"""
    h = pm(client)
    p = mkproject(client, h, "PTimeNaive")

    r = client.post(f"/api/v1/projects/{p['id']}/followups", headers=h,
                    json={"content": "本地时间", "remind_at": "2026-09-19T08:30:00"})
    assert r.status_code == 200, r.text
    assert Probe(db).remind_at() == datetime(2026, 9, 19, 8, 30, 0)


def test_offset_serialization_across_endpoints(client):
    """「对外接口一律带偏移」不只是一处：任务与填报历史同样带 `+08:00`。"""
    h = pm(client)
    p = mkproject(client, h, "PTimeMany")
    t = client.post("/api/v1/tasks", headers=h,
                    json={"project_id": p["id"], "name": "时间口径任务"})
    assert t.status_code == 200, t.text
    tid = t.json()["id"]

    r = client.post("/api/v1/progress-logs", headers=h,
                    json={"task_id": tid, "progress": 30, "note": "带时间出参"})
    assert r.status_code == 200, r.text

    task = client.get(f"/api/v1/tasks?project_id={p['id']}", headers=h).json()["items"][0]
    assert task["created_at"].endswith("+08:00"), task["created_at"]
    log = client.get(f"/api/v1/progress-logs?task_id={tid}", headers=h).json()["items"][0]
    assert log["created_at"].endswith("+08:00"), log["created_at"]


def test_notification_sync_stamp_roundtrips_with_offset(client, db):
    """通知节流戳：带偏移写入、读出仍能算出正确的节流窗口。"""
    h = pm(client)
    mkproject(client, h, "PTimeNotify")
    assert client.get("/api/v1/notifications", headers=h).status_code == 200

    stamp = Probe(db).param("notifications_synced_at")
    assert stamp is not None and stamp.endswith("+08:00"), stamp
    # 能解析回 aware，且与"现在"同刻（说明写读口径一致，节流窗口不会算错）
    parsed = as_app(datetime.fromisoformat(stamp))
    assert abs((app_now_aware() - parsed).total_seconds()) < 60, parsed

    # 第二次读取走节流分支（不重算），仍应正常返回
    assert client.get("/api/v1/notifications", headers=h).status_code == 200


def test_timeutil_contract_helpers():
    """口径模块自身的行为：naive↔aware↔DB 的换算方向都是对的。"""
    assert app_now().tzinfo is None
    assert app_now_aware().utcoffset() == timedelta(hours=8)
    assert as_app(datetime(2026, 9, 18, 9, 0)).utcoffset() == timedelta(hours=8)
    # aware UTC 09:00 == 北京时间 17:00
    assert as_app(datetime(2026, 9, 18, 9, 0, tzinfo=timezone.utc)) == \
        datetime(2026, 9, 18, 17, 0, tzinfo=APP_TZ)
    assert as_app(None) is None
