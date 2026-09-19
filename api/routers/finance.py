"""P0-A 财务底座 API：账套、自然月期间、科目树、期初余额与账套辅助资料。"""

from calendar import monthrange
from datetime import date
from decimal import Decimal, InvalidOperation
from typing import Any, cast

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..core.audit import commit_audited
from ..core.database import Base, get_db
from ..core.deps import get_current_user
from ..core.rbac import is_admin
from ..core.timeutil import app_now
from ..models import (
    Account,
    AccountAuxiliary,
    AccountBook,
    AccountBookMember,
    AccountingPeriod,
    AuxiliaryItem,
    OpeningBalance,
    User,
)

router = APIRouter(prefix="/finance", tags=["finance"])

CATEGORIES = {"资产", "负债", "权益", "成本", "损益"}
AUX_KINDS = {"customer", "vendor", "department", "employee", "project", "cashflow"}
ACCOUNT_AUX_FLAGS = {"customer", "vendor", "dept", "employee", "project", "cashflow"}


class BookIn(BaseModel):
    code: str = Field(min_length=1, max_length=32)
    name: str = Field(min_length=1, max_length=128)
    base_currency: str = Field(default="CNY", min_length=3, max_length=3)


class AccountIn(BaseModel):
    code: str = Field(min_length=4, max_length=32)
    name: str = Field(min_length=1, max_length=128)
    direction: str = Field(pattern="^[DC]$")
    category: str
    parent_id: int | None = None
    aux_flags: dict[str, bool] = Field(default_factory=dict)


class OpeningIn(BaseModel):
    account_id: int
    aux_key: str = Field(default="", max_length=128)
    aux_detail: dict = Field(default_factory=dict)
    debit: Decimal = Decimal("0.00")
    credit: Decimal = Decimal("0.00")


class AuxiliaryIn(BaseModel):
    kind: str
    code: str = Field(min_length=1, max_length=64)
    name: str = Field(min_length=1, max_length=128)
    metadata: dict = Field(default_factory=dict)


class AccountAuxiliaryIn(BaseModel):
    account_id: int
    auxiliary_item_id: int


class PeriodStatusIn(BaseModel):
    status: str = Field(pattern="^(open|closed|locked)$")


def _book_access(db: Session, user: User, book_id: int) -> AccountBook:
    book = db.query(AccountBook).filter(AccountBook.id == book_id).first()
    if not book:
        raise HTTPException(404, "账套不存在")
    if (
        not is_admin(user)
        and not db.query(AccountBookMember)
        .filter_by(account_book_id=book_id, user_id=user.id)
        .first()
    ):
        raise HTTPException(403, "无权访问该账套")
    return book


def _book_header(db: Session, user: User, header: str | None) -> AccountBook:
    code = (header or "").strip()
    if not code:
        raise HTTPException(400, "请通过 X-Account-Book 指定账套 code")
    book = db.query(AccountBook).filter(AccountBook.code == code).first()
    if not book:
        raise HTTPException(404, "账套不存在")
    return _book_access(db, user, book.id)  # type: ignore[arg-type]


def _period_dates(year: int, month: int) -> tuple[date, date]:
    if month == 13:
        return date(year, 12, 31), date(year, 12, 31)
    return date(year, month, 1), date(year, month, monthrange(year, month)[1])


def _seed_accounts(db: Session, book_id: int) -> None:
    """幂等导入冻结的 2022 准则基础树（一级、常用二级及三级）。"""
    seeds = (
        ("1001", "库存现金", "D", "资产", None, {"cashflow": True}),
        ("1002", "银行存款", "D", "资产", None, {"cashflow": True}),
        ("100201", "招行基本户", "D", "资产", "1002", {"cashflow": True}),
        ("1122", "应收账款", "D", "资产", None, {"customer": True}),
        ("1405", "库存商品", "D", "资产", None, {}),
        ("1601", "固定资产", "D", "资产", None, {}),
        ("1602", "累计折旧", "C", "资产", None, {}),
        ("2001", "短期借款", "C", "负债", None, {}),
        ("2202", "应付账款", "C", "负债", None, {"vendor": True}),
        ("2211", "应付职工薪酬", "C", "负债", None, {}),
        ("2221", "应交税费", "C", "负债", None, {}),
        ("3001", "实收资本", "C", "权益", None, {}),
        ("6001", "主营业务收入", "C", "损益", None, {}),
        ("6401", "主营业务成本", "D", "成本", None, {}),
        ("6602", "管理费用", "D", "损益", None, {"dept": True}),
    )
    for code, name, direction, category, parent_code, aux_flags in seeds:
        row = db.query(Account).filter_by(account_book_id=book_id, code=code).first()
        if row:
            continue
        parent = (
            db.query(Account)
            .filter_by(account_book_id=book_id, code=parent_code)
            .first()
            if parent_code
            else None
        )
        row = Account(
            account_book_id=book_id,
            code=code,
            name=name,
            level=len(code) // 2 - 1,
            parent_id=parent.id if parent else None,
            direction=direction,
            category=category,
            aux_flags=aux_flags,
            is_leaf=parent is None,
        )
        db.add(row)
        if parent:
            cast(Any, parent).is_leaf = False
        db.flush()


def _serialize_book(book: AccountBook) -> dict:
    return {
        "id": book.id,
        "code": book.code,
        "name": book.name,
        "base_currency": book.base_currency,
        "currencies": book.currencies,
        "status": book.status,
    }


@router.post("/books")
def create_book(
    body: BookIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)
):
    if not is_admin(user):
        raise HTTPException(403, "仅管理员可创建账套")
    code = body.code.strip()
    currency = body.base_currency.upper()
    if not currency.isalpha():
        raise HTTPException(400, "本位币必须为 3 位字母代码")
    if db.query(AccountBook).filter_by(code=code).first():
        raise HTTPException(409, "账套 code 已存在")
    book = AccountBook(
        code=code,
        name=body.name.strip(),
        base_currency=currency,
        currencies=[currency],
        created_by=user.id,
    )
    db.add(book)
    db.flush()
    for month in range(1, 13):
        start, end = _period_dates(date.today().year, month)
        db.add(
            AccountingPeriod(
                account_book_id=book.id,
                year=start.year,
                month=month,
                period_index=start.year * 100 + month,
                start_date=start,
                end_date=end,
            )
        )
    db.add(AccountBookMember(account_book_id=book.id, user_id=user.id, role="owner"))
    _seed_accounts(db, book.id)  # type: ignore[arg-type]
    try:
        commit_audited(db, user.id, "create", "account_book", str(book.id), code)
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(409, "账套创建失败") from exc
    return _serialize_book(book)


@router.get("/books")
def list_books(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    q = db.query(AccountBook)
    if not is_admin(user):
        q = q.join(AccountBookMember).filter(AccountBookMember.user_id == user.id)
    return [_serialize_book(x) for x in q.order_by(AccountBook.id).all()]


@router.get("/books/{book_id}")
def get_book(
    book_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)
):
    return _serialize_book(_book_access(db, user, book_id))


@router.get("/periods")
def list_periods(
    year: int | None = Query(default=None, ge=1, le=9999),
    x_account_book: str | None = Header(default=None),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    book = _book_header(db, user, x_account_book)
    query = db.query(AccountingPeriod).filter_by(account_book_id=book.id)
    if year is not None:
        query = query.filter(AccountingPeriod.year == year)
    rows = query.order_by(AccountingPeriod.period_index).all()
    return [
        {
            "id": x.id,
            "year": x.year,
            "month": x.month,
            "period": f"{x.year:04d}-{x.month:02d}",
            "status": x.status,
            "start_date": x.start_date.isoformat(),
            "end_date": x.end_date.isoformat(),
            "version": x.version,
        }
        for x in rows
    ]


@router.patch("/periods/{period_id}")
def update_period(
    period_id: int,
    body: PeriodStatusIn,
    x_account_book: str | None = Header(default=None),
    if_match: str | None = Header(default=None, alias="If-Match"),
    x_reopen_period: str | None = Header(default=None, alias="X-Reopen-Period"),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    book = _book_header(db, user, x_account_book)
    if not is_admin(user):
        raise HTTPException(403, "仅管理员可维护期间")
    row = (
        db.query(AccountingPeriod)
        .filter_by(id=period_id, account_book_id=book.id)
        .with_for_update()
        .first()
    )
    if not row:
        raise HTTPException(404, "期间不存在")
    period = cast(Any, row)
    current_status = str(period.status)
    allowed_transitions = {
        "open": {"open", "closed"},
        "closed": {"closed", "locked", "open"},
        "locked": {"locked"},
    }
    if body.status not in allowed_transitions.get(current_status, set()):
        raise HTTPException(400, "期间状态只能按 open→closed→locked 流转")
    expected_version = None
    if if_match:
        try:
            expected_version = int(if_match.strip().strip('"'))
        except ValueError as exc:
            raise HTTPException(400, "If-Match 必须为期间 version") from exc
    if expected_version is not None and expected_version != period.version:
        raise HTTPException(409, "期间已被其他请求更新，请刷新后重试")
    if current_status == "locked" and body.status != "locked":
        raise HTTPException(400, "已锁定期间不能重新打开或结账")
    if current_status == "closed" and body.status == "open":
        if (x_reopen_period or "").lower() != "confirm":
            raise HTTPException(400, "已结账期间不能直接重新打开；反结账需二次确认")
        next_period = (
            db.query(AccountingPeriod)
            .filter(
                AccountingPeriod.account_book_id == book.id,
                AccountingPeriod.period_index > period.period_index,
                AccountingPeriod.status != "open",
            )
            .order_by(AccountingPeriod.period_index)
            .first()
        )
        if next_period:
            raise HTTPException(400, "反结账必须按期间倒序，后一期间尚未打开")
    if body.status == "locked" and current_status != "closed":
        raise HTTPException(400, "只能锁定已结账期间")
    period.status = body.status
    period.version = period.version + 1
    if body.status in {"closed", "locked"}:
        period.closed_by = user.id
        period.closed_at = period.closed_at or app_now()
    else:
        period.closed_by = None
        period.closed_at = None
    commit_audited(db, user.id, "update", "accounting_period", str(row.id), body.status)
    return {"id": row.id, "status": row.status, "version": row.version}


@router.get("/accounts/tree")
def account_tree(
    x_account_book: str | None = Header(default=None),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    book = _book_header(db, user, x_account_book)
    rows = (
        db.query(Account)
        .filter_by(account_book_id=book.id)
        .order_by(Account.code)
        .all()
    )
    return [
        {
            "id": x.id,
            "code": x.code,
            "name": x.name,
            "level": x.level,
            "parent_id": x.parent_id,
            "direction": x.direction,
            "category": x.category,
            "aux_flags": x.aux_flags,
            "is_leaf": x.is_leaf,
            "is_active": x.is_active,
        }
        for x in rows
    ]


def _validate_account_code(
    db: Session, book_id: int, body: AccountIn
) -> tuple[int, Account | None]:
    if body.category not in CATEGORIES:
        raise HTTPException(400, "科目类别不合法")
    if set(body.aux_flags) - ACCOUNT_AUX_FLAGS:
        raise HTTPException(400, "辅助核算开关包含不支持的维度")
    if body.parent_id is None and len(body.code) != 4:
        raise HTTPException(400, "一级科目编码必须为 4 位")
    if len(body.code) not in (4, 6, 8, 10):
        raise HTTPException(400, "科目编码必须符合 4-2-2 层级")
    parent = None
    if body.parent_id is not None:
        parent = (
            db.query(Account)
            .filter_by(id=body.parent_id, account_book_id=book_id)
            .first()
        )
        if not parent:
            raise HTTPException(400, "父科目不存在或不属于当前账套")
        parent_model = cast(Any, parent)
        if not parent_model.is_active:
            raise HTTPException(400, "父科目已停用，不能新增下级")
        if (
            parent_model.direction != body.direction
            or parent_model.category != body.category
        ):
            raise HTTPException(400, "父子科目方向和类别必须一致")
        has_balance = (
            db.query(OpeningBalance)
            .filter(
                OpeningBalance.account_book_id == book_id,
                OpeningBalance.account_id == parent_model.id,
                (OpeningBalance.debit != 0) | (OpeningBalance.credit != 0),
            )
            .first()
        )
        if has_balance:
            raise HTTPException(400, "父科目已有余额或发生额，不能新增下级")
        parent_code = str(parent_model.code)
        if len(body.code) != len(parent_code) + 2 or not body.code.startswith(
            parent_code
        ):
            raise HTTPException(400, "子科目编码必须为父科目编码加两位")
    expected_level = len(body.code) // 2 - 1
    if expected_level < 1 or (
        parent is not None and expected_level != parent.level + 1
    ):
        raise HTTPException(400, "科目层级与编码不一致")
    return expected_level, parent


@router.post("/accounts")
def create_account(
    body: AccountIn,
    x_account_book: str | None = Header(default=None),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    book = _book_header(db, user, x_account_book)
    if not is_admin(user):
        raise HTTPException(403, "仅管理员可维护科目")
    level, parent = _validate_account_code(db, book.id, body)  # type: ignore[arg-type]
    if db.query(Account).filter_by(account_book_id=book.id, code=body.code).first():
        raise HTTPException(409, "科目编码已存在")
    if parent is not None:
        cast(Any, parent).is_leaf = False
    row = Account(
        account_book_id=book.id,
        code=body.code,
        name=body.name.strip(),
        level=level,
        parent_id=body.parent_id,
        direction=body.direction,
        category=body.category,
        aux_flags=body.aux_flags,
    )
    db.add(row)
    commit_audited(db, user.id, "create", "account", body.code, str(book.code))
    return {
        "id": row.id,
        "code": row.code,
        "name": row.name,
        "level": row.level,
        "is_leaf": row.is_leaf,
        "is_active": row.is_active,
    }


@router.patch("/accounts/{account_id}")
def toggle_account(
    account_id: int,
    active: bool,
    x_account_book: str | None = Header(default=None),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    book = _book_header(db, user, x_account_book)
    if not is_admin(user):
        raise HTTPException(403, "仅管理员可维护科目")
    row = db.query(Account).filter_by(id=account_id, account_book_id=book.id).first()
    if not row:
        raise HTTPException(404, "科目不存在")
    if not active:
        if (
            db.query(Account)
            .filter_by(parent_id=row.id, account_book_id=book.id)
            .first()
        ):
            raise HTTPException(400, "有下级科目时不能停用")
        has_balance = (
            db.query(OpeningBalance)
            .filter(
                OpeningBalance.account_book_id == book.id,
                OpeningBalance.account_id == row.id,
                (OpeningBalance.debit != 0) | (OpeningBalance.credit != 0),
            )
            .first()
        )
        if has_balance:
            raise HTTPException(400, "科目有期末余额或期初余额，不能停用")
        # P0-A has no voucher/ledger tables yet.  Keep this query explicit so
        # the guard automatically covers the first transaction tables when
        # they are introduced, without weakening the zero-activity contract.
        for table_name in ("journal_entry_lines", "voucher_lines", "ledger_entries"):
            table = Base.metadata.tables.get(table_name)
            if table is not None and db.execute(
                select(table.c.id).where(
                    table.c.account_book_id == book.id,
                    table.c.account_id == row.id,
                ).limit(1)
            ).first():
                raise HTTPException(400, "科目本期已有发生额，不能停用")
    cast(Any, row).is_active = active
    commit_audited(db, user.id, "update", "account", str(row.id), f"active={active}")
    return {"id": row.id, "is_active": row.is_active}


@router.get("/opening-balances")
def list_opening(
    x_account_book: str | None = Header(default=None),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    book = _book_header(db, user, x_account_book)
    return [
        {
            "id": x.id,
            "account_id": x.account_id,
            "aux_key": x.aux_key,
            "aux_detail": x.aux_detail,
            "debit": str(x.debit),
            "credit": str(x.credit),
        }
        for x in db.query(OpeningBalance).filter_by(account_book_id=book.id).all()
    ]


def _decimal(value: Decimal) -> Decimal:
    try:
        result = Decimal(value).quantize(Decimal("0.01"))
    except (InvalidOperation, ValueError) as exc:
        raise HTTPException(400, "金额必须为合法数字") from exc
    if result < 0:
        raise HTTPException(400, "金额不能为负数")
    return result


@router.post("/opening-balances")
def upsert_opening(
    body: OpeningIn,
    x_account_book: str | None = Header(default=None),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    book = _book_header(db, user, x_account_book)
    if not is_admin(user):
        raise HTTPException(403, "仅管理员可录入期初")
    account = (
        db.query(Account).filter_by(id=body.account_id, account_book_id=book.id).first()
    )
    if not account:
        raise HTTPException(400, "科目不存在或不属于当前账套")
    debit, credit = _decimal(body.debit), _decimal(body.credit)
    if debit and credit:
        raise HTTPException(400, "期初借贷只能填写一方")
    row = (
        db.query(OpeningBalance)
        .filter_by(account_book_id=book.id, account_id=account.id, aux_key=body.aux_key)
        .first()
    )
    if not row:
        row = OpeningBalance(
            account_book_id=book.id,
            account_id=account.id,
            aux_key=body.aux_key,
            aux_detail=body.aux_detail,
        )
        db.add(row)
    opening_model = cast(Any, row)
    opening_model.aux_detail, opening_model.debit, opening_model.credit = (
        body.aux_detail,
        debit,
        credit,
    )
    commit_audited(
        db,
        user.id,
        "upsert",
        "opening_balance",
        str(row.id or body.account_id),
        str(book.code),
    )
    return {"id": row.id, "debit": str(row.debit), "credit": str(row.credit)}


@router.get("/opening-balances/check")
def check_opening(
    x_account_book: str | None = Header(default=None),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    book = _book_header(db, user, x_account_book)
    rows = db.query(OpeningBalance).filter_by(account_book_id=book.id).all()
    debit = sum((x.debit for x in rows), Decimal(0))
    credit = sum((x.credit for x in rows), Decimal(0))
    return {
        "balanced": debit == credit,
        "debit": str(debit),
        "credit": str(credit),
        "difference": str(debit - credit),
    }


@router.get("/auxiliary-items")
def list_auxiliary(
    kind: str = "",
    x_account_book: str | None = Header(default=None),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    book = _book_header(db, user, x_account_book)
    q = db.query(AuxiliaryItem).filter_by(account_book_id=book.id)
    if kind:
        if kind not in AUX_KINDS:
            raise HTTPException(400, "辅助资料类型不合法")
        q = q.filter_by(kind=kind)
    return [
        {
            "id": x.id,
            "kind": x.kind,
            "code": x.code,
            "name": x.name,
            "metadata": x.extra_data,
            "is_active": x.is_active,
        }
        for x in q.order_by(AuxiliaryItem.id).all()
    ]


@router.get("/account-auxiliaries")
def list_account_auxiliaries(
    account_id: int | None = Query(default=None),
    x_account_book: str | None = Header(default=None),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    book = _book_header(db, user, x_account_book)
    query = db.query(AccountAuxiliary).filter_by(account_book_id=book.id)
    if account_id is not None:
        query = query.filter_by(account_id=account_id)
    return [
        {
            "id": x.id,
            "account_id": x.account_id,
            "auxiliary_item_id": x.auxiliary_item_id,
        }
        for x in query.order_by(AccountAuxiliary.id).all()
    ]


@router.post("/account-auxiliaries")
def create_account_auxiliary(
    body: AccountAuxiliaryIn,
    x_account_book: str | None = Header(default=None),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    book = _book_header(db, user, x_account_book)
    if not is_admin(user):
        raise HTTPException(403, "仅管理员可维护科目辅助核算")
    account = (
        db.query(Account).filter_by(id=body.account_id, account_book_id=book.id).first()
    )
    item = (
        db.query(AuxiliaryItem)
        .filter_by(id=body.auxiliary_item_id, account_book_id=book.id)
        .first()
    )
    if not account or not item:
        raise HTTPException(400, "科目或辅助资料不存在或不属于当前账套")
    flags = account.aux_flags or {}
    flag_name = {"department": "dept"}.get(cast(str, item.kind), cast(str, item.kind))
    if not flags.get(flag_name, False):
        raise HTTPException(400, "该科目未启用此辅助核算维度")
    row = AccountAuxiliary(
        account_book_id=book.id, account_id=account.id, auxiliary_item_id=item.id
    )
    db.add(row)
    try:
        commit_audited(
            db, user.id, "create", "account_auxiliary", str(item.id), str(book.code)
        )
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(409, "科目辅助核算关联已存在") from exc
    return {
        "id": row.id,
        "account_id": row.account_id,
        "auxiliary_item_id": row.auxiliary_item_id,
    }


@router.delete("/account-auxiliaries/{link_id}")
def delete_account_auxiliary(
    link_id: int,
    x_account_book: str | None = Header(default=None),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    book = _book_header(db, user, x_account_book)
    if not is_admin(user):
        raise HTTPException(403, "仅管理员可维护科目辅助核算")
    row = (
        db.query(AccountAuxiliary)
        .filter_by(id=link_id, account_book_id=book.id)
        .first()
    )
    if not row:
        raise HTTPException(404, "科目辅助核算关联不存在")
    db.delete(row)
    commit_audited(
        db, user.id, "delete", "account_auxiliary", str(link_id), str(book.code)
    )
    return {"deleted": True, "id": link_id}


@router.post("/auxiliary-items")
def create_auxiliary(
    body: AuxiliaryIn,
    x_account_book: str | None = Header(default=None),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    book = _book_header(db, user, x_account_book)
    if not is_admin(user):
        raise HTTPException(403, "仅管理员可维护辅助资料")
    if body.kind not in AUX_KINDS:
        raise HTTPException(400, "辅助资料类型不合法")
    row = AuxiliaryItem(
        account_book_id=book.id,
        kind=body.kind,
        code=body.code.strip(),
        name=body.name.strip(),
        extra_data=body.metadata,
    )
    db.add(row)
    commit_audited(db, user.id, "create", "auxiliary_item", body.code, str(book.code))
    return {
        "id": row.id,
        "kind": row.kind,
        "code": row.code,
        "name": row.name,
        "metadata": row.extra_data,
    }
