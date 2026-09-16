"""预算（科目/期间校验）+ 调整 1 级审批。

权限契约（Stage 1 收敛）：预算调整审批只能由管理员决策（`/budget-adjusts/{aid}/approve`）；
仍保留普通用户按项目参与登记预算与提交调整申请的路径（需为项目负责人/成员）。
"""
from datetime import date

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..core.audit import write_audit
from ..core.costs import execution
from ..core.database import get_db, parse_date
from ..core.deps import get_current_user
from ..core.paging import DEFAULT_PAGE_SIZE, paginate
from ..core.rbac import (get_active_project, require_admin, scope_child_query,
                         visible_project_ids)
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
            "rate": ex["rate"], "warn": ex["warn"]}


def _project(db: Session, pid: int, user: User, write=False) -> Project:
    """子表接口的项目边界：未软删除 + 参与人校验（软删除项目一律 404）。"""
    return get_active_project(db, pid, user, write=write)


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
    """预算列表：统一分页信封 + 排序白名单（默认 `id` 升序）。

    指定 project_id 时按该项目鉴权；否则只返回「可见 + 未软删除」项目的预算（下推 SQL）。
    """
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
    if body.subject not in SUBJECTS:
        raise HTTPException(400, f"科目须为 {sorted(SUBJECTS)}")
    if body.amount < 0:
        raise HTTPException(400, "预算金额不能为负")
    if body.period_start and body.period_end and body.period_start > body.period_end:
        raise HTTPException(400, "预算期间开始不能晚于结束")
    if p.plan_start and body.period_start and body.period_start < p.plan_start:
        raise HTTPException(400, "预算期间须落在项目计划起止内")
    if p.plan_end and body.period_end and body.period_end > p.plan_end:
        raise HTTPException(400, "预算期间须落在项目计划起止内")
    b = Budget(project_id=body.project_id, subject=body.subject, amount=body.amount,
               period_start=body.period_start, period_end=body.period_end)
    db.add(b)
    db.commit()
    write_audit(db, user.id, "create_budget", "budgets", b.id, f"{body.subject} {body.amount}")
    return _b(b, db)


@router.patch("/budgets/{bid}")
def adjust_request(bid: int, body: dict, db: Session = Depends(get_db),
                   user: User = Depends(get_current_user)):
    """预算调整走 1 级审批：先建 adjust 单，管理员批后生效并留痕。"""
    b = db.query(Budget).filter_by(id=bid).first()
    if not b:
        raise HTTPException(404, "预算不存在")
    _project(db, b.project_id, user, write=True)
    new_amount = float(body.get("amount", b.amount))
    reason = body.get("reason", "")
    adj = BudgetAdjust(budget_id=bid, project_id=b.project_id, old_amount=b.amount,
                       new_amount=new_amount, reason=reason, by_id=user.id)
    on = db.query(SysParam).filter_by(key="budget_approval_on").first()
    auto = not on or on.value == "0"
    if auto:
        # 开关关闭 = 系统自动生效，不是人工审批：approved_by 留空，避免申请人被记为审批人
        b.amount = new_amount
        adj.status = "approved"
        adj.approved_by = None
    db.add(adj)
    db.commit()
    if adj.status == "pending":
        from ..core.notify import approval_recipients, push_many
        push_many(db, approval_recipients(db), "approval",
                  f"预算调整待审批：{b.subject}",
                  f"{adj.old_amount} → {new_amount}" + (f"｜{reason}" if reason else ""),
                  ref_type="budget_adjust", ref_id=adj.id, project_id=b.project_id,
                  dedup_key=f"adjust-request:{adj.id}")
        db.commit()
    write_audit(db, user.id, "adjust_budget", "budget_adjusts", adj.id,
                f"budget={bid} {adj.old_amount}->{new_amount}" + (" auto" if auto else ""))
    return {"id": adj.id, "status": adj.status}


@router.get("/budget-adjusts")
def list_adjusts(project_id: int = 0, status: str = "", budget_id: int = 0,
                 sort: str = "-id", page: int = 1, size: int = DEFAULT_PAGE_SIZE,
                 db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """调整单列表：统一分页信封（默认 `-id` 最新在前）+ 排序白名单。

    无 project_id 时只返回可见且未软删除项目的调整单（下推 SQL，不再全量载入）。
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

    def _adj(a: BudgetAdjust):
        return {"id": a.id, "budget_id": a.budget_id, "project_id": a.project_id,
                "old_amount": a.old_amount, "new_amount": a.new_amount,
                "reason": a.reason, "status": a.status, "by_id": a.by_id}

    return paginate(q, page=page, size=size, allowed=ADJUST_SORTS,
                    default_sort="-id", sort=sort, map_row=_adj)


@router.post("/budget-adjusts/{aid}/approve")
def approve_adjust(aid: int, body: dict, db: Session = Depends(get_db),
                   user: User = Depends(get_current_user)):
    """预算调整决策（仅管理员）：先鉴权，非管理员稳定 403 且不产生状态变更。"""
    require_admin(user)
    a = db.query(BudgetAdjust).filter_by(id=aid).first()
    if not a or a.status != "pending":
        raise HTTPException(404, "调整单不存在或已处理")
    # 决策边界：软删除项目的调整单不可处理
    get_active_project(db, a.project_id, msg="项目已删除，调整单不可处理")
    ok = body.get("approve", True)
    a.status = "approved" if ok else "rejected"
    a.approved_by = user.id
    if ok:
        b = db.query(Budget).filter_by(id=a.budget_id).first()
        if b:
            b.amount = a.new_amount
    db.commit()
    write_audit(db, user.id, "approve_adjust", "budget_adjusts", aid, a.status)
    return {"id": aid, "status": a.status}
