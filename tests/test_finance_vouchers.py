"""P0-B regression tests for the finance voucher engine."""

from decimal import Decimal
import io

from openpyxl import Workbook, load_workbook


def _auth(client, username, password):
    response = client.post(
        "/api/v1/auth/login", json={"username": username, "password": password}
    )
    assert response.status_code == 200
    return {"Authorization": f"Bearer {response.json()['access_token']}"}


def _book(client, headers, code="VOUCHER-TEST"):
    response = client.post(
        "/api/v1/finance/books", json={"code": code, "name": code}, headers=headers
    )
    assert response.status_code == 200
    return response.json()


def _scoped(headers, book):
    return {**headers, "X-Account-Book": book["code"]}


def _accounts(client, headers):
    rows = client.get("/api/v1/finance/accounts/tree", headers=headers).json()
    return {row["code"]: row for row in rows}


def test_admin_menu_exposes_finance_but_member_does_not(client):
    admin = _auth(client, "admin", "admin123456")
    member = _auth(client, "pm", "pm123456")

    admin_menus = client.get("/api/v1/meta/me/menus", headers=admin)
    member_menus = client.get("/api/v1/meta/me/menus", headers=member)

    assert admin_menus.status_code == member_menus.status_code == 200
    assert {item["href"] for item in admin_menus.json()["menus"]}.__contains__("/finance")
    assert "/finance" not in {item["href"] for item in member_menus.json()["menus"]}

    forbidden = client.get("/api/v1/finance/books", headers=member)
    assert forbidden.status_code == 403


def test_voucher_rejects_unbalanced_entries_without_persisting(client):
    headers = _auth(client, "admin", "admin123456")
    book = _book(client, headers, "VOUCHER-UNBALANCED")
    scoped = _scoped(headers, book)
    accounts = _accounts(client, scoped)
    periods = client.get("/api/v1/finance/periods", headers=scoped).json()

    response = client.post(
        "/api/v1/finance/vouchers",
        headers=scoped,
        json={
            "period_id": periods[0]["id"],
            "voucher_no": "记-0001",
            "voucher_date": periods[0]["start_date"],
            "summary": "不平衡测试",
            "lines": [
                {"account_id": accounts["1405"]["id"], "debit": "10.00", "credit": "0", "summary": "采购"},
                {"account_id": accounts["6001"]["id"], "debit": "0", "credit": "9.99", "summary": "收入"},
            ],
        },
    )

    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "F-UNBALANCED"
    assert client.get("/api/v1/finance/vouchers", headers=scoped).json()["total"] == 0


def test_voucher_rejects_internal_sources_and_unreviewed_posting(client):
    headers = _auth(client, "admin", "admin123456")
    book = _book(client, headers, "VOUCHER-SOURCE")
    scoped = _scoped(headers, book)
    accounts = _accounts(client, scoped)
    cash_account = next(row for row in accounts.values() if row["is_leaf"] and row["aux_flags"].get("cashflow"))
    period = client.get("/api/v1/finance/periods", headers=scoped).json()[0]
    payload = {
        "period_id": period["id"],
        "voucher_no": "记-0001",
        "voucher_date": period["start_date"],
        "source": "auto-close",
        "lines": [
            {"account_id": accounts["1405"]["id"], "debit": "1.00", "credit": "0", "summary": "库存"},
            {"account_id": accounts["6001"]["id"], "debit": "0", "credit": "1.00", "summary": "收入"},
        ],
    }
    rejected = client.post("/api/v1/finance/vouchers", headers=scoped, json=payload)
    assert rejected.status_code == 400
    assert rejected.json()["detail"]["code"] == "F-INVALID-VOUCHER"

    payload["source"] = "manual"
    created = client.post("/api/v1/finance/vouchers", headers=scoped, json=payload).json()
    assert client.post(f"/api/v1/finance/vouchers/{created['id']}/submit", headers=scoped).status_code == 200
    blocked = client.post(f"/api/v1/finance/vouchers/{created['id']}/post", headers=scoped)
    assert blocked.status_code == 400
    assert blocked.json()["detail"]["code"] == "F-SOD"


def test_voucher_lifecycle_posts_once_and_updates_balance(client):
    headers = _auth(client, "admin", "admin123456")
    book = _book(client, headers, "VOUCHER-LIFECYCLE")
    scoped = _scoped(headers, book)
    accounts = _accounts(client, scoped)
    periods = client.get("/api/v1/finance/periods", headers=scoped).json()
    payload = {
        "period_id": periods[0]["id"],
        "voucher_no": "记-0001",
        "voucher_date": periods[0]["start_date"],
        "summary": "销售收款",
        "lines": [
            {"account_id": accounts["1405"]["id"], "debit": "100.00", "credit": "0", "summary": "采购"},
            {"account_id": accounts["6001"]["id"], "debit": "0", "credit": "100.00", "summary": "收入"},
        ],
    }

    created = client.post("/api/v1/finance/vouchers", headers=scoped, json=payload)
    assert created.status_code == 200
    assert created.json()["status"] == "draft"

    voucher_id = created.json()["id"]
    submitted = client.post(f"/api/v1/finance/vouchers/{voucher_id}/submit", headers=scoped)
    assert submitted.status_code == 200
    assert submitted.json()["status"] == "pending"

    approved = client.post(f"/api/v1/finance/vouchers/{voucher_id}/approve", headers=scoped)
    assert approved.status_code == 200
    assert approved.json()["status"] == "pending"

    posted = client.post(f"/api/v1/finance/vouchers/{voucher_id}/post", headers=scoped)
    assert posted.status_code == 200
    assert posted.json()["status"] == "posted"

    duplicate = client.post(f"/api/v1/finance/vouchers/{voucher_id}/post", headers=scoped)
    assert duplicate.status_code == 400
    assert duplicate.json()["detail"]["code"] == "F-VOUCHER-STATE"

    balances = client.get(
        "/api/v1/finance/balances",
        headers=scoped,
        params={"period_id": periods[0]["id"]},
    )
    assert balances.status_code == 200
    rows = {row["account_code"]: row for row in balances.json()["items"]}
    assert Decimal(rows["1405"]["debit_total"]) == Decimal("100.00")
    assert Decimal(rows["6001"]["credit_total"]) == Decimal("100.00")


def test_posted_voucher_can_only_be_corrected_by_reversal(client):
    headers = _auth(client, "admin", "admin123456")
    book = _book(client, headers, "VOUCHER-REVERSAL")
    scoped = _scoped(headers, book)
    accounts = _accounts(client, scoped)
    cash_account = next(row for row in accounts.values() if row["is_leaf"] and row["aux_flags"].get("cashflow"))
    period = client.get("/api/v1/finance/periods", headers=scoped).json()[0]
    payload = {
        "period_id": period["id"],
        "voucher_no": "记-0001",
        "voucher_date": period["start_date"],
        "summary": "待冲销",
        "lines": [
            {"account_id": accounts["1405"]["id"], "debit": "20.00", "credit": "0", "summary": "采购"},
            {"account_id": accounts["6001"]["id"], "debit": "0", "credit": "20.00", "summary": "收入"},
        ],
    }
    created = client.post("/api/v1/finance/vouchers", headers=scoped, json=payload).json()
    vid = created["id"]
    assert client.post(f"/api/v1/finance/vouchers/{vid}/submit", headers=scoped).status_code == 200
    assert client.post(f"/api/v1/finance/vouchers/{vid}/approve", headers=scoped).status_code == 200
    assert client.post(f"/api/v1/finance/vouchers/{vid}/post", headers=scoped).status_code == 200

    edited = client.patch(
        f"/api/v1/finance/vouchers/{vid}", headers=scoped, json={"summary": "不允许直接改"}
    )
    assert edited.status_code == 400
    assert edited.json()["detail"]["code"] == "F-VOUCHER-POSTED"

    reversal = client.post(f"/api/v1/finance/vouchers/{vid}/reverse", headers=scoped)
    assert reversal.status_code == 200
    assert reversal.json()["status"] == "draft"
    assert reversal.json()["reversal_of"] == vid
    assert reversal.json()["lines"][0]["credit"] == "20.00"
    assert reversal.json()["lines"][0]["debit"] == "0.00"


def test_close_check_blocks_unreviewed_vouchers_and_close_round_trip(client):
    headers = _auth(client, "admin", "admin123456")
    book = _book(client, headers, "VOUCHER-CLOSE")
    scoped = _scoped(headers, book)
    accounts = _accounts(client, scoped)
    cash_account = next(row for row in accounts.values() if row["is_leaf"] and row["aux_flags"].get("cashflow"))
    period = client.get("/api/v1/finance/periods", headers=scoped).json()[0]
    payload = {
        "period_id": period["id"],
        "voucher_no": "记-0001",
        "voucher_date": period["start_date"],
        "summary": "结账检查",
        "lines": [
            {"account_id": accounts["1405"]["id"], "debit": "10.00", "credit": "0", "summary": "采购"},
            {"account_id": accounts["6001"]["id"], "debit": "0", "credit": "10.00", "summary": "收入"},
        ],
    }
    created = client.post("/api/v1/finance/vouchers", headers=scoped, json=payload).json()
    assert client.post(f"/api/v1/finance/vouchers/{created['id']}/submit", headers=scoped).status_code == 200

    blocked = client.post("/api/v1/finance/close/check", headers=scoped, params={"period_id": period["id"]})
    assert blocked.status_code == 200
    assert blocked.json()["ready"] is False
    assert any(item["code"] == "F-UNREVIEWED-VOUCHER" for item in blocked.json()["issues"])

    assert client.post(f"/api/v1/finance/vouchers/{created['id']}/approve", headers=scoped).status_code == 200
    assert client.post(f"/api/v1/finance/vouchers/{created['id']}/post", headers=scoped).status_code == 200
    closed = client.post("/api/v1/finance/close/run", headers={**scoped, "If-Match": str(period["version"])}, params={"period_id": period["id"]})
    assert closed.status_code == 200
    assert closed.json()["status"] == "closed"

    reopened = client.post("/api/v1/finance/close/reverse", headers={**scoped, "If-Match": "2"}, params={"period_id": period["id"], "confirm": "true"})
    assert reopened.status_code == 200
    assert reopened.json()["status"] == "open"
    vouchers = client.get("/api/v1/finance/vouchers", headers=scoped, params={"period_id": period["id"], "size": 100}).json()["items"]
    assert any(item["source"] == "auto-reopen" and item["status"] == "posted" for item in vouchers)


def test_posting_carries_previous_period_balance_forward(client):
    headers = _auth(client, "admin", "admin123456")
    book = _book(client, headers, "VOUCHER-CARRY-FORWARD")
    scoped = _scoped(headers, book)
    accounts = _accounts(client, scoped)
    periods = client.get("/api/v1/finance/periods", headers=scoped).json()
    first, second = periods[:2]

    def post(period, number, amount):
        payload = {
            "period_id": period["id"],
            "voucher_no": f"记-{number:04d}",
            "voucher_date": period["start_date"],
            "summary": "跨期余额",
            "lines": [
                {"account_id": accounts["1405"]["id"], "debit": str(amount), "credit": "0", "summary": "库存"},
                {"account_id": accounts["6001"]["id"], "debit": "0", "credit": str(amount), "summary": "收入"},
            ],
        }
        created = client.post("/api/v1/finance/vouchers", headers=scoped, json=payload).json()
        assert client.post(f"/api/v1/finance/vouchers/{created['id']}/submit", headers=scoped).status_code == 200
        assert client.post(f"/api/v1/finance/vouchers/{created['id']}/approve", headers=scoped).status_code == 200
        assert client.post(f"/api/v1/finance/vouchers/{created['id']}/post", headers=scoped).status_code == 200

    post(first, 1, "100.00")
    post(second, 1, "25.00")
    balances = client.get("/api/v1/finance/balances", headers=scoped, params={"period_id": second["id"]})
    assert balances.status_code == 200
    rows = {row["account_code"]: row for row in balances.json()["items"]}
    assert Decimal(rows["1405"]["debit_total"]) == Decimal("25.00")
    assert Decimal(rows["1405"]["ending_debit"]) == Decimal("125.00")
    assert Decimal(rows["6001"]["credit_total"]) == Decimal("25.00")
    assert Decimal(rows["6001"]["ending_credit"]) == Decimal("125.00")


def test_close_generates_profit_carry_forward_and_preserves_income_report(client):
    headers = _auth(client, "admin", "admin123456")
    book = _book(client, headers, "VOUCHER-AUTO-CLOSE")
    scoped = _scoped(headers, book)
    accounts = _accounts(client, scoped)
    period = client.get("/api/v1/finance/periods", headers=scoped).json()[0]
    payload = {
        "period_id": period["id"],
        "voucher_no": "记-0001",
        "voucher_date": period["start_date"],
        "summary": "结转测试收入",
        "lines": [
            {"account_id": accounts["1405"]["id"], "debit": "100.00", "credit": "0", "summary": "库存"},
            {"account_id": accounts["6001"]["id"], "debit": "0", "credit": "100.00", "summary": "收入"},
        ],
    }
    created = client.post("/api/v1/finance/vouchers", headers=scoped, json=payload).json()
    assert client.post(f"/api/v1/finance/vouchers/{created['id']}/submit", headers=scoped).status_code == 200
    assert client.post(f"/api/v1/finance/vouchers/{created['id']}/approve", headers=scoped).status_code == 200
    assert client.post(f"/api/v1/finance/vouchers/{created['id']}/post", headers=scoped).status_code == 200

    closed = client.post(
        "/api/v1/finance/close/run",
        headers={**scoped, "If-Match": str(period["version"])},
        params={"period_id": period["id"]},
    )
    assert closed.status_code == 200

    vouchers = client.get("/api/v1/finance/vouchers", headers=scoped, params={"period_id": period["id"], "size": 100}).json()["items"]
    auto = next(item for item in vouchers if item["source"] == "auto-close")
    assert auto["status"] == "posted"
    auto_lines = {line["account_code"]: line for line in auto["lines"]}
    assert auto_lines["6001"]["debit"] == "100.00"
    assert auto_lines["3103"]["credit"] == "100.00"

    income = client.get("/api/v1/finance/reports/income", headers=scoped, params={"period_id": period["id"]})
    assert income.status_code == 200
    assert Decimal(income.json()["totals"]["profit"]) == Decimal("100.00")
    balance_sheet = client.get("/api/v1/finance/reports/balance-sheet", headers=scoped, params={"period_id": period["id"]})
    assert balance_sheet.status_code == 200
    assert balance_sheet.json()["totals"]["balanced"] is True


def test_voucher_template_is_book_scoped_and_can_generate_draft(client):
    headers = _auth(client, "admin", "admin123456")
    book = _book(client, headers, "VOUCHER-TEMPLATE")
    scoped = _scoped(headers, book)
    accounts = _accounts(client, scoped)
    period = client.get("/api/v1/finance/periods", headers=scoped).json()[0]
    template = client.post(
        "/api/v1/finance/voucher-templates",
        headers=scoped,
        json={
            "code": "OFFICE",
            "name": "办公费模板",
            "lines": [
                {"account_id": accounts["1405"]["id"], "summary": "办公费", "debit": "100.00", "credit": "0", "aux_detail": {}},
                {"account_id": accounts["6001"]["id"], "summary": "办公费", "debit": "0", "credit": "100.00", "aux_detail": {}},
            ],
        },
    )
    assert template.status_code == 200
    assert template.json()["code"] == "OFFICE"
    listed = client.get("/api/v1/finance/voucher-templates", headers=scoped)
    assert listed.status_code == 200
    assert [row["code"] for row in listed.json()] == ["OFFICE"]

    generated = client.post(
        "/api/v1/finance/vouchers/from-template",
        headers=scoped,
        json={
            "template_id": template.json()["id"],
            "period_id": period["id"],
            "voucher_no": "记-0001",
            "voucher_date": period["start_date"],
            "summary": "一月办公费",
        },
    )
    assert generated.status_code == 200
    assert generated.json()["status"] == "draft"
    assert generated.json()["source"] == "template"
    assert generated.json()["lines"][0]["debit"] == "100.00"


def test_voucher_excel_import_is_atomic_and_reports_row_numbers(client):
    headers = _auth(client, "admin", "admin123456")
    book = _book(client, headers, "VOUCHER-IMPORT")
    scoped = _scoped(headers, book)
    accounts = _accounts(client, scoped)
    period = client.get("/api/v1/finance/periods", headers=scoped).json()[0]

    wb = Workbook()
    ws = wb.active
    ws.append(["凭证号", "凭证日期", "摘要", "科目编码", "分录摘要", "借方", "贷方", "现金流项目", "辅助核算JSON"])
    ws.append(["记-0001", period["start_date"], "导入成功", "1405", "库存", "12.00", "0", "", "{}"])
    ws.append(["记-0001", period["start_date"], "导入成功", "6001", "收入", "0", "12.00", "", "{}"])
    ws.append(["记-0002", period["start_date"], "导入失败", "NOPE", "错误科目", "1.00", "0", "", "{}"])
    stream = io.BytesIO()
    wb.save(stream)
    stream.seek(0)

    imported = client.post(
        f"/api/v1/finance/vouchers/import?period_id={period['id']}",
        headers=scoped,
        files={"file": ("vouchers.xlsx", stream.getvalue(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
    )
    assert imported.status_code == 400
    detail = imported.json()["detail"]
    assert detail["code"] == "F-IMPORT-INVALID"
    assert any(item["row"] == 4 for item in detail["details"])
    assert client.get("/api/v1/finance/vouchers", headers=scoped).json()["total"] == 0

    wb.remove(wb.active)
    ws = wb.create_sheet()
    ws.append(["凭证号", "凭证日期", "摘要", "科目编码", "分录摘要", "借方", "贷方", "现金流项目", "辅助核算JSON"])
    ws.append(["记-0001", period["start_date"], "导入成功", "1405", "库存", "12.00", "0", "", "{}"])
    ws.append(["记-0001", period["start_date"], "导入成功", "6001", "收入", "0", "12.00", "", "{}"])
    stream = io.BytesIO()
    wb.save(stream)
    stream.seek(0)
    success = client.post(
        f"/api/v1/finance/vouchers/import?period_id={period['id']}",
        headers=scoped,
        files={"file": ("vouchers.xlsx", stream.getvalue(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
    )
    assert success.status_code == 200
    assert success.json()["imported"] == 1


def test_voucher_excel_export_contains_current_book_vouchers(client):
    headers = _auth(client, "admin", "admin123456")
    book = _book(client, headers, "VOUCHER-EXPORT")
    scoped = _scoped(headers, book)
    accounts = _accounts(client, scoped)
    period = client.get("/api/v1/finance/periods", headers=scoped).json()[0]
    payload = {
        "period_id": period["id"],
        "voucher_no": "记-0001",
        "voucher_date": period["start_date"],
        "summary": "导出测试",
        "lines": [
            {"account_id": accounts["1405"]["id"], "debit": "2.00", "credit": "0", "summary": "库存"},
            {"account_id": accounts["6001"]["id"], "debit": "0", "credit": "2.00", "summary": "收入"},
        ],
    }
    created = client.post("/api/v1/finance/vouchers", headers=scoped, json=payload).json()
    assert client.post(f"/api/v1/finance/vouchers/{created['id']}/submit", headers=scoped).status_code == 200
    assert client.post(f"/api/v1/finance/vouchers/{created['id']}/approve", headers=scoped).status_code == 200
    assert client.post(f"/api/v1/finance/vouchers/{created['id']}/post", headers=scoped).status_code == 200
    exported = client.get(f"/api/v1/finance/vouchers/export?period_id={period['id']}", headers=scoped)
    assert exported.status_code == 200
    sheet = load_workbook(io.BytesIO(exported.content), read_only=True).active
    rows = list(sheet.iter_rows(values_only=True))
    assert rows[0][:5] == ("凭证号", "凭证日期", "摘要", "科目编码", "分录摘要")
    assert any(row[0] == "记-0001" for row in rows[1:])


def test_cash_transaction_creates_a_book_scoped_draft_voucher(client):
    headers = _auth(client, "admin", "admin123456")
    book = _book(client, headers, "CASH-TRANSACTION")
    scoped = _scoped(headers, book)
    accounts = _accounts(client, scoped)
    cash_account = next(row for row in accounts.values() if row["is_leaf"] and row["aux_flags"].get("cashflow"))
    period = client.get("/api/v1/finance/periods", headers=scoped).json()[0]

    created = client.post(
        "/api/v1/finance/cash-transactions",
        headers=scoped,
        json={
            "period_id": period["id"],
            "kind": "receipt",
            "transaction_date": period["start_date"],
            "amount": "88.00",
            "account_id": cash_account["id"],
            "offset_account_id": accounts["6001"]["id"],
            "summary": "客户收款",
            "counterparty": "客户A",
            "cashflow_item": "C01",
        },
    )
    assert created.status_code == 200, created.text
    body = created.json()
    assert body["kind"] == "receipt"
    assert body["voucher"]["status"] == "draft"
    assert body["voucher"]["source"] == "cash"
    assert body["voucher"]["lines"][0]["debit"] == "88.00"


def test_bank_statement_import_match_and_reconciliation_summary(client):
    headers = _auth(client, "admin", "admin123456")
    book = _book(client, headers, "BANK-RECONCILE")
    scoped = _scoped(headers, book)
    accounts = _accounts(client, scoped)
    cash_account = next(row for row in accounts.values() if row["is_leaf"] and row["aux_flags"].get("cashflow"))
    period = client.get("/api/v1/finance/periods", headers=scoped).json()[0]

    cash_response = client.post(
        "/api/v1/finance/cash-transactions",
        headers=scoped,
        json={
            "period_id": period["id"],
            "kind": "receipt",
            "transaction_date": period["start_date"],
            "amount": "50.00",
            "account_id": cash_account["id"],
            "offset_account_id": accounts["6001"]["id"],
            "summary": "银行收款",
            "cashflow_item": "C01",
        },
    )
    assert cash_response.status_code == 200, cash_response.text
    cash = cash_response.json()
    voucher_id = cash["voucher"]["id"]
    assert client.post(f"/api/v1/finance/vouchers/{voucher_id}/submit", headers=scoped).status_code == 200
    assert client.post(f"/api/v1/finance/vouchers/{voucher_id}/approve", headers=scoped).status_code == 200
    assert client.post(f"/api/v1/finance/vouchers/{voucher_id}/post", headers=scoped).status_code == 200

    wb = Workbook()
    ws = wb.active
    ws.append(["流水号", "交易日期", "方向", "金额", "银行账户", "摘要", "对方"])
    ws.append(["BANK-001", period["start_date"], "流入", "50.00", "100201", "银行收款", "客户A"])
    stream = io.BytesIO()
    wb.save(stream)
    stream.seek(0)
    imported = client.post(
        f"/api/v1/finance/bank-statements/import?period_id={period['id']}",
        headers=scoped,
        files={"file": ("bank.xlsx", stream.getvalue(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
    )
    assert imported.status_code == 200
    statement_id = imported.json()["items"][0]["id"]

    matched = client.post(
        f"/api/v1/finance/bank-statements/{statement_id}/match",
        headers=scoped,
        json={"voucher_id": voucher_id},
    )
    assert matched.status_code == 200
    assert matched.json()["status"] == "matched"

    summary = client.get(
        "/api/v1/finance/bank-reconciliation",
        headers=scoped,
        params={"period_id": period["id"]},
    )
    assert summary.status_code == 200
    assert summary.json()["unmatched_count"] == 0
    assert Decimal(summary.json()["bank_total"]) == Decimal("50.00")


def test_bank_statement_import_is_atomic_and_reports_row_number(client):
    headers = _auth(client, "admin", "admin123456")
    book = _book(client, headers, "BANK-IMPORT-ERROR")
    scoped = _scoped(headers, book)
    period = client.get("/api/v1/finance/periods", headers=scoped).json()[0]
    wb = Workbook()
    ws = wb.active
    ws.append(["流水号", "交易日期", "方向", "金额", "银行账户", "摘要", "对方"])
    ws.append(["BANK-OK", period["start_date"], "流入", "10.00", "100201", "正常", "A"])
    ws.append(["BANK-BAD", period["start_date"], "未知", "20.00", "100201", "错误", "B"])
    stream = io.BytesIO()
    wb.save(stream)
    stream.seek(0)
    response = client.post(
        f"/api/v1/finance/bank-statements/import?period_id={period['id']}",
        headers=scoped,
        files={"file": ("bank.xlsx", stream.getvalue(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
    )
    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "F-IMPORT-INVALID"
    assert any(item["row"] == 3 for item in response.json()["detail"]["details"])
    assert client.get("/api/v1/finance/bank-statements", headers=scoped).json()["total"] == 0


def test_finance_book_roles_separate_read_entry_review_cash_and_close(client, db):
    admin = _auth(client, "admin", "admin123456")
    clerk = _auth(client, "pm", "pm123456")
    outsider = _auth(client, "outsider", "out123456")
    book = _book(client, admin, "ROLE-MATRIX")
    scoped_admin = _scoped(admin, book)
    accounts = _accounts(client, scoped_admin)
    period = client.get("/api/v1/finance/periods", headers=scoped_admin).json()[0]

    from api.models import AccountBookMember, User
    with db() as session:
        clerk_user = session.query(User).filter_by(username="pm").first()
        session.add(AccountBookMember(account_book_id=book["id"], user_id=clerk_user.id, role="finance_clerk"))
        session.commit()

    scoped_clerk = _scoped(clerk, book)
    read = client.get("/api/v1/finance/accounts/tree", headers=scoped_clerk)
    assert read.status_code == 200
    draft = client.post("/api/v1/finance/vouchers", headers=scoped_clerk, json={
        "period_id": period["id"], "voucher_no": "记-0001", "voucher_date": period["start_date"], "summary": "制单",
        "lines": [
            {"account_id": accounts["1405"]["id"], "debit": "1.00", "credit": "0", "summary": "库存"},
            {"account_id": accounts["6001"]["id"], "debit": "0", "credit": "1.00", "summary": "收入"},
        ],
    })
    assert draft.status_code == 200
    voucher_id = draft.json()["id"]
    assert client.post(f"/api/v1/finance/vouchers/{voucher_id}/submit", headers=scoped_clerk).status_code == 200
    assert client.post(f"/api/v1/finance/vouchers/{voucher_id}/approve", headers=scoped_clerk).status_code == 403
    assert client.post("/api/v1/finance/close/check", headers=scoped_clerk, params={"period_id": period["id"]}).status_code == 403

    assert client.get("/api/v1/finance/books", headers=outsider).status_code == 403
