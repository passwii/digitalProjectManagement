#!/usr/bin/env python3
"""把存量本地附件回填到 Cloudflare R2（影子迁移的「全量回填」一步）。

背景
----
`attachments` 表里接入 R2 之前的行是本地磁盘坐标（`storage_backend='local'`、
`object_key=''`、`path=<磁盘路径>`）。切换 `STORAGE_BACKEND=r2` 之后，新上传走 R2，
但**老行的正文仍在磁盘上**——本脚本负责把正文搬到 R2 并改写元数据，
使下载路径不再依赖旧卷。

设计要点
--------
· **默认 dry-run**：不加 `--apply` 只打印将要做什么，不写库、不上传。
· **幂等**：已经有 `object_key` 的行直接跳过，可反复执行。
· **先传后改**：正文先成功落 R2，再更新该行元数据；上传失败的行走错误清单，
  元数据保持不动（仍可用旧磁盘路径下载），不会造成「元数据说在 R2、其实没传上去」。
· **可选校验**：`--verify` 上传后回读比对字节，适合一次性正式迁移。
· **可选清理**：`--delete-local` 在**上传并校验成功后**才删本地文件（默认保留）。
· **不吞错**：任何上传失败都以非 0 退出码结束，便于放进发布流程做闸门。

本脚本是独立的运维脚本：只用 psycopg3 连 PostgreSQL、用 boto3 连 R2，
不依赖已归档的 Python 后端代码，也不会在导入期连接数据库。依赖见 `scripts/requirements-ops.txt`。

用法
----
    # 1) 先看清单（不改任何东西）
    python scripts/migrate_attachments_to_r2.py

    # 2) 正式迁移（上传 + 校验 + 改库，保留本地文件）
    STORAGE_BACKEND=r2 python scripts/migrate_attachments_to_r2.py --apply --verify

    # 3) 正式迁移（上传 + 校验 + 改库 + 回收本地文件）
    STORAGE_BACKEND=r2 python scripts/migrate_attachments_to_r2.py --apply --verify --delete-local

本脚本要在**同一次调用里**把 `--delete-local` 一起给上：待回填的集合是「`object_key` 为空
的行」，第一步跑完后所有行都有了 `object_key`，再跑一次会打印「没有需要回填的附件」并
直接返回——**一个本地文件都不会删**。分两步走会让人以为已经清干净。

注意：需先把 `STORAGE_BACKEND` 设为 `r2`（或 `R2_*` 配齐且用 `auto`），
否则本脚本会拒绝执行——避免「以为在回填 R2、其实又写了一遍本地盘」。
"""

from __future__ import annotations

import argparse
import hashlib
import os
import re
import sys
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.parse import quote
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import boto3
import psycopg
from botocore.config import Config
from psycopg.rows import dict_row

_ROOT = Path(__file__).resolve().parents[1]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from scripts._attachment_rows import domain_for as _domain_for  # noqa: E402
from scripts._attachment_rows import int_of as _ident  # noqa: E402
from scripts._attachment_rows import text_of as _text  # noqa: E402

BACKEND_LOCAL = "local"
BACKEND_R2 = "r2"

#: 下载/回读分块大小，与线上 R2 传输层保持一致。
CHUNK_SIZE = 1024 * 1024

_PRODUCTION_ENVS = {"prod", "production"}

#: 业务域 → 对象键一级目录；未登记的一律收敛为「其他」。
_DOMAIN_FOLDER = {
    "contract": "合同",
    "project": "项目",
    "expense": "凭证",
    "contact": "档案",
}
_FALLBACK_FOLDER = "其他"
#: 人员档案量小，不设年份二级目录（与线上 build_object_key 一致）。
_NO_YEAR_DOMAINS = {"contact"}

_MAX_STEM_CHARS = 100
_RANDOM_TAG_LEN = 8

_CONTROL_CHARS = re.compile(r"[\x00-\x1f\x7f]")
_WHITESPACE = re.compile(r"\s+")
_UNSAFE_NAME_CHARS = re.compile(r'[/\\:*?"<>|]')
_DOT_RUN = re.compile(r"\.{2,}")

#: 待回填 = `object_key` 为空的行；SQL 是静态字面量，值全部走绑定参数。
_PENDING_SQL = """
SELECT id, filename, path, content_type, ref_type
FROM attachments
WHERE object_key IS NULL OR object_key = ''
ORDER BY id
"""

_UPDATE_SQL = """
UPDATE attachments
SET storage_backend = %s,
    object_key = %s,
    path = %s,
    etag = %s,
    size = %s
WHERE id = %s
"""

try:
    _APP_TZ = ZoneInfo("Asia/Shanghai")
except ZoneInfoNotFoundError:  # pragma: no cover - 缺少 IANA 数据时的兜底
    # 中国自 1991 年起无夏令时，固定 +08:00 与 IANA 数据等价。
    _APP_TZ = timezone(timedelta(hours=8), "Asia/Shanghai")


class StorageConfigError(RuntimeError):
    """存储配置缺失或自相矛盾：R2-only 闸门拒绝执行。"""


class R2Unavailable(RuntimeError):
    """R2 不可用（网络 / 凭据 / 桶不存在 / 5xx）。"""


class R2ObjectMissing(RuntimeError):
    """对象不存在（404 / NoSuchKey）。"""


@dataclass(frozen=True)
class R2Settings:
    """R2 连接参数（全部来自 R2_* 环境变量）。"""

    endpoint_url: str
    access_key_id: str
    secret_access_key: str
    bucket: str
    region: str = "auto"
    public_url: str = ""


@dataclass(frozen=True)
class StoredObject:
    """一次上传的结果，直接映射到 Attachment 的存储字段。"""

    backend: str
    path: str
    object_key: str
    size: int
    etag: str


def _env(name: str, default: str = "") -> str:
    return (os.getenv(name) or "").strip() or default


def _app_now() -> datetime:
    """当前时刻的北京时间；对象键里的年份按这个口径取。"""
    return datetime.now(_APP_TZ)


def _is_production() -> bool:
    return _env("APP_ENV", "development").lower() in _PRODUCTION_ENVS


def _r2_settings_from_env() -> R2Settings:
    return R2Settings(
        endpoint_url=_env("R2_ENDPOINT_URL"),
        access_key_id=_env("R2_ACCESS_KEY_ID"),
        secret_access_key=_env("R2_SECRET_ACCESS_KEY"),
        bucket=_env("R2_BUCKET_NAME"),
        region=_env("R2_REGION", "auto"),
        public_url=_env("R2_PUBLIC_URL"),
    )


def _r2_settings_complete(settings: R2Settings) -> bool:
    return bool(
        settings.endpoint_url
        and settings.access_key_id
        and settings.secret_access_key
        and settings.bucket
    )


def _missing_r2_fields(settings: R2Settings) -> str:
    """列出缺失的 R2 必填项（只报变量名，**绝不回显值**）。"""
    required = {
        "R2_ENDPOINT_URL": settings.endpoint_url,
        "R2_ACCESS_KEY_ID": settings.access_key_id,
        "R2_SECRET_ACCESS_KEY": settings.secret_access_key,
        "R2_BUCKET_NAME": settings.bucket,
    }
    return ", ".join(name for name, value in required.items() if not value) or "未设置"


def _resolve_backend_name() -> str:
    """按 STORAGE_BACKEND 解析新写入后端，保留线上「配置不自洽就报错」的语义。"""
    settings = _r2_settings_from_env()
    complete = _r2_settings_complete(settings)
    requested = _env("STORAGE_BACKEND", BACKEND_R2).lower()
    if requested not in {"auto", BACKEND_LOCAL, BACKEND_R2}:
        raise StorageConfigError(
            f"STORAGE_BACKEND 取值无法识别：{requested!r}（只支持 r2 / auto / local）"
        )
    if requested == BACKEND_R2 and not complete:
        raise StorageConfigError(
            "STORAGE_BACKEND=r2 但 R2 配置不完整（需要 R2_ENDPOINT_URL / "
            "R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET_NAME）"
        )
    if requested == "auto" and not complete:
        raise StorageConfigError(
            "STORAGE_BACKEND=auto 但 R2 配置不完整（缺 "
            f"{_missing_r2_fields(settings)}）：R2 是附件正文唯一的持久化口径，"
            "不回落本地磁盘。本地开发请显式设 STORAGE_BACKEND=local"
            "（正文只写临时暂存目录，不持久化）。"
        )
    backend = (
        BACKEND_R2
        if (requested == BACKEND_R2 or (requested == "auto" and complete))
        else BACKEND_LOCAL
    )
    if backend == BACKEND_LOCAL and _is_production():
        raise StorageConfigError(
            f"APP_ENV={_env('APP_ENV')} 下不允许 STORAGE_BACKEND={requested}："
            "R2 是附件正文唯一的持久化口径，生产环境必须配置 R2_* 并设 "
            "STORAGE_BACKEND=r2。"
        )
    return backend


def _database_url() -> str:
    """DATABASE_URL → psycopg3 可直接连接 PostgreSQL 的 libpq URL。

    SQLAlchemy 风格的驱动后缀（`postgresql+psycopg://` / `+psycopg2` /
    `+asyncpg`）不是合法 libpq 连接串，这里统一去掉；`postgres://` 也归一为
    `postgresql://`。
    """
    raw = (os.environ.get("DATABASE_URL") or "").strip()
    if not raw:
        raise RuntimeError("DATABASE_URL 未配置（需指向 PostgreSQL）")
    if raw.startswith("postgres://"):
        return "postgresql://" + raw[len("postgres://") :]
    if raw.startswith("postgresql://"):
        return raw
    if raw.startswith("postgresql+") and "://" in raw:
        return "postgresql://" + raw.split("://", 1)[1]
    raise RuntimeError("DATABASE_URL 必须指向 PostgreSQL")


def _connect():
    """建立 psycopg3 连接；行用 dict 表示，便于直接复用附件行工具。"""
    return psycopg.connect(
        _database_url(), connect_timeout=10, row_factory=dict_row
    )


def _build_client(settings: R2Settings):
    """构造 S3 兼容客户端（R2 只支持 SigV4，且必须显式用 path 风格）。"""
    return boto3.client(
        "s3",
        endpoint_url=settings.endpoint_url,
        aws_access_key_id=settings.access_key_id,
        aws_secret_access_key=settings.secret_access_key,
        region_name=settings.region or "auto",
        config=Config(
            signature_version="s3v4",
            s3={"addressing_style": "path"},
            retries={"max_attempts": 3, "mode": "standard"},
        ),
    )


def _sanitize_key(key: str) -> str:
    """清洗对象键：S3 键允许 Unicode，只去掉控制字符并归一空白。"""
    if not key:
        return ""
    cleaned = _CONTROL_CHARS.sub("", key)
    cleaned = _WHITESPACE.sub(" ", cleaned)
    return cleaned.strip()


def _business_folder(domain: str) -> str:
    return _DOMAIN_FOLDER.get((domain or "").strip().lower(), _FALLBACK_FOLDER)


def _object_key_ext(filename: str) -> str:
    """扩展名（小写，只保留字母数字），非法则返回空串。"""
    ext = Path(_sanitize_key(filename or "")).suffix.lower()
    return ext if len(ext) > 1 and ext[1:].isalnum() else ""


def _clean_file_stem(filename: str) -> str:
    """原始文件名 → 可读、可安全进对象键的基名（不含扩展名）。

    与线上 storage.clean_file_stem 保持同一套清洗规则：取 basename、去控制字符、
    替换保留字符，保留中文与空格，限长后为空则回落 `file`。
    """
    base = (filename or "").replace("\\", "/").split("/")[-1]
    base = _CONTROL_CHARS.sub("", base)
    base = _UNSAFE_NAME_CHARS.sub("-", base)
    ext = _object_key_ext(base)
    stem = base[: -len(ext)] if ext else base
    stem = _DOT_RUN.sub("-", stem)
    stem = _WHITESPACE.sub(" ", stem).strip(" .-")
    stem = stem[:_MAX_STEM_CHARS].strip(" .-")
    return stem or "file"


def _build_object_key(domain: str, filename: str) -> str:
    """生成对象键：`{业务域}/{yyyy}/{可读原名}__{8位随机}{ext}`。

    与线上 build_object_key 的调用口径一致：迁移脚本不传 year / disambiguator，
    年份取当前北京时间，随机后缀取 8 位十六进制；档案类不设年份目录。
    """
    folder = _business_folder(domain)
    parts = [folder]
    if (domain or "").strip().lower() not in _NO_YEAR_DOMAINS:
        parts.append(f"{_app_now():%Y}")
    name = f"{_clean_file_stem(filename)}__{uuid.uuid4().hex[:_RANDOM_TAG_LEN]}"
    name += _object_key_ext(filename)
    parts.append(name)
    return _sanitize_key("/".join(parts))


def _public_url(settings: R2Settings, key: str) -> str:
    """对象公开 URL：优先 R2_PUBLIC_URL，否则回落 endpoint/bucket。"""
    base = (settings.public_url or f"{settings.endpoint_url}/{settings.bucket}").rstrip(
        "/"
    )
    return f"{base}/{quote(_sanitize_key(key), safe='/')}"


def _is_missing(exc: Exception) -> bool:
    """判定「对象不存在」，与「R2 不可用」区分开（前者 404，后者 502）。"""
    response = getattr(exc, "response", None) or {}
    code = str(response.get("Error", {}).get("Code", ""))
    status = (response.get("ResponseMetadata", {}) or {}).get("HTTPStatusCode")
    return code in {"NoSuchKey", "NoSuchBucket", "404"} or status == 404


def _put_object(
    client, settings: R2Settings, data: bytes, key: str, content_type: str
) -> StoredObject:
    """上传一段字节并返回可落库的坐标；失败统一包装成 R2Unavailable。"""
    try:
        response = client.put_object(
            Bucket=settings.bucket,
            Key=key,
            Body=data,
            ContentType=content_type or "application/octet-stream",
        )
    except Exception as exc:  # noqa: BLE001 - 统一转成脚本可读的错误
        raise R2Unavailable(f"R2 上传失败（{exc.__class__.__name__}）") from exc
    etag = str(response.get("ETag") or "").strip('"')
    if not etag:
        # 某些兼容实现不回 ETag：用内容摘要兜底，保证元数据里有可核对指纹。
        etag = hashlib.sha256(data).hexdigest()
    return StoredObject(
        backend=BACKEND_R2,
        path=_public_url(settings, key),
        object_key=key,
        size=len(data),
        etag=etag,
    )


def _read_object(client, settings: R2Settings, key: str) -> bytes:
    """回读整段对象（--verify 用）；不存在抛 R2ObjectMissing，其他失败抛 R2Unavailable。"""
    try:
        response = client.get_object(Bucket=settings.bucket, Key=key)
    except Exception as exc:  # noqa: BLE001 - 统一转成脚本可读的错误
        if _is_missing(exc):
            raise R2ObjectMissing(key) from exc
        raise R2Unavailable(f"R2 读取失败（{exc.__class__.__name__}）") from exc

    body = response["Body"]
    chunks: list[bytes] = []
    try:
        while True:
            chunk = body.read(CHUNK_SIZE)
            if not chunk:
                break
            chunks.append(chunk)
    finally:
        close = getattr(body, "close", None)
        if callable(close):
            close()
    return b"".join(chunks)


def _pending(conn) -> list[dict[str, Any]]:
    """待回填 = 还没有 object_key 的行（本地坐标）。"""
    with conn.cursor() as cur:
        cur.execute(_PENDING_SQL)
        return cur.fetchall()


def _read_local(row: dict[str, Any]) -> bytes | None:
    path = _text(row.get("path")).strip()
    if not path or path.startswith(("http://", "https://")):
        return None
    fp = Path(path)
    if not fp.exists():
        return None
    return fp.read_bytes()


def migrate(*, apply: bool, verify: bool, delete_local: bool) -> int:
    try:
        backend_name = _resolve_backend_name()
    except StorageConfigError as exc:
        print(f"[abort] {exc}", file=sys.stderr)
        return 2

    if backend_name != BACKEND_R2:
        print(
            f"[abort] 当前 STORAGE_BACKEND 解析为 {backend_name!r}，不是 'r2'。\n"
            "        请设置 STORAGE_BACKEND=r2（并配齐 R2_*）后重跑，"
            "避免把正文又写回本地盘。",
            file=sys.stderr,
        )
        return 2

    settings = _r2_settings_from_env()
    client = _build_client(settings)
    try:
        conn = _connect()
    except Exception as exc:  # noqa: BLE001 - 脚本入口，连不上库就直接退出
        print(
            f"[error] 无法连接数据库（{exc.__class__.__name__}）：{exc}",
            file=sys.stderr,
        )
        return 1

    failures: list[tuple[int, str]] = []
    migrated = skipped_missing = 0
    try:
        rows = _pending(conn)
        # 结束只读事务，避免长时间回填期间一直持有表的 AccessShareLock。
        conn.commit()
        total = len(rows)
        print(f"待回填 {total} 条（模式：{'APPLY' if apply else 'DRY-RUN'}）")
        if not total:
            print("没有需要回填的附件。")
            return 0

        for row in rows:
            row_id = row["id"]
            aid = _ident(row_id)
            data = _read_local(row)
            if data is None:
                # 本地文件已不在：无法回填，列出待人工处理（不阻断其他行）
                skipped_missing += 1
                print(f"  [skip] id={aid} 本地正文缺失：{row.get('path')}")
                failures.append((aid, "local file missing"))
                continue

            key = _build_object_key(
                _domain_for(row), _text(row.get("filename")) or "attachment"
            )
            print(f"  [plan] id={aid} {row.get('filename')!r} -> {key} ({len(data)} bytes)")
            if not apply:
                continue

            try:
                stored = _put_object(
                    client, settings, data, key, _text(row.get("content_type"))
                )
                if verify and _read_object(client, settings, stored.object_key) != data:
                    raise R2Unavailable("回读校验不一致")

                # 先传成功、再改元数据：失败的行仍指向可用的旧磁盘路径。
                local_before = _text(row.get("path"))
                with conn.cursor() as cur:
                    cur.execute(
                        _UPDATE_SQL,
                        (
                            BACKEND_R2,
                            stored.object_key,
                            stored.path,
                            stored.etag,
                            stored.size,
                            row_id,
                        ),
                    )
                conn.commit()
                migrated += 1

                if delete_local:
                    Path(local_before).unlink(missing_ok=True)
            except (R2Unavailable, R2ObjectMissing) as exc:
                conn.rollback()
                failures.append((aid, str(exc)))
                print(f"  [fail] id={aid}: {exc}", file=sys.stderr)

        print(
            f"完成：回填 {migrated}，跳过(本地缺失) {skipped_missing}，失败 {len(failures)}"
        )
        if failures:
            print("失败明细：", file=sys.stderr)
            for aid, why in failures:
                print(f"  - id={aid}: {why}", file=sys.stderr)
            return 1
        return 0
    finally:
        conn.close()


def main() -> int:
    parser = argparse.ArgumentParser(description="回填存量本地附件到 Cloudflare R2")
    parser.add_argument(
        "--apply", action="store_true", help="真正执行（默认只打印计划）"
    )
    parser.add_argument("--verify", action="store_true", help="上传后回读比对字节")
    parser.add_argument(
        "--delete-local", action="store_true", help="校验成功后删除本地文件（默认保留）"
    )
    args = parser.parse_args()
    return migrate(apply=args.apply, verify=args.verify, delete_local=args.delete_local)


if __name__ == "__main__":
    raise SystemExit(main())
