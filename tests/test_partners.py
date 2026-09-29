"""BLF-1152 我的友商模块后端验收：权限 / 分页 / 子表 / 附件全链路。

  1. 权限：全接口仅管理员可用（`require_admin`，与通讯录模块同口径）——
     非管理员稳定 403，未登录 401；鉴权先于业务读写（403 时不落库）。
  2. 友商 CRUD + 统一分页信封 `{total,page,size,items}`：名称 keyword、排序白名单、
     非法分页参数 400、名称唯一。
  3. 业绩合同子表：增删改查 + 校验（必填 / 金额 ≥0 / 有限数字）+
     跨友商隔离（换 pid 引用一律 404）。
  4. 附件（`ref_type='partner'`）：分类白名单、扩展名白名单、统一体积上限
     单一来源（`partners.MAX_SIZE is MAX_ATTACHMENT_SIZE`）、小体积超限 400、
     上传/列表/下载/删除 roundtrip、跨友商 404、删除级联清正文。
  5. 菜单：`/partners` 仅管理员可见。
"""
from test_mvp import login


def _create_partner(client, headers, **overrides):
    body = {"name": "嵩讯科技", **overrides}
    r = client.post("/api/v1/partners", headers=headers, json=body)
    assert r.status_code == 200, r.text
    return r.json()


# ============ 1. 权限 ============

def test_partners_admin_only(client, db):
    pm = login(client, "pm")
    assert client.get("/api/v1/partners", headers=pm).status_code == 403
    assert client.post("/api/v1/partners", headers=pm, json={"name": "X"}).status_code == 403
    assert client.get("/api/v1/partners/1", headers=pm).status_code == 403
    assert client.patch("/api/v1/partners/1", headers=pm, json={}).status_code == 403
    assert client.delete("/api/v1/partners/1", headers=pm).status_code == 403
    assert client.get("/api/v1/partners/1/contracts", headers=pm).status_code == 403
    assert client.post("/api/v1/partners/1/contracts", headers=pm, json={}).status_code == 403
    assert client.get("/api/v1/partners/1/attachments", headers=pm).status_code == 403
    assert client.post(
        "/api/v1/partners/1/attachments",
        headers=pm,
        data={"category": "qual_cert"},
        files={"file": ("q.pdf", b"data", "application/pdf")},
    ).status_code == 403
    # 未登录一律 401
    assert client.get("/api/v1/partners").status_code == 401


def test_partner_forbidden_writes_nothing(client, db):
    """403 先于业务读写：非管理员的创建不落库。"""
    from api.models import Partner

    pm = login(client, "pm")
    r = client.post("/api/v1/partners", headers=pm, json={"name": "越权友商"})
    assert r.status_code == 403
    session = db()
    try:
        assert session.query(Partner).filter_by(name="越权友商").first() is None
    finally:
        session.close()


# ============ 2. CRUD + 分页 ============

def test_partners_crud_and_paging_envelope(client, db):
    h = login(client, "admin")
    a = _create_partner(client, h, name="嵩讯科技",
                        contact_name="张经理", phone="13800138000",
                        email="bd@example.com", remark="核心伙伴")
    b = _create_partner(client, h, name="个体户老王")
    _create_partner(client, h, name="陪标单位A")

    assert "partner_type" not in a and a["contact_name"] == "张经理"
    assert a["attachment_count"] == 0 and "members" not in a and a["contracts"] == []

    # 统一分页信封
    page1 = client.get("/api/v1/partners?page=1&size=2", headers=h).json()
    assert set(page1) >= {"total", "page", "size", "items"}
    assert (page1["total"], page1["page"], page1["size"]) == (3, 1, 2)
    assert len(page1["items"]) == 2
    # 默认 -id：新建的在前
    assert page1["items"][0]["name"] == "陪标单位A"
    page2 = client.get("/api/v1/partners?page=2&size=2", headers=h).json()
    assert len(page2["items"]) == 1
    over = client.get("/api/v1/partners?page=9&size=2", headers=h).json()
    assert over["total"] == 3 and over["items"] == []

    # keyword 只匹配名称
    assert client.get("/api/v1/partners?keyword=嵩讯", headers=h).json()["total"] == 1
    assert client.get("/api/v1/partners?keyword=张经理", headers=h).json()["total"] == 0
    assert client.get("/api/v1/partners?keyword=13800138000", headers=h).json()["total"] == 0
    assert client.get("/api/v1/partners?keyword=不存在", headers=h).json()["total"] == 0

    # 排序白名单：非法 400
    assert client.get("/api/v1/partners?sort=nope", headers=h).status_code == 400
    assert client.get("/api/v1/partners?page=0", headers=h).status_code == 400
    assert client.get("/api/v1/partners?size=101", headers=h).status_code == 400
    by_name = client.get("/api/v1/partners?sort=name&size=10", headers=h).json()
    assert [i["name"] for i in by_name["items"]] == sorted(
        [i["name"] for i in by_name["items"]])

    # 详情 / 更新 / 名称唯一
    got = client.get(f"/api/v1/partners/{a['id']}", headers=h).json()
    assert got["name"] == "嵩讯科技" and "members" not in got and got["contracts"] == []
    assert client.get("/api/v1/partners/999999", headers=h).status_code == 404

    upd = client.patch(f"/api/v1/partners/{a['id']}", headers=h,
                       json={"phone": "13900139000", "remark": "更新备注"})
    assert upd.status_code == 200, upd.text
    assert upd.json()["phone"] == "13900139000"

    dup = client.post("/api/v1/partners", headers=h, json={"name": "嵩讯科技"})
    assert dup.status_code == 400 and "已存在" in dup.json()["detail"]
    dup2 = client.patch(f"/api/v1/partners/{b['id']}", headers=h,
                        json={"name": "嵩讯科技"})
    assert dup2.status_code == 400

    # 校验：空名称 / 超长 / 非法邮箱
    assert client.post("/api/v1/partners", headers=h, json={"name": "  "}).status_code == 400
    assert client.post("/api/v1/partners", headers=h,
                       json={"name": "n" * 129}).status_code == 400
    assert client.post("/api/v1/partners", headers=h,
                       json={"name": "邮箱测试", "email": "not-an-email"}).status_code == 400
    assert client.get("/api/v1/partners", headers=h).json()["total"] == 3


def test_partner_search_is_name_only(client, db):
    h = login(client, "admin")
    _create_partner(client, h, name="名称命中友商", contact_name="联系人命中")
    _create_partner(client, h, name="另一个友商", phone="13800138000")

    assert client.get("/api/v1/partners?keyword=名称命中", headers=h).json()["total"] == 1
    assert client.get("/api/v1/partners?keyword=联系人命中", headers=h).json()["total"] == 0
    assert client.get("/api/v1/partners?keyword=13800138000", headers=h).json()["total"] == 0


def test_partner_payload_excludes_removed_fields(client, db):
    h = login(client, "admin")
    created = _create_partner(client, h, name="字段清理友商", partner_type="旧类型")
    assert "partner_type" not in created
    assert "members" not in created
    assert "member_count" not in created

    detail = client.get(f"/api/v1/partners/{created['id']}", headers=h).json()
    assert "partner_type" not in detail
    assert "members" not in detail
    assert client.get(f"/api/v1/partners/{created['id']}/members", headers=h).status_code == 404


def test_partner_delete_cascades(client, db):
    """删除友商：合同级联，附件正文与元数据一并清理。"""
    from api.models import Attachment, PartnerContract

    h = login(client, "admin")
    p = _create_partner(client, h, name="待删友商")
    pid = p["id"]
    cid = client.post(f"/api/v1/partners/{pid}/contracts", headers=h,
                      json={"project_name": "旧项目", "amount": 10}).json()["id"]
    aid = client.post(f"/api/v1/partners/{pid}/attachments", headers=h,
                      data={"category": "other"},
                      files={"file": ("old.pdf", b"bytes", "application/pdf")}).json()["id"]

    assert client.delete(f"/api/v1/partners/{pid}", headers=h).status_code == 200
    assert client.get(f"/api/v1/partners/{pid}", headers=h).status_code == 404
    session = db()
    try:
        assert session.query(PartnerContract).filter_by(id=cid).first() is None
        assert session.query(Attachment).filter_by(id=aid).first() is None
    finally:
        session.close()


# ============ 3. 业绩合同子表 ============

def test_partner_contracts_roundtrip_and_validation(client, db):
    h = login(client, "admin")
    p = _create_partner(client, h, name="业绩友商")
    pid = p["id"]

    assert client.post(f"/api/v1/partners/{pid}/contracts", headers=h,
                       json={"project_name": "  "}).status_code == 400
    assert client.post(f"/api/v1/partners/{pid}/contracts", headers=h,
                       json={"project_name": "P", "amount": -1}).status_code == 400
    # NaN / Inf：TestClient 的 json= 序列化拒绝非标 float，改走原始请求体直达服务端校验。
    raw_headers = {**h, "Content-Type": "application/json"}
    assert client.post(f"/api/v1/partners/{pid}/contracts", headers=raw_headers,
                       content='{"project_name": "P", "amount": NaN}').status_code == 400
    assert client.post(f"/api/v1/partners/{pid}/contracts", headers=raw_headers,
                       content='{"project_name": "P", "amount": Infinity}').status_code == 400

    c = client.post(f"/api/v1/partners/{pid}/contracts", headers=h,
                    json={"project_name": "某市政项目", "amount": 128.5,
                          "signed_date": "2025-06-01", "remark": "联合体"}).json()
    assert c["amount"] == 128.5 and c["signed_date"] == "2025-06-01"

    rows = client.get(f"/api/v1/partners/{pid}/contracts", headers=h).json()
    assert len(rows) == 1

    upd = client.patch(f"/api/v1/partners/{pid}/contracts/{c['id']}", headers=h,
                       json={"amount": 130})
    assert upd.status_code == 200 and upd.json()["amount"] == 130
    assert client.patch(f"/api/v1/partners/{pid}/contracts/{c['id']}", headers=h,
                        json={"amount": -5}).status_code == 400

    # 详情聚合子表
    detail = client.get(f"/api/v1/partners/{pid}", headers=h).json()
    assert len(detail["contracts"]) == 1 and detail["contracts"][0]["project_name"] == "某市政项目"

    assert client.delete(f"/api/v1/partners/{pid}/contracts/{c['id']}",
                         headers=h).status_code == 200


def test_partner_subresources_isolated_by_pid(client, db):
    """子表 id 不得跨友商复用：换 pid 引用一律 404。"""
    h = login(client, "admin")
    p1 = _create_partner(client, h, name="隔离A")
    p2 = _create_partner(client, h, name="隔离B")
    cid = client.post(f"/api/v1/partners/{p1['id']}/contracts", headers=h,
                      json={"project_name": "隔离项目", "amount": 1}).json()["id"]

    assert client.delete(f"/api/v1/partners/{p2['id']}/contracts/{cid}",
                         headers=h).status_code == 404
    # 原友商下仍正常
    assert client.delete(f"/api/v1/partners/{p1['id']}/contracts/{cid}",
                         headers=h).status_code == 200


# ============ 4. 附件 ============

def test_partner_attachment_single_source_limit():
    """体积上限与全站同一来源（通讯录 / 项目 / 支出凭证同一常量对象）。"""
    from api.core.limits import MAX_ATTACHMENT_SIZE
    from api.routers import partners

    assert partners.MAX_SIZE is MAX_ATTACHMENT_SIZE
    assert MAX_ATTACHMENT_SIZE == 100 * 1024 * 1024


def test_partner_attachment_flow(client, db):
    h = login(client, "admin")
    p = _create_partner(client, h, name="附件友商")
    pid = p["id"]

    bad_category = client.post(f"/api/v1/partners/{pid}/attachments", headers=h,
                               data={"category": "unknown"},
                               files={"file": ("q.pdf", b"d", "application/pdf")})
    assert bad_category.status_code == 400

    bad_type = client.post(f"/api/v1/partners/{pid}/attachments", headers=h,
                           data={"category": "qual_cert"},
                           files={"file": ("evil.exe", b"d", "application/octet-stream")})
    assert bad_type.status_code == 400

    up = client.post(f"/api/v1/partners/{pid}/attachments", headers=h,
                     data={"category": "qual_cert"},
                     files={"file": ("资质证书.pdf", b"%PDF-1.4 fake", "application/pdf")})
    assert up.status_code == 200, up.text
    att = up.json()
    assert att["category"] == "qual_cert" and att["category_label"] == "资质证书"

    rows = client.get(f"/api/v1/partners/{pid}/attachments?category=qual_cert", headers=h)
    assert rows.status_code == 200, rows.text
    assert [r["id"] for r in rows.json()] == [att["id"]]

    contract = client.post(f"/api/v1/partners/{pid}/attachments", headers=h,
                            data={"category": "contract"},
                            files={"file": ("合同附件.pdf", b"%PDF-1.4 contract", "application/pdf")})
    assert contract.status_code == 200, contract.text
    assert contract.json()["category"] == "contract"
    assert [r["id"] for r in client.get(
        f"/api/v1/partners/{pid}/attachments?category=contract", headers=h
    ).json()] == [contract.json()["id"]]
    assert client.get(f"/api/v1/partners/{pid}/attachments?category=nope",
                      headers=h).status_code == 400

    dl = client.get(f"/api/v1/partners/{pid}/attachments/{att['id']}/download", headers=h)
    assert dl.status_code == 200 and dl.content == b"%PDF-1.4 fake"

    # 详情附件计数同步：_attachment_count（partners.py）只按 ref_type/ref_id 过滤，
    # 不按 category 收窄，所以上面挂的 qual_cert + contract 两份都要计入。
    assert client.get(f"/api/v1/partners/{pid}", headers=h).json()["attachment_count"] == 2

    assert client.delete(f"/api/v1/partners/{pid}/attachments/{att['id']}",
                         headers=h).status_code == 200
    # 删掉的只是 qual_cert 那份：裸列表接口不带 category 参数时返回全部分类
    # （list_partner_attachments 里 `if category:` 是短路判断），contract 那份仍在。
    assert [r["id"] for r in client.get(
        f"/api/v1/partners/{pid}/attachments", headers=h
    ).json()] == [contract.json()["id"]]
    # 计数跟着删除回落，形成 2 → 1 的前后对照：证明它真在数 DB 行，
    # 而不是返回写死的常数或被缓存的旧值。
    assert client.get(f"/api/v1/partners/{pid}", headers=h).json()["attachment_count"] == 1


def test_partner_attachment_over_limit_rejected(client, db, monkeypatch):
    """超限 400 走同一 `read_within_limit` 接线：把上限临时调小验证，不传 100MB 真文件。"""
    from api.core import limits
    from api.routers import partners

    h = login(client, "admin")
    pid = _create_partner(client, h, name="上限友商")["id"]
    monkeypatch.setattr(partners, "MAX_SIZE", 10)
    assert limits.MAX_ATTACHMENT_SIZE == 100 * 1024 * 1024  # 全局常量未被污染
    over = client.post(f"/api/v1/partners/{pid}/attachments", headers=h,
                       data={"category": "other"},
                       files={"file": ("big.pdf", b"0123456789X", "application/pdf")})
    assert over.status_code == 400, over.text
    assert client.get(f"/api/v1/partners/{pid}/attachments", headers=h).json() == []


def test_partner_attachment_isolated_by_pid(client, db):
    """附件 id 不得跨友商复用。"""
    h = login(client, "admin")
    p1 = _create_partner(client, h, name="附件隔离A")
    p2 = _create_partner(client, h, name="附件隔离B")
    aid = client.post(f"/api/v1/partners/{p1['id']}/attachments", headers=h,
                      data={"category": "other"},
                      files={"file": ("a.pdf", b"d", "application/pdf")}).json()["id"]
    assert client.get(f"/api/v1/partners/{p2['id']}/attachments/{aid}/download",
                      headers=h).status_code == 404
    assert client.delete(f"/api/v1/partners/{p2['id']}/attachments/{aid}",
                         headers=h).status_code == 404
    assert client.get(f"/api/v1/partners/{p1['id']}/attachments/{aid}/download",
                      headers=h).status_code == 200


def test_partner_attachment_download_audited(client, db):
    """敏感附件下载写审计。"""
    from api.models import AuditLog

    h = login(client, "admin")
    pid = _create_partner(client, h, name="审计友商")["id"]
    aid = client.post(f"/api/v1/partners/{pid}/attachments", headers=h,
                      data={"category": "contract"},
                      files={"file": ("c.pdf", b"d", "application/pdf")}).json()["id"]
    assert client.get(f"/api/v1/partners/{pid}/attachments/{aid}/download",
                      headers=h).status_code == 200
    session = db()
    try:
        row = session.query(AuditLog).filter_by(
            action="download_partner_attachment", resource_id=str(aid)).first()
        assert row is not None
    finally:
        session.close()


# ============ 5. 菜单 ============

def test_partners_menu_admin_only(client):
    admin_menus = client.get("/api/v1/meta/me/menus",
                             headers=login(client, "admin")).json()["menus"]
    pm_menus = client.get("/api/v1/meta/me/menus",
                          headers=login(client, "pm")).json()["menus"]
    assert any(m["href"] == "/partners" for m in admin_menus)
    assert all(m["href"] != "/partners" for m in pm_menus)
