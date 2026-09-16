"""定时任务逻辑：跟进 remind 到期扫描 + 四预警计算（供 jobs/CLI 与 /reports/warnings 共用）。

Stage 5 起全部改为批量聚合查询，查询次数与项目数无关。
Stage 4A 补齐：
  · 跟进提醒有可追踪状态（followups.remind_state）—— 一条到期跟进被推送后记为 done，
    不会每次扫描都重复灌入；处理人/处理时间/备注一并留存；
  · 四类预警（逾期任务/里程碑临近/项目停滞/预算预警）各自的引用三元组齐备，
    `ref_type` + `ref_id` + `project_id` 可直接支撑前端定位到具体对象；
  · 预算预警的 `ref_id` 指向具体项目下的科目级预警，前端可定位到项目成本页。
"""
from datetime import date, datetime, timedelta, timezone

from sqlalchemy import func
from sqlalchemy.orm import Session

from ..models import Budget, Expense, Followup, Milestone, ProgressLog, Project, SysParam, Task
from .costs import PASS


STATE_PENDING = "pending"
STATE_DONE = "done"
STATE_IGNORED = "ignored"
STATE_NONE = "none"   # 没有 remind_at：不参与提醒


def _param(db: Session, key: str, default: str) -> str:
    p = db.query(SysParam).filter_by(key=key).first()
    return p.value if p and p.value else default


def _aware(ts: datetime | None) -> datetime | None:
    if ts is None:
        return None
    return ts if ts.tzinfo else ts.replace(tzinfo=timezone.utc)


def due_followups(db: Session, now: datetime | None = None, limit: int = 500) -> list[dict]:
    """10min 级扫描：remind_at <= now 且**尚未处理通知**的跟进。

    只返回 `remind_state in (pending, none)` 的记录：已推送过的（done）不再重复返回，
    这样调用方无需自己去重，避免同一到期记录无限重复灌入通知。
    """
    now = now or datetime.now(timezone.utc)
    rows = db.query(Followup).filter(
        Followup.remind_at.isnot(None),
        Followup.remind_at <= now,
        Followup.remind_state.in_([STATE_PENDING, STATE_NONE, None]),
    ).order_by(Followup.remind_at).limit(limit).all()
    return [{"followup_id": f.id, "project_id": f.project_id, "user_id": f.user_id,
             "remind_at": f.remind_at.isoformat() if f.remind_at else None,
             "content": (f.content or "")[:200]} for f in rows]


def mark_followup_reminded(db: Session, followup_ids: list[int],
                           now: datetime | None = None) -> int:
    """把已推送提醒的跟进标为 done，并记录推送时间（调用方负责提交）。"""
    if not followup_ids:
        return 0
    now = now or datetime.now(timezone.utc)
    rows = db.query(Followup).filter(Followup.id.in_(followup_ids)).all()
    for f in rows:
        if f.remind_state in (STATE_PENDING, STATE_NONE, None):
            f.remind_state = STATE_DONE
            f.reminded_at = now
    return len(rows)


def handle_followup(db: Session, f: Followup, state: str, user_id: int | None,
                    note: str = "", now: datetime | None = None) -> Followup:
    """处理一条跟进提醒（done 已处理 / ignored 已忽略 / pending 重新打开）。"""
    if state not in (STATE_PENDING, STATE_DONE, STATE_IGNORED):
        raise ValueError(f"非法处理状态：{state}")
    now = now or datetime.now(timezone.utc)
    f.remind_state = state
    if state == STATE_PENDING:
        f.handled_at, f.handled_by, f.handle_note = None, None, ""
    else:
        f.handled_at, f.handled_by = now, user_id
        f.handle_note = note or ""
    return f


def compute_warnings(db: Session, projects: list[Project]) -> dict:
    """四预警：任务逾期 / 里程碑临近(N天可配)+逾期 / 项目停滞(N天默认7可配) / 预算80%+超支。
    另附 followup_due（跟进 remind 到期且尚未推送）。

    Stage 5 优化：全部改为批量聚合查询（原先逐项目 × 逐任务/里程碑/预算查询，
    2000 项目下耗时 2s+，现为常数级查询次数）。
    Stage 4A：每条预警都带 `ref_type` / `ref_id` / `project_id`，可直接构造可定位通知。
    """
    mw = int(_param(db, "milestone_warn_days", "3"))
    stagnant = int(_param(db, "stagnant_days", "7"))
    rate_line = float(_param(db, "budget_warn_rate", "0.8"))
    out = {"overdue_tasks": [], "milestones": [], "stagnant_projects": [],
           "budget_warnings": [], "followup_due": []}
    today = date.today()
    now = datetime.now(timezone.utc)
    pids = [p.id for p in projects]
    if not pids:
        return out

    # 1) 逾期任务：一次查询
    overdue = db.query(Task).filter(
        Task.project_id.in_(pids),
        Task.plan_end.isnot(None),
        Task.plan_end < today,
        Task.status != "done",
        Task.progress < 100,
    ).all()
    out["overdue_tasks"] = [
        {"task_id": t.id, "name": t.name, "project_id": t.project_id,
         "owner_id": t.owner_id, "ref_type": "task", "ref_id": t.id,
         "plan_end": t.plan_end.isoformat() if t.plan_end else None}
        for t in overdue
    ]

    # 2) 里程碑临近/逾期：一次查询（plan_date <= today + mw，未完成）
    miles = db.query(Milestone).filter(
        Milestone.project_id.in_(pids),
        Milestone.status == "open",
        Milestone.actual_date.is_(None),
        Milestone.plan_date.isnot(None),
        Milestone.plan_date <= today + timedelta(days=mw),
    ).all()
    out["milestones"] = [
        {"milestone_id": m.id, "name": m.name, "project_id": m.project_id,
         "owner_id": m.owner_id, "ref_type": "milestone", "ref_id": m.id,
         "overdue": m.plan_date < today, "days_left": (m.plan_date - today).days}
        for m in miles
    ]

    # 3) 停滞项目：一次聚合取每个项目最后一次填报时间
    last_map = dict(
        db.query(ProgressLog.project_id, func.max(ProgressLog.created_at))
        .filter(ProgressLog.project_id.in_(pids))
        .group_by(ProgressLog.project_id).all()
    )
    for p in projects:
        if p.status != "doing":
            continue
        ts = last_map.get(p.id)
        if ts is None:
            days = stagnant          # 从无填报视为停滞（与原逻辑一致）
        else:
            if ts.tzinfo is None:
                ts = ts.replace(tzinfo=timezone.utc)
            days = (now - ts).days
        if days >= stagnant:
            out["stagnant_projects"].append(
                {"project_id": p.id, "name": p.name, "days_no_log": days,
                 "ref_type": "project", "ref_id": p.id})

    # 4) 预算预警：预算与已通过支出各一次聚合（按 项目 × 科目）
    bud = dict(((pid_, s), float(a or 0)) for pid_, s, a in
               db.query(Budget.project_id, Budget.subject, func.sum(Budget.amount))
               .filter(Budget.project_id.in_(pids))
               .group_by(Budget.project_id, Budget.subject).all())
    spd = dict(((pid_, s), float(a or 0)) for pid_, s, a in
               db.query(Expense.project_id, Expense.subject, func.sum(Expense.amount))
               .filter(Expense.project_id.in_(pids), Expense.status.in_(PASS))
               .group_by(Expense.project_id, Expense.subject).all())
    for (pid_, subject), b in bud.items():
        if not b:
            continue
        s = spd.get((pid_, subject), 0.0)
        rate = round(s / b, 4)
        warn = rate >= rate_line
        over = s > b
        if warn or over:
            out["budget_warnings"].append(
                {"project_id": pid_, "subject": subject, "budget": round(b, 2),
                 "spent": round(s, 2), "balance": round(b - s, 2),
                 "rate": rate, "warn": warn, "over": over,
                 "ref_type": "project", "ref_id": pid_, "ref_key": f"{pid_}:{subject}"})

    due = due_followups(db, now)
    out["followup_due"] = [d for d in due if d["project_id"] in set(pids)]
    return out


def sync_notifications(db: Session, projects: list[Project] | None = None,
                       max_per_type: int = 50) -> dict:
    """把预警计算结果落库为站内通知（按去重窗口防重）。返回各类写入条数。

    性能与防刷量考虑：
      · 由调用方节流（见 routers/notifications.py 的 SYNC_INTERVAL），不每次请求都跑
      · 每类最多写入 max_per_type 条（取最紧急的前 N 条），避免 2000 项目下瞬间灌爆通知表

    引用完整性（Stage 4A）：每类通知都带 ref_type / ref_id / project_id 三元组，
    前端点击可定位到具体任务、里程碑、支出或跟进；预算预警的 ref 指向具体项目
    （科目维度的去重键仍按 项目:科目 区分，保证同项目不同科目互不影响）。
    """
    from .notify import admin_ids, push, push_many

    if projects is None:
        projects = db.query(Project).filter(Project.deleted_at.is_(None)).all()
    w = compute_warnings(db, projects)
    created = {"overdue_task": 0, "milestone": 0, "stagnant": 0, "budget": 0, "followup": 0}

    owner_of = {p.id: p.owner_id for p in projects}
    pids = list(owner_of.keys())
    if not pids:
        return {**created, "total": 0}

    task_ids = [x["task_id"] for x in w["overdue_tasks"][:max_per_type]]
    mile_ids = [x["milestone_id"] for x in w["milestones"][:max_per_type]]
    tasks = {t.id: t for t in db.query(Task).filter(Task.id.in_(task_ids)).all()} if task_ids else {}
    miles = {m.id: m for m in db.query(Milestone).filter(Milestone.id.in_(mile_ids)).all()} if mile_ids else {}

    for x in w["overdue_tasks"][:max_per_type]:
        t = tasks.get(x["task_id"])
        rcpt = [t.owner_id if t else None, owner_of.get(x["project_id"])]
        created["overdue_task"] += push_many(
            db, rcpt, "overdue_task", f"任务逾期：{x['name']}",
            f"计划结束 {x['plan_end']}，仍未完成", ref_type="task", ref_id=x["task_id"],
            project_id=x["project_id"], dedup_key=f"overdue_task:{x['task_id']}")

    for x in w["milestones"][:max_per_type]:
        m = miles.get(x["milestone_id"])
        rcpt = [m.owner_id if m else None, owner_of.get(x["project_id"])]
        state = "已逾期" if x["overdue"] else f"{x['days_left']} 天后到期"
        created["milestone"] += push_many(
            db, rcpt, "milestone", f"里程碑{state}：{x['name']}",
            f"计划日期 {m.plan_date.isoformat() if m and m.plan_date else ''}",
            ref_type="milestone", ref_id=x["milestone_id"],
            project_id=x["project_id"], dedup_key=f"milestone:{x['milestone_id']}")

    for x in w["stagnant_projects"][:max_per_type]:
        created["stagnant"] += push(
            db, owner_of.get(x["project_id"]), "stagnant",
            f"项目停滞 {x['days_no_log']} 天：{x['name']}",
            "连续多日无进度填报，请跟进", ref_type="project", ref_id=x["project_id"],
            project_id=x["project_id"], dedup_key=f"stagnant:{x['project_id']}")

    admins = admin_ids(db)
    for x in w["budget_warnings"][:max_per_type]:
        state = "已超预算" if x["over"] else f"执行率 {round(x['rate'] * 100, 1)}%"
        created["budget"] += push_many(
            db, [owner_of.get(x["project_id"]), *admins], "budget",
            f"预算预警（{x['subject']}）：{state}",
            f"预算 {x['budget']}，已支出 {x['spent']}",
            ref_type="project", ref_id=x["project_id"], project_id=x["project_id"],
            dedup_key=f"budget:{x['project_id']}:{x['subject']}")

    # 跟进提醒：推送后把跟进标记为已通知（remind_state=done），同一到期记录不会再次进入扫描
    pushable = [x for x in w["followup_due"][:max_per_type]
                if x.get("user_id") and x.get("project_id")]
    for x in pushable:
        created["followup"] += push(
            db, x["user_id"], "followup", "跟进提醒到期",
            (x["content"] or "")[:120], ref_type="followup", ref_id=x["followup_id"],
            project_id=x["project_id"], dedup_key=f"followup:{x['followup_id']}")
    mark_followup_reminded(db, [x["followup_id"] for x in pushable])

    db.commit()
    created["total"] = sum(created.values())
    return created


def main():
    """CLI 入口：python -m api.core.jobs（供 cron/launchd 每10min/每日02:00调用）。"""
    from .database import SessionLocal
    db = SessionLocal()
    try:
        due = due_followups(db)
        print(f"due_followups={len(due)}")
        for d in due[:20]:
            print(d)
        print("notifications:", sync_notifications(db))
    finally:
        db.close()
