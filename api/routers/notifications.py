"""Stage 3：站内通知。懒触发同步（不依赖 cron），支持已读与未读计数。"""
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from ..core.database import get_db
from ..core.deps import get_current_user
from ..core.jobs import sync_notifications
from ..models import Notification, Project, User

router = APIRouter(prefix="/notifications", tags=["notifications"])

# 懒同步节流窗口（秒）：避免轮询时反复跑全量预警计算
SYNC_INTERVAL = 300


def _n(x: Notification):
    return {"id": x.id, "type": x.type, "title": x.title, "body": x.body,
            "ref_type": x.ref_type, "ref_id": x.ref_id, "project_id": x.project_id,
            "read": x.read_at is not None,
            "created_at": x.created_at.isoformat() if x.created_at else None}


def _sync(db: Session, force: bool = False):
    """懒同步：把当前预警落库（按天去重）。

    节流：默认 5 分钟内不重复计算（存在 sys_params.notifications_synced_at），
    避免每次轮询都跑全量预警；失败不影响读取。
    """
    from datetime import datetime, timedelta, timezone

    from ..models import SysParam

    key = "notifications_synced_at"
    now = datetime.now(timezone.utc)
    try:
        row = db.query(SysParam).filter_by(key=key).first()
        if not force and row and row.value:
            try:
                last = datetime.fromisoformat(row.value)
                if last.tzinfo is None:
                    last = last.replace(tzinfo=timezone.utc)
                if (now - last) < timedelta(seconds=SYNC_INTERVAL):
                    return
            except ValueError:
                pass
        projects = db.query(Project).filter(Project.deleted_at.is_(None)).all()
        sync_notifications(db, projects)
        if row:
            row.value = now.isoformat()
        else:
            db.add(SysParam(key=key, value=now.isoformat(), desc="通知最近同步时间"))
        db.commit()
    except Exception:
        db.rollback()


@router.get("")
def list_notifications(unread: int = 0, page: int = 1, size: int = 20,
                       db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    _sync(db)
    q = db.query(Notification).filter_by(user_id=user.id).order_by(Notification.id.desc())
    if unread:
        q = q.filter(Notification.read_at.is_(None))
    total = q.count()
    rows = q.offset((max(page, 1) - 1) * size).limit(size).all()
    unread_count = db.query(Notification).filter(
        Notification.user_id == user.id, Notification.read_at.is_(None)).count()
    return {"total": total, "unread": unread_count, "page": max(page, 1), "size": size,
            "items": [_n(x) for x in rows]}


@router.get("/count")
def unread_count(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """轮询接口：只读计数，不做同步（保持微秒级响应）。"""
    n = db.query(Notification).filter(
        Notification.user_id == user.id, Notification.read_at.is_(None)).count()
    return {"unread": n}


@router.post("/{nid}/read")
def mark_read(nid: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    x = db.query(Notification).filter_by(id=nid, user_id=user.id).first()
    if not x:
        raise HTTPException(404, "通知不存在")
    if not x.read_at:
        x.read_at = datetime.now(timezone.utc)
        db.commit()
    return {"ok": True}


@router.post("/read-all")
def mark_all_read(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    rows = db.query(Notification).filter(
        Notification.user_id == user.id, Notification.read_at.is_(None)).all()
    now = datetime.now(timezone.utc)
    for x in rows:
        x.read_at = now
    db.commit()
    return {"ok": True, "read": len(rows)}
