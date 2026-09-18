"""站内通知（Stage 3 落地，Stage 4A 补可追踪状态与去重窗口）。

设计：所有预警/审批/提醒统一写入 notifications 表，支持已读、处理状态与历史。
每条通知都带可定位引用（`ref_type` / `ref_id` / `project_id`），前端点击即可直达业务对象。

去重（Stage 4A）：
  · 同一 `dedup_key` 在去重窗口内只推一次，窗口由系统参数 `notify_dedup_days` 控制（默认 1 天）。
  · 窗口是**时间窗口**而非自然日：原先按自然日切分，跨零点会立刻重推同一条到期记录；
    改为「距上次推送不足 N 天则跳过」，同一到期记录不会被无限重复灌入。
  · 去重键含引用 id（如 `overdue_task:12`），因此不同任务/里程碑/支出/跟进互不影响。
"""
from collections.abc import Sequence
from datetime import timedelta

from sqlalchemy import or_
from sqlalchemy.orm import Session

from ..models import Notification, Role, SysParam, UserRole
from .timeutil import app_now, to_db

# 默认去重窗口（天）：可由 sys_params.notify_dedup_days 覆盖
DEFAULT_DEDUP_DAYS = 1
DEDUP_PARAM_KEY = "notify_dedup_days"

STATE_PENDING = "pending"
STATE_DONE = "done"
STATE_IGNORED = "ignored"

# 引用类型白名单：保证 ref_type 与 ref_id 的配对语义稳定，前端跳转可穷举
REF_TYPES = ("project", "task", "milestone", "expense", "budget_adjust", "followup")


def _db_ts(ts):
    """把库里的时间列统一到入库口径（naive 北京时间，见 core/timeutil.py）。

    去重窗口是「两个时间点之差」，两边必须在同一口径里相减：
    naive 与 aware 相减会直接 `TypeError`，而混着用就是历史 bug 的来源。
    """
    return to_db(ts)


def dedup_days(db: Session) -> int:
    """去重窗口天数：缺省 1 天；非法值回退默认（不因脏参数让预警失去防重能力）。

    结果在当前 Session 上记忆化：一次同步会对同一用户/不同引用调用上百次 push，
    逐次查 sys_params 是手写的 N+1。
    """
    cached = db.info.get("_notify_dedup_days")
    if cached is not None:
        return cached
    row = db.query(SysParam).filter_by(key=DEDUP_PARAM_KEY).first()
    try:
        days = max(0, int(row.value)) if row and row.value else DEFAULT_DEDUP_DAYS
    except (TypeError, ValueError):
        days = DEFAULT_DEDUP_DAYS
    db.info["_notify_dedup_days"] = days
    return days


def reset_caches(db: Session) -> None:
    """清除 Session 级缓存（参数被改动后调用，否则窗口变更不会生效）。"""
    db.info.pop("_notify_dedup_days", None)


def _like_prefix(key: str) -> str:
    """把去重键转成 LIKE 前缀模式，转义 `%` / `_` / `\\` 避免 subject 里的通配符造成误命中。"""
    escaped = key.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return escaped


def _dedup_hit(db: Session, user_id: int, dedup_key: str, days: int) -> bool:
    """同一用户 + 同一去重键，是否在窗口内已推送过。days<=0 表示不去重（仅在显式配置时）。

    兼容三种存法：
      · `key`                —— Stage 4A 起的格式（窗口由 created_at 判定）
      · `key:<YYYY-MM-DD>`   —— Stage 3 的自然日格式（升级前存量行）
      · `key@<ts>`           —— 中间过渡格式
    前缀模式用转义后的 `_like_prefix`，保证 `overdue_task:1` 不会误匹配 `overdue_task:12`。
    """
    if days <= 0:
        return False
    cutoff = app_now() - timedelta(days=days)
    pat = _like_prefix(dedup_key)
    rows = db.query(Notification.created_at).filter(
        Notification.user_id == user_id,
        or_(Notification.dedup_key == dedup_key,
            Notification.dedup_key.like(f"{pat}:%", escape="\\"),
            Notification.dedup_key.like(f"{pat}@%", escape="\\")),
    ).all()
    for (created,) in rows:
        if created is None or _db_ts(created) >= cutoff:
            return True
    return False


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
    """写入一条通知。user_id 为空或在去重窗口内已推过则跳过。返回是否写入。

    `ref_type` 必须在白名单内；不在白名单时降级为空（宁可不可跳转，也不写入无法解析的引用）。
    """
    if not user_id:
        return False
    key = ""
    if dedup_key:
        if _dedup_hit(db, user_id, dedup_key, dedup_days(db)):
            return False
        key = dedup_key
    if ref_type and ref_type not in REF_TYPES:
        ref_type, ref_id = "", None
    db.add(Notification(
        user_id=user_id, type=ntype, title=title[:128], body=body,
        channel="inapp", ref_type=ref_type, ref_id=ref_id,
        project_id=project_id, dedup_key=key, state=STATE_PENDING,
        created_at=app_now(),
    ))
    return True


def push_many(
    db: Session,
    user_ids: Sequence[int | None],
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


def mark_state(db: Session, notification: Notification, state: str, user_id: int | None,
               note: str = "") -> Notification:
    """写入处理状态（调用方负责鉴权与提交）：done 已处理 / ignored 已忽略 / pending 恢复。"""
    if state not in (STATE_PENDING, STATE_DONE, STATE_IGNORED):
        raise ValueError(f"非法处理状态：{state}")
    notification.state = state
    if state == STATE_PENDING:
        notification.handled_at, notification.handled_by, notification.handle_note = None, None, ""
    else:
        notification.handled_at, notification.handled_by = app_now(), user_id
        notification.handle_note = note or ""
    return notification


def purge_old(db: Session, keep_days: int = 90) -> int:
    """清理历史通知，避免无限增长（供 jobs CLI 调用）。"""
    cutoff = app_now() - timedelta(days=keep_days)
    rows = db.query(Notification).filter(Notification.created_at < cutoff).all()
    for r in rows:
        db.delete(r)
    db.commit()
    return len(rows)
