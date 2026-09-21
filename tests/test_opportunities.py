"""商机管理的 CRUD、分页和导航顺序验收。"""

from test_mvp import login


def test_opportunities_crud_and_sidebar_order(client, db):
    h = login(client, "pm")

    menus = client.get("/api/v1/meta/me/menus", headers=h)
    assert menus.status_code == 200, menus.text
    assert [item["key"] for item in menus.json()["menus"]][:2] == ["opportunities", "projects"]

    created = client.post(
        "/api/v1/opportunities",
        headers=h,
        json={
            "name": "城市更新商机",
            "client": "某市建设单位",
            "owner_name": "pm",
            "budget_total": 128000,
            "stage": "proposal",
            "expected_close": "2026-12-31",
        },
    )
    assert created.status_code == 200, created.text
    item = created.json()
    assert item["code"].startswith("OPP-")
    assert item["stage"] == "proposal"

    listing = client.get("/api/v1/opportunities?keyword=城市更新&page=1&size=10", headers=h)
    assert listing.status_code == 200, listing.text
    assert listing.json()["total"] == 1

    updated = client.patch(
        f"/api/v1/opportunities/{item['id']}",
        headers=h,
        json={"stage": "won", "expected_close": "2027-01-10"},
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["stage"] == "won"
    assert updated.json()["expected_close"] == "2027-01-10"

    assert client.post(
        "/api/v1/opportunities",
        headers=h,
        json={"name": "非法阶段商机", "stage": "unknown"},
    ).status_code == 400
    assert client.delete(f"/api/v1/opportunities/{item['id']}", headers=h).status_code == 200
    assert client.get(f"/api/v1/opportunities/{item['id']}", headers=h).status_code == 404
