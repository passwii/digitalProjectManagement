"""审计留痕。

契约（Stage 4A）：
  · 关键写操作的审计行与业务变更必须同一次提交 —— 用 `commit_audited()`；
    业务落库成功但审计写失败时，整笔事务一起回滚，接口返回 500 而不是「静默成功」。
  · `write_audit()` 保持既有签名（先提交业务、再单独提交审计行），但**失败不再静默**：
    审计写入异常会 rollback 并抛 500，调用方与前端都能看到「留痕失败」，不允许被当成成功。
"""
from datetime import datetime, timezone

from fastapi import HTTPException

AUDIT_FAIL_MSG = "审计写入失败，本次操作已回滚，请重试或联系管理员"


def _row(db, user_id, action: str, resource: str = "", resource_id="", detail: str = "", ip: str = ""):
    from ..models import AuditLog

    return AuditLog(user_id=user_id, action=action, resource=resource,
                    resource_id=str(resource_id or ""), detail=detail or "", ip=ip or "",
                    created_at=datetime.now(timezone.utc))


def audit_row(db, user_id, action: str, resource: str = "", resource_id="",
              detail: str = "", ip: str = ""):
    """只把审计行加入当前事务，不提交（供需要原子提交的调用方使用）。"""
    from ..models import AuditLog  # noqa: F401  (确保模型已注册)

    row = _row(db, user_id, action, resource, resource_id, detail, ip)
    db.add(row)
    return row


def commit_audited(db, user_id, action: str, resource: str = "", resource_id="",
                   detail: str = "", ip: str = ""):
    """业务变更 + 审计行**一次提交**：任一失败则整体回滚并抛 500。

    关键写操作（状态流转 / 审批决策 / 特批 / 预算调整）一律用本函数，
    保证「有状态变化必有时间线，且不会出现业务成功但留痕丢失」。
    审计行构造本身失败（如审计表结构异常）同样回滚并报 500。
    """
    try:
        audit_row(db, user_id, action, resource, resource_id, detail, ip)
        db.commit()
    except HTTPException:
        raise
    except Exception:
        db.rollback()
        raise HTTPException(500, AUDIT_FAIL_MSG)
    return True


def write_audit(db, user_id, action: str, resource: str = "", resource_id: str = "",
                detail: str = "", ip: str = ""):
    """兼容入口：业务已提交后单独提交审计行。

    注意：与 `commit_audited` 不同，本函数不具备事务原子性 —— 仅用于业务提交已完成、
    审计作为独立后续动作的场景（如登录/导出/下载）。审计失败会抛 500，绝不静默吞掉。
    """
    try:
        db.add(_row(db, user_id, action, resource, resource_id, detail, ip))
        db.commit()
    except Exception:
        db.rollback()
        raise HTTPException(500, AUDIT_FAIL_MSG)


def audit(action: str, resource: str = ""):
    """FastAPI dependency 工厂占位（当前各 router 直接调 write_audit/commit_audited）。"""
    return {"action": action, "resource": resource}
