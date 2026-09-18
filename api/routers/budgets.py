"""预算（科目/期间校验）+ 调整 1 级审批 + 申请人可查时间线（Stage 4A 补齐）。

权限契约（Stage 1 收敛）：预算调整审批只能由管理员决策（`/budget-adjusts/{aid}/approve`
与 `/approvals/budget_adjust/{aid}/decide`）；普通用户按项目参与登记预算与提交调整申请。

Stage 4A 补齐：
  · 金额/期间/科目全部先校验（负数、NaN、期间倒置、越出项目计划区间一律 400 且零副作用）；
  · 调整单带 `decision_reason` / `decided_at`，申请人可查「谁在什么时候因为什么批/驳」；
  · `GET /budget-adjusts/{aid}/timeline` 对申请人开放（不依赖管理员专属审计日志）。
"""
from datetime import date

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..core.audit import commit_audited
from ..core.costs import execution
from ..core.database import get_db
from ..core.deps import get_current_user
from ..core.paging import DEFAULT_PAGE_SIZE, paginate
from ..core.rbac import (
    can_read_project,
    get_active_project,
    require_admin,
    scope_child_query,
)
from ..core.timeline import (
    ACTION_APPROVE,
    ACTION_AUTO,
    ACTION_REJECT,
    ACTION_SUBMIT,
    KIND_BUDGET_ADJUST,
    timeline,
)
from ..core.timeutil import app_now, iso
from ..core.validation import check_amount, check_choice, check_date_range
from ..models import Budget, BudgetAdjust, Project, SysParam, User

router = APIRouter(prefix="", tags=["budgets"])

SUBJECTS = {"人工", "采购", "外包", "差旅", "其他"}

# 排序白名单（Stage 3A）：字段名 → ORM 列
BUDGET_SORTS = {
    "id": Budget.id, "project_id": Budget.project_id, "subject": Budget.subject,
    "amount": Budget.amount, "period_start": Budget.period_start,
    "period_end": Budget.period_end, "created_at": Budget.created_at,
}
ADJUST_SORTS = {
    "id": BudgetAdjust.id, "project_id": BudgetAdjust.project_id,
    "old_amount": BudgetAdjust.old_amount, "new_amount": BudgetAdjust.new_amount,
    "status": BudgetAdjust.status, "created_at": BudgetAdjust.created_at,
}


def _b(b: Budget, db: Session):
    ex = execution(db, b.project_id, b.subject)
    return {"id": b.id, "project_id": b.project_id, "subject": b.subject,
            "amount": b.amount,
            "period_start": b.period_start.isoformat() if b.period_start else None,
            "period_end": b.period_end.isoformat() if b.period_end else None,
            "spent": ex["spent"], "balance": ex["balance"],
            "rate": ex["rate"], "warn": ex["warn"],
            "over": ex.get("over", False)}


def _adj_row(a: BudgetAdjust, subject: str = ""):
    return {"id": a.id, "budget_id": a.budget_id, "project_id": a.project_id,
            "subject": subject,
            "old_amount": a.old_amount, "new_amount": a.new_amount,
            "reason": a.reason, "status": a.status, "by_id": a.by_id,
            "approved_by": a.approved_by,
            "decision_reason": a.decision_reason or "",
            "decided_at": iso(a.decided_at),
            "can_approve_adjust": a.status == "pending",
            "created_at": iso(a.created_at)}


def _project(db: Session, pid: int, user: User, write=False) -> Project:
    """子表接口的项目边界：未软删除 + 参与人校验（软删除项目一律 404）。"""
    return get_active_project(db, pid, user, write=write)


def _check_period(period_start: date | None, period_end: date | None, p: Project) -> None:
    check_date_range(period_start, period_end, start_field="预算期间开始",
                     end_field="预算期间结束")
    if p.plan_start and period_start and period_start < p.plan_start:
        raise HTTPException(400, "预算期间须落在项目计划起止内")
    if p.plan_end and period_end and period_end > p.plan_end:
        raise HTTPException(400, "预算期间须落在项目计划起止内")


class BudgetIn(BaseModel):
    project_id: int
    subject: str
    amount: float
    period_start: date | None = None
    period_end: date | None = None


@router.get("/budgets")
def list_budgets(project_id: int = 0, subject: str = "", sort: str = "id",
                 page: int = 1, size: int = DEFAULT_PAGE_SIZE,
                 db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """预算列表：统一分页信封 + 排序白名单（默认 `id` 升序）。"""
    q = db.query(Budget)
    if project_id:
        _project(db, project_id, user)
        q = q.filter(Budget.project_id == project_id)
    else:
        q = scope_child_query(q, Budget, db, user)
    if subject:
        q = q.filter(Budget.subject == subject)
    return paginate(q, page=page, size=size, allowed=BUDGET_SORTS,
                    default_sort="id", sort=sort,
                    map_row=lambda b: _b(b, db))


@router.post("/budgets")
def create_budget(body: BudgetIn, db: Session = Depends(get_db),
                  user: User = Depends(get_current_user)):
    p = _project(db, body.project_id, user, write=True)
    if p.status == "archived":
        raise HTTPException(400, "已归档项目只读")
    check_choice(str(body.subject or "").strip(), SUBJECTS, field="科目")
    amount = check_amount(body.amount, field="预算金额", allow_zero=True)
    _check_period(body.period_start, body.period_end, p)
    b = Budget(project_id=body.project_id, subject=body.subject, amount=amount,
               period_start=body.period_start, period_end=body.period_end)
    db.add(b)
    db.flush()
    commit_audited(db, user.id, "create_budget", "budgets", b.id,
                   f"{body.subject} {amount}")
    return _b(b, db)


@router.patch("/budgets/{bid}")
def adjust_request(bid: int, body: dict, db: Session = Depends(get_db),
                   user: User = Depends(get_current_user)):
    """预算调整走 1 级审批：先建 adjust 单，管理员批后生效并留痕。

    审批开关关闭时系统自动生效（`ACTION_AUTO`，`approved_by` 留空）——
    自动生效不是人工审批，不把申请人误记为审批人。
    """
    b = db.query(Budget).filter_by(id=bid).first()
    if not b:
        raise HTTPException(404, "预算不存在")
    p = _project(db, b.project_id, user, write=True)
    if p.status == "archived":
        raise HTTPException(400, "已归档项目只读")
    new_amount = check_amount(body.get("amount", b.amount), field="调整后金额", allow_zero=True)
    reason = str(body.get("reason", "") or "").strip()
    if new_amount == b.amount:
        raise HTTPException(400, "调整后金额与当前预算相同，无需提交调整")

    adj = BudgetAdjust(budget_id=bid, project_id=b.project_id, old_amount=b.amount,
                       new_amount=new_amount, reason=reason, by_id=user.id,
                       created_at=app_now())
    on = db.query(SysParam).filter_by(key="budget_approval_on").first()
    auto = not on or on.value == "0"
    if auto:
        b.amount = new_amount
        adj.status = "approved"
        adj.approved_by = None
        adj.decided_at = app_now()
        adj.decision_reason = "审批开关关闭，系统自动生效"
    db.add(adj)
    db.flush()

    from ..core.timeline import record as record_timeline
    record_timeline(db, KIND_BUDGET_ADJUST, adj.id, ACTION_SUBMIT, from_status="",
                    to_status="pending", project_id=b.project_id, actor_id=user.id,
                    reason=reason)
    if auto:
        record_timeline(db, KIND_BUDGET_ADJUST, adj.id, ACTION_AUTO, from_status="pending",
                        to_status="approved", project_id=b.project_id, actor_id=None,
                        reason="审批开关关闭，系统自动生效")
    commit_audited(db, user.id, "adjust_budget", "budget_adjusts", adj.id,
                   f"budget={bid} {adj.old_amount}->{new_amount}" + (" auto" if auto else ""))

    if adj.status == "pending":
        from ..core.notify import approval_recipients, push_many
        push_many(db, approval_recipients(db), "approval",
                  f"预算调整待审批：{b.subject}",
                  f"{adj.old_amount} → {new_amount}" + (f"｜{reason}" if reason else ""),
                  ref_type="budget_adjust", ref_id=adj.id, project_id=b.project_id,
                  dedup_key=f"adjust-request:{adj.id}")
        db.commit()
    return {"id": adj.id, "status": adj.status, "project_id": b.project_id,
            "subject": b.subject, "old_amount": adj.old_amount, "new_amount": new_amount,
            "decision_reason": adj.decision_reason or ""}


@router.get("/budget-adjusts")
def list_adjusts(project_id: int = 0, status: str = "", budget_id: int = 0,
                 mine: int = 0, sort: str = "-id", page: int = 1,
                 size: int = DEFAULT_PAGE_SIZE,
                 db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """调整单列表：统一分页信封（默认 `-id` 最新在前）+ 排序白名单。

    `mine=1` 只返回当前用户提交的调整单，供申请人自查审批意见与状态。
    """
    q = db.query(BudgetAdjust)
    if project_id:
        _project(db, project_id, user)
        q = q.filter(BudgetAdjust.project_id == project_id)
    else:
        q = scope_child_query(q, BudgetAdjust, db, user)
    if status:
        q = q.filter(BudgetAdjust.status == status)
    if budget_id:
        q = q.filter(BudgetAdjust.budget_id == budget_id)
    if mine:
        q = q.filter(BudgetAdjust.by_id == user.id)

    subjects = {bid_: subj for bid_, subj in db.query(Budget.id, Budget.subject).all()}
    return paginate(q, page=page, size=size, allowed=ADJUST_SORTS,
                    default_sort="-id", sort=sort,
                    map_row=lambda a: _adj_row(a, subjects.get(a.budget_id, "")))


@router.get("/budget-adjusts/{aid}/timeline")
def adjust_timeline(aid: int, db: Session = Depends(get_db),
                    user: User = Depends(get_current_user)):
    """调整单时间线：申请人可查自己单据的审批状态变化与意见。"""
    a = db.query(BudgetAdjust).filter_by(id=aid).first()
    if not a:
        raise HTTPException(404, "调整单不存在")
    p = get_active_project(db, a.project_id)
    if not can_read_project(user, p):
        raise HTTPException(403, "无权访问该调整单")
    return {"id": a.id, "status": a.status, "decision_reason": a.decision_reason or "",
            "items": timeline(db, KIND_BUDGET_ADJUST, aid)}


@router.post("/budget-adjusts/{aid}/approve")
def approve_adjust(aid: int, body: dict, db: Session = Depends(get_db),
                   user: User = Depends(get_current_user)):
    """预算调整决策（仅管理员）：先鉴权，非管理员稳定 403 且不产生状态变更。"""
    require_admin(user)
    a = db.query(BudgetAdjust).filter_by(id=aid).first()
    if not a or a.status != "pending":
        raise HTTPException(404, "调整单不存在或已处理")
    get_active_project(db, a.project_id, msg="项目已删除，调整单不可处理")
    ok = bool(body.get("approve", True))
    reason = str(body.get("reason", "") or "").strip()
    if not ok and not reason:
        raise HTTPException(400, "驳回必须填写意见")

    b = db.query(Budget).filter_by(id=a.budget_id).first()
    if ok and b and a.new_amount < 0:
        raise HTTPException(400, "调整后金额不能为负")
    a.status = "approved" if ok else "rejected"
    a.approved_by = user.id
    a.decision_reason = reason
    a.decided_at = app_now()
    if ok and b:
        b.amount = a.new_amount

    from ..core.timeline import record as record_timeline
    record_timeline(db, KIND_BUDGET_ADJUST, aid, ACTION_APPROVE if ok else ACTION_REJECT,
                    from_status="pending", to_status=a.status, project_id=a.project_id,
                    actor_id=user.id, reason=reason)
    commit_audited(db, user.id, "approve_adjust", "budget_adjusts", aid,
                   f"{a.status} {reason}")

    from ..core.notify import push
    push(db, a.by_id, "approval",
         f"预算调整{'通过' if ok else '驳回'}：{(b.subject if b else '')}",
         reason or f"{a.old_amount} → {a.new_amount}",
         ref_type="budget_adjust", ref_id=a.id, project_id=a.project_id,
         dedup_key=f"adjust-decided:{a.id}")
    db.commit()
    return _adj_row(a, b.subject if b else "")
