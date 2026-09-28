"""公司设备资产：权限、生命周期和批量导入的接口契约。"""
from datetime import date
import csv
import io

import pytest
from openpyxl import Workbook

from api.models import AuditLog, Dict, EquipmentAsset, EquipmentEvent, EquipmentBatch
from test_mvp import login


ROOT = "/api/v1/equipment-assets"


@pytest.fixture(autouse=True)
def categories(db):
    with db() as session:
        for code, label in (("computer", "电脑"), ("monitor", "显示器"), ("printer", "打印机"),
                            ("network", "网络设备"), ("instrument", "工具仪器"), ("other", "其他")):
            session.add(Dict(type="equipment_category", code=code, label=label))
        session.commit()


def _create(client, headers, name="笔记本", **extra):
    response = client.post(ROOT, headers=headers, json={"name": name, "category_code": "computer", **extra})
    assert response.status_code == 200, response.text
    return response.json()


def test_permissions_and_lifecycle(client, db):
    admin, pm, outsider = (login(client, who) for who in ("admin", "pm", "outsider"))
    assert client.post(ROOT, headers=pm, json={"name": "电脑", "category_code": "computer"}).status_code == 403
    assert client.get(ROOT, headers=pm).status_code == 200
    asset = _create(client, admin)
    aid = asset["id"]
    assert asset["code"].startswith("EQ-")
    assert client.post(f"{ROOT}/{aid}/borrow", headers=pm, json={"due_date": "2099-01-01"}).status_code == 200
    assert client.post(f"{ROOT}/{aid}/return", headers=outsider).status_code == 403
    assert client.post(f"{ROOT}/{aid}/return", headers=pm).status_code == 200
    assert client.post(f"{ROOT}/{aid}/claim", headers=pm).status_code == 200
    assert client.post(f"{ROOT}/{aid}/return", headers=pm).status_code == 403
    assert client.post(f"{ROOT}/{aid}/return", headers=admin).status_code == 200
    assert client.post(f"{ROOT}/{aid}/maintenance", headers=pm).status_code == 403
    assert client.post(f"{ROOT}/{aid}/maintenance", headers=admin).status_code == 200
    assert client.post(f"{ROOT}/{aid}/scrap", headers=admin).status_code == 200
    assert client.post(f"{ROOT}/{aid}/borrow", headers=pm).status_code == 400
    events = client.get(f"{ROOT}/{aid}/events", headers=pm)
    assert [item["action"] for item in events.json()["items"]] == [
        "create", "borrow", "return", "claim", "return", "maintenance", "scrap"
    ]
    with db() as session:
        assert session.query(EquipmentEvent).filter_by(asset_id=aid).count() == 7
        assert session.query(AuditLog).filter_by(resource="equipment_assets", resource_id=str(aid)).count() == 7


def test_batch_and_unique_codes(client, db):
    admin = login(client, "admin")
    response = client.post(f"{ROOT}/inbound", headers=admin, json={
        "source": "采购单 1", "items": [{"name": "显示器", "category_code": "monitor"}, {"name": "显示器", "category_code": "monitor"}]
    })
    assert response.status_code == 200, response.text
    items = response.json()["items"]
    assert len(items) == 2 and len({item["code"] for item in items}) == 2
    assert all(item["batch_id"] == response.json()["batch_id"] for item in items)
    assert response.json()["acceptance_status"] == "accepted"
    assert all(item["status"] == "available" for item in items)
    assert client.post(f"{ROOT}/inbound", headers=login(client, "pm"), json={"items": []}).status_code == 403


def test_export_neutralizes_formula_strings_in_csv_and_xlsx(client):
    admin = login(client, "admin")
    values = ["=1+1", "+SUM(A1:A2)", "-1+2", "@SUM(A1)", "  =1+1", "\t+1+1"]
    for i, value in enumerate(values):
        _create(client, admin, name=value, serial_number=f"FORMULA-{i}")

    csv_response = client.get(f"{ROOT}/export?format=csv", headers=admin)
    assert csv_response.status_code == 200
    rows = list(csv.DictReader(io.StringIO(csv_response.content.decode("utf-8-sig"))))
    assert [row["name"] for row in rows] == ["'" + value for value in values]

    xlsx_response = client.get(f"{ROOT}/export?format=xlsx", headers=admin)
    assert xlsx_response.status_code == 200
    from openpyxl import load_workbook
    sheet = load_workbook(io.BytesIO(xlsx_response.content), data_only=False).active
    assert [sheet.cell(row, 2).value for row in range(2, len(values) + 2)] == values
    assert all(sheet.cell(row, 2).data_type == "s" for row in range(2, len(values) + 2))


def test_pending_batch_metadata_is_readable_and_assets_cannot_be_claimed(client, db):
    admin, pm = login(client, "admin"), login(client, "pm")
    response = client.post(f"{ROOT}/inbound", headers=admin, json={
        "source": "供应商送货", "supplier": "星河设备有限公司", "purchase_order_no": "PO-2026-018",
        "invoice_no": "INV-2026-88", "acceptance_status": "pending_acceptance", "note": "待清点",
        "items": [{"name": "待验收电脑", "category_code": "computer", "serial_number": "PENDING-1"}],
    })
    assert response.status_code == 200, response.text
    result = response.json()
    asset = result["items"][0]
    assert asset["status"] == "pending_acceptance"
    assert client.post(f"{ROOT}/{asset['id']}/claim", headers=pm).status_code == 400
    assert client.post(f"{ROOT}/{asset['id']}/borrow", headers=pm, json={"due_date": "2099-01-01"}).status_code == 400
    batches = client.get(f"{ROOT}/batches", headers=pm)
    assert batches.status_code == 200
    batch = next(item for item in batches.json()["items"] if item["id"] == result["batch_id"])
    assert batch["source"] == "供应商送货"
    assert batch["supplier"] == "星河设备有限公司"
    assert batch["purchase_order_no"] == "PO-2026-018"
    assert batch["invoice_no"] == "INV-2026-88"
    assert batch["acceptance_status"] == "pending_acceptance"
    assert batch["note"] == "待清点"
    assert batch["created_by"]
    assert batch["created_at"]
    detail = client.get(f"{ROOT}/batches/{result['batch_id']}", headers=pm)
    assert detail.status_code == 200
    assert detail.json()["items"][0]["id"] == asset["id"]


def test_admin_acceptance_updates_batch_assets_events_and_audit_atomically(client, db, monkeypatch):
    admin, pm = login(client, "admin"), login(client, "pm")
    response = client.post(f"{ROOT}/inbound", headers=admin, json={
        "supplier": "Acme", "acceptance_status": "pending_acceptance", "items": [
            {"name": "电脑甲", "category_code": "computer"},
            {"name": "电脑乙", "category_code": "computer"},
        ],
    })
    assert response.status_code == 200, response.text
    batch_id = response.json()["batch_id"]
    assert client.post(f"{ROOT}/batches/{batch_id}/accept", headers=pm).status_code == 403
    accepted = client.post(f"{ROOT}/batches/{batch_id}/accept", headers=admin, json={"note": "验收合格"})
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["acceptance_status"] == "accepted"
    assert {item["status"] for item in accepted.json()["items"]} == {"available"}
    with db() as session:
        assert session.query(EquipmentEvent).filter_by(batch_id=batch_id, action="acceptance").count() == 2
        assert session.query(AuditLog).filter_by(resource="equipment_batches", resource_id=str(batch_id)).count() == 2

    pending = client.post(f"{ROOT}/inbound", headers=admin, json={
        "acceptance_status": "pending_acceptance", "items": [{"name": "电脑丙", "category_code": "computer"}],
    }).json()
    second_batch_id = pending["batch_id"]
    import api.core.audit as audit
    def fail(*_args, **_kwargs):
        raise RuntimeError("audit unavailable")
    monkeypatch.setattr(audit, "audit_row", fail)
    failed = client.post(f"{ROOT}/batches/{second_batch_id}/accept", headers=admin)
    assert failed.status_code == 500
    with db() as session:
        assert session.get(EquipmentBatch, second_batch_id).acceptance_status == "pending_acceptance"
        second_asset = session.query(EquipmentAsset).filter_by(batch_id=second_batch_id).one()
        assert second_asset.status == "pending_acceptance"
        assert session.query(EquipmentEvent).filter_by(asset_id=second_asset.id).count() == 1


def test_import_prevalidation_is_atomic(client, db):
    admin = login(client, "admin")
    payload = b"name,category_code,serial_number\nGood,computer,S1\nBad,unknown,S2\n"
    response = client.post(f"{ROOT}/import", headers=admin, files={"file": ("assets.csv", payload, "text/csv")})
    assert response.status_code == 400, response.text
    assert response.json()["detail"]["errors"][0]["row"] == 3
    with db() as session:
        assert session.query(EquipmentAsset).count() == 0
    good = b"name,category_code,serial_number\nGood,computer,S1\nOther,monitor,S2\n"
    response = client.post(f"{ROOT}/import", headers=admin, files={"file": ("assets.csv", good, "text/csv")})
    assert response.status_code == 200, response.text
    assert response.json()["created"] == 2
    assert client.post(f"{ROOT}/import", headers=admin, files={"file": ("assets.csv", good, "text/csv")}).status_code == 400
    assert client.get(f"{ROOT}/export?format=csv", headers=admin).status_code == 200
    assert client.get(f"{ROOT}/export?format=xlsx", headers=admin).status_code == 200
    assert client.get(f"{ROOT}/export?format=csv", headers=login(client, "pm")).status_code == 403


def test_xlsx_import_and_invalid_rows(client, db):
    admin = login(client, "admin")
    book = Workbook()
    sheet = book.active
    sheet.append(["name", "category_code", "purchase_price"])
    sheet.append(["路由器", "network", 100])
    sheet.append(["无价设备", "other", "nonsense"])
    from io import BytesIO
    stream = BytesIO()
    book.save(stream)
    response = client.post(f"{ROOT}/import", headers=admin,
                           files={"file": ("assets.xlsx", stream.getvalue())})
    assert response.status_code == 400, response.text
    assert response.json()["detail"]["errors"][0]["row"] == 3
    with db() as session:
        assert session.query(EquipmentAsset).count() == 0


def test_corrupt_xlsx_returns_validation_error(client):
    admin = login(client, "admin")
    response = client.post(f"{ROOT}/import", headers=admin,
                           files={"file": ("assets.xlsx", b"broken workbook")})
    assert response.status_code == 400, response.text


def test_audit_failure_rolls_back_state_and_event(client, db, monkeypatch):
    admin = login(client, "admin")
    asset = _create(client, admin)
    import api.core.audit as audit
    def fail(*_args, **_kwargs):
        raise RuntimeError("audit unavailable")
    monkeypatch.setattr(audit, "audit_row", fail)
    response = client.post(f"{ROOT}/{asset['id']}/scrap", headers=admin)
    assert response.status_code == 500
    with db() as session:
        assert session.get(EquipmentAsset, asset["id"]).status == "available"
        assert session.query(EquipmentEvent).filter_by(asset_id=asset["id"]).count() == 1


def test_overdue_lists_only_borrowed_assets_past_due_date(client, db):
    admin, pm = login(client, "admin"), login(client, "pm")
    overdue_asset = _create(client, admin, name="逾期电脑")
    upcoming_asset = _create(client, admin, name="未逾期电脑")
    assert client.post(f"{ROOT}/{overdue_asset['id']}/borrow", headers=pm,
                       json={"due_date": "2099-01-01"}).status_code == 200
    assert client.post(f"{ROOT}/{upcoming_asset['id']}/borrow", headers=pm,
                       json={"due_date": "2099-01-01"}).status_code == 200
    with db() as session:
        session.get(EquipmentAsset, overdue_asset["id"]).due_date = date(2000, 1, 1)
        session.commit()

    response = client.get(f"{ROOT}/overdue", headers=pm)
    assert response.status_code == 200, response.text
    assert [item["id"] for item in response.json()["items"]] == [overdue_asset["id"]]


def test_category_admin_crud_and_referenced_category_cannot_be_deleted(client):
    admin = login(client, "admin")
    created = client.post(f"{ROOT}/categories", headers=admin,
                          json={"code": "camera", "label": "相机", "sort": 9})
    assert created.status_code == 200, created.text
    assert created.json() == {"code": "camera", "label": "相机", "sort": 9}
    updated = client.patch(f"{ROOT}/categories/camera", headers=admin,
                           json={"label": "摄影设备", "sort": 3})
    assert updated.status_code == 200, updated.text
    assert updated.json() == {"code": "camera", "label": "摄影设备", "sort": 3}
    assert client.delete(f"{ROOT}/categories/camera", headers=admin).json() == {"ok": True}

    assert client.post(f"{ROOT}/categories", headers=admin,
                       json={"code": "tablet", "label": "平板"}).status_code == 200
    assert client.post(ROOT, headers=admin,
                       json={"name": "平板设备", "category_code": "tablet"}).status_code == 200
    blocked = client.delete(f"{ROOT}/categories/tablet", headers=admin)
    assert blocked.status_code == 400


def test_statistics_monthly_inbound_and_outbound_count_equipment_events(client):
    admin, pm = login(client, "admin"), login(client, "pm")
    created = _create(client, admin, name="新建资产")
    inbound = client.post(f"{ROOT}/inbound", headers=admin, json={"items": [
        {"name": "入库资产", "category_code": "computer"},
    ]})
    assert inbound.status_code == 200, inbound.text
    pending = client.post(f"{ROOT}/inbound", headers=admin, json={
        "acceptance_status": "pending_acceptance",
        "items": [{"name": "验收资产", "category_code": "monitor"}],
    })
    assert pending.status_code == 200, pending.text
    pending_id = pending.json()["batch_id"]
    assert client.post(f"{ROOT}/batches/{pending_id}/accept", headers=admin).status_code == 200
    assert client.post(f"{ROOT}/{created['id']}/claim", headers=pm).status_code == 200
    assert client.post(f"{ROOT}/{created['id']}/return", headers=admin).status_code == 200
    inbound_asset_id = inbound.json()["items"][0]["id"]
    assert client.post(f"{ROOT}/{inbound_asset_id}/borrow", headers=pm,
                       json={"due_date": "2099-01-01"}).status_code == 200

    response = client.get(f"{ROOT}/statistics", headers=pm)
    assert response.status_code == 200, response.text
    month = date.today().strftime("%Y-%m")
    summary = next(row for row in response.json()["by_month"] if row["month"] == month)
    assert summary == {"month": month, "inbound": 4, "outbound": 2}
