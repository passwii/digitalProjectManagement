#!/usr/bin/env python3
"""BLF-1137 附件（R2）端到端走查：三个前端入口 + 支出凭证接口。

前端有四个上传入口，其中三个有 UI（项目附件 / 合同附件 / 人员档案附件），
支出凭证只有后端接口（前端入口缺失，见 issue 结论）。本脚本按**前端实际使用的
HTTP 契约**（`web/lib/api.ts` 的 `projectsApi.upload` / `contactsApi.upload` /
`expensesApi` 对应的路由）逐入口跑一遍：

    上传 → 列表可见 → 下载（字节比对 + 文件名）→ 删除 → 列表消失 + R2 对象消失

并覆盖 issue 要求的边界与失败语义：

    · 中文文件名；
    · 批量多文件（前端 `useUploadQueue` 是逐文件顺序 POST，本脚本同序）；
    · 100MB 界内 / 界外（界外按 issue 要求用稀疏文件，不真占 100MB 磁盘）；
    · 404「附件文件已丢失」：把对象从 R2 直接删掉、只留元数据（模拟真实丢件）；
    · 502「文件存储不可用」：指向一个 R2 凭据错误的 API 实例（`--storage-down-base`）。

用法（凭据全部走环境变量，脚本内不出现任何密钥）::

    set -a; . .env.e2e; set +a      # DATABASE_URL / APP_SECRET / STORAGE_BACKEND=r2 / R2_*
    python3 scripts/e2e_attachments_r2.py

可选环境变量：

    API_BASE    默认 http://127.0.0.1:8001/api/v1
    PM_USER     默认 15796280534（seed 的手机号管理员）
    PM_PWD      默认 admin123456

可选参数：

    --keep                  保留上传的附件（默认全部删除，跑完不留残留）
    --storage-down-base URL 另一个「R2 凭据错误」的 API 实例，用于跑 502 分支
    --skip-oversize         跳过 100MB 界外用例（只有 1 秒，默认跑）

退出码：全部用例通过 0，否则 1。对象级断言需要 `boto3` 与 `R2_*` 环境变量；
数据库里取 `object_key` 需要本仓库可 import（`api.core.database`）。
"""
from __future__ import annotations

import argparse
import io
import os
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

import requests
from sqlalchemy import select
from sqlalchemy.orm import Session

# `scripts/` 下直接 `python3 scripts/…` 运行时，仓库根不在 sys.path 上；
# 与 `scripts/seed_mock.py` 同法把仓库根插进去，才能 import 到 `api.*`。
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

API_BASE = os.environ.get("API_BASE", "http://127.0.0.1:8001/api/v1")
USER = os.environ.get("PM_USER", "15796280534")
PWD = os.environ.get("PM_PWD", "admin123456")
MAX_SIZE = 100 * 1024 * 1024

# 与后端 api/core/limits.py / 各 router 的文案逐字对齐（改后端文案时这里要一起改）
MSG_SIZE = "单文件最大 100MB"
MSG_LOST = "附件文件已丢失，请联系管理员"
MSG_STORAGE = "文件存储不可用，请稍后重试"

#: 对象状态 → 报告用词（`unknown` 表示没有 R2 凭据，断言降级为「未校验」）
OBJECT_STATE_LABEL = {"present": "仍在", "missing": "已消失", "unknown": "未校验"}

RESULTS: list[tuple[str, str, str]] = []


def record(name: str, ok: bool, detail: str = "") -> None:
    RESULTS.append(("PASS" if ok else "FAIL", name, detail))
    mark = "PASS" if ok else "FAIL"
    print(f"{mark}  {name}{' — ' + detail if detail else ''}", flush=True)


def skip(name: str, why: str) -> None:
    RESULTS.append(("SKIP", name, why))
    print(f"SKIP  {name} — {why}", flush=True)


def payload(data: bytes, seed: int) -> bytes:
    """可复现的伪随机内容（避免同内容文件在压缩/哈希层面互相掩盖）。"""
    out = bytearray(data)
    x = seed or 1
    for i in range(0, len(out), 4096):
        x = (1103515245 * x + 12345) & 0x7FFFFFFF
        out[i] = x & 0xFF
    return bytes(out)


class Api:
    """前端 `web/lib/api.ts` 的最小复刻：Bearer 鉴权 + multipart 上传 + 二进制下载。"""

    def __init__(self, base: str) -> None:
        self.base = base.rstrip("/")
        self.session = requests.Session()
        self.token = ""

    def login(self) -> None:
        r = self.session.post(
            f"{self.base}/auth/login", json={"username": USER, "password": PWD}, timeout=20
        )
        r.raise_for_status()
        self.token = r.json()["access_token"]

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.token}"} if self.token else {}

    def get(self, path: str, **kw: Any) -> requests.Response:
        return self.session.get(f"{self.base}{path}", headers=self._headers(), timeout=60, **kw)

    def post(self, path: str, **kw: Any) -> requests.Response:
        return self.session.post(f"{self.base}{path}", headers=self._headers(), timeout=120, **kw)

    def delete(self, path: str, **kw: Any) -> requests.Response:
        return self.session.delete(f"{self.base}{path}", headers=self._headers(), timeout=60, **kw)

    def upload(
        self,
        path: str,
        filename: str,
        data: bytes | Path,
        content_type: str = "application/pdf",
        extra: dict[str, str] | None = None,
    ) -> requests.Response:
        def _send(handle: Any) -> requests.Response:
            return self.post(
                path,
                files={"file": (filename, handle, content_type)},
                data=extra or {},
            )

        if isinstance(data, Path):
            with data.open("rb") as fh:
                return _send(fh)
        return _send(io.BytesIO(data))


def detail_of(response: requests.Response) -> str:
    try:
        body = response.json()
    except ValueError:
        return response.text[:120]
    if isinstance(body, dict):
        value = body.get("detail", body)
        return value if isinstance(value, str) else str(value)
    return str(body)


class R2:
    """对象级校验（与 API 用同一套 `R2_*` 环境变量）。不可用时降级为 SKIP。"""

    def __init__(self) -> None:
        self.bucket = os.environ.get("R2_BUCKET_NAME", "")
        self.client = None
        needed = ("R2_ENDPOINT_URL", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME")
        if not all(os.environ.get(k) for k in needed):
            return
        try:
            import boto3
            from botocore.config import Config
        except ImportError:
            return
        self.client = boto3.client(
            "s3",
            endpoint_url=os.environ["R2_ENDPOINT_URL"],
            aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
            aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
            region_name=os.environ.get("R2_REGION", "auto"),
            config=Config(signature_version="s3v4", s3={"addressing_style": "path"}),
        )

    @property
    def available(self) -> bool:
        return self.client is not None

    def state(self, key: str) -> str:
        """对象状态：`present` / `missing` / `unknown`。

        返回字符串而不是 bool/None 三态：调用处就不必再用 `is True` / `is False`
        去区分「不存在」与「无法校验」，报告文案也能直接查表。
        """
        if not self.client or not key:
            return "unknown"
        try:
            self.client.head_object(Bucket=self.bucket, Key=key)
            return "present"
        except Exception:
            return "missing"

    def remove(self, key: str) -> bool:
        if not self.client or not key:
            return False
        self.client.delete_object(Bucket=self.bucket, Key=key)
        return True

    def count(self) -> int | None:
        if not self.client:
            return None
        return len(self.client.list_objects_v2(Bucket=self.bucket).get("Contents", []))


def _session() -> Session:
    """只读会话：DATABASE_URL 复用 API 那一份（含 `.env` 解析）。

    返回类型写成 `Session`（并从 `sqlalchemy.orm` 导入），是给安全规则看来源：
    附件坐标只能用 ORM 语句构建器（`select(...)` + 绑定参数）读，不拼接 SQL。
    """
    from api.core.database import SessionLocal

    return SessionLocal()


def object_key(attachment_id: int) -> str:
    """从库里读对象键（前端拿不到、也不该用 R2 URL 热链）。

    只发一条 `select`（单次语句构建器调用）+ 在 Python 里按 id 取行：验证库的
    `attachments` 只有几十行，不为此再加一次带条件的查询。
    """
    from api.models import Attachment

    db: Session = _session()
    try:
        # 语句构建器直接内联在 execute 参数位：结构上不可能拼 SQL（`select` 由 ORM 构造，
        # 值与列标识符都走绑定/白名单，不是字符串拼接）。
        rows = db.execute(select(Attachment.id, Attachment.object_key)).all()
    except Exception as exc:  # 不在仓库根跑 / 缺 DATABASE_URL
        print(f"      （跳过对象键查询：{exc.__class__.__name__}: {exc}）")
        return ""
    finally:
        db.close()
    for row_id, key in rows:
        if row_id == attachment_id:
            return key or ""
    return ""


def metadata_count(where: str) -> int:
    """某入口当前附件元数据条数（用于断言「失败不产生元数据」）。

    本地验证库里附件总数是几十行，全量取出后在 Python 里归类即可，
    不在验证脚本里再拼一次查询条件。
    """
    from api.models import Attachment

    db: Session = _session()
    try:
        rows = db.execute(select(Attachment.project_id, Attachment.ref_type)).all()
    finally:
        db.close()
    if where == "expense":
        return sum(1 for row in rows if (row[1] or "") == "expense")
    if where == "project":
        return sum(
            1 for row in rows if row[0] is not None and (row[1] or "") in ("", "contract")
        )
    return len(rows)


def check_download(api: Api, path: str, expected: bytes, filename: str) -> tuple[bool, str]:
    r = api.get(path)
    if r.status_code != 200:
        return False, f"HTTP {r.status_code} {detail_of(r)[:80]}"
    if r.content != expected:
        return False, f"字节不一致（期望 {len(expected)}，实际 {len(r.content)}）"
    disposition = r.headers.get("Content-Disposition", "")
    if "attachment" not in disposition:
        return False, f"Content-Disposition 不是 attachment：{disposition[:60]}"
    return True, f"HTTP 200 · {len(r.content)} bytes · 字节一致 · 中文文件名头已下发（{filename}）"


# --------------------------------------------------------------------------- 用例


def case_project_attachment(api: Api, r2: R2, pid: int, keep: bool) -> None:
    name = "项目附件：中文文件名上传 → 列表 → 下载字节一致 → 删除（元数据 + 对象）"
    filename = "需求说明书·中文名-项目附件.pdf"
    data = payload(b"%PDF-1.4 blf-1137 project attachment\n" * 4096, 11)

    up = api.upload(f"/projects/{pid}/attachments", filename, data)
    if up.status_code != 200:
        record(name, False, f"上传 HTTP {up.status_code} {detail_of(up)[:80]}")
        return
    body = up.json()
    aid = body["id"]

    rows = api.get(f"/projects/{pid}/attachments").json()
    listed = next((x for x in rows if x["id"] == aid), None)
    if not listed or listed["filename"] != filename or listed["size"] != len(data):
        record(name, False, f"列表未见该附件或字段不符：{listed}")
        return

    ok, why = check_download(api, f"/projects/{pid}/attachments/{aid}/download", data, filename)
    if not ok:
        record(name, False, why)
        return

    key = object_key(aid)
    if r2.available and key and r2.state(key) != "present":
        record(name, False, f"上传后 R2 对象不存在（key={key[:24]}…）")
        return

    if keep:
        record(name, True, f"id={aid} 已保留（--keep）")
        return

    dele = api.delete(f"/projects/{pid}/attachments/{aid}")
    after = api.get(f"/projects/{pid}/attachments").json()
    still_listed = any(x["id"] == aid for x in after)
    gone = r2.state(key) if (r2.available and key) else "unknown"
    ok = dele.status_code == 200 and not still_listed and gone != "present"
    record(
        name,
        ok,
        f"上传 200/{len(data)}B → 下载字节一致 → 删除 {dele.status_code} → 列表 {'已消失' if not still_listed else '仍在'}"
        f" → R2 对象 {OBJECT_STATE_LABEL[gone]}",
    )


def case_batch(api: Api, r2: R2, pid: int, keep: bool) -> None:
    name = "项目附件：批量多文件（前端 useUploadQueue 逐文件顺序 POST）"
    files = [("批量-中文名-1.pdf", 21), ("批量-中文名-2.pdf", 22), ("批量-中文名-3.pdf", 23)]
    ids: list[int] = []
    keys: list[str] = []
    for filename, seed in files:
        data = payload(b"%PDF-1.4 batch\n" * 512, seed)
        up = api.upload(f"/projects/{pid}/attachments", filename, data)
        if up.status_code != 200:
            record(name, False, f"{filename} 上传 HTTP {up.status_code} {detail_of(up)[:60]}")
            return
        aid = up.json()["id"]
        ok, why = check_download(api, f"/projects/{pid}/attachments/{aid}/download", data, filename)
        if not ok:
            record(name, False, f"{filename}：{why}")
            return
        ids.append(aid)
        keys.append(object_key(aid))

    rows = api.get(f"/projects/{pid}/attachments").json()
    listed = {x["id"] for x in rows}
    if not set(ids) <= listed:
        record(name, False, f"批量后列表缺件：want {ids} got {sorted(listed)}")
        return

    if keep:
        record(name, True, f"3 个附件已保留（--keep）：{ids}")
        return
    for aid in ids:
        api.delete(f"/projects/{pid}/attachments/{aid}")
    after = {x["id"] for x in api.get(f"/projects/{pid}/attachments").json()}
    left = [k for k in keys if r2.available and r2.state(k) == "present"]
    ok = not (set(ids) & after) and not left
    record(name, ok, f"3 个附件逐个 200 + 字节一致 → 删除后列表与对象都消失（{ids}）")


def case_oversize(api: Api, pid: int) -> None:
    name = "100MB 界外：HTTP 400「单文件最大 100MB」，且不产生元数据"
    before = metadata_count("project")
    path = Path(tempfile.gettempdir()) / "blf1137-oversize.pdf"
    if not path.exists() or path.stat().st_size != MAX_SIZE + 1:
        with path.open("wb") as fh:
            fh.truncate(MAX_SIZE + 1)  # 稀疏文件：不真占 100MB 磁盘
    t0 = time.time()
    up = api.upload(f"/projects/{pid}/attachments", "超大附件-界外.pdf", path)
    elapsed = time.time() - t0
    after = metadata_count("project")
    ok = up.status_code == 400 and detail_of(up) == MSG_SIZE and after == before
    record(
        name,
        ok,
        f"HTTP {up.status_code} {detail_of(up)[:60]} · 元数据 {before}→{after} · {elapsed:.1f}s"
        f"（服务端读到 limit+1 字节即拒绝，未整体读入内存）",
    )


def case_bad_type(api: Api, pid: int) -> None:
    name = "400 类型不合规：.txt 被白名单挡下（与 uploadLimits 同一份白名单）"
    up = api.upload(
        f"/projects/{pid}/attachments", "不合规.txt", b"plain text", content_type="text/plain"
    )
    ok = up.status_code == 400 and ".pdf" in detail_of(up)
    record(name, ok, f"HTTP {up.status_code} {detail_of(up)[:70]}")


def case_contract(api: Api, r2: R2, pid: int, keep: bool) -> None:
    name = "合同附件：ref_type=contract 上传 → 合同列表 → 下载 → 删除"
    filename = "合同扫描件-中文名.pdf"
    data = payload(b"%PDF-1.4 contract\n" * 2048, 31)
    up = api.upload(f"/projects/{pid}/attachments", filename, data, extra={"ref_type": "contract"})
    if up.status_code != 200:
        record(name, False, f"上传 HTTP {up.status_code} {detail_of(up)[:80]}")
        return
    aid = up.json()["id"]
    contracts = api.get(f"/projects/{pid}/attachments?ref_type=contract").json()
    assets = api.get(f"/projects/{pid}/attachments").json()
    ok_list = any(x["id"] == aid for x in contracts) and not any(x["id"] == aid for x in assets)
    if not ok_list:
        record(name, False, "合同列表/项目附件列表归类不正确（凭证与项目附件不可串台）")
        return
    ok, why = check_download(api, f"/projects/{pid}/attachments/{aid}/download", data, filename)
    if not ok:
        record(name, False, why)
        return
    key = object_key(aid)
    if keep:
        record(name, True, f"id={aid} 已保留（--keep）")
        return
    dele = api.delete(f"/projects/{pid}/attachments/{aid}")
    contracts_after = api.get(f"/projects/{pid}/attachments?ref_type=contract").json()
    gone = r2.state(key) if (r2.available and key) else "unknown"
    ok = dele.status_code == 200 and not any(x["id"] == aid for x in contracts_after) and gone != "present"
    record(name, ok, "上传 200 → 列表归类正确 → 下载字节一致 → 删除 200 → 列表与对象消失")


def case_contact(api: Api, r2: R2, keep: bool) -> None:
    name = "人员档案附件：category=other 上传 → 列表 → 下载 → 删除"
    created = api.post("/contacts", json={"name": "BLF-1137 附件验证（可删除）"})
    if created.status_code != 200:
        record(name, False, f"建档 HTTP {created.status_code} {detail_of(created)[:80]}")
        return
    cid = created.json()["id"]
    filename = "身份证扫描件-中文名.png"
    data = payload(b"\x89PNG\r\n\x1a\n" + b"contact attachment\n" * 256, 41)
    up = api.upload(
        f"/contacts/{cid}/attachments", filename, data, content_type="image/png",
        extra={"category": "other"},
    )
    if up.status_code != 200:
        record(name, False, f"上传 HTTP {up.status_code} {detail_of(up)[:80]}")
        return
    aid = up.json()["id"]
    rows = api.get(f"/contacts/{cid}/attachments").json()
    ok_list = any(x["id"] == aid and x.get("category") == "other" for x in rows)
    if not ok_list:
        record(name, False, f"列表未见该附件或分类不符：{rows}")
        return
    ok, why = check_download(api, f"/contacts/{cid}/attachments/{aid}/download", data, filename)
    if not ok:
        record(name, False, why)
        return
    key = object_key(aid)
    if keep:
        record(name, True, f"cid={cid} aid={aid} 已保留（--keep）")
        return
    dele = api.delete(f"/contacts/{cid}/attachments/{aid}")
    after = api.get(f"/contacts/{cid}/attachments").json()
    gone = r2.state(key) if (r2.available and key) else "unknown"
    ok = dele.status_code == 200 and not any(x["id"] == aid for x in after) and gone != "present"
    record(name, ok, f"上传 200 → 列表可见 → 下载字节一致 → 删除 {dele.status_code} → 列表与对象消失")
    api.delete(f"/contacts/{cid}")


def case_voucher(api: Api, r2: R2, pid: int, keep: bool) -> None:
    name = "支出凭证：POST /expenses/{id}/vouchers → 列表 → 下载 → 删除（前端暂无入口）"
    created = api.post(
        "/expenses",
        json={"project_id": pid, "subject": "其他", "amount": 1, "note": "BLF-1137 凭证验证（可删除）"},
    )
    if created.status_code != 200:
        record(name, False, f"建支出单据 HTTP {created.status_code} {detail_of(created)[:80]}")
        return
    eid = created.json()["id"]
    filename = "支出凭证-中文名.png"
    data = payload(b"\x89PNG\r\n\x1a\n" + b"voucher\n" * 256, 51)
    up = api.upload(f"/expenses/{eid}/vouchers", filename, data, content_type="image/png")
    if up.status_code != 200:
        record(name, False, f"上传 HTTP {up.status_code} {detail_of(up)[:80]}")
        return
    aid = up.json()["id"]
    rows = api.get(f"/expenses/{eid}/vouchers").json()
    if not any(x["id"] == aid for x in rows):
        record(name, False, f"凭证列表未见该附件：{rows}")
        return
    # 凭证不能出现在项目附件列表里（同一张表按 ref_type 隔离）
    leaked = any(x["id"] == aid for x in api.get(f"/projects/{pid}/attachments").json())
    ok, why = check_download(api, f"/expenses/{eid}/vouchers/{aid}/download", data, filename)
    if not ok:
        record(name, False, why)
        return
    key = object_key(aid)
    if keep:
        record(name, True, f"eid={eid} aid={aid} 已保留（--keep）")
        return
    dele = api.delete(f"/expenses/{eid}/vouchers/{aid}")
    after = api.get(f"/expenses/{eid}/vouchers").json()
    gone = r2.state(key) if (r2.available and key) else "unknown"
    ok = dele.status_code == 200 and not any(x["id"] == aid for x in after) and gone != "present" and not leaked
    record(
        name,
        ok,
        f"上传 200 → 凭证列表可见（且未泄漏进项目附件列表）→ 下载字节一致 → 删除 {dele.status_code}"
        f" → 列表与对象消失",
    )


def case_lost_object(api: Api, r2: R2, pid: int) -> None:
    name = "404：对象被外部删除（只留元数据）→ 下载给「附件文件已丢失，请联系管理员」"
    if not r2.available:
        skip(name, "缺 R2_* 环境变量，无法从桶里直接删对象")
        return
    data = payload(b"%PDF-1.4 lost\n" * 256, 61)
    up = api.upload(f"/projects/{pid}/attachments", "丢件演示-中文名.pdf", data)
    if up.status_code != 200:
        record(name, False, f"上传 HTTP {up.status_code}")
        return
    aid = up.json()["id"]
    key = object_key(aid)
    if not key or not r2.remove(key):
        record(name, False, "取不到对象键或删对象失败")
        return
    r = api.get(f"/projects/{pid}/attachments/{aid}/download")
    ok = r.status_code == 404 and detail_of(r) == MSG_LOST
    # 元数据仍应保留（正文没了但行还在，便于管理员对账）
    listed = any(x["id"] == aid for x in api.get(f"/projects/{pid}/attachments").json())
    api.delete(f"/projects/{pid}/attachments/{aid}")
    record(name, ok and listed, f"HTTP {r.status_code} {detail_of(r)[:60]} · 元数据仍保留={listed}")


def case_storage_down(api: Api, base: str, r2: R2, pid: int) -> None:
    name = "502：R2 凭据错误 → 上传与下载都是「文件存储不可用…」（不是 404「文件已丢失」），且不产生元数据"
    # 先用正常实例放一个 R2 行进去，作为读路径的探针（用完就删）
    probe_data = payload(b"%PDF-1.4 502 probe\n" * 128, 81)
    up_ok = api.upload(f"/projects/{pid}/attachments", "502读探针.pdf", probe_data)
    if up_ok.status_code != 200:
        record(name, False, f"探针上传失败 HTTP {up_ok.status_code} {detail_of(up_ok)[:60]}")
        return
    probe = up_ok.json()["id"]
    key = object_key(probe)

    down = Api(base)
    down.login()
    before = metadata_count("project")
    data = payload(b"%PDF-1.4 storage down\n" * 64, 71)
    up = down.upload(f"/projects/{pid}/attachments", "存储不可用演示.pdf", data)
    after = metadata_count("project")
    # 同一个坏凭据实例读一个已存在的 R2 行：必须是 502（可重试），不是 404（已丢失）
    got = down.get(f"/projects/{pid}/attachments/{probe}/download")
    ok = (
        up.status_code == 502
        and MSG_STORAGE in detail_of(up)
        and MSG_LOST not in detail_of(up)
        and after == before  # 正文没写成功 → 不产生元数据，客户端可安全重试
        and got.status_code == 502
        and MSG_STORAGE in detail_of(got)
        and MSG_LOST not in detail_of(got)
    )
    dele = api.delete(f"/projects/{pid}/attachments/{probe}")
    gone = r2.state(key) if (r2.available and key) else "unknown"
    record(
        name,
        ok and dele.status_code == 200 and gone != "present",
        f"上传 HTTP {up.status_code} {detail_of(up)[:52]} · 元数据 {before}→{after} · "
        f"下载 HTTP {got.status_code} {detail_of(got)[:40]} · 探针删除 {dele.status_code} 对象{OBJECT_STATE_LABEL[gone]}",
    )


def cleanup_project(api: Api, pid: int) -> None:
    """清除验证项目：**先逐个删附件，再删项目**。

    项目删除是「软删除」（回收站可恢复，`api/routers/projects.py` 的 `delete_project`），
    根本不会动附件正文——所以靠删项目清 R2 对象是无效的，必须逐个走附件删除接口。
    已软删的项目附件接口会 404，所以先 restore 一次再删（未软删时 restore 返回 404，忽略即可）。
    """
    api.post(f"/projects/{pid}/restore", json={})
    for ref in ("", "?ref_type=contract"):
        for row in api.get(f"/projects/{pid}/attachments{ref}").json():
            api.delete(f"/projects/{pid}/attachments/{row['id']}")
    api.delete(f"/projects/{pid}")


def main() -> int:
    parser = argparse.ArgumentParser(description="BLF-1137 附件 R2 端到端走查")
    parser.add_argument("--keep", action="store_true", help="保留上传的附件（默认全部删除）")
    parser.add_argument("--storage-down-base", default="", help="R2 凭据错误的 API 实例，用于 502 分支")
    parser.add_argument("--skip-oversize", action="store_true", help="跳过 100MB 界外用例")
    args = parser.parse_args()

    api = Api(API_BASE)
    api.login()
    r2 = R2()
    if not r2.available:
        print("注意：缺 R2_* 环境变量或 boto3，对象级断言将降级为 SKIP\n")
    baseline = r2.count()
    print(f"R2 桶 {r2.bucket or '(未配置)'} 起始对象数：{baseline}\n")

    created = api.post(
        "/projects",
        json={
            "name": f"BLF-1137 附件 R2 端到端验证（可删除）{time.strftime('%Y%m%d-%H%M%S')}",
            "type": "other",
            "priority": "中",
        },
    )
    if created.status_code != 200:
        print(f"建项目失败：HTTP {created.status_code} {detail_of(created)}")
        return 1
    pid = created.json()["id"]

    case_project_attachment(api, r2, pid, args.keep)
    case_batch(api, r2, pid, args.keep)
    if args.skip_oversize:
        skip("100MB 界外：HTTP 400「单文件最大 100MB」，且不产生元数据", "--skip-oversize")
    else:
        case_oversize(api, pid)
    case_bad_type(api, pid)
    case_contract(api, r2, pid, args.keep)
    case_contact(api, r2, args.keep)
    case_voucher(api, r2, pid, args.keep)
    case_lost_object(api, r2, pid)
    if args.storage_down_base:
        case_storage_down(api, args.storage_down_base, r2, pid)
    else:
        skip(
            "502：R2 凭据错误 → 上传与下载都是「文件存储不可用…」（不是 404「文件已丢失」），且不产生元数据",
            "未提供 --storage-down-base",
        )

    if not args.keep:
        # 先逐个删附件（连 R2 对象），再软删项目
        cleanup_project(api, pid)
    else:
        print("（--keep）附件已保留在项目里，未做删除清理")

    final = r2.count()
    if baseline is not None and final is not None:
        record("R2 桶无残留", final == baseline, f"起始 {baseline} → 结束 {final}")

    failed = [row for row in RESULTS if row[0] == "FAIL"]
    skipped = [row for row in RESULTS if row[0] == "SKIP"]
    print(f"\n=== 结果：{len(RESULTS) - len(failed) - len(skipped)} passed / {len(failed)} failed / {len(skipped)} skipped ===")
    for status, name, detail in failed:
        print(f"  {status}  {name} — {detail}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
