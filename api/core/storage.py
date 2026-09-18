"""附件存储抽象：Cloudflare R2（唯一持久化口径）+ 本地临时暂存（仅开发/测试）。

定位
----
`Attachment` 是**控制面**（谁能传、归属谁、多大、什么类型），二进制正文是**数据面**。
本模块把「写字节 / 取字节 / 删字节」收敛到一个 `StorageBackend` 协议，
业务 router 不再关心正文落在磁盘还是 R2。

唯一事实口径（重要）
--------------------
**R2 是附件正文唯一的持久化存储**。服务器磁盘只允许在上传途中「短暂停留」
（`UploadFile` 的 spool 文件、内存缓冲），任何代码路径都不允许把正文落盘持久化：

  · `r2`（默认）：新写入强制走 R2；`R2_*` 配置不全 → **启动即失败**，
    绝不「以为在用 R2、其实写进容器磁盘」。
  · `auto`：`R2_*` 配齐就用 R2；配不齐 → **启动即失败**（不再静默回落本地盘）。
    静默回落会让正文只存在容器磁盘上、重建即丢，与「R2 是唯一口径」直接矛盾。
  · `local`：**仅开发/测试**显式可用。正文写进 `local_staging_root()` 指定的
    **临时暂存目录**（默认系统临时目录），不是持久卷；`APP_ENV=production` 时
    该取值直接被拒绝，因此生产环境不可能把正文写到 VPS 磁盘。

本地后端的落点另有硬校验：**不允许落在应用目录内**（`ROOT`，容器里即 `/app`，
含 `data` 持久卷）。「VPS 不落盘」因此不是靠约定，而是配置一错就起不来。

读旧的、写新的（重要）
----------------------
正文的**读取与删除永远按行**（`Attachment.storage_backend` + `object_key` + `path`）
选后端，只有**新写入**才看 `STORAGE_BACKEND`。因此有两个入口：

  · `get_backend_for_row(row)` —— 读写某个已存在的附件，后端与行内坐标严格一致；
  · `get_backend()` —— 新上传/回填用，按全局 `STORAGE_BACKEND` 解析。

若两者不一致（典型场景：`STORAGE_BACKEND` 从 `r2` 改回 `local` 做演示、或本地开发
连的是生产库），任何按「当前配置」去读/删 R2 行的做法都会退化成 404 + 漏删。
所以行级后端不受全局开关影响，全局开关只改新写入的落点。

元数据落库
----------
`Attachment.path` 与新增的 `storage_backend` / `object_key` / `etag` 一起记录正文位置：

  · 本地后端：`path` = 磁盘绝对路径，`object_key` 留空；
  · R2 后端：`path` = 对象公开 URL（人可读、便于排查），`object_key` = 真实对象键。

切换 `STORAGE_BACKEND=r2` 之前请先跑 `validate_storage_settings()`
（`api.main` 的 lifespan 已调用；脚本可单独调用），避免「进程绿着起来、每个请求才炸」。

对象键命名遵循 README §5.3 的「业务可读 + 不可枚举」要求（方案 A，2026-09-18 与用户确认）：

    {业务域}/{yyyy}/{可读原名}__{8位随机}.{ext}      # 合同 / 项目 / 凭证
    {业务域}/{可读原名}__{8位随机}.{ext}             # 档案（量小，不分年）

一级目录 = 业务域（`合同` / `项目` / `凭证` / `档案`），在 R2 控制台里直接可读；
二级目录 = 年份（分片，避免单目录无限膨胀）；文件名 = 清洗后的原始名 + 随机后缀，
既可读可搜、又不可枚举。读取永远按**行内 `object_key`**，不解析路径，
所以迁移期间新旧键并存不会出现 404。
"""

from __future__ import annotations

import logging
import os
import re
import tempfile
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
    "STAGING_ROOT",
    "LocalBackend",
    "R2Backend",
    "StoredObject",
    "backend_for_row_coords",
    "build_object_key",
    "business_folder",
    "clean_file_stem",
    "get_backend",
    "get_backend_for_row",
    "get_storage_settings",
    "local_staging_root",
    "object_key_ext",
    "r2_settings_complete",
    "r2_settings_from_env",
    "resolve_backend_name",
    "resolve_backend_name_from",
    "storage_enabled",
    "storage_profile",
    "validate_storage_settings",
]

logger = logging.getLogger(__name__)

BACKEND_LOCAL = "local"
BACKEND_R2 = "r2"

#: 本地后端的默认落点：**系统临时目录下的暂存目录，不是持久卷**。
#: 可用 `STORAGE_LOCAL_ROOT` 覆盖，但覆盖值不许落在应用目录内（见 `local_staging_root()`）。
STAGING_ROOT = Path(tempfile.gettempdir()) / "pm-attachment-staging"

#: 业务域（API 层 domain）→ 一级目录名。**一级目录就是业务**，控制台里直接可读。
#: 未登记的 domain 一律收敛为 `其他`，绝不把调用方字符串直接拼成路径。
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
#: 连续的点（`..`）不留在对象键里：看起来像路径穿越，排查时也是噪声
_DOT_RUN = re.compile(r"\.{2,}")

#: 视为生产环境的 `APP_ENV` 取值（生产环境禁止本地后端）
_PRODUCTION_ENVS = {"prod", "production"}


def _is_within(path: Path, parent: Path) -> bool:
    """`path` 是否就是 `parent`，或位于 `parent` 之下。"""
    return path == parent or parent in path.parents


def local_staging_root() -> Path:
    """本地后端的落点（每次调用重新读环境变量，便于测试注入）。

    默认 `STAGING_ROOT`（系统临时目录）。**必须落在应用目录之外**：应用目录在容器里
    就是 `/app`（含 `data` 持久卷），正文落进去就等于「在 VPS 上持久化」，与
    「R2 是唯一事实口径」矛盾，所以这里直接报错而不是警告。
    """
    raw = _env("STORAGE_LOCAL_ROOT")
    root = Path(raw).expanduser() if raw else STAGING_ROOT
    if not root.is_absolute():
        root = ROOT / root
    app_root = ROOT.resolve()
    try:
        resolved = root.resolve()
    except OSError:  # pragma: no cover - 极端文件系统错误
        resolved = root
    if _is_within(resolved, app_root):
        raise RuntimeError(
            f"STORAGE_LOCAL_ROOT 不能指向应用目录（{app_root}）：本地后端只是上传途中的"
            "临时暂存，附件正文的唯一持久化口径是 R2，不允许写进应用数据卷。"
        )
    return resolved


def _is_production() -> bool:
    """是否生产环境（`APP_ENV`，默认 `development`）。"""
    return _env("APP_ENV", "development").lower() in _PRODUCTION_ENVS


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


def r2_settings_from_env() -> R2Settings:
    """从环境变量读取 R2 连接参数（线上服务、行级后端、迁移脚本共用同一处解析）。"""
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


def get_storage_settings() -> _Settings:
    """解析 `STORAGE_BACKEND` 与 `R2_*` 配置（单一来源：环境变量，见 .env.docker.example）。

    这里定义「什么情况下进程可以起来」，是「R2 是附件正文唯一持久化口径」的执行点：
    任何会让正文落到服务器磁盘的配置组合（缺凭据的 `r2` / `auto`、生产环境的 `local`）
    都在这里直接抛错，而不是回落本地盘。
    """
    r2 = r2_settings_from_env()
    complete = r2_settings_complete(r2)
    requested = _env("STORAGE_BACKEND", BACKEND_R2).lower()
    if requested not in {"auto", BACKEND_LOCAL, BACKEND_R2}:
        raise RuntimeError(
            f"STORAGE_BACKEND 取值无法识别：{requested!r}（只支持 r2 / auto / local）"
        )
    if requested == BACKEND_R2 and not complete:
        raise RuntimeError(
            "STORAGE_BACKEND=r2 但 R2 配置不完整（需要 R2_ENDPOINT_URL / R2_ACCESS_KEY_ID / "
            "R2_SECRET_ACCESS_KEY / R2_BUCKET_NAME）"
        )
    if requested == "auto" and not complete:
        raise RuntimeError(
            "STORAGE_BACKEND=auto 但 R2 配置不完整（缺 "
            f"{_missing_r2_fields(r2)}）：R2 是附件正文唯一的持久化口径，不回落本地磁盘。"
            "本地开发请显式设 STORAGE_BACKEND=local（正文只写临时暂存目录，不持久化）。"
        )
    backend = (
        BACKEND_R2
        if (requested == BACKEND_R2 or (requested == "auto" and complete))
        else BACKEND_LOCAL
    )
    if backend == BACKEND_LOCAL:
        if _is_production():
            raise RuntimeError(
                f"APP_ENV={_env('APP_ENV')} 下不允许 STORAGE_BACKEND={requested}："
                "R2 是附件正文唯一的持久化口径，生产环境必须配置 R2_* 并设 "
                "STORAGE_BACKEND=r2。"
            )
        # 只报落点与变量名，**绝不回显密钥**。
        logger.warning(
            "附件正文使用本地临时暂存目录（%s）：仅限开发/测试，重启或临时目录清理后"
            "即消失，不是持久化存储。",
            local_staging_root(),
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


def _presign_ttl() -> int:
    """预签名 TTL（行级后端不依赖 `STORAGE_BACKEND`，单独解析一次）。"""
    try:
        ttl = int(_env("R2_PRESIGN_TTL_SECONDS", "3600"))
    except ValueError:
        ttl = 3600
    return max(ttl, 60)


def _missing_r2_fields(r2: R2Settings) -> str:
    """列出缺失的 R2 必填项（只报变量名，**绝不回显值**）。"""
    required = {
        "R2_ENDPOINT_URL": r2.endpoint_url,
        "R2_ACCESS_KEY_ID": r2.access_key_id,
        "R2_SECRET_ACCESS_KEY": r2.secret_access_key,
        "R2_BUCKET_NAME": r2.bucket,
    }
    return ", ".join(name for name, value in required.items() if not value) or "未设置"


def validate_storage_settings() -> _Settings:
    """启动期校验：配置与 `STORAGE_BACKEND` 自相矛盾时立刻抛错，不让进程绿着起来。

    由 `get_storage_settings()` 抛出的错误包括：`r2`/`auto` 强制模式下 `R2_*` 不全、
    生产环境选本地后端、本地落点落在应用目录内。调用点见 `api.main` 的 lifespan。
    """
    return get_storage_settings()


def resolve_backend_name() -> str:
    """按 `STORAGE_BACKEND` 解析出的**新写入**后端名（`local` / `r2`）。"""
    return get_storage_settings().backend


def resolve_backend_name_from(
    row_backend: str, path: str = "", object_key: str = ""
) -> str:
    """按**某一行的坐标**解析后端名（读/删必须用这个，不能用全局开关）。

    规则与 `attachments._row_coords()` 完全一致，两处不得各自演化：

      · `storage_backend` 为空 → 存量行，按本地磁盘；
      · `storage_backend='local'` 但 `path` 是 http(s) URL 或有 `object_key`
        → 迁移过程中的行，按 R2（`path` 是 URL，不能当磁盘路径用）；
      · 其余按行内 `storage_backend` 取值。

    无法识别的取值**明确报错**，不静默降级成本地 —— 否则一个笔误的
    `storage_backend` 就会变成「对象漏删 + 下载 404」。
    """
    declared = (row_backend or "").strip().lower()
    key = (object_key or "").strip()
    location = (path or "").strip()
    if declared in ("", BACKEND_LOCAL) and (
        key or location.startswith(("http://", "https://"))
    ):
        return BACKEND_R2
    if declared in ("", BACKEND_LOCAL):
        return BACKEND_LOCAL
    if declared == BACKEND_R2:
        return BACKEND_R2
    raise RuntimeError(
        f"附件行的存储后端无法识别：{row_backend!r}（只支持 local / r2；"
        "请修正数据或补上对应后端实现，勿静默按本地磁盘处理）"
    )


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


def business_folder(domain: str) -> str:
    """业务域 → 一级目录名（未登记的一律 `其他`）。"""
    return _DOMAIN_FOLDER.get((domain or "").strip().lower(), _FALLBACK_FOLDER)


def clean_file_stem(filename: str) -> str:
    """原始文件名 → 可读、可安全进对象键的基名（不含扩展名）。

    · 先取 basename：正斜杠与反斜杠都当分隔符，`../x.pdf` 只剩 `x`；
    · 去掉控制字符，把对象键/系统保留字符换成 `-`；
    · 保留中文与空格（便于控制台搜索），空白归一、首尾的点/横线/空格去掉；
    · 限长 `_MAX_STEM_CHARS`，截断后仍为空则回落 `file`（不产生空名键）。
    """
    base = (filename or "").replace("\\", "/").split("/")[-1]
    base = _CONTROL_CHARS.sub("", base)
    base = _UNSAFE_NAME_CHARS.sub("-", base)
    ext = object_key_ext(base)
    stem = base[: -len(ext)] if ext else base
    stem = _DOT_RUN.sub("-", stem)
    stem = _WHITESPACE.sub(" ", stem).strip(" .-")
    stem = stem[:_MAX_STEM_CHARS].strip(" .-")
    return stem or "file"


def object_key_ext(filename: str) -> str:
    """扩展名（小写，只保留字母数字），非法则返回空串。

    只保留 `.` + 字母数字，杜绝 `..` / 路径分隔符之类的字符进入对象键。
    """
    ext = Path(sanitize_key(filename or "")).suffix.lower()
    return ext if len(ext) > 1 and ext[1:].isalnum() else ""


def build_object_key(
    domain: str,
    filename: str,
    owner_id: int | None = None,
    suffix: str = "",
    disambiguator: str = "",
) -> str:
    """生成对象键：`{业务域}/{yyyy}/{可读原名}__{8位随机}{_标记}{ext}`。

    · 一级目录 = 业务域（`合同` / `项目` / `凭证` / `档案`），未登记的收敛为 `其他`；
    · 二级目录 = 年份（`contact` 档案量小，不分年）；
    · 文件名 = 清洗后的原始名 + `__` + 8 位随机后缀，既可读可搜又不可枚举；
    · `suffix` 是调用方给的可读标记（如支出凭证的上传时间戳），只保留字母数字；
    · `disambiguator` 供迁移脚本传入**稳定**后缀，保证同一行反复生成的键一致；
    · 原始名仍完整保存在 `Attachment.filename`，键里的名字只是检索线索；
    · `owner_id` 仅用于**本地后端**的目录分片（便于排查），不进对象键，避免暴露用户 id。
    """
    now = datetime.now(timezone.utc)
    folder = business_folder(domain)
    parts = [folder]
    if (domain or "").strip().lower() not in _NO_YEAR_DOMAINS:
        parts.append(f"{now:%Y}")

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


def local_path_for(
    domain: str, filename: str, object_key: str, owner_id: int | None = None
) -> Path:
    """本地后端的目标路径：`{STORAGE_LOCAL_ROOT}/{domain}/{owner?}/{uuid}{ext}`。

    这是**临时暂存路径，不是持久化存储**（见模块 docstring「唯一事实口径」）：
    只服务开发/测试与显式 `STORAGE_BACKEND=local`，落点由 `local_staging_root()` 校验。
    接入 R2 之前的存量附件按行内 `path` 读，不受这里的布局变化影响。
    只为本地后端调用；R2 写入不生成磁盘路径。
    """
    parts = [local_staging_root(), business_folder(domain)]
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
    """按**当前配置**返回后端实例（新上传 / 回填用）。

    已存在附件的读取与删除不要用这个 —— 用 `get_backend_for_row()`：行内坐标才是
    那份正文真正的位置，与全局开关无关。
    """
    settings = get_storage_settings()
    if settings.backend == BACKEND_R2 and settings.r2 is not None:
        return R2Backend(settings.r2, presign_ttl=settings.presign_ttl)
    return LocalBackend()


def backend_for_row_coords(
    row_backend: str, path: str, object_key: str
) -> StorageBackend:
    """按行内坐标取后端实例（读/删已存在附件的唯一正确入口）。

    `local` 行没有 R2 依赖，即使 `R2_*` 被清空也照常删除磁盘文件；`r2` 行需要完整
    的 `R2_*` 配置与桶名，缺失时**明确报错**，绝不静默退回本地盘去「删一个不存在的
    路径」并把元数据删掉（那会造成无人追踪的 R2 孤儿对象）。
    """
    name = resolve_backend_name_from(row_backend, path, object_key)
    if name == BACKEND_LOCAL:
        return LocalBackend()
    settings = r2_settings_from_env()
    if not r2_settings_complete(settings):
        raise RuntimeError(
            "该附件的正文在 R2（storage_backend=r2），但当前 R2 配置不完整（缺 "
            f"{_missing_r2_fields(settings)}）；不能按本地磁盘读写该行。"
        )
    return R2Backend(settings, presign_ttl=_presign_ttl())


def get_backend_for_row(row) -> StorageBackend:
    """`backend_for_row_coords()` 的便捷入口，直接吃 `Attachment` 行对象。"""
    return backend_for_row_coords(
        str(getattr(row, "storage_backend", "") or ""),
        str(getattr(row, "path", "") or ""),
        str(getattr(row, "object_key", "") or ""),
    )


def try_delete_object_quietly(object_key: str) -> None:
    """补偿用：删对象失败只记录，不抛出（供业务事务失败后的清理调用）。"""
    settings = get_storage_settings()
    if settings.backend != BACKEND_R2 or settings.r2 is None or not object_key:
        return
    try_delete_object(settings.r2, object_key)


__all__ += ["R2ObjectMissing", "R2Unavailable", "try_delete_object_quietly"]
