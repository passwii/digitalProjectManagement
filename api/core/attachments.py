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

关键约束：已存在附件的读/删一律**按行**取后端（`get_backend_for_row`），不看
`STORAGE_BACKEND`。否则把开关改回 `local`（或本地开发连生产库）时，所有已上 R2 的
附件会同时退化成「下载 404 假装丢文件」+「删除 200 但对象没删」的孤儿对象。
"""

from __future__ import annotations

import logging
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
    get_backend_for_row,
    local_path_for,
    resolve_backend_name_from,
)

logger = logging.getLogger(__name__)

__all__ = [
    "attachment_blob_available",
    "attachment_response",
    "remove_attachment_blob",
    "store_attachment",
]


def _row_coords(row) -> tuple[str, str, str]:
    """读出一行的 `(backend, object_key, local_path)`，兼容接入 R2 之前的存量行。

    后端判定委托 `storage.resolve_backend_name_from()`（单一实现），保证「读/删用的
    后端」与迁移脚本、行内坐标三处永远一致；未知取值明确报错而不是静默当本地。
    """
    declared = str(getattr(row, "storage_backend", "") or "").strip()
    object_key = str(getattr(row, "object_key", "") or "").strip()
    path = str(getattr(row, "path", "") or "").strip()
    return resolve_backend_name_from(declared, path, object_key), object_key, path


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
    object_key = build_object_key(domain, filename, owner_id=uploaded_by, suffix=suffix)
    try:
        # `get_backend()` 也会抛 `RuntimeError`（配置自相矛盾），必须在 try 内：
        # 否则它会以裸 500 冒出，既不是承诺的 502，调用方也看不出是配置错误。
        target = backend or get_backend()
        _reject_duplicate_object_key(db, target.name, object_key)
        # 只有本地后端才需要磁盘路径；R2 上传不生成也不使用磁盘落点
        local_path = (
            local_path_for(domain, filename, object_key, owner_id=uploaded_by)
            if target.name == BACKEND_LOCAL
            else Path()
        )
        stored = target.put(data, object_key, local_path, content_type)
    except HTTPException:
        # 重复对象键等已在下方抛出的 HTTP 语义（500）原样冒出去，不要被当成存储不可用
        raise
    except R2Unavailable as exc:
        # 正文没写成功 → 不产生任何元数据，客户端可安全重试
        raise HTTPException(502, f"文件存储不可用，请稍后重试（{exc}）") from exc
    except RuntimeError as exc:
        # `STORAGE_BACKEND` 配置自相矛盾等配置错误：502（可重试的服务不可用）
        # 而不是裸 500，且同样不产生元数据。
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
    return get_backend_for_row(row).exists(object_key, local_path)


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
    try:
        # 行内坐标不合法（如 `storage_backend` 写错）也要收敛成 502，不能裸 500：
        # 客户端的处理方式是「可重试的服务不可用」，而 500 看起来像服务端 bug。
        backend_name, object_key, local_path = _row_coords(row)
    except RuntimeError as exc:
        raise HTTPException(502, f"文件存储不可用，请稍后重试（{exc}）") from exc

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
        # 按**行内**后端流式读取：即使全局开关已改回 local，已上 R2 的行仍能下载
        chunks, size = get_backend_for_row(row).stream(object_key, local_path)
    except R2ObjectMissing as exc:
        raise HTTPException(404, _LOST_MSG) from exc
    except R2Unavailable as exc:
        raise HTTPException(502, f"文件存储不可用，请稍后重试（{exc}）") from exc
    except RuntimeError as exc:
        raise HTTPException(502, f"文件存储不可用，请稍后重试（{exc}）") from exc
    return StreamingResponse(
        _guarded(chunks, filename=name, size=size),
        media_type=media_type,
        headers=_stream_headers(disposition, size),
    )


_LOST_MSG = "附件文件已丢失，请联系管理员"


def _stream_headers(disposition: dict, size: int) -> dict:
    headers = dict(disposition)
    if size > 0:
        headers["Content-Length"] = str(size)
    return headers


def _guarded(
    chunks: Iterator[bytes], *, filename: str, size: int
) -> Iterator[bytes]:
    """流中断（R2 挂掉）时不要把裸异常抛回 ASGI，但也**不能静默截断**。

    `Content-Length` 已经由响应头声明为 `size`，中途少发字节时客户端会把截断文件
    当成功下载存盘（100MB 附件静默损坏）。所以这里记 error 日志，并附上已发字节数
    与声明的总长，便于对账；响应本身只能截断（头部已发出，无法改状态码）。

    捕类范围刻意是 `Exception`：传输层的失败未必都是 `R2Unavailable`
    （botocore 的 `ClientError`、连接重置等会以其他类型冒出），只捕 `R2Unavailable`
    会让这些路径**没有日志**——正是这里要避免的「静默截断」。
    """
    sent = 0
    try:
        for chunk in chunks:
            sent += len(chunk)
            yield chunk
    except Exception as exc:  # noqa: BLE001 - 任何传输失败都要留对账线索
        logger.error(
            "附件下载流中断：filename=%s 已发送=%d/%d 字节（%s: %s）"
            "——客户端收到的文件可能不完整",
            filename,
            sent,
            size,
            type(exc).__name__,
            exc,
        )
        return


def _reject_duplicate_object_key(
    db: Session, backend_name: str, object_key: str
) -> None:
    """新键必须唯一：命中已有行说明 uuid 撞车或元数据残留，直接报错而不是覆盖正文。

    查询走 ORM 参数绑定（`filter(Column == value)`），不是字符串拼 SQL。
    """
    existing = (
        db.query(Attachment.id).filter(Attachment.object_key == object_key).first()
    )
    if existing is not None:
        logger.error(
            "对象键已存在，拒绝覆盖：backend=%s key=%s（已挂在附件 id=%s）",
            backend_name,
            object_key,
            existing[0],
        )
        raise HTTPException(500, "附件存储坐标冲突，请重试")


def remove_attachment_blob(row, *, strict: bool = True) -> bool:
    """删正文。`strict=True` 时删不掉抛错（调用方保留元数据，避免孤儿对象）。

    删除顺序刻意是「先删正文、后删元数据」：反过来的话，一旦 R2 删除失败，
    数据库里已经查不到这个 key，对象就永远无人追踪了。

    后端按**行内坐标**取：全局 `STORAGE_BACKEND` 改成 `local` 时，已有 R2 行仍然
    删 R2 对象（配置不全则报 502 并保留元数据），不会出现「返回 200、对象还在」的孤儿。
    """
    try:
        # 行内坐标不合法（如 `storage_backend` 写错）也走下面的 `RuntimeError` → 502 +
        # 保留元数据，绝不能变成「裸 500 且元数据已被摘掉」。
        backend_name, object_key, local_path = _row_coords(row)
        if backend_name == BACKEND_R2 and object_key:
            get_backend_for_row(row).delete(object_key, local_path)
        elif local_path and not local_path.startswith(("http://", "https://")):
            Path(local_path).unlink(missing_ok=True)
        return True
    except R2Unavailable as exc:
        if strict:
            raise HTTPException(502, f"文件删除失败，请稍后重试（{exc}）") from exc
        return False
    except RuntimeError as exc:
        # 行在 R2 但 R2 配置缺失 / 行内后端取值非法：保留元数据（不删库），
        # 让对象仍可被追踪与重试删除。
        if strict:
            raise HTTPException(
                502, f"文件存储不可用，无法确认对象已删除（{exc}）"
            ) from exc
        return False
