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
from ..core.database import get_db
from ..core.deps import get_current_user
from ..core.rbac import get_active_project, require_admin, visible_project_ids
from ..models import Budget, BudgetAdjust, Project, SysParam, User

router = APIRouter(prefix="", tags=["budgets"])

SUBJECTS = {"人工", "采购", "外包", "差旅", "其他"}


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
def list_budgets(project_id: int = 0, db: Session = Depends(get_db),
                 user: User = Depends(get_current_user)):
    """预算列表：指定 project_id 时按该项目鉴权；否则只返回「可见 + 未软删除」项目的预算。"""
    q = db.query(Budget).order_by(Budget.id)
    if project_id:
        _project(db, project_id, user)
        q = q.filter_by(project_id=project_id)
    else:
        q = q.filter(Budget.project_id.in_(visible_project_ids(db, user)))
    return [_b(b, db) for b in q.all()]


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
def list_adjusts(project_id: int = 0, status: str = "", db: Session = Depends(get_db),
                 user: User = Depends(get_current_user)):
    """调整单列表：无 project_id 时只返回可见且未软删除项目的调整单。"""
    q = db.query(BudgetAdjust).order_by(BudgetAdjust.id.desc())
    if project_id:
        _project(db, project_id, user)
        q = q.filter_by(project_id=project_id)
    else:
        q = q.filter(BudgetAdjust.project_id.in_(visible_project_ids(db, user)))
    if status:
        q = q.filter_by(status=status)
    return [{"id": a.id, "budget_id": a.budget_id, "project_id": a.project_id,
             "old_amount": a.old_amount, "new_amount": a.new_amount,
             "reason": a.reason, "status": a.status, "by_id": a.by_id} for a in q.all()]


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
