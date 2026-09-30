"""项目「日志」tab 的成本 / 应收 / 回款留痕（`project_changes`）。

为什么单独建用例文件：这三类业务活动的留痕是**写侧契约**——前端项目详情页
「日志」tab 只读 `GET /projects/{pid}/changes`，后端在支出、应收、回款的写路径上
额外补一条 `ProjectChange`。与既有的项目字段 / 负责人 / 状态留痕互不影响，
独立成文件便于回归「业务活动是否出现在日志里」这一条链路。
"""
from api.models import ProjectChange


def login(client, username, password=None):
    default = {
        "admin": "admin123456",
        "pm": "pm123456",
        "outsider": "out123456",
    }
    response = client.post("/api/v1/auth/login", json={
        "username": username,
        "password": password or default[username],
    })
    assert response.status_code == 200, response.text
    return {"Authorization": f"Bearer {response.json()['access_token']}"}


def create_project(client, headers, name="留痕项目"):
    response = client.post("/api/v1/projects", headers=headers, json={
        "name": name,
        "plan_start": "2026-01-01",
        "plan_end": "2026-12-31",
    })
    assert response.status_code == 200, response.text
    return response.json()


def changes(client, headers, project_id):
    response = client.get(f"/api/v1/projects/{project_id}/changes", headers=headers)
    assert response.status_code == 200, response.text
    return response.json()


def expense_changes(db, project_id):
    session = db()
    try:
        return (
            session.query(ProjectChange)
            .filter_by(project_id=project_id, field="expense")
            .order_by(ProjectChange.id)
            .all()
        )
    finally:
        session.close()


def test_expense_registration_is_recorded_in_project_changes(client, db):
    """审批关闭 → 自动通过：登记支出应落一条 field="expense"、old="" 的留痕。"""
    user = login(client, "pm")
    project = create_project(client, user)

    created = client.post("/api/v1/expenses", headers=user, json={
        "project_id": project["id"],
        "subject": "人工",
        "amount": 150,
        "note": "工资",
    })
    assert created.status_code == 200, created.text
    # conftest 默认 expense_approval_on=0 且无预算 → 自动生效
    assert created.json()["status"] == "approved"

    rows = expense_changes(db, project["id"])
    assert len(rows) == 1
    assert rows[0].old == ""
    assert "登记「人工」" in rows[0].new
    assert "已通过" in rows[0].new

    # 写侧留痕必须能从前端读的接口按原样看到
    listed = [row for row in changes(client, user, project["id"]) if row["field"] == "expense"]
    assert len(listed) == 1
    assert listed[0]["old"] == ""
    assert listed[0]["new"] == rows[0].new


def test_receivable_and_payment_creation_are_recorded_in_project_changes(client, db):
    """新增应收 + 登记回款：分别落 field="receivable" 与 "receivable_payment"。"""
    user = login(client, "pm")
    project = create_project(client, user, name="应收留痕项目")

    receivable_response = client.post(
        f"/api/v1/projects/{project['id']}/receivables",
        headers=user,
        json={
            "name": "一期款",
            "amount": "100.00",
            "receivable_date": "2026-01-10",
            "due_date": "2026-01-31",
        },
    )
    assert receivable_response.status_code == 200, receivable_response.text
    receivable = receivable_response.json()

    payment_response = client.post(
        f"/api/v1/projects/{project['id']}/receivables/{receivable['id']}/payments",
        headers=user,
        json={"amount": "40.00", "payment_date": "2026-02-01"},
    )
    assert payment_response.status_code == 200, payment_response.text

    session = db()
    try:
        rows = session.query(ProjectChange).filter_by(project_id=project["id"]).all()
        by_field = {}
        for row in rows:
            by_field.setdefault(row.field, []).append(row)
    finally:
        session.close()

    assert len(by_field.get("receivable", [])) == 1
    assert len(by_field.get("receivable_payment", [])) == 1
    receivable_row = by_field["receivable"][0]
    payment_row = by_field["receivable_payment"][0]
    assert receivable_row.old == "" and payment_row.old == ""
    assert "新增「一期款」" in receivable_row.new
    assert "100.00" in receivable_row.new
    assert "登记 40.00 元" in payment_row.new
    assert "一期款" in payment_row.new

    listed = {(row["field"], row["new"]) for row in changes(client, user, project["id"])}
    assert ("receivable", receivable_row.new) in listed
    assert ("receivable_payment", payment_row.new) in listed


def test_expense_decision_and_resubmit_are_recorded_in_project_changes(client, db):
    """审批开关开启：登记 → 驳回 → 重提，每一步都留痕且驳回意见原样进日志。"""
    user = login(client, "pm")
    administrator = login(client, "admin")
    project = create_project(client, user, name="成本决策留痕项目")

    session = db()
    try:
        from api.models import SysParam

        session.query(SysParam).filter_by(key="expense_approval_on").first().value = "1"
        session.commit()
    finally:
        session.close()

    created = client.post("/api/v1/expenses", headers=user, json={
        "project_id": project["id"],
        "subject": "人工",
        "amount": 200,
    })
    assert created.status_code == 200, created.text
    assert created.json()["status"] == "pending"

    rejected = client.post(
        f"/api/v1/expenses/{created.json()['id']}/reject",
        headers=administrator,
        json={"reason": "缺少发票"},
    )
    assert rejected.status_code == 200, rejected.text

    resubmitted = client.post(
        f"/api/v1/expenses/{created.json()['id']}/resubmit",
        headers=user,
        json={"amount": 180},
    )
    assert resubmitted.status_code == 200, resubmitted.text

    rows = expense_changes(db, project["id"])
    assert len(rows) == 3
    assert "登记「人工」" in rows[0].new and "待审批" in rows[0].new
    assert "「人工」被驳回：缺少发票" == rows[1].new
    assert "「人工」重新提交" in rows[2].new
    assert all(row.old == "" for row in rows)


def test_receivable_and_payment_mutations_are_recorded_in_project_changes(client, db):
    """修改 / 删除应收与回款都要留痕，且删除用删除前的名称与金额。"""
    user = login(client, "pm")
    administrator = login(client, "admin")
    project = create_project(client, user, name="应收变更留痕项目")

    receivable = client.post(
        f"/api/v1/projects/{project['id']}/receivables",
        headers=user,
        json={
            "name": "一期款",
            "amount": "100.00",
            "receivable_date": "2026-01-10",
            "due_date": "2026-01-31",
        },
    ).json()
    payment = client.post(
        f"/api/v1/projects/{project['id']}/receivables/{receivable['id']}/payments",
        headers=user,
        json={"amount": "30.00", "payment_date": "2026-02-01"},
    ).json()

    assert client.patch(
        f"/api/v1/projects/{project['id']}/receivables/{receivable['id']}",
        headers=user,
        json={"amount": "120.00"},
    ).status_code == 200
    assert client.patch(
        f"/api/v1/projects/{project['id']}/receivables/{receivable['id']}/payments/{payment['id']}",
        headers=user,
        json={"amount": "40.00"},
    ).status_code == 200
    assert client.delete(
        f"/api/v1/projects/{project['id']}/receivables/{receivable['id']}/payments/{payment['id']}",
        headers=administrator,
    ).status_code == 200
    assert client.delete(
        f"/api/v1/projects/{project['id']}/receivables/{receivable['id']}",
        headers=administrator,
    ).status_code == 200

    session = db()
    try:
        texts = [
            row.new
            for row in session.query(ProjectChange)
            .filter_by(project_id=project["id"])
            .order_by(ProjectChange.id)
            .all()
        ]
    finally:
        session.close()

    assert "修改「一期款」为 120.00 元" in texts
    assert any("更正「一期款」下的回款为 40.00 元" == text for text in texts)
    assert any("删除「一期款」下的一笔回款 40.00 元" == text for text in texts)
    assert "删除「一期款」" in texts

    listed = {(row["field"], row["new"]) for row in changes(client, user, project["id"])}
    assert ("receivable", "修改「一期款」为 120.00 元") in listed
    assert ("receivable", "删除「一期款」") in listed
    assert ("receivable_payment", "更正「一期款」下的回款为 40.00 元") in listed
    assert ("receivable_payment", "删除「一期款」下的一笔回款 40.00 元") in listed
