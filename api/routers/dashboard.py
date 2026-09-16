"""Stage 4：工作台汇总 + 项目健康度 + 周报数据。

优化要点（Stage 5 一并落地）：全部用聚合查询（GROUP BY）取数，避免 项目×科目 的 N+1。
"""
from datetime import date, datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func
from sqlalchemy.orm import Session

from ..core.costs import PASS
from ..core.database import get_db
from ..core.deps import get_current_user
from ..core.rbac import can_approve, visible_project_condition
from ..models import (Budget, BudgetAdjust, Expense, Milestone, Notification,
                      ProgressLog, Project, ProjectMember, Task, User)

router = APIRouter(prefix="/dashboard", tags=["dashboard"])


def _visible(db: Session, user: User) -> list[Project]:
    """可见项目（过滤软删除 + 权限下推 SQL）。"""
    q = db.query(Project).filter(Project.deleted_at.is_(None))
    vis = visible_project_condition(user)
    if vis is not None:
        q = q.filter(vis)
    return q.all()


def healthy(progress: float, rate: float, overdue: int, stagnant_days: int,
            status: str) -> str:
    """健康度：bad（逾期/停滞/超支）> risk（临近预警）> ok > closed。"""
    if status in ("cancelled", "archived"):
        return "closed"
    if overdue > 0 or stagnant_days >= 14 or rate > 1:
        return "bad"
    if stagnant_days >= 7 or rate >= 0.8:
        return "risk"
    return "ok"


@router.get("/summary")
def summary(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """工作台 KPI + 图表数据（趋势 / 科目占比）+ 项目健康度列表。"""
    projects = _visible(db, user)
    pids = [p.id for p in projects]
    now = datetime.now(timezone.utc)
    today = date.today()
    month = today.strftime("%Y-%m")

    # 我参与的项目（成员或负责人）
    my_ids = {m.project_id for m in db.query(ProjectMember).filter_by(user_id=user.id).all()}
    my_projects = [p for p in projects if p.id in my_ids or p.owner_id == user.id]

    # 逾期任务（一次取全量后按 project 分组，避免逐项目查询）
    tasks = db.query(Task).filter(Task.project_id.in_(pids)).all() if pids else []
    overdue_tasks = [
        t for t in tasks
        if t.plan_end and t.plan_end < today and (t.progress or 0) < 100 and t.status != "done"
    ]
    overdue_by_project: dict[int, int] = {}
    for t in overdue_tasks:
        overdue_by_project[t.project_id] = overdue_by_project.get(t.project_id, 0) + 1
    my_task_ids = {t.id for t in tasks if t.owner_id == user.id}

    # 停滞天数：按项目取最后一次填报时间（一次查询）
    last_log = dict(
        db.query(ProgressLog.project_id, func.max(ProgressLog.created_at))
        .filter(ProgressLog.project_id.in_(pids))
        .group_by(ProgressLog.project_id).all()
    ) if pids else {}
    stagnant_days: dict[int, int] = {}
    for p in projects:
        ts = last_log.get(p.id)
        if ts is None:
            stagnant_days[p.id] = 999  # 从无填报
        else:
            if ts.tzinfo is None:
                ts = ts.replace(tzinfo=timezone.utc)
            stagnant_days[p.id] = max(0, (now - ts).days)

    # 预算 / 支出：一次聚合（GROUP BY 项目、科目），替代逐项目逐科目查询
    bud_rows = db.query(Budget.project_id, Budget.subject, func.sum(Budget.amount)) \
        .filter(Budget.project_id.in_(pids)).group_by(Budget.project_id, Budget.subject).all() if pids else []
    exp_rows = db.query(Expense.project_id, Expense.subject, func.sum(Expense.amount)) \
        .filter(Expense.project_id.in_(pids), Expense.status.in_(PASS)) \
        .group_by(Expense.project_id, Expense.subject).all() if pids else []

    budget_map: dict[int, float] = {}
    by_subject: dict[str, dict[str, float]] = {}
    for pid_, subject, amt in bud_rows:
        budget_map[pid_] = budget_map.get(pid_, 0) + (amt or 0)
        by_subject.setdefault(subject or "其他", {"budget": 0.0, "spent": 0.0})["budget"] += amt or 0
    spent_map: dict[int, float] = {}
    for pid_, subject, amt in exp_rows:
        spent_map[pid_] = spent_map.get(pid_, 0) + (amt or 0)
        by_subject.setdefault(subject or "其他", {"budget": 0.0, "spent": 0.0})["spent"] += amt or 0

    total_budget = sum(budget_map.values())
    total_spent = sum(spent_map.values())

    # 近 6 个月支出趋势（一次查询后按月聚合）
    start = (today.replace(day=1) - timedelta(days=155)).replace(day=1)
    monthly_rows = db.query(Expense.exp_date, func.sum(Expense.amount)) \
        .filter(Expense.project_id.in_(pids), Expense.status.in_(PASS),
                Expense.exp_date >= start).group_by(Expense.exp_date).all() if pids else []
    trend_map: dict[str, float] = {}
    for d_, amt in monthly_rows:
        if not d_:
            continue
        trend_map[d_.strftime("%Y-%m")] = trend_map.get(d_.strftime("%Y-%m"), 0) + (amt or 0)
    trend = []
    cur = today.replace(day=1)
    for i in range(5, -1, -1):
        y, m = cur.year, cur.month - i
        while m <= 0:
            m += 12
            y -= 1
        key = f"{y:04d}-{m:02d}"
        trend.append({"month": key, "spent": round(trend_map.get(key, 0), 2)})

    # 本月支出
    month_spent = round(trend_map.get(month, 0), 2)

    # 待我审批：只有管理员有审批资格，其他人恒为 0（与审批中心入口同一判定）
    if can_approve(user):
        filings = db.query(func.count(Project.id)).filter(
            Project.status == "pending", Project.deleted_at.is_(None)).scalar() or 0
        adjusts = db.query(func.count(BudgetAdjust.id)).filter_by(status="pending").scalar() or 0
        pending_expenses = db.query(func.count(Expense.id)).filter_by(status="pending").scalar() or 0
        pending_approvals = int(filings + adjusts + pending_expenses)
    else:
        pending_approvals = 0

    # 里程碑临近/逾期
    miles = db.query(Milestone).filter(Milestone.project_id.in_(pids), Milestone.status == "open").all() if pids else []
    near_milestones = [
        m for m in miles
        if m.plan_date and not m.actual_date and (m.plan_date - today).days <= 3
    ]

    # 项目健康度列表（进行中优先）
    def health_row(p: Project):
        b = budget_map.get(p.id, 0)
        s = spent_map.get(p.id, 0)
        rate = round(s / b, 4) if b else 0
        od = overdue_by_project.get(p.id, 0)
        sd = stagnant_days.get(p.id, 0)
        return {"id": p.id, "code": p.code, "name": p.name, "status": p.status,
                "priority": p.priority, "owner_id": p.owner_id,
                "progress": p.progress or 0, "plan_end": p.plan_end.isoformat() if p.plan_end else None,
                "budget": round(b, 2), "spent": round(s, 2), "rate": rate,
                "overdue_tasks": od, "stagnant_days": sd,
                "health": healthy(p.progress or 0, rate, od, sd, p.status)}

    health = [health_row(p) for p in projects]
    health.sort(key=lambda x: ({"bad": 0, "risk": 1, "ok": 2, "closed": 3}[x["health"]], -x["progress"]))

    unread = db.query(func.count(Notification.id)).filter(
        Notification.user_id == user.id, Notification.read_at.is_(None)).scalar() or 0

    return {
        "kpi": {
            "my_projects": len(my_projects),
            "active_projects": len([p for p in projects if p.status in ("filed", "doing")]),
            "overdue_tasks": len(overdue_tasks),
            "my_overdue_tasks": len([t for t in overdue_tasks if t.id in my_task_ids]),
            "near_milestones": len(near_milestones),
            "stagnant_projects": len([p for p in projects if p.status == "doing" and stagnant_days.get(p.id, 0) >= 7]),
            "total_budget": round(total_budget, 2),
            "total_spent": round(total_spent, 2),
            "total_rate": round(total_spent / total_budget, 4) if total_budget else 0,
            "month_spent": month_spent,
            "month": month,
            "pending_approvals": pending_approvals,
            "unread_notifications": int(unread),
        },
        "trend": trend,
        "by_subject": [{"subject": k, **{kk: round(vv, 2) for kk, vv in v.items()}}
                       for k, v in sorted(by_subject.items())],
        "health": health[:20],
    }


@router.get("/health")
def health_only(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """只取项目健康度（供列表页打标）。"""
    return {"items": summary(db, user)["health"]}


@router.get("/my-weekly")
def my_weekly(project_id: int = 0, db: Session = Depends(get_db),
              user: User = Depends(get_current_user)):
    """周报数据：本周填报、进度变化、逾期、待办。"""
    projects = _visible(db, user)
    if project_id:
        projects = [p for p in projects if p.id == project_id]
        if not projects:
            raise HTTPException(404, "项目不存在或无权访问")
    pids = [p.id for p in projects]
    now = datetime.now(timezone.utc)
    week_ago = now - timedelta(days=7)

    logs = db.query(ProgressLog).filter(ProgressLog.project_id.in_(pids)).all() if pids else []
    week_logs = []
    for l in logs:
        ts = l.created_at
        if ts and ts.tzinfo is None:
            ts = ts.replace(tzinfo=timezone.utc)
        if ts and ts >= week_ago:
            week_logs.append(l)

    tasks = db.query(Task).filter(Task.project_id.in_(pids)).all() if pids else []
    today = date.today()
    overdue = [t for t in tasks
               if t.plan_end and t.plan_end < today and (t.progress or 0) < 100 and t.status != "done"]
    due_soon = [t for t in tasks
                if t.plan_end and today <= t.plan_end <= today + timedelta(days=7)
                and (t.progress or 0) < 100]

    return {
        "range": {"from": week_ago.date().isoformat(), "to": today.isoformat()},
        "project_id": project_id or None,
        "progress_logs": [{"task_id": l.task_id, "project_id": l.project_id, "user_id": l.user_id,
                           "progress": l.progress, "note": l.note,
                           "created_at": l.created_at.isoformat() if l.created_at else None}
                          for l in sorted(week_logs, key=lambda x: x.id, reverse=True)][:50],
        "log_count": len(week_logs),
        "overdue": [{"id": t.id, "name": t.name, "project_id": t.project_id,
                     "plan_end": t.plan_end.isoformat() if t.plan_end else None,
                     "progress": t.progress, "owner_id": t.owner_id} for t in overdue],
        "due_soon": [{"id": t.id, "name": t.name, "project_id": t.project_id,
                      "plan_end": t.plan_end.isoformat() if t.plan_end else None,
                      "progress": t.progress, "owner_id": t.owner_id} for t in due_soon],
        "projects": [{"id": p.id, "code": p.code, "name": p.name, "status": p.status,
                      "progress": p.progress or 0} for p in projects],
    }
