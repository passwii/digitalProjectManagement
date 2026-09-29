"""项目级应收与逐笔回款台账。"""

from datetime import date
from decimal import Decimal, InvalidOperation

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func
from sqlalchemy.orm import Session

from ..core.audit import commit_audited
from ..core.database import get_db
from ..core.deps import get_current_user
from ..core.paging import DEFAULT_PAGE_SIZE, paginate
from ..core.rbac import (
    check_project_access,
    get_active_project,
    is_demo_hidden,
    require_admin,
)
from ..core.timeutil import app_now, app_today, iso
from ..models import Project, ProjectReceivable, ProjectReceivablePayment, User

router = APIRouter(prefix="/projects", tags=["project-receivables"])

MONEY = Decimal("0.01")
MAX_MONEY = Decimal("10000000000000000")
RECEIVABLE_SORTS = {
    "id": ProjectReceivable.id,
    "name": ProjectReceivable.name,
    "amount": ProjectReceivable.amount,
    "receivable_date": ProjectReceivable.receivable_date,
    "due_date": ProjectReceivable.due_date,
    "created_at": ProjectReceivable.created_at,
}
PAYMENT_SORTS = {
    "id": ProjectReceivablePayment.id,
    "amount": ProjectReceivablePayment.amount,
    "payment_date": ProjectReceivablePayment.payment_date,
    "created_at": ProjectReceivablePayment.created_at,
}


def _body(value) -> dict:
    if not isinstance(value, dict):
        raise HTTPException(400, "请求体须为 JSON 对象")
    return value


def _name(value) -> str:
    if not isinstance(value, str) or not value.strip():
        raise HTTPException(400, "款项名称必填")
    name = value.strip()
    if len(name) > 128:
        raise HTTPException(400, "款项名称不能超过 128 个字符")
    return name


def _note(value) -> str:
    if value is None:
        return ""
    if not isinstance(value, str):
        raise HTTPException(400, "说明须为文本")
    return value.strip()


def _money(value, field: str) -> Decimal:
    if value is None or value == "" or isinstance(value, bool):
        raise HTTPException(400, f"{field}须为正数，最多两位小数")
    try:
        amount = Decimal(str(value).strip())
    except (InvalidOperation, ValueError):
        raise HTTPException(400, f"{field}须为有效数字")
    if not amount.is_finite():
        raise HTTPException(400, f"{field}须为有效数字")
    if amount <= 0:
        raise HTTPException(400, f"{field}须为正数")
    try:
        rounded = amount.quantize(MONEY)
    except InvalidOperation:
        raise HTTPException(400, f"{field}数值过大")
    if amount != rounded:
        raise HTTPException(400, f"{field}最多保留两位小数")
    if rounded >= MAX_MONEY:
        raise HTTPException(400, f"{field}数值过大")
    return rounded


def _date(value, field: str) -> date:
    if isinstance(value, date):
        return value
    if not isinstance(value, str) or not value.strip():
        raise HTTPException(400, f"{field}必填")
    try:
        return date.fromisoformat(value.strip())
    except ValueError:
        raise HTTPException(400, f"{field}须为 YYYY-MM-DD 格式")


def _money_text(value) -> str:
    return f"{Decimal(str(value or 0)).quantize(MONEY):.2f}"


def _lock_project(db: Session, pid: int, user: User) -> Project:
    """所有应收写操作的第一条业务查询：锁定活动项目行，串行化同项目写入。"""
    project = (
        db.query(Project)
        .filter(Project.id == pid, Project.deleted_at.is_(None))
        .with_for_update()
        .first()
    )
    if not project or is_demo_hidden(project, db):
        raise HTTPException(404, "项目不存在")
    check_project_access(user, project, write=True, db=db)
    return project


def _require_writable(project: Project) -> None:
    if project.status == "archived":
        raise HTTPException(400, "已归档项目只读")


def _receivable(db: Session, pid: int, rid: int, *, lock: bool = False) -> ProjectReceivable:
    query = db.query(ProjectReceivable).filter(
        ProjectReceivable.id == rid,
        ProjectReceivable.project_id == pid,
        ProjectReceivable.deleted_at.is_(None),
    )
    if lock:
        query = query.with_for_update()
    row = query.first()
    if not row:
        raise HTTPException(404, "应收记录不存在")
    return row


def _payment(
    db: Session,
    pid: int,
    rid: int,
    payment_id: int,
    *,
    lock: bool = False,
) -> ProjectReceivablePayment:
    query = db.query(ProjectReceivablePayment).filter(
        ProjectReceivablePayment.id == payment_id,
        ProjectReceivablePayment.project_id == pid,
        ProjectReceivablePayment.receivable_id == rid,
        ProjectReceivablePayment.deleted_at.is_(None),
    )
    if lock:
        query = query.with_for_update()
    row = query.first()
    if not row:
        raise HTTPException(404, "回款记录不存在")
    return row


def _payment_totals(
    db: Session,
    pid: int,
    rid: int,
    *,
    exclude_payment_id: int | None = None,
) -> tuple[Decimal, int]:
    query = db.query(
        func.coalesce(func.sum(ProjectReceivablePayment.amount), Decimal("0.00")),
        func.count(ProjectReceivablePayment.id),
    ).filter(
        ProjectReceivablePayment.project_id == pid,
        ProjectReceivablePayment.receivable_id == rid,
        ProjectReceivablePayment.deleted_at.is_(None),
    )
    if exclude_payment_id is not None:
        query = query.filter(ProjectReceivablePayment.id != exclude_payment_id)
    received, count = query.one()
    return Decimal(str(received or 0)), int(count or 0)


def _status(amount: Decimal, received: Decimal, due_date: date) -> str:
    if received >= amount:
        return "paid"
    if due_date < app_today():
        return "overdue"
    if received > 0:
        return "partial"
    return "unpaid"


def _receivable_row(
    db: Session,
    receivable: ProjectReceivable,
) -> dict:
    received, payment_count = _payment_totals(
        db, receivable.project_id, receivable.id,
    )
    amount = Decimal(str(receivable.amount))
    outstanding = max(amount - received, Decimal("0.00"))
    return {
        "id": receivable.id,
        "project_id": receivable.project_id,
        "name": receivable.name,
        "amount": _money_text(amount),
        "received_amount": _money_text(received),
        "outstanding_amount": _money_text(outstanding),
        "receivable_date": iso(receivable.receivable_date),
        "due_date": iso(receivable.due_date),
        "note": receivable.note or "",
        "status": _status(amount, received, receivable.due_date),
        "payment_count": payment_count,
    }


def _payment_row(payment: ProjectReceivablePayment) -> dict:
    return {
        "id": payment.id,
        "project_id": payment.project_id,
        "receivable_id": payment.receivable_id,
        "amount": _money_text(payment.amount),
        "payment_date": iso(payment.payment_date),
        "note": payment.note or "",
        "created_at": iso(payment.created_at),
    }


def _summary(db: Session, pid: int) -> dict:
    amount = (
        db.query(func.coalesce(func.sum(ProjectReceivable.amount), Decimal("0.00")))
        .filter(
            ProjectReceivable.project_id == pid,
            ProjectReceivable.deleted_at.is_(None),
        )
        .scalar()
    )
    received = (
        db.query(
            func.coalesce(
                func.sum(ProjectReceivablePayment.amount),
                Decimal("0.00"),
            )
        )
        .join(
            ProjectReceivable,
            ProjectReceivable.id == ProjectReceivablePayment.receivable_id,
        )
        .filter(
            ProjectReceivablePayment.project_id == pid,
            ProjectReceivablePayment.deleted_at.is_(None),
            ProjectReceivable.project_id == pid,
            ProjectReceivable.deleted_at.is_(None),
        )
        .scalar()
    )
    amount = Decimal(str(amount or 0))
    received = Decimal(str(received or 0))
    outstanding = max(amount - received, Decimal("0.00"))
    return {
        "amount": _money_text(amount),
        "received_amount": _money_text(received),
        "outstanding_amount": _money_text(outstanding),
    }


@router.get("/{pid}/receivables")
def list_receivables(
    pid: int,
    page: int = 1,
    size: int = DEFAULT_PAGE_SIZE,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    get_active_project(db, pid, user)
    query = db.query(ProjectReceivable).filter(
        ProjectReceivable.project_id == pid,
        ProjectReceivable.deleted_at.is_(None),
    )
    result = paginate(
        query,
        page=page,
        size=size,
        allowed=RECEIVABLE_SORTS,
        default_sort="-id",
        map_row=lambda row: _receivable_row(db, row),
    )
    result["summary"] = _summary(db, pid)
    return result


@router.post("/{pid}/receivables")
def create_receivable(
    pid: int,
    body: dict,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    project = _lock_project(db, pid, user)
    _require_writable(project)
    payload = _body(body)
    name = _name(payload.get("name"))
    amount = _money(payload.get("amount"), "应收金额")
    receivable_date = _date(payload.get("receivable_date"), "应收日期")
    due_date = _date(payload.get("due_date"), "到期日")
    if due_date < receivable_date:
        raise HTTPException(400, "到期日不能早于应收日期")

    receivable = ProjectReceivable(
        project_id=pid,
        name=name,
        amount=amount,
        receivable_date=receivable_date,
        due_date=due_date,
        note=_note(payload.get("note")),
        created_by=user.id,
        created_at=app_now(),
        updated_at=app_now(),
    )
    db.add(receivable)
    db.flush()
    commit_audited(
        db,
        user.id,
        "create_project_receivable",
        "project_receivable",
        receivable.id,
        f"project={pid},name={name},amount={amount}",
    )
    return _receivable_row(db, receivable)


@router.patch("/{pid}/receivables/{rid}")
def update_receivable(
    pid: int,
    rid: int,
    body: dict,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    project = _lock_project(db, pid, user)
    _require_writable(project)
    receivable = _receivable(db, pid, rid, lock=True)
    payload = _body(body)

    name = _name(payload["name"]) if "name" in payload else receivable.name
    amount = (
        _money(payload["amount"], "应收金额")
        if "amount" in payload else Decimal(str(receivable.amount))
    )
    receivable_date = (
        _date(payload["receivable_date"], "应收日期")
        if "receivable_date" in payload else receivable.receivable_date
    )
    due_date = (
        _date(payload["due_date"], "到期日")
        if "due_date" in payload else receivable.due_date
    )
    if due_date < receivable_date:
        raise HTTPException(400, "到期日不能早于应收日期")
    received, _ = _payment_totals(db, pid, rid)
    if amount < received:
        raise HTTPException(400, "应收金额不能低于已回款金额")

    receivable.name = name
    receivable.amount = amount
    receivable.receivable_date = receivable_date
    receivable.due_date = due_date
    if "note" in payload:
        receivable.note = _note(payload["note"])
    db.flush()
    commit_audited(
        db,
        user.id,
        "update_project_receivable",
        "project_receivable",
        rid,
        f"project={pid},fields={','.join(sorted(payload))}",
    )
    return _receivable_row(db, receivable)


@router.delete("/{pid}/receivables/{rid}")
def delete_receivable(
    pid: int,
    rid: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    require_admin(user)
    project = _lock_project(db, pid, user)
    _require_writable(project)
    receivable = _receivable(db, pid, rid, lock=True)
    receivable.deleted_at = app_now()
    receivable.deleted_by = user.id
    db.flush()
    commit_audited(
        db,
        user.id,
        "delete_project_receivable",
        "project_receivable",
        rid,
        f"project={pid},name={receivable.name}",
    )
    return {"ok": True, "id": rid}


@router.get("/{pid}/receivables/{rid}/payments")
def list_payments(
    pid: int,
    rid: int,
    page: int = 1,
    size: int = DEFAULT_PAGE_SIZE,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    get_active_project(db, pid, user)
    _receivable(db, pid, rid)
    query = db.query(ProjectReceivablePayment).filter(
        ProjectReceivablePayment.project_id == pid,
        ProjectReceivablePayment.receivable_id == rid,
        ProjectReceivablePayment.deleted_at.is_(None),
    )
    return paginate(
        query,
        page=page,
        size=size,
        allowed=PAYMENT_SORTS,
        default_sort="-payment_date",
        map_row=_payment_row,
    )


@router.post("/{pid}/receivables/{rid}/payments")
def create_payment(
    pid: int,
    rid: int,
    body: dict,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    project = _lock_project(db, pid, user)
    _require_writable(project)
    receivable = _receivable(db, pid, rid, lock=True)
    payload = _body(body)
    amount = _money(payload.get("amount"), "回款金额")
    payment_date = _date(payload.get("payment_date"), "回款日期")
    received, _ = _payment_totals(db, pid, rid)
    if received + amount > Decimal(str(receivable.amount)):
        raise HTTPException(400, "回款累计不能超过应收金额")

    payment = ProjectReceivablePayment(
        project_id=pid,
        receivable_id=rid,
        amount=amount,
        payment_date=payment_date,
        note=_note(payload.get("note")),
        created_by=user.id,
        created_at=app_now(),
        updated_at=app_now(),
    )
    db.add(payment)
    db.flush()
    commit_audited(
        db,
        user.id,
        "create_project_receivable_payment",
        "project_receivable_payment",
        payment.id,
        f"project={pid},receivable={rid},amount={amount}",
    )
    return _payment_row(payment)


@router.patch("/{pid}/receivables/{rid}/payments/{payment_id}")
def update_payment(
    pid: int,
    rid: int,
    payment_id: int,
    body: dict,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    project = _lock_project(db, pid, user)
    _require_writable(project)
    receivable = _receivable(db, pid, rid, lock=True)
    payment = _payment(db, pid, rid, payment_id, lock=True)
    payload = _body(body)

    amount = (
        _money(payload["amount"], "回款金额")
        if "amount" in payload else Decimal(str(payment.amount))
    )
    payment_date = (
        _date(payload["payment_date"], "回款日期")
        if "payment_date" in payload else payment.payment_date
    )
    other_received, _ = _payment_totals(
        db, pid, rid, exclude_payment_id=payment_id,
    )
    if other_received + amount > Decimal(str(receivable.amount)):
        raise HTTPException(400, "回款累计不能超过应收金额")

    payment.amount = amount
    payment.payment_date = payment_date
    if "note" in payload:
        payment.note = _note(payload["note"])
    db.flush()
    commit_audited(
        db,
        user.id,
        "update_project_receivable_payment",
        "project_receivable_payment",
        payment_id,
        f"project={pid},receivable={rid},fields={','.join(sorted(payload))}",
    )
    return _payment_row(payment)


@router.delete("/{pid}/receivables/{rid}/payments/{payment_id}")
def delete_payment(
    pid: int,
    rid: int,
    payment_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    require_admin(user)
    project = _lock_project(db, pid, user)
    _require_writable(project)
    _receivable(db, pid, rid, lock=True)
    payment = _payment(db, pid, rid, payment_id, lock=True)
    payment.deleted_at = app_now()
    payment.deleted_by = user.id
    db.flush()
    commit_audited(
        db,
        user.id,
        "delete_project_receivable_payment",
        "project_receivable_payment",
        payment_id,
        f"project={pid},receivable={rid},amount={payment.amount}",
    )
    return {"ok": True, "id": payment_id}
