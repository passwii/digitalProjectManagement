"""项目支出来源凭证的持久化契约。"""

from datetime import date, datetime

from sqlalchemy import UniqueConstraint

from api.models import Account, AccountBookMember, AccountingPeriod, AuditLog, AuxiliaryItem, Expense, Project, User, Voucher


def _auth(client, username="admin", password="admin123456"):
    response = client.post("/api/v1/auth/login", json={"username": username, "password": password})
    assert response.status_code == 200
    return {"Authorization": f"Bearer {response.json()['access_token']}"}


def _setup(client, db):
    admin = _auth(client)
    book = client.post("/api/v1/finance/books", headers=admin, json={"code": "PROJECT-EXPENSE", "name": "项目支出账套"}).json()
    scoped = {**admin, "X-Account-Book": book["code"]}
    period = client.get("/api/v1/finance/periods", headers=scoped).json()[0]
    accounts = {row["code"]: row for row in client.get("/api/v1/finance/accounts/tree", headers=scoped).json()}
    with db() as session:
        pm = session.query(User).filter_by(username="pm").one()
        outsider = session.query(User).filter_by(username="outsider").one()
        projects = [
            Project(code="PE-1", name="可见项目", owner_id=pm.id),
            Project(code="PE-2", name="其他项目", owner_id=outsider.id),
            Project(code="PE-3", name="回收项目", owner_id=pm.id, deleted_at=datetime(2025, 1, 1)),
        ]
        session.add_all(projects)
        session.flush()
        expenses = [
            Expense(project_id=projects[0].id, subject="人工", amount=123.456, exp_date=date.fromisoformat(period["start_date"]), status="approved"),
            Expense(project_id=projects[0].id, subject="采购", amount=20, status="exception"),
            Expense(project_id=projects[0].id, subject="采购", amount=30, status="pending"),
            Expense(project_id=projects[0].id, subject="采购", amount=40, status="rejected"),
            Expense(project_id=projects[1].id, subject="采购", amount=50, status="approved"),
            Expense(project_id=projects[2].id, subject="采购", amount=60, status="approved"),
        ]
        session.add_all(expenses)
        session.commit()
        ids = [row.id for row in expenses]
        pids = [row.id for row in projects]
    return scoped, period, accounts, ids, pids, book


def _payload(period, accounts, **changes):
    body = {
        "period_id": period["id"], "voucher_date": period["start_date"], "summary": "项目支出制单",
        "debit": {"account_id": accounts["1405"]["id"], "aux_detail": {}, "cashflow_item": None},
        "credit": {"account_id": accounts["6001"]["id"], "aux_detail": {}, "cashflow_item": None},
    }
    body.update(changes)
    return body


def test_list_only_active_approved_and_exception_expenses_with_filters(client, db):
    headers, period, accounts, ids, pids, book = _setup(client, db)
    response = client.get("/api/v1/finance/project-expenses", headers=headers)
    assert response.status_code == 200
    rows = response.json()
    assert (rows["total"], rows["page"], rows["size"]) == (3, 1, 20)
    assert {row["id"] for row in rows["items"]} == {ids[0], ids[1], ids[4]}
    assert rows["items"][0]["project"]["id"] in pids
    assert rows["items"][0]["source_voucher_summary"] is None
    filtered = client.get("/api/v1/finance/project-expenses", headers=headers, params={"project_id": pids[0], "status": "approved", "date_from": period["start_date"], "date_to": period["end_date"], "page": 1, "size": 1})
    assert filtered.status_code == 200
    assert [row["id"] for row in filtered.json()["items"]] == [ids[0]]


def test_conversion_uses_source_amount_creates_draft_and_reports_link(client, db):
    headers, period, accounts, ids, pids, book = _setup(client, db)
    payload = _payload(period, accounts, amount="999999.99")
    response = client.post(f"/api/v1/finance/project-expenses/{ids[0]}/voucher", headers=headers, json=payload)
    assert response.status_code == 200
    voucher = response.json()
    assert voucher["source_expense_id"] == ids[0]
    assert voucher["source"] == "project-expense" and voucher["status"] == "draft"
    assert voucher["total_debit"] == voucher["total_credit"] == "123.46"
    assert voucher["voucher_no"] == "记-0001"
    assert [line["debit"] for line in voucher["lines"]] == ["123.46", "0.00"]
    with db() as session:
        audit = session.query(AuditLog).filter_by(action="create_project_expense_voucher", resource_id=str(ids[0])).one()
        assert f"voucher={voucher['id']}" in audit.detail
    again = client.post(f"/api/v1/finance/project-expenses/{ids[0]}/voucher", headers=headers, json=payload)
    assert again.status_code == 409
    assert again.json()["detail"]["code"] == "F-PROJECT-EXPENSE-LINKED"
    assert again.json()["detail"]["source_voucher_summary"]["id"] == voucher["id"]
    listed = client.get("/api/v1/finance/project-expenses", headers=headers, params={"project_id": pids[0]}).json()
    assert next(row for row in listed["items"] if row["id"] == ids[0])["source_voucher_summary"]["id"] == voucher["id"]


def test_invalid_status_period_date_and_account_leave_no_voucher(client, db):
    headers, period, accounts, ids, pids, book = _setup(client, db)
    for eid in (ids[2], ids[3]):
        assert client.post(f"/api/v1/finance/project-expenses/{eid}/voucher", headers=headers, json=_payload(period, accounts)).status_code == 400
    bad_account = _payload(period, accounts)
    bad_account["debit"]["account_id"] = -1
    assert client.post(f"/api/v1/finance/project-expenses/{ids[0]}/voucher", headers=headers, json=bad_account).status_code == 400
    out_of_range = _payload(period, accounts, voucher_date="2000-01-01")
    assert client.post(f"/api/v1/finance/project-expenses/{ids[0]}/voucher", headers=headers, json=out_of_range).status_code == 400
    with db() as session:
        session.query(AccountingPeriod).filter_by(id=period["id"]).one().status = "closed"
        session.commit()
    assert client.post(f"/api/v1/finance/project-expenses/{ids[0]}/voucher", headers=headers, json=_payload(period, accounts)).status_code == 400
    assert client.get("/api/v1/finance/vouchers", headers=headers).json()["total"] == 0


def test_auxiliary_must_be_in_current_book_and_match_kind(client, db):
    headers, period, accounts, ids, pids, book = _setup(client, db)
    admin = _auth(client)
    headers = {**admin, "X-Account-Book": book["code"]}
    other_book = client.post("/api/v1/finance/books", headers=admin, json={"code": "AUX-OTHER", "name": "辅助资料其他账套"}).json()
    with db() as session:
        session.query(Account).filter_by(id=accounts["1405"]["id"]).one().aux_flags = {"project": True}
        item = AuxiliaryItem(account_book_id=book["id"], kind="vendor", code="V-1", name="供应商")
        cross_book = AuxiliaryItem(account_book_id=other_book["id"], kind="project", code="P-1", name="其他账套项目")
        session.add_all([item, cross_book])
        session.commit()
        item_id = item.id
        cross_book_id = cross_book.id
    missing = client.post(f"/api/v1/finance/project-expenses/{ids[0]}/voucher", headers=headers, json=_payload(period, accounts))
    assert missing.status_code == 400
    wrong = _payload(period, accounts)
    wrong["debit"]["aux_detail"] = {"project": item_id}
    assert client.post(f"/api/v1/finance/project-expenses/{ids[0]}/voucher", headers=headers, json=wrong).status_code == 400
    wrong["debit"]["aux_detail"] = {"project": cross_book_id}
    assert client.post(f"/api/v1/finance/project-expenses/{ids[0]}/voucher", headers=headers, json=wrong).status_code == 400
    assert client.get("/api/v1/finance/vouchers", headers=headers).json()["total"] == 0
    with db() as session:
        valid = AuxiliaryItem(account_book_id=book["id"], kind="project", code="P-OK", name="本账套项目")
        session.add(valid)
        session.commit()
        valid_id = valid.id
    wrong["debit"]["aux_detail"] = {"project": valid_id}
    assert client.post(f"/api/v1/finance/project-expenses/{ids[0]}/voucher", headers=headers, json=wrong).status_code == 200


def test_role_and_project_visibility_are_both_required(client, db):
    headers, period, accounts, ids, pids, book = _setup(client, db)
    with db() as session:
        pm = session.query(User).filter_by(username="pm").one()
        pm_id = pm.id
        session.add(AccountBookMember(account_book_id=book["id"], user_id=pm_id, role="finance_reviewer"))
        session.commit()
    pm_headers = {**_auth(client, "pm", "pm123456"), "X-Account-Book": book["code"]}
    listed = client.get("/api/v1/finance/project-expenses", headers=pm_headers)
    assert listed.status_code == 200
    assert {row["id"] for row in listed.json()["items"]} == {ids[0], ids[1]}
    assert client.post(f"/api/v1/finance/project-expenses/{ids[0]}/voucher", headers=pm_headers, json=_payload(period, accounts)).status_code == 403
    with db() as session:
        session.query(AccountBookMember).filter_by(account_book_id=book["id"], user_id=pm_id).one().role = "finance_clerk"
        session.commit()
    assert client.post(f"/api/v1/finance/project-expenses/{ids[4]}/voucher", headers=pm_headers, json=_payload(period, accounts)).status_code in (403, 404)


def test_source_link_in_other_book_hides_voucher_details(client, db):
    headers, period, accounts, ids, pids, book = _setup(client, db)
    created = client.post(f"/api/v1/finance/project-expenses/{ids[0]}/voucher", headers=headers, json=_payload(period, accounts))
    assert created.status_code == 200
    admin = _auth(client)
    second = client.post("/api/v1/finance/books", headers=admin, json={"code": "SECOND-BOOK", "name": "第二账套"}).json()
    scoped = {**admin, "X-Account-Book": second["code"]}
    second_period = client.get("/api/v1/finance/periods", headers=scoped).json()[0]
    second_accounts = {row["code"]: row for row in client.get("/api/v1/finance/accounts/tree", headers=scoped).json()}
    listed = client.get("/api/v1/finance/project-expenses", headers=scoped).json()
    summary = next(row for row in listed["items"] if row["id"] == ids[0])["source_voucher_summary"]
    assert summary == {"converted": True, "message": "已在其他账套转换"}
    conflict = client.post(f"/api/v1/finance/project-expenses/{ids[0]}/voucher", headers=scoped, json=_payload(second_period, second_accounts))
    assert conflict.status_code == 409
    assert conflict.json()["detail"]["source_voucher_summary"] == summary
    assert str(created.json()["voucher_no"]) not in str(conflict.json())


def test_numbering_skips_existing_period_number_and_is_unique(client, db):
    headers, period, accounts, ids, pids, book = _setup(client, db)
    manual = client.post("/api/v1/finance/vouchers", headers=headers, json={
        "period_id": period["id"], "voucher_no": "记-0007", "voucher_date": period["start_date"], "summary": "已有编号",
        "lines": [
            {"account_id": accounts["1405"]["id"], "debit": "1.00"},
            {"account_id": accounts["6001"]["id"], "credit": "1.00"},
        ],
    })
    assert manual.status_code == 200
    created = client.post(f"/api/v1/finance/project-expenses/{ids[0]}/voucher", headers=headers, json=_payload(period, accounts))
    assert created.status_code == 200
    assert created.json()["voucher_no"] == "记-0008"


def test_voucher_source_expense_id_is_unique_fk_in_metadata():
    table = Voucher.__table__

    assert "source_expense_id" in table.c
    column = table.c.source_expense_id
    assert column.nullable
    assert len(column.foreign_keys) == 1
    foreign_key = next(iter(column.foreign_keys))
    assert foreign_key.target_fullname == "expenses.id"
    assert foreign_key.ondelete == "RESTRICT"
    assert foreign_key.constraint.name == "fk_vouchers_source_expense_id_expenses"
    assert any(
        isinstance(constraint, UniqueConstraint)
        and constraint.name == "uq_vouchers_source_expense_id"
        and [item.name for item in constraint.columns] == ["source_expense_id"]
        for constraint in table.constraints
    )
