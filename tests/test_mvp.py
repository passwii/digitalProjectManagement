"""MVP 验收 pytest（Stage1-4）：≥10 用例，未登录 401 必测。隔离库：tmp sqlite + dependency_overrides。"""
import io
from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from api.core.database import Base, ensure_fts, get_db
from api.core.security import hash_password
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
    assert client.get(f"/api/v1/expenses?project_id={p['id']}", headers=ha).json()[0]["status"] == "pending"
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
    assert client.get(f"/api/v1/projects/{p['id']}/followups", headers=h).json() == []


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
    bin_rows = client.get("/api/v1/projects/recycle-bin/list", headers=ha).json()
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
    asserts = client.get("/api/v1/budget-adjusts?status=pending", headers=ha).json()
    assert any(x["id"] == aid for x in asserts)
    assert client.get(f"/api/v1/expenses?project_id={p['id']}", headers=ha).json()[0]["status"] == "pending"
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
    assert any(x["id"] == p["id"] for x in client.get("/api/v1/projects/recycle-bin/list", headers=ha).json())
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
    assert any(x["id"] == p2["id"] for x in client.get("/api/v1/projects/recycle-bin/list", headers=ha).json())
    assert client.post(f"/api/v1/projects/{p2['id']}/restore", headers=ha).status_code == 200
    assert p2["id"] in filings()
    # 回收站属管理面：非管理员连查看都 403
    assert client.get("/api/v1/projects/recycle-bin/list", headers=hpm).status_code == 403
    client.put("/api/v1/admin/params", headers=ha, json={"project_approval_on": "0"})
