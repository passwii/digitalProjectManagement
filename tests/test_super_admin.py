from __future__ import annotations

import pytest
from sqlalchemy import Boolean, text
from sqlalchemy.exc import IntegrityError

from api import seed
from api.models import Role, User, UserRole


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
