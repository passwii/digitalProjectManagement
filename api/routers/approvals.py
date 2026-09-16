"""审批中心：聚合三类待办：立项审批 / 预算调整 / 支出，统一决策入口。

权限契约（Stage 1 收敛）：审批中心属于管理与审批面，仅管理员可用；
  · 列表、决策、特批四处共用 core.rbac.can_approve 判定 → 列表可见性与决策放行永远一致；
  · 决策入口先做管理员校验，非管理员稳定 403 且不会产生任何业务状态变更。

设计：不新建重复状态表——分别复用各域已有的 pending 状态与状态机：
  立项  → projects.status == "pending"（待立项审批），通过转 filed，驳回转 cancelled
  预算调整 → budget_adjusts.status == "pending"
  支出   → expenses.status == "pending"

Stage 4A 补齐：
  · **全局规则 + 无 N+1**：三类待办各一次聚合查询（`totals` 用 COUNT，当页用 JOIN 取关联名称），
    关联项目名与科目名批量取回；行内不再逐行发起查询（原先 adjust/expense 行各取一次项目名）。
  · **审计原子**：决策与审计同一次提交（`commit_audited`），业务成功但留痕失败不再可能。
  · **时间线**：决策结果写入 `approval_records`，申请人（非管理员）可通过各域的 timeline 接口查到。
  · **决策意见**：驳回必须给意见，意见落到业务行（`decision_reason`）并随通知回传申请人。
"""
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..core.audit import commit_audited
from ..core.database import get_db
from ..core.deps import get_current_user
from ..core.notify import push
from ..core.rbac import can_approve, get_active_project, require_admin
from ..core.timeline import (ACTION_APPROVE, ACTION_EXCEPTION, ACTION_REJECT,
                             ACTION_SUBMIT, KIND_BUDGET_ADJUST, KIND_EXPENSE,
                             KIND_PROJECT_FILING, timeline)
from ..core.timeline import record as record_timeline
from ..models import Budget, BudgetAdjust, Expense, Project, ProjectChange, User

router = APIRouter(prefix="/approvals", tags=["approvals"])

# 三类待办的 kind 白名单：未知 kind 一律 400（不再落到「不支持的审批类型」之前就做任何读写）
KINDS = ("project_filing", "budget_adjust", "expense")
MAX_LIMIT = 500


def _active_project_ids():
    """「未软删除项目」子查询：三类待办共用的全局规则过滤条件。"""
    return select(Project.id).where(Project.deleted_at.is_(None))


@router.get("/pending")
def pending(limit: int = 200, kind: str = "", db: Session = Depends(get_db),
            user: User = Depends(get_current_user)):
    """管理员审批中心：全局三类待办聚合（跨部门、跨项目，仅含未软删除项目的记录）。

    查询边界（Stage 3A/4A）：
      · 每类待办服务端最多返回 `limit` 条（默认 200，上限 500），`totals` 同时回传真实总数；
      · **无 N+1**：每类待办各一次 COUNT + 一次取当页；项目名/科目名用一次 IN 查询批量映射，
        行内不再发起任何逐行查询；
      · `kind` 可选（project_filing / budget_adjust / expense）只看某一类，其余两类返回空数组，
        但 `totals` 仍给全量口径，避免前端误判「没有待办」。
      · 行内 `can_decide` 与决策入口共用 `core.rbac.can_approve`，不存在「按钮可见但接口 403」。
    """
    require_admin(user)
    if limit < 1 or limit > MAX_LIMIT:
        raise HTTPException(400, f"limit 须为 1-{MAX_LIMIT} 的整数，收到 {limit!r}")
    if kind and kind not in KINDS:
        raise HTTPException(400, f"kind 须为 {list(KINDS)} 之一，收到 {kind!r}")

    active = _active_project_ids()
    want = set(KINDS) if not kind else {kind}

    adjust_q = db.query(BudgetAdjust).filter(BudgetAdjust.status == "pending",
                                             BudgetAdjust.project_id.in_(active))
    expense_q = db.query(Expense).filter(Expense.status == "pending",
                                         Expense.project_id.in_(active))
    filing_q = db.query(Project).filter(Project.status == "pending",
                                        Project.deleted_at.is_(None))

    # 总数（不截断）与当页行分开取：前端既能显示“还有多少条”，又不会拉到无界数据
    totals = {
        "project_filings": filing_q.count() if "project_filing" in want else 0,
        "budget_adjusts": adjust_q.count() if "budget_adjust" in want else 0,
        "expenses": expense_q.count() if "expense" in want else 0,
    }
    filings = filing_q.order_by(Project.id.desc()).limit(limit).all() \
        if "project_filing" in want else []
    adjusts = adjust_q.order_by(BudgetAdjust.id.desc()).limit(limit).all() \
        if "budget_adjust" in want else []
    expenses = expense_q.order_by(Expense.id.desc()).limit(limit).all() \
        if "expense" in want else []

    # 批量取关联名称：一次 IN 查询映射 project_id → name、budget_id → subject（消除逐行 N+1）
    project_ids = {p.id for p in filings} | {a.project_id for a in adjusts} \
        | {e.project_id for e in expenses}
    project_names = dict(db.query(Project.id, Project.name)
                         .filter(Project.id.in_(project_ids or [0])).all()) if project_ids else {}
    budget_ids = {a.budget_id for a in adjusts}
    budget_subjects = dict(db.query(Budget.id, Budget.subject)
                           .filter(Budget.id.in_(budget_ids or [0])).all()) if budget_ids else {}
    # 申请人名称也批量映射，避免行内再查
    actor_ids = {p.owner_id for p in filings}
    actor_ids |= {a.by_id for a in adjusts} | {e.by_id for e in expenses}
    actor_ids.discard(None)
    actor_names = dict(db.query(User.id, User.real_name)
                       .filter(User.id.in_(actor_ids or [0])).all()) if actor_ids else {}

    decide = can_approve(user)

    def filing_row(p: Project):
        return {"kind": "project_filing", "id": p.id, "project_id": p.id, "code": p.code,
                "name": p.name, "owner_id": p.owner_id,
                "applicant_name": actor_names.get(p.owner_id, ""),
                "budget_total": p.budget_total,
                "plan_start": p.plan_start.isoformat() if p.plan_start else None,
                "plan_end": p.plan_end.isoformat() if p.plan_end else None,
                "status": p.status, "can_decide": decide}

    def adjust_row(a: BudgetAdjust):
        return {"kind": "budget_adjust", "id": a.id, "project_id": a.project_id,
                "project_name": project_names.get(a.project_id, ""),
                "subject": budget_subjects.get(a.budget_id, ""),
                "old_amount": a.old_amount, "new_amount": a.new_amount, "reason": a.reason,
                "by_id": a.by_id, "applicant_name": actor_names.get(a.by_id, ""),
                "decision_reason": a.decision_reason or "", "status": a.status,
                "can_decide": decide}

    def expense_row(e: Expense):
        return ({"kind": "expense", "id": e.id, "project_id": e.project_id,
                 "project_name": project_names.get(e.project_id, ""), "subject": e.subject,
                 "amount": e.amount,
                 "exp_date": e.exp_date.isoformat() if e.exp_date else None,
                 "note": e.note, "by_id": e.by_id,
                 "applicant_name": actor_names.get(e.by_id, ""),
                 "resubmit_count": e.resubmit_count or 0, "status": e.status,
                 "can_decide": decide})

    return {
        "project_filings": [filing_row(p) for p in filings],
        "budget_adjusts": [adjust_row(a) for a in adjusts],
        "expenses": [expense_row(e) for e in expenses],
        "total": totals["project_filings"] + totals["budget_adjusts"] + totals["expenses"],
        "totals": totals,
        "limit": limit,
        "kind": kind,
    }


@router.get("/{kind}/{aid}/timeline")
def pending_timeline(kind: str, aid: int, db: Session = Depends(get_db),
                     user: User = Depends(get_current_user)):
    """审批对象时间线：管理员可查任意单据的流转；申请人在各域 timeline 接口查自己的单据。"""
    require_admin(user)
    if kind not in KINDS:
        raise HTTPException(400, f"不支持的审批类型：{kind}")
    return {"kind": kind, "id": aid, "items": timeline(db, kind, aid)}


@router.post("/{kind}/{aid}/decide")
def decide(kind: str, aid: int, body: dict, db: Session = Depends(get_db),
           user: User = Depends(get_current_user)):
    """统一决策入口：body {approve: bool, reason: str}。仅管理员。"""
    require_admin(user)  # 先鉴权：非管理员稳定 403，且早于任何状态读取/写入
    if kind not in KINDS:
        raise HTTPException(400, f"不支持的审批类型：{kind}")
    approve = bool(body.get("approve", True))
    reason = str(body.get("reason", "") or "").strip()
    if not approve and not reason:
        raise HTTPException(400, "驳回必须填写意见")

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
        record_timeline(db, KIND_PROJECT_FILING, p.id,
                        ACTION_APPROVE if approve else ACTION_REJECT,
                        from_status=old, to_status=p.status, project_id=p.id,
                        actor_id=user.id, reason=reason)
        push(db, p.owner_id, "approval",
             f"立项审批{'通过' if approve else '驳回'}：{p.name}",
             reason or ("已通过，可开始排期" if approve else "已驳回"),
             ref_type="project", ref_id=p.id, project_id=p.id,
             dedup_key=f"filing-decided:{p.id}:{p.status}")
        commit_audited(db, user.id, "approve_filing", "projects", p.id,
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
        a.decision_reason = reason
        a.decided_at = datetime.now(timezone.utc)
        b = db.query(Budget).filter_by(id=a.budget_id).first()
        if approve and b:
            b.amount = a.new_amount
        record_timeline(db, KIND_BUDGET_ADJUST, a.id,
                        ACTION_APPROVE if approve else ACTION_REJECT,
                        from_status="pending", to_status=a.status, project_id=a.project_id,
                        actor_id=user.id, reason=reason)
        push(db, a.by_id, "approval",
             f"预算调整{'通过' if approve else '驳回'}：{p.name if p else ''}",
             reason or f"{a.old_amount} → {a.new_amount}",
             ref_type="budget_adjust", ref_id=a.id, project_id=a.project_id,
             dedup_key=f"adjust-decided:{a.id}")
        commit_audited(db, user.id, "decide_adjust", "budget_adjusts", aid,
                       f"{'approve' if approve else 'reject'} {reason}")
        return {"kind": kind, "id": aid, "status": a.status,
                "subject": b.subject if b else "", "decision_reason": reason}

    # kind == "expense"
    e = db.query(Expense).filter_by(id=aid).first()
    if not e:
        raise HTTPException(404, "支出不存在")
    if e.status != "pending":
        raise HTTPException(400, "该支出不在待审批状态")
    # 决策边界：软删除项目的支出不可处理
    get_active_project(db, e.project_id, msg="项目已删除，该支出不可处理")
    if approve:
        from ..core.costs import budget_total, spent
        b = budget_total(db, e.project_id, e.subject)
        if b and (spent(db, e.project_id, e.subject) + e.amount > b):
            raise HTTPException(400, "超预算：通过前请先调预算或走特批")
    e.status = "approved" if approve else "rejected"
    e.approved_by = user.id
    e.decision_reason = reason
    e.decided_at = datetime.now(timezone.utc)
    record_timeline(db, KIND_EXPENSE, e.id, ACTION_APPROVE if approve else ACTION_REJECT,
                    from_status="pending", to_status=e.status, project_id=e.project_id,
                    actor_id=user.id, reason=reason)
    push(db, e.by_id, "approval",
         f"支出{'通过' if approve else '驳回'}：{e.subject} {e.amount}",
         reason or f"当前状态：{e.status}", ref_type="expense", ref_id=e.id,
         project_id=e.project_id,
         dedup_key=f"expense-decided:{e.id}:{e.status}:{e.resubmit_count or 0}")
    commit_audited(db, user.id, "decide_expense", "expenses", e.id,
                   f"{'approve' if approve else 'reject'} {reason}")
    return {"kind": kind, "id": e.id, "status": e.status, "decision_reason": reason}


@router.post("/expense/{eid}/exception")
def exception_by_center(eid: int, body: dict, db: Session = Depends(get_db),
                        user: User = Depends(get_current_user)):
    """审批中心里的超预算特批放行（复用支出 exception 语义）。仅管理员，理由必填。"""
    require_admin(user)
    e = db.query(Expense).filter_by(id=eid).first()
    if not e:
        raise HTTPException(404, "支出不存在")
    if e.status not in ("pending", "rejected"):
        raise HTTPException(400, f"仅待审批或已驳回的支出可特批，当前为 {e.status}")
    get_active_project(db, e.project_id, msg="项目已删除，该支出不可处理")
    reason = str(body.get("reason", "") or "").strip()
    if not reason:
        raise HTTPException(400, "特批必须填写理由")
    old = e.status
    e.status = "exception"
    e.approved_by = user.id
    e.decision_reason = reason
    e.decided_at = datetime.now(timezone.utc)
    record_timeline(db, KIND_EXPENSE, e.id, ACTION_EXCEPTION, from_status=old,
                    to_status="exception", project_id=e.project_id, actor_id=user.id,
                    reason=reason)
    push(db, e.by_id, "approval", f"支出特批放行：{e.subject} {e.amount}",
         reason, ref_type="expense", ref_id=e.id,
         project_id=e.project_id,
         dedup_key=f"expense-decided:{e.id}:exception:{e.resubmit_count or 0}")
    commit_audited(db, user.id, "exception_expense", "expenses", eid, reason)
    return {"kind": "expense", "id": eid, "status": e.status, "decision_reason": reason}
