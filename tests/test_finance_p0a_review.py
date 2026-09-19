"""Review-gate regression tests for the finance P0-A isolation contracts."""


def _auth(client, username, password):
    response = client.post("/api/v1/auth/login", json={"username": username, "password": password})
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
        "/api/v1/finance/accounts/tree", headers={**headers, "X-Account-Book": first["code"]}
    )
    second_accounts = client.get(
        "/api/v1/finance/accounts/tree", headers={**headers, "X-Account-Book": second["code"]}
    )
    assert first_accounts.status_code == second_accounts.status_code == 200
    assert len(first_accounts.json()) >= 15
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
        json={"code": "100201", "name": "非法一级", "direction": "D", "category": "资产"},
        headers=scoped,
    )
    assert invalid_root.status_code == 400

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
    assert len(client.get("/api/v1/finance/account-auxiliaries", headers=scoped).json()) == 1


def test_period_reopen_requires_confirmation_reverse_order_and_version(client):
    headers = _auth(client, "admin", "admin123456")
    book = _book(client, headers, "REVIEW-D")
    scoped = {**headers, "X-Account-Book": book["code"]}
    periods = client.get("/api/v1/finance/periods", headers=scoped).json()
    first, second = periods[:2]

    close_first = client.patch(
        f"/api/v1/finance/periods/{first['id']}",
        json={"status": "closed"},
        headers={**scoped, "If-Match": str(first["version"])},
    )
    assert close_first.status_code == 200
    reopen_without_confirmation = client.patch(
        f"/api/v1/finance/periods/{first['id']}",
        json={"status": "open"},
        headers={**scoped, "If-Match": "2"},
    )
    assert reopen_without_confirmation.status_code == 400

    close_second = client.patch(
        f"/api/v1/finance/periods/{second['id']}",
        json={"status": "closed"},
        headers={**scoped, "If-Match": str(second["version"])},
    )
    assert close_second.status_code == 200
    wrong_order = client.patch(
        f"/api/v1/finance/periods/{first['id']}",
        json={"status": "open"},
        headers={**scoped, "If-Match": "2", "X-Reopen-Period": "confirm"},
    )
    assert wrong_order.status_code == 400

    reopen_second = client.patch(
        f"/api/v1/finance/periods/{second['id']}",
        json={"status": "open"},
        headers={**scoped, "If-Match": "2", "X-Reopen-Period": "confirm"},
    )
    assert reopen_second.status_code == 200
    stale = client.patch(
        f"/api/v1/finance/periods/{first['id']}",
        json={"status": "open"},
        headers={**scoped, "If-Match": "1", "X-Reopen-Period": "confirm"},
    )
    assert stale.status_code == 409
