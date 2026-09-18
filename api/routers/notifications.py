"""Stage 3 / Stage 4A：站内通知（懒触发同步，不依赖 cron）。

Stage 4A 补齐：
  · **可追踪状态**：每条通知有 `state`（pending 待处理 / done 已处理 / ignored 已忽略）与
    `handled_at` / `handled_by` / `handle_note`，把「已推送」与「已处理」区分开；
  · **可定位引用**：`ref_type` / `ref_id` / `project_id` 三元组齐备，并额外返回 `link`
    （前端可直接跳转的相对路径），避免前端各自猜测跳转规则；
  · **去重窗口可配**：`notify_dedup_days`（默认 1 天，时间窗口而非自然日切分），
    同一到期记录在窗口内不会被重复灌入，跨零点也不会立刻重推。

引用三元组的完整性由 `core.notify.REF_TYPES` 白名单保证：
预警/审批/提醒的写入点都必须给出 ref_type + ref_id + project_id，缺失时不写入无法解析的引用。
"""
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..core.database import get_db
from ..core.deps import get_current_user
from ..core.jobs import sync_notifications
from ..core.notify import (
    DEDUP_PARAM_KEY,
    REF_TYPES,
    STATE_DONE,
    STATE_IGNORED,
    STATE_PENDING,
    dedup_days,
    mark_state,
)
from ..core.timeutil import app_now, app_now_aware, as_app, iso
from ..models import Notification, Project, User

router = APIRouter(prefix="/notifications", tags=["notifications"])

# 懒同步节流窗口（秒）：避免轮询时反复跑全量预警计算
SYNC_INTERVAL = 300

# 通知类型 → 中文标签（与 web/lib/labels.ts 对齐，供前端与接口文档共用）
TYPE_LABEL = {
    "overdue_task": "任务逾期",
    "milestone": "里程碑",
    "stagnant": "项目停滞",
    "budget": "预算预警",
    "followup": "跟进提醒",
    "approval": "审批",
    "expense": "支出",
}

NOTIFY_STATES = (STATE_PENDING, STATE_DONE, STATE_IGNORED)


def _link(x: Notification) -> str | None:
    """通知点击的定位链接（服务端给唯一答案，避免前端各自猜跳转规则）。"""
    if x.ref_type == "task" and x.project_id:
        return f"/progress?project_id={x.project_id}&task_id={x.ref_id}"
    if x.ref_type == "milestone" and x.project_id:
        return f"/progress?project_id={x.project_id}&milestone_id={x.ref_id}"
    if x.ref_type == "expense":
        return f"/costs?project_id={x.project_id or ''}&expense_id={x.ref_id}"
    if x.ref_type == "budget_adjust":
        return f"/approvals?budget_adjust_id={x.ref_id}"
    if x.ref_type == "followup" and x.project_id:
        return f"/projects/{x.project_id}?followup_id={x.ref_id}"
    if x.project_id:
        return f"/projects/{x.project_id}"
    return None


def _n(x: Notification) -> dict:
    return {"id": x.id, "type": x.type, "type_label": TYPE_LABEL.get(x.type, x.type),
            "title": x.title, "body": x.body,
            "ref_type": x.ref_type, "ref_id": x.ref_id, "project_id": x.project_id,
            "ref_complete": bool(x.ref_type and x.ref_id),
            "link": _link(x),
            "state": x.state or STATE_PENDING,
            "handled_at": iso(x.handled_at),
            "handled_by": x.handled_by,
            "handle_note": x.handle_note or "",
            "read": x.read_at is not None,
            "created_at": iso(x.created_at)}


def _sync(db: Session, force: bool = False):
    """懒同步：把当前预警落库（按去重窗口防重）。

    节流：默认 5 分钟内不重复计算（存在 sys_params.notifications_synced_at），
    避免每次轮询都跑全量预警；失败不影响读取。
    """
    from datetime import timedelta

    from ..models import SysParam

    key = "notifications_synced_at"
    now = app_now_aware()
    try:
        row = db.query(SysParam).filter_by(key=key).first()
        if not force and row and row.value:
            try:
                last = as_app(datetime.fromisoformat(row.value))
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
def list_notifications(unread: int = 0, state: str = "", type: str = "",
                       page: int = 1, size: int = 20,
                       db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """我的通知：可按已读与处理状态筛选，每条都带可定位引用与跳转链接。"""
    if state and state not in NOTIFY_STATES:
        raise HTTPException(400, f"state 须为 {list(NOTIFY_STATES)} 之一，收到 {state!r}")
    if size < 1 or size > 100:
        raise HTTPException(400, f"size 须为 1-100 的整数，收到 {size!r}")
    if page < 1:
        raise HTTPException(400, f"page 须为 ≥1 的整数，收到 {page!r}")
    _sync(db)
    q = db.query(Notification).filter_by(user_id=user.id)
    if unread:
        q = q.filter(Notification.read_at.is_(None))
    if state:
        q = q.filter(Notification.state == state)
    if type:
        q = q.filter(Notification.type == type)
    total = q.count()
    rows = q.order_by(Notification.id.desc()).offset((page - 1) * size).limit(size).all()
    unread_count = db.query(Notification).filter(
        Notification.user_id == user.id, Notification.read_at.is_(None)).count()
    pending_count = db.query(Notification).filter(
        Notification.user_id == user.id,
        Notification.state == STATE_PENDING).count()
    return {"total": total, "unread": unread_count, "pending": pending_count,
            "page": page, "size": size,
            "dedup_days": dedup_days(db),
            "items": [_n(x) for x in rows]}


@router.get("/count")
def unread_count(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """轮询接口：只读计数，不做同步（保持微秒级响应）。"""
    n = db.query(Notification).filter(
        Notification.user_id == user.id, Notification.read_at.is_(None)).count()
    pending = db.query(Notification).filter(
        Notification.user_id == user.id, Notification.state == STATE_PENDING).count()
    return {"unread": n, "pending": pending}


@router.get("/{nid}")
def get_notification(nid: int, db: Session = Depends(get_db),
                     user: User = Depends(get_current_user)):
    """单条通知详情（带引用完整性与跳转链接，供通知面板做「对象不存在」的兜底判断）。"""
    x = db.query(Notification).filter_by(id=nid, user_id=user.id).first()
    if not x:
        raise HTTPException(404, "通知不存在")
    data = _n(x)
    # 引用对象是否仍可访问：已删除/不可见时前端应展示可理解的错误而不是空白页
    data["ref_available"] = True
    if x.ref_type == "expense":
        from ..models import Expense
        e = db.query(Expense).filter_by(id=x.ref_id).first()
        data["ref_available"] = bool(e)
    elif x.project_id:
        from ..core.rbac import get_active_project
        try:
            get_active_project(db, x.project_id, user)
        except HTTPException:
            data["ref_available"] = False
    return data


@router.post("/{nid}/read")
def mark_read(nid: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    x = db.query(Notification).filter_by(id=nid, user_id=user.id).first()
    if not x:
        raise HTTPException(404, "通知不存在")
    if not x.read_at:
        x.read_at = app_now()
        db.commit()
    return {"ok": True, "id": x.id, "state": x.state or STATE_PENDING}


@router.post("/read-all")
def mark_all_read(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    rows = db.query(Notification).filter(
        Notification.user_id == user.id, Notification.read_at.is_(None)).all()
    now = app_now()
    for x in rows:
        x.read_at = now
    db.commit()
    return {"ok": True, "read": len(rows)}


@router.post("/{nid}/handle")
def handle_notification(nid: int, body: dict, db: Session = Depends(get_db),
                        user: User = Depends(get_current_user)):
    """标记通知为「已处理 / 已忽略」（可带处理备注）。

    这是「可追踪的通知/处理状态」的写入端：预警类通知被处理或显式忽略后，
    不再是待处理队列的一部分，避免同一到期记录反复出现在待办视野里。
    """
    x = db.query(Notification).filter_by(id=nid, user_id=user.id).first()
    if not x:
        raise HTTPException(404, "通知不存在")
    state = str(body.get("state", STATE_DONE) or STATE_DONE)
    if state not in NOTIFY_STATES:
        raise HTTPException(400, f"state 须为 {list(NOTIFY_STATES)} 之一，收到 {state!r}")
    mark_state(db, x, state, user.id, str(body.get("note", "") or ""))
    if not x.read_at:
        x.read_at = app_now()
    db.commit()
    return _n(x)


@router.post("/handle-all")
def handle_all(body: dict, db: Session = Depends(get_db),
               user: User = Depends(get_current_user)):
    """批量处理：把当前用户某一类（或全部）待处理通知标记为已处理/已忽略。"""
    state = str(body.get("state", STATE_DONE) or STATE_DONE)
    if state not in (STATE_DONE, STATE_IGNORED):
        raise HTTPException(400, f"批量处理只支持 {[STATE_DONE, STATE_IGNORED]}")
    ntype = str(body.get("type", "") or "")
    if ntype and ntype not in TYPE_LABEL:
        raise HTTPException(400, f"不支持的通知类型：{ntype!r}")
    q = db.query(Notification).filter(Notification.user_id == user.id,
                                      Notification.state == STATE_PENDING)
    if ntype:
        q = q.filter(Notification.type == ntype)
    rows = q.all()
    now = app_now()
    note = str(body.get("note", "") or "")
    for x in rows:
        mark_state(db, x, state, user.id, note)
        x.read_at = x.read_at or now
    db.commit()
    return {"ok": True, "handled": len(rows), "state": state, "type": ntype}


@router.get("/dedup/config")
def dedup_config(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """去重窗口配置（只读）：便于前端/运维解释「为什么同一条预警没有重复出现」。"""
    return {"key": DEDUP_PARAM_KEY, "days": dedup_days(db), "ref_types": list(REF_TYPES)}
