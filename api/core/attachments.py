"""附件正文的读/写/删收口（本地磁盘与 R2 共用一条代码路径）。

为什么单独一层
--------------
三个上传入口（项目/合同附件、人员档案附件、支出凭证）原先各自 `mkdir` + `write_bytes`
+ `Path(a.path).unlink()`，接 R2 时若各改一遍，必然会漏改一处（历史上调体积上限
那次就是靠「三处都改」的纪律维持的）。这里把正文读写收敛成三个函数，
router 只负责鉴权与业务语义：

  · `store_attachment()` —— 写正文 + 构造 `Attachment` 行（**不提交**，与审计同事务）；
  · `attachment_response()` —— 下载响应（本地走 `FileResponse` 支持 Range，R2 走分块流）；
  · `remove_attachment_blob()` —— 删正文（**先删正文再删元数据**：删不掉就报错，
    绝不出现「数据库说没了、R2 还留着」的孤儿对象）。

同时兼容**存量数据**：`storage_backend` 为空/`local` 的旧行仍按磁盘路径读，
不需要一次性迁移即可平滑运行；新写入的行按当前配置走后端。
"""

from __future__ import annotations

from collections.abc import Iterator
from datetime import datetime, timezone
from pathlib import Path

from fastapi import HTTPException
from fastapi.responses import FileResponse, StreamingResponse
from sqlalchemy.orm import Session

from ..models import Attachment
from .r2 import R2ObjectMissing, R2Unavailable
from .storage import (
    BACKEND_LOCAL,
    BACKEND_R2,
    StorageBackend,
    build_object_key,
    get_backend,
    local_path_for,
)

__all__ = [
    "attachment_blob_available",
    "attachment_response",
    "remove_attachment_blob",
    "store_attachment",
]


def _row_coords(row) -> tuple[str, str, str]:
    """读出一行的 `(backend, object_key, local_path)`，兼容接入 R2 之前的存量行。"""
    backend = (getattr(row, "storage_backend", "") or "").strip() or BACKEND_LOCAL
    object_key = (getattr(row, "object_key", "") or "").strip()
    path = (getattr(row, "path", "") or "").strip()
    # 存量行没有 object_key：若正文已切 R2，其 path 是 URL，不能当磁盘路径用。
    if backend == BACKEND_LOCAL and path.startswith(("http://", "https://")):
        backend = BACKEND_R2
    return backend, object_key, path


def store_attachment(
    db: Session,
    *,
    domain: str,
    filename: str,
    content_type: str,
    data: bytes,
    project_id: int | None = None,
    ref_type: str = "",
    ref_id: int | None = None,
    category: str = "",
    uploaded_by: int | None = None,
    suffix: str = "",
    backend: StorageBackend | None = None,
) -> Attachment:
    """写正文并返回**未持久化**的 `Attachment` 行。

    调用方负责鉴权、体积/类型校验与 `commit_audited()`；本函数只做正文落位与元数据组装，
    保证「业务行 + 审计」仍是一次事务提交（README §3.5 / ADR-004）。
    """
    target = backend or get_backend()
    object_key = build_object_key(domain, filename, owner_id=uploaded_by, suffix=suffix)
    local_path = local_path_for(domain, filename, object_key, owner_id=uploaded_by)
    try:
        stored = target.put(data, object_key, local_path, content_type)
    except R2Unavailable as exc:
        # 正文没写成功 → 不产生任何元数据，客户端可安全重试
        raise HTTPException(502, f"文件存储不可用，请稍后重试（{exc}）") from exc

    row = Attachment(
        project_id=project_id,
        filename=filename,
        path=stored.path,
        size=stored.size,
        content_type=content_type or "",
        uploaded_by=uploaded_by,
        uploaded_at=datetime.now(timezone.utc),
        ref_type=ref_type,
        ref_id=ref_id,
        category=category,
        storage_backend=stored.backend,
        object_key=stored.object_key,
        etag=stored.etag,
    )
    db.add(row)
    db.flush()
    return row


def attachment_blob_available(row) -> bool:
    """正文是否仍可读（用于区分「文件已丢失」与「R2 暂时不可用」）。"""
    backend_name, object_key, local_path = _row_coords(row)
    if backend_name != BACKEND_R2:
        return bool(local_path) and Path(local_path).exists()
    if not object_key:
        return False
    return get_backend().exists(object_key, local_path)


def attachment_response(
    row, *, filename: str | None = None, content_type: str | None = None
) -> FileResponse | StreamingResponse:
    """构造下载响应（`Content-Disposition` 统一带 UTF-8 文件名）。

    · 本地后端：`FileResponse` —— 原生支持 Range 断点续传；
    · R2 后端：分块流式返回 —— 100MB 附件不会整体进内存，且不经浏览器缓存凭据。
    """
    from urllib.parse import quote

    name = filename or row.filename or "attachment"
    media_type = content_type or row.content_type or "application/octet-stream"
    disposition = {"Content-Disposition": f"attachment; filename*=UTF-8''{quote(name)}"}
    backend_name, object_key, local_path = _row_coords(row)

    if backend_name != BACKEND_R2:
        path = Path(local_path)
        if not path.exists():
            raise HTTPException(404, _LOST_MSG)
        return FileResponse(
            path, media_type=media_type, filename=name, headers=disposition
        )

    if not object_key:
        raise HTTPException(404, _LOST_MSG)
    try:
        chunks, size = get_backend().stream(object_key, local_path)
    except R2ObjectMissing as exc:
        raise HTTPException(404, _LOST_MSG) from exc
    except R2Unavailable as exc:
        raise HTTPException(502, f"文件存储不可用，请稍后重试（{exc}）") from exc
    return StreamingResponse(
        _guarded(chunks),
        media_type=media_type,
        headers=_stream_headers(disposition, size),
    )


_LOST_MSG = "附件文件已丢失，请联系管理员"


def _stream_headers(disposition: dict, size: int) -> dict:
    headers = dict(disposition)
    if size > 0:
        headers["Content-Length"] = str(size)
    return headers


def _guarded(chunks: Iterator[bytes]) -> Iterator[bytes]:
    """流中断（R2 挂掉）时不要让 ASGI 抛裸异常：截断流即可，日志留给上层。"""
    try:
        yield from chunks
    except R2Unavailable:
        return


def remove_attachment_blob(row, *, strict: bool = True) -> bool:
    """删正文。`strict=True` 时删不掉抛错（调用方保留元数据，避免孤儿对象）。

    删除顺序刻意是「先正文、后元数据」：反过来的话，一旦 R2 删除失败，
    数据库里已经查不到这个 key，对象就永远无人追踪了。
    """
    backend_name, object_key, local_path = _row_coords(row)
    try:
        if backend_name == BACKEND_R2 and object_key:
            get_backend().delete(object_key, local_path)
        elif local_path and not local_path.startswith(("http://", "https://")):
            Path(local_path).unlink(missing_ok=True)
        return True
    except R2Unavailable as exc:
        if strict:
            raise HTTPException(502, f"文件删除失败，请稍后重试（{exc}）") from exc
        return False
