"""Stage 4A 验收 pytest：进度 / 成本 / 审批 / 通知闭环。

覆盖 issue「验收标准」的五项：
  1. 非法任务/支出/预算状态或数值请求 → 明确 4xx 且数据库零副作用；
  2. 驳回支出可重新提交；批准/驳回/特批/预算调整都有申请人、决策人、意见与时间线；
  3. 四类预警可手工构造并生成通知；同一引用在去重窗口内不重复灌入；
  4. 通知点击所需的 ref_type/ref_id/project_id 完整，审批与业务状态最终一致；
  5. 关键写操作审计失败不会被静默当作成功。

复用 tests/test_mvp.py 的 fixture（同库同账号），只新增用例文件，不改既有 40 项断言。
"""
import io
from datetime import date, datetime, timedelta, timezone

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from api.core.database import Base, ensure_fts, get_db
from api.core.security import hash_password
from api.main import app


# ---------------------------------------------------------------- fixtures

@pytest.fixture()
def db(tmp_path):
    """与 test_mvp 同一套隔离库与账号（保持两份测试的参照系一致）。"""
    url = f"sqlite:///{tmp_path}/t4a.db"
    eng = create_engine(url, connect_args={"check_same_thread": False})
    TestingSession = sessionmaker(bind=eng, autoflush=False, autocommit=False)
    Base.metadata.create_all(bind=eng)
    ensure_fts(eng)
    s = TestingSession()
    try:
        from api.models import Department, Role, SysParam, User, UserRole
        d = Department(name="综合部")
        s.add(d)
        s.flush()
        for code, name in [("admin", "系统管理员"), ("project_manager", "项目负责人"),
                           ("member", "项目成员"), ("cost_admin", "成本管理员"),
                           ("dept_manager", "部门负责人"), ("executive", "高层（只读）")]:
            s.add(Role(code=code, name=name))
        s.flush()
        for k, v in {"login_fail_limit": "5", "login_lock_minutes": "15",
                     "budget_warn_rate": "0.8", "budget_approval_on": "0",
                     "expense_approval_on": "0", "milestone_warn_days": "3",
                     "stagnant_days": "7", "notify_dedup_days": "1"}.items():
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
    from fastapi.testclient import TestClient
    return TestClient(app)


PASSWORDS = {"admin": "admin123456", "cost": "cost123456", "outsider": "out123456"}


def login(client, username, pwd="pm123456"):
    r = client.post("/api/v1/auth/login",
                    json={"username": username, "password": PASSWORDS.get(username, pwd)})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


def mkproject(client, h, name="P4A", **kw):
    body = {"name": name, "plan_start": "2026-01-01", "plan_end": "2026-12-31",
            "budget_total": 100000, **kw}
    r = client.post("/api/v1/projects", json=body, headers=h)
    assert r.status_code == 200, r.text
    return r.json()


def items(r):
    data = r.json()
    return data["items"] if isinstance(data, dict) else data


def set_params(client, h, **kw):
    assert client.put("/api/v1/admin/params", headers=h, json=kw).status_code == 200


def seed_plan_dates(db):
    """把项目计划区间拉宽，避免手工造数被「任务/支出落在项目计划内」规则拦住。"""
    from api.models import Project
    s = db()
    for p in s.query(Project).all():
        p.plan_start, p.plan_end = date(2020, 1, 1), date(2030, 12, 31)
    s.commit()
    s.close()


# ============ 1. 非法任务请求：明确 4xx 且零副作用 ============

def test_task_invalid_inputs_have_no_side_effects(client, db):
    h = login(client, "pm")
    p = mkproject(client, h, "P4ATask")
    base = client.get(f"/api/v1/tasks?project_id={p['id']}", headers=h).json()["total"]

    bad = [
        ({"project_id": p["id"], "name": "   "}, "空名称"),
        ({"project_id": p["id"], "name": "负权重", "weight": -1}, "负权重"),
        ({"project_id": p["id"], "name": "零权重", "weight": 0}, "零权重"),
        ({"project_id": p["id"], "name": "区间倒置",
          "plan_start": "2026-06-01", "plan_end": "2026-01-01"}, "计划开始晚于结束"),
        ({"project_id": p["id"], "name": "越出项目区间",
          "plan_start": "2019-01-01", "plan_end": "2026-06-01"}, "早于项目计划开始"),
        ({"project_id": p["id"], "name": "越出项目结束",
          "plan_start": "2026-01-01", "plan_end": "2031-01-01"}, "晚于项目计划结束"),
        ({"project_id": p["id"], "name": "不存在父任务", "parent_id": 999999}, "父任务不存在"),
    ]
    for payload, why in bad:
        r = client.post("/api/v1/tasks", json=payload, headers=h)
        assert r.status_code == 400, f"{why} 应 400，实得 {r.status_code} {r.text}"

    # 零副作用：任务数不变，且没有任何一条脏任务被写进去
    assert client.get(f"/api/v1/tasks?project_id={p['id']}", headers=h).json()["total"] == base
    names = {t["name"] for t in items(client.get(f"/api/v1/tasks?project_id={p['id']}", headers=h))}
    assert not (names & {n for _, n in [(0, x["name"]) for x in bad and [{"name": "负权重"}]]})


def test_task_invalid_update_keeps_original_values(client, db):
    """PATCH 校验失败时不得留下「部分修改」——原任务字段必须一字不变。"""
    h = login(client, "pm")
    p = mkproject(client, h, "P4AUpd")
    a = client.post("/api/v1/tasks", json={"project_id": p["id"], "name": "A", "weight": 2},
                    headers=h).json()
    before = dict(a)

    cases = [
        {"weight": 0},
        {"weight": -5},
        {"plan_start": "2027-01-01", "plan_end": "2026-01-01"},
        {"parent_id": a["id"]},                        # 父任务不能是自己
        {"status": "unknown"},                          # 状态白名单外
        {"progress": 101},                              # 进度越界
        {"progress": -1},
        {"predecessor_id": 999999},                     # 前置不存在
    ]
    for body in cases:
        r = client.patch(f"/api/v1/tasks/{a['id']}", json=body, headers=h)
        assert r.status_code == 400, f"{body} 应 400，实得 {r.status_code} {r.text}"

    after = client.get(f"/api/v1/tasks?project_id={p['id']}", headers=h).json()["items"][0]
    for f in ("name", "weight", "plan_start", "plan_end", "status", "progress",
              "parent_id", "predecessor_id"):
        assert after[f] == before[f], f"{f} 被部分修改：{before[f]} -> {after[f]}"


def test_task_dependency_and_status_consistency(client, db):
    """依赖一致性：前置未完成不得置 done；父子必须同项目；跨项目前置被拒。"""
    h = login(client, "pm")
    p1 = mkproject(client, h, "P4ADep1")
    p2 = mkproject(client, h, "P4ADep2")
    pre = client.post("/api/v1/tasks", json={"project_id": p1["id"], "name": "前置"},
                      headers=h).json()
    suc = client.post("/api/v1/tasks",
                      json={"project_id": p1["id"], "name": "后继", "predecessor_id": pre["id"]},
                      headers=h).json()
    # 前置未完成 → 不能直接置 done / 报 100%
    assert client.patch(f"/api/v1/tasks/{suc['id']}", json={"status": "done"},
                        headers=h).status_code == 400
    assert client.post("/api/v1/progress-logs",
                       json={"task_id": suc["id"], "progress": 100}, headers=h).status_code == 400
    # 前置完成后放行
    assert client.post("/api/v1/progress-logs", json={"task_id": pre["id"], "progress": 100},
                       headers=h).status_code == 200
    assert client.patch(f"/api/v1/tasks/{suc['id']}", json={"status": "done"},
                        headers=h).status_code == 200

    # 跨项目前置：拒绝；同项目父任务约束：拒绝
    other = client.post("/api/v1/tasks", json={"project_id": p2["id"], "name": "别的项目任务"},
                        headers=h).json()
    assert client.post("/api/v1/tasks",
                       json={"project_id": p1["id"], "name": "跨项目前置",
                             "predecessor_id": other["id"]}, headers=h).status_code == 400
    assert client.post("/api/v1/tasks",
                       json={"project_id": p1["id"], "name": "跨项目父", "parent_id": other["id"]},
                       headers=h).status_code == 400
    # 父子环：把父任务设为自己的子任务
    child = client.post("/api/v1/tasks",
                        json={"project_id": p1["id"], "name": "子", "parent_id": pre["id"]},
                        headers=h).json()
    assert client.patch(f"/api/v1/tasks/{pre['id']}", json={"parent_id": child["id"]},
                        headers=h).status_code == 400


def test_task_level_limit_and_import_row_errors(client, db):
    h = login(client, "pm")
    p = mkproject(client, h, "P4ALvl")
    parent = None
    for i in range(5):
        body = {"project_id": p["id"], "name": f"L{i+1}"}
        if parent:
            body["parent_id"] = parent
        r = client.post("/api/v1/tasks", json=body, headers=h)
        assert r.status_code == 200, f"第 {i+1} 级应可创建：{r.text}"
        parent = r.json()["id"]
    assert client.post("/api/v1/tasks",
                       json={"project_id": p["id"], "name": "L6", "parent_id": parent},
                       headers=h).status_code == 400

    # Excel 导入：非法行回报行号且不写入
    from openpyxl import Workbook
    wb = Workbook()
    ws = wb.active
    ws.append(["层级", "名称", "负责人账号", "计划开始", "计划结束", "权重"])
    ws.append([1, "正常", "pm", None, None, 1])
    ws.append([1, "权重为0", "pm", None, None, 0])
    ws.append([1, "区间倒置", "pm", "2026-06-01", "2026-01-01", 1])
    ws.append([9, "层级越界", "pm", None, None, 1])
    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    before = client.get(f"/api/v1/tasks?project_id={p['id']}", headers=h).json()["total"]
    r = client.post(f"/api/v1/tasks/import?project_id={p['id']}", headers=h,
                    files={"file": ("t.xlsx", buf.getvalue(),
                                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")})
    assert r.status_code == 200, r.text
    assert r.json()["created"] == 1
    for line in ("第3行", "第4行", "第5行"):
        assert any(line in e for e in r.json()["errors"]), r.json()["errors"]
    assert client.get(f"/api/v1/tasks?project_id={p['id']}", headers=h).json()["total"] == before + 1


# ============ 进度填报历史不可被直接覆盖 ============

def test_progress_history_is_append_only(client):
    h = login(client, "pm")
    p = mkproject(client, h, "P4ALog")
    t = client.post("/api/v1/tasks", json={"project_id": p["id"], "name": "T1"},
                    headers=h).json()
    for val in (10, 40, 70):
        assert client.post("/api/v1/progress-logs",
                           json={"task_id": t["id"], "progress": val},
                           headers=h).status_code == 200
    # PATCH 任务进度也会追加一条历史，而不是改写旧记录
    assert client.patch(f"/api/v1/tasks/{t['id']}", json={"progress": 90},
                        headers=h).status_code == 200

    logs = items(client.get(f"/api/v1/progress-logs?task_id={t['id']}", headers=h))
    assert [l["progress"] for l in logs] == [90, 70, 40, 10]   # 默认 -id 最新在前
    # 历史不可改：没有任何写接口能修改既有 log
    lid = logs[-1]["id"]
    assert client.patch(f"/api/v1/progress-logs/{lid}", json={"progress": 0},
                        headers=h).status_code == 405
    assert client.delete(f"/api/v1/progress-logs/{lid}", headers=h).status_code == 405
    # 单条详情可查（原始 note/remaining_days 保留）
    assert client.get(f"/api/v1/progress-logs/{lid}", headers=h).status_code == 200
    # 非法填报：越界与非法任务
    assert client.post("/api/v1/progress-logs", json={"task_id": t["id"], "progress": 200},
                       headers=h).status_code == 400
    assert client.post("/api/v1/progress-logs", json={"task_id": 999999, "progress": 1},
                       headers=h).status_code == 404
    # 进度未变（最后一次 90，被拒绝的 200 没有落库）
    assert client.get(f"/api/v1/tasks?project_id={p['id']}", headers=h).json()["items"][0]["progress"] == 90


# ============ 2. 支出：凭证 + 驳回重提 + 意见 + 时间线 ============

def test_expense_invalid_inputs_no_side_effect(client, db):
    h = login(client, "pm")
    ha = login(client, "admin")
    p = mkproject(client, h, "P4AExp")
    seed_plan_dates(db)
    before = client.get(f"/api/v1/expenses?project_id={p['id']}", headers=h).json()["total"]

    bad = [
        ({"project_id": p["id"], "subject": "人工", "amount": 0}, "金额为 0"),
        ({"project_id": p["id"], "subject": "人工", "amount": -100}, "负金额"),
        ({"project_id": p["id"], "subject": "不存在的科目", "amount": 10}, "科目白名单外"),
        ({"project_id": p["id"], "subject": "人工", "amount": 10,
          "exp_date": "2000-01-01"}, "早于项目计划开始"),
        ({"project_id": p["id"], "subject": "人工", "amount": 10,
          "exp_date": "2050-01-01"}, "日期超出合理范围"),
    ]
    for payload, why in bad:
        r = client.post("/api/v1/expenses", json=payload, headers=h)
        assert r.status_code == 400, f"{why} 应 400，实得 {r.status_code} {r.text}"
    assert client.get(f"/api/v1/expenses?project_id={p['id']}", headers=h).json()["total"] == before

    # 预算侧：负金额 / 期间倒置 / 越界 / 科目非法
    for payload, why in [
        ({"project_id": p["id"], "subject": "人工", "amount": -1}, "负预算"),
        ({"project_id": p["id"], "subject": "非法科目", "amount": 1}, "科目非法"),
        ({"project_id": p["id"], "subject": "人工", "amount": 1,
          "period_start": "2026-06-01", "period_end": "2026-01-01"}, "期间倒置"),
    ]:
        r = client.post("/api/v1/budgets", json=payload, headers=h)
        assert r.status_code == 400, f"{why} 应 400，实得 {r.status_code} {r.text}"
    assert client.get(f"/api/v1/budgets?project_id={p['id']}", headers=h).json()["total"] == 0
    # 调整单：金额与现值相同 / 负值
    bid = client.post("/api/v1/budgets",
                      json={"project_id": p["id"], "subject": "人工", "amount": 1000,
                            "period_start": "2026-01-01", "period_end": "2026-12-31"},
                      headers=h).json()["id"]
    assert client.patch(f"/api/v1/budgets/{bid}", json={"amount": 1000},
                        headers=h).status_code == 400
    assert client.patch(f"/api/v1/budgets/{bid}", json={"amount": -5},
                        headers=h).status_code == 400
    assert client.get("/api/v1/budget-adjusts", headers=ha).json()["total"] == 0


def test_expense_voucher_roundtrip(client, db):
    """凭证附件：上传 → 申请人可见可下载 → 越权人不可见 → 删除。"""
    h = login(client, "pm")
    ha = login(client, "admin")
    ho = login(client, "outsider")
    p = mkproject(client, h, "P4AVoucher")
    set_params(client, ha, expense_approval_on="1")
    e = client.post("/api/v1/expenses",
                    json={"project_id": p["id"], "subject": "采购", "amount": 500},
                    headers=h).json()
    assert e["status"] == "pending"

    up = client.post(f"/api/v1/expenses/{e['id']}/vouchers", headers=h,
                     files={"file": ("发票.png", b"fakeinvoice", "image/png")})
    assert up.status_code == 200, up.text
    vid = up.json()["id"]
    # 非法类型与空文件
    assert client.post(f"/api/v1/expenses/{e['id']}/vouchers", headers=h,
                       files={"file": ("x.exe", b"MZ", "application/octet-stream")}).status_code == 400
    assert client.post(f"/api/v1/expenses/{e['id']}/vouchers", headers=h,
                       files={"file": ("empty.png", b"", "image/png")}).status_code == 400

    lst = client.get(f"/api/v1/expenses/{e['id']}/vouchers", headers=h)
    assert len(lst.json()) == 1 and lst.json()[0]["filename"] == "发票.png"
    dl = client.get(f"/api/v1/expenses/{e['id']}/vouchers/{vid}/download", headers=h)
    assert dl.status_code == 200 and dl.content == b"fakeinvoice"
    # 非参与人：支出不可见（项目级 403/404），凭证列表与下载同样被拒
    assert client.get(f"/api/v1/expenses/{e['id']}/vouchers", headers=ho).status_code in (403, 404)
    assert client.get(f"/api/v1/expenses/{e['id']}/vouchers/{vid}/download",
                      headers=ho).status_code in (403, 404)
    # 越权删除被拒；本人可删
    assert client.delete(f"/api/v1/expenses/{e['id']}/vouchers/{vid}",
                         headers=ho).status_code in (403, 404)
    assert client.delete(f"/api/v1/expenses/{e['id']}/vouchers/{vid}",
                         headers=h).status_code == 200
    assert client.get(f"/api/v1/expenses/{e['id']}/vouchers", headers=h).json() == []
    set_params(client, ha, expense_approval_on="0")


def test_expense_voucher_not_leaked_into_project_attachments(client, db):
    """支出凭证不得混进项目附件列表/下载入口（否则文件名与上传人对外泄漏）。"""
    h = login(client, "pm")
    p = mkproject(client, h, "P4AVLeak")
    # 一个正常项目附件
    proj_att = client.post(f"/api/v1/projects/{p['id']}/attachments", headers=h,
                           files={"file": ("方案.pdf", b"doc", "application/pdf")}).json()
    e = client.post("/api/v1/expenses",
                    json={"project_id": p["id"], "subject": "采购", "amount": 10},
                    headers=h).json()
    v = client.post(f"/api/v1/expenses/{e['id']}/vouchers", headers=h,
                    files={"file": ("发票.png", b"inv", "image/png")}).json()

    listed = client.get(f"/api/v1/projects/{p['id']}/attachments", headers=h).json()
    assert [x["id"] for x in listed] == [proj_att["id"]]
    # 项目附件下载入口不得取到凭证；支出凭证入口不得取到项目附件
    assert client.get(f"/api/v1/projects/{p['id']}/attachments/{v['id']}/download",
                      headers=h).status_code == 404
    assert client.get(f"/api/v1/expenses/{e['id']}/vouchers/{proj_att['id']}/download",
                      headers=h).status_code == 404
    # 项目附件删除入口也不得删掉凭证
    assert client.delete(f"/api/v1/projects/{p['id']}/attachments/{v['id']}",
                         headers=h).status_code == 404
    assert len(client.get(f"/api/v1/expenses/{e['id']}/vouchers", headers=h).json()) == 1


def test_expense_reject_reason_resubmit_timeline(client, db):
    """驳回 → 申请人在列表看到原因 → 修正后重新提交 → 时间线保留全部状态变化。"""
    h = login(client, "pm")
    ha = login(client, "admin")
    p = mkproject(client, h, "P4AResub")
    set_params(client, ha, expense_approval_on="1")
    e = client.post("/api/v1/expenses",
                    json={"project_id": p["id"], "subject": "差旅", "amount": 800,
                          "note": "初次提交"}, headers=h).json()
    eid = e["id"]
    assert e["status"] == "pending" and e["can_resubmit"] is False

    # 驳回必须给意见
    assert client.post(f"/api/v1/expenses/{eid}/reject", json={"reason": "  "},
                       headers=ha).status_code == 400
    r = client.post(f"/api/v1/expenses/{eid}/reject", json={"reason": "缺少发票"},
                    headers=ha)
    assert r.status_code == 200 and r.json()["status"] == "rejected"
    assert r.json()["decision_reason"] == "缺少发票"

    # 申请人视角：列表里直接看到驳回原因，且标记可重提
    row = next(x for x in items(client.get(f"/api/v1/expenses?mine=1", headers=h))
               if x["id"] == eid)
    assert row["status"] == "rejected" and row["decision_reason"] == "缺少发票"
    assert row["can_resubmit"] is True and row["approved_by"] is not None
    # 申请人可查时间线（非管理员也放行）
    tl = client.get(f"/api/v1/expenses/{eid}/timeline", headers=h).json()
    assert [x["action"] for x in tl["items"]] == ["submit", "reject"]
    assert tl["items"][-1]["reason"] == "缺少发票" and tl["items"][-1]["actor_id"] is not None

    # 非申请人（同项目其他人）不能重提：outsider 连项目都不可见 → 403/404
    ho = login(client, "outsider")
    assert client.post(f"/api/v1/expenses/{eid}/resubmit", json={},
                       headers=ho).status_code in (403, 404)

    # 重新提交：修正金额 + 追加凭证
    rs = client.post(f"/api/v1/expenses/{eid}/resubmit",
                     json={"amount": 300, "note": "改为实际金额并补发票"}, headers=h)
    assert rs.status_code == 200, rs.text
    assert rs.json()["status"] == "pending" and rs.json()["resubmit_count"] == 1
    assert rs.json()["decision_reason"] == ""      # 重提清空当前意见，历史仍保留在时间线
    assert rs.json()["amount"] == 300
    assert client.post(f"/api/v1/expenses/{eid}/vouchers", headers=h,
                       files={"file": ("发票.png", b"inv", "image/png")}).status_code == 200

    tl2 = client.get(f"/api/v1/expenses/{eid}/timeline", headers=h).json()
    actions = [x["action"] for x in tl2["items"]]
    assert actions == ["submit", "reject", "resubmit"]
    assert tl2["items"][1]["reason"] == "缺少发票"          # 驳回意见不被覆盖
    # 已非 rejected：再次重提被拒
    assert client.post(f"/api/v1/expenses/{eid}/resubmit", json={},
                       headers=h).status_code == 400

    # 管理员通过：业务状态与审批记录最终一致
    ap = client.post(f"/api/v1/approvals/expense/{eid}/decide", headers=ha,
                     json={"approve": True, "reason": "已补票"})
    assert ap.status_code == 200 and ap.json()["status"] == "approved"
    tl3 = client.get(f"/api/v1/expenses/{eid}/timeline", headers=h).json()
    assert tl3["items"][-1]["action"] == "approve" and tl3["items"][-1]["reason"] == "已补票"
    row2 = next(x for x in items(client.get("/api/v1/expenses?mine=1", headers=h))
                if x["id"] == eid)
    assert row2["status"] == "approved" and row2["decision_reason"] == "已补票"
    assert row2["can_resubmit"] is False
    set_params(client, ha, expense_approval_on="0")


def test_expense_exception_requires_reason_and_records_decision(client, db):
    """特批：理由必填；申请人、决策人、意见、时间全部可查。"""
    h = login(client, "pm")
    ha = login(client, "admin")
    p = mkproject(client, h, "P4AExc")
    client.post("/api/v1/budgets", headers=h,
                json={"project_id": p["id"], "subject": "采购", "amount": 100,
                      "period_start": "2026-01-01", "period_end": "2026-12-31"})
    set_params(client, ha, expense_approval_on="1")
    e = client.post("/api/v1/expenses",
                    json={"project_id": p["id"], "subject": "采购", "amount": 500},
                    headers=h).json()
    eid = e["id"]
    assert e["status"] == "pending" and e["over_budget"] is True

    assert client.post(f"/api/v1/expenses/{eid}/exception", json={"reason": ""},
                       headers=ha).status_code == 400
    assert client.post(f"/api/v1/approvals/expense/{eid}/exception", json={},
                       headers=ha).status_code == 400
    r = client.post(f"/api/v1/expenses/{eid}/exception", json={"reason": "紧急复工需要"},
                    headers=ha)
    assert r.status_code == 200 and r.json()["status"] == "exception"
    assert r.json()["decision_reason"] == "紧急复工需要"
    assert r.json()["approved_by"] is not None and r.json()["decided_at"] is not None

    tl = client.get(f"/api/v1/expenses/{eid}/timeline", headers=h).json()
    ex_rec = [x for x in tl["items"] if x["action"] == "exception"]
    assert ex_rec and ex_rec[0]["reason"] == "紧急复工需要"
    assert ex_rec[0]["actor_id"] == r.json()["approved_by"]
    # 申请人收到带定位引用的结果通知
    n = items(client.get("/api/v1/notifications?type=approval", headers=h))
    hit = [x for x in n if x["ref_type"] == "expense" and x["ref_id"] == eid]
    assert hit and hit[0]["state"] == "pending"
    set_params(client, ha, expense_approval_on="0")


# ============ 3. 预算调整：意见 + 时间线 + 自动生效不冒充人工审批 ============

def test_budget_adjust_decision_and_timeline(client, db):
    h = login(client, "pm")
    ha = login(client, "admin")
    p = mkproject(client, h, "P4AAdj")
    set_params(client, ha, budget_approval_on="1")
    bid = client.post("/api/v1/budgets", headers=h,
                      json={"project_id": p["id"], "subject": "人工", "amount": 1000,
                            "period_start": "2026-01-01", "period_end": "2026-12-31"}).json()["id"]
    adj = client.patch(f"/api/v1/budgets/{bid}", headers=h,
                       json={"amount": 1500, "reason": "追加人力"}).json()
    aid = adj["id"]
    assert adj["status"] == "pending" and adj["subject"] == "人工"

    # 驳回必填意见
    assert client.post(f"/api/v1/approvals/budget_adjust/{aid}/decide", headers=ha,
                       json={"approve": False}).status_code == 400
    r = client.post(f"/api/v1/approvals/budget_adjust/{aid}/decide", headers=ha,
                    json={"approve": False, "reason": "走外包更合适"})
    assert r.status_code == 200 and r.json()["status"] == "rejected"
    # 驳回后预算不变
    budgets = items(client.get(f"/api/v1/budgets?project_id={p['id']}", headers=h))
    assert budgets[0]["amount"] == 1000

    # 申请人自查（mine=1）能看到意见与决策人；时间线完整
    mine = items(client.get("/api/v1/budget-adjusts?mine=1", headers=h))
    assert mine[0]["decision_reason"] == "走外包更合适" and mine[0]["approved_by"] is not None
    tl = client.get(f"/api/v1/budget-adjusts/{aid}/timeline", headers=h).json()
    assert [x["action"] for x in tl["items"]] == ["submit", "reject"]
    assert tl["items"][-1]["reason"] == "走外包更合适"

    # 再次提交 → 通过：预算生效且带意见
    adj2 = client.patch(f"/api/v1/budgets/{bid}", headers=h,
                        json={"amount": 1800, "reason": "重新申请"}).json()
    ap = client.post(f"/api/v1/budget-adjusts/{adj2['id']}/approve", headers=ha,
                     json={"approve": True, "reason": "同意追加"})
    assert ap.status_code == 200 and ap.json()["status"] == "approved"
    assert ap.json()["decision_reason"] == "同意追加"
    assert items(client.get(f"/api/v1/budgets?project_id={p['id']}", headers=h))[0]["amount"] == 1800

    # 重复审批被拒（状态已不是 pending）
    assert client.post(f"/api/v1/budget-adjusts/{adj2['id']}/approve", headers=ha,
                       json={"approve": True}).status_code == 404
    set_params(client, ha, budget_approval_on="0")


def test_budget_auto_approve_is_not_marked_as_human_decision(client, db):
    """审批开关关闭 = 系统自动生效：approved_by 必须留空，不把申请人误记为审批人。"""
    h = login(client, "pm")
    ha = login(client, "admin")
    p = mkproject(client, h, "P4AAuto")
    set_params(client, ha, budget_approval_on="0")
    bid = client.post("/api/v1/budgets", headers=h,
                      json={"project_id": p["id"], "subject": "人工", "amount": 1000,
                            "period_start": "2026-01-01", "period_end": "2026-12-31"}).json()["id"]
    adj = client.patch(f"/api/v1/budgets/{bid}", headers=h, json={"amount": 2000}).json()
    assert adj["status"] == "approved"
    row = items(client.get("/api/v1/budget-adjusts?mine=1", headers=h))[0]
    assert row["approved_by"] is None
    tl = client.get(f"/api/v1/budget-adjusts/{adj['id']}/timeline", headers=h).json()
    assert [x["action"] for x in tl["items"]] == ["submit", "auto_approve"]
    assert tl["items"][-1]["actor_id"] is None


# ============ 4. 四类预警可手工构造 + 去重窗口 ============

def _seed_warning_fixtures(client, db, h):
    """手工构造四类预警：逾期任务 / 里程碑临近 / 项目停滞 / 预算预警。

    返回 (project, task, plan_start_iso, plan_end_iso)；日期在 session 关闭前取出，
    避免 ORM 对象游离后访问属性报 DetachedInstanceError。
    """
    from api.models import Project
    p = mkproject(client, h, "P4AWarn")
    s = db()
    row = s.query(Project).filter_by(id=p["id"]).first()
    row.plan_start = date.today() - timedelta(days=120)
    row.plan_end = date.today() + timedelta(days=200)
    row.status = "doing"
    s.commit()
    ps, pe = row.plan_start.isoformat(), row.plan_end.isoformat()
    s.close()

    t = client.post("/api/v1/tasks", headers=h,
                    json={"project_id": p["id"], "name": "逾期任务",
                          "plan_start": (date.today() - timedelta(days=60)).isoformat(),
                          "plan_end": (date.today() - timedelta(days=10)).isoformat()}).json()
    near = (date.today() + timedelta(days=2)).isoformat()
    client.post("/api/v1/milestones", headers=h,
                json={"project_id": p["id"], "name": "临近里程碑", "plan_date": near})
    # 预算预警：预算 10000 / 支出 9000 → 90%
    client.post("/api/v1/budgets", headers=h,
                json={"project_id": p["id"], "subject": "人工", "amount": 10000,
                      "period_start": ps, "period_end": pe})
    client.post("/api/v1/expenses", headers=h,
                json={"project_id": p["id"], "subject": "人工", "amount": 9000,
                      "exp_date": date.today().isoformat()})
    return p, t


def test_four_warning_types_detected(client, db):
    """四类预警都能被手工构造并被 /reports/warnings 识别（口径可复现）。"""
    h = login(client, "pm")
    p, t = _seed_warning_fixtures(client, db, h)
    w = client.get("/api/v1/reports/warnings", headers=h).json()
    assert any(x["task_id"] == t["id"] for x in w["overdue_tasks"])
    assert any(x["project_id"] == p["id"] for x in w["milestones"])
    assert any(x["project_id"] == p["id"] for x in w["stagnant_projects"])
    assert any(x["project_id"] == p["id"] and x["subject"] == "人工"
               for x in w["budget_warnings"])
    # 每条预警都带可定位引用三元组
    for key in ("overdue_tasks", "milestones", "stagnant_projects", "budget_warnings"):
        for row in w[key]:
            assert row.get("ref_type") and row.get("ref_id") and row.get("project_id"), key


def test_warnings_produce_notifications_with_complete_refs(client, db):
    """四类预警落库为通知：ref_type/ref_id/project_id 完整，且 link 可定位。"""
    h = login(client, "pm")
    p, t = _seed_warning_fixtures(client, db, h)
    got = client.get("/api/v1/notifications?size=100", headers=h).json()
    types = {x["type"] for x in got["items"]}
    assert {"overdue_task", "milestone", "budget"} <= types, types
    for x in got["items"]:
        assert x["ref_type"] and x["ref_id"] and x["project_id"], x
        assert x["link"], x
        assert x["ref_complete"] is True
    task_note = next(x for x in got["items"] if x["type"] == "overdue_task")
    assert task_note["ref_id"] == t["id"]
    assert task_note["project_id"] == p["id"]
    assert str(t["id"]) in task_note["link"]


def test_notification_dedup_window_blocks_repeat(client, db):
    """去重窗口：同一引用在窗口内不重复灌入；窗口可配且状态计数可追踪。"""
    h = login(client, "pm")
    p, t = _seed_warning_fixtures(client, db, h)
    first = client.get("/api/v1/notifications?size=100", headers=h).json()
    assert first["dedup_days"] == 1
    # 清掉同步节流，强制重算预警：同一引用不得再次写入
    from api.models import Notification, SysParam
    s = db()
    s.query(SysParam).filter_by(key="notifications_synced_at").first().value = ""
    s.commit()
    before = s.query(Notification).count()
    s.close()
    second = client.get("/api/v1/notifications?size=100", headers=h).json()
    assert second["total"] == first["total"], "去重窗口内不应重复灌入"
    s = db()
    assert s.query(Notification).count() == before
    s.close()

    # 窗口设为 0 = 关闭去重（此时允许重复），再次同步条数应增长
    client.put("/api/v1/admin/params", headers=login(client, "admin"),
               json={"notify_dedup_days": "0"})
    s = db()
    s.query(SysParam).filter_by(key="notifications_synced_at").first().value = ""
    s.commit()
    s.close()
    client.get("/api/v1/notifications?size=100", headers=h)
    s = db()
    grew = s.query(Notification).count()
    s.close()
    assert grew > before, "关闭去重后应能重新推送"
    client.put("/api/v1/admin/params", headers=login(client, "admin"),
               json={"notify_dedup_days": "1"})


def test_notification_state_tracking_and_link(client, db):
    """通知处理状态：标记已处理/已忽略带处理人与时间；未读与待处理计数分开。"""
    h = login(client, "pm")
    p, t = _seed_warning_fixtures(client, db, h)
    got = client.get("/api/v1/notifications?size=100", headers=h).json()
    assert got["pending"] >= 1
    nid = got["items"][0]["id"]
    assert client.get(f"/api/v1/notifications/{nid}", headers=h).json()["ref_available"] is True

    r = client.post(f"/api/v1/notifications/{nid}/handle",
                    json={"state": "done", "note": "已与项目组确认"}, headers=h)
    assert r.status_code == 200
    body = r.json()
    assert body["state"] == "done" and body["handled_by"] is not None
    assert body["handled_at"] and body["handle_note"] == "已与项目组确认"
    assert body["read"] is True
    # 非法状态
    assert client.post(f"/api/v1/notifications/{nid}/handle", json={"state": "x"},
                       headers=h).status_code == 400
    # 按状态筛选与批量处理
    pend = client.get("/api/v1/notifications?state=pending&size=100", headers=h).json()
    assert all(x["state"] == "pending" for x in pend["items"])
    hd = client.post("/api/v1/notifications/handle-all", json={"state": "ignored"}, headers=h)
    assert hd.status_code == 200 and hd.json()["state"] == "ignored"
    assert client.get("/api/v1/notifications/count", headers=h).json()["pending"] == 0
    # 越权：他人的通知不可处理
    ho = login(client, "outsider")
    assert client.post(f"/api/v1/notifications/{nid}/handle", json={},
                       headers=ho).status_code == 404


def test_followup_remind_state_is_tracked_and_not_repeated(client, db):
    """跟进提醒：到期可生成通知且带 followup 引用；推送后标记已通知，不会无限重复。"""
    from api.models import Followup, SysParam
    h = login(client, "pm")
    p = mkproject(client, h, "P4AFollow")
    past = (datetime.now(timezone.utc) - timedelta(hours=2)).isoformat()
    f = client.post(f"/api/v1/projects/{p['id']}/followups", headers=h,
                    json={"method": "电话", "content": "回访客户", "remind_at": past})
    assert f.status_code == 200
    fid = f.json()["id"]
    assert f.json()["remind_state"] == "pending"
    # 提醒时间早于跟进时间 → 400
    assert client.post(f"/api/v1/projects/{p['id']}/followups", headers=h,
                       json={"method": "电话", "happened_at": "2026-06-01T10:00:00+00:00",
                             "remind_at": "2026-05-01T10:00:00+00:00"}).status_code == 400
    # 非法跟进方式
    assert client.post(f"/api/v1/projects/{p['id']}/followups", headers=h,
                       json={"method": "微信"}).status_code == 400

    # 手工触发同步 → 生成 followup 通知并标记已通知
    from api.core.jobs import due_followups, sync_notifications
    s = db()
    assert any(x["followup_id"] == fid for x in due_followups(s))
    sync_notifications(s, max_per_type=50)
    row = s.query(Followup).filter_by(id=fid).first()
    assert row.remind_state == "done" and row.reminded_at is not None
    # 已通知的不再进入扫描 → 同一到期记录不会重复灌入
    assert not any(x["followup_id"] == fid for x in due_followups(s))
    s.close()

    notes = items(client.get("/api/v1/notifications?size=100", headers=h))
    hit = [x for x in notes if x["ref_type"] == "followup" and x["ref_id"] == fid]
    assert len(hit) == 1, f"跟进提醒应只推一次，实得 {len(hit)}"
    assert hit[0]["project_id"] == p["id"] and hit[0]["link"]

    # 处理提醒：记录处理人/时间/备注
    r = client.post(f"/api/v1/projects/{p['id']}/followups/{fid}/remind",
                    json={"state": "done", "note": "已电话沟通"}, headers=h)
    assert r.status_code == 200 and r.json()["remind_state"] == "done"
    assert r.json()["handled_by"] is not None and r.json()["handle_note"] == "已电话沟通"
    # 清空 remind_at → 退出提醒队列
    assert client.patch(f"/api/v1/projects/{p['id']}/followups/{fid}", headers=h,
                        json={"remind_at": None}).json()["remind_state"] == "none"
    assert client.post(f"/api/v1/projects/{p['id']}/followups/{fid}/remind",
                       json={"state": "done"}, headers=h).status_code == 400


# ============ 5. 审批中心：全局规则、无 N+1、状态一致 ============

def test_approvals_pending_global_and_bounded(client, db):
    """审批中心按管理员全局规则聚合；kind 过滤与 totals 口径一致；非法 limit/kind 400。"""
    ha = login(client, "admin")
    h = login(client, "pm")
    set_params(client, ha, project_approval_on="1", expense_approval_on="1",
               budget_approval_on="1")
    p1 = mkproject(client, h, "P4APend1")
    p2 = mkproject(client, h, "P4APend2")
    for p in (p1, p2):
        bid = client.post("/api/v1/budgets", headers=h,
                          json={"project_id": p["id"], "subject": "人工", "amount": 1000,
                                "period_start": "2026-01-01",
                                "period_end": "2026-12-31"}).json()["id"]
        client.patch(f"/api/v1/budgets/{bid}", headers=h, json={"amount": 1200})
        client.post("/api/v1/expenses", headers=h,
                    json={"project_id": p["id"], "subject": "人工", "amount": 100})

    full = client.get("/api/v1/approvals/pending", headers=ha).json()
    assert full["totals"]["project_filings"] == 2
    assert full["totals"]["budget_adjusts"] == 2
    assert full["totals"]["expenses"] == 2
    assert full["total"] == 6
    # 行内 can_decide 与决策入口一致；申请人姓名批量填充（无 N+1 也可见）
    assert all(x["can_decide"] is True for x in full["project_filings"])
    assert all(x["applicant_name"] for x in full["project_filings"])
    assert all(x["project_name"] for x in full["budget_adjusts"] + full["expenses"])
    # kind 过滤：只回一类，totals 仍是全量口径
    only = client.get("/api/v1/approvals/pending?kind=expense", headers=ha).json()
    assert len(only["expenses"]) == 2 and only["budget_adjusts"] == [] \
        and only["project_filings"] == []
    assert only["totals"]["expenses"] == 2
    assert only["total"] == 2
    # 有界返回
    bounded = client.get("/api/v1/approvals/pending?limit=1", headers=ha).json()
    assert len(bounded["expenses"]) == 1 and bounded["totals"]["expenses"] == 2
    assert client.get("/api/v1/approvals/pending?limit=0", headers=ha).status_code == 400
    assert client.get("/api/v1/approvals/pending?limit=501", headers=ha).status_code == 400
    assert client.get("/api/v1/approvals/pending?kind=nope", headers=ha).status_code == 400

    # 决策：业务状态、审批记录与待办口径最终一致
    eid = full["expenses"][0]["id"]
    assert client.post(f"/api/v1/approvals/expense/{eid}/decide", headers=ha,
                       json={"approve": True, "reason": "同意"}).status_code == 200
    after = client.get("/api/v1/approvals/pending", headers=ha).json()
    assert after["totals"]["expenses"] == 1
    tl = client.get(f"/api/v1/approvals/expense/{eid}/timeline", headers=ha).json()
    assert [x["action"] for x in tl["items"]] == ["submit", "approve"]
    set_params(client, ha, project_approval_on="0", expense_approval_on="0",
               budget_approval_on="0")


def test_approvals_decide_rejects_and_missing_reason(client, db):
    """决策边界：驳回必填意见；未知 kind 400；非管理员 403 且零状态变更。"""
    ha = login(client, "admin")
    h = login(client, "pm")
    ho = login(client, "cost")
    set_params(client, ha, project_approval_on="1")
    p = mkproject(client, h, "P4ADecide")
    assert client.post(f"/api/v1/approvals/{'project_filing'}/{p['id']}/decide", headers=ha,
                       json={"approve": False}).status_code == 400
    assert client.post(f"/api/v1/approvals/nope/1/decide", headers=ha,
                       json={"approve": True}).status_code == 400
    assert client.post(f"/api/v1/approvals/project_filing/{p['id']}/decide", headers=ho,
                       json={"approve": True}).status_code == 403
    assert client.get("/api/v1/approvals/pending", headers=ho).status_code == 403
    # 状态未被越权改动
    assert client.get(f"/api/v1/projects/{p['id']}", headers=ha).json()["status"] == "pending"
    r = client.post(f"/api/v1/approvals/project_filing/{p['id']}/decide", headers=ha,
                    json={"approve": False, "reason": "预算依据不足"})
    assert r.status_code == 200 and r.json()["status"] == "cancelled"
    tl = client.get("/api/v1/approvals/project_filing/" + str(p["id"]) + "/timeline",
                    headers=ha).json()
    assert tl["items"][-1]["action"] == "reject"
    assert tl["items"][-1]["reason"] == "预算依据不足"
    set_params(client, ha, project_approval_on="0")


def test_project_filing_decision_visible_to_applicant(client, db):
    """立项审批结果对申请人可见可查（时间线 + 通知）。"""
    ha = login(client, "admin")
    h = login(client, "pm")
    set_params(client, ha, project_approval_on="1")
    p = mkproject(client, h, "P4AFiling")
    assert p["status"] == "pending"
    assert client.post(f"/api/v1/approvals/project_filing/{p['id']}/decide", headers=ha,
                       json={"approve": True, "reason": "符合年度计划"}).status_code == 200
    notes = items(client.get("/api/v1/notifications?type=approval&size=100", headers=h))
    hit = [x for x in notes if x["ref_type"] == "project" and x["ref_id"] == p["id"]
           and "通过" in x["title"]]
    assert hit, notes
    assert hit[0]["body"] == "符合年度计划"
    assert hit[0]["project_id"] == p["id"]
    set_params(client, ha, project_approval_on="0")


# ============ 6. 审计失败不会被静默当作成功 ============

def test_audit_failure_is_not_silently_swallowed(client, db, monkeypatch):
    """关键写操作审计失败 → 接口 500 且业务变更回滚，绝不静默成功。"""
    from api.core import audit as audit_mod
    from api.models import ApprovalRecord, AuditLog, Expense, Task

    h = login(client, "pm")
    ha = login(client, "admin")
    p = mkproject(client, h, "P4AAudit")
    # 先开审批开关（本调用自身也要写审计，必须在注入故障之前完成）
    set_params(client, ha, expense_approval_on="1")

    # 让 AuditLog 写入必然抛错：模拟审计表故障
    def boom(*_a, **_kw):
        raise RuntimeError("audit storage down")

    monkeypatch.setattr(audit_mod, "_row", boom)

    # 建任务：必须 500 且任务未落库
    r = client.post("/api/v1/tasks", json={"project_id": p["id"], "name": "审计失败任务"},
                    headers=h)
    assert r.status_code == 500, r.text
    s = db()
    assert s.query(Task).filter_by(name="审计失败任务").count() == 0
    s.close()

    # 建支出：同样 500 且零副作用（含时间线也不应留下孤儿数据）
    r2 = client.post("/api/v1/expenses",
                     json={"project_id": p["id"], "subject": "人工", "amount": 50}, headers=h)
    assert r2.status_code == 500, r2.text
    s = db()
    assert s.query(Expense).filter_by(project_id=p["id"]).count() == 0
    assert s.query(ApprovalRecord).filter_by(kind="expense").count() == 0
    s.close()

    # 恢复审计写入后，同一请求恢复正常（证明失败是审计导致的，不是别的原因）
    monkeypatch.undo()
    ok = client.post("/api/v1/tasks", json={"project_id": p["id"], "name": "恢复后任务"},
                     headers=h)
    assert ok.status_code == 200, ok.text
    s = db()
    assert s.query(Task).filter_by(name="恢复后任务").count() == 1
    assert s.query(AuditLog).filter_by(action="create_task").count() >= 1
    s.close()
    set_params(client, ha, expense_approval_on="0")


def test_audit_written_for_decision_paths(client, db):
    """审批/特批/调整决策都在审计里留下记录（有状态变化必有留痕）。"""
    h = login(client, "pm")
    ha = login(client, "admin")
    p = mkproject(client, h, "P4AAuditOk")
    set_params(client, ha, expense_approval_on="1")
    e = client.post("/api/v1/expenses",
                    json={"project_id": p["id"], "subject": "人工", "amount": 100},
                    headers=h).json()
    client.post(f"/api/v1/expenses/{e['id']}/reject", json={"reason": "先补充材料"}, headers=ha)
    client.post(f"/api/v1/expenses/{e['id']}/resubmit", json={"amount": 80}, headers=h)
    client.post(f"/api/v1/approvals/expense/{e['id']}/decide", headers=ha,
                json={"approve": True, "reason": "同意"})
    logs = items(client.get("/api/v1/admin/logs?size=100", headers=ha))
    actions = {l["action"] for l in logs}
    assert {"create_expense", "reject_expense", "resubmit_expense", "decide_expense"} <= actions
    set_params(client, ha, expense_approval_on="0")
