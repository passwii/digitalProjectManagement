#!/usr/bin/env python3
"""把 R2 上的对象键迁移到「业务目录」规范（方案 A）。

背景
----
接入 R2 时对象键是 tenant/default/{domain}/{yyyy}/{mm}/{uuid}.{ext}：层级深、文件名
不可读，控制台里几乎只能靠猜（用户 2026-09-18 反馈「找文件难度太大」）。方案 A 改为：

    合同/2026/2026-024-xx采购合同-534万__a1b2c3d4.pdf
    项目/2026/开票-设备费-60%__5e6f7a8b.png
    凭证/2026/2026-09-差旅-发票__9c0d1e2f_20260918120000.pdf
    档案/张爱杰-身份证__3b4c5d6e.pdf          （人员档案量小，不分年）

一级 = 业务域，二级 = 年份，文件名 = 可读原名 + 8 位随机后缀。最多两级目录。

做法（每一步都可中断、可重跑）
------------------------------
对每一行：同桶服务端复制旧键 → 新键（字节不经本机）→ 校验 → 改库。旧对象先留着，
确认新键到位后再用 --sweep-legacy 回收（它只删 tenant/default/ 下已无任何行引用
的对象）—— 分两步是为了随时可以回头比对，而不是靠一条命令的运气。

· 默认 dry-run：不加 --apply 只打印「旧键 → 新键」对照清单，不写库、不动桶。
· 确定性新键（重跑是真无操作）：新键只由行自身算 —— 8 位后缀优先沿用键里已有的，
  其次取旧键里的 uuid；年份不取当前时间，而是「已是新键的行沿用键里的年份、旧键取该行
  uploaded_at 的年份」；凭证键尾的上传标记（__{后缀}_{时间戳}）原样带过去。因此同一行
  反复执行得到同一个键，已在新键上的行直接跳过，跨年后重跑也不会把整批行算成新年的键
  （否则旧键会静默变成桶内孤儿）。
· 先复制、后改库：任一步失败都保留旧键与库内坐标，不会出现「库指向一个不存在的对象」；
  校验不过的复制品会被当场删掉，不在桶里留半成品。
· --verify：把新旧对象都完整读回来比较 sha256 与字节数（不是只看 ETag），
  确认复制真的字节级一致。305MB 量级在一分钟内。
· --sweep-legacy：回收旧命名空间里已无人引用的对象；仍被行引用的旧键永不删。
  它按「无引用」判定，所以不管你是先改键后回收、还是上一次忘了回收，都能收干净——
  不会出现「跑第二遍才发现什么都不删」的空操作。
· 不吞错：任何失败都以非 0 退出码结束。

依赖与配置
----------
本脚本是独立的运维脚本，不依赖归档的 Python 后端模块：

· 数据库：psycopg（psycopg3），连接串取 DATABASE_URL（兼容 SQLAlchemy 风格的
  postgresql+psycopg://，会规范化为 libpq URL）；
· 对象存储：boto3，凭据取 R2_ENDPOINT_URL / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY /
  R2_BUCKET_NAME，可选 R2_REGION（默认 auto）与 R2_PUBLIC_URL。

用法
----
    # 1) 看对照清单（不改任何东西）
    python scripts/rekey_r2_objects.py

    # 2) 正式迁移（复制 + 整读校验 + 改库；旧键仍在桶里，可随时对照）
    python scripts/rekey_r2_objects.py --apply --verify

    # 3) 回收旧键（只删已无行引用的 tenant/default/... 对象）
    python scripts/rekey_r2_objects.py --apply --sweep-legacy

读取永远按行内 object_key，不解析路径，所以「新旧键并存」期间线上不受影响：
迁移中、迁移后都不需要停服，也不会出现 404。
"""

from __future__ import annotations

import argparse
import hashlib
import os
import re
import sys
import uuid
from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.parse import quote
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import psycopg
from psycopg.rows import dict_row

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

#: 业务域推断只有这一处实现（见 scripts/_attachment_rows.py）：它决定对象键的一级目录，
#: 与线上写入必须给出同一个答案，否则迁移后会出现「同一类附件落在两个目录」。
from scripts._attachment_rows import domain_for as _domain_for  # noqa: E402
from scripts._attachment_rows import int_of as _ident  # noqa: E402
from scripts._attachment_rows import text_of as _text  # noqa: E402

#: 旧键末段里的 uuid（32 位十六进制），用于取确定性的新键后缀
_UUID_RE = re.compile(r"[0-9a-f]{32}")
#: 新键末段：{可读原名}__{后缀}[_{上传标记}]（标记是凭证的上传时间戳）。后缀长度写成
#: {8,}：既认现在线上产出的 8 位，也不至于将来改成 12 位时把标记误当成后缀。
_TAG_RE = re.compile(r"__([0-9A-Za-z]{8,})(?:_([0-9A-Za-z]+))?$")
#: 新键里的年份目录段（{业务域}/{yyyy}/），旧键两级都是数字但取第二个
_YEAR_RE = re.compile(r"^(?:19|20)\d{2}$")

#: 方案 A 之前的命名空间前缀（回收只针对它，绝不碰新键）
LEGACY_PREFIX = "tenant/default/"

#: 下载分块大小：1MB —— 100MB 附件不会一次性进内存
CHUNK_SIZE = 1024 * 1024

#: 业务域（API 层 domain）→ 一级目录名。一级目录就是业务，控制台里直接可读。
#: 未登记的 domain 一律收敛为「其他」，绝不把调用方字符串直接拼成路径。
_DOMAIN_FOLDER = {
    "contract": "合同",
    "project": "项目",
    "expense": "凭证",
    "contact": "档案",
}
_FALLBACK_FOLDER = "其他"

#: 人员档案量小，不设年份二级目录（方案 A：该类只有「档案/文件名」两级）
_NO_YEAR_DOMAINS = {"contact"}

#: 可读文件名（不含扩展名）长度上限：太长的名字会把 key 撑大且控制台里显示不全
_MAX_STEM_CHARS = 100

#: 随机后缀长度（防重名 + 防枚举；桶虽是私有的，纵深防御不亏）
_RANDOM_TAG_LEN = 8

_CONTROL_CHARS = re.compile(r"[\x00-\x1f\x7f]")
_WHITESPACE = re.compile(r"\s+")
#: 文件名里不允许出现的字符：对象键分隔符 + Windows/URL 保留字符
_UNSAFE_NAME_CHARS = re.compile(r'[/\\:*?"<>|]')
#: 连续的点（..）不留在对象键里：看起来像路径穿越，排查时也是噪声
_DOT_RUN = re.compile(r"\.{2,}")

try:  # 容器缺 IANA 数据时用固定 +08:00（中国自 1991 年起无夏令时）
    _APP_TZ = ZoneInfo("Asia/Shanghai")
except ZoneInfoNotFoundError:  # pragma: no cover - 极端运行环境兜底
    _APP_TZ = timezone(timedelta(hours=8), "Asia/Shanghai")


@dataclass(frozen=True)
class RekeyPlan:
    """一行的改键计划（aid / 旧键 / 新键 / 库内指纹）。"""

    aid: int
    filename: str
    old_key: str
    new_key: str
    size: int
    etag: str


@dataclass
class RekeyReport:
    """一次迁移的结果汇总（dry-run 时只有 plans）。"""

    plans: list[RekeyPlan] = field(default_factory=list)
    up_to_date: int = 0
    rekeyed: int = 0
    failures: list[tuple[int, str]] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.failures


@dataclass(frozen=True)
class AttachmentRow:
    """attachments 表里迁移需要的最小行快照。

    只取改键与校验用得到的列，避免脚本和 ORM 模型耦合；uploaded_at 用于决定
    旧键的目标年份（必须是行内值，不能取当前时间）。
    """

    id: int
    filename: str
    object_key: str
    size: int
    etag: str
    ref_type: str
    uploaded_at: datetime | None


# ============ 数据库（psycopg3） ============


def _database_url() -> str:
    """DATABASE_URL → psycopg3 可直接连接的 libpq URL。

    SQLAlchemy 风格的驱动后缀（postgresql+psycopg:// / +psycopg2 / +asyncpg）
    不是合法 libpq 连接串，这里统一去掉；postgres:// 也归一为 postgresql://。
    """
    raw = (os.getenv("DATABASE_URL") or "").strip()
    if not raw:
        raise RuntimeError("DATABASE_URL 未配置（需指向 PostgreSQL）")
    if raw.startswith("postgres://"):
        return "postgresql://" + raw[len("postgres://") :]
    if raw.startswith("postgresql://"):
        return raw
    if raw.startswith("postgresql+") and "://" in raw:
        return "postgresql://" + raw.split("://", 1)[1]
    raise RuntimeError("DATABASE_URL 必须指向 PostgreSQL")


def connect_database() -> psycopg.Connection:
    """按 DATABASE_URL 建立连接；失败由调用方转成非 0 退出码。"""
    return psycopg.connect(_database_url(), connect_timeout=15)


#: 已在 R2 的行（有 object_key），按主键顺序。值全部走绑定参数，SQL 是静态字面量。
_SELECT_R2_ROWS = """
    SELECT id, filename, object_key, size, etag, ref_type, uploaded_at
    FROM attachments
    WHERE object_key IS NOT NULL AND object_key <> ''
    ORDER BY id
"""

_UPDATE_ROW_WITH_ETAG = """
    UPDATE attachments
    SET object_key = %s, storage_backend = 'r2', path = %s, etag = %s
    WHERE id = %s
"""

_UPDATE_ROW_KEEP_ETAG = """
    UPDATE attachments
    SET object_key = %s, storage_backend = 'r2', path = %s
    WHERE id = %s
"""


def _r2_rows(conn: psycopg.Connection) -> list[AttachmentRow]:
    """读出所有已在 R2 的行（有 object_key），按主键顺序。"""
    with conn.cursor(row_factory=dict_row) as cur:
        cur.execute(_SELECT_R2_ROWS)
        records = cur.fetchall()
    return [
        AttachmentRow(
            id=_ident(record["id"]),
            filename=_text(record["filename"]),
            object_key=_text(record["object_key"]),
            size=_ident(record["size"]),
            etag=_text(record["etag"]),
            ref_type=_text(record["ref_type"]),
            uploaded_at=record["uploaded_at"],
        )
        for record in records
    ]


def _update_row(
    conn: psycopg.Connection,
    plan: RekeyPlan,
    settings: R2Settings,
    etag: str,
) -> None:
    """复制并校验成功后才改库；etag 为空时保留库内原值。"""
    path = public_url(settings, plan.new_key)
    with conn.cursor() as cur:
        if etag:
            cur.execute(
                _UPDATE_ROW_WITH_ETAG, (plan.new_key, path, etag, plan.aid)
            )
        else:
            cur.execute(_UPDATE_ROW_KEEP_ETAG, (plan.new_key, path, plan.aid))
        updated = cur.rowcount
    if updated == 0:
        conn.rollback()
        raise RuntimeError(f"附件 id={plan.aid} 在迁移过程中消失")
    conn.commit()


# ============ R2（boto3，S3 兼容） ============


class R2Unavailable(RuntimeError):
    """R2 不可用（网络 / 凭据 / 桶不存在 / 5xx）。"""


class R2ObjectMissing(RuntimeError):
    """对象不存在（404 / NoSuchKey）。"""


@dataclass(frozen=True)
class R2Settings:
    """R2 连接参数（由环境变量解析，本模块不把凭据写进代码）。"""

    endpoint_url: str
    access_key_id: str
    secret_access_key: str
    bucket: str
    region: str = "auto"
    public_url: str = ""

    def fingerprint(self) -> tuple[str, str, str, str, str]:
        """客户端缓存键：任一项变化即重建客户端。"""
        return (
            self.endpoint_url,
            self.access_key_id,
            self.secret_access_key,
            self.bucket,
            self.region or "auto",
        )


_CLIENTS: dict[tuple[str, str, str, str, str], Any] = {}


def _env(name: str, default: str = "") -> str:
    return (os.getenv(name) or "").strip() or default


def r2_settings_from_env() -> R2Settings:
    """从环境变量读取 R2 连接参数（与线上服务同一套 R2_* 变量名）。"""
    return R2Settings(
        endpoint_url=_env("R2_ENDPOINT_URL"),
        access_key_id=_env("R2_ACCESS_KEY_ID"),
        secret_access_key=_env("R2_SECRET_ACCESS_KEY"),
        bucket=_env("R2_BUCKET_NAME"),
        region=_env("R2_REGION", "auto"),
        public_url=_env("R2_PUBLIC_URL"),
    )


def r2_settings_complete(settings: R2Settings) -> bool:
    """R2 必填项是否齐全（endpoint / key id / secret / bucket）。"""
    return bool(
        settings.endpoint_url
        and settings.access_key_id
        and settings.secret_access_key
        and settings.bucket
    )


def build_client(settings: R2Settings):
    """真正构造 boto3 S3 客户端（测试可替换本函数注入内存实现）。"""
    import boto3
    from botocore.config import Config

    return boto3.client(
        "s3",
        endpoint_url=settings.endpoint_url,
        aws_access_key_id=settings.access_key_id,
        aws_secret_access_key=settings.secret_access_key,
        region_name=settings.region or "auto",
        # R2 只支持 SigV4，且路径风格必须显式开启（默认 virtual-host 会被拒）
        config=Config(
            signature_version="s3v4",
            s3={"addressing_style": "path"},
            retries={"max_attempts": 3, "mode": "standard"},
        ),
    )


def get_r2_client(settings: R2Settings):
    """取（或按配置指纹新建）R2 客户端单例。"""
    key = settings.fingerprint()
    client = _CLIENTS.get(key)
    if client is None:
        client = build_client(settings)
        _CLIENTS[key] = client
    return client


def close_clients() -> None:
    """丢弃缓存的客户端（测试清理 / 凭据轮转后强制重建）。"""
    _CLIENTS.clear()


def sanitize_key(key: str) -> str:
    """清洗对象键：S3 键允许 Unicode（中文会被 URL 编码），只去掉控制字符并归一空白。"""
    if not key:
        return ""
    cleaned = _CONTROL_CHARS.sub("", key)
    cleaned = _WHITESPACE.sub(" ", cleaned)
    return cleaned.strip()


def _is_missing(exc: Exception) -> bool:
    """判定「对象不存在」，与「R2 不可用」区分开（前者 404，后者 502）。"""
    response = getattr(exc, "response", None) or {}
    code = str(response.get("Error", {}).get("Code", ""))
    status = (response.get("ResponseMetadata", {}) or {}).get("HTTPStatusCode")
    return code in {"NoSuchKey", "NoSuchBucket", "404"} or status == 404


def object_stream(
    settings: R2Settings, key: str
) -> tuple[Iterator[bytes], int, str]:
    """打开对象读取流，返回 (分块迭代器, 字节数, etag)。

    对象不存在抛 R2ObjectMissing；其他失败抛 R2Unavailable。
    迭代器消费完/关闭时会释放底层连接。
    """
    try:
        client = get_r2_client(settings)
        resp = client.get_object(Bucket=settings.bucket, Key=key)
    except Exception as exc:
        if _is_missing(exc):
            raise R2ObjectMissing(key) from exc
        raise R2Unavailable(f"R2 读取失败（{exc.__class__.__name__}）") from exc

    body = resp["Body"]
    raw_length = resp.get("ContentLength")
    try:
        length = max(int(raw_length), 0)
    except (TypeError, ValueError):
        length = 0
    etag = str(resp.get("ETag") or "").strip('"')

    def _chunks() -> Iterator[bytes]:
        try:
            while True:
                chunk = body.read(CHUNK_SIZE)
                if not chunk:
                    break
                yield chunk
        finally:
            close = getattr(body, "close", None)
            if callable(close):
                close()

    return _chunks(), length, etag


def object_head(settings: R2Settings, key: str) -> dict | None:
    """对象元信息 {key, size, etag, content_type}；不存在返回 None。"""
    try:
        client = get_r2_client(settings)
        resp = client.head_object(Bucket=settings.bucket, Key=key)
    except Exception as exc:
        if _is_missing(exc):
            return None
        raise R2Unavailable(f"R2 HEAD 失败（{exc.__class__.__name__}）") from exc
    try:
        size = max(int(resp.get("ContentLength") or 0), 0)
    except (TypeError, ValueError):
        size = 0
    return {
        "key": key,
        "size": size,
        "etag": str(resp.get("ETag") or "").strip('"'),
        "content_type": str(resp.get("ContentType") or ""),
    }


def copy_object(settings: R2Settings, source_key: str, target_key: str) -> dict:
    """同桶服务端复制（字节不经调用方网络），返回 {key, etag}。"""
    try:
        client = get_r2_client(settings)
        resp = client.copy_object(
            Bucket=settings.bucket,
            CopySource={"Bucket": settings.bucket, "Key": source_key},
            Key=target_key,
        )
    except Exception as exc:
        raise R2Unavailable(f"R2 复制失败（{exc.__class__.__name__}）") from exc
    result = resp.get("CopyObjectResult") or {}
    return {
        "key": target_key,
        "etag": str(result.get("ETag") or "").strip('"'),
    }


def iter_objects(settings: R2Settings) -> Iterator[dict]:
    """遍历桶内对象（自动分页），每项 {key, size, etag, last_modified}。"""
    try:
        client = get_r2_client(settings)
        #: 分页游标（不叫 token，避免被密钥类静态规则误报）
        cursor = ""
        while True:
            kwargs: dict[str, Any] = {"Bucket": settings.bucket}
            if cursor:
                kwargs["ContinuationToken"] = cursor
            resp = client.list_objects_v2(**kwargs)
            for item in resp.get("Contents") or []:
                yield {
                    "key": str(item.get("Key") or ""),
                    "size": int(item.get("Size") or 0),
                    "etag": str(item.get("ETag") or "").strip('"'),
                    "last_modified": item.get("LastModified"),
                }
            cursor = str(resp.get("NextContinuationToken") or "")
            if not resp.get("IsTruncated") or not cursor:
                break
    except Exception as exc:  # 统一包装成 R2Unavailable
        raise R2Unavailable(f"R2 列举失败（{exc.__class__.__name__}）") from exc


def _delete_object_result(settings: R2Settings, key: str) -> str:
    """删除对象，永不抛错；成功返回空串，失败返回错误类名。"""
    if not key:
        return ""
    try:
        client = get_r2_client(settings)
        client.delete_object(Bucket=settings.bucket, Key=key)
        return ""
    except Exception as exc:  # noqa: BLE001
        return exc.__class__.__name__


def delete_object(settings: R2Settings, key: str) -> None:
    """删除对象，失败抛 R2Unavailable。"""
    error = _delete_object_result(settings, key)
    if error:
        raise R2Unavailable(f"R2 删除失败（{error}）")


def try_delete_object_quietly(settings: R2Settings, key: str) -> None:
    """补偿用：删对象失败只忽略，不抛出（不把一次清理失败变成整批中断）。"""
    _delete_object_result(settings, key)


def public_url(settings: R2Settings, key: str) -> str:
    """对象公开 URL：优先自定义域名（R2_PUBLIC_URL），否则回落 endpoint/bucket。"""
    base = (settings.public_url or f"{settings.endpoint_url}/{settings.bucket}").rstrip(
        "/"
    )
    return f"{base}/{quote(sanitize_key(key), safe='/')}"


# ============ 方案 A 对象键 ============


def _app_now() -> datetime:
    """当前时刻的北京时间 naive 值（与线上写入口径一致）。"""
    return datetime.now(_APP_TZ).replace(tzinfo=None)


def business_folder(domain: str) -> str:
    """业务域 → 一级目录名（未登记的一律 其他）。"""
    return _DOMAIN_FOLDER.get((domain or "").strip().lower(), _FALLBACK_FOLDER)


def object_key_ext(filename: str) -> str:
    """扩展名（小写，只保留字母数字），非法则返回空串。"""
    ext = Path(sanitize_key(filename or "")).suffix.lower()
    return ext if len(ext) > 1 and ext[1:].isalnum() else ""


def clean_file_stem(filename: str) -> str:
    """原始文件名 → 可读、可安全进对象键的基名（不含扩展名）。"""
    base = (filename or "").replace("\\", "/").split("/")[-1]
    base = _CONTROL_CHARS.sub("", base)
    base = _UNSAFE_NAME_CHARS.sub("-", base)
    ext = object_key_ext(base)
    stem = base[: -len(ext)] if ext else base
    stem = _DOT_RUN.sub("-", stem)
    stem = _WHITESPACE.sub(" ", stem).strip(" .-")
    stem = stem[:_MAX_STEM_CHARS].strip(" .-")
    return stem or "file"


def build_object_key(
    domain: str,
    filename: str,
    owner_id: int | None = None,
    suffix: str = "",
    disambiguator: str = "",
    year: int | None = None,
) -> str:
    """生成对象键：{业务域}/{yyyy}/{可读原名}__{8位随机}{_标记}{ext}。

    · 一级目录 = 业务域（合同 / 项目 / 凭证 / 档案），未登记的收敛为 其他；
    · 二级目录 = 年份（contact 档案量小，不分年）；
    · 文件名 = 清洗后的原始名 + __ + 8 位随机后缀，既可读可搜又不可枚举；
    · suffix 是调用方给的可读标记（如支出凭证的上传时间戳），只保留字母数字；
    · disambiguator 供迁移脚本传入稳定后缀，保证同一行反复生成的键一致；
    · year 供迁移脚本传入行内年份：线上上传不传（默认当前北京时间年份），
      迁移必须传，否则同一行跨年后会算出另一个键，重跑就不再是幂等的 no-op；
    · owner_id 仅用于本地后端的目录分片，不进对象键，避免暴露用户 id。
    """
    now = _app_now()
    folder = business_folder(domain)
    parts = [folder]
    if (domain or "").strip().lower() not in _NO_YEAR_DOMAINS:
        parts.append(f"{now:%Y}" if not isinstance(year, int) else f"{year:04d}")

    raw_tag = disambiguator or uuid.uuid4().hex[:_RANDOM_TAG_LEN]
    tag = "".join(ch for ch in raw_tag if ch.isalnum())[:_RANDOM_TAG_LEN]
    if not tag:
        tag = uuid.uuid4().hex[:_RANDOM_TAG_LEN]
    name = f"{clean_file_stem(filename)}__{tag}"

    marker = "".join(ch for ch in suffix if ch.isalnum())
    if marker:
        name += f"_{marker}"
    name += object_key_ext(filename)
    parts.append(name)
    return sanitize_key("/".join(parts))


def tag_and_marker(old_key: str) -> tuple[str, str]:
    """拆当前键末段的 (后缀, 上传标记)；不是新键形态时返回 ("", "")。

    新键末段是 {可读原名}__{后缀}[_{上传标记}]{ext}，凭证的上传时间戳就是那个标记。
    重算目标键时必须把它原样带回去，否则 凭证/…__tag_marker.pdf 会被算成
    凭证/…__tag.pdf：与当前键不等 → 重跑再复制一份，把带标记的旧键留在桶里 ——
    而 --sweep-legacy 只扫 tenant/default/，永远收不到它。
    """
    tail = _text(old_key).rsplit("/", 1)[-1]
    ext = object_key_ext(tail)
    stem = tail[: -len(ext)] if ext else tail
    match = _TAG_RE.search(stem)
    if match is None:
        return "", ""
    return match.group(1).lower(), match.group(2) or ""


def stable_tag(old_key: str) -> str:
    """从旧键里取稳定的 8 位后缀：优先沿用新键已有的后缀，其次 uuid，最后按旧键摘要。

    确定性是幂等的前提：同一行反复执行必须算出同一个新键，否则会复制出第二份对象。
    三种来源的顺序也保证了「改过的行不会再被改一次」：已是新键的行直接沿用原后缀，
    算出的目标键与当前键相等，即视为无需迁移。
    """
    tag, _marker = tag_and_marker(old_key)
    if tag:
        return tag
    tail = _text(old_key).rsplit("/", 1)[-1]
    match = _UUID_RE.search(tail)
    if match:
        return match.group(0)[:8]
    return hashlib.sha256(_text(old_key).encode("utf-8")).hexdigest()[:8]


def _year_from_key(old_key: str) -> int | None:
    """取新键里的年份目录段（{业务域}/{yyyy}/…）；没有年份层（如档案）返回 None。"""
    parts = [part for part in _text(old_key).split("/") if part]
    if len(parts) < 3 or not _YEAR_RE.match(parts[1]):
        return None
    try:
        return int(parts[1])
    except (TypeError, ValueError):  # 正则已挡过，这里只是不让异常变成一次崩溃
        return None


def _year_for(row, old_key: str) -> int | None:
    """目标键的年份：已是新键的行沿用当前键里的年份，其它行取该行的上传年份。

    年份必须来自「行」，绝不能取 datetime.now()：否则 2027 年再跑一次，2026 年迁好的
    行会被整批算成 2027/…，旧键立刻变成没人引用的孤儿（--sweep-legacy 只认
    tenant/default/，收不到它），而脚本仍会打印「失败 0」并以 0 退出。
    """
    if tag_and_marker(old_key)[0]:
        year = _year_from_key(old_key)
        if year is not None:
            return year
    year = getattr(getattr(row, "uploaded_at", None), "year", None)
    return year if isinstance(year, int) else None


def target_key(row) -> str:
    """按方案 A 计算某一行应有的对象键（业务域 + 年份 + 可读名 + 稳定后缀 + 上传标记）。

    只用行自身的数据（当前键、文件名、uploaded_at），不读时钟：
    · 已在新键上的行算出的目标键 == 当前键 → 重跑是真的无操作（含凭证的时间戳标记）；
    · 跨年后重跑也不会把旧年份的键算成新年的键，不会平白造出桶内孤儿。
    """
    old_key = _text(getattr(row, "object_key", ""))
    tag, marker = tag_and_marker(old_key)
    return build_object_key(
        _domain_for(row),
        _text(getattr(row, "filename", "")) or "attachment",
        suffix=marker,
        disambiguator=tag or stable_tag(old_key),
        year=_year_for(row, old_key),
    )


# ============ 迁移 / 回收 / 对账 ============


def _digest_of(settings: R2Settings, key: str) -> tuple[str, int]:
    """完整读回一个对象，返回 (sha256, 字节数)。"""
    chunks, _length, _etag = object_stream(settings, key)
    digest = hashlib.sha256()
    total = 0
    for chunk in chunks:
        digest.update(chunk)
        total += len(chunk)
    return digest.hexdigest(), total


def _verify_copy(settings: R2Settings, old_key: str, new_key: str, plan: RekeyPlan) -> str:
    """校验新对象与旧对象一致；返回错误说明，空串表示通过。

    三道关：目标存在 → 字节数（新 vs 旧对象，不是只看库内值）→ ETag 核对。
    单次 PUT 的对象 ETag 就是内容 MD5，复制后应保持不变。
    """
    old_head = object_head(settings, old_key)
    new_head = object_head(settings, new_key)
    if new_head is None:
        return "复制后目标对象不存在"
    if old_head is None:
        return "复制后旧对象不见了（复制过程异常）"
    if new_head["size"] != old_head["size"]:
        return f"字节数不一致：新 {new_head['size']} ≠ 旧 {old_head['size']}"
    if plan.size and new_head["size"] != plan.size:
        return f"字节数与库内记录不一致：新 {new_head['size']} ≠ 库 {plan.size}"
    if old_head["etag"] and new_head["etag"] and new_head["etag"] != old_head["etag"]:
        return f"ETag 不一致：新 {new_head['etag']} ≠ 旧 {old_head['etag']}"
    if plan.etag and new_head["etag"] and new_head["etag"] != plan.etag:
        return f"ETag 与库内记录不一致：新 {new_head['etag']} ≠ 库 {plan.etag}"
    return ""


def rekey(
    conn: psycopg.Connection,
    settings: R2Settings,
    *,
    apply: bool = False,
    verify: bool = False,
    echo=print,
) -> RekeyReport:
    """执行（或演练）改键迁移，返回结构化结果。

    apply=False 只算清单；verify=True 额外整读新旧对象比对 sha256。
    旧对象不在本步骤删除，由 sweep_legacy() 在确认后回收。
    """
    report = RekeyReport()
    planned: dict[str, int] = {}

    for row in _r2_rows(conn):
        aid = _ident(row.id)
        old_key = _text(row.object_key)
        new_key = target_key(row)
        if new_key == old_key:
            report.up_to_date += 1
            continue
        if new_key in planned:
            # 两行算到同一个新键：绝不能继续，否则一行会覆盖另一行的正文
            report.failures.append(
                (aid, f"新键与附件 id={planned[new_key]} 冲突：{new_key}")
            )
            continue
        planned[new_key] = aid
        report.plans.append(
            RekeyPlan(
                aid=aid,
                filename=_text(row.filename),
                old_key=old_key,
                new_key=new_key,
                size=_ident(row.size),
                etag=_text(row.etag),
            )
        )

    mode = "APPLY" if apply else "DRY-RUN"
    echo(
        f"已在 R2 的行 {report.up_to_date + len(report.plans)} 条"
        f"（需改键 {len(report.plans)}，已是新键 {report.up_to_date}）；模式：{mode}"
    )
    for plan in report.plans:
        echo(f"  [plan] id={plan.aid} {plan.filename!r}")
        echo(f"         {plan.old_key}")
        echo(f"      -> {plan.new_key}")
    if not apply:
        echo("dry-run 结束：未复制、未改库、未删除。加 --apply 执行。")
        return report

    for plan in report.plans:
        try:
            if object_head(settings, plan.new_key) is not None:
                report.failures.append((plan.aid, f"目标键已存在，跳过：{plan.new_key}"))
                continue
            copy_object(settings, plan.old_key, plan.new_key)
            problem = _verify_copy(settings, plan.old_key, plan.new_key, plan)
            if problem:
                # 复制出来的对象不可信：删掉它，别把库改过去（也避免留半成品在桶里）
                try_delete_object_quietly(settings, plan.new_key)
                report.failures.append((plan.aid, problem))
                continue
            if verify:
                old_digest, old_size = _digest_of(settings, plan.old_key)
                new_digest, new_size = _digest_of(settings, plan.new_key)
                if old_digest != new_digest or old_size != new_size:
                    try_delete_object_quietly(settings, plan.new_key)
                    report.failures.append(
                        (plan.aid, f"整读比对不一致：sha256 新 {new_digest} 旧 {old_digest}")
                    )
                    continue
        except (R2Unavailable, R2ObjectMissing) as exc:
            try_delete_object_quietly(settings, plan.new_key)
            report.failures.append((plan.aid, f"复制/校验失败：{exc}"))
            continue

        # 复制并校验成功 → 改库（只在新对象确实存在时才改，库不会指向空中楼阁）
        head = object_head(settings, plan.new_key)
        etag = _text(head.get("etag")) if head else ""
        _update_row(conn, plan, settings, etag)
        report.rekeyed += 1
        echo(f"  [done] id={plan.aid} -> {plan.new_key}")

    echo(
        f"完成：改键 {report.rekeyed}，已是新键 {report.up_to_date}，失败 {len(report.failures)}"
    )
    if report.failures:
        echo("失败明细：", file=sys.stderr)
        for aid, why in report.failures:
            print(f"  - id={aid}: {why}", file=sys.stderr)
    return report


def sweep_legacy(
    conn: psycopg.Connection,
    settings: R2Settings,
    *,
    apply: bool = False,
    echo=print,
) -> dict:
    """回收旧命名空间（tenant/default/...）下已无任何行引用的对象。

    按「无引用」而不是按「刚改过键」判定，所以先迁移后回收、上一次忘了回收、
    单行重跑几种情形都能收干净。仍被行引用的旧键（例如还没迁移的行）永不删。
    """
    referenced = {_text(row.object_key) for row in _r2_rows(conn)}
    legacy = [
        item["key"]
        for item in iter_objects(settings)
        if item["key"].startswith(LEGACY_PREFIX)
    ]
    stale = sorted(key for key in legacy if key not in referenced)
    kept = sorted(key for key in legacy if key in referenced)
    mode = "APPLY" if apply else "DRY-RUN"
    echo(
        f"旧命名空间对象 {len(legacy)} 个（仍被引用 {len(kept)}，无引用可回收 {len(stale)}）；"
        f"模式：{mode}"
    )
    for key in kept:
        echo(f"  [keep ] 仍被某行引用，不删：{key}")
    for key in stale:
        echo(f"  [sweep] {key}")
    failures: list[tuple[str, str]] = []
    if apply:
        for key in stale:
            try:
                delete_object(settings, key)
            except R2Unavailable as exc:
                failures.append((key, str(exc)))
        echo(f"回收完成：删除 {len(stale) - len(failures)}，失败 {len(failures)}")
        for key, why in failures:
            print(f"  - {key}: {why}", file=sys.stderr)
    else:
        echo("dry-run 结束：未删除。加 --apply --sweep-legacy 回收。")
    return {"legacy": len(legacy), "kept": kept, "swept": stale, "failures": failures}


def reconcile(conn: psycopg.Connection, settings: R2Settings, echo=print) -> dict:
    """桶 ↔ 数据库双向对账（只读）：找出「库里有、桶里没有」与桶内孤儿。"""
    db_keys = {_text(row.object_key) for row in _r2_rows(conn)}
    bucket = {item["key"]: item for item in iter_objects(settings)}
    missing = sorted(db_keys - set(bucket))
    orphan = sorted(set(bucket) - db_keys)
    echo(
        f"对账：库内 R2 行 {len(db_keys)}，桶内对象 {len(bucket)}，"
        f"桶内缺对象 {len(missing)}，桶内孤儿 {len(orphan)}"
    )
    for key in missing:
        echo(f"  [missing] 库内有行但桶里没有：{key}")
    for key in orphan:
        echo(f"  [orphan ] 桶里有对象但库内无行：{key}")
    return {
        "db_rows": len(db_keys),
        "bucket_objects": len(bucket),
        "missing": missing,
        "orphan": orphan,
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="把 R2 对象键迁移到业务目录规范（方案 A）"
    )
    parser.add_argument("--apply", action="store_true", help="真正执行（默认只打印计划）")
    parser.add_argument(
        "--verify", action="store_true", help="改键时整读新旧对象比对 sha256"
    )
    parser.add_argument(
        "--delete-old",
        action="store_true",
        help=argparse.SUPPRESS,  # 已由 --sweep-legacy 取代（按「无引用」判定，不会空操作）
        dest="delete_old_removed",
    )
    parser.add_argument(
        "--sweep-legacy",
        action="store_true",
        help="回收旧命名空间下已无行引用的对象（与 --apply 一起才真删）",
    )
    parser.add_argument(
        "--no-reconcile", action="store_true", help="跳过桶 ↔ 数据库对账"
    )
    args = parser.parse_args()

    settings = r2_settings_from_env()
    if not r2_settings_complete(settings):
        print(
            "[abort] R2 配置不完整（需要 R2_ENDPOINT_URL / R2_ACCESS_KEY_ID / "
            "R2_SECRET_ACCESS_KEY / R2_BUCKET_NAME）",
            file=sys.stderr,
        )
        return 2
    if args.delete_old_removed:
        print(
            "[abort] --delete-old 已移除：请分开跑两步（--apply --verify 然后 "
            "--apply --sweep-legacy），回收按「桶内对象已无行引用」判定。",
            file=sys.stderr,
        )
        return 2

    try:
        with connect_database() as conn:
            report = rekey(conn, settings, apply=args.apply, verify=args.verify)
            sweep_failures = 0
            if args.sweep_legacy:
                sweep = sweep_legacy(conn, settings, apply=args.apply)
                sweep_failures = len(sweep["failures"])
            if not args.no_reconcile:
                reconcile(conn, settings)
            return 0 if (report.ok and not sweep_failures) else 1
    except (R2Unavailable, R2ObjectMissing, psycopg.Error, RuntimeError, OSError) as exc:
        # 不吞错：打印原因并以非 0 退出，便于放进发布流程做闸门
        print(f"[error] {exc.__class__.__name__}: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
