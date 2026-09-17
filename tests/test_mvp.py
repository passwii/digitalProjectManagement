"""MVP 验收 pytest（Stage1-4）：≥10 用例，未登录 401 必测。隔离库：tmp sqlite + dependency_overrides。"""
import io
from threading import Barrier, Thread
from datetime import date, datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from jose import jwt
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from api.core.config import settings
from api.core.database import Base, ensure_fts, get_db
from api.core.security import ALGORITHM, SECRET_KEY, hash_password
from api.main import app


@pytest.fixture()
def db(tmp_path):
    url = f"sqlite:///{tmp_path}/t.db"
    eng = create_engine(url, connect_args={"check_same_thread": False})
    TestingSession = sessionmaker(bind=eng, autoflush=False, autocommit=False)
    Base.metadata.create_all(bind=eng)
    ensure_fts(eng)  # 与生产一致：FTS5 trigram（不支持时静默回退 LIKE）
    s = TestingSession()
    try:
        from api.models import Department, Role, SysParam, User, UserRole
        d = Department(name="综合部")
        s.add(d)
        s.flush()
        for code, name in [("admin", "系统管理员"), ("project_manager", "项目负责人"),
                           ("member", "项目成员"), ("cost_admin", "成本管理员"),
                           ("dept_manager", "部门负责人"),
                           ("executive", "高层（只读）")]:
            s.add(Role(code=code, name=name))
        s.flush()
        for k, v in {"login_fail_limit": "5", "login_lock_minutes": "15",
                     "budget_warn_rate": "0.8", "budget_approval_on": "0",
                     "expense_approval_on": "0", "milestone_warn_days": "3",
                     "stagnant_days": "7"}.items():
            s.add(SysParam(key=k, value=v))

        def mk(username, pwd, roles):
            u = User(username=username, pwd_hash=hash_password(pwd),
                     real_name=username, dept_id=d.id)
            s.add(u)
            s.flush()
            for c in roles:
                r = s.query(Role).filter_by(code=c).first()
                s.add(UserRole(user_id=u.id, role_id=r.id))
            return u
        mk("admin", "admin123456", ["admin"])
        mk("pm", "pm123456", ["project_manager", "member"])
        mk("outsider", "out123456", ["member"])
        mk("cost", "cost123456", ["cost_admin"])
        mk("exec", "exec123456", ["executive"])
        mk("deptm", "deptm123456", ["dept_manager", "member"])
        s.commit()
    finally:
        s.close()

    def override():
        sess = TestingSession()
        try:
            yield sess
        finally:
            sess.close()
    app.dependency_overrides[get_db] = override
    yield TestingSession
    app.dependency_overrides.clear()


@pytest.fixture()
def client(db):
    return TestClient(app)


PASSWORDS = {"admin": "admin123456", "cost": "cost123456", "outsider": "out123456",
             "exec": "exec123456", "deptm": "deptm123456"}


def login(client, username, pwd="pm123456"):
    r = client.post("/api/v1/auth/login",
                    json={"username": username, "password": PASSWORDS.get(username, pwd)})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


def mkproject(client, h, name="PAlpha", **kw):
    body = {"name": name, "plan_start": "2026-01-01", "plan_end": "2026-12-31",
            "budget_total": 100000, **kw}
    r = client.post("/api/v1/projects", json=body, headers=h)
    assert r.status_code == 200, r.text
    return r.json()


def items(r):
    """Stage 3A 列表契约：所有列表接口返回 {total,page,size,items}。"""
    data = r.json()
    return data["items"] if isinstance(data, dict) else data


def mkprojects(client, h, n, prefix="PPg"):
    return [mkproject(client, h, f"{prefix}{i:03d}") for i in range(n)]


# 1. 未登录一律 401
def test_unauth_401(client):
    r = client.get("/api/v1/projects")
    assert r.status_code == 401, r.text
    r2 = client.get("/api/v1/projects", headers={"Authorization": "Bearer bad"})
    assert r2.status_code == 401


# 2. 登录/me
def test_login_me(client):
    h = login(client, "admin")
    r = client.get("/api/v1/auth/me", headers=h)
    assert r.status_code == 200 and r.json()["username"] == "admin"


# 3. 编号年份序列 + 名称唯一
def test_project_code_and_dup(client):
    h = login(client, "pm")
    p1 = mkproject(client, h, name="PU1")
    p2 = mkproject(client, h, name="PU2")
    assert p1["code"].startswith("PJ-") and p1["code"] != p2["code"]
    r = client.post("/api/v1/projects", json={"name": "PU1"}, headers=h)
    assert r.status_code == 400


# 4. 状态机非法流转 400，合法 draft->filed
def test_status_machine(client):
    h = login(client, "pm")
    p = mkproject(client, h, name="PSM")
    r = client.post(f"/api/v1/projects/{p['id']}/status",
                    json={"status": "done"}, headers=h)
    assert r.status_code == 400
    r2 = client.post(f"/api/v1/projects/{p['id']}/status",
                     json={"status": "filed"}, headers=h)
    assert r2.status_code == 200 and r2.json()["status"] == "filed"


# 5. 越权 403（非成员读项目）
def test_rbac_forbidden(client):
    h = login(client, "pm")
    p = mkproject(client, h, name="PRBAC")
    ho = login(client, "outsider")
    r = client.get(f"/api/v1/projects/{p['id']}", headers=ho)
    assert r.status_code == 403


# 6. 附件白名单拦截
def test_attachment_whitelist(client):
    h = login(client, "pm")
    p = mkproject(client, h, name="PATT")
    r = client.post(f"/api/v1/projects/{p['id']}/attachments", headers=h,
                    files={"file": ("evil.exe", b"data", "application/octet-stream")})
    assert r.status_code == 400


# 7. WBS 环检测拦截
def test_task_cycle(client):
    h = login(client, "pm")
    p = mkproject(client, h, name="PCYC")
    a = client.post("/api/v1/tasks", json={"project_id": p["id"], "name": "A"}, headers=h).json()
    b = client.post("/api/v1/tasks",
                    json={"project_id": p["id"], "name": "B", "predecessor_id": a["id"]},
                    headers=h).json()
    r = client.patch(f"/api/v1/tasks/{a['id']}", json={"predecessor_id": b["id"]}, headers=h)
    assert r.status_code == 400


# 8. 仅本人填报 403
def test_report_own_only(client):
    h = login(client, "pm")
    p = mkproject(client, h, name="POWN")
    t = client.post("/api/v1/tasks", json={"project_id": p["id"], "name": "T1"}, headers=h).json()
    ho = login(client, "outsider")
    r = client.post("/api/v1/progress-logs",
                    json={"task_id": t["id"], "progress": 50}, headers=ho)
    assert r.status_code in (403, 404)


# 9. Excel 模板表头校验行号报错
def test_import_header_check(client):
    from openpyxl import Workbook
    h = login(client, "pm")
    p = mkproject(client, h, name="PIMP")
    wb = Workbook()
    ws = wb.active
    ws.append(["错", "头", "x", "y", "z", "w"])
    ws.append([1, "T", "pm", None, None, 1])
    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    r = client.post(f"/api/v1/tasks/import?project_id={p['id']}", headers=h,
                    files={"file": ("t.xlsx", buf.getvalue(),
                                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")})
    assert r.status_code == 200
    assert r.json()["created"] == 0 and any("第1行" in e for e in r.json()["errors"])


# 10. 加权进度手工验算一致
def test_weighted_progress(client):
    h = login(client, "pm")
    p = mkproject(client, h, name="PW")
    t1 = client.post("/api/v1/tasks", json={"project_id": p["id"], "name": "T1", "weight": 3},
                     headers=h).json()
    t2 = client.post("/api/v1/tasks", json={"project_id": p["id"], "name": "T2", "weight": 1},
                     headers=h).json()
    client.post("/api/v1/progress-logs", json={"task_id": t1["id"], "progress": 100}, headers=h)
    client.post("/api/v1/progress-logs", json={"task_id": t2["id"], "progress": 0}, headers=h)
    r = client.get(f"/api/v1/projects/{p['id']}/progress", headers=h).json()
    assert r["progress"] == 75.0, r


# 11. 确认快照：非负责人 403，本人可确认且留痕
def test_confirm_snapshot(client):
    h = login(client, "pm")
    p = mkproject(client, h, name="PCFM")
    ho = login(client, "outsider")
    # outsider 非成员写权限即 403（先于仅负责人校验）
    r = client.post(f"/api/v1/projects/{p['id']}/progress/confirm", headers=ho)
    assert r.status_code == 403
    r2 = client.post(f"/api/v1/projects/{p['id']}/progress/confirm", headers=h)
    assert r2.status_code == 200 and "confirmed_at" in r2.json()
    ch = client.get(f"/api/v1/projects/{p['id']}/changes", headers=h).json()
    assert any(c["field"] == "progress_snapshot" for c in ch)


# 12. 预算期间须落在项目计划内
def test_budget_period(client):
    h = login(client, "pm")
    p = mkproject(client, h, name="PBUD")
    r = client.post("/api/v1/budgets",
                    json={"project_id": p["id"], "subject": "人工", "amount": 1000,
                          "period_start": "2025-01-01", "period_end": "2026-06-01"}, headers=h)
    assert r.status_code == 400
    r2 = client.post("/api/v1/budgets",
                     json={"project_id": p["id"], "subject": "人工", "amount": 1000,
                           "period_start": "2026-02-01", "period_end": "2026-06-01"}, headers=h)
    assert r2.status_code == 200


# 13. 超预算拦截 + 特批放行链路（审批人 = 管理员，成本管理员不再是审批人）
def test_over_budget_and_exception(client, db):
    h = login(client, "pm")
    ha = login(client, "admin")
    hc = login(client, "cost")
    p = mkproject(client, h, name="POVER")
    client.post("/api/v1/budgets",
                json={"project_id": p["id"], "subject": "人工", "amount": 100,
                      "period_start": "2026-02-01", "period_end": "2026-06-01"}, headers=h)
    # 审批关闭时超预算直接拦截
    r = client.post("/api/v1/expenses",
                    json={"project_id": p["id"], "subject": "人工", "amount": 150}, headers=h)
    assert r.status_code == 400
    # 打开审批开关：超预算转为 pending
    S = db()
    from api.models import SysParam
    S.query(SysParam).filter_by(key="expense_approval_on").first().value = "1"
    S.commit()
    S.close()
    e = client.post("/api/v1/expenses",
                    json={"project_id": p["id"], "subject": "人工", "amount": 150}, headers=h).json()
    assert e["status"] == "pending"
    # 非管理员（含成本管理员）审批/特批一律 403，且状态不变
    assert client.post(f"/api/v1/expenses/{e['id']}/approve", headers=hc).status_code == 403
    assert client.post(f"/api/v1/expenses/{e['id']}/reject", headers=hc,
                       json={"reason": "不行"}).status_code == 403
    assert client.post(f"/api/v1/expenses/{e['id']}/exception", json={"reason": "特批"},
                       headers=hc).status_code == 403
    assert items(client.get(f"/api/v1/expenses?project_id={p['id']}", headers=ha))[0]["status"] == "pending"
    # 管理员：approve 被超预算拦截，exception 放行
    ra = client.post(f"/api/v1/expenses/{e['id']}/approve", headers=ha)
    assert ra.status_code == 400
    rx = client.post(f"/api/v1/expenses/{e['id']}/exception", json={"reason": "特批"}, headers=ha)
    assert rx.status_code == 200 and rx.json()["status"] == "exception"


# 14. 里程碑临近预警 + 报表导出同口径
def test_milestone_warn_and_export(client):
    h = login(client, "pm")
    p = mkproject(client, h, name="PMS")
    near = (date.today() + timedelta(days=2)).isoformat()
    client.post("/api/v1/milestones",
                json={"project_id": p["id"], "name": "M1", "plan_date": near}, headers=h)
    w = client.get("/api/v1/reports/warnings", headers=h).json()
    assert any(m["project_id"] == p["id"] for m in w["milestones"])
    rep = client.get("/api/v1/reports/cost", headers=h).json()
    assert "note" in rep and any("管理口径" in (rep["note"] + r.get("note", "")) for r in rep["items"] + [{}])
    ex = client.get("/api/v1/reports/cost/export", headers=h)
    assert ex.status_code == 200 and ex.content[:2] == b"PK"


# ============ Stage 2：条目编辑闭环 ============

def _upload_png(client, h, pid, name="t.png"):
    files = {"file": (name, b"fakepng", "image/png")}
    r = client.post(f"/api/v1/projects/{pid}/attachments", files=files, headers=h)
    assert r.status_code == 200, r.text
    return r.json()


# 15. 附件下载与删除（含越权）
def test_attachment_download_delete(client):
    h = login(client, "pm")
    p = mkproject(client, h, "PAtt")
    a = _upload_png(client, h, p["id"])
    r = client.get(f"/api/v1/projects/{p['id']}/attachments/{a['id']}/download", headers=h)
    assert r.status_code == 200 and r.content == b"fakepng"
    # 非上传者且非管理员删除 → 403
    ho = login(client, "outsider")
    r2 = client.delete(f"/api/v1/projects/{p['id']}/attachments/{a['id']}", headers=ho)
    assert r2.status_code in (403, 404)
    # 管理员可删
    ha = login(client, "admin")
    assert client.delete(f"/api/v1/projects/{p['id']}/attachments/{a['id']}", headers=ha).status_code == 200
    assert client.get(f"/api/v1/projects/{p['id']}/attachments", headers=h).json() == []


# 16. 跟进编辑/删除 + 分页信封
def test_followup_update_delete_paged(client):
    h = login(client, "pm")
    p = mkproject(client, h, "PFollow")
    fid = client.post(f"/api/v1/projects/{p['id']}/followups", headers=h,
                      json={"method": "电话", "content": "初访"}).json()["id"]
    r = client.patch(f"/api/v1/projects/{p['id']}/followups/{fid}", headers=h,
                     json={"method": "现场", "content": "改成现场"})
    assert r.status_code == 200 and r.json()["content"] == "改成现场"
    page = client.get(f"/api/v1/projects/{p['id']}/followups?page=1&size=5", headers=h).json()
    assert page["total"] == 1 and len(page["items"]) == 1
    assert client.delete(f"/api/v1/projects/{p['id']}/followups/{fid}", headers=h).status_code == 200
    assert items(client.get(f"/api/v1/projects/{p['id']}/followups", headers=h)) == []


# 17. 成员管理：整体覆盖 + 负责人保留
def test_set_members(client, db):
    h = login(client, "pm")
    p = mkproject(client, h, "PMem")
    from api.models import User
    other = db().query(User).filter_by(username="cost").first().id
    r = client.put(f"/api/v1/projects/{p['id']}/members", headers=h, json={"user_ids": [other]})
    assert r.status_code == 200, r.text
    members = set(r.json()["member_ids"])
    assert other in members
    assert r.json()["owner_id"] in members  # 负责人自动保留


# 18. 软删除 / 回收站 / 恢复
def test_soft_delete_recycle_restore(client):
    h = login(client, "pm")
    p = mkproject(client, h, "PDel")
    # 非管理员不可删
    assert client.delete(f"/api/v1/projects/{p['id']}", headers=h).status_code == 403
    ha = login(client, "admin")
    # 已立项/进行中不可删
    client.post(f"/api/v1/projects/{p['id']}/status", headers=ha, json={"status": "filed"})
    assert client.delete(f"/api/v1/projects/{p['id']}", headers=ha).status_code == 400
    client.post(f"/api/v1/projects/{p['id']}/status", headers=ha, json={"status": "cancelled"})
    assert client.delete(f"/api/v1/projects/{p['id']}", headers=ha).status_code == 200
    # 台账不再可见
    ids = [x["id"] for x in client.get("/api/v1/projects", headers=ha).json()["items"]]
    assert p["id"] not in ids
    bin_rows = items(client.get("/api/v1/projects/recycle-bin/list", headers=ha))
    assert any(x["id"] == p["id"] for x in bin_rows)
    assert client.post(f"/api/v1/projects/{p['id']}/restore", headers=ha).status_code == 200
    ids2 = [x["id"] for x in client.get("/api/v1/projects", headers=ha).json()["items"]]
    assert p["id"] in ids2


# ============ Stage 3：通知 + 审批中心 ============

# 19. 通知生成 + 已读 + 去重
def test_notifications_flow(client):
    h = login(client, "pm")
    p = mkproject(client, h, "PNotif")
    # 造预算 80% 预警：预算 10000，支出 8500
    client.post("/api/v1/budgets", headers=h, json={"project_id": p["id"], "subject": "人工",
                                                    "amount": 10000,
                                                    "period_start": "2026-01-01",
                                                    "period_end": "2026-12-31"})
    client.post("/api/v1/expenses", headers=h, json={"project_id": p["id"], "subject": "人工",
                                                     "amount": 8500, "exp_date": "2026-06-01"})
    first = client.get("/api/v1/notifications", headers=h).json()
    assert first["total"] >= 1 and first["unread"] >= 1
    # 重复拉取不应产生重复通知（按天去重）
    second = client.get("/api/v1/notifications", headers=h).json()
    assert second["total"] == first["total"]
    nid = first["items"][0]["id"]
    assert client.post(f"/api/v1/notifications/{nid}/read", headers=h).status_code == 200
    assert client.post("/api/v1/notifications/read-all", headers=h).json()["ok"] is True
    assert client.get("/api/v1/notifications/count", headers=h).json()["unread"] == 0
    # 越权：他人的通知不可标记
    ho = login(client, "outsider")
    assert client.post(f"/api/v1/notifications/{nid}/read", headers=ho).status_code == 404


# 20. 立项审批开关打通：创建即待审批 → 审批中心放行
def test_project_filing_approval(client, db):
    ha = login(client, "admin")
    assert client.put("/api/v1/admin/params", headers=ha,
                      json={"project_approval_on": "1"}).status_code == 200
    h = login(client, "pm")
    p = mkproject(client, h, "PFiling")
    assert p["status"] == "pending"
    pend = client.get("/api/v1/approvals/pending", headers=ha).json()
    assert any(x["id"] == p["id"] for x in pend["project_filings"])
    r = client.post(f"/api/v1/approvals/project_filing/{p['id']}/decide", headers=ha,
                    json={"approve": True, "reason": "同意"})
    assert r.status_code == 200 and r.json()["status"] == "filed"
    assert client.get(f"/api/v1/projects/{p['id']}", headers=ha).json()["status"] == "filed"
    client.put("/api/v1/admin/params", headers=ha, json={"project_approval_on": "0"})


# 21. 支出审批中心决策 + 非审批人 403
def test_expense_approval_center(client):
    ha = login(client, "admin")
    client.put("/api/v1/admin/params", headers=ha, json={"expense_approval_on": "1"})
    h = login(client, "pm")
    p = mkproject(client, h, "PExpAppr")
    e = client.post("/api/v1/expenses", headers=h, json={"project_id": p["id"], "subject": "采购",
                                                         "amount": 1000, "exp_date": "2026-06-01"})
    assert e.json()["status"] == "pending"
    eid = e.json()["id"]
    # 普通成员无权审批
    hm = login(client, "outsider")
    assert client.post(f"/api/v1/approvals/expense/{eid}/decide", headers=hm,
                       json={"approve": True}).status_code == 403
    r = client.post(f"/api/v1/approvals/expense/{eid}/decide", headers=ha, json={"approve": True})
    assert r.status_code == 200 and r.json()["status"] == "approved"
    client.put("/api/v1/admin/params", headers=ha, json={"expense_approval_on": "0"})


# ============ Stage 4：工作台 + 报表 ============

# 22. 工作台汇总口径
def test_dashboard_summary_weekly(client):
    h = login(client, "pm")
    p = mkproject(client, h, "PDash")
    client.post("/api/v1/budgets", headers=h, json={"project_id": p["id"], "subject": "人工",
                                                    "amount": 10000,
                                                    "period_start": "2026-01-01",
                                                    "period_end": "2026-12-31"})
    client.post("/api/v1/expenses", headers=h, json={"project_id": p["id"], "subject": "人工",
                                                     "amount": 5000, "exp_date": "2026-06-01"})
    s = client.get("/api/v1/dashboard/summary", headers=h).json()
    assert s["kpi"]["my_projects"] >= 1
    assert s["kpi"]["total_budget"] == 10000
    assert s["kpi"]["total_spent"] == 5000
    assert len(s["trend"]) == 6
    assert any(x["subject"] == "人工" for x in s["by_subject"])
    w = client.get("/api/v1/dashboard/my-weekly", headers=h).json()
    assert "range" in w and "overdue" in w and "due_soon" in w


# 23. FTS 检索：≥3 字命中并返回高亮片段，短词回退 LIKE
def test_fts_keyword_snippet(client):
    h = login(client, "pm")
    mkproject(client, h, "官网改版项目", description="演示全文检索能力")
    hit = client.get("/api/v1/projects?keyword=官网改版", headers=h).json()
    if hit["total"]:  # FTS5 可用时（部分环境无 trigram 会走 LIKE）
        assert "snippet" in hit["items"][0]
    short = client.get("/api/v1/projects?keyword=改版", headers=h).json()
    assert short["total"] >= 1  # 2 字关键词经 LIKE 回退仍能命中


# 24. 分页信封 + 权限下推（不可见项目不出现）
def test_paging_and_visibility(client):
    h = login(client, "pm")
    p = mkproject(client, h, "PPage")
    for i in range(3):
        client.post("/api/v1/expenses", headers=h, json={"project_id": p["id"], "subject": "差旅",
                                                         "amount": 100 + i, "exp_date": "2026-06-01"})
    page = client.get(f"/api/v1/expenses?project_id={p['id']}&page=1&size=2", headers=h).json()
    assert page["total"] == 3 and len(page["items"]) == 2
    # outsider 不是成员、部门也不同 → 看不到该项目
    ho = login(client, "outsider")
    ids = [x["id"] for x in client.get("/api/v1/projects", headers=ho).json()["items"]]
    assert p["id"] not in ids
    assert client.get(f"/api/v1/projects/{p['id']}", headers=ho).status_code == 403


# ============ Stage 1：管理员全局管理与审批边界 ============
# 契约：admin 是唯一的管理与审批角色 + 唯一全局数据范围；非管理员调用管理/审批接口稳定 403 且无状态变更；
#      审批中心 pending 与决策入口同一判定；普通用户按「负责人/成员」参与业务的路径不受影响。

def mkuser_in_other_dept(db, username, pwd, roles, dept_name="外部部门"):
    """在另一个部门建用户（用于验证「全局范围只属于管理员」）。返回 (user_id, dept_id)。"""
    from api.core.security import hash_password as _hp
    from api.models import Department, Role, User, UserRole
    S = db()
    d = S.query(Department).filter_by(name=dept_name).first()
    if not d:
        d = Department(name=dept_name)
        S.add(d)
        S.flush()
    u = User(username=username, pwd_hash=_hp(pwd), real_name=username, dept_id=d.id)
    S.add(u)
    S.flush()
    for c in roles:
        r = S.query(Role).filter_by(code=c).first()
        assert r is not None, f"角色 {c} 不存在"
        S.add(UserRole(user_id=u.id, role_id=r.id))
    S.commit()
    out = (u.id, d.id)
    S.close()
    return out


def login_raw(client, username, pwd):
    r = client.post("/api/v1/auth/login", json={"username": username, "password": pwd})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


# 25. 管理/审批接口：非管理员稳定 403，且不产生任何业务状态变更
def test_non_admin_management_and_approval_403(client, db):
    ha = login(client, "admin")
    assert client.put("/api/v1/admin/params", headers=ha,
                      json={"project_approval_on": "1", "expense_approval_on": "1",
                            "budget_approval_on": "1"}).status_code == 200
    h = login(client, "pm")
    p = mkproject(client, h, "PGate")
    assert p["status"] == "pending"
    bid = client.post("/api/v1/budgets", headers=h,
                      json={"project_id": p["id"], "subject": "人工", "amount": 1000,
                            "period_start": "2026-01-01", "period_end": "2026-12-31"}).json()["id"]
    adj = client.patch(f"/api/v1/budgets/{bid}", headers=h,
                       json={"amount": 2000, "reason": "追加"}).json()
    assert adj["status"] == "pending"
    aid = adj["id"]
    eid = client.post("/api/v1/expenses", headers=h,
                      json={"project_id": p["id"], "subject": "采购", "amount": 500,
                            "exp_date": "2026-06-01"}).json()["id"]

    forbidden = [
        ("get", "/api/v1/admin/users", None),
        ("post", "/api/v1/admin/users", {"username": "hacker", "password": "hacker123"}),
        ("get", "/api/v1/admin/roles", None),
        ("get", "/api/v1/admin/dicts", None),
        ("post", "/api/v1/admin/dicts", {"type": "t", "code": "c", "label": "l"}),
        ("get", "/api/v1/admin/params", None),
        ("put", "/api/v1/admin/params", {"expense_approval_on": "0"}),
        ("get", "/api/v1/admin/logs", None),
        ("get", "/api/v1/admin/logs/export", None),
        ("get", "/api/v1/projects/recycle-bin/list", None),
        ("delete", f"/api/v1/projects/{p['id']}", None),
        ("post", f"/api/v1/projects/{p['id']}/restore", None),
        ("get", "/api/v1/approvals/pending", None),
        ("post", f"/api/v1/approvals/project_filing/{p['id']}/decide", {"approve": True}),
        ("post", f"/api/v1/approvals/budget_adjust/{aid}/decide", {"approve": True}),
        ("post", f"/api/v1/approvals/expense/{eid}/decide", {"approve": True}),
        ("post", f"/api/v1/approvals/expense/{eid}/exception", {"reason": "特批"}),
        ("post", f"/api/v1/budget-adjusts/{aid}/approve", {"approve": True}),
        ("post", f"/api/v1/expenses/{eid}/approve", None),
        ("post", f"/api/v1/expenses/{eid}/reject", {"reason": "驳回"}),
        ("post", f"/api/v1/expenses/{eid}/exception", {"reason": "特批"}),
    ]
    for name in ("pm", "outsider", "cost", "exec", "deptm"):
        hh = login(client, name)
        for method, url, payload in forbidden:
            kw = {"json": payload} if payload is not None else {}
            r = getattr(client, method)(url, headers=hh, **kw)
            assert r.status_code == 403, f"{name} {method.upper()} {url} -> {r.status_code}"

    # 无状态变更：立项仍待审批、调整单仍待审批、支出仍待审批、参数与用户未被改写
    assert client.get(f"/api/v1/projects/{p['id']}", headers=ha).json()["status"] == "pending"
    asserts = items(client.get("/api/v1/budget-adjusts?status=pending", headers=ha))
    assert any(x["id"] == aid for x in asserts)
    assert items(client.get(f"/api/v1/expenses?project_id={p['id']}", headers=ha))[0]["status"] == "pending"
    assert client.get("/api/v1/admin/params", headers=ha).json()["expense_approval_on"] == "1"
    assert not any(u["username"] == "hacker"
                   for u in client.get("/api/v1/admin/users", headers=ha).json()["items"])
    # 审计里也不应留下「越权成功」的记录
    logs = client.get("/api/v1/admin/logs", headers=ha).json()["items"]
    assert not any(l["action"] in ("decide_expense", "approve_adjust", "approve_filing") for l in logs)
    client.put("/api/v1/admin/params", headers=ha,
               json={"project_approval_on": "0", "expense_approval_on": "0",
                     "budget_approval_on": "0"})


# 26. 管理员全局范围（跨部门、跨项目）+ 审批中心 pending 与决策入口一致
def test_admin_global_scope_and_approval_consistency(client, db):
    ha = login(client, "admin")
    assert client.put("/api/v1/admin/params", headers=ha,
                      json={"project_approval_on": "1"}).status_code == 200
    _uid, dept_id = mkuser_in_other_dept(db, "otherpm", "other123456",
                                         ["project_manager", "member"])
    hother = login_raw(client, "otherpm", "other123456")
    p = mkproject(client, hother, "POtherDept")
    assert p["status"] == "pending" and p["dept_id"] == dept_id

    # 管理员跨部门读取 + 出现在全局台账
    assert client.get(f"/api/v1/projects/{p['id']}", headers=ha).json()["id"] == p["id"]
    ids = [x["id"] for x in client.get("/api/v1/projects?size=100", headers=ha).json()["items"]]
    assert p["id"] in ids
    # 跨部门也能处理（改状态）
    assert client.post(f"/api/v1/projects/{p['id']}/status", headers=ha,
                       json={"status": "filed"}).json()["status"] == "filed"
    client.post(f"/api/v1/projects/{p['id']}/status", headers=ha, json={"status": "doing"})

    # 审批中心：全局聚合三类待办，行内 can_decide 与决策入口同一判定
    p2 = mkproject(client, hother, "POtherDept2")
    pend = client.get("/api/v1/approvals/pending", headers=ha).json()
    row = next(x for x in pend["project_filings"] if x["id"] == p2["id"])
    assert row["can_decide"] is True
    assert pend["total"] == (len(pend["project_filings"]) + len(pend["budget_adjusts"])
                             + len(pend["expenses"]))
    r = client.post(f"/api/v1/approvals/project_filing/{p2['id']}/decide", headers=ha,
                    json={"approve": True, "reason": "同意"})
    assert r.status_code == 200 and r.json()["status"] == "filed"

    # 非管理员：列表不可见（403），决策同样 403 —— 不存在「按钮可见但接口拒绝」
    for hh in (login(client, "pm"), hother, login(client, "outsider")):
        assert client.get("/api/v1/approvals/pending", headers=hh).status_code == 403
    assert client.post(f"/api/v1/approvals/project_filing/{p['id']}/decide", headers=hother,
                       json={"approve": True}).status_code == 403
    client.put("/api/v1/admin/params", headers=ha, json={"project_approval_on": "0"})


# 27. 保留角色（负责人/成本管理员/部门负责人/高层）不再拥有管理与审批特权
def test_reserved_roles_have_no_admin_privilege(client, db):
    ha = login(client, "admin")
    hpm = login(client, "pm")
    p = mkproject(client, hpm, "PReserved")

    for name in ("cost", "exec", "deptm", "outsider"):
        hh = login(client, name)
        # 无全局读：非参与人一律 403（部门隔离/高层只读/成本全局权限规则已取消）
        assert client.get(f"/api/v1/projects/{p['id']}", headers=hh).status_code == 403
        # 「待我审批」恒为 0，不泄漏全局待办计数
        assert client.get("/api/v1/dashboard/summary", headers=hh).json()["kpi"]["pending_approvals"] == 0
        # 单一入口：菜单里没有管理与审批入口
        mm = client.get("/api/v1/meta/me/menus", headers=hh).json()
        assert mm["is_admin"] is False and mm["can_approve"] is False
        keys = {m["key"] for m in mm["menus"]}
        assert "admin" not in keys and "approvals" not in keys

    # 有真实待办时，非管理员的计数仍为 0；管理员能看到
    client.put("/api/v1/admin/params", headers=ha, json={"project_approval_on": "1"})
    mkproject(client, hpm, "PReserved2")
    assert client.get("/api/v1/dashboard/summary", headers=login(client, "exec")).json()["kpi"]["pending_approvals"] == 0
    assert client.get("/api/v1/dashboard/summary", headers=ha).json()["kpi"]["pending_approvals"] >= 1

    mm_admin = client.get("/api/v1/meta/me/menus", headers=ha).json()
    assert mm_admin["is_admin"] is True and mm_admin["can_approve"] is True
    assert {"approvals", "admin"} <= {m["key"] for m in mm_admin["menus"]}

    # 普通用户参与路径未被收敛：负责人仍可建项目/任务/预算/支出/跟进
    t = client.post("/api/v1/tasks", json={"project_id": p["id"], "name": "T1"}, headers=hpm)
    assert t.status_code == 200
    assert client.post("/api/v1/progress-logs", json={"task_id": t.json()["id"], "progress": 30},
                       headers=hpm).status_code == 200
    assert client.post(f"/api/v1/projects/{p['id']}/followups", headers=hpm,
                       json={"method": "电话", "content": "初访"}).status_code == 200
    assert client.post("/api/v1/budgets", headers=hpm,
                       json={"project_id": p["id"], "subject": "人工", "amount": 1000,
                             "period_start": "2026-01-01", "period_end": "2026-12-31"}).status_code == 200
    assert client.post("/api/v1/expenses", headers=hpm,
                       json={"project_id": p["id"], "subject": "人工", "amount": 100}).status_code == 200
    client.put("/api/v1/admin/params", headers=ha, json={"project_approval_on": "0"})


# 28. 软删除项目边界：管理员全局 ≠ 包含回收站数据
def test_soft_delete_boundary_with_admin_global_scope(client, db):
    ha = login(client, "admin")
    hpm = login(client, "pm")
    p = mkproject(client, hpm, "PBinBoundary")
    client.post(f"/api/v1/projects/{p['id']}/status", headers=ha, json={"status": "filed"})
    assert client.delete(f"/api/v1/projects/{p['id']}", headers=ha).status_code == 400  # 已立项不可删
    client.post(f"/api/v1/projects/{p['id']}/status", headers=ha, json={"status": "cancelled"})
    assert client.delete(f"/api/v1/projects/{p['id']}", headers=ha).status_code == 200
    assert p["id"] not in [x["id"] for x in client.get("/api/v1/projects?size=100", headers=ha).json()["items"]]
    assert client.get(f"/api/v1/projects/{p['id']}", headers=ha).status_code == 404
    assert any(x["id"] == p["id"] for x in items(client.get("/api/v1/projects/recycle-bin/list", headers=ha)))
    assert client.post(f"/api/v1/projects/{p['id']}/restore", headers=ha).status_code == 200
    assert p["id"] in [x["id"] for x in client.get("/api/v1/projects?size=100", headers=ha).json()["items"]]

    # 待立项审批项目被软删除后：不出现在正常列表与审批待办，只在回收站可见，恢复后回到待办
    assert client.put("/api/v1/admin/params", headers=ha, json={"project_approval_on": "1"}).status_code == 200
    p2 = mkproject(client, hpm, "PBinPending")
    assert p2["status"] == "pending"
    filings = lambda: [x["id"] for x in client.get("/api/v1/approvals/pending", headers=ha).json()["project_filings"]]  # noqa: E731
    assert p2["id"] in filings()
    assert client.delete(f"/api/v1/projects/{p2['id']}", headers=ha).status_code == 200
    assert p2["id"] not in filings()
    assert p2["id"] not in [x["id"] for x in client.get("/api/v1/projects?size=100", headers=ha).json()["items"]]
    assert any(x["id"] == p2["id"] for x in items(client.get("/api/v1/projects/recycle-bin/list", headers=ha)))
    assert client.post(f"/api/v1/projects/{p2['id']}/restore", headers=ha).status_code == 200
    assert p2["id"] in filings()
    # 回收站属管理面：非管理员连查看都 403
    assert client.get("/api/v1/projects/recycle-bin/list", headers=hpm).status_code == 403
    client.put("/api/v1/admin/params", headers=ha, json={"project_approval_on": "0"})


# 29. 子表列表的统一边界：不带 project_id 时只返回「可见 + 未软删除」项目的数据
def test_child_lists_apply_visibility_boundary(client, db):
    ha = login(client, "admin")
    h = login(client, "pm")
    assert client.put("/api/v1/admin/params", headers=ha,
                      json={"budget_approval_on": "1",
                            "expense_approval_on": "1"}).status_code == 200
    p = mkproject(client, h, "PVisBound")
    bid = client.post("/api/v1/budgets", headers=h,
                      json={"project_id": p["id"], "subject": "人工", "amount": 1000,
                            "period_start": "2026-01-01", "period_end": "2026-12-31"}).json()["id"]
    aid = client.patch(f"/api/v1/budgets/{bid}", headers=h,
                       json={"amount": 1200, "reason": "追加"}).json()["id"]
    eid = client.post("/api/v1/expenses", headers=h,
                      json={"project_id": p["id"], "subject": "人工", "amount": 300,
                            "exp_date": "2026-06-01"}).json()["id"]
    mid = client.post("/api/v1/milestones", headers=h,
                      json={"project_id": p["id"], "name": "M1",
                            "plan_date": "2026-06-30"}).json()["id"]
    tid = client.post("/api/v1/tasks", headers=h,
                      json={"project_id": p["id"], "name": "T1"}).json()["id"]
    client.post("/api/v1/progress-logs", headers=h, json={"task_id": tid, "progress": 40})

    # 管理员（全局）在所有列表里都能看到这些记录
    assert any(x["id"] == bid for x in items(client.get("/api/v1/budgets", headers=ha)))
    assert any(x["id"] == aid for x in items(client.get("/api/v1/budget-adjusts", headers=ha)))
    assert any(x["id"] == eid for x in items(client.get("/api/v1/expenses", headers=ha)))
    assert any(x["id"] == mid for x in items(client.get("/api/v1/milestones", headers=ha)))
    assert any(x["id"] == tid for x in items(client.get("/api/v1/tasks", headers=ha)))
    assert any(x["project_id"] == p["id"] for x in items(client.get("/api/v1/progress-logs", headers=ha)))

    # 非参与人（含保留角色）：不带 project_id 的列表必须是空，不得泄漏其他项目数据
    for name in ("outsider", "exec", "deptm", "cost"):
        hh = login(client, name)
        assert items(client.get("/api/v1/budgets", headers=hh)) == [], name
        assert items(client.get("/api/v1/budget-adjusts", headers=hh)) == [], name
        assert items(client.get("/api/v1/expenses", headers=hh)) == [], name
        assert items(client.get("/api/v1/milestones", headers=hh)) == [], name
        assert items(client.get("/api/v1/tasks", headers=hh)) == [], name
        assert items(client.get("/api/v1/progress-logs", headers=hh)) == [], name
        # 也不能用 project_id / task_id 绕过项目边界
        for url in (f"/api/v1/budgets?project_id={p['id']}",
                    f"/api/v1/budget-adjusts?project_id={p['id']}",
                    f"/api/v1/expenses?project_id={p['id']}",
                    f"/api/v1/milestones?project_id={p['id']}",
                    f"/api/v1/tasks?project_id={p['id']}",
                    f"/api/v1/progress-logs?project_id={p['id']}",
                    f"/api/v1/progress-logs?task_id={tid}"):
            assert client.get(url, headers=hh).status_code == 403, f"{name} {url}"
    # 参与路径未被收敛：负责人自己仍然看得到
    assert any(x["id"] == bid for x in items(client.get("/api/v1/budgets", headers=h)))
    assert any(x["project_id"] == p["id"] for x in items(client.get("/api/v1/progress-logs", headers=h)))


# 30. 软删除项目边界（子表）：列表 / 待办 / 计数 / 决策入口 / 写入口一律排除
def test_soft_deleted_project_child_records_excluded(client, db):
    from api.models import BudgetAdjust, Expense

    ha = login(client, "admin")
    h = login(client, "pm")
    assert client.put("/api/v1/admin/params", headers=ha,
                      json={"budget_approval_on": "1",
                            "expense_approval_on": "1"}).status_code == 200
    p = mkproject(client, h, "PSoftRec")
    bid = client.post("/api/v1/budgets", headers=h,
                      json={"project_id": p["id"], "subject": "人工", "amount": 1000,
                            "period_start": "2026-01-01", "period_end": "2026-12-31"}).json()["id"]
    aid = client.patch(f"/api/v1/budgets/{bid}", headers=h,
                       json={"amount": 1200, "reason": "追加"}).json()["id"]
    eid = client.post("/api/v1/expenses", headers=h,
                      json={"project_id": p["id"], "subject": "人工", "amount": 300,
                            "exp_date": "2026-06-01"}).json()["id"]
    mid = client.post("/api/v1/milestones", headers=h,
                      json={"project_id": p["id"], "name": "M1",
                            "plan_date": "2026-06-30"}).json()["id"]
    tid = client.post("/api/v1/tasks", headers=h,
                      json={"project_id": p["id"], "name": "T1"}).json()["id"]
    client.post("/api/v1/progress-logs", headers=h, json={"task_id": tid, "progress": 40})

    # 删除前：待办与计数都包含这些记录（调整单 + 支出 = 2）
    pend = client.get("/api/v1/approvals/pending", headers=ha).json()
    assert any(x["id"] == aid for x in pend["budget_adjusts"])
    assert any(x["id"] == eid for x in pend["expenses"])
    assert client.get("/api/v1/dashboard/summary", headers=ha).json()["kpi"]["pending_approvals"] == 2

    # 软删除项目（draft → cancelled → 删除）
    client.post(f"/api/v1/projects/{p['id']}/status", headers=ha, json={"status": "cancelled"})
    assert client.delete(f"/api/v1/projects/{p['id']}", headers=ha).status_code == 200

    # 普通列表：连管理员（全局范围）也不再看到已删除项目的子表记录
    assert client.get(f"/api/v1/budgets?project_id={p['id']}", headers=ha).status_code == 404
    assert all(x["id"] != bid for x in items(client.get("/api/v1/budgets", headers=ha)))
    assert all(x["id"] != aid for x in items(client.get("/api/v1/budget-adjusts", headers=ha)))
    assert all(x["id"] != eid for x in items(client.get("/api/v1/expenses", headers=ha)))
    assert all(x["id"] != mid for x in items(client.get("/api/v1/milestones", headers=ha)))
    assert all(x["id"] != tid for x in items(client.get("/api/v1/tasks", headers=ha)))
    assert all(x["project_id"] != p["id"] for x in items(client.get("/api/v1/progress-logs", headers=ha)))

    # 审批待办与「待我审批」计数：同样排除
    pend2 = client.get("/api/v1/approvals/pending", headers=ha).json()
    assert not any(x["id"] == aid for x in pend2["budget_adjusts"])
    assert not any(x["id"] == eid for x in pend2["expenses"])
    assert client.get("/api/v1/dashboard/summary", headers=ha).json()["kpi"]["pending_approvals"] == 0

    # 决策入口：一律 404，且不得产生状态变更
    assert client.post(f"/api/v1/approvals/budget_adjust/{aid}/decide", headers=ha,
                       json={"approve": True}).status_code == 404
    assert client.post(f"/api/v1/approvals/expense/{eid}/decide", headers=ha,
                       json={"approve": True}).status_code == 404
    assert client.post(f"/api/v1/approvals/expense/{eid}/exception", headers=ha,
                       json={"reason": "特批"}).status_code == 404
    assert client.post(f"/api/v1/budget-adjusts/{aid}/approve", headers=ha,
                       json={"approve": True}).status_code == 404
    assert client.post(f"/api/v1/expenses/{eid}/approve", headers=ha).status_code == 404
    assert client.post(f"/api/v1/expenses/{eid}/reject", headers=ha,
                       json={"reason": "驳回"}).status_code == 404
    assert client.post(f"/api/v1/expenses/{eid}/exception", headers=ha,
                       json={"reason": "特批"}).status_code == 404
    S = db()
    assert S.query(BudgetAdjust).filter_by(id=aid).first().status == "pending"
    assert S.query(Expense).filter_by(id=eid).first().status == "pending"
    S.close()

    # 普通写入口：软删除项目统一 404（不静默写入）
    assert client.post("/api/v1/budgets", headers=ha,
                       json={"project_id": p["id"], "subject": "人工", "amount": 100,
                             "period_start": "2026-01-01",
                             "period_end": "2026-12-31"}).status_code == 404
    assert client.patch(f"/api/v1/budgets/{bid}", headers=ha,
                        json={"amount": 999}).status_code == 404
    assert client.post("/api/v1/expenses", headers=ha,
                       json={"project_id": p["id"], "subject": "人工", "amount": 10}).status_code == 404
    assert client.post("/api/v1/milestones", headers=ha,
                       json={"project_id": p["id"], "name": "M2",
                             "plan_date": "2026-07-31"}).status_code == 404
    assert client.patch(f"/api/v1/milestones/{mid}", headers=ha,
                        json={"name": "M1x"}).status_code == 404
    assert client.delete(f"/api/v1/milestones/{mid}", headers=ha).status_code == 404
    assert client.post("/api/v1/tasks", headers=ha,
                       json={"project_id": p["id"], "name": "T2"}).status_code == 404
    assert client.patch(f"/api/v1/tasks/{tid}", headers=ha, json={"name": "T1x"}).status_code == 404
    assert client.post("/api/v1/progress-logs", headers=ha,
                       json={"task_id": tid, "progress": 60}).status_code == 404

    # 恢复后重新回到正常业务面（记录与待办都回来了）
    assert client.post(f"/api/v1/projects/{p['id']}/restore", headers=ha).status_code == 200
    assert any(x["id"] == bid for x in items(client.get("/api/v1/budgets", headers=ha)))
    assert client.get("/api/v1/dashboard/summary", headers=ha).json()["kpi"]["pending_approvals"] == 2
    client.put("/api/v1/admin/params", headers=ha,
               json={"budget_approval_on": "0", "expense_approval_on": "0"})


# ============ 演示数据开关（demo_data_on）============

def _mk_demo_project(client, db, name="DemoProj"):
    """直接落库一个 is_demo=True 的项目（模拟 seed_mock 写入的演示数据）。"""
    from api.models import Project
    s = db()
    try:
        p = Project(code="PJ-2026-9001", name=name, type="研发", status="doing",
                    plan_start=date(2026, 1, 1), plan_end=date(2026, 12, 31),
                    budget_total=1000, is_demo=True)
        s.add(p)
        s.commit()
        return p.id
    finally:
        s.close()


def _set_demo(client, h, on):
    return client.put("/api/v1/admin/demo-data", headers=h, json={"on": on})


# 38. 演示数据开关默认关闭：列表/看板/报表/预警/直连五处一并隐藏
def test_demo_data_hidden_by_default(client, db):
    ha = login(client, "admin")
    pid = _mk_demo_project(client, db)
    # 默认（seed 未写入开关时）视为隐藏
    assert client.get("/api/v1/admin/demo-data", headers=ha).json()["on"] is False
    assert client.get("/api/v1/projects", headers=ha).json()["total"] == 0
    assert client.get("/api/v1/dashboard/summary", headers=ha).json()["kpi"]["my_projects"] == 0
    assert client.get("/api/v1/dashboard/summary", headers=ha).json()["health"] == []
    assert client.get("/api/v1/reports/cost", headers=ha).json()["items"] == []
    assert client.get(f"/api/v1/projects/{pid}", headers=ha).status_code == 404
    # 子表写入也应被拦（项目按不存在处理）
    assert client.post("/api/v1/expenses", headers=ha, json={
        "project_id": pid, "subject": "人工", "amount": 10}).status_code == 404


# 39. 演示数据开关打开：恢复可见，且工作台「我的项目」对管理员不再恒为 0
def test_demo_data_toggle_on(client, db):
    ha = login(client, "admin")
    pid = _mk_demo_project(client, db, "DemoToggle")
    assert _set_demo(client, ha, True).json()["on"] is True
    assert client.get("/api/v1/projects", headers=ha).json()["total"] == 1
    assert client.get(f"/api/v1/projects/{pid}", headers=ha).status_code == 200
    s = client.get("/api/v1/dashboard/summary", headers=ha).json()
    assert s["kpi"]["my_projects"] == 1
    assert len(s["health"]) == 1
    # 关闭后重新隐藏
    assert _set_demo(client, ha, False).json()["on"] is False
    assert client.get("/api/v1/projects", headers=ha).json()["total"] == 0


# 40. 演示数据开关权限：非管理员不能切换但能读状态；非演示数据不受影响
def test_demo_data_permission_and_scope(client, db):
    ha = login(client, "admin")
    p = mkproject(client, ha, "RealProj")          # 非演示项目
    _mk_demo_project(client, db, "DemoScope")
    hp = login(client, "pm")

    assert client.get("/api/v1/projects", headers=ha).json()["total"] == 1   # 只剩真实项目
    assert client.get(f"/api/v1/projects/{p['id']}", headers=ha).status_code == 200
    assert client.put("/api/v1/admin/demo-data", headers=hp, json={"on": True}).status_code == 403
    assert client.get("/api/v1/admin/demo-data", headers=hp).status_code == 403
    menus = client.get("/api/v1/meta/me/menus", headers=hp).json()
    assert menus["demo_on"] is False and menus["can_toggle_demo"] is False
    # 打开开关后真实项目仍可见，演示项目一并可见
    _set_demo(client, ha, True)
    assert client.get("/api/v1/projects", headers=ha).json()["total"] == 2
# ============ Stage 3A：列表分页 / 排序 / 查询边界契约 ============
# 契约（前端与回归测试共同依赖）：
#   · 所有列表接口返回 {total,page,size,items}；省略分页参数 = page1/size20（不再返回无界数据）
#   · 非法 page/size/sort → 400；size 上限 100；排序白名单外字段绝不拼进 SQL
#   · total 与 items 同条件对应；越过末页返回空 items（不抛异常、不重复上一页）
#   · 排序稳定性：请求的 sort 之后以 id 兜底，连续翻页不重不漏


def paged_keys(data):
    return {"total", "page", "size", "items"} <= set(data.keys())


# 31. 所有列表接口统一信封：省略分页参数不再返回无界数据
def test_list_endpoints_always_paged(client):
    ha = login(client, "admin")
    h = login(client, "pm")
    ps = mkprojects(client, h, 25)          # 25 个项目 > 默认 size
    pid = ps[0]["id"]
    tids = [client.post("/api/v1/tasks", headers=h,
                        json={"project_id": pid, "name": f"T{i}"}).json()["id"] for i in range(3)]
    bid = client.post("/api/v1/budgets", headers=h,
                      json={"project_id": pid, "subject": "人工", "amount": 100}).json()["id"]
    client.patch(f"/api/v1/budgets/{bid}", headers=h, json={"amount": 200, "reason": "追加"})
    for i in range(3):
        client.post("/api/v1/expenses", headers=h,
                    json={"project_id": pid, "subject": "差旅", "amount": 10 + i})
    client.post("/api/v1/milestones", headers=h, json={"project_id": pid, "name": "M1"})
    client.post(f"/api/v1/projects/{pid}/followups", headers=h, json={"content": "跟进"})
    client.post("/api/v1/progress-logs", headers=h, json={"task_id": tids[0], "progress": 10})

    for url in ("/api/v1/projects", "/api/v1/tasks", "/api/v1/budgets",
                "/api/v1/budget-adjusts", "/api/v1/expenses", "/api/v1/milestones",
                "/api/v1/progress-logs", f"/api/v1/projects/{pid}/followups",
                "/api/v1/admin/users", "/api/v1/admin/logs",
                "/api/v1/projects/recycle-bin/list"):
        r = client.get(url, headers=ha)
        assert r.status_code == 200, f"{url} -> {r.status_code} {r.text}"
        data = r.json()
        assert isinstance(data, dict), f"{url} 未返回分页信封：{type(data).__name__}"
        assert paged_keys(data), f"{url} 信封字段缺失：{sorted(data.keys())}"
        assert (data["page"], data["size"]) == (1, 20), f"{url} 默认分页不一致：{data['page']}/{data['size']}"
        assert data["total"] >= len(data["items"]), url
        assert len(data["items"]) <= 20, f"{url} 省略分页参数返回了无界数据：{len(data['items'])}"
    # 25 个项目：默认只回当页，total 仍是全量
    got = client.get("/api/v1/projects", headers=ha).json()
    assert got["total"] == 25 and len(got["items"]) == 20


# 32. 非法 page/size/sort 一律 400（含注入式排序字段不会执行任意 SQL）
def test_list_rejects_invalid_page_size_and_sort(client):
    ha = login(client, "admin")
    h = login(client, "pm")
    mkprojects(client, h, 3, prefix="PBad")
    urls = ("/api/v1/projects", "/api/v1/tasks", "/api/v1/budgets", "/api/v1/expenses",
            "/api/v1/budget-adjusts", "/api/v1/admin/logs")
    for url in urls:
        assert client.get(f"{url}?page=0", headers=ha).status_code == 400, url
        assert client.get(f"{url}?page=-3", headers=ha).status_code == 400, url
        assert client.get(f"{url}?size=0", headers=ha).status_code == 400, url
        assert client.get(f"{url}?size=101", headers=ha).status_code == 400, url
        # 白名单外（含注入式负载）的排序字段：400，绝不拼进 SQL
        for bad in ("id%3BDROP%20TABLE%20projects", "amount%22--", "1%3D1",
                    "amount%20desc", "%28select%201%29"):
            assert client.get(f"{url}?sort={bad}", headers=ha).status_code == 400, f"{url} sort={bad}"
    # size 合法上界 100 放行；库表完好、注入未生效
    ok = client.get("/api/v1/projects?size=100", headers=ha)
    assert ok.status_code == 200 and ok.json()["size"] == 100
    assert client.get("/api/v1/projects", headers=ha).status_code == 200


# 33. 翻页边界与排序稳定性：相同排序值下以 id 兜底，不重不漏
def test_paging_boundaries_and_stable_sort(client):
    h = login(client, "pm")
    ps = mkprojects(client, h, 25, prefix="PStab")   # 预算额相同 → 校验 id 兜底
    ids = sorted(p["id"] for p in ps)
    seen = []
    for page in (1, 2, 3):
        data = client.get(f"/api/v1/projects?sort=budget_total&page={page}&size=10", headers=h).json()
        assert data["total"] == 25 and (data["page"], data["size"]) == (page, 10)
        seen += [x["id"] for x in data["items"]]
    assert seen == ids, "相同排序值下翻页必须稳定（id 兜底），不重不漏"
    # 越过末页：空 items，不抛异常、不重复上一页数据
    last = client.get("/api/v1/projects?sort=budget_total&page=4&size=10", headers=h).json()
    assert last["total"] == 25 and last["items"] == []
    assert client.get("/api/v1/projects?page=9999", headers=h).json()["items"] == []
    # 排序方向与多字段排序生效
    desc = client.get("/api/v1/projects?sort=-id&size=5", headers=h).json()
    assert [x["id"] for x in desc["items"]] == sorted(ids, reverse=True)[:5]
    multi = client.get("/api/v1/projects?sort=-budget_total,id&size=5", headers=h).json()
    assert [x["id"] for x in multi["items"]] == ids[:5]


# 34. 筛选组合、越权项目查询、软删除边界与注入式输入
def test_list_filters_scope_and_safe_inputs(client):
    ha = login(client, "admin")
    h = login(client, "pm")
    ho = login(client, "outsider")
    p1 = mkproject(client, h, "PScopeA")
    assert client.post(f"/api/v1/projects/{p1['id']}/status", headers=ha,
                       json={"status": "filed"}).status_code == 200
    p2 = mkproject(client, h, "PScopeB")
    tid2 = client.post("/api/v1/tasks", headers=h,
                       json={"project_id": p2["id"], "name": "T-Hidden"}).json()["id"]
    client.post("/api/v1/tasks", headers=h, json={"project_id": p1["id"], "name": "T-Scope"})
    bid = client.post("/api/v1/budgets", headers=h,
                      json={"project_id": p1["id"], "subject": "人工", "amount": 500}).json()["id"]
    client.post("/api/v1/expenses", headers=h,
                json={"project_id": p1["id"], "subject": "差旅", "amount": 20, "note": "机票"})
    client.post("/api/v1/milestones", headers=h,
                json={"project_id": p1["id"], "name": "M-Scope"})

    # 组合筛选 + 分页信封同时生效
    data = client.get("/api/v1/projects?status=filed&keyword=PScopeA&page=1&size=10", headers=h).json()
    assert data["total"] == 1 and data["items"][0]["id"] == p1["id"]
    assert client.get("/api/v1/projects?status=filed&keyword=PScopeB", headers=h).json()["total"] == 0
    assert client.get("/api/v1/tasks?keyword=T-Scope&size=5", headers=h).json()["total"] == 1
    assert client.get("/api/v1/expenses?subject=差旅&keyword=机票", headers=h).json()["total"] == 1
    assert client.get("/api/v1/expenses?subject=人工", headers=h).json()["total"] == 0
    assert client.get("/api/v1/budgets?subject=人工&sort=-amount", headers=h).json()["items"][0]["id"] == bid
    assert client.get("/api/v1/milestones?status=open", headers=h).json()["total"] == 1
    assert client.get(f"/api/v1/budget-adjusts?project_id={p1['id']}&status=pending",
                      headers=h).json()["total"] == 0

    # 越权项目查询：403；不带 project_id 时只回「可见 + 未软删除」范围（此处为空）
    for url in (f"/api/v1/tasks?project_id={p1['id']}",
                f"/api/v1/budgets?project_id={p1['id']}",
                f"/api/v1/expenses?project_id={p1['id']}",
                f"/api/v1/milestones?project_id={p1['id']}",
                f"/api/v1/progress-logs?project_id={p1['id']}"):
        assert client.get(url, headers=ho).status_code == 403, url
    for url in ("/api/v1/tasks", "/api/v1/budgets", "/api/v1/expenses", "/api/v1/milestones",
                "/api/v1/progress-logs", "/api/v1/budget-adjusts"):
        r = client.get(url, headers=ho).json()
        assert r["total"] == 0 and r["items"] == [], url

    # 软删除项目的子表记录退出所有列表（管理员全局范围也不例外），只在回收站可见
    client.post(f"/api/v1/projects/{p2['id']}/status", headers=ha, json={"status": "cancelled"})
    assert client.delete(f"/api/v1/projects/{p2['id']}", headers=ha).status_code == 200
    assert client.get(f"/api/v1/tasks?project_id={p2['id']}", headers=ha).status_code == 404
    assert all(x["id"] != tid2 for x in items(client.get("/api/v1/tasks", headers=ha)))
    assert any(x["id"] == p2["id"]
               for x in items(client.get("/api/v1/projects/recycle-bin/list", headers=ha)))

    # 注入式输入：keyword 走参数化、sort 走白名单，不执行也不 500
    inj = client.get("/api/v1/projects?keyword=%27%20OR%201%3D1%20--", headers=h)
    assert inj.status_code == 200 and inj.json()["total"] == 0
    assert client.get("/api/v1/projects", headers=h).status_code == 200


# 35. 项目选择器最小字段接口 + meta 字典边界
def test_project_options_and_meta_contract(client):
    h = login(client, "pm")
    ho = login(client, "outsider")
    mkprojects(client, h, 25, prefix="POpt")
    data = client.get("/api/v1/projects/options?keyword=POpt&page=1&size=10", headers=h).json()
    assert paged_keys(data) and data["total"] == 25 and len(data["items"]) == 10
    assert set(data["items"][0].keys()) == {"id", "code", "name", "status", "owner_id", "dept_id"}
    assert client.get("/api/v1/projects/options?page=0", headers=h).status_code == 400
    assert client.get("/api/v1/projects/options?size=101", headers=h).status_code == 400
    # 选择器不泄漏不可见项目
    assert client.get("/api/v1/projects/options?keyword=POpt", headers=ho).json()["items"] == []
    # 人员字典：最小字段 + 服务端硬上限；选择器用分页搜索接口
    users = client.get("/api/v1/meta/users", headers=h).json()
    assert isinstance(users, list) and users
    assert set(users[0].keys()) == {"id", "username", "real_name", "dept_id", "status", "roles"}
    assert len(users) <= 500
    assert [u["username"] for u in client.get("/api/v1/meta/users?keyword=pm", headers=h).json()] == ["pm"]
    sr = client.get("/api/v1/meta/users/search?keyword=pm&page=1&size=1", headers=h).json()
    assert sr["total"] == 1 and len(sr["items"]) == 1
    assert client.get("/api/v1/meta/users/search?size=101", headers=h).status_code == 400
    assert client.get("/api/v1/meta/users?ids=1,2", headers=h).json()
    assert len(client.get("/api/v1/meta/depts", headers=h).json()) <= 500


# 36. 审批待办：有界返回 + totals 与总数口径一致
def test_pending_is_bounded_with_totals(client):
    ha = login(client, "admin")
    h = login(client, "pm")
    assert client.put("/api/v1/admin/params", headers=ha,
                      json={"expense_approval_on": "1"}).status_code == 200
    p = mkproject(client, h, "PPend")
    for i in range(3):
        client.post("/api/v1/expenses", headers=h,
                    json={"project_id": p["id"], "subject": "差旅", "amount": 10 + i})
    data = client.get("/api/v1/approvals/pending?limit=2", headers=ha).json()
    assert data["totals"]["expenses"] == 3 and len(data["expenses"]) == 2
    assert data["total"] == 3 and data["limit"] == 2
    assert client.get("/api/v1/approvals/pending?limit=0", headers=ha).status_code == 400
    assert client.get("/api/v1/approvals/pending?limit=501", headers=ha).status_code == 400
    full = client.get("/api/v1/approvals/pending", headers=ha).json()
    assert len(full["expenses"]) == 3 and full["totals"]["expenses"] == 3
    client.put("/api/v1/admin/params", headers=ha, json={"expense_approval_on": "0"})


# 37. 排序白名单真实生效且默认排序保持不变
def test_sort_whitelist_orders(client):
    h = login(client, "pm")
    p = mkproject(client, h, "PSort")
    for a in (300, 100, 200):
        client.post("/api/v1/expenses", headers=h,
                    json={"project_id": p["id"], "subject": "差旅", "amount": a})
    base = f"/api/v1/expenses?project_id={p['id']}"
    assert [x["amount"] for x in items(client.get(f"{base}&sort=amount", headers=h))] == [100, 200, 300]
    assert [x["amount"] for x in items(client.get(f"{base}&sort=-amount", headers=h))] == [300, 200, 100]
    # 默认 -id（最新在前）保持既有行为
    assert [x["amount"] for x in items(client.get(base, headers=h))] == [200, 100, 300]


def test_admin_issued_phone_user_must_change_password(client, db):
    ha = login(client, "admin")
    r = client.post("/api/v1/admin/users", headers=ha, json={
        "username": "13800138000",
        "password": "InitPass2026",
        "real_name": "新成员",
        "roles": ["member"],
    })
    assert r.status_code == 200, r.text
    S = db()
    from api.models import User
    u = S.query(User).filter_by(username="13800138000").first()
    assert u is not None and u.must_change_pwd is True
    S.close()

    issued = client.post("/api/v1/auth/login", json={
        "username": "13800138000", "password": "InitPass2026",
    })
    assert issued.status_code == 200
    assert issued.json()["must_change_pwd"] is True


def test_project_custom_code_contract_and_contract_attachment_scope(client):
    h = login(client, "pm")
    r = client.post("/api/v1/projects", headers=h, json={
        "name": "合同字段项目",
        "code": "SHzk-2026-088",
        "owner_name": "张爱杰",
        "client": "测试客户",
        "budget_total": 100000,
        "contract_status": "已签订",
        "forward_contract": "前向合同",
        "backward_contract": "后向合同",
    })
    assert r.status_code == 200, r.text
    p = r.json()
    assert p["code"] == "SHzk-2026-088"
    assert p["owner_name"] == "张爱杰"
    assert p["contract_status"] == "已签订"

    att = client.post(
        f"/api/v1/projects/{p['id']}/attachments",
        headers=h,
        files={"file": ("contract.pdf", b"pdf", "application/pdf")},
        data={"ref_type": "contract"},
    )
    assert att.status_code == 200, att.text
    assert client.get(f"/api/v1/projects/{p['id']}/attachments", headers=h).json() == []
    contracts = client.get(
        f"/api/v1/projects/{p['id']}/attachments?ref_type=contract", headers=h
    ).json()
    assert [a["filename"] for a in contracts] == ["contract.pdf"]


# 38. Cookie 登录：access/refresh 为 HttpOnly，CSRF 可由前端读取
def test_cookie_login_sets_secure_session_shape(client):
    r = client.post("/api/v1/auth/login",
                    json={"username": "admin", "password": "admin123456"})
    assert r.status_code == 200, r.text

    cookies = r.headers.get_list("set-cookie")
    access = next(c for c in cookies if c.startswith("pm_access_token="))
    refresh = next(c for c in cookies if c.startswith("pm_refresh_token="))
    csrf = next(c for c in cookies if c.startswith("pm_csrf_token="))
    assert "HttpOnly" in access
    assert "HttpOnly" in refresh
    assert "HttpOnly" not in csrf
    assert "SameSite=lax" in access
    assert "Path=/api/v1/auth" in refresh

    me = client.get("/api/v1/auth/me")
    assert me.status_code == 200
    assert me.json()["username"] == "admin"


# 39. Cookie 写请求缺少 CSRF 必须 403，带对 token 成功
def test_cookie_write_requires_csrf(client):
    r = client.post("/api/v1/auth/login",
                    json={"username": "admin", "password": "admin123456"})
    assert r.status_code == 200

    change_password = {
        "old_password": "admin123456",
        "new_password": "admin1234567",
    }
    denied = client.post("/api/v1/auth/change-password", json=change_password)
    assert denied.status_code == 403

    csrf = client.cookies.get("pm_csrf_token")
    allowed = client.post("/api/v1/auth/change-password", json=change_password,
                          headers={"X-CSRF-Token": csrf})
    assert allowed.status_code == 200


def _expired_session_cookies():
    expired_at = datetime.now(timezone.utc) - timedelta(minutes=1)

    def encode(kind):
        return jwt.encode(
            {"sub": "1", "kind": kind, "jti": f"expired-{kind}", "exp": expired_at},
            SECRET_KEY,
            algorithm=ALGORITHM,
        )

    return {
        settings.access_cookie_name: encode("access"),
        settings.refresh_cookie_name: encode("refresh"),
    }


# 40. 无有效会话也必须幂等清 Cookie
@pytest.mark.parametrize("state", ["missing", "invalid", "expired", "blacklisted"])
def test_logout_without_valid_session_clears_auth_cookies(client, state):
    request_cookies = {}
    access = refresh = ""

    if state == "invalid":
        request_cookies = {
            settings.access_cookie_name: "invalid-access",
            settings.refresh_cookie_name: "invalid-refresh",
        }
    elif state == "expired":
        request_cookies = _expired_session_cookies()
    elif state == "blacklisted":
        login = client.post("/api/v1/auth/login",
                            json={"username": "admin", "password": "admin123456"})
        assert login.status_code == 200, login.text
        access = login.json()["access_token"]
        refresh = login.json()["refresh_token"]
        csrf = client.cookies.get(settings.csrf_cookie_name)
        first = client.post("/api/v1/auth/logout", json={},
                            headers={"X-CSRF-Token": csrf})
        assert first.status_code == 200, first.text
        assert client.get("/api/v1/auth/me",
                          headers={"Authorization": f"Bearer {access}"}).status_code == 401
        assert client.post("/api/v1/auth/refresh",
                           json={"refresh_token": refresh}).status_code == 401
        client.cookies.clear()
        request_cookies = {
            settings.access_cookie_name: access,
            settings.refresh_cookie_name: refresh,
        }

    for name, value in request_cookies.items():
        client.cookies.set(name, value)
    response = client.post("/api/v1/auth/logout")
    assert response.status_code == 200, response.text

    set_cookie = response.headers.get_list("set-cookie")
    deleted = {
        header.split("=", 1)[0]: header
        for header in set_cookie
        if header.startswith((
            f"{settings.access_cookie_name}=",
            f"{settings.refresh_cookie_name}=",
            f"{settings.csrf_cookie_name}=",
        ))
    }
    assert set(deleted) == {
        settings.access_cookie_name,
        settings.refresh_cookie_name,
        settings.csrf_cookie_name,
    }
    assert all("max-age=0" in header.lower() for header in deleted.values())


# 41. Bearer 兼容期不要求 CSRF
def test_bearer_write_remains_compatible(client):
    login = client.post("/api/v1/auth/login",
                        json={"username": "admin", "password": "admin123456"})
    token = login.json()["access_token"]
    client.cookies.clear()

    r = client.post("/api/v1/auth/logout", json={},
                    headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200


# 42. 空 Bearer 不能让 Cookie 会话绕过 CSRF
def test_empty_bearer_does_not_bypass_cookie_csrf(client):
    login = client.post("/api/v1/auth/login",
                        json={"username": "admin", "password": "admin123456"})
    assert login.status_code == 200

    r = client.post("/api/v1/auth/change-password",
                    headers={"Authorization": "Bearer "},
                    json={"old_password": "admin123456", "new_password": "admin1234567"})
    assert r.status_code == 403


# 43. 登出使用统一 Bearer 解析，额外空格的令牌也必须失效
def test_logout_blacklists_bearer_token_with_extra_spaces(client):
    login = client.post("/api/v1/auth/login",
                        json={"username": "admin", "password": "admin123456"})
    assert login.status_code == 200
    token = login.json()["access_token"]
    client.cookies.clear()

    logout = client.post("/api/v1/auth/logout", json={},
                         headers={"Authorization": f"Bearer    {token}"})
    assert logout.status_code == 200

    me = client.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert me.status_code == 401


# 44. refresh 轮换：Cookie 刷新后旧 token 重放返回 401
def test_refresh_rotates_and_rejects_replay(client):
    r = client.post("/api/v1/auth/login",
                    json={"username": "admin", "password": "admin123456"})
    assert r.status_code == 200
    old_refresh = client.cookies.get("pm_refresh_token")
    csrf = client.cookies.get("pm_csrf_token")

    refreshed = client.post("/api/v1/auth/refresh",
                            headers={"X-CSRF-Token": csrf})
    assert refreshed.status_code == 200, refreshed.text
    new_refresh = client.cookies.get("pm_refresh_token")
    assert new_refresh and new_refresh != old_refresh
    csrf = client.cookies.get("pm_csrf_token")

    replay = client.post(
        "/api/v1/auth/refresh",
        json={"refresh_token": old_refresh},
        headers={"X-CSRF-Token": csrf},
    )
    assert replay.status_code == 401


# 45. Bearer 客户端可用请求体 refresh token，不依赖 Cookie
def test_refresh_body_token_supports_legacy_client(client):
    r = client.post("/api/v1/auth/login",
                    json={"username": "admin", "password": "admin123456"})
    refresh = r.json()["refresh_token"]
    client.cookies.clear()

    refreshed = client.post("/api/v1/auth/refresh",
                            json={"refresh_token": refresh})
    assert refreshed.status_code == 200
    assert refreshed.json()["access_token"]
    assert refreshed.json()["refresh_token"]


# 46. 并发 refresh 只允许同一个 refresh token 消费一次
def test_concurrent_refresh_consumes_token_once(client):
    login_response = client.post(
        "/api/v1/auth/login",
        json={"username": "admin", "password": "admin123456"},
    )
    assert login_response.status_code == 200
    refresh = login_response.json()["refresh_token"]
    first_client = TestClient(app, raise_server_exceptions=False)
    second_client = TestClient(app, raise_server_exceptions=False)
    barrier = Barrier(2)
    responses = [None, None]

    def refresh_once(refresh_client, index):
        barrier.wait()
        responses[index] = refresh_client.post(
            "/api/v1/auth/refresh",
            json={"refresh_token": refresh},
        )

    threads = [
        Thread(target=refresh_once, args=(first_client, 0)),
        Thread(target=refresh_once, args=(second_client, 1)),
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    statuses = sorted(response.status_code for response in responses)
    assert statuses == [200, 401]
    successful = [response for response in responses if response.status_code == 200]
    assert len(successful) == 1
    assert successful[0].json()["access_token"]
    assert successful[0].json()["refresh_token"]
