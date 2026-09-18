"""Cloudflare R2（S3 兼容）传输层。

架构定位（README §5）：PostgreSQL 是附件 **控制面**，Cloudflare R2 是 **二进制数据面**。
本模块只负责「按 key 传字节 / 取字节 / 判存在 / 删对象 / 造 URL」，业务语义
（谁能传、传什么、落哪张表）留在 `api/core/storage.py` 与各 router。

约定
----
· **单例客户端按配置指纹缓存**：`R2_*` 环境变量变化（本地调试、测试注入）会自动重建，
  不靠进程重启，也不会把旧凭据继续用下去。
· **删除永不抛错**：`try_delete_object()` 返回结构化 `R2DeleteResult`，调用方（或补偿逻辑）
  可以安全地在事务收尾阶段调用；`delete_object()` 是它的抛错版本，仅供需要「删不掉就别删库」的入口。
· **boto3 延迟导入**：仅使用本地存储（`STORAGE_BACKEND=local`）时不依赖 boto3 也能启动。
· 传输失败统一包装成 `R2Unavailable` / `R2ObjectMissing`，不把 botocore 异常泄漏到 router。
"""
from __future__ import annotations

import io
import re
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any, BinaryIO

__all__ = [
    "CHUNK_SIZE",
    "R2DeleteResult",
    "R2ObjectMissing",
    "R2Settings",
    "R2Unavailable",
    "build_client",
    "close_clients",
    "delete_object",
    "get_r2_client",
    "object_exists",
    "object_stream",
    "presign_get_url",
    "public_url",
    "sanitize_key",
    "try_delete_object",
    "upload_object",
]

#: 下载分块大小：1MB —— 100MB 附件不会一次性进内存。
CHUNK_SIZE = 1024 * 1024


class R2Unavailable(RuntimeError):
    """R2 不可用（网络 / 凭据 / 桶不存在 / 5xx）。router 层转 502/500。"""


class R2ObjectMissing(RuntimeError):
    """对象不存在（404 / NoSuchKey）。router 层转「文件已丢失」。"""


@dataclass(frozen=True)
class R2Settings:
    """R2 连接参数（由 `storage.get_storage_settings()` 注入，本模块不读环境变量）。"""

    endpoint_url: str
    access_key_id: str
    secret_access_key: str
    bucket: str
    region: str = "auto"
    public_url: str = ""

    def fingerprint(self) -> tuple[str, str, str, str, str]:
        """客户端缓存键：任一项变化即重建客户端。"""
        return (self.endpoint_url, self.access_key_id, self.secret_access_key,
                self.bucket, self.region or "auto")


@dataclass(frozen=True)
class R2DeleteResult:
    """删除的结构化结果。

    `success=True`：对象已删除或本来就不存在（幂等）。
    `success=False`：`error_class` / `error_message` 给出原因，调用方可决定重试或保留元数据。
    """

    success: bool
    key: str
    error_class: str | None = None
    error_message: str | None = None


_CLIENTS: dict[tuple, Any] = {}


def build_client(settings: R2Settings):
    """真正构造 boto3 S3 客户端（测试通过替换本函数注入内存实现）。"""
    import boto3  # 延迟导入：local 后端不需要 boto3
    from botocore.config import Config

    return boto3.client(
        "s3",
        endpoint_url=settings.endpoint_url,
        aws_access_key_id=settings.access_key_id,
        aws_secret_access_key=settings.secret_access_key,
        region_name=settings.region or "auto",
        # R2 只支持 SigV4，且路径风格必须显式开启（默认 virtual-host 会被拒）
        config=Config(signature_version="s3v4", s3={"addressing_style": "path"},
                      retries={"max_attempts": 3, "mode": "standard"}),
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
    """丢弃缓存的客户端（测试清理；也可用于凭据轮转后强制重建）。"""
    _CLIENTS.clear()


_CONTROL_CHARS = re.compile(r"[\x00-\x1f\x7f]")
_WHITESPACE = re.compile(r"\s+")


def sanitize_key(key: str) -> str:
    """清洗对象键：S3 键允许 Unicode（中文会被 URL 编码），只去掉控制字符并归一空白。"""
    if not key:
        return ""
    cleaned = _CONTROL_CHARS.sub("", key)
    cleaned = _WHITESPACE.sub(" ", cleaned)
    return cleaned.strip()


def _boto_errors():
    from botocore.exceptions import BotoCoreError, ClientError

    return ClientError, BotoCoreError


def _is_missing(exc) -> bool:
    """判定「对象不存在」，与「R2 不可用」区分开（前者 404，后者 502）。"""
    response = getattr(exc, "response", None) or {}
    code = str(response.get("Error", {}).get("Code", ""))
    status = (response.get("ResponseMetadata", {}) or {}).get("HTTPStatusCode")
    return code in {"NoSuchKey", "NoSuchBucket", "404"} or status == 404


def upload_object(settings: R2Settings, data: bytes, key: str,
                  content_type: str = "application/octet-stream") -> dict:
    """上传一段字节，返回 `{key, bucket, etag, size}`。

    上传前已由 `core.limits` 做体积上限校验，因此单次 PUT 足够（≤100MB，未触及 5GB 上限）。
    """
    import hashlib

    client = get_r2_client(settings)
    try:
        resp = client.put_object(Bucket=settings.bucket, Key=key, Body=data,
                                 ContentType=content_type or "application/octet-stream")
    except Exception as exc:
        raise R2Unavailable(f"R2 上传失败（{exc.__class__.__name__}）") from exc
    etag = str(resp.get("ETag") or "").strip('"')
    if not etag:
        # 某些兼容实现不回 ETag：用内容摘要兜底，保证元数据里有可核对指纹。
        etag = hashlib.sha256(data).hexdigest()
    return {"key": key, "bucket": settings.bucket, "etag": etag, "size": len(data)}


def object_stream(settings: R2Settings, key: str) -> tuple[Iterator[bytes], int, str]:
    """打开对象读取流，返回 `(分块迭代器, 字节数, etag)`。

    对象不存在抛 `R2ObjectMissing`；其他失败抛 `R2Unavailable`。
    迭代器消费完/关闭时会释放底层连接。
    """
    client = get_r2_client(settings)
    try:
        resp = client.get_object(Bucket=settings.bucket, Key=key)
    except Exception as exc:
        if _is_missing(exc):
            raise R2ObjectMissing(key) from exc
        raise R2Unavailable(f"R2 读取失败（{exc.__class__.__name__}）") from exc

    body: BinaryIO = resp["Body"]
    raw_length = resp.get("ContentLength")
    try:
        # ContentLength 由远端返回，可能是 None / 非数字字符串 —— 解析失败按 0 处理，
        # 调用方只用它填 Content-Length 头，真实的字节流仍由分块迭代器决定。
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


def object_exists(settings: R2Settings, key: str) -> bool:
    """对象是否存在（HEAD）。不存在返回 False；R2 不可用抛 `R2Unavailable`。"""
    client = get_r2_client(settings)
    try:
        client.head_object(Bucket=settings.bucket, Key=key)
        return True
    except Exception as exc:
        if _is_missing(exc):
            return False
        raise R2Unavailable(f"R2 HEAD 失败（{exc.__class__.__name__}）") from exc


def try_delete_object(settings: R2Settings, key: str) -> R2DeleteResult:
    """删除对象，**永不抛错**，返回结构化结果（可被试运行/补偿逻辑安全调用）。"""
    if not key:
        return R2DeleteResult(success=True, key="")
    client = get_r2_client(settings)
    try:
        client.delete_object(Bucket=settings.bucket, Key=key)
        return R2DeleteResult(success=True, key=key)
    except Exception as exc:  # noqa: BLE001
        return R2DeleteResult(success=False, key=key,
                              error_class=exc.__class__.__name__, error_message=str(exc))


def delete_object(settings: R2Settings, key: str) -> None:
    """删除对象，失败抛 `R2Unavailable`。

    供「删不掉就不要删数据库行」的入口使用（否则 R2 上会留下无人追踪的对象）。
    """
    result = try_delete_object(settings, key)
    if not result.success:
        raise R2Unavailable(f"R2 删除失败（{result.error_class}）")


def public_url(settings: R2Settings, key: str) -> str:
    """对象公开 URL：优先自定义域名（`R2_PUBLIC_URL`），否则回落 endpoint/bucket。

    key 做 percent-encoding 且保留 `/`，中文文件名不会破坏 URL。
    """
    from urllib.parse import quote

    base = (settings.public_url or f"{settings.endpoint_url}/{settings.bucket}").rstrip("/")
    return f"{base}/{quote(sanitize_key(key), safe='/')}"


def presign_get_url(settings: R2Settings, key: str, expires_in: int = 3600) -> str:
    """签发短期 GET 预签名 URL（私有桶直读，不经 API 代理）。"""
    client = get_r2_client(settings)
    try:
        return client.generate_presigned_url(
            "get_object",
            Params={"Bucket": settings.bucket, "Key": key},
            ExpiresIn=expires_in,
        )
    except Exception as exc:
        raise R2Unavailable(f"R2 预签名失败（{exc.__class__.__name__}）") from exc


def bytes_io(data: bytes) -> io.BytesIO:
    """小工具：把 bytes 包成文件对象（供 upload_fileobj 风格的调用方复用）。"""
    return io.BytesIO(data)
