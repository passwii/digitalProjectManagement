from __future__ import annotations

import pytest
from sqlalchemy import Boolean, text
from sqlalchemy.exc import IntegrityError

from api import seed
from api.models import AuditLog, Role, User, UserRole


def test_super_admin_metadata_contract():
    assert "is_super_admin" in User.__table__.c
    column = User.__table__.c.is_super_admin
    assert isinstance(column.type, Boolean)
    assert column.nullable is False
    assert column.default.arg is False
    assert str(column.server_default.arg) == "false"
    index = next(index for index in User.__table__.indexes if index.name == "uq_users_single_super_admin")
    assert index.unique
    assert list(index.columns) == [column]
    assert str(index.dialect_options["postgresql"]["where"]) == "users.is_super_admin = true"


def test_fixture_super_admin_is_explicit_and_legacy_role_does_not_promote(db):
    with db() as session:
        users = session.query(User).order_by(User.username).all()
        assert {user.username: user.is_super_admin for user in users} == {
            "admin": True, "cost": False, "deptm": False,
            "exec": False, "outsider": False, "pm": False,
        }
        outsider = session.query(User).filter_by(username="outsider").one()
        admin_role = session.query(Role).filter_by(code="admin").one()
        session.add(UserRole(user_id=outsider.id, role_id=admin_role.id))
        session.commit()
        session.refresh(outsider)
        assert outsider.is_super_admin is False


def test_metadata_rejects_second_super_admin_and_accepts_multiple_ordinary_users(db):
    with db() as session:
        session.add_all([
            User(username="ordinary_one", pwd_hash="unused"),
            User(username="ordinary_two", pwd_hash="unused"),
        ])
        session.commit()
        assert session.query(User).filter_by(is_super_admin=False).count() == 7
        with pytest.raises(IntegrityError) as error:
            with session.begin_nested():
                session.add(User(username="second_super_admin", pwd_hash="unused", is_super_admin=True))
                session.flush()
        assert error.value.orig.diag.constraint_name == "uq_users_single_super_admin"
        session.execute(text("INSERT INTO users (username, pwd_hash) VALUES ('sql_default', 'unused')"))
        assert session.query(User).filter_by(username="sql_default").one().is_super_admin is False
        with pytest.raises(IntegrityError):
            with session.begin_nested():
                session.execute(text("INSERT INTO users (username, pwd_hash, is_super_admin) VALUES ('null_flag', 'unused', NULL)"))


@pytest.mark.parametrize("existing_initial_admin", [False, True])
def test_seed_sets_only_initial_admin_flag_and_is_idempotent(db, monkeypatch, existing_initial_admin):
    with db() as session:
        # The fixture's super-admin must relinquish its flag before seeding another identity.
        fixture_admin = session.query(User).filter_by(username="admin").one()
        fixture_admin.is_super_admin = False
        if existing_initial_admin:
            session.add(User(username=seed.INITIAL_ADMIN_USERNAME, pwd_hash="existing_hash"))
        session.commit()
        engine = session.get_bind()

    monkeypatch.setattr(seed, "engine", engine)
    monkeypatch.setattr(seed, "SessionLocal", db)
    seed.main()
    seed.main()
    with db() as session:
        initial = session.query(User).filter_by(username=seed.INITIAL_ADMIN_USERNAME).one()
        assert initial.is_super_admin is True
        assert [user.username for user in session.query(User).filter_by(is_super_admin=True)] == [seed.INITIAL_ADMIN_USERNAME]
        assert session.query(User).filter_by(username="admin").one().is_super_admin is False
        admin_role = session.query(Role).filter_by(code="admin").one()
        assert session.query(UserRole).filter_by(user_id=initial.id, role_id=admin_role.id).count() == 1
        if existing_initial_admin:
            assert initial.pwd_hash == "existing_hash"
        else:
            assert initial.must_change_pwd is True


def test_legacy_admin_role_does_not_grant_system_management(client, db):
    from test_mvp import login

    with db() as session:
        user = session.query(User).filter_by(username="outsider").one()
        admin_role = session.query(Role).filter_by(code="admin").one()
        session.add(UserRole(user_id=user.id, role_id=admin_role.id))
        session.commit()

    headers = login(client, "outsider", pwd="out123456")
    users_response = client.get("/api/v1/admin/users", headers=headers)
    params_response = client.get("/api/v1/admin/params", headers=headers)
    assert users_response.status_code == 403
    assert params_response.status_code == 403
    assert users_response.json()["detail"] == "仅超级管理员可操作"

    menus = client.get("/api/v1/meta/me/menus", headers=headers)
    assert menus.status_code == 200, menus.text
    assert menus.json()["is_super_admin"] is False
    assert menus.json()["is_admin"] is False
    assert all(item["key"] != "admin" for item in menus.json()["menus"])


def test_super_admin_cannot_be_disabled_and_rejection_has_no_side_effects(client, db):
    from test_mvp import login

    with db() as session:
        admin = session.query(User).filter_by(username="admin").one()
        admin_id = admin.id

    headers = login(client, "admin")
    with db() as session:
        admin = session.query(User).filter_by(id=admin_id).one()
        admin.failed_count = 3
        session.commit()

    response = client.patch(
        f"/api/v1/admin/users/{admin_id}",
        headers=headers,
        json={"status": "disabled"},
    )
    assert response.status_code == 409, response.text

    with db() as session:
        admin = session.query(User).filter_by(id=admin_id).one()
        assert admin.status == "active"
        assert admin.failed_count == 3
        assert session.query(AuditLog).filter_by(
            action="update_user", resource_id=str(admin_id)
        ).count() == 0

    restored = client.patch(
        f"/api/v1/admin/users/{admin_id}",
        headers=login(client, "admin"),
        json={"status": "active"},
    )
    assert restored.status_code == 200, restored.text
    with db() as session:
        admin = session.query(User).filter_by(id=admin_id).one()
        assert admin.status == "active"
        assert admin.failed_count == 0
        assert admin.locked_until is None


@pytest.mark.parametrize(
    "payload",
    [
        {"username": "13700000011", "password": "abc12345", "roles": ["admin"]},
        {"username": "13700000012", "password": "abc12345", "is_super_admin": True},
    ],
)
def test_create_user_rejects_role_and_super_admin_fields(client, db, payload):
    from test_mvp import login

    response = client.post("/api/v1/admin/users", headers=login(client, "admin"), json=payload)
    assert response.status_code == 400, response.text
    with db() as session:
        assert session.query(User).filter_by(username=payload["username"]).count() == 0


@pytest.mark.parametrize("payload", [{"roles": ["admin"]}, {"is_super_admin": True}])
def test_update_user_rejects_role_and_super_admin_fields_before_writes(client, db, payload):
    from test_mvp import login

    with db() as session:
        target = session.query(User).filter_by(username="outsider").one()
        target_id = target.id

    response = client.patch(
        f"/api/v1/admin/users/{target_id}", headers=login(client, "admin"), json=payload
    )
    assert response.status_code == 400, response.text
    with db() as session:
        target = session.query(User).filter_by(id=target_id).one()
        assert target.is_super_admin is False
        assert [role.code for role in target.roles] == ["member"]


def test_user_modules_rejects_admin_key_before_creating_account(client, db):
    from test_mvp import login

    response = client.post(
        "/api/v1/admin/users",
        headers=login(client, "admin"),
        json={"username": "13700000013", "password": "abc12345", "modules": ["admin"]},
    )
    assert response.status_code == 400, response.text
    with db() as session:
        assert session.query(User).filter_by(username="13700000013").count() == 0


def test_user_modules_patch_rejects_admin_key_without_changing_existing_assignment(client, db):
    from test_mvp import login

    with db() as session:
        target = session.query(User).filter_by(username="outsider").one()
        target.modules_assigned = True
        target_id = target.id
        session.commit()

    response = client.patch(
        f"/api/v1/admin/users/{target_id}",
        headers=login(client, "admin"),
        json={"modules": ["admin"]},
    )
    assert response.status_code == 400, response.text
    with db() as session:
        target = session.query(User).filter_by(id=target_id).one()
        assert target.modules_assigned is True
        assert target.modules == []
