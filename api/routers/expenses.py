"""支出登记 + 审批/驳回/特批。超预算默认拦截，特批放行。

权限契约（Stage 1 收敛）：审批、驳回、特批只能由管理员执行（先鉴权，非管理员稳定 403）；
普通用户仍可按项目参与登记支出（需为项目负责人/成员）。
"""
from datetime import date

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..core.audit import write_audit
from ..core.costs import PASS, budget_total, execution, spent
from ..core.database import get_db
from ..core.deps import get_current_user
from ..core.rbac import get_active_project, require_admin, visible_project_ids
from ..models import Expense, SysParam, User

router = APIRouter(prefix="/expenses", tags=["expenses"])


def _e(e: Expense):
    return {"id": e.id, "project_id": e.project_id, "subject": e.subject,
            "amount": e.amount, "exp_date": e.exp_date.isoformat() if e.exp_date else None,
            "note": e.note, "status": e.status, "by_id": e.by_id}


def _over(db: Session, project_id: int, subject: str, extra: float) -> bool:
    b = budget_total(db, project_id, subject)
    return bool(b) and (spent(db, project_id, subject) + extra > b)


class ExpenseIn(BaseModel):
    project_id: int
    subject: str = ""
    amount: float
    exp_date: date | None = None
    note: str = ""


@router.get("")
def list_expenses(project_id: int = 0, status: str = "",
                  page: int = 0, size: int = 20,
                  db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """支出列表：指定 project_id 时按该项目鉴权；否则只返回「可见 + 未软删除」项目的支出。"""
    q = db.query(Expense).order_by(Expense.id.desc())
    if project_id:
        get_active_project(db, project_id, user)
        q = q.filter_by(project_id=project_id)
    else:
        q = q.filter(Expense.project_id.in_(visible_project_ids(db, user)))
    if status:
        q = q.filter_by(status=status)
    total = q.count()
    rows = q.all() if not page else q.offset((max(page, 1) - 1) * size).limit(size).all()
    items = [_e(e) for e in rows]
    if not page:
        return items
    return {"total": total, "page": max(page, 1), "size": size, "items": items}


@router.post("")
def create_expense(body: ExpenseIn, db: Session = Depends(get_db),
                   user: User = Depends(get_current_user)):
    p = get_active_project(db, body.project_id, user, write=True)
    if body.amount <= 0:
        raise HTTPException(400, "支出金额须大于 0")
    on = db.query(SysParam).filter_by(key="expense_approval_on").first()
    approval_on = bool(on and on.value == "1")
    over = _over(db, body.project_id, body.subject, body.amount)
    if over and not approval_on:
        # 审批关闭时直接计入执行，超预算必须拦截（只能调预算或先开审批走特批）
        raise HTTPException(400, "超预算已拦截：请调预算或走特批")
    st = "pending" if (approval_on or over) else "approved"
    e = Expense(project_id=body.project_id, subject=body.subject, amount=body.amount,
                exp_date=body.exp_date, note=body.note, status=st, by_id=user.id)
    db.add(e)
    db.commit()
    if st == "pending":
        # 待审批：通知审批人（当前契约下唯一审批人 = 管理员）
        from ..core.notify import approval_recipients, push_many
        push_many(db, approval_recipients(db), "approval",
                  f"支出待审批：{body.subject} {body.amount} 元",
                  f"项目 {p.name}｜{body.note or '无说明'}"
                  + ("｜超预算需特批" if over else ""),
                  ref_type="expense", ref_id=e.id, project_id=p.id,
                  dedup_key=f"expense-request:{e.id}")
        db.commit()
    ex = execution(db, body.project_id, body.subject)
    write_audit(db, user.id, "create_expense", "expenses", e.id, f"{body.amount} {st}")
    r = _e(e)
    r["execution"] = ex  # 返回实时执行率；warn=True 即 80% 提醒
    return r


@router.post("/{eid}/approve")
def approve(eid: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """支出通过（仅管理员）。"""
    require_admin(user)
    e = db.query(Expense).filter_by(id=eid).first()
    if not e or e.status != "pending":
        raise HTTPException(404, "支出不存在或不在待审批")
    get_active_project(db, e.project_id, msg="项目已删除，该支出不可处理")
    if _over(db, e.project_id, e.subject, e.amount):
        raise HTTPException(400, "超预算：通过前请先调预算或走特批")
    e.status, e.approved_by = "approved", user.id
    db.commit()
    write_audit(db, user.id, "approve_expense", "expenses", eid, "approved")
    return _e(e)


@router.post("/{eid}/reject")
def reject(eid: int, body: dict, db: Session = Depends(get_db),
           user: User = Depends(get_current_user)):
    """支出驳回（仅管理员）。"""
    require_admin(user)
    e = db.query(Expense).filter_by(id=eid).first()
    if not e or e.status != "pending":
        raise HTTPException(404, "支出不存在或不在待审批")
    get_active_project(db, e.project_id, msg="项目已删除，该支出不可处理")
    e.status, e.approved_by = "rejected", user.id
    db.commit()
    write_audit(db, user.id, "reject_expense", "expenses", eid, body.get("reason", ""))
    return _e(e)


@router.post("/{eid}/exception")
def exception(eid: int, body: dict, db: Session = Depends(get_db),
              user: User = Depends(get_current_user)):
    """特批放行超预算支出（仅管理员）。"""
    require_admin(user)
    e = db.query(Expense).filter_by(id=eid).first()
    if not e or e.status not in ("pending", "rejected"):
        if not e:
            raise HTTPException(404, "支出不存在")
        raise HTTPException(400, "仅待审批/已驳回可特批")
    get_active_project(db, e.project_id, msg="项目已删除，该支出不可处理")
    e.status, e.approved_by = "exception", user.id
    db.commit()
    write_audit(db, user.id, "exception_expense", "expenses", eid, body.get("reason", "特批"))
    return _e(e)
