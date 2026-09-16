"""审计留痕。"""
from datetime import datetime, timezone

from .database import SessionLocal


def write_audit(db, user_id, action: str, resource: str = "", resource_id: str = "", detail: str = "", ip: str = ""):
    from ..models import AuditLog

    try:
        db.add(AuditLog(user_id=user_id, action=action, resource=resource,
                        resource_id=str(resource_id or ""), detail=detail or "", ip=ip or "",
                        created_at=datetime.now(timezone.utc)))
        db.commit()
    except Exception:
        db.rollback()


def audit(action: str, resource: str = ""):
    """FastAPI dependency 工厂占位（当前各 router 直接调 write_audit）。"""
    return {"action": action, "resource": resource}
