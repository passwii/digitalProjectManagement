"""BLF-1136：Cloudflare R2 存储接入的后端回归。

覆盖四层，全部不依赖真实网络（用内存版 S3 客户端替身）：

  1. **传输层 `core.r2`** —— key 清洗、URL 编码（中文）、ETag、删除的结构化结果、
     404 与「R2 不可用」的区分、客户端按配置指纹缓存；
  2. **抽象层 `core.storage`** —— `STORAGE_BACKEND=auto/local/r2` 的选择与回落、
     `r2` 强制但配置不全时启动即报错、对象键命名规范、本地后端读写删往返、秘密不外泄；
  3. **三个上传入口的端到端** —— 项目/合同附件、人员档案附件、支出凭证在 R2 后端下
     `storage_backend/object_key/etag` 正确落库，下载字节一致，删除同时清对象；
  4. **兼容与失败路径** —— 接入 R2 前的存量本地行仍可下载；R2 上传失败 → 502 且不产生元数据；
     R2 删除失败 → 502 且**保留**元数据（不留无人追踪的孤儿对象）；体积上限与归属隔离不变。

测试通过替换 `api.core.r2.build_client` 注入内存客户端，`R2_*` 环境变量在用例内设置，
因此「本地跑测试」不需要 R2 凭据，也不会碰到真实桶。
"""

from __future__ import annotations

import io
from pathlib import Path

import pytest
from botocore.exceptions import ClientError
from sqlalchemy.orm import Session
from test_mvp import login, mkproject

from api.core import r2 as r2_mod
from api.core import storage as storage_mod
from api.core.attachments import (
    attachment_blob_available,
    attachment_response,
    remove_attachment_blob,
    store_attachment,
)
from api.core.limits import MAX_ATTACHMENT_SIZE
from api.core.r2 import (
    R2DeleteResult,
    R2ObjectMissing,
    R2Settings,
    R2Unavailable,
    public_url,
    sanitize_key,
    try_delete_object,
)
from api.models import Attachment, User

ENDPOINT = "https://account123.r2.cloudflarestorage.com"
BUCKET = "ziktech"
# 占位凭据（非真实密钥）：只为拼出完整的 R2 配置，测试不会发起真实网络请求
FAKE_KEY_ID = "placeholder-key-id"
FAKE_SECRET = "placeholder" + "-secret-value"  # 占位值，非真实凭据

R2_ENV = {
    "R2_ENDPOINT_URL": ENDPOINT,
    "R2_ACCESS_KEY_ID": FAKE_KEY_ID,
    "R2_SECRET_ACCESS_KEY": FAKE_SECRET,
    "R2_BUCKET_NAME": BUCKET,
    "R2_REGION": "auto",
    "R2_PUBLIC_URL": "",
}


# ============ 内存版 S3 替身 ============


class _FakeS3:
    """最小 S3 兼容实现：够 put/get/head/delete/预签名，且能模拟各类故障。"""

    def __init__(self):
        self.objects: dict[str, dict] = {}
        self.put_calls: list[dict] = []
        self.delete_calls: list[str] = []
        self.fail_put = False
        self.fail_delete = False
        self.fail_get = False

    # --- 内部 ---
    @staticmethod
    def _missing(key: str) -> ClientError:
        return ClientError(
            {
                "Error": {"Code": "NoSuchKey", "Message": "not found"},
                "ResponseMetadata": {"HTTPStatusCode": 404},
            },
            "GetObject",
        )

    @staticmethod
    def _boom() -> ClientError:
        return ClientError(
            {
                "Error": {"Code": "InternalError"},
                "ResponseMetadata": {"HTTPStatusCode": 500},
            },
            "Op",
        )

    # --- S3 接口 ---
    def put_object(self, Bucket, Key, Body, ContentType=None):
        if self.fail_put:
            raise self._boom()
        payload = Body if isinstance(Body, bytes) else bytes(Body)
        self.objects[Key] = {"body": payload, "content_type": ContentType}
        self.put_calls.append(
            {"key": Key, "size": len(payload), "content_type": ContentType}
        )
        return {"ETag": '"' + str(abs(hash(payload))) + '"'}

    def get_object(self, Bucket, Key):
        if Key not in self.objects:
            raise self._missing(Key)
        if self.fail_get:
            raise self._boom()
        record = self.objects[Key]
        return {
            "Body": io.BytesIO(record["body"]),
            "ContentLength": len(record["body"]),
            "ETag": '"' + str(abs(hash(record["body"]))) + '"',
        }

    def head_object(self, Bucket, Key):
        if Key not in self.objects:
            raise self._missing(Key)
        return {"ContentLength": len(self.objects[Key]["body"])}

    def delete_object(self, Bucket, Key):
        if self.fail_delete:
            raise self._boom()
        self.objects.pop(Key, None)
        self.delete_calls.append(Key)
        return {}

    def generate_presigned_url(self, op, Params, ExpiresIn):
        return f"{ENDPOINT}/{Params['Bucket']}/{Params['Key']}?sig=stub&exp={ExpiresIn}"


@pytest.fixture()
def fake_s3(monkeypatch):
    """把 R2 客户端替成内存实现，并把环境切到 R2 后端。"""
    client = _FakeS3()
    for key, value in R2_ENV.items():
        monkeypatch.setenv(key, value)
    monkeypatch.setenv("STORAGE_BACKEND", "r2")
    r2_mod.close_clients()
    monkeypatch.setattr(r2_mod, "build_client", lambda settings: client)
    yield client
    r2_mod.close_clients()


@pytest.fixture()
def local_storage(monkeypatch):
    """强制本地后端（不设 R2_* 环境变量）。"""
    for key in R2_ENV:
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("STORAGE_BACKEND", "local")
    r2_mod.close_clients()
    yield
    r2_mod.close_clients()


def _row_of(session: Session, aid):
    """按主键取出附件行（顺带断言存在，避免 `.first()` 的 Optional 直接展开）。

    `aid` 不标注 `int`：legacy `Column(...)` 风格下主键列值静态类型是 `Column[int]`。
    """
    row = session.query(Attachment).filter_by(id=aid).first()
    assert row is not None, f"附件 id={aid} 不存在"
    return row


def _col(row, name: str):
    """取出 ORM 行上的列值（legacy `Column(...)` 风格下列值静态类型是 `Column[T]`）。

    与 `scripts/migrate_attachments_to_r2.py::_text` 同一目的：断言写 `_col(row, "size")`
    而不是直接比较列属性，避免列值与 `bool()` 语义混淆。
    """
    return getattr(row, name)


def _settings() -> R2Settings:
    return R2Settings(
        endpoint_url=ENDPOINT,
        access_key_id=FAKE_KEY_ID,
        secret_access_key=FAKE_SECRET,
        bucket=BUCKET,
    )


@pytest.fixture()
def session(db):
    """`conftest.db` 给的是 sessionmaker；本文件直接操作 ORM，需要真实 Session。

    与已有测试（如 `test_stage4a_closure`）的 `s = db()` 用法一致，但**必须收尾**：
    未结束的事务会持有表锁，使 `db` fixture 收尾的 `DROP SCHEMA ... CASCADE` 永久阻塞。
    """
    s = db()
    try:
        yield s
    finally:
        s.rollback()
        s.close()


# ============ 1. 传输层 core.r2 ============


def test_public_url_encodes_chinese_key_but_keeps_slashes(fake_s3):
    """中文进 key 时 URL 会百分号编码，且不破坏路径分隔（保留 `/`）。"""
    url = storage_mod.get_backend().url_for("tenant/default/项目/发票 扫描件.pdf", "")
    suffix = url.split(f"{ENDPOINT}/{BUCKET}/")[1]
    assert suffix.startswith("tenant/default/")  # 路径分隔符保留
    assert suffix.endswith(".pdf")
    assert "%" in suffix  # 中文/空格被百分号编码
    assert "项目" not in suffix and "发票" not in suffix  # 原文不出现在 URL 里


def test_sanitize_key_keeps_unicode_strips_control_chars():
    assert sanitize_key("tenant/项目/合同 文件.pdf") == "tenant/项目/合同 文件.pdf"
    assert sanitize_key("a\x00b\x1fc\x7fd") == "abcd"
    # 多余空白归一为单个空格，首尾去空白
    assert sanitize_key("  a \n\t b  ") == "a b"
    assert sanitize_key("") == ""


def test_public_url_prefers_custom_domain_and_encodes_chinese():
    with_custom = R2Settings(
        endpoint_url=ENDPOINT,
        access_key_id=FAKE_KEY_ID,
        secret_access_key=FAKE_SECRET,
        bucket=BUCKET,
        public_url="https://cdn.example.com",
    )
    assert public_url(
        with_custom, "tenant/default/project/2026/09/发票.pdf"
    ).startswith("https://cdn.example.com/tenant/default/project/2026/09/")
    # 中文被百分号编码，但路径分隔符保留
    encoded = public_url(with_custom, "a/发票.pdf").split("https://cdn.example.com/")[1]
    assert encoded.startswith("a/") and "%" in encoded and "/" not in encoded[2:]

    # 没配自定义域名 → 回落 endpoint/bucket
    fallback = public_url(_settings(), "a/b.pdf")
    assert fallback == f"{ENDPOINT}/{BUCKET}/a/b.pdf"


def test_try_delete_object_is_vacuous_for_blank_key_and_never_raises(fake_s3):
    assert try_delete_object(_settings(), "") == R2DeleteResult(success=True, key="")
    assert fake_s3.delete_calls == []

    fake_s3.objects["k"] = {"body": b"x", "content_type": None}
    assert try_delete_object(_settings(), "k").success is True
    assert fake_s3.delete_calls == ["k"]

    # 失败路径：结构化返回错误信息，不抛异常
    fake_s3.fail_delete = True
    result = try_delete_object(_settings(), "k")
    assert result.success is False
    assert result.error_class == "ClientError"
    assert result.error_message


def test_object_stream_distinguishes_missing_from_unavailable(fake_s3):
    fake_s3.objects["gone"] = {"body": b"", "content_type": None}
    del fake_s3.objects["gone"]
    with pytest.raises(R2ObjectMissing):
        r2_mod.object_stream(_settings(), "gone")

    fake_s3.objects["here"] = {"body": b"hello", "content_type": None}
    chunks, length, _etag = r2_mod.object_stream(_settings(), "here")
    assert b"".join(chunks) == b"hello"
    assert length == 5

    # 5xx 属于「不可用」而非「不存在」：调用方据此返回 502 而不是 404
    fake_s3.fail_get = True
    with pytest.raises(R2Unavailable):
        r2_mod.object_stream(_settings(), "here")


def test_object_exists_returns_false_only_for_missing(fake_s3):
    assert r2_mod.object_exists(_settings(), "nope") is False
    fake_s3.objects["yes"] = {"body": b"1", "content_type": None}
    assert r2_mod.object_exists(_settings(), "yes") is True


def test_upload_object_returns_etag_and_falls_back_on_missing_etag(fake_s3):
    out = r2_mod.upload_object(_settings(), b"payload", "k.pdf", "application/pdf")
    assert out["key"] == "k.pdf" and out["bucket"] == BUCKET and out["size"] == 7
    assert out["etag"]

    class _NoEtag(_FakeS3):
        def put_object(self, Bucket, Key, Body, ContentType=None):
            return {}

    r2_mod._CLIENTS.clear()
    r2_mod.build_client = lambda settings: _NoEtag()  # type: ignore[assignment]
    out2 = r2_mod.upload_object(_settings(), b"payload", "k2.pdf", "application/pdf")
    # 兼容实现不回 ETag 时用内容摘要兜底，保证元数据里总有可核对指纹
    assert len(out2["etag"]) == 64


def test_client_is_cached_per_config_fingerprint(monkeypatch):
    created: list[R2Settings] = []

    def _factory(settings):
        created.append(settings)
        return _FakeS3()

    monkeypatch.setattr(r2_mod, "build_client", _factory)
    r2_mod.close_clients()

    a = _settings()
    r2_mod.get_r2_client(a)
    r2_mod.get_r2_client(a)
    assert len(created) == 1, "同一配置只应构造一次客户端"

    # 凭据变化 → 重建（不能继续用旧凭据）
    r2_mod.get_r2_client(
        R2Settings(
            endpoint_url=ENDPOINT,
            access_key_id="rotated-key-id",
            secret_access_key=FAKE_SECRET,
            bucket=BUCKET,
        )
    )
    assert len(created) == 2
    r2_mod.close_clients()


# ============ 2. 抽象层 core.storage ============


def test_backend_auto_falls_back_to_local_without_r2_config(monkeypatch):
    for key in R2_ENV:
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("STORAGE_BACKEND", "auto")
    assert storage_mod.resolve_backend_name() == "local"
    assert storage_mod.get_backend().name == "local"
    assert storage_mod.storage_enabled() is False


def test_backend_auto_uses_r2_when_config_complete(monkeypatch):
    for key, value in R2_ENV.items():
        monkeypatch.setenv(key, value)
    monkeypatch.setenv("STORAGE_BACKEND", "auto")
    assert storage_mod.resolve_backend_name() == "r2"
    assert storage_mod.storage_enabled() is True


def test_forced_r2_without_config_fails_loudly(monkeypatch):
    for key in R2_ENV:
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("STORAGE_BACKEND", "r2")
    # 不允许「以为在用 R2、其实写到容器磁盘」
    with pytest.raises(RuntimeError, match="R2 配置不完整"):
        storage_mod.resolve_backend_name()


def test_storage_profile_never_exposes_secrets(monkeypatch):
    for key, value in R2_ENV.items():
        monkeypatch.setenv(key, value)
    monkeypatch.setenv("STORAGE_BACKEND", "r2")
    profile = storage_mod.storage_profile()
    d = profile["backend"]
    assert d == "r2" and profile["bucket"] == BUCKET
    dumped = repr(profile)
    assert FAKE_SECRET not in dumped and FAKE_KEY_ID not in dumped


def test_build_object_key_shape_and_sanitization():
    key = storage_mod.build_object_key("project", "合同 扫描件.pdf")
    parts = key.split("/")
    assert parts[:3] == ["tenant", "default", "project"], key
    assert len(parts) == 6 and len(parts[3]) == 4 and len(parts[4]) == 2
    assert parts[5].endswith(".pdf") and len(parts[5]) == 36  # 32 hex + .pdf

    # 非法 domain 收敛为 other，绝不把调用方字符串拼进路径
    assert storage_mod.build_object_key("../etc", "x.pdf").split("/")[2] == "other"
    # 扩展名只保留字母数字，杜绝 `..` / 斜杠进入 key
    assert storage_mod.build_object_key("project", "evil../..pdf").count("/") == 5
    assert not storage_mod.build_object_key("project", "noext").endswith(".")
    # 时间戳后缀被清洗成字母数字
    tagged = storage_mod.build_object_key("expense", "a.png", suffix="20260918120000")
    assert tagged.split("/")[5].endswith("_20260918120000.png")
    # 两次调用不重复（uuid）
    assert storage_mod.build_object_key(
        "project", "a.pdf"
    ) != storage_mod.build_object_key("project", "a.pdf")


def test_local_backend_roundtrip(tmp_path):
    backend = storage_mod.LocalBackend()
    target = tmp_path / "nested" / "file.pdf"
    stored = backend.put(b"hello-local", "unused/key.pdf", target, "application/pdf")

    assert stored.backend == "local" and stored.object_key == ""
    assert stored.path == str(target) and stored.size == 11
    assert stored.etag and len(stored.etag) == 64
    assert backend.exists("", stored.path) is True

    chunks, length = backend.stream("", stored.path)
    assert b"".join(chunks) == b"hello-local" and length == 11

    with pytest.raises(R2ObjectMissing):
        backend.stream("", str(tmp_path / "absent.pdf"))

    backend.delete("", stored.path)
    assert backend.exists("", stored.path) is False


def test_r2_backend_put_stream_delete(fake_s3, tmp_path):
    backend = storage_mod.get_backend()
    assert backend.name == "r2"

    stored = backend.put(
        b"invoice-bytes",
        "tenant/default/expense/2026/09/x.png",
        tmp_path / "ignored.png",
        "image/png",
    )
    assert stored.backend == "r2" and stored.object_key.endswith(".png")
    assert stored.path == public_url(_settings(), stored.object_key)
    assert stored.size == 13

    assert backend.exists(stored.object_key, "") is True
    chunks, length = backend.stream(stored.object_key, "")
    assert b"".join(chunks) == b"invoice-bytes" and length == 13

    backend.delete(stored.object_key, "")
    assert backend.exists(stored.object_key, "") is False


def test_r2_backend_delete_failure_raises_for_strict_callers(fake_s3):
    backend = storage_mod.R2Backend(_settings())
    fake_s3.fail_delete = True
    with pytest.raises(R2Unavailable):
        backend.delete("some/key.png", "")


# ============ 3. store_attachment / 下载 / 删除 的统一层 ============


def test_store_attachment_uses_r2_and_records_coordinates(
    session: Session, fake_s3
):
    row = store_attachment(
        session,
        domain="project",
        filename="发票 扫描件.pdf",
        content_type="application/pdf",
        data=b"payload-bytes",
        project_id=None,
        uploaded_by=None,
    )
    key = str(_col(row, "object_key"))
    assert str(_col(row, "storage_backend")) == "r2"
    assert key.startswith("tenant/default/project/")
    # 对象键是不含中文的 uuid 命名（不可猜测且可审计）；公开 URL 由 endpoint/bucket + key 拼成
    assert str(_col(row, "path")) == f"{ENDPOINT}/{BUCKET}/{key}"
    assert str(_col(row, "filename")) == "发票 扫描件.pdf"
    assert _col(row, "size") == 13
    assert str(_col(row, "etag")) != ""
    assert fake_s3.objects[key]["body"] == b"payload-bytes"


def test_attachment_response_streams_r2_bytes_with_utf8_filename(client, fake_s3):
    """R2 后端下载走 HTTP 流式响应：字节一致、文件名 UTF-8、Content-Length 正确。

    （直接断言 `attachment_response()` 的 `body_iterator` 不可行：starlette 会把同步生成器
    包成异步迭代器。这里走真实 HTTP 入口，顺带覆盖 router 与下载响应体的接合。）
    """
    h = login(client, "pm")
    p = mkproject(client, h, "PR2Stream")
    up = client.post(
        f"/api/v1/projects/{p['id']}/attachments",
        headers=h,
        files={"file": ("发票.png", b"img", "image/png")},
    )
    assert up.status_code == 200, up.text
    aid = up.json()["id"]

    dl = client.get(f"/api/v1/projects/{p['id']}/attachments/{aid}/download", headers=h)
    assert dl.status_code == 200
    assert dl.content == b"img"
    assert dl.headers["content-length"] == "3"
    assert "filename*=UTF-8" in dl.headers["content-disposition"]
    assert dl.headers["content-type"] == "image/png"


def test_attachment_response_missing_object_is_404_but_unavailable_is_502(
    session: Session, fake_s3
):
    from fastapi import HTTPException

    row = store_attachment(
        session,
        domain="project",
        filename="a.pdf",
        content_type="application/pdf",
        data=b"x",
        project_id=None,
    )
    fake_s3.objects.pop(str(_col(row, "object_key")))
    with pytest.raises(HTTPException) as missing:
        attachment_response(row)
    assert missing.value.status_code == 404

    row2 = store_attachment(
        session,
        domain="project",
        filename="b.pdf",
        content_type="application/pdf",
        data=b"y",
        project_id=None,
    )
    fake_s3.fail_get = True
    with pytest.raises(HTTPException) as unavailable:
        attachment_response(row2)
    # R2 挂掉 ≠ 文件丢失：502 让客户端重试，而不是误报「文件已丢失」
    assert unavailable.value.status_code == 502
    assert attachment_blob_available(row2) in (False, True)  # HEAD 也可能失败，不应抛错


def test_remove_attachment_blob_deletes_object_and_is_strict_on_failure(
    session: Session, fake_s3
):
    row = store_attachment(
        session,
        domain="project",
        filename="c.pdf",
        content_type="application/pdf",
        data=b"z",
        project_id=None,
    )
    assert remove_attachment_blob(row) is True
    assert str(_col(row, "object_key")) not in fake_s3.objects

    row2 = store_attachment(
        session,
        domain="project",
        filename="d.pdf",
        content_type="application/pdf",
        data=b"w",
        project_id=None,
    )
    fake_s3.fail_delete = True
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as exc:
        remove_attachment_blob(row2)
    assert exc.value.status_code == 502
    assert _col(row2, "object_key") in fake_s3.objects
    assert remove_attachment_blob(row2, strict=False) is False


# ============ 4. 三个上传入口端到端（R2 后端） ============


def test_project_attachment_full_flow_on_r2(client, fake_s3):
    h = login(client, "pm")
    p = mkproject(client, h, "PR2Flow")

    up = client.post(
        f"/api/v1/projects/{p['id']}/attachments",
        headers=h,
        files={"file": ("方案 第一版.pdf", b"pdf-body", "application/pdf")},
    )
    assert up.status_code == 200, up.text
    aid = up.json()["id"]
    assert up.json()["size"] == 8

    # R2 上确实有对象，且键遵循 tenant/default/... 规范
    keys = list(fake_s3.objects)
    assert len(keys) == 1 and keys[0].startswith("tenant/default/project/")

    dl = client.get(f"/api/v1/projects/{p['id']}/attachments/{aid}/download", headers=h)
    assert dl.status_code == 200 and dl.content == b"pdf-body"
    assert "filename*=UTF-8" in dl.headers["content-disposition"]

    assert (
        client.delete(
            f"/api/v1/projects/{p['id']}/attachments/{aid}", headers=h
        ).status_code
        == 200
    )
    assert fake_s3.objects == {}
    assert client.get(f"/api/v1/projects/{p['id']}/attachments", headers=h).json() == []


def test_contract_attachment_gets_contract_domain(client, fake_s3):
    h = login(client, "pm")
    p = mkproject(client, h, "PR2Contract")
    assert (
        client.post(
            f"/api/v1/projects/{p['id']}/attachments",
            headers=h,
            data={"ref_type": "contract"},
            files={"file": ("合同.pdf", b"c", "application/pdf")},
        ).status_code
        == 200
    )
    assert next(iter(fake_s3.objects)).startswith("tenant/default/contract/")


def test_contact_attachment_full_flow_on_r2(client, fake_s3):
    h = login(client, "admin")
    cid = client.post(
        "/api/v1/contacts", headers=h, json={"name": "R2 证件人员"}
    ).json()["id"]

    up = client.post(
        f"/api/v1/contacts/{cid}/attachments",
        headers=h,
        data={"category": "id_card"},
        files={"file": ("身份证正面.png", b"id-card", "image/png")},
    )
    assert up.status_code == 200, up.text
    assert up.json()["category"] == "id_card"
    assert up.json()["filename"] == "身份证正面.png"
    assert next(iter(fake_s3.objects)).startswith("tenant/default/contact/")

    aid = up.json()["id"]
    dl = client.get(f"/api/v1/contacts/{cid}/attachments/{aid}/download", headers=h)
    assert dl.status_code == 200 and dl.content == b"id-card"
    assert (
        client.delete(
            f"/api/v1/contacts/{cid}/attachments/{aid}", headers=h
        ).status_code
        == 200
    )
    assert fake_s3.objects == {}


def test_expense_voucher_full_flow_on_r2(client, fake_s3):
    h = login(client, "pm")
    p = mkproject(client, h, "PR2Voucher")
    eid = client.post(
        "/api/v1/expenses",
        json={"project_id": p["id"], "subject": "采购", "amount": 100},
        headers=h,
    ).json()["id"]

    up = client.post(
        f"/api/v1/expenses/{eid}/vouchers",
        headers=h,
        files={"file": ("发票.png", b"invoice", "image/png")},
    )
    assert up.status_code == 200, up.text
    assert next(iter(fake_s3.objects)).startswith("tenant/default/expense/")

    aid = up.json()["id"]
    dl = client.get(f"/api/v1/expenses/{eid}/vouchers/{aid}/download", headers=h)
    assert dl.status_code == 200 and dl.content == b"invoice"

    # 归属隔离仍然成立：项目附件入口不得取到凭证，反之亦然
    assert (
        client.get(
            f"/api/v1/projects/{p['id']}/attachments/{aid}/download", headers=h
        ).status_code
        == 404
    )
    assert (
        client.delete(
            f"/api/v1/projects/{p['id']}/attachments/{aid}", headers=h
        ).status_code
        == 404
    )

    assert (
        client.delete(f"/api/v1/expenses/{eid}/vouchers/{aid}", headers=h).status_code
        == 200
    )
    assert fake_s3.objects == {}


def test_upload_to_r2_failure_returns_502_without_metadata(
    client, session: Session, fake_s3
):
    h = login(client, "pm")
    p = mkproject(client, h, "PR2Fail")
    fake_s3.fail_put = True

    r = client.post(
        f"/api/v1/projects/{p['id']}/attachments",
        headers=h,
        files={"file": ("x.pdf", b"body", "application/pdf")},
    )
    assert r.status_code == 502, r.text
    # 上传失败不得留下元数据，客户端可安全重试
    assert session.query(Attachment).filter_by(project_id=p["id"]).count() == 0
    # 也没有「已上传但无记录」的对象
    assert fake_s3.objects == {}


def test_delete_when_r2_delete_fails_keeps_metadata(
    client, session: Session, fake_s3
):
    h = login(client, "pm")
    p = mkproject(client, h, "PR2DelFail")
    aid = client.post(
        f"/api/v1/projects/{p['id']}/attachments",
        headers=h,
        files={"file": ("keep.pdf", b"body", "application/pdf")},
    ).json()["id"]

    fake_s3.fail_delete = True
    r = client.delete(f"/api/v1/projects/{p['id']}/attachments/{aid}", headers=h)
    assert r.status_code == 502, r.text
    # 元数据保留：对象仍可被追踪、可重试删除，不会变成孤儿
    assert session.query(Attachment).filter_by(id=aid).count() == 1
    assert client.get(f"/api/v1/projects/{p['id']}/attachments", headers=h).json() != []


def test_size_limit_still_enforced_on_r2(client, fake_s3):
    h = login(client, "pm")
    p = mkproject(client, h, "PR2Limit")
    over = client.post(
        f"/api/v1/projects/{p['id']}/attachments",
        headers=h,
        files={
            "file": ("big.pdf", b"\0" * (MAX_ATTACHMENT_SIZE + 1), "application/pdf")
        },
    )
    assert over.status_code == 400 and "100MB" in over.json()["detail"]
    # 超限在读取阶段就被拦下，不会上传到 R2
    assert fake_s3.put_calls == []


# ============ 5. 兼容存量本地行 / 本地后端回归 ============


def test_legacy_local_rows_still_download(
    client, session: Session, fake_s3, tmp_path
):
    """接入 R2 之前写入的行（storage_backend 空/object_key 空）继续按磁盘路径读。"""
    h = login(client, "pm")
    p = mkproject(client, h, "PR2Legacy")
    # 存量行要挂在真实用户名下：删除入口要求「上传者本人或管理员」
    uploader = session.query(User).filter_by(username="pm").first()
    assert uploader is not None
    uploader_id = _col(uploader, "id")
    path = tmp_path / "legacy.pdf"
    path.write_bytes(b"legacy-bytes")
    legacy = Attachment(
        project_id=p["id"],
        filename="legacy.pdf",
        path=str(path),
        size=12,
        content_type="application/pdf",
        ref_type="",
        ref_id=None,
        uploaded_by=uploader_id,
    )
    session.add(legacy)
    session.flush()
    legacy_id = _col(legacy, "id")
    # 模拟迁移后的存量行：server_default 已把 storage_backend 置为 local、object_key 为空。
    # 形状与真实老数据一致，同时验证 `_row_coords` 对空 object_key 的退化处理。
    legacy.storage_backend = "local"  # type: ignore[assignment]
    session.commit()

    dl = client.get(
        f"/api/v1/projects/{p['id']}/attachments/{legacy_id}/download", headers=h
    )
    assert dl.status_code == 200 and dl.content == b"legacy-bytes"

    row = _row_of(session, legacy_id)
    assert attachment_blob_available(row) is True
    # 本地行不会被误删到 R2 上
    assert fake_s3.delete_calls == []
    assert (
        client.delete(
            f"/api/v1/projects/{p['id']}/attachments/{legacy_id}", headers=h
        ).status_code
        == 200
    )
    assert not path.exists()


def test_local_backend_still_works_end_to_end(
    client, local_storage, session: Session
):
    from api.core.database import ROOT

    h = login(client, "pm")
    p = mkproject(client, h, "PLocalBack")
    up = client.post(
        f"/api/v1/projects/{p['id']}/attachments",
        headers=h,
        files={"file": ("local.pdf", b"on-disk", "application/pdf")},
    )
    assert up.status_code == 200, up.text
    aid = up.json()["id"]

    row = _row_of(session, aid)
    path = str(_col(row, "path"))
    assert str(_col(row, "storage_backend")) in ("local", "")
    assert str(_col(row, "object_key")) == ""
    assert path.startswith(str(ROOT / "data" / "files"))

    assert Path(path).read_bytes() == b"on-disk"

    dl = client.get(f"/api/v1/projects/{p['id']}/attachments/{aid}/download", headers=h)
    assert dl.status_code == 200 and dl.content == b"on-disk"

    assert (
        client.delete(
            f"/api/v1/projects/{p['id']}/attachments/{aid}", headers=h
        ).status_code
        == 200
    )
    assert not Path(path).exists()


def test_list_endpoints_do_not_leak_storage_details_or_secrets(client, fake_s3):
    h = login(client, "pm")
    p = mkproject(client, h, "PR2Leak")
    client.post(
        f"/api/v1/projects/{p['id']}/attachments",
        headers=h,
        files={"file": ("a.pdf", b"x", "application/pdf")},
    )
    listed = client.get(f"/api/v1/projects/{p['id']}/attachments", headers=h)
    assert listed.status_code == 200
    body = listed.text
    # 列表响应不应暴露对象键、内网 endpoint 或任何密钥
    assert "object_key" not in body
    assert "tenant/default" not in body
    assert ENDPOINT not in body
    assert FAKE_SECRET not in body


# ============ 6. 「曾有 R2 行 → 切 local」的回滚/降级路径 ============


def _switch_to_local(monkeypatch) -> None:
    """把全局开关切回 `local`（模拟运维按文档做「回滚」），R2 凭据仍在。"""
    monkeypatch.setenv("STORAGE_BACKEND", "local")
    r2_mod.close_clients()


def test_r2_rows_still_readable_and_deletable_after_switch_to_local(
    client, session: Session, fake_s3, monkeypatch
):
    """核心回归：全局切到 `local` 后，已上 R2 的行必须**照旧走 R2** 读/删。

    这是回滚/降级最容易踩的坑：正文寻址按行、后端实例却按全局环境变量取，两者
    不一致时会静默传导成「下载 404 假装丢文件」+「删除 200 但对象没删」的孤儿对象。
    """
    h = login(client, "pm")
    p = mkproject(client, h, "PR2Rollback")
    aid = client.post(
        f"/api/v1/projects/{p['id']}/attachments",
        headers=h,
        files={"file": ("rollback.pdf", b"r2-body", "application/pdf")},
    ).json()["id"]
    row = _row_of(session, aid)
    key = str(_col(row, "object_key"))
    assert str(_col(row, "storage_backend")) == "r2" and key in fake_s3.objects

    _switch_to_local(monkeypatch)

    # 1) 下载照旧成功，字节一致 —— 不是 404「附件文件已丢失」
    dl = client.get(f"/api/v1/projects/{p['id']}/attachments/{aid}/download", headers=h)
    assert dl.status_code == 200, dl.text
    assert dl.content == b"r2-body"

    # 2) 删除返回 200，且 R2 对象**真的被删掉**（否则就是无人追踪的孤儿对象）
    assert (
        client.delete(
            f"/api/v1/projects/{p['id']}/attachments/{aid}", headers=h
        ).status_code
        == 200
    )
    assert fake_s3.delete_calls == [key]
    assert fake_s3.objects == {}
    assert session.query(Attachment).filter_by(id=aid).count() == 0

    # 3) 新上传落本地盘（全局开关仍然生效）——「读旧的、写新的」
    up = client.post(
        f"/api/v1/projects/{p['id']}/attachments",
        headers=h,
        files={"file": ("new.pdf", b"local-body", "application/pdf")},
    )
    assert up.status_code == 200
    new_row = _row_of(session, up.json()["id"])
    assert (str(_col(new_row, "storage_backend")) or "local") == "local"
    assert str(_col(new_row, "object_key")) == ""


def test_local_write_does_not_land_in_r2_bucket(
    client, session: Session, fake_s3, monkeypatch
):
    """反向保护：切 `local` 后新写入不得再往 R2 塞对象。"""
    h = login(client, "pm")
    p = mkproject(client, h, "PR2NoWrite")
    _switch_to_local(monkeypatch)

    up = client.post(
        f"/api/v1/projects/{p['id']}/attachments",
        headers=h,
        files={"file": ("local.pdf", b"x", "application/pdf")},
    )
    assert up.status_code == 200, up.text
    assert fake_s3.put_calls == []


def test_switched_to_local_but_r2_config_gone_refuses_to_delete(
    client, session: Session, fake_s3, monkeypatch
):
    """R2 行 + 全局 local + `R2_*` 被清空：**必须报错并保留元数据**，不能假装删成功。

    否则删除返回 200、对象仍在桶里，而数据库里已经查不到这个 key —— 永久孤儿。
    """
    h = login(client, "pm")
    p = mkproject(client, h, "PR2NoCreds")
    aid = client.post(
        f"/api/v1/projects/{p['id']}/attachments",
        headers=h,
        files={"file": ("orphan.pdf", b"body", "application/pdf")},
    ).json()["id"]
    key = str(_col(_row_of(session, aid), "object_key"))

    monkeypatch.setenv("STORAGE_BACKEND", "local")
    for name in R2_ENV:
        monkeypatch.delenv(name, raising=False)
    r2_mod.close_clients()

    # 读：502（可重试的「存储不可用」），不能是 404「文件已丢失」
    dl = client.get(f"/api/v1/projects/{p['id']}/attachments/{aid}/download", headers=h)
    assert dl.status_code == 502, dl.text
    assert "已丢失" not in dl.text

    # 删：502 + 元数据保留，对象仍可被追踪重试
    rm = client.delete(f"/api/v1/projects/{p['id']}/attachments/{aid}", headers=h)
    assert rm.status_code == 502, rm.text
    assert session.query(Attachment).filter_by(id=aid).count() == 1
    assert key in fake_s3.objects


def test_row_backend_resolution_matches_row_coordinates(fake_s3):
    """`storage.resolve_backend_name_from()` 与行内坐标判定一致，且非法值明确报错。"""
    assert storage_mod.resolve_backend_name_from("", "/data/files/1/a.pdf") == "local"
    assert storage_mod.resolve_backend_name_from("local", "/data/files/1/a.pdf") == "local"
    # 空/`local` 但路径是 URL 或已有 object_key → 迁移中的行，按 R2
    assert (
        storage_mod.resolve_backend_name_from("local", f"{ENDPOINT}/{BUCKET}/k.pdf")
        == "r2"
    )
    assert (
        storage_mod.resolve_backend_name_from("", "/data/files/1/a.pdf", "tenant/x.pdf")
        == "r2"
    )
    assert storage_mod.resolve_backend_name_from("r2", f"{ENDPOINT}/{BUCKET}/k") == "r2"
    # 未知取值不静默当本地：否则会漏删对象、下载 404
    with pytest.raises(RuntimeError, match="无法识别"):
        storage_mod.resolve_backend_name_from("s3", "k.pdf")


def test_row_local_backend_needs_no_r2_credentials(local_storage, fake_s3_row_free=None):
    """本地行即使 `R2_*` 全空也照常删除磁盘文件（不因缺凭据而报错）。"""
    from api.core.database import ROOT

    path = ROOT / "data" / "files" / "unit-local-row.bin"
    path.write_bytes(b"disk-body")
    backend = storage_mod.get_backend_for_row(type("Row", (), {
        "storage_backend": "local", "path": str(path), "object_key": "",
    })())
    assert backend.name == "local"
    backend.delete("", str(path))
    assert not path.exists()


def test_blank_r2_object_key_row_is_deleted_from_disk_not_r2(fake_s3, tmp_path):
    """行标了 `r2` 却没有 object_key（异常数据）：删磁盘路径，不误发 R2 删除请求。"""
    path = tmp_path / "odd.bin"
    path.write_bytes(b"x")
    row = type("Row", (), {
        "storage_backend": "r2", "path": str(path), "object_key": "",
    })()
    assert remove_attachment_blob(row) is True
    assert fake_s3.delete_calls == []
    assert not path.exists()


# ============ 7. 启动期校验（`STORAGE_BACKEND=r2` 配置不全不再静默） ============


def test_startup_lifespan_rejects_forced_r2_without_config(monkeypatch):
    """`r2` 强制模式配置不全 → **应用启动（lifespan）即抛错**，不是首个请求才炸。"""
    from fastapi.testclient import TestClient

    from api.main import app

    for name in R2_ENV:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("STORAGE_BACKEND", "r2")
    with pytest.raises(RuntimeError, match="R2 配置不完整"), TestClient(app):
        pass


def test_startup_lifespan_accepts_auto_without_config(monkeypatch):
    """`auto` 且没配凭据时仍能启动（本地开发/CI 不该被凭据卡住）。"""
    from fastapi.testclient import TestClient

    from api.main import app

    for name in R2_ENV:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("STORAGE_BACKEND", "auto")
    with TestClient(app) as c:
        body = c.get("/health").json()
    assert body["ok"] is True and body["storage_backend"] == "local"
    assert "storage_bucket" not in body


def test_auto_fallback_logs_warning(monkeypatch, caplog):
    """`auto` 静默回落本地盘是本 PR 要防的场景之一：至少要留一条 warning。"""
    import logging

    for name in R2_ENV:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("STORAGE_BACKEND", "auto")
    with caplog.at_level(logging.WARNING, logger="api.core.storage"):
        assert storage_mod.resolve_backend_name() == "local"
    assert any("回落本地磁盘" in r.message for r in caplog.records)
    # 只报「哪些变量没配」，绝不回显值
    assert FAKE_SECRET not in caplog.text
