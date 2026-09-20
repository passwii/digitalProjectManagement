"""Review-gate regression tests for the finance P0-A isolation contracts."""


def _auth(client, username, password):
    response = client.post(
        "/api/v1/auth/login", json={"username": username, "password": password}
    )
    assert response.status_code == 200
    return {"Authorization": f"Bearer {response.json()['access_token']}"}


def _book(client, headers, code):
    response = client.post(
        "/api/v1/finance/books", json={"code": code, "name": code}, headers=headers
    )
    assert response.status_code == 200
    return response.json()


def test_finance_books_seed_full_tree_and_isolate_reads(client):
    headers = _auth(client, "admin", "admin123456")
    first = _book(client, headers, "REVIEW-A")
    second = _book(client, headers, "REVIEW-B")

    first_accounts = client.get(
        "/api/v1/finance/accounts/tree",
        headers={**headers, "X-Account-Book": first["code"]},
    )
    second_accounts = client.get(
        "/api/v1/finance/accounts/tree",
        headers={**headers, "X-Account-Book": second["code"]},
    )
    assert first_accounts.status_code == second_accounts.status_code == 200
    assert len(first_accounts.json()) >= 75
    assert {row["subject_version"] for row in first_accounts.json()} == {"2022"}
    assert len(second_accounts.json()) == len(first_accounts.json())
    assert {row["id"] for row in first_accounts.json()}.isdisjoint(
        {row["id"] for row in second_accounts.json()}
    )


def test_finance_account_validation_and_auxiliary_api(client):
    headers = _auth(client, "admin", "admin123456")
    book = _book(client, headers, "REVIEW-C")
    scoped = {**headers, "X-Account-Book": book["code"]}

    invalid_root = client.post(
        "/api/v1/finance/accounts",
        json={
            "code": "100201",
            "name": "非法一级",
            "direction": "D",
            "category": "资产",
        },
        headers=scoped,
    )
    assert invalid_root.status_code == 400

    accounts = client.get("/api/v1/finance/accounts/tree", headers=scoped).json()
    # A seeded parent may already have one child; adding a sibling remains valid.
    sibling = client.post(
        "/api/v1/finance/accounts",
        json={
            "code": "100202",
            "name": "工行一般户",
            "direction": "D",
            "category": "资产",
            "parent_id": next(row["id"] for row in accounts if row["code"] == "1002"),
        },
        headers=scoped,
    )
    assert sibling.status_code == 200

    auxiliary = client.post(
        "/api/v1/finance/auxiliary-items",
        json={"kind": "department", "code": "D01", "name": "管理部"},
        headers=scoped,
    )
    assert auxiliary.status_code == 200
    accounts = client.get("/api/v1/finance/accounts/tree", headers=scoped).json()
    expense = next(row for row in accounts if row["code"] == "6602")
    link = client.post(
        "/api/v1/finance/account-auxiliaries",
        json={"account_id": expense["id"], "auxiliary_item_id": auxiliary.json()["id"]},
        headers=scoped,
    )
    assert link.status_code == 200
    assert (
        len(client.get("/api/v1/finance/account-auxiliaries", headers=scoped).json())
        == 1
    )


def test_account_deactivation_requires_zero_balance(client):
    headers = _auth(client, "admin", "admin123456")
    book = _book(client, headers, "REVIEW-E")
    scoped = {**headers, "X-Account-Book": book["code"]}
    accounts = client.get("/api/v1/finance/accounts/tree", headers=scoped).json()
    target = next(row for row in accounts if row["code"] == "1405")

    opening = client.post(
        "/api/v1/finance/opening-balances",
        json={"account_id": target["id"], "debit": "1.00", "credit": "0.00"},
        headers=scoped,
    )
    assert opening.status_code == 200
    blocked = client.patch(
        f"/api/v1/finance/accounts/{target['id']}?active=false",
        headers=scoped,
    )
    assert blocked.status_code == 400

    zero_target = next(row for row in accounts if row["code"] == "1601")
    disabled = client.patch(
        f"/api/v1/finance/accounts/{zero_target['id']}?active=false",
        headers=scoped,
    )
    assert disabled.status_code == 200
    assert disabled.json()["is_active"] is False


def test_period_reopen_requires_confirmation_reverse_order_and_version(client):
    headers = _auth(client, "admin", "admin123456")
    book = _book(client, headers, "REVIEW-D")
    scoped = {**headers, "X-Account-Book": book["code"]}
    periods = client.get("/api/v1/finance/periods", headers=scoped).json()
    first, second = periods[:2]

    close_first = client.post(
        f"/api/v1/finance/periods/{first['id']}/close",
        headers={**scoped, "If-Match": str(first["version"])},
    )
    assert close_first.status_code == 200
    assert close_first.json()["version"] == 2
    reopen_without_confirmation = client.post(
        f"/api/v1/finance/periods/{first['id']}/reopen",
        headers={**scoped, "If-Match": "2"},
    )
    assert reopen_without_confirmation.status_code == 400
    assert reopen_without_confirmation.json()["detail"]["code"] == "F-PERIOD-CLOSED"

    close_second = client.post(
        f"/api/v1/finance/periods/{second['id']}/close",
        headers={**scoped, "If-Match": str(second["version"])},
    )
    assert close_second.status_code == 200
    wrong_order = client.post(
        f"/api/v1/finance/periods/{first['id']}/reopen",
        headers={**scoped, "If-Match": "2", "X-Reopen-Period": "confirm"},
    )
    assert wrong_order.status_code == 400
    assert wrong_order.json()["detail"]["code"] == "F-REVERSE-ORDER"

    reopen_second = client.post(
        f"/api/v1/finance/periods/{second['id']}/reopen",
        headers={**scoped, "If-Match": "2", "X-Reopen-Period": "confirm"},
    )
    assert reopen_second.status_code == 200
    stale = client.post(
        f"/api/v1/finance/periods/{first['id']}/reopen",
        headers={**scoped, "If-Match": "1", "X-Reopen-Period": "confirm"},
    )
    assert stale.status_code == 409
    assert stale.json()["detail"]["code"] == "F-PERIOD-CLOSED"


def test_opening_balance_requires_leaf_active_account_and_book_scope(client):
    headers = _auth(client, "admin", "admin123456")
    first = _book(client, headers, "REVIEW-F")
    second = _book(client, headers, "REVIEW-G")
    first_scoped = {**headers, "X-Account-Book": first["code"]}
    second_scoped = {**headers, "X-Account-Book": second["code"]}
    first_accounts = client.get("/api/v1/finance/accounts/tree", headers=first_scoped).json()
    second_accounts = client.get("/api/v1/finance/accounts/tree", headers=second_scoped).json()
    parent = next(row for row in first_accounts if row["code"] == "1002")
    other_book_account = next(row for row in second_accounts if row["code"] == "1001")

    non_leaf = client.post(
        "/api/v1/finance/opening-balances",
        json={"account_id": parent["id"], "debit": "1.00"},
        headers=first_scoped,
    )
    assert non_leaf.status_code == 400
    assert non_leaf.json()["detail"]["code"] == "F-ACCT-INACTIVE"

    cross_book = client.post(
        "/api/v1/finance/opening-balances",
        json={"account_id": other_book_account["id"], "debit": "1.00"},
        headers=first_scoped,
    )
    assert cross_book.status_code == 400
    assert cross_book.json()["detail"]["code"] == "F-ACCT-INACTIVE"

    leaf = next(row for row in first_accounts if row["code"] == "1601")
    disabled = client.patch(
        f"/api/v1/finance/accounts/{leaf['id']}?active=false", headers=first_scoped
    )
    assert disabled.status_code == 200
    inactive = client.post(
        "/api/v1/finance/opening-balances",
        json={"account_id": leaf["id"], "debit": "1.00"},
        headers=first_scoped,
    )
    assert inactive.status_code == 400
    assert inactive.json()["detail"]["code"] == "F-ACCT-INACTIVE"
