from datetime import datetime
from decimal import Decimal

from api.models import AuditLog, Project
from sqlalchemy import event, inspect, text


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


def create_project(client, headers, name="应收项目"):
    response = client.post("/api/v1/projects", headers=headers, json={
        "name": name,
        "plan_start": "2026-01-01",
        "plan_end": "2026-12-31",
    })
    assert response.status_code == 200, response.text
    return response.json()


def create_receivable(client, headers, project_id, **values):
    response = client.post(
        f"/api/v1/projects/{project_id}/receivables",
        headers=headers,
        json={
            "name": "一期款",
            "amount": "100.00",
            "receivable_date": "2026-01-10",
            "due_date": "2099-01-31",
            "note": "合同约定",
            **values,
        },
    )
    assert response.status_code == 200, response.text
    return response.json()


def add_payment(client, headers, project_id, receivable_id, amount, **values):
    return client.post(
        f"/api/v1/projects/{project_id}/receivables/{receivable_id}/payments",
        headers=headers,
        json={"amount": amount, "payment_date": "2026-02-01", "note": "到账", **values},
    )


def test_project_receivable_tracks_partial_and_full_payments_and_rejects_overpayment(client):
    user = login(client, "pm")
    project = create_project(client, user)
    receivable = create_receivable(client, user, project["id"])

    assert receivable["amount"] == "100.00"
    assert receivable["received_amount"] == "0.00"
    assert receivable["outstanding_amount"] == "100.00"
    assert receivable["status"] == "unpaid"

    first = add_payment(client, user, project["id"], receivable["id"], "35.00")
    assert first.status_code == 200, first.text
    second = add_payment(client, user, project["id"], receivable["id"], "65.00")
    assert second.status_code == 200, second.text
    overpayment = add_payment(client, user, project["id"], receivable["id"], "0.01")
    assert overpayment.status_code == 400, overpayment.text

    response = client.get(
        f"/api/v1/projects/{project['id']}/receivables?page=1&size=20",
        headers=user,
    )
    assert response.status_code == 200, response.text
    item = response.json()["items"][0]
    assert response.json()["total"] == 1
    assert item["received_amount"] == "100.00"
    assert item["outstanding_amount"] == "0.00"
    assert item["status"] == "paid"
    assert item["payment_count"] == 2


def test_project_receivable_page_batches_payment_summaries(client, db):
    user = login(client, "pm")
    project = create_project(client, user, name="应收批量汇总项目")
    receivables = [
        create_receivable(client, user, project["id"], name=f"第{i}期", amount="100.00")
        for i in range(5)
    ]
    expected_totals = {}
    for index, item in enumerate(receivables, start=1):
        first_amount = Decimal(index * 10)
        assert add_payment(
            client, user, project["id"], item["id"], str(first_amount),
        ).status_code == 200
        count = 1
        total = first_amount
        if index % 2 == 0:
            second_amount = Decimal(index)
            assert add_payment(
                client, user, project["id"], item["id"], str(second_amount),
            ).status_code == 200
            total += second_amount
            count += 1
        expected_totals[item["id"]] = (f"{total:.2f}", count)

    session = db()
    bind = session.get_bind()
    session.close()
    payment_queries = []

    def record_payment_query(_conn, _cursor, statement, _parameters, _context, _executemany):
        normalized = statement.lower()
        if "project_receivable_payments" in normalized and "select" in normalized:
            payment_queries.append(normalized)

    event.listen(bind, "before_cursor_execute", record_payment_query)
    try:
        response = client.get(
            f"/api/v1/projects/{project['id']}/receivables?page=1&size=5",
            headers=user,
        )
    finally:
        event.remove(bind, "before_cursor_execute", record_payment_query)

    assert response.status_code == 200, response.text
    assert len(response.json()["items"]) == 5
    assert {
        row["id"]: (row["received_amount"], row["payment_count"])
        for row in response.json()["items"]
    } == expected_totals
    assert len(payment_queries) <= 2, payment_queries


def test_project_receivable_amount_cannot_be_reduced_below_received_total(client):
    user = login(client, "pm")
    project = create_project(client, user)
    receivable = create_receivable(client, user, project["id"])
    assert add_payment(client, user, project["id"], receivable["id"], "40.00").status_code == 200

    response = client.patch(
        f"/api/v1/projects/{project['id']}/receivables/{receivable['id']}",
        headers=user,
        json={"amount": "39.99"},
    )
    assert response.status_code == 400, response.text


def test_project_receivable_permissions_and_soft_delete_keep_payment_history(client, db):
    member = login(client, "pm")
    project = create_project(client, member)
    receivable = create_receivable(client, member, project["id"])
    payment = add_payment(client, member, project["id"], receivable["id"], "20.00").json()
    updated_payment = client.patch(
        f"/api/v1/projects/{project['id']}/receivables/{receivable['id']}/payments/{payment['id']}",
        headers=member,
        json={"amount": "25.00", "payment_date": "2026-02-02", "note": "更正到账日"},
    )
    assert updated_payment.status_code == 200, updated_payment.text
    updated_receivable = client.patch(
        f"/api/v1/projects/{project['id']}/receivables/{receivable['id']}",
        headers=member,
        json={"note": "补充合同口径"},
    )
    assert updated_receivable.status_code == 200, updated_receivable.text
    outsider = login(client, "outsider")
    administrator = login(client, "admin")

    assert client.get(
        f"/api/v1/projects/{project['id']}/receivables", headers=outsider,
    ).status_code == 403
    assert client.delete(
        f"/api/v1/projects/{project['id']}/receivables/{receivable['id']}", headers=member,
    ).status_code == 403
    assert client.delete(
        f"/api/v1/projects/{project['id']}/receivables/{receivable['id']}/payments/{payment['id']}",
        headers=member,
    ).status_code == 403

    deleted_payment = client.delete(
        f"/api/v1/projects/{project['id']}/receivables/{receivable['id']}/payments/{payment['id']}",
        headers=administrator,
    )
    assert deleted_payment.status_code == 200, deleted_payment.text
    rows = client.get(
        f"/api/v1/projects/{project['id']}/receivables", headers=member,
    ).json()["items"]
    assert rows[0]["received_amount"] == "0.00"
    assert rows[0]["outstanding_amount"] == "100.00"

    deleted_receivable = client.delete(
        f"/api/v1/projects/{project['id']}/receivables/{receivable['id']}",
        headers=administrator,
    )
    assert deleted_receivable.status_code == 200, deleted_receivable.text
    assert client.get(
        f"/api/v1/projects/{project['id']}/receivables", headers=member,
    ).json()["total"] == 0

    session = db()
    try:
        stored_receivable = session.execute(text(
            "SELECT deleted_at FROM project_receivables WHERE id = :id"
        ), {"id": receivable["id"]}).one()
        stored_payment = session.execute(text(
            "SELECT deleted_at FROM project_receivable_payments WHERE id = :id"
        ), {"id": payment["id"]}).one()
        actions = {
            row.action for row in session.query(AuditLog)
            .filter(AuditLog.resource.in_(["project_receivable", "project_receivable_payment"]))
            .all()
        }
        assert stored_receivable.deleted_at is not None
        assert stored_payment.deleted_at is not None
        assert {
            "create_project_receivable",
            "create_project_receivable_payment",
            "update_project_receivable",
            "update_project_receivable_payment",
            "delete_project_receivable",
            "delete_project_receivable_payment",
        } <= actions
    finally:
        session.close()


def test_project_receivable_rejects_invalid_amount_and_due_date(client):
    user = login(client, "pm")
    project = create_project(client, user)
    endpoint = f"/api/v1/projects/{project['id']}/receivables"

    zero = client.post(endpoint, headers=user, json={
        "name": "零金额", "amount": "0", "receivable_date": "2026-01-01", "due_date": "2026-02-01",
    })
    assert zero.status_code == 400, zero.text

    invalid_dates = client.post(endpoint, headers=user, json={
        "name": "到期日在应收日前", "amount": "1.00", "receivable_date": "2026-02-01", "due_date": "2026-01-01",
    })
    assert invalid_dates.status_code == 400, invalid_dates.text

    too_many_decimals = client.post(endpoint, headers=user, json={
        "name": "超两位小数", "amount": "1.001",
        "receivable_date": "2026-01-01", "due_date": "2026-02-01",
    })
    assert too_many_decimals.status_code == 400, too_many_decimals.text

    invalid_date = client.post(endpoint, headers=user, json={
        "name": "非法日期", "amount": "1.00",
        "receivable_date": "not-a-date", "due_date": "2026-02-01",
    })
    assert invalid_date.status_code == 400, invalid_date.text


def test_project_receivable_status_uses_due_date(client):
    user = login(client, "pm")
    project = create_project(client, user)
    receivable = create_receivable(
        client,
        user,
        project["id"],
        receivable_date="2000-01-01",
        due_date="2000-01-02",
    )
    assert receivable["status"] == "overdue"
    assert add_payment(client, user, project["id"], receivable["id"], "100.00").status_code == 200
    listed = client.get(f"/api/v1/projects/{project['id']}/receivables", headers=user).json()["items"]
    assert listed[0]["status"] == "paid"


def test_project_receivable_and_payment_updates_support_ui_fields_and_pagination(client):
    user = login(client, "pm")
    project = create_project(client, user)
    receivable = create_receivable(client, user, project["id"])

    updated = client.patch(
        f"/api/v1/projects/{project['id']}/receivables/{receivable['id']}",
        headers=user,
        json={
            "name": "验收款",
            "amount": "150.00",
            "receivable_date": "2026-03-01",
            "due_date": "2026-04-01",
            "note": "按验收节点调整",
        },
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["name"] == "验收款"
    assert updated.json()["amount"] == "150.00"
    assert updated.json()["receivable_date"] == "2026-03-01"
    assert updated.json()["due_date"] == "2026-04-01"
    assert updated.json()["note"] == "按验收节点调整"

    first = add_payment(client, user, project["id"], receivable["id"], "50.00")
    second = add_payment(client, user, project["id"], receivable["id"], "40.00")
    assert first.status_code == 200, first.text
    assert second.status_code == 200, second.text
    first_id = first.json()["id"]

    payments = client.get(
        f"/api/v1/projects/{project['id']}/receivables/{receivable['id']}/payments"
        "?page=1&size=1",
        headers=user,
    )
    assert payments.status_code == 200, payments.text
    payment_page = payments.json()
    assert set(payment_page) >= {"total", "page", "size", "items"}
    assert (payment_page["total"], payment_page["page"], payment_page["size"]) == (2, 1, 1)
    assert set(payment_page["items"][0]) >= {"id", "amount", "payment_date", "note"}

    patched_payment = client.patch(
        f"/api/v1/projects/{project['id']}/receivables/{receivable['id']}/payments/{first_id}",
        headers=user,
        json={"amount": "30.00", "payment_date": "2026-03-02", "note": "更正金额"},
    )
    assert patched_payment.status_code == 200, patched_payment.text
    assert patched_payment.json()["amount"] == "30.00"
    assert patched_payment.json()["payment_date"] == "2026-03-02"
    assert patched_payment.json()["note"] == "更正金额"

    over_limit = client.patch(
        f"/api/v1/projects/{project['id']}/receivables/{receivable['id']}/payments/{first_id}",
        headers=user,
        json={"amount": "111.00"},
    )
    assert over_limit.status_code == 400, over_limit.text

    item = client.get(
        f"/api/v1/projects/{project['id']}/receivables", headers=user,
    ).json()["items"][0]
    assert item["received_amount"] == "70.00"
    assert item["outstanding_amount"] == "80.00"
    assert item["payment_count"] == 2

    assert client.get(
        f"/api/v1/projects/{project['id']}/receivables?page=0", headers=user,
    ).status_code == 400
    assert client.get(
        f"/api/v1/projects/{project['id']}/receivables?page=1&size=101", headers=user,
    ).status_code == 400


def test_project_receivable_rejects_invalid_payment_amount_and_date(client):
    user = login(client, "pm")
    project = create_project(client, user)
    receivable = create_receivable(client, user, project["id"])
    endpoint = f"/api/v1/projects/{project['id']}/receivables/{receivable['id']}/payments"

    for amount in ("0", "-1.00", "1.001", "NaN"):
        response = client.post(endpoint, headers=user, json={
            "amount": amount, "payment_date": "2026-02-01",
        })
        assert response.status_code == 400, f"{amount}: {response.text}"

    invalid_date = client.post(endpoint, headers=user, json={
        "amount": "1.00", "payment_date": "not-a-date",
    })
    assert invalid_date.status_code == 400, invalid_date.text


def test_project_receivable_cannot_cross_project_paths_or_access_deleted_rows(client):
    member = login(client, "pm")
    administrator = login(client, "admin")
    project = create_project(client, member, name="应收隔离 A")
    other = create_project(client, member, name="应收隔离 B")
    receivable = create_receivable(client, member, project["id"])
    payment = add_payment(client, member, project["id"], receivable["id"], "20.00").json()

    assert client.patch(
        f"/api/v1/projects/{other['id']}/receivables/{receivable['id']}",
        headers=member,
        json={"note": "串项目"},
    ).status_code == 404
    assert client.post(
        f"/api/v1/projects/{other['id']}/receivables/{receivable['id']}/payments",
        headers=member,
        json={"amount": "1.00", "payment_date": "2026-02-01"},
    ).status_code == 404
    assert client.patch(
        f"/api/v1/projects/{other['id']}/receivables/{receivable['id']}/payments/{payment['id']}",
        headers=member,
        json={"amount": "1.00"},
    ).status_code == 404

    assert client.delete(
        f"/api/v1/projects/{project['id']}/receivables/{receivable['id']}",
        headers=administrator,
    ).status_code == 200
    assert client.get(
        f"/api/v1/projects/{project['id']}/receivables/{receivable['id']}/payments",
        headers=member,
    ).status_code == 404
    assert client.patch(
        f"/api/v1/projects/{project['id']}/receivables/{receivable['id']}",
        headers=member,
        json={"note": "已删除"},
    ).status_code == 404


def test_project_receivable_archived_project_is_read_only(client, db):
    member = login(client, "pm")
    administrator = login(client, "admin")
    project = create_project(client, member)
    receivable = create_receivable(client, member, project["id"])
    payment = add_payment(client, member, project["id"], receivable["id"], "20.00").json()

    session = db()
    try:
        session.query(Project).filter_by(id=project["id"]).update({"status": "archived"})
        session.commit()
    finally:
        session.close()

    assert client.get(
        f"/api/v1/projects/{project['id']}/receivables", headers=member,
    ).status_code == 200
    assert client.get(
        f"/api/v1/projects/{project['id']}/receivables/{receivable['id']}/payments",
        headers=member,
    ).status_code == 200
    assert client.post(
        f"/api/v1/projects/{project['id']}/receivables",
        headers=member,
        json={
            "name": "归档新增", "amount": "1.00",
            "receivable_date": "2026-01-01", "due_date": "2026-02-01",
        },
    ).status_code == 400
    assert client.patch(
        f"/api/v1/projects/{project['id']}/receivables/{receivable['id']}",
        headers=member,
        json={"note": "归档修改"},
    ).status_code == 400
    assert client.post(
        f"/api/v1/projects/{project['id']}/receivables/{receivable['id']}/payments",
        headers=member,
        json={"amount": "1.00", "payment_date": "2026-02-01"},
    ).status_code == 400
    assert client.patch(
        f"/api/v1/projects/{project['id']}/receivables/{receivable['id']}/payments/{payment['id']}",
        headers=member,
        json={"amount": "10.00"},
    ).status_code == 400
    assert client.delete(
        f"/api/v1/projects/{project['id']}/receivables/{receivable['id']}/payments/{payment['id']}",
        headers=administrator,
    ).status_code == 400
    assert client.delete(
        f"/api/v1/projects/{project['id']}/receivables/{receivable['id']}",
        headers=administrator,
    ).status_code == 400


def test_project_receivable_nonmember_cannot_write_and_deleted_project_is_unreadable(client, db):
    member = login(client, "pm")
    outsider = login(client, "outsider")
    project = create_project(client, member, name="软删除应收项目")
    receivable = create_receivable(client, member, project["id"])

    assert client.post(
        f"/api/v1/projects/{project['id']}/receivables",
        headers=outsider,
        json={
            "name": "越权新增", "amount": "1.00",
            "receivable_date": "2026-01-01", "due_date": "2026-02-01",
        },
    ).status_code == 403
    assert client.patch(
        f"/api/v1/projects/{project['id']}/receivables/{receivable['id']}",
        headers=outsider,
        json={"note": "越权修改"},
    ).status_code == 403
    assert client.post(
        f"/api/v1/projects/{project['id']}/receivables/{receivable['id']}/payments",
        headers=outsider,
        json={"amount": "1.00", "payment_date": "2026-02-01"},
    ).status_code == 403

    session = db()
    try:
        session.query(Project).filter_by(id=project["id"]).update({
            "deleted_at": datetime(2026, 1, 1),
        })
        session.commit()
    finally:
        session.close()

    assert client.get(
        f"/api/v1/projects/{project['id']}/receivables", headers=member,
    ).status_code == 404
    assert client.get(
        f"/api/v1/projects/{project['id']}/receivables/{receivable['id']}/payments",
        headers=member,
    ).status_code == 404


def test_project_receivable_schema_uses_restrict_fks_and_project_indexes(db):
    session = db()
    try:
        inspector = inspect(session.get_bind())
        tables = set(inspector.get_table_names())
        assert {"project_receivables", "project_receivable_payments"} <= tables

        receivable_columns = {
            column["name"]: column for column in inspector.get_columns("project_receivables")
        }
        assert receivable_columns["amount"]["type"].precision == 18
        assert receivable_columns["amount"]["type"].scale == 2

        receivable_fks = inspector.get_foreign_keys("project_receivables")
        assert any(
            fk["referred_table"] == "projects"
            and fk["options"].get("ondelete") == "RESTRICT"
            for fk in receivable_fks
        )
        payment_fks = inspector.get_foreign_keys("project_receivable_payments")
        assert any(
            fk["referred_table"] == "projects"
            and fk["options"].get("ondelete") == "RESTRICT"
            for fk in payment_fks
        )
        assert any(
            fk["referred_table"] == "project_receivables"
            and fk["options"].get("ondelete") == "RESTRICT"
            and fk["constrained_columns"] == ["project_id", "receivable_id"]
            for fk in payment_fks
        )
    finally:
        session.close()


def test_project_receivable_summary_is_project_wide_and_ignores_current_page(client):
    member = login(client, "pm")
    administrator = login(client, "admin")
    project = create_project(client, member, name="应收汇总项目")
    first = create_receivable(
        client, member, project["id"], name="首期款", amount="100.00",
    )
    create_receivable(
        client, member, project["id"], name="尾款", amount="200.00",
    )
    assert add_payment(
        client, member, project["id"], first["id"], "40.00",
    ).status_code == 200
    deleted = create_receivable(
        client, member, project["id"], name="作废应收", amount="999.00",
    )
    assert client.delete(
        f"/api/v1/projects/{project['id']}/receivables/{deleted['id']}",
        headers=administrator,
    ).status_code == 200

    response = client.get(
        f"/api/v1/projects/{project['id']}/receivables?page=1&size=1",
        headers=member,
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["total"] == 2
    assert body["page"] == 1
    assert body["size"] == 1
    assert len(body["items"]) == 1
    assert body["summary"] == {
        "amount": "300.00",
        "received_amount": "40.00",
        "outstanding_amount": "260.00",
    }
