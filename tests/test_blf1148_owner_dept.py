"""BLF-1148 回归：项目台账负责人筛选（owner_id/owner_name 混用修复）+ 通讯录部门新增。"""
from test_mvp import items, login, mkproject


def _mkuser(db, username: str, real_name: str):
    from api.core.security import hash_password
    from api.models import Department, User

    session = db()
    try:
        dept = session.query(Department).filter_by(name="综合部").first()
        assert dept is not None
        user = User(username=username, pwd_hash=hash_password("x1234567"),
                    real_name=real_name, dept_id=dept.id)
        session.add(user)
        session.commit()
        return user.id
    finally:
        session.close()


def _insert_project(db, code: str, name: str, owner_id, owner_name: str):
    from api.models import Project

    session = db()
    try:
        session.add(Project(code=code, name=name, owner_id=owner_id,
                            owner_name=owner_name, status="doing"))
        session.commit()
    finally:
        session.close()


def _names(r) -> set:
    return {p["name"] for p in items(r)}


def _setup_owner_data(client, db):
    """一致数据 P1/P4 走 API 建，脏数据 P2（陈旧 owner_id）/P3（空 owner_id）直写 DB。"""
    admin = login(client, "admin")
    zhang_id = _mkuser(db, "13800001111", "张爱杰")
    lisi_id = _mkuser(db, "13800002222", "李四")
    mkproject(client, admin, name="BLF1148-P1", owner_id=zhang_id, owner_name="张爱杰")
    _insert_project(db, "PJ-1148-P2", "BLF1148-P2", lisi_id, "张爱杰")
    _insert_project(db, "PJ-1148-P3", "BLF1148-P3", None, "张爱杰")
    mkproject(client, admin, name="BLF1148-P4", owner_id=lisi_id, owner_name="李四")
    return admin, zhang_id, lisi_id


def test_owner_name_exact_hit(client, db):
    admin, _, _ = _setup_owner_data(client, db)
    r = client.get("/api/v1/projects?owner=张爱杰", headers=admin)
    assert r.status_code == 200, r.text
    # 精确匹配命中：一致数据 + 陈旧 owner_id + 空 owner_id 全部命中
    assert _names(r) == {"BLF1148-P1", "BLF1148-P2", "BLF1148-P3"}
    # options 选择器同契约
    r2 = client.get("/api/v1/projects/options?owner=张爱杰", headers=admin)
    assert r2.status_code == 200, r2.text
    assert _names(r2) == {"BLF1148-P1", "BLF1148-P2", "BLF1148-P3"}


def test_owner_name_miss_returns_empty(client, db):
    admin, _, _ = _setup_owner_data(client, db)
    r = client.get("/api/v1/projects?owner=不存在的人", headers=admin)
    assert r.status_code == 200, r.text
    assert items(r) == []  # 匹配不到返回空，而不是回退成全部


def test_owner_empty_returns_all(client, db):
    admin, _, _ = _setup_owner_data(client, db)
    assert _names(client.get("/api/v1/projects", headers=admin)) == {
        "BLF1148-P1", "BLF1148-P2", "BLF1148-P3", "BLF1148-P4"}
    r = client.get("/api/v1/projects?owner=", headers=admin)
    assert r.status_code == 200, r.text
    assert _names(r) == {"BLF1148-P1", "BLF1148-P2", "BLF1148-P3", "BLF1148-P4"}


def test_owner_id_backward_compat(client, db):
    admin, zhang_id, _ = _setup_owner_data(client, db)
    # 老 owner_id 语义保持不变：只按 id 精确过滤
    r = client.get(f"/api/v1/projects?owner_id={zhang_id}", headers=admin)
    assert r.status_code == 200, r.text
    assert _names(r) == {"BLF1148-P1"}
    r = client.get("/api/v1/projects?owner_id=999999", headers=admin)
    assert r.status_code == 200, r.text
    assert items(r) == []


def test_patch_owner_name_relinks_owner_id(client, db):
    from api.models import Project, ProjectChange

    admin, zhang_id, lisi_id = _setup_owner_data(client, db)
    session = db()
    try:
        p3 = session.query(Project).filter_by(name="BLF1148-P3").first()
        pid = p3.id
    finally:
        session.close()
    # 仅改名（不带 owner_id）：新名精确命中唯一用户 → owner_id 同步重链
    r = client.patch(f"/api/v1/projects/{pid}", headers=admin,
                     json={"owner_name": "李四"})
    assert r.status_code == 200, r.text
    assert r.json()["owner_id"] == lisi_id
    session = db()
    try:
        changes = session.query(ProjectChange).filter_by(project_id=pid).all()
        assert {c.field for c in changes} >= {"owner_id", "owner_name"}
    finally:
        session.close()
    assert "BLF1148-P3" in _names(
        client.get("/api/v1/projects?owner=李四", headers=admin))
    # 改名到查无此人的名字：owner_id 保持不动，读侧仍按 owner_name 命中
    r = client.patch(f"/api/v1/projects/{pid}", headers=admin,
                     json={"owner_name": "外部顾问"})
    assert r.status_code == 200, r.text
    assert r.json()["owner_id"] == lisi_id
    assert _names(client.get("/api/v1/projects?owner=外部顾问", headers=admin)) == {
        "BLF1148-P3"}


def test_patch_owner_name_duplicate_name_no_relink(client, db):
    from api.models import Project

    admin, zhang_id, _ = _setup_owner_data(client, db)
    _mkuser(db, "13800003333", "同名")
    _mkuser(db, "13800004444", "同名")
    session = db()
    try:
        p1 = session.query(Project).filter_by(name="BLF1148-P1").first()
        pid = p1.id
    finally:
        session.close()
    r = client.patch(f"/api/v1/projects/{pid}", headers=admin,
                     json={"owner_name": "同名"})
    assert r.status_code == 200, r.text
    # 同名多人无法唯一确定 → 不乱链，保持原 owner_id
    assert r.json()["owner_id"] == zhang_id


def test_departments_seed_contract(client, db):
    from api.models import Department
    from api.seed import DEPARTMENTS

    assert DEPARTMENTS == ["综合部", "行销部", "交付与服务部", "市场部", "总经办"]
    # 与 seed.main() 相同的幂等补齐逻辑跑两遍：5 个部门全量存在且无重复
    session = db()
    try:
        for _ in range(2):
            for dept_name in DEPARTMENTS:
                if not session.query(Department).filter_by(name=dept_name).first():
                    session.add(Department(name=dept_name))
            session.commit()
        names = sorted(d.name for d in session.query(Department).all())
        assert names == sorted(DEPARTMENTS)
        # 综合部是存量第一部门（users.dept_id 外键指向），id 必须保持为首位不变
        first = session.query(Department).order_by(Department.id).first()
        assert first.name == "综合部"
    finally:
        session.close()
    # 通讯录建档/筛选可用到新部门：建档行销部人员并按部门筛出
    admin = login(client, "admin")
    session = db()
    try:
        dept = session.query(Department).filter_by(name="行销部").first()
        dept_id = dept.id
    finally:
        session.close()
    r = client.post("/api/v1/contacts", headers=admin,
                    json={"name": "行销人员", "mobile": "13900001111",
                          "dept_id": dept_id})
    assert r.status_code == 200, r.text
    r = client.get(f"/api/v1/contacts?dept_id={dept_id}", headers=admin)
    assert r.status_code == 200, r.text
    assert any(p["name"] == "行销人员" for p in items(r))
