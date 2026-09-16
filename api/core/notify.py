"""站内通知（Stage 3）：落库 + 按天去重 + 角色收件人解析。

设计：所有预警/审批/提醒统一写入 notifications 表，支持已读与历史。
channel 字段预留 email/wecom，本期只做 inapp。
"""
from datetime import date, datetime, timezone

from sqlalchemy.orm import Session

from ..models import Notification, Role, User, UserRole

# 去重窗口：同一 dedup_key 每自然日只推一次
WINDOW_FMT = "%Y-%m-%d"


def _today() -> str:
    return datetime.now(timezone.utc).strftime(WINDOW_FMT)


def user_ids_with_role(db: Session, code: str) -> list[int]:
    r = db.query(Role).filter_by(code=code).first()
    if not r:
        return []
    return [ur.user_id for ur in db.query(UserRole).filter_by(role_id=r.id).all()]


def admin_ids(db: Session) -> list[int]:
    """管理员用户 id：当前契约下唯一的管理与审批角色（见 core.rbac）。"""
    from .rbac import ROLE_ADMIN

    return user_ids_with_role(db, ROLE_ADMIN)


def push(
    db: Session,
    user_id: int | None,
    ntype: str,
    title: str,
    body: str = "",
    *,
    ref_type: str = "",
    ref_id: int | None = None,
    project_id: int | None = None,
    dedup_key: str = "",
) -> bool:
    """写入一条通知。user_id 为空或 dedup_key 当日已存在则跳过。返回是否写入。"""
    if not user_id:
        return False
    if dedup_key:
        key = f"{dedup_key}:{_today()}"
        exists = db.query(Notification).filter_by(user_id=user_id, dedup_key=key).first()
        if exists:
            return False
    else:
        key = ""
    db.add(Notification(
        user_id=user_id, type=ntype, title=title[:128], body=body,
        channel="inapp", ref_type=ref_type, ref_id=ref_id,
        project_id=project_id, dedup_key=key,
        created_at=datetime.now(timezone.utc),
    ))
    return True


def push_many(
    db: Session,
    user_ids: list[int],
    ntype: str,
    title: str,
    body: str = "",
    *,
    ref_type: str = "",
    ref_id: int | None = None,
    project_id: int | None = None,
    dedup_key: str = "",
) -> int:
    n = 0
    for uid in sorted({u for u in user_ids if u}):
        if push(db, uid, ntype, title, body, ref_type=ref_type, ref_id=ref_id,
                project_id=project_id, dedup_key=dedup_key):
            n += 1
    return n


def approval_recipients(db: Session) -> list[int]:
    """审批人：仅系统管理员（管理与审批唯一角色）。

    项目负责人 / 成本管理员 / 高层都不再是审批人，不再出现在审批通知收件人里。
    """
    return admin_ids(db)


def purge_old(db: Session, keep_days: int = 90) -> int:
    """清理历史通知，避免无限增长（供 jobs CLI 调用）。"""
    from datetime import timedelta

    cutoff = datetime.now(timezone.utc) - timedelta(days=keep_days)
    rows = db.query(Notification).filter(Notification.created_at < cutoff).all()
    for r in rows:
        db.delete(r)
    db.commit()
    return len(rows)
