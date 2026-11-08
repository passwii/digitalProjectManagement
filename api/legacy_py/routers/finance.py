"""P0-A 财务 API：账套与基础资料由 finance 模块统一控制；业务状态校验保持不变。"""

from calendar import monthrange
from datetime import date
from decimal import Decimal, InvalidOperation
from typing import Any, cast

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..core.audit import commit_audited
from ..core.database import get_db
from ..core.deps import get_current_user
from ..core.timeutil import app_now
from ..models import (
    Account,
    AccountAuxiliary,
    AccountBook,
    AccountBalance,
    AccountingPeriod,
    AuxiliaryItem,
    OpeningBalance,
    User,
)

router = APIRouter(prefix="/finance", tags=["finance"])

CATEGORIES = {"资产", "负债", "权益", "成本", "损益"}
AUX_KINDS = {"customer", "vendor", "department", "employee", "project", "cashflow"}
ACCOUNT_AUX_FLAGS = {"customer", "vendor", "dept", "employee", "project", "cashflow"}
ACCOUNT_SUBJECT_VERSION = "2022"


def _finance_error(
    status_code: int,
    code: str,
    message: str,
    details: list[dict[str, str]] | None = None,
) -> None:
    raise HTTPException(
        status_code,
        detail={"code": code, "message": message, "details": details or []},
    )


class BookIn(BaseModel):
    code: str = Field(min_length=1, max_length=32)
    name: str = Field(min_length=1, max_length=128)
    base_currency: str = Field(default="CNY", min_length=3, max_length=3)


class BookDeleteIn(BaseModel):
    confirmation_code: str = Field(min_length=1, max_length=32)
    acknowledged_retention: bool = False


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
    book = db.query(AccountBook).filter(AccountBook.id == book_id, AccountBook.deleted_at.is_(None)).first()
    if not book:
        _finance_error(404, "F-NO-BOOK-ACCESS", "账套不存在")
    return book


def _book_header(db: Session, user: User, header: str | None) -> AccountBook:
    code = (header or "").strip()
    if not code:
        _finance_error(403, "F-NO-BOOK-ACCESS", "请通过 X-Account-Book 指定账套 code")
    book = db.query(AccountBook).filter(AccountBook.code == code, AccountBook.deleted_at.is_(None)).first()
    if not book:
        _finance_error(403, "F-NO-BOOK-ACCESS", "账套不存在")
    return _book_access(db, user, book.id)  # type: ignore[arg-type]


def _period_dates(year: int, month: int) -> tuple[date, date]:
    if month == 13:
        return date(year, 12, 31), date(year, 12, 31)
    return date(year, month, 1), date(year, month, monthrange(year, month)[1])


def _seed_accounts(db: Session, book_id: int) -> None:
    """幂等导入 2022 企业会计准则基础树（一级/二级全量及常用三级）。"""
    # This is deliberately data, not test-only setup: the subject_version on
    # every row makes future chart revisions explicit while preserving local
    # account names and flags on an existing book.
    seeds = (
        ("1001", "库存现金", "D", "资产", None, {"cashflow": True}),
        ("1002", "银行存款", "D", "资产", None, {"cashflow": True}),
        ("100201", "招行基本户", "D", "资产", "1002", {"cashflow": True}),
        ("10020101", "招行基本户-人民币", "D", "资产", "100201", {"cashflow": True}),
        ("1012", "其他货币资金", "D", "资产", None, {"cashflow": True}),
        ("1101", "交易性金融资产", "D", "资产", None, {}),
        ("1102", "短期投资", "D", "资产", None, {}),
        ("1103", "应收股利", "D", "资产", None, {}),
        ("1111", "应收利息", "D", "资产", None, {}),
        ("1121", "应收票据", "D", "资产", None, {}),
        ("1122", "应收账款", "D", "资产", None, {"customer": True}),
        ("112201", "应收账款-国内客户", "D", "资产", "1122", {"customer": True}),
        ("11220101", "应收账款-国内客户-一类", "D", "资产", "112201", {"customer": True}),
        ("1123", "预付账款", "D", "资产", None, {"vendor": True}),
        ("1131", "应收股利", "D", "资产", None, {}),
        ("1132", "应收利息", "D", "资产", None, {}),
        ("1221", "其他应收款", "D", "资产", None, {}),
        ("1231", "坏账准备", "C", "资产", None, {}),
        ("1401", "材料采购", "D", "资产", None, {}),
        ("1402", "在途物资", "D", "资产", None, {}),
        ("1403", "原材料", "D", "资产", None, {}),
        ("1404", "材料成本差异", "D", "资产", None, {}),
        ("1405", "库存商品", "D", "资产", None, {}),
        ("1406", "发出商品", "D", "资产", None, {}),
        ("1407", "商品进销差价", "C", "资产", None, {}),
        ("1408", "委托加工物资", "D", "资产", None, {}),
        ("1411", "周转材料", "D", "资产", None, {}),
        ("1471", "存货跌价准备", "C", "资产", None, {}),
        ("1501", "持有至到期投资", "D", "资产", None, {}),
        ("1503", "可供出售金融资产", "D", "资产", None, {}),
        ("1511", "长期股权投资", "D", "资产", None, {}),
        ("1521", "投资性房地产", "D", "资产", None, {}),
        ("1531", "长期应收款", "D", "资产", None, {}),
        ("1601", "固定资产", "D", "资产", None, {}),
        ("1602", "累计折旧", "C", "资产", None, {}),
        ("1603", "固定资产减值准备", "C", "资产", None, {}),
        ("1604", "在建工程", "D", "资产", None, {}),
        ("1606", "固定资产清理", "D", "资产", None, {}),
        ("1701", "无形资产", "D", "资产", None, {}),
        ("1702", "累计摊销", "C", "资产", None, {}),
        ("1703", "无形资产减值准备", "C", "资产", None, {}),
        ("1801", "长期待摊费用", "D", "资产", None, {}),
        ("1811", "递延所得税资产", "D", "资产", None, {}),
        ("1901", "待处理财产损溢", "D", "资产", None, {}),
        ("2001", "短期借款", "C", "负债", None, {}),
        ("2101", "交易性金融负债", "C", "负债", None, {}),
        ("2201", "应付票据", "C", "负债", None, {}),
        ("2202", "应付账款", "C", "负债", None, {"vendor": True}),
        ("220201", "应付账款-国内供应商", "C", "负债", "2202", {"vendor": True}),
        ("22020101", "应付账款-国内供应商-一类", "C", "负债", "220201", {"vendor": True}),
        ("2203", "预收账款", "C", "负债", None, {}),
        ("2211", "应付职工薪酬", "C", "负债", None, {}),
        ("2221", "应交税费", "C", "负债", None, {}),
        ("222101", "应交税费-应交增值税", "C", "负债", "2221", {}),
        ("22210101", "应交税费-应交增值税-进项税额", "C", "负债", "222101", {}),
        ("2231", "应付利息", "C", "负债", None, {}),
        ("2241", "其他应付款", "C", "负债", None, {}),
        ("2401", "递延收益", "C", "负债", None, {}),
        ("2501", "长期借款", "C", "负债", None, {}),
        ("2601", "应付债券", "C", "负债", None, {}),
        ("2701", "长期应付款", "C", "负债", None, {}),
        ("2801", "预计负债", "C", "负债", None, {}),
        ("2901", "递延所得税负债", "C", "负债", None, {}),
        ("3001", "实收资本", "C", "权益", None, {}),
        ("3002", "资本公积", "C", "权益", None, {}),
        ("3101", "盈余公积", "C", "权益", None, {}),
        ("3103", "本年利润", "C", "权益", None, {}),
        ("3104", "利润分配", "C", "权益", None, {}),
        ("4001", "生产成本", "D", "成本", None, {}),
        ("4101", "制造费用", "D", "成本", None, {}),
        ("5001", "开发成本", "D", "成本", None, {}),
        ("5101", "研发支出", "D", "成本", None, {}),
        ("6001", "主营业务收入", "C", "损益", None, {}),
        ("6051", "其他业务收入", "C", "损益", None, {}),
        ("6101", "公允价值变动损益", "C", "损益", None, {}),
        ("6111", "投资收益", "C", "损益", None, {}),
        ("6301", "营业外收入", "C", "损益", None, {}),
        ("6401", "主营业务成本", "D", "成本", None, {}),
        ("6402", "其他业务成本", "D", "成本", None, {}),
        ("6601", "销售费用", "D", "损益", None, {"dept": True}),
        ("6602", "管理费用", "D", "损益", None, {"dept": True}),
        ("660201", "管理费用-办公费", "D", "损益", "6602", {"dept": True}),
        ("66020101", "管理费用-办公费-日常", "D", "损益", "660201", {"dept": True}),
        ("6603", "财务费用", "D", "损益", None, {"dept": True}),
        ("6711", "营业外支出", "D", "损益", None, {}),
        ("6801", "所得税费用", "D", "损益", None, {}),
        ("6901", "以前年度损益调整", "D", "损益", None, {}),
    )
    for code, name, direction, category, parent_code, aux_flags in seeds:
        row = db.query(Account).filter_by(account_book_id=book_id, code=code).first()
        if row:
            continue
        parent = (
            db.query(Account).filter_by(account_book_id=book_id, code=parent_code).first()
            if parent_code else None
        )
        row = Account(
            account_book_id=book_id, code=code, name=name,
            level=len(code) // 2 - 1, parent_id=parent.id if parent else None,
            direction=direction, category=category, aux_flags=aux_flags,
            subject_version=ACCOUNT_SUBJECT_VERSION, is_leaf=True,
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
    code = body.code.strip()
    currency = body.base_currency.upper()
    if currency != "CNY":
        _finance_error(400, "F-BOOK-CURRENCY", "财务账套仅支持人民币（CNY）")
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
    _seed_accounts(db, book.id)  # type: ignore[arg-type]
    try:
        commit_audited(db, user.id, "create", "account_book", str(book.id), code)
    except IntegrityError as exc:
        db.rollback()
        _finance_error(409, "F-NO-BOOK-ACCESS", "账套创建失败")
    return _serialize_book(book)


@router.get("/books")
def list_books(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    q = db.query(AccountBook).filter(AccountBook.deleted_at.is_(None))
    return [_serialize_book(x) for x in q.order_by(AccountBook.id).all()]


@router.delete("/books/{book_id}")
def delete_book(
    book_id: int,
    body: BookDeleteIn,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """把账套移入回收站；数据库中的账套及其业务数据全部保留。"""
    book = (
        db.query(AccountBook)
        .filter(AccountBook.id == book_id, AccountBook.deleted_at.is_(None))
        .with_for_update()
        .first()
    )
    if not book:
        _finance_error(404, "F-NO-BOOK-ACCESS", "账套不存在或已在回收站")
    if body.confirmation_code.strip() != book.code:
        _finance_error(400, "F-BOOK-DELETE-CONFIRM", "账套编码确认不匹配")
    if not body.acknowledged_retention:
        _finance_error(400, "F-BOOK-DELETE-CONFIRM", "请确认账套数据将保留并可由管理员恢复")
    book.deleted_at = app_now()
    book.deleted_by = user.id
    commit_audited(db, user.id, "soft_delete", "account_book", str(book.id), f"移入回收站：{book.code}")
    return {"ok": True, "id": book_id, "deleted_at": book.deleted_at.isoformat()}


@router.get("/books/recycle-bin/list")
def list_deleted_books(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """列出保留在数据库中的账套。"""
    books = (
        db.query(AccountBook)
        .filter(AccountBook.deleted_at.is_not(None))
        .order_by(AccountBook.deleted_at.desc(), AccountBook.id.desc())
        .all()
    )
    return [
        {
            **_serialize_book(book),
            "deleted_at": book.deleted_at.isoformat() if book.deleted_at else None,
            "deleted_by": book.deleted_by,
        }
        for book in books
    ]


@router.post("/books/{book_id}/restore")
def restore_book(
    book_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """从回收站恢复账套及其原有业务数据。"""
    book = (
        db.query(AccountBook)
        .filter(AccountBook.id == book_id, AccountBook.deleted_at.is_not(None))
        .with_for_update()
        .first()
    )
    if not book:
        _finance_error(404, "F-NO-BOOK-ACCESS", "回收站中不存在该账套")
    book.deleted_at = None
    book.deleted_by = None
    commit_audited(db, user.id, "restore", "account_book", str(book.id), f"恢复账套：{book.code}")
    return _serialize_book(book)


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
    row = (
        db.query(AccountingPeriod)
        .filter_by(id=period_id, account_book_id=book.id)
        .with_for_update()
        .first()
    )
    if not row:
        _finance_error(404, "F-NO-BOOK-ACCESS", "期间不存在")
    period = cast(Any, row)
    current_status = str(period.status)
    allowed_transitions = {
        "open": {"open", "closed"},
        "closed": {"closed", "locked", "open"},
        "locked": {"locked"},
    }
    if body.status not in allowed_transitions.get(current_status, set()):
        _finance_error(400, "F-PERIOD-CLOSED", "期间状态只能按 open→closed→locked 流转")
    expected_version = None
    if if_match:
        try:
            expected_version = int(if_match.strip().strip('"'))
        except ValueError:
            _finance_error(400, "F-PERIOD-CLOSED", "If-Match 必须为期间 version")
    if expected_version is not None and expected_version != period.version:
        _finance_error(409, "F-PERIOD-CLOSED", "期间已被其他请求更新，请刷新后重试")
    if current_status == "locked" and body.status != "locked":
        _finance_error(400, "F-PERIOD-CLOSED", "已锁定期间不能重新打开或结账")
    if current_status == "closed" and body.status == "open":
        if (x_reopen_period or "").lower() != "confirm":
            _finance_error(400, "F-PERIOD-CLOSED", "已结账期间不能直接重新打开；反结账需二次确认")
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
            _finance_error(400, "F-REVERSE-ORDER", "反结账必须按期间倒序，后一期间尚未打开")
    if body.status == "locked" and current_status != "closed":
        _finance_error(400, "F-PERIOD-CLOSED", "只能锁定已结账期间")
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


@router.post("/periods/{period_id}/close")
@router.patch("/periods/{period_id}/close")
def close_period(
    period_id: int,
    x_account_book: str | None = Header(default=None),
    if_match: str | None = Header(default=None, alias="If-Match"),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """冻结契约别名：结账。"""
    return update_period(
        period_id,
        PeriodStatusIn(status="closed"),
        x_account_book,
        if_match,
        None,
        db,
        user,
    )


@router.post("/periods/{period_id}/reopen")
@router.patch("/periods/{period_id}/reopen")
def reopen_period(
    period_id: int,
    x_account_book: str | None = Header(default=None),
    if_match: str | None = Header(default=None, alias="If-Match"),
    x_reopen_period: str | None = Header(default=None, alias="X-Reopen-Period"),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """冻结契约别名：反结账，必须显式二次确认。"""
    return update_period(
        period_id,
        PeriodStatusIn(status="open"),
        x_account_book,
        if_match,
        x_reopen_period,
        db,
        user,
    )


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
            "subject_version": x.subject_version,
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
    level, parent = _validate_account_code(db, book.id, body)  # type: ignore[arg-type]
    if db.query(Account).filter_by(account_book_id=book.id, code=body.code).first():
        _finance_error(409, "F-ACCT-INACTIVE", "科目编码已存在")
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
    row = db.query(Account).filter_by(id=account_id, account_book_id=book.id).first()
    if not row:
        _finance_error(400, "F-ACCT-INACTIVE", "科目不存在")
    if not active:
        if (
            db.query(Account)
            .filter_by(parent_id=row.id, account_book_id=book.id)
            .first()
        ):
            _finance_error(400, "F-ACCT-INACTIVE", "有下级科目时不能停用")
        has_balance = (
            db.query(OpeningBalance)
            .filter(
                OpeningBalance.account_book_id == book.id,
                OpeningBalance.account_id == row.id,
                (OpeningBalance.debit != 0) | (OpeningBalance.credit != 0),
            )
            .first()
        )
        has_activity = (
            db.query(AccountBalance)
            .filter(
                AccountBalance.account_book_id == book.id,
                AccountBalance.account_id == row.id,
                (
                    (AccountBalance.opening_debit != 0)
                    | (AccountBalance.opening_credit != 0)
                    | (AccountBalance.debit_total != 0)
                    | (AccountBalance.credit_total != 0)
                    | (AccountBalance.ending_debit != 0)
                    | (AccountBalance.ending_credit != 0)
                ),
            )
            .first()
        )
        if has_balance or has_activity:
            _finance_error(400, "F-ACCT-INACTIVE", "科目有余额或本期发生额，不能停用")
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
    account = (
        db.query(Account).filter_by(id=body.account_id, account_book_id=book.id).first()
    )
    if not account:
        _finance_error(400, "F-ACCT-INACTIVE", "科目不存在或不属于当前账套")
    account_model = cast(Any, account)
    if not account_model.is_active or not account_model.is_leaf:
        _finance_error(400, "F-ACCT-INACTIVE", "期初余额只能录入启用的末级科目")
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
    account = (
        db.query(Account).filter_by(id=body.account_id, account_book_id=book.id).first()
    )
    item = (
        db.query(AuxiliaryItem)
        .filter_by(id=body.auxiliary_item_id, account_book_id=book.id)
        .first()
    )
    if not account or not item:
        _finance_error(400, "F-ACCT-INACTIVE", "科目或辅助资料不存在或不属于当前账套")
    flags = account.aux_flags or {}
    flag_name = {"department": "dept"}.get(cast(str, item.kind), cast(str, item.kind))
    if not flags.get(flag_name, False):
        _finance_error(400, "F-ACCT-INACTIVE", "该科目未启用此辅助核算维度")
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
        _finance_error(409, "F-ACCT-INACTIVE", "科目辅助核算关联已存在")
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
    row = (
        db.query(AccountAuxiliary)
        .filter_by(id=link_id, account_book_id=book.id)
        .first()
    )
    if not row:
        _finance_error(404, "F-NO-BOOK-ACCESS", "科目辅助核算关联不存在")
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
    if body.kind not in AUX_KINDS:
        _finance_error(400, "F-ACCT-INACTIVE", "辅助资料类型不合法")
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
