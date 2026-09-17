"""BLF-1119：附件单文件上限 20MB → 100MB 的后端回归（常量单一来源 + 有界读取 + 边界值）。

覆盖 issue 要求：

  1. **单一常量真相**：三个上传入口共用 `api/core/limits.py` 的一份常量，
     超限文案里的数字由常量推导（改限制时文案不会漂移）；
  2. **读取方式一致**：`read_within_limit` 统一 `read(limit + 1)`，
     超限在读完 limit+1 字节时即 400，不会把无界数据整体读进内存；
  3. **边界值**：恰好等于上限 → 200 且落盘大小正确；超过上限 → 400 且文案含 `100MB`；
  4. **验收 grep**：`api/` 下不再残留 `20 * 1024 * 1024` / `20MB`。

三个入口（项目附件 / 人员档案附件 / 支出凭证）各自的边界用例都跑真实 HTTP + 真实 100MB 体积，
避免「只测辅助函数、入口却漏改」的假绿。
"""
import io
import re
from pathlib import Path

import pytest
from fastapi import HTTPException
from test_mvp import login, mkproject

from api.core.limits import (
    MAX_ATTACHMENT_SIZE,
    UNIT_MB,
    attachment_size_label,
    attachment_size_message,
    read_within_limit,
)

API_DIR = Path(__file__).resolve().parents[1] / "api"


# ============ 1. 常量单一来源 / 文案不漂移 ============

def test_limit_is_100mb_and_single_source():
    """上限 = 100MB，且三个 router 引用的是同一个对象（不是各自抄一份）。"""
    assert MAX_ATTACHMENT_SIZE == 100 * UNIT_MB
    assert UNIT_MB == 1024 * 1024

    from api.routers import contacts, expenses, projects

    assert projects.MAX_SIZE is MAX_ATTACHMENT_SIZE
    assert contacts.MAX_SIZE is MAX_ATTACHMENT_SIZE
    assert expenses.VOUCHER_MAX_SIZE is MAX_ATTACHMENT_SIZE


def test_message_derives_from_constant():
    """文案数字由常量拼出：改常量文案跟着改，不可能写死旧数字。"""
    assert attachment_size_label() == "100MB"
    assert attachment_size_message() == "单文件最大 100MB"

    # 换一个上限，文案必须跟着变（证明不是硬编码的 100MB）
    assert attachment_size_label(20 * UNIT_MB) == "20MB"
    assert attachment_size_message(20 * UNIT_MB) == "单文件最大 20MB"


# ============ 2. 有界读取 ============

class _CountingStream:
    """记录 read() 入参，验证「只读 limit+1 字节」而不是 read() 全量。"""

    def __init__(self, size: int):
        self.size = size
        self.reads: list[int] = []

    def read(self, n: int = -1) -> bytes:
        self.reads.append(n)
        return b"\0" * min(n, self.size)


class _FakeUpload:
    def __init__(self, size: int):
        self.file = _CountingStream(size)


def test_read_within_limit_reads_only_limit_plus_one():
    at_limit = _FakeUpload(MAX_ATTACHMENT_SIZE)
    assert len(read_within_limit(at_limit)) == MAX_ATTACHMENT_SIZE
    assert at_limit.file.reads == [MAX_ATTACHMENT_SIZE + 1]

    way_over = _FakeUpload(500 * UNIT_MB)
    with pytest.raises(HTTPException) as exc:
        read_within_limit(way_over)
    assert exc.value.status_code == 400
    assert "100MB" in exc.value.detail
    # 只读了 limit+1，绝不会把 500MB 整体读进内存
    assert way_over.file.reads == [MAX_ATTACHMENT_SIZE + 1]


def test_routers_have_no_unbounded_read():
    """三个入口都不再有 `file.file.read()`（无界读）——统一走 read_within_limit。"""
    offenders = []
    for path in sorted((API_DIR / "routers").glob("*.py")):
        for lineno, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
            if re.search(r"\.file\.read\(\s*\)", line):
                offenders.append(f"{path.name}:{lineno}")
    assert offenders == [], f"存在无界读取：{offenders}"


# ============ 3. 边界值：三个入口真实 HTTP ============

def _blob(size: int) -> bytes:
    return b"\0" * size


def test_project_attachment_at_and_over_limit(client):
    h = login(client, "pm")
    p = mkproject(client, h, "P100Proj")

    ok = client.post(f"/api/v1/projects/{p['id']}/attachments", headers=h,
                     files={"file": ("at.pdf", _blob(MAX_ATTACHMENT_SIZE), "application/pdf")})
    assert ok.status_code == 200, ok.text
    assert ok.json()["size"] == MAX_ATTACHMENT_SIZE

    over = client.post(f"/api/v1/projects/{p['id']}/attachments", headers=h,
                       files={"file": ("over.pdf", _blob(MAX_ATTACHMENT_SIZE + 1),
                                       "application/pdf")})
    assert over.status_code == 400, over.text
    assert "100MB" in over.json()["detail"]
    # 超限不落库、不上传目录
    assert len(client.get(f"/api/v1/projects/{p['id']}/attachments", headers=h).json()) == 1

    assert client.delete(
        f"/api/v1/projects/{p['id']}/attachments/{ok.json()['id']}", headers=h
    ).status_code == 200


def test_contact_attachment_at_and_over_limit(client):
    h = login(client, "admin")
    created = client.post("/api/v1/contacts", headers=h, json={"name": "上限测试人员"})
    assert created.status_code == 200, created.text
    cid = created.json()["id"]

    ok = client.post(f"/api/v1/contacts/{cid}/attachments", headers=h,
                     data={"category": "labor_contract"},
                     files={"file": ("at.pdf", _blob(MAX_ATTACHMENT_SIZE), "application/pdf")})
    assert ok.status_code == 200, ok.text
    assert ok.json()["size"] == MAX_ATTACHMENT_SIZE

    over = client.post(f"/api/v1/contacts/{cid}/attachments", headers=h,
                       data={"category": "labor_contract"},
                       files={"file": ("over.pdf", _blob(MAX_ATTACHMENT_SIZE + 1),
                                       "application/pdf")})
    assert over.status_code == 400, over.text
    assert "100MB" in over.json()["detail"]
    assert len(client.get(f"/api/v1/contacts/{cid}/attachments", headers=h).json()) == 1

    assert client.delete(
        f"/api/v1/contacts/{cid}/attachments/{ok.json()['id']}", headers=h
    ).status_code == 200


def test_expense_voucher_at_and_over_limit(client):
    h = login(client, "pm")
    p = mkproject(client, h, "P100Exp")
    e = client.post("/api/v1/expenses",
                    json={"project_id": p["id"], "subject": "采购", "amount": 100},
                    headers=h).json()

    ok = client.post(f"/api/v1/expenses/{e['id']}/vouchers", headers=h,
                     files={"file": ("at.png", _blob(MAX_ATTACHMENT_SIZE), "image/png")})
    assert ok.status_code == 200, ok.text
    assert ok.json()["size"] == MAX_ATTACHMENT_SIZE

    over = client.post(f"/api/v1/expenses/{e['id']}/vouchers", headers=h,
                       files={"file": ("over.png", _blob(MAX_ATTACHMENT_SIZE + 1), "image/png")})
    assert over.status_code == 400, over.text
    assert "100MB" in over.json()["detail"]
    assert len(client.get(f"/api/v1/expenses/{e['id']}/vouchers", headers=h).json()) == 1

    assert client.delete(
        f"/api/v1/expenses/{e['id']}/vouchers/{ok.json()['id']}", headers=h
    ).status_code == 200


# ============ 4. 验收：api/ 下无 20MB 残留 ============

def test_no_20mb_residue_under_api():
    pattern = re.compile(r"20 \* 1024 \* 1024|20MB")
    offenders = []
    for path in sorted(API_DIR.rglob("*.py")):
        for lineno, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
            if pattern.search(line):
                offenders.append(f"api/{path.relative_to(API_DIR)}:{lineno}")
    assert offenders == [], f"仍有 20MB 残留：{offenders}"


def test_small_upload_still_works(client):
    """小文件回归：上限放宽不能把正常上传路径弄坏。"""
    h = login(client, "pm")
    p = mkproject(client, h, "P100Small")
    r = client.post(f"/api/v1/projects/{p['id']}/attachments", headers=h,
                    files={"file": ("small.pdf", io.BytesIO(b"tiny"), "application/pdf")})
    assert r.status_code == 200, r.text
    assert r.json()["size"] == 4
