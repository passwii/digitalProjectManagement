"""功能模块按用户分配（Stage 5）：菜单可见性与后端接口门禁同源。

覆盖：
  1. 存量/未分配用户默认四个基础模块（行为不变），管理类模块默认不可见、接口 403；
  2. 管理员模块目录全量，可显式给普通用户分配/回收模块；
  3. 显式分配为空 = 只保留恒可见工作台；
  4. 前端菜单 `/meta/me/menus` 与接口 `require_module` 同一判定（分配后接口放行）。
"""
from test_mvp import login

BASE_MODULES = ["opportunities", "projects", "assets", "reports"]
ADMIN_MODULES = ["contacts", "partners", "approvals"]
BUSINESS_MODULES = BASE_MODULES + ADMIN_MODULES + ["finance"]


def _uid(db, username: str) -> int:
    from api.models import User

    session = db()
    try:
        user = session.query(User).filter_by(username=username).first()
        assert user is not None
        return user.id
    finally:
        session.close()


def _menus(client, headers) -> dict:
    r = client.get("/api/v1/meta/me/menus", headers=headers)
    assert r.status_code == 200, r.text
    return r.json()


def _keys(body: dict) -> list[str]:
    return [m["key"] for m in body["menus"]]


def _set_modules(client, headers, uid: int, modules: list[str]):
    r = client.patch(f"/api/v1/admin/users/{uid}", headers=headers, json={"modules": modules})
    assert r.status_code == 200, r.text
    return r.json()


def test_admin_sees_all_modules_and_catalog(client):
    admin = login(client, "admin")
    body = _menus(client, admin)
    assert body["is_admin"] is True
    assert body["is_super_admin"] is True
    assert body["can_approve"] is True
    assert body["can_finance"] is True
    assert _keys(body) == BUSINESS_MODULES + ["admin"]

    r = client.get("/api/v1/admin/modules", headers=admin)
    assert r.status_code == 200, r.text
    catalog = r.json()
    assert [m["key"] for m in catalog] == BUSINESS_MODULES
    assert all(m["label"] and m["href"] for m in catalog)
    assert {m["key"]: (m["label"], m["href"]) for m in catalog}["finance"] == (
        "财务管理", "/finance"
    )
    assert all(m["key"] != "admin" for m in catalog)


def test_unassigned_user_defaults_to_base_modules(client):
    pm = login(client, "pm")
    body = _menus(client, pm)
    assert body["is_admin"] is False
    assert body["is_super_admin"] is False
    assert _keys(body) == BASE_MODULES
    assert body["can_approve"] is False
    # 未分配管理模块：通讯录/审批中心接口稳定 403
    assert client.get("/api/v1/contacts", headers=pm).status_code == 403
    assert client.get("/api/v1/approvals/pending", headers=pm).status_code == 403


def test_assigning_management_modules_opens_menu_and_api(client, db):
    admin = login(client, "admin")
    pm_id = _uid(db, "pm")

    updated = _set_modules(client, admin, pm_id, ["contacts", "approvals"])
    assert updated["modules"] == ["contacts", "approvals"]

    pm = login(client, "pm")
    body = _menus(client, pm)
    assert _keys(body) == ["contacts", "approvals"]
    assert body["can_approve"] is True

    # 前后端一致：分配后接口放行，未分配的基础模块接口 403
    assert client.get("/api/v1/contacts", headers=pm).status_code == 200
    assert client.get("/api/v1/approvals/pending", headers=pm).status_code == 200
    assert client.get("/api/v1/projects", headers=pm).status_code == 403
    assert client.get("/api/v1/opportunities", headers=pm).status_code == 403


def test_explicitly_empty_modules_keep_only_dashboard(client, db):
    admin = login(client, "admin")
    pm_id = _uid(db, "pm")

    updated = _set_modules(client, admin, pm_id, [])
    assert updated["modules"] == []

    pm = login(client, "pm")
    body = _menus(client, pm)
    assert _keys(body) == []
    assert body["is_admin"] is False and body["is_super_admin"] is False
    assert client.get("/api/v1/projects", headers=pm).status_code == 403


def test_legacy_admin_role_does_not_affect_explicit_modules(client, db):
    from api.models import Role, User, UserRole

    with db() as session:
        user = session.query(User).filter_by(username="pm").one()
        role = session.query(Role).filter_by(code="admin").one()
        session.add(UserRole(user_id=user.id, role_id=role.id))
        user.modules_assigned = True
        session.commit()

    body = _menus(client, login(client, "pm"))
    assert body["is_admin"] is False and body["is_super_admin"] is False
    assert _keys(body) == []


def test_legacy_admin_role_does_not_affect_default_modules(client, db):
    from api.models import Role, User, UserRole

    with db() as session:
        user = session.query(User).filter_by(username="pm").one()
        role = session.query(Role).filter_by(code="admin").one()
        session.add(UserRole(user_id=user.id, role_id=role.id))
        session.commit()

    assert _keys(_menus(client, login(client, "pm"))) == BASE_MODULES


def test_new_user_modules_roundtrip(client):
    admin = login(client, "admin")
    created = client.post(
        "/api/v1/admin/users",
        headers=admin,
        json={
            "username": "13700000001",
            "password": "abc12345",
            "real_name": "模块测试",
            "modules": ["reports", "partners"],
        },
    )
    assert created.status_code == 200, created.text
    assert created.json()["modules"] == ["reports", "partners"]

    new_user = login(client, "13700000001", pwd="abc12345")
    assert _keys(_menus(client, new_user)) == ["reports", "partners"]
    assert client.get("/api/v1/partners", headers=new_user).status_code == 200
    assert client.get("/api/v1/contacts", headers=new_user).status_code == 403
