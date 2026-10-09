"""功能模块驱动的项目数据范围：任一基础模块 → 项目数据全局可读写。

契约（对齐用户决策「有模块就能看全部/写全部」）：
  · 拥有任一解锁项目内容的模块（opportunities/projects/assets/reports）：
    项目台账/支出报表/工作台的内容与子资源（任务/预算/支出/里程碑）全局可见、全局可写；
    独立业务规则仍在范围之上（进度只能报自己的任务、快照确认仅负责人）。
  · 未拥有基础模块的用户维持「负责人/成员」参与范围；项目内容入口由路由门禁 403。
"""
from test_mvp import login, mkproject


def _mk_user(client, admin_h, username, modules):
    r = client.post("/api/v1/admin/users", headers=admin_h, json={
        "username": username, "password": "abc12345",
        "real_name": username, "modules": modules})
    assert r.status_code == 200, r.text
    return login(client, username, pwd="abc12345")


def _uid_of(client, admin_h, username):
    rows = client.get(f"/api/v1/admin/users?keyword={username}", headers=admin_h).json()
    return next(u["id"] for u in rows["items"] if u["username"] == username)


def test_module_holder_reads_all_projects(client):
    ha = login(client, "admin")
    h = login(client, "pm")
    p = mkproject(client, h, "PScopeRead")
    client.post("/api/v1/tasks", json={"project_id": p["id"], "name": "T-Read"}, headers=h)
    client.post("/api/v1/budgets", headers=h,
                json={"project_id": p["id"], "subject": "人工", "amount": 1000,
                      "period_start": "2026-01-01", "period_end": "2026-12-31"})
    hm = _mk_user(client, ha, "13700000081", ["projects"])   # 非任何项目成员

    ids = [x["id"] for x in client.get("/api/v1/projects", headers=hm).json()["items"]]
    assert p["id"] in ids
    assert client.get(f"/api/v1/projects/{p['id']}", headers=hm).status_code == 200
    # 子资源列表全局可见
    assert any(x["name"] == "T-Read"
               for x in client.get("/api/v1/tasks", headers=hm).json()["items"])
    # 支出报表全局口径：能汇总他人项目
    rep = client.get(f"/api/v1/reports/cost?project_id={p['id']}", headers=hm)
    assert rep.status_code == 200 and rep.json()["items"], rep.text
    # 工作台全局口径：KPI 聚合包含他人项目的预算
    s = client.get("/api/v1/dashboard/summary", headers=hm).json()
    assert s["kpi"]["total_budget"] >= 1000


def test_module_holder_writes_all_projects(client):
    ha = login(client, "admin")
    h = login(client, "pm")
    p = mkproject(client, h, "PScopeWrite")
    hm = _mk_user(client, ha, "13700000082", ["opportunities"])  # 任一基础模块即可

    # 旧契约这里是 403「仅项目成员可写」；新契约模块持有者全局可写
    assert client.post("/api/v1/tasks", json={"project_id": p["id"], "name": "T-Global"},
                       headers=hm).status_code == 200
    assert client.post("/api/v1/expenses",
                       json={"project_id": p["id"], "subject": "差旅", "amount": 100,
                             "exp_date": "2026-06-01"},
                       headers=hm).status_code == 200
    assert client.post(f"/api/v1/projects/{p['id']}/followups",
                       json={"method": "电话", "content": "全局可写"},
                       headers=hm).status_code == 200

    # 独立业务规则仍在项目范围之上：非本人任务不可填报、非负责人不可确认快照
    tid = client.post("/api/v1/tasks", json={"project_id": p["id"], "name": "T-Own"},
                      headers=h).json()["id"]
    assert client.post("/api/v1/progress-logs",
                       json={"task_id": tid, "progress": 10}, headers=hm).status_code == 403
    assert client.post(f"/api/v1/projects/{p['id']}/progress/confirm",
                       headers=hm).status_code == 403


def test_zero_module_user_keeps_member_scope(client):
    ha = login(client, "admin")
    h = login(client, "pm")
    p1 = mkproject(client, h, "PScopeMember")
    p2 = mkproject(client, h, "PScopeOther")
    hz = _mk_user(client, ha, "13700000083", [])
    uid = _uid_of(client, ha, "13700000083")

    # 无基础模块：项目内容入口被路由门禁拦下
    assert client.get("/api/v1/projects", headers=hz).status_code == 403

    # 加入 p1 后：成员参与范围不变（读自己参与的项目 + 可写）
    assert client.put(f"/api/v1/projects/{p1['id']}/members",
                      headers=h, json={"user_ids": [uid]}).status_code == 200
    tid = client.post("/api/v1/tasks", json={"project_id": p1["id"], "name": "T-Member"},
                      headers=h).json()["id"]
    assert any(x["id"] == tid for x in client.get("/api/v1/tasks", headers=hz).json()["items"])
    assert client.post("/api/v1/tasks", json={"project_id": p1["id"], "name": "T-ByMember"},
                       headers=hz).status_code == 200
    # 他人项目边界仍在：按 project_id 越界查询 → 403
    assert client.get(f"/api/v1/tasks?project_id={p2['id']}", headers=hz).status_code == 403
    assert client.post("/api/v1/expenses",
                       json={"project_id": p2["id"], "subject": "差旅", "amount": 1,
                             "exp_date": "2026-06-01"},
                       headers=hz).status_code == 403
