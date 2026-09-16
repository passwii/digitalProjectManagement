"""审批中心：聚合三类待办：立项审批 / 预算调整 / 支出，统一决策入口。

权限契约（Stage 1 收敛）：审批中心属于管理与审批面，仅管理员可用；
  · 列表、决策、特批四处共用 core.rbac.can_approve 判定 → 列表可见性与决策放行永远一致；
  · 决策入口先做管理员校验，非管理员稳定 403 且不会产生任何业务状态变更。

设计：不新建重复状态表——分别复用各域已有的 pending 状态与状态机：
  立项  → projects.status == "pending"（待立项审批），通过转 filed，驳回转 cancelled
  预算调整 → budget_adjusts.status == "pending"
  支出   → expenses.status == "pending"
"""
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..core.audit import write_audit
from ..core.database import get_db
from ..core.deps import get_current_user
from ..core.notify import push
from ..core.rbac import can_approve, get_active_project, require_admin
from ..models import (Budget, BudgetAdjust, Expense, Project, ProjectChange,
                      User)

router = APIRouter(prefix="/approvals", tags=["approvals"])


@router.get("/pending")
def pending(limit: int = 200, db: Session = Depends(get_db),
            user: User = Depends(get_current_user)):
    """管理员审批中心：全局三类待办聚合（跨部门、跨项目，仅含未软删除项目的记录）。

    查询边界（Stage 3A）：每类待办服务端最多返回 `limit` 条（默认 200，上限 500），
    并用 `totals` 同时回传三类待办的真实总数，避免待办积压时响应无界放大（前端可据此提示“还有 N 条”）。
    行内 `can_decide` 与决策入口共用 `core.rbac.can_approve`，不存在「按钮可见但接口 403」的错位。
    兼容旧客户端：`total` 仍为三类待办总数，`project_filings` / `budget_adjusts` / `expenses` 三个键不变。
    """
    require_admin(user)
    if limit < 1 or limit > 500:
        raise HTTPException(400, f"limit 须为 1-500 的整数，收到 {limit!r}")

    from sqlalchemy import select

    from ..core.rbac import is_admin  # noqa: F401  (保持模块导入清晰，便于后续扩展)

    active = select(Project.id).where(Project.deleted_at.is_(None))
    adjust_q = db.query(BudgetAdjust).filter(BudgetAdjust.status == "pending",
                                            BudgetAdjust.project_id.in_(active))
    expense_q = db.query(Expense).filter(Expense.status == "pending",
                                         Expense.project_id.in_(active))
    filing_q = db.query(Project).filter(Project.status == "pending",
                                        Project.deleted_at.is_(None))

    # 总数（不截断）与当页行分开取：前端既能显示“还有多少条”，又不会拉到无界数据
    totals = {
        "project_filings": filing_q.count(),
        "budget_adjusts": adjust_q.count(),
        "expenses": expense_q.count(),
    }
    filings = filing_q.order_by(Project.id.desc()).limit(limit).all()
    adjusts = adjust_q.order_by(BudgetAdjust.id.desc()).limit(limit).all()
    expenses = expense_q.order_by(Expense.id.desc()).limit(limit).all()

    # 批量取关联名称（原实现每行一次查询，待办多时是 N+1 热点）
    project_ids = {p.id for p in filings} | {a.project_id for a in adjusts} \
        | {e.project_id for e in expenses}
    project_names = {
        pid: name for pid, name in
        db.query(Project.id, Project.name).filter(Project.id.in_(project_ids or [0])).all()
    } if project_ids else {}
    budget_subjects = {
        bid: subject for bid, subject in
        db.query(Budget.id, Budget.subject).filter(
            Budget.id.in_({a.budget_id for a in adjusts} or [0])).all()
    } if adjusts else {}

    decide = can_approve(user)

    def filing_row(p: Project):
        return {"kind": "project_filing", "id": p.id, "project_id": p.id, "code": p.code,
                "name": p.name, "owner_id": p.owner_id, "budget_total": p.budget_total,
                "plan_start": p.plan_start.isoformat() if p.plan_start else None,
                "plan_end": p.plan_end.isoformat() if p.plan_end else None,
                "can_decide": decide}

    def adjust_row(a: BudgetAdjust):
        return {"kind": "budget_adjust", "id": a.id, "project_id": a.project_id,
                "project_name": project_names.get(a.project_id, ""),
                "subject": budget_subjects.get(a.budget_id, ""),
                "old_amount": a.old_amount, "new_amount": a.new_amount, "reason": a.reason,
                "by_id": a.by_id,
                "can_decide": decide}

    def expense_row(e: Expense):
        return {"kind": "expense", "id": e.id, "project_id": e.project_id,
                "project_name": project_names.get(e.project_id, ""), "subject": e.subject,
                "amount": e.amount,
                "exp_date": e.exp_date.isoformat() if e.exp_date else None,
                "note": e.note, "by_id": e.by_id,
                "can_decide": decide}

    return {
        "project_filings": [filing_row(p) for p in filings],
        "budget_adjusts": [adjust_row(a) for a in adjusts],
        "expenses": [expense_row(e) for e in expenses],
        "total": totals["project_filings"] + totals["budget_adjusts"] + totals["expenses"],
        "totals": totals,
        "limit": limit,
    }


@router.post("/{kind}/{aid}/decide")
def decide(kind: str, aid: int, body: dict, db: Session = Depends(get_db),
           user: User = Depends(get_current_user)):
    """统一决策入口：body {approve: bool, reason: str}。仅管理员。"""
    require_admin(user)  # 先鉴权：非管理员稳定 403，且早于任何状态读取/写入
    approve = bool(body.get("approve", True))
    reason = str(body.get("reason", ""))

    if kind == "project_filing":
        p = db.query(Project).filter_by(id=aid, deleted_at=None).first()
        if not p:
            raise HTTPException(404, "项目不存在")
        if p.status != "pending":
            raise HTTPException(400, "该项目不在待立项审批状态")
        old = p.status
        p.status = "filed" if approve else "cancelled"
        db.add(ProjectChange(project_id=p.id, field="status", old=old, new=p.status,
                             by_id=user.id, at=datetime.now(timezone.utc)))
        push(db, p.owner_id, "approval",
             f"立项审批{'通过' if approve else '驳回'}：{p.name}",
             reason or ("已通过，可开始排期" if approve else "已驳回"),
             ref_type="project", ref_id=p.id, project_id=p.id,
             dedup_key=f"filing-decided:{p.id}:{p.status}")
        db.commit()
        write_audit(db, user.id, "approve_filing", "projects", p.id,
                    f"{'approve' if approve else 'reject'} {reason}")
        return {"kind": kind, "id": p.id, "status": p.status}

    if kind == "budget_adjust":
        a = db.query(BudgetAdjust).filter_by(id=aid).first()
        if not a or a.status != "pending":
            raise HTTPException(404, "调整单不存在或已处理")
        # 决策边界：软删除项目的调整单不可处理
        p = get_active_project(db, a.project_id, msg="项目已删除，调整单不可处理")
        a.status = "approved" if approve else "rejected"
        a.approved_by = user.id
        if approve:
            b = db.query(Budget).filter_by(id=a.budget_id).first()
            if b:
                b.amount = a.new_amount
        push(db, a.by_id, "approval",
             f"预算调整{'通过' if approve else '驳回'}：{p.name if p else ''}",
             reason or f"{a.old_amount} → {a.new_amount}",
             ref_type="budget_adjust", ref_id=a.id, project_id=a.project_id,
             dedup_key=f"adjust-decided:{a.id}")
        db.commit()
        write_audit(db, user.id, "decide_adjust", "budget_adjusts", aid,
                    f"{'approve' if approve else 'reject'} {reason}")
        return {"kind": kind, "id": aid, "status": a.status}

    if kind == "expense":
        e = db.query(Expense).filter_by(id=aid).first()
        if not e:
            raise HTTPException(404, "支出不存在")
        if e.status != "pending":
            raise HTTPException(400, "该支出不在待审批状态")
        # 决策边界：软删除项目的支出不可处理
        get_active_project(db, e.project_id, msg="项目已删除，该支出不可处理")
        # approve=true 走常规通过；驳回/特批另见 /decide 与 /exception
        if approve:
            e.status = "approved"
        else:
            e.status = "rejected"
        push(db, e.by_id, "approval",
             f"支出{'通过' if approve else '驳回'}：{e.subject} {e.amount}",
             reason, ref_type="expense", ref_id=e.id, project_id=e.project_id,
             dedup_key=f"expense-decided:{e.id}")
        db.commit()
        write_audit(db, user.id, "decide_expense", "expenses", e.id,
                    f"{'approve' if approve else 'reject'} {reason}")
        return {"kind": kind, "id": e.id, "status": e.status}

    raise HTTPException(400, f"不支持的审批类型：{kind}")


@router.post("/expense/{eid}/exception")
def exception_by_center(eid: int, body: dict, db: Session = Depends(get_db),
                        user: User = Depends(get_current_user)):
    """审批中心里的超预算特批放行（复用支出 exception 语义）。仅管理员。"""
    require_admin(user)
    e = db.query(Expense).filter_by(id=eid).first()
    if not e:
        raise HTTPException(404, "支出不存在")
    if e.status not in ("pending", "rejected"):
        raise HTTPException(400, "仅待审批或已驳回的支出可特批")
    get_active_project(db, e.project_id, msg="项目已删除，该支出不可处理")
    e.status = "exception"
    push(db, e.by_id, "approval", f"支出特批放行：{e.subject} {e.amount}",
         str(body.get("reason", "")), ref_type="expense", ref_id=e.id,
         project_id=e.project_id, dedup_key=f"expense-exception:{e.id}")
    db.commit()
    write_audit(db, user.id, "exception_expense", "expenses", eid, "特批放行")
    return {"kind": "expense", "id": eid, "status": e.status}
