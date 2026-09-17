"""通讯录花名册：人员主数据、可选账号关联与附件回归。"""
from test_mvp import login


def _uid(db, username: str) -> int:
    from api.models import User

    session = db()
    try:
        user = session.query(User).filter_by(username=username).first()
        assert user is not None
        return user.id
    finally:
        session.close()


def _dept_id(db) -> int:
    from api.models import Department

    session = db()
    try:
        return session.query(Department).first().id
    finally:
        session.close()


def _create_contact(client, headers, **overrides):
    body = {
        "name": "通讯录人员",
        "mobile": "13800138000",
        "employment_type": "正式",
        "employment_status": "active",
        **overrides,
    }
    response = client.post("/api/v1/contacts", headers=headers, json=body)
    assert response.status_code == 200, response.text
    return response.json()


def test_contact_profile_model(db):
    from api.models import ContactProfile

    session = db()
    try:
        row = ContactProfile(name="无账号人员", mobile="13800138000", employee_no="E001")
        session.add(row)
        session.commit()
        assert row.id
        assert row.user_id is None
    finally:
        session.close()


def test_contacts_admin_only(client):
    headers = login(client, "pm")
    assert client.get("/api/v1/contacts", headers=headers).status_code == 403
    assert client.post("/api/v1/contacts", headers=headers, json={"name": "A"}).status_code == 403
    assert client.get("/api/v1/contacts/999", headers=headers).status_code == 403
    assert client.patch("/api/v1/contacts/999", headers=headers, json={}).status_code == 403
    assert client.post(
        "/api/v1/contacts/999/attachments",
        headers=headers,
        data={"category": "id_card"},
        files={"file": ("id.png", b"png", "image/png")},
    ).status_code == 403


def test_contacts_independent_and_optional_account_link(client, db):
    headers = login(client, "admin")
    pm_id = _uid(db, "pm")
    dept_id = _dept_id(db)

    standalone = _create_contact(
        client,
        headers,
        name="外包工程师",
        mobile="13900139000",
        dept_id=dept_id,
        employee_no="OUT-001",
        position="实施顾问",
    )
    assert standalone["user_id"] is None
    assert standalone["has_account"] is False
    assert standalone["mobile"] == "13900139000"

    linked = _create_contact(
        client,
        headers,
        name="项目经理",
        mobile="13700137000",
        user_id=pm_id,
        employee_no="E001",
        position="项目总监",
        hire_date="2024-03-01",
        contract_type="劳动合同",
        contract_start="2024-03-01",
        contract_end="2027-02-28",
    )
    assert linked["user_id"] == pm_id
    assert linked["has_account"] is True
    assert linked["employee_no"] == "E001"

    listed = client.get("/api/v1/contacts?keyword=外包&page=1&size=20", headers=headers)
    assert listed.status_code == 200, listed.text
    assert listed.json()["total"] == 1
    assert listed.json()["items"][0]["name"] == "外包工程师"

    updated = client.patch(
        f"/api/v1/contacts/{linked['id']}",
        headers=headers,
        json={"position": "交付负责人"},
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["position"] == "交付负责人"

    duplicate = client.patch(
        f"/api/v1/contacts/{standalone['id']}",
        headers=headers,
        json={"employee_no": "E001"},
    )
    assert duplicate.status_code == 400
    assert "工号" in duplicate.json()["detail"]

    duplicate_link = client.patch(
        f"/api/v1/contacts/{standalone['id']}",
        headers=headers,
        json={"user_id": pm_id},
    )
    assert duplicate_link.status_code == 400
    assert "已关联" in duplicate_link.json()["detail"]


def test_admin_created_user_gets_contact(client, db):
    headers = login(client, "admin")
    existing = _create_contact(
        client,
        headers,
        name="待开户人员",
        mobile="13600136000",
        dept_id=_dept_id(db),
    )
    created = client.post(
        "/api/v1/admin/users",
        headers=headers,
        json={
            "username": "13600136000",
            "password": "abc12345",
            "real_name": "新员工",
            "dept_id": _dept_id(db),
            "roles": ["member"],
        },
    )
    assert created.status_code == 200, created.text
    user_id = created.json()["id"]
    detail = client.get(f"/api/v1/contacts?keyword=13600136000", headers=headers).json()
    assert detail["total"] == 1
    assert detail["items"][0]["id"] == existing["id"]
    assert detail["items"][0]["user_id"] == user_id
    assert detail["items"][0]["has_account"] is True


def test_contact_attachment_flow(client, db):
    headers = login(client, "admin")
    contact = _create_contact(client, headers, name="证件测试人员")
    cid = contact["id"]

    bad_category = client.post(
        f"/api/v1/contacts/{cid}/attachments",
        headers=headers,
        data={"category": "unknown"},
        files={"file": ("id.png", b"png", "image/png")},
    )
    assert bad_category.status_code == 400

    bad_type = client.post(
        f"/api/v1/contacts/{cid}/attachments",
        headers=headers,
        data={"category": "professional_cert"},
        files={"file": ("evil.exe", b"data", "application/octet-stream")},
    )
    assert bad_type.status_code == 400

    uploaded = client.post(
        f"/api/v1/contacts/{cid}/attachments",
        headers=headers,
        data={"category": "id_card"},
        files={"file": ("身份证正面.png", b"id-card-bytes", "image/png")},
    )
    assert uploaded.status_code == 200, uploaded.text
    attachment = uploaded.json()
    assert attachment["category"] == "id_card"
    assert attachment["filename"] == "身份证正面.png"

    rows = client.get(
        f"/api/v1/contacts/{cid}/attachments?category=id_card",
        headers=headers,
    )
    assert rows.status_code == 200, rows.text
    assert [row["id"] for row in rows.json()] == [attachment["id"]]

    downloaded = client.get(
        f"/api/v1/contacts/{cid}/attachments/{attachment['id']}/download",
        headers=headers,
    )
    assert downloaded.status_code == 200
    assert downloaded.content == b"id-card-bytes"

    deleted = client.delete(
        f"/api/v1/contacts/{cid}/attachments/{attachment['id']}",
        headers=headers,
    )
    assert deleted.status_code == 200
    assert client.get(
        f"/api/v1/contacts/{cid}/attachments",
        headers=headers,
    ).json() == []


def test_contacts_menu_admin_only(client):
    admin_menus = client.get(
        "/api/v1/meta/me/menus",
        headers=login(client, "admin"),
    ).json()["menus"]
    pm_menus = client.get(
        "/api/v1/meta/me/menus",
        headers=login(client, "pm"),
    ).json()["menus"]
    assert any(item["href"] == "/contacts" for item in admin_menus)
    assert all(item["href"] != "/contacts" for item in pm_menus)
