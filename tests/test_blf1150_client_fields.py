"""BLF-1150 Stage2 后端验收：台账客户字段 + 支出票据接口补充核实。

A. 客户字段（`client_contact` 客户联系人 / `client_phone` 联系方式）：
  1. 创建时可写、详情/列表可读、PATCH 可改、留痕可查；
  2. 不传时默认空串 —— 存量数据不受迁移影响（迁移侧 `server_default=""`）。
B. 支出票据补充（既有 roundtrip 已覆盖 png/非法类型/空文件/越权列表下载删除）：
  3. 发票 PDF 可上传（需求明示「发票 PDF 或凭证图片」）；
  4. 凭证与支出强绑定 —— 跨支出引用下载/删除一律 404；
  5. 删除权限精确到「上传者本人或管理员」—— 同项目非上传成员删除 403，
     但列表/下载可读；管理员可删。
"""
from tests.test_stage4a_closure import items, login, mkproject, set_params


def _uid(client, ha, username):
    rows = items(client.get("/api/v1/admin/users", headers=ha))
    return next(u["id"] for u in rows if u["username"] == username)


# ============ A. 客户字段 ============

def test_client_fields_roundtrip_and_change_log(client, db):
    h = login(client, "pm")
    p = mkproject(client, h, "P1150Client",
                  client_contact="王经理", client_phone="13800138000")
    assert p["client_contact"] == "王经理" and p["client_phone"] == "13800138000"

    got = client.get(f"/api/v1/projects/{p['id']}", headers=h).json()
    assert got["client_contact"] == "王经理" and got["client_phone"] == "13800138000"

    rows = items(client.get("/api/v1/projects?name=P1150Client", headers=h))
    assert rows[0]["client_contact"] == "王经理"

    r = client.patch(f"/api/v1/projects/{p['id']}",
                     json={"client_contact": "李助理", "client_phone": "010-88886666"},
                     headers=h)
    assert r.status_code == 200, r.text
    assert r.json()["client_contact"] == "李助理"
    assert r.json()["client_phone"] == "010-88886666"

    fields = {c["field"] for c in
              client.get(f"/api/v1/projects/{p['id']}/changes", headers=h).json()}
    assert {"client_contact", "client_phone"} <= fields


def test_client_fields_default_empty_for_legacy_rows(client, db):
    """不带新字段创建（模拟迁移前存量行）→ 读写均为 http://空串，不炸 500。"""
    h = login(client, "pm")
    p = mkproject(client, h, "P1150Legacy")
    assert p["client_contact"] == "" and p["client_phone"] == ""
    got = client.get(f"/api/v1/projects/{p['id']}", headers=h).json()
    assert got["client_contact"] == "" and got["client_phone"] == ""


# ============ B. 支出票据补充 ============

def test_voucher_pdf_accepted(client, db):
    """需求点名「发票 PDF」—— .pdf 必须在白名单内可上传、可下载。"""
    h = login(client, "pm")
    p = mkproject(client, h, "P1150Pdf")
    e = client.post("/api/v1/expenses",
                    json={"project_id": p["id"], "subject": "采购", "amount": 100},
                    headers=h).json()
    up = client.post(f"/api/v1/expenses/{e['id']}/vouchers", headers=h,
                     files={"file": ("发票.pdf", b"%PDF-1.4 fake", "application/pdf")})
    assert up.status_code == 200, up.text
    dl = client.get(
        f"/api/v1/expenses/{e['id']}/vouchers/{up.json()['id']}/download", headers=h)
    assert dl.status_code == 200 and dl.content == b"%PDF-1.4 fake"


def test_voucher_bound_to_expense(client, db):
    """凭证 id 不得跨支出复用 —— 换一个 eid 引用同一 aid，下载/删除都是 404。"""
    h = login(client, "pm")
    p = mkproject(client, h, "P1150Bound")
    e1 = client.post("/api/v1/expenses",
                     json={"project_id": p["id"], "subject": "采购", "amount": 10},
                     headers=h).json()
    e2 = client.post("/api/v1/expenses",
                     json={"project_id": p["id"], "subject": "差旅", "amount": 20},
                     headers=h).json()
    vid = client.post(f"/api/v1/expenses/{e1['id']}/vouchers", headers=h,
                      files={"file": ("a.png", b"img", "image/png")}).json()["id"]
    assert client.get(f"/api/v1/expenses/{e2['id']}/vouchers/{vid}/download",
                      headers=h).status_code == 404
    assert client.delete(f"/api/v1/expenses/{e2['id']}/vouchers/{vid}",
                         headers=h).status_code == 404
    # 原支出下仍正常
    assert client.get(f"/api/v1/expenses/{e1['id']}/vouchers/{vid}/download",
                      headers=h).status_code == 200


def test_voucher_delete_only_uploader_or_admin(client, db):
    """同项目非上传成员：列表/下载可读，删除 403；管理员可删。"""
    h = login(client, "pm")
    ha = login(client, "admin")
    hc = login(client, "cost")
    p = mkproject(client, h, "P1150Del")
    cid = _uid(client, ha, "cost")
    assert client.put(f"/api/v1/projects/{p['id']}/members", headers=h,
                      json={"user_ids": [cid]}).status_code == 200
    e = client.post("/api/v1/expenses",
                    json={"project_id": p["id"], "subject": "采购", "amount": 50},
                    headers=h).json()
    vid = client.post(f"/api/v1/expenses/{e['id']}/vouchers", headers=h,
                      files={"file": ("a.png", b"img", "image/png")}).json()["id"]

    lst = client.get(f"/api/v1/expenses/{e['id']}/vouchers", headers=hc)
    assert lst.status_code == 200 and len(lst.json()) == 1
    assert client.get(f"/api/v1/expenses/{e['id']}/vouchers/{vid}/download",
                      headers=hc).status_code == 200
    assert client.delete(f"/api/v1/expenses/{e['id']}/vouchers/{vid}",
                         headers=hc).status_code == 403
    assert client.delete(f"/api/v1/expenses/{e['id']}/vouchers/{vid}",
                         headers=ha).status_code == 200
    assert client.get(f"/api/v1/expenses/{e['id']}/vouchers",
                      headers=h).json() == []
    set_params(client, ha, expense_approval_on="0")
