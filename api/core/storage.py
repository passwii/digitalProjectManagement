"""附件存储抽象：本地磁盘 / Cloudflare R2 双后端，一个上传入口。

定位
----
`Attachment` 是**控制面**（谁能传、归属谁、多大、什么类型），二进制正文是**数据面**。
本模块把「写字节 / 取字节 / 删字节」收敛到一个 `StorageBackend` 协议，
业务 router 不再关心正文落在磁盘还是 R2。

后端选择
--------
`STORAGE_BACKEND` 取 `auto`（默认）/ `local` / `r2`：

  · `auto`：R2 配置齐全 → R2；否则回落本地磁盘。保证「没配对象存储也能起服务」，
    本地开发与 CI 不需要 R2 凭据。
  · `r2`  ：强制 R2；配置不全直接报错，避免「以为在用 R2、其实写到容器磁盘」。
  · `local`：强制本地（离线演示、回滚开关）。

元数据落库
----------
`Attachment.path` 与新增的 `storage_backend` / `object_key` / `etag` 一起记录正文位置：

  · 本地后端：`path` = 磁盘绝对路径，`object_key` 留空；
  · R2 后端：`path` = 对象公开 URL（人可读、便于排查），`object_key` = 真实对象键。

对象键命名遵循 README §5.3 的「不可猜测 + 可审计」要求：
`tenant/default/{domain}/{yyyy}/{mm}/{uuid}.{ext}`（domain 例如 project / expense / contact）。
"""

from __future__ import annotations

import os
import uuid
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Protocol

from .database import ROOT
from .r2 import (
    CHUNK_SIZE,
    R2ObjectMissing,
    R2Settings,
    R2Unavailable,
    delete_object,
    object_exists,
    object_stream,
    presign_get_url,
    public_url,
    sanitize_key,
    try_delete_object,
    upload_object,
)

__all__ = [
    "BACKEND_LOCAL",
    "BACKEND_R2",
    "FILES_ROOT",
    "LocalBackend",
    "R2Backend",
    "StoredObject",
    "build_object_key",
    "get_backend",
    "get_storage_settings",
    "resolve_backend_name",
    "storage_enabled",
    "storage_profile",
]

BACKEND_LOCAL = "local"
BACKEND_R2 = "r2"

#: 本地后端根目录（与既有 `data/files` 布局一致，存量附件无需搬迁）
FILES_ROOT = ROOT / "data" / "files"

#: 允许的 key 前缀（防止 domain 参数被拼成 `../` 之类的越界路径）
_ALLOWED_DOMAIN = {"project", "contract", "expense", "contact"}


@dataclass(frozen=True)
class StoredObject:
    """一次落盘/上传的结果，直接映射到 `Attachment` 的存储字段。"""

    backend: str
    path: str  # 本地：磁盘路径；R2：公开 URL
    object_key: str  # 本地：空；R2：对象键
    size: int
    etag: str


class StorageBackend(Protocol):
    """存储后端协议（两个实现：本地磁盘 / R2）。"""

    name: str

    def put(
        self, data: bytes, key: str, local_path: Path, content_type: str
    ) -> StoredObject:
        """写入正文，返回可落库的存储坐标。"""
        ...

    def stream(self, object_key: str, local_path: str) -> tuple[Iterator[bytes], int]:
        """打开读取流，返回 `(分块迭代器, 字节数)`；对象不存在抛 `R2ObjectMissing`。"""
        ...

    def delete(self, object_key: str, local_path: str) -> None:
        """删除正文；失败抛 `R2Unavailable`（调用方据此决定是否保留元数据）。"""
        ...

    def exists(self, object_key: str, local_path: str) -> bool:
        """正文是否仍可读（用于区分「文件丢失」与「R2 不可用」）。"""
        ...

    def url_for(self, object_key: str, local_path: str) -> str:
        """正文的可读 URL；本地后端返回空串（只能经 API 代理下载）。"""
        ...


@dataclass(frozen=True)
class _Settings:
    """存储相关配置快照（每次调用重新读取，环境变量变更即时生效）。"""

    backend: str
    r2: R2Settings | None
    presign_ttl: int


def _env(name: str, default: str = "") -> str:
    return (os.getenv(name) or "").strip() or default


def get_storage_settings() -> _Settings:
    """解析 `STORAGE_BACKEND` 与 `R2_*` 配置（单一来源：环境变量，见 .env.docker.example）。"""
    r2 = R2Settings(
        endpoint_url=_env("R2_ENDPOINT_URL"),
        access_key_id=_env("R2_ACCESS_KEY_ID"),
        secret_access_key=_env("R2_SECRET_ACCESS_KEY"),
        bucket=_env("R2_BUCKET_NAME"),
        region=_env("R2_REGION", "auto"),
        public_url=_env("R2_PUBLIC_URL"),
    )
    complete = bool(
        r2.endpoint_url and r2.access_key_id and r2.secret_access_key and r2.bucket
    )
    requested = _env("STORAGE_BACKEND", "auto").lower()
    if requested == BACKEND_R2 and not complete:
        raise RuntimeError(
            "STORAGE_BACKEND=r2 但 R2 配置不完整（需要 R2_ENDPOINT_URL / R2_ACCESS_KEY_ID / "
            "R2_SECRET_ACCESS_KEY / R2_BUCKET_NAME）"
        )
    backend = (
        BACKEND_R2
        if (requested == BACKEND_R2 or (requested == "auto" and complete))
        else BACKEND_LOCAL
    )
    try:
        ttl = int(_env("R2_PRESIGN_TTL_SECONDS", "3600"))
    except ValueError:
        ttl = 3600
    return _Settings(
        backend=backend,
        r2=r2 if backend == BACKEND_R2 else None,
        presign_ttl=max(ttl, 60),
    )


def resolve_backend_name() -> str:
    """当前生效的后端名（`local` / `r2`）——健康检查与响应体用。"""
    return get_storage_settings().backend


def storage_enabled() -> bool:
    """是否已切到对象存储（供 `/health` 与文档展示）。"""
    return resolve_backend_name() == BACKEND_R2


def storage_profile() -> dict[str, object]:
    """可对外的存储画像（**不含任何密钥**）。"""
    settings = get_storage_settings()
    profile: dict[str, object] = {"backend": settings.backend}
    if settings.r2 is not None:
        profile["bucket"] = settings.r2.bucket
        profile["endpoint_configured"] = bool(settings.r2.endpoint_url)
        profile["public_url_configured"] = bool(settings.r2.public_url)
    return profile


def build_object_key(
    domain: str, filename: str, owner_id: int | None = None, suffix: str = ""
) -> str:
    """生成对象键：`tenant/default/{domain}/{yyyy}/{mm}/{uuid}{suffix}{ext}`。

    · domain 走白名单，非法值收敛为 `other`，绝不把调用方字符串直接拼成路径；
    · 文件名只取扩展名，原始名留在 `Attachment.filename`，避免中文/空格/`..` 进 key；
    · `owner_id` 仅用于**本地后端**的目录分片（便于排查），不进对象键，避免暴露用户 id。
    """
    safe_domain = domain if domain in _ALLOWED_DOMAIN else "other"
    now = datetime.now(timezone.utc)
    ext = Path(sanitize_key(filename or "")).suffix.lower()
    # 扩展名再过滤一次：只保留 `.` + 字母数字，杜绝 `..` / 斜杠进入 key
    ext = ext if len(ext) > 1 and ext[1:].isalnum() else ""
    # 可读后缀（如支出凭证的时间戳）统一加下划线，并只保留字母数字
    tag = "".join(ch for ch in suffix if ch.isalnum())
    tag = f"_{tag}" if tag else ""
    key = f"tenant/default/{safe_domain}/{now:%Y}/{now:%m}/{uuid.uuid4().hex}{tag}{ext}"
    return sanitize_key(key)


def local_path_for(
    domain: str, filename: str, object_key: str, owner_id: int | None = None
) -> Path:
    """本地后端的目标路径：`data/files/{domain}/{owner?}/{uuid}{ext}`（与既有布局同构）。"""
    parts = [FILES_ROOT, domain if domain in _ALLOWED_DOMAIN else "other"]
    if owner_id is not None:
        parts.append(str(owner_id))
    ext = Path(object_key).suffix
    parts.append(f"{uuid.uuid4().hex}{ext}")
    return Path(*parts)


class LocalBackend:
    """本地磁盘后端：行为与接入 R2 之前完全一致（`data/files` 落盘）。"""

    name = BACKEND_LOCAL

    def put(
        self, data: bytes, key: str, local_path: Path, content_type: str
    ) -> StoredObject:
        import hashlib

        local_path.parent.mkdir(parents=True, exist_ok=True)
        local_path.write_bytes(data)
        return StoredObject(
            backend=self.name,
            path=str(local_path),
            object_key="",
            size=len(data),
            etag=hashlib.sha256(data).hexdigest(),
        )

    def stream(self, object_key: str, local_path: str) -> tuple[Iterator[bytes], int]:
        path = Path(local_path)
        if not path.exists():
            raise R2ObjectMissing(local_path)

        size = path.stat().st_size

        def _chunks() -> Iterator[bytes]:
            with path.open("rb") as fh:
                while True:
                    chunk = fh.read(CHUNK_SIZE)
                    if not chunk:
                        break
                    yield chunk

        return _chunks(), size

    def delete(self, object_key: str, local_path: str) -> None:
        if local_path:
            Path(local_path).unlink(missing_ok=True)

    def exists(self, object_key: str, local_path: str) -> bool:
        return bool(local_path) and Path(local_path).exists()

    def url_for(self, object_key: str, local_path: str) -> str:
        return ""


class R2Backend:
    """Cloudflare R2 后端：正文写入对象存储，数据库只留 key 与 URL。"""

    name = BACKEND_R2

    def __init__(self, settings: R2Settings, presign_ttl: int = 3600):
        self._settings = settings
        self._presign_ttl = presign_ttl

    def put(
        self, data: bytes, key: str, local_path: Path, content_type: str
    ) -> StoredObject:
        uploaded = upload_object(
            self._settings, data, key, content_type or "application/octet-stream"
        )
        return StoredObject(
            backend=self.name,
            path=public_url(self._settings, uploaded["key"]),
            object_key=uploaded["key"],
            size=uploaded["size"],
            etag=uploaded["etag"],
        )

    def stream(self, object_key: str, local_path: str) -> tuple[Iterator[bytes], int]:
        chunks, length, _etag = object_stream(self._settings, object_key)
        return chunks, length

    def delete(self, object_key: str, local_path: str) -> None:
        if object_key:
            delete_object(self._settings, object_key)

    def exists(self, object_key: str, local_path: str) -> bool:
        return bool(object_key) and object_exists(self._settings, object_key)

    def url_for(self, object_key: str, local_path: str) -> str:
        return public_url(self._settings, object_key) if object_key else ""

    def presign(self, object_key: str) -> str:
        """签发短期直读 URL（私有桶场景；公开读的桶用 `url_for`）。"""
        return presign_get_url(self._settings, object_key, self._presign_ttl)


def get_backend() -> StorageBackend:
    """按当前配置返回后端实例（无全局可变状态，环境变量变更即时生效）。"""
    settings = get_storage_settings()
    if settings.backend == BACKEND_R2 and settings.r2 is not None:
        return R2Backend(settings.r2, presign_ttl=settings.presign_ttl)
    return LocalBackend()


def try_delete_object_quietly(object_key: str) -> None:
    """补偿用：删对象失败只记录，不抛出（供业务事务失败后的清理调用）。"""
    settings = get_storage_settings()
    if settings.backend != BACKEND_R2 or settings.r2 is None or not object_key:
        return
    try_delete_object(settings.r2, object_key)


__all__ += ["R2ObjectMissing", "R2Unavailable", "try_delete_object_quietly"]
