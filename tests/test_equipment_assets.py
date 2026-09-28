"""公司设备资产：权限、生命周期和批量导入的接口契约。"""
import pytest
from openpyxl import Workbook

from api.models import AuditLog, Dict, EquipmentAsset, EquipmentEvent
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
    assert client.post(f"{ROOT}/inbound", headers=login(client, "pm"), json={"items": []}).status_code == 403


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
