"""P0-B/C 财务凭证、余额、账簿与基础报表 API。

首期沿用 admin-only 财务权限。项目管理的 Budget/Expense 不会自动写入本模块；
所有会计事实都从本路由的已过账凭证产生。
"""

import io
import json
from datetime import date
from decimal import Decimal, InvalidOperation
from typing import Any, cast

from fastapi import APIRouter, Depends, File, Header, HTTPException, Query, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from ..core.audit import commit_audited
from ..core.database import get_db
from ..core.deps import get_current_user
from ..core.rbac import ROLE_CASHIER, ROLE_FINANCE_CLERK, ROLE_FINANCE_MANAGER, ROLE_FINANCE_REVIEWER, is_admin, require_finance
from ..core.timeutil import app_now
from ..models import Account, AccountBalance, AccountBook, AccountingPeriod, AssetDepreciation, BankStatement, CashTransaction, FixedAsset, OpeningBalance, User, Voucher, VoucherEntry, VoucherTemplate
from .finance import _book_header

router = APIRouter(prefix="/finance", tags=["finance-accounting"])
EXTERNAL_VOUCHER_SOURCES = {"manual", "template", "import"}
INTERNAL_VOUCHER_SOURCES = EXTERNAL_VOUCHER_SOURCES | {"cash", "auto-close", "auto-reopen", "reversal", "auto-asset"}


def _error(status: int, code: str, message: str, details: list[dict[str, str]] | None = None):
    raise HTTPException(status, detail={"code": code, "message": message, "details": details or []})


def _role(db: Session, user: User, book_id: int, allowed: set[str] | None = None):
    try:
        return require_finance(db, user, book_id, allowed)
    except HTTPException as exc:
        _error(exc.status_code, "F-FINANCE-ROLE", str(exc.detail))


def _admin(user: User):
    if not is_admin(user):
        _error(403, "F-FINANCE-ROLE", "仅系统管理员可执行此操作")


def _money(value: Any, field: str = "金额") -> Decimal:
    try:
        result = Decimal(str(value)).quantize(Decimal("0.01"))
    except (InvalidOperation, ValueError, TypeError) as exc:
        _error(400, "F-INVALID-AMOUNT", f"{field}必须为合法数字")
        raise exc
    if not result.is_finite():
        _error(400, "F-INVALID-AMOUNT", f"{field}必须为有限数字")
    if result < 0:
        _error(400, "F-INVALID-AMOUNT", f"{field}不能为负数")
    return result


class EntryIn(BaseModel):
    account_id: int
    summary: str = Field(default="", max_length=255)
    debit: Decimal = Decimal("0.00")
    credit: Decimal = Decimal("0.00")
    aux_detail: dict = Field(default_factory=dict)
    cashflow_item: str | None = Field(default=None, max_length=32)


class VoucherIn(BaseModel):
    period_id: int
    voucher_no: str = Field(min_length=1, max_length=32)
    voucher_date: date
    summary: str = Field(default="", max_length=255)
    source: str = Field(default="manual", max_length=16)
    lines: list[EntryIn] = Field(min_length=2)


class VoucherPatch(BaseModel):
    period_id: int | None = None
    voucher_no: str | None = Field(default=None, min_length=1, max_length=32)
    voucher_date: date | None = None
    summary: str | None = Field(default=None, max_length=255)
    lines: list[EntryIn] | None = Field(default=None, min_length=2)


class ReasonIn(BaseModel):
    reason: str = Field(default="", max_length=500)


class TemplateIn(BaseModel):
    code: str = Field(min_length=1, max_length=32)
    name: str = Field(min_length=1, max_length=128)
    lines: list[EntryIn] = Field(min_length=2)


class FromTemplateIn(BaseModel):
    template_id: int
    period_id: int
    voucher_no: str = Field(min_length=1, max_length=32)
    voucher_date: date
    summary: str = Field(default="", max_length=255)


class CashTransactionIn(BaseModel):
    period_id: int
    kind: str = Field(pattern="^(receipt|payment|expense)$")
    transaction_date: date
    amount: Decimal
    account_id: int
    offset_account_id: int
    summary: str = Field(default="", max_length=255)
    counterparty: str = Field(default="", max_length=128)
    cashflow_item: str | None = Field(default=None, max_length=32)


class BankMatchIn(BaseModel):
    voucher_id: int


class FixedAssetIn(BaseModel):
    code: str = Field(min_length=1, max_length=64)
    name: str = Field(min_length=1, max_length=128)
    category: str = Field(default="", max_length=64)
    acquisition_date: date
    original_cost: Decimal
    residual_rate: Decimal = Decimal("0")
    useful_life_months: int = Field(gt=0)
    asset_account_id: int
    depreciation_account_id: int
    expense_account_id: int


def _period(db: Session, book_id: int, period_id: int) -> AccountingPeriod:
    row = db.query(AccountingPeriod).filter_by(id=period_id, account_book_id=book_id).first()
    if not row:
        _error(400, "F-PERIOD-CLOSED", "期间不存在或不属于当前账套")
    return cast(AccountingPeriod, row)


def _normalise_lines(db: Session, book_id: int, period: AccountingPeriod, lines: list[EntryIn]):
    if not lines:
        _error(400, "F-INVALID-VOUCHER", "凭证至少需要两条分录")
    total_debit = Decimal("0.00")
    total_credit = Decimal("0.00")
    prepared: list[dict[str, Any]] = []
    errors: list[dict[str, str]] = []
    for index, line in enumerate(lines, 1):
        debit = _money(line.debit, f"第{index}行借方")
        credit = _money(line.credit, f"第{index}行贷方")
        if (debit > 0) == (credit > 0):
            errors.append({"field": f"lines[{index - 1}]", "reason": "借贷金额必须且只能填写一方"})
            continue
        account = db.query(Account).filter_by(id=line.account_id, account_book_id=book_id).first()
        if not account:
            errors.append({"field": f"lines[{index - 1}].account_id", "reason": "科目不存在或不属于当前账套"})
            continue
        account_model = cast(Account, account)
        if not account_model.is_active or not account_model.is_leaf:
            errors.append({"field": f"lines[{index - 1}].account_id", "reason": "只能使用启用的末级科目"})
            continue
        flags = account_model.aux_flags or {}
        aux = line.aux_detail or {}
        for flag, label in (("customer", "客户"), ("vendor", "供应商"), ("dept", "部门"), ("employee", "员工"), ("project", "项目")):
            if flags.get(flag) and not aux.get(flag):
                errors.append({"field": f"lines[{index - 1}].aux_detail.{flag}", "reason": f"科目要求填写{label}辅助核算"})
        if flags.get("cashflow") and not line.cashflow_item:
            errors.append({"field": f"lines[{index - 1}].cashflow_item", "reason": "现金类科目必须填写现金流项目"})
        total_debit += debit
        total_credit += credit
        prepared.append({"account": account_model, "summary": line.summary.strip(), "debit": debit, "credit": credit, "aux_detail": aux, "cashflow_item": line.cashflow_item})
    if errors:
        _error(400, "F-INVALID-VOUCHER", "凭证分录校验失败", errors)
    if total_debit != total_credit or total_debit <= 0:
        _error(400, "F-UNBALANCED", f"凭证借贷不平：借方 {total_debit}，贷方 {total_credit}")
    return prepared, total_debit, total_credit


def _serialize(voucher: Voucher, entries: list[VoucherEntry], accounts: dict[int, Account] | None = None):
    accounts = accounts or {}
    return {
        "id": voucher.id,
        "period_id": voucher.period_id,
        "voucher_no": voucher.voucher_no,
        "voucher_date": voucher.voucher_date.isoformat(),
        "status": voucher.status,
        "source": voucher.source,
        "summary": voucher.summary,
        "total_debit": str(voucher.total_debit),
        "total_credit": str(voucher.total_credit),
        "created_by": voucher.created_by,
        "reviewed_by": voucher.reviewed_by,
        "posted_by": voucher.posted_by,
        "reversal_of": voucher.reversal_of,
        "decision_reason": voucher.decision_reason,
        "lines": [
            {"id": entry.id, "line_no": entry.line_no, "account_id": entry.account_id, "account_code": accounts.get(entry.account_id).code if entry.account_id in accounts else "", "account_name": accounts.get(entry.account_id).name if entry.account_id in accounts else "", "summary": entry.summary, "debit": str(entry.debit), "credit": str(entry.credit), "aux_detail": entry.aux_detail, "cashflow_item": entry.cashflow_item}
            for entry in entries
        ],
    }


def _load_voucher(db: Session, book_id: int, voucher_id: int) -> Voucher:
    row = db.query(Voucher).filter_by(id=voucher_id, account_book_id=book_id).first()
    if not row:
        _error(404, "F-VOUCHER-NOT-FOUND", "凭证不存在")
    return cast(Voucher, row)


def _entries(db: Session, voucher_id: int):
    rows = db.query(VoucherEntry).filter_by(voucher_id=voucher_id).order_by(VoucherEntry.line_no).all()
    account_ids = {row.account_id for row in rows}
    accounts = {row.id: row for row in db.query(Account).filter(Account.id.in_(account_ids or [0])).all()}
    return rows, accounts


def _template_json(template: VoucherTemplate) -> dict:
    return {"id": template.id, "code": template.code, "name": template.name, "lines": template.lines, "is_active": template.is_active}


@router.get("/voucher-templates")
def list_voucher_templates(x_account_book: str | None = Header(default=None), db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    book = _book_header(db, user, x_account_book)
    _role(db, user, book.id)
    return [_template_json(row) for row in db.query(VoucherTemplate).filter_by(account_book_id=book.id, is_active=True).order_by(VoucherTemplate.code).all()]


@router.post("/voucher-templates")
def create_voucher_template(body: TemplateIn, x_account_book: str | None = Header(default=None), db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    book = _book_header(db, user, x_account_book)
    _role(db, user, book.id, {ROLE_FINANCE_CLERK, ROLE_FINANCE_MANAGER})
    if db.query(VoucherTemplate).filter_by(account_book_id=book.id, code=body.code.strip()).first():
        _error(409, "F-TEMPLATE-DUPLICATE", "模板编码已存在")
    period = _period(db, book.id, next((row.id for row in db.query(AccountingPeriod).filter_by(account_book_id=book.id).order_by(AccountingPeriod.period_index).all()), 0))
    prepared, debit, credit = _normalise_lines(db, book.id, period, body.lines)
    lines = [{"account_id": item["account"].id, "summary": item["summary"], "debit": str(item["debit"]), "credit": str(item["credit"]), "aux_detail": item["aux_detail"], "cashflow_item": item["cashflow_item"]} for item in prepared]
    template = VoucherTemplate(account_book_id=book.id, code=body.code.strip(), name=body.name.strip(), lines=lines, created_by=user.id, created_at=app_now())
    db.add(template)
    commit_audited(db, user.id, "create", "voucher_template", body.code, book.code)
    return _template_json(template)


@router.post("/vouchers/from-template")
def voucher_from_template(body: FromTemplateIn, x_account_book: str | None = Header(default=None), db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    book = _book_header(db, user, x_account_book)
    _role(db, user, book.id, {ROLE_FINANCE_CLERK, ROLE_FINANCE_MANAGER})
    template = db.query(VoucherTemplate).filter_by(id=body.template_id, account_book_id=book.id, is_active=True).first()
    if not template:
        _error(404, "F-TEMPLATE-NOT-FOUND", "凭证模板不存在")
    period = _period(db, book.id, body.period_id)
    lines = [EntryIn(**line) for line in (template.lines or [])]
    payload = VoucherIn(period_id=body.period_id, voucher_no=body.voucher_no, voucher_date=body.voucher_date, summary=body.summary, source="template", lines=lines)
    return create_voucher(payload, x_account_book, db, user)


IMPORT_HEADERS = ["凭证号", "凭证日期", "摘要", "科目编码", "分录摘要", "借方", "贷方", "现金流项目", "辅助核算JSON"]


@router.post("/vouchers/import")
def import_vouchers(period_id: int, file: UploadFile = File(...), x_account_book: str | None = Header(default=None), db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    book = _book_header(db, user, x_account_book)
    _role(db, user, book.id, {ROLE_FINANCE_CLERK, ROLE_FINANCE_MANAGER})
    period = _period(db, book.id, period_id)
    if period.status != "open":
        _error(400, "F-PERIOD-CLOSED", "当前期间不可导入凭证")
    try:
        from openpyxl import load_workbook
        workbook = load_workbook(file.file, read_only=True, data_only=True)
        sheet = workbook.active
        rows = list(sheet.iter_rows(values_only=True))
    except Exception as exc:
        _error(400, "F-IMPORT-INVALID", "Excel 解析失败", [{"row": "1", "reason": str(exc)}])
    if not rows or list(rows[0][:len(IMPORT_HEADERS)]) != IMPORT_HEADERS:
        _error(400, "F-IMPORT-INVALID", "Excel 表头不符合凭证导入模板", [{"row": "1", "reason": "表头必须为：" + "、".join(IMPORT_HEADERS)}])
    grouped: dict[str, list[tuple[int, list[Any]]]] = {}
    errors: list[dict[str, Any]] = []
    for row_number, raw in enumerate(rows[1:], 2):
        values = list(raw[:len(IMPORT_HEADERS)]) + [None] * max(0, len(IMPORT_HEADERS) - len(raw))
        if not any(value not in (None, "") for value in values):
            continue
        voucher_no, voucher_date, summary, account_code, line_summary, debit, credit, cashflow_item, aux_raw = values
        grouped.setdefault(str(voucher_no or "").strip(), []).append((row_number, values))
    payloads: list[VoucherIn] = []
    for voucher_no, group in grouped.items():
        if not voucher_no:
            errors.append({"row": group[0][0], "reason": "凭证号不能为空"})
            continue
        lines: list[EntryIn] = []
        voucher_date = None
        summary = ""
        for row_number, values in group:
            _, raw_date, raw_summary, account_code, line_summary, debit, credit, cashflow_item, aux_raw = values
            account = db.query(Account).filter_by(account_book_id=book.id, code=str(account_code or "").strip()).first()
            if not account:
                errors.append({"row": row_number, "reason": f"科目编码不存在：{account_code}"})
                continue
            try:
                parsed_date = raw_date if isinstance(raw_date, date) else date.fromisoformat(str(raw_date))
                aux_detail = json.loads(aux_raw or "{}")
                if not isinstance(aux_detail, dict):
                    raise ValueError("辅助核算JSON必须为对象")
                lines.append(EntryIn(account_id=account.id, summary=str(line_summary or ""), debit=Decimal(str(debit or "0")), credit=Decimal(str(credit or "0")), cashflow_item=str(cashflow_item).strip() if cashflow_item else None, aux_detail=aux_detail))
                voucher_date = parsed_date
                summary = str(raw_summary or "")
            except Exception as exc:
                errors.append({"row": row_number, "reason": f"数据格式错误：{exc}"})
        if lines and voucher_date:
            payloads.append(VoucherIn(period_id=period_id, voucher_no=voucher_no, voucher_date=voucher_date, summary=summary, source="import", lines=lines))
    if errors:
        _error(400, "F-IMPORT-INVALID", "Excel 导入校验失败，未写入任何凭证", errors)
    try:
        created_rows = [_build_draft_voucher(db, book, payload, user) for payload in payloads]
        commit_audited(db, user.id, "import_vouchers", "vouchers", str(period.id), f"count={len(created_rows)}")
        created = []
        for row in created_rows:
            entries, accounts = _entries(db, row.id)
            created.append(_serialize(row, entries, accounts))
        return {"imported": len(created), "vouchers": created}
    except HTTPException:
        db.rollback()
        raise


@router.get("/vouchers/export")
def export_vouchers(period_id: int, x_account_book: str | None = Header(default=None), db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    book = _book_header(db, user, x_account_book)
    _role(db, user, book.id)
    period = _period(db, book.id, period_id)
    from openpyxl import Workbook
    workbook = Workbook()
    sheet = workbook.active
    sheet.append(IMPORT_HEADERS)
    rows = db.query(Voucher).filter_by(account_book_id=book.id, period_id=period.id).order_by(Voucher.voucher_date, Voucher.id).all()
    for voucher in rows:
        entries, accounts = _entries(db, voucher.id)
        for entry in entries:
            sheet.append([voucher.voucher_no, voucher.voucher_date.isoformat(), voucher.summary, accounts[entry.account_id].code, entry.summary, str(entry.debit), str(entry.credit), entry.cashflow_item or "", json.dumps(entry.aux_detail or {}, ensure_ascii=False)])
    stream = io.BytesIO()
    workbook.save(stream)
    stream.seek(0)
    commit_audited(db, user.id, "export_vouchers", "vouchers", str(period.id), f"book={book.code}")
    return StreamingResponse(stream, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", headers={"Content-Disposition": f"attachment; filename=vouchers_{period.year:04d}-{period.month:02d}.xlsx"})


def _rebuild_entries(db: Session, voucher: Voucher, book_id: int, period: AccountingPeriod, lines: list[EntryIn]):
    prepared, debit, credit = _normalise_lines(db, book_id, period, lines)
    db.query(VoucherEntry).filter_by(voucher_id=voucher.id).delete()
    for line_no, item in enumerate(prepared, 1):
        db.add(VoucherEntry(account_book_id=book_id, voucher_id=voucher.id, line_no=line_no, account_id=item["account"].id, summary=item["summary"], debit=item["debit"], credit=item["credit"], aux_detail=item["aux_detail"], cashflow_item=item["cashflow_item"]))
    voucher.total_debit = debit
    voucher.total_credit = credit


def _build_draft_voucher(db: Session, book: AccountBook, body: VoucherIn, user: User) -> Voucher:
    period = _period(db, book.id, body.period_id)
    if period.status != "open":
        _error(400, "F-PERIOD-CLOSED", "当前期间不可录入凭证")
    if not (period.start_date <= body.voucher_date <= period.end_date):
        _error(400, "F-PERIOD-CLOSED", "凭证日期不在所属期间")
    if body.source not in INTERNAL_VOUCHER_SOURCES:
        _error(400, "F-INVALID-VOUCHER", "凭证来源不合法")
    voucher_no = body.voucher_no.strip()
    if db.query(Voucher).filter_by(account_book_id=book.id, period_id=period.id, voucher_no=voucher_no).first():
        _error(409, "F-DUP-VOUCHER-NO", "凭证号在当前期间已存在")
    prepared, debit, credit = _normalise_lines(db, book.id, period, body.lines)
    voucher = Voucher(account_book_id=book.id, period_id=period.id, voucher_no=voucher_no, voucher_date=body.voucher_date, status="draft", source=body.source, summary=body.summary.strip(), total_debit=debit, total_credit=credit, created_by=user.id, updated_at=app_now())
    db.add(voucher)
    db.flush()
    for line_no, item in enumerate(prepared, 1):
        db.add(VoucherEntry(account_book_id=book.id, voucher_id=voucher.id, line_no=line_no, account_id=item["account"].id, summary=item["summary"], debit=item["debit"], credit=item["credit"], aux_detail=item["aux_detail"], cashflow_item=item["cashflow_item"]))
    return voucher


@router.post("/vouchers")
def create_voucher(body: VoucherIn, x_account_book: str | None = Header(default=None), db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    book = _book_header(db, user, x_account_book)
    _role(db, user, book.id, {ROLE_FINANCE_CLERK, ROLE_FINANCE_MANAGER})
    if body.source not in EXTERNAL_VOUCHER_SOURCES:
        _error(400, "F-INVALID-VOUCHER", "凭证来源不合法")
    voucher = _build_draft_voucher(db, book, body, user)
    commit_audited(db, user.id, "create", "voucher", str(voucher.id), voucher.voucher_no)
    entries, accounts = _entries(db, voucher.id)
    return _serialize(voucher, entries, accounts)


def _cash_voucher_payload(book_id: int, body: CashTransactionIn, account: Account, offset: Account, user: User) -> VoucherIn:
    if body.kind == "receipt":
        lines = [
            EntryIn(account_id=body.account_id, summary=body.summary, debit=body.amount, credit=Decimal("0"), cashflow_item=body.cashflow_item),
            EntryIn(account_id=body.offset_account_id, summary=body.summary, debit=Decimal("0"), credit=body.amount),
        ]
    else:
        lines = [
            EntryIn(account_id=body.offset_account_id, summary=body.summary, debit=body.amount, credit=Decimal("0")),
            EntryIn(account_id=body.account_id, summary=body.summary, debit=Decimal("0"), credit=body.amount, cashflow_item=body.cashflow_item),
        ]
    return VoucherIn(period_id=body.period_id, voucher_no=f"收付-{app_now().strftime('%H%M%S%f')[:8]}", voucher_date=body.transaction_date, summary=body.summary, source="cash", lines=lines)


@router.post("/cash-transactions")
def create_cash_transaction(body: CashTransactionIn, x_account_book: str | None = Header(default=None), db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    book = _book_header(db, user, x_account_book)
    _role(db, user, book.id, {ROLE_CASHIER, ROLE_FINANCE_MANAGER})
    _period(db, book.id, body.period_id)
    amount = _money(body.amount)
    account = db.query(Account).filter_by(id=body.account_id, account_book_id=book.id, is_active=True, is_leaf=True).first()
    offset = db.query(Account).filter_by(id=body.offset_account_id, account_book_id=book.id, is_active=True, is_leaf=True).first()
    if not account or not offset:
        _error(400, "F-ACCT-INACTIVE", "资金科目和对方科目必须是当前账套启用的末级科目")
    body = body.model_copy(update={"amount": amount})
    payload = _cash_voucher_payload(book.id, body, account, offset, user)
    voucher = _build_draft_voucher(db, book, payload, user)
    transaction = CashTransaction(account_book_id=book.id, period_id=body.period_id, kind=body.kind, transaction_date=body.transaction_date, amount=amount, account_id=body.account_id, offset_account_id=body.offset_account_id, summary=body.summary.strip(), counterparty=body.counterparty.strip(), cashflow_item=body.cashflow_item, status="draft", voucher_id=voucher.id, created_by=user.id, created_at=app_now())
    db.add(transaction)
    commit_audited(db, user.id, "create_cash_transaction", "cash_transaction", str(transaction.id), f"voucher={voucher.id}")
    entries, accounts = _entries(db, voucher.id)
    return {"id": transaction.id, "kind": transaction.kind, "status": transaction.status, "amount": str(transaction.amount), "voucher": _serialize(voucher, entries, accounts)}


def _asset_json(asset: FixedAsset) -> dict:
    return {"id": asset.id, "code": asset.code, "name": asset.name, "category": asset.category, "acquisition_date": asset.acquisition_date.isoformat(), "original_cost": str(asset.original_cost), "residual_rate": str(asset.residual_rate), "useful_life_months": asset.useful_life_months, "accumulated_depreciation": str(asset.accumulated_depreciation), "net_book_value": str(asset.original_cost - asset.accumulated_depreciation), "status": asset.status}


@router.post("/fixed-assets")
def create_fixed_asset(body: FixedAssetIn, x_account_book: str | None = Header(default=None), db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    book = _book_header(db, user, x_account_book)
    _role(db, user, book.id, {ROLE_FINANCE_CLERK, ROLE_FINANCE_MANAGER})
    cost = _money(body.original_cost, "原值")
    residual = Decimal(str(body.residual_rate))
    if not residual.is_finite() or residual < 0 or residual >= 1:
        _error(400, "F-ASSET-INVALID", "残值率必须在 0 到 1 之间")
    accounts = [db.query(Account).filter_by(id=account_id, account_book_id=book.id, is_active=True, is_leaf=True).first() for account_id in (body.asset_account_id, body.depreciation_account_id, body.expense_account_id)]
    if any(account is None for account in accounts):
        _error(400, "F-ASSET-INVALID", "固定资产科目必须是当前账套启用的末级科目")
    if db.query(FixedAsset).filter_by(account_book_id=book.id, code=body.code.strip()).first():
        _error(409, "F-ASSET-DUPLICATE", "资产编码已存在")
    asset = FixedAsset(account_book_id=book.id, code=body.code.strip(), name=body.name.strip(), category=body.category.strip(), acquisition_date=body.acquisition_date, original_cost=cost, residual_rate=residual, useful_life_months=body.useful_life_months, asset_account_id=body.asset_account_id, depreciation_account_id=body.depreciation_account_id, expense_account_id=body.expense_account_id, accumulated_depreciation=Decimal("0.00"), status="active", created_by=user.id, created_at=app_now())
    db.add(asset)
    commit_audited(db, user.id, "create_fixed_asset", "fixed_asset", body.code, book.code)
    return _asset_json(asset)


@router.get("/fixed-assets")
def list_fixed_assets(x_account_book: str | None = Header(default=None), db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    book = _book_header(db, user, x_account_book)
    rows = db.query(FixedAsset).filter_by(account_book_id=book.id).order_by(FixedAsset.code).all()
    return {"total": len(rows), "items": [_asset_json(row) for row in rows]}


@router.post("/fixed-assets/depreciate")
def depreciate_fixed_assets(period_id: int, x_account_book: str | None = Header(default=None), db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    book = _book_header(db, user, x_account_book)
    _role(db, user, book.id, {ROLE_FINANCE_MANAGER})
    period = _period(db, book.id, period_id)
    total = Decimal("0.00")
    generated = []
    for asset in db.query(FixedAsset).filter_by(account_book_id=book.id, status="active").all():
        if asset.acquisition_date >= period.start_date:
            continue
        if db.query(AssetDepreciation).filter_by(account_book_id=book.id, asset_id=asset.id, period_id=period.id).first():
            continue
        depreciable = Decimal(asset.original_cost) * (Decimal("1") - Decimal(asset.residual_rate))
        monthly = (depreciable / asset.useful_life_months).quantize(Decimal("0.01"))
        remaining = depreciable - Decimal(asset.accumulated_depreciation)
        amount = min(monthly, remaining).quantize(Decimal("0.01"))
        if amount <= 0:
            continue
        lines = [EntryIn(account_id=asset.expense_account_id, summary=f"{asset.name}折旧", debit=amount, credit=Decimal("0"), aux_detail={"dept": "fixed-assets"}), EntryIn(account_id=asset.depreciation_account_id, summary=f"{asset.name}折旧", debit=Decimal("0"), credit=amount)]
        payload = VoucherIn(period_id=period.id, voucher_no=f"折旧-{asset.code}-{period.year:04d}{period.month:02d}", voucher_date=period.end_date, summary=f"计提{asset.name}折旧", source="auto-asset", lines=lines)
        voucher = _build_draft_voucher(db, book, payload, user)
        voucher.status = "posted"; voucher.reviewed_by = user.id; voucher.posted_by = user.id
        _update_balance(db, voucher, book.id)
        depreciation = AssetDepreciation(account_book_id=book.id, asset_id=asset.id, period_id=period.id, amount=amount, voucher_id=voucher.id, created_by=user.id, created_at=app_now())
        db.add(depreciation)
        asset.accumulated_depreciation += amount
        total += amount
        generated.append(voucher)
    commit_audited(db, user.id, "depreciate_fixed_assets", "fixed_assets", str(period.id), f"count={len(generated)},amount={total}")
    return {"period_id": period.id, "depreciated": len(generated), "total_amount": str(total), "vouchers": [{"id": row.id, "source": row.source, "status": row.status} for row in generated]}


BANK_HEADERS = ["流水号", "交易日期", "方向", "金额", "银行账户", "摘要", "对方"]


@router.post("/bank-statements/import")
def import_bank_statements(period_id: int, file: UploadFile = File(...), x_account_book: str | None = Header(default=None), db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    book = _book_header(db, user, x_account_book)
    _role(db, user, book.id, {ROLE_CASHIER, ROLE_FINANCE_MANAGER})
    _period(db, book.id, period_id)
    try:
        from openpyxl import load_workbook
        rows = list(load_workbook(file.file, read_only=True, data_only=True).active.iter_rows(values_only=True))
    except Exception as exc:
        _error(400, "F-IMPORT-INVALID", "银行流水 Excel 解析失败", [{"row": 1, "reason": str(exc)}])
    if not rows or list(rows[0][:len(BANK_HEADERS)]) != BANK_HEADERS:
        _error(400, "F-IMPORT-INVALID", "银行流水表头不符合模板", [{"row": 1, "reason": "表头必须为：" + "、".join(BANK_HEADERS)}])
    parsed: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []
    for row_number, raw in enumerate(rows[1:], 2):
        values = list(raw[:len(BANK_HEADERS)]) + [None] * max(0, len(BANK_HEADERS) - len(raw))
        if not any(value not in (None, "") for value in values):
            continue
        external_id, raw_date, direction, raw_amount, account_code, summary, counterparty = values
        try:
            if str(direction).strip() not in {"流入", "流出"}:
                raise ValueError("方向必须为流入或流出")
            transaction_date = raw_date if isinstance(raw_date, date) else date.fromisoformat(str(raw_date))
            amount = _money(raw_amount, "银行流水金额")
            if not str(external_id or "").strip():
                raise ValueError("流水号不能为空")
            parsed.append({"external_id": str(external_id).strip(), "transaction_date": transaction_date, "direction": "inflow" if str(direction).strip() == "流入" else "outflow", "amount": amount, "account_code": str(account_code or "").strip(), "summary": str(summary or ""), "counterparty": str(counterparty or "")})
        except Exception as exc:
            errors.append({"row": row_number, "reason": str(exc)})
    if errors:
        _error(400, "F-IMPORT-INVALID", "银行流水导入校验失败，未写入任何流水", errors)
    for item in parsed:
        if db.query(BankStatement).filter_by(account_book_id=book.id, external_id=item["external_id"]).first():
            _error(409, "F-IMPORT-DUPLICATE", f"流水号已存在：{item['external_id']}")
    try:
        rows = []
        for item in parsed:
            row = BankStatement(account_book_id=book.id, period_id=period_id, created_by=user.id, created_at=app_now(), **item)
            db.add(row); rows.append(row)
        commit_audited(db, user.id, "import_bank_statements", "bank_statements", str(period_id), f"count={len(rows)}")
        return {"imported": len(rows), "items": [{"id": row.id, "external_id": row.external_id, "status": row.status, "amount": str(row.amount), "direction": row.direction} for row in rows]}
    except HTTPException:
        raise


@router.get("/bank-statements")
def list_bank_statements(period_id: int | None = None, x_account_book: str | None = Header(default=None), db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    book = _book_header(db, user, x_account_book)
    q = db.query(BankStatement).filter_by(account_book_id=book.id)
    if period_id is not None:
        q = q.filter(BankStatement.period_id == period_id)
    rows = q.order_by(BankStatement.transaction_date.desc(), BankStatement.id.desc()).all()
    return {"total": len(rows), "items": [{"id": row.id, "external_id": row.external_id, "transaction_date": row.transaction_date.isoformat(), "direction": row.direction, "amount": str(row.amount), "account_code": row.account_code, "summary": row.summary, "counterparty": row.counterparty, "status": row.status, "matched_voucher_id": row.matched_voucher_id} for row in rows]}


@router.post("/bank-statements/{statement_id}/match")
def match_bank_statement(statement_id: int, body: BankMatchIn, x_account_book: str | None = Header(default=None), db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    book = _book_header(db, user, x_account_book); _role(db, user, book.id, {ROLE_CASHIER, ROLE_FINANCE_MANAGER})
    row = db.query(BankStatement).filter_by(id=statement_id, account_book_id=book.id).with_for_update().first()
    if not row:
        _error(404, "F-BANK-STATEMENT-NOT-FOUND", "银行流水不存在")
    if row.status == "matched":
        _error(400, "F-BANK-STATEMENT-STATE", "银行流水已经匹配")
    voucher = db.query(Voucher).filter_by(id=body.voucher_id, account_book_id=book.id, period_id=row.period_id, status="posted").first()
    if not voucher:
        _error(400, "F-BANK-MATCH-INVALID", "只能匹配当前账套当前期间的已过账凭证")
    entries = db.query(VoucherEntry).filter_by(voucher_id=voucher.id, account_book_id=book.id).all()
    cash_amount = sum((entry.debit if row.direction == "inflow" else entry.credit for entry in entries if entry.cashflow_item), Decimal("0.00"))
    if cash_amount != row.amount:
        _error(400, "F-BANK-MATCH-INVALID", "银行流水金额与凭证现金金额不一致")
    row.status = "matched"; row.matched_voucher_id = voucher.id; row.matched_by = user.id; row.matched_at = app_now()
    commit_audited(db, user.id, "match_bank_statement", "bank_statement", str(row.id), f"voucher={voucher.id}")
    return {"id": row.id, "status": row.status, "matched_voucher_id": row.matched_voucher_id}


@router.get("/bank-reconciliation")
def bank_reconciliation(period_id: int, x_account_book: str | None = Header(default=None), db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    book = _book_header(db, user, x_account_book)
    rows = db.query(BankStatement).filter_by(account_book_id=book.id, period_id=period_id).all()
    bank_total = sum((row.amount if row.direction == "inflow" else -row.amount for row in rows), Decimal("0.00"))
    unmatched = [row for row in rows if row.status == "unmatched"]
    return {"period_id": period_id, "bank_total": str(bank_total), "unmatched_count": len(unmatched), "unmatched_amount": str(sum((row.amount if row.direction == "inflow" else -row.amount for row in unmatched), Decimal("0.00"))), "items": [{"id": row.id, "external_id": row.external_id, "amount": str(row.amount), "direction": row.direction, "status": row.status} for row in rows]}


@router.get("/vouchers")
def list_vouchers(status: str = "", period_id: int | None = None, page: int = Query(default=1, ge=1), size: int = Query(default=20, ge=1, le=100), x_account_book: str | None = Header(default=None), db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    book = _book_header(db, user, x_account_book)
    q = db.query(Voucher).filter(Voucher.account_book_id == book.id)
    if status:
        if status not in {"draft", "pending", "posted", "void"}:
            _error(400, "F-VOUCHER-STATE", "凭证状态不合法")
        q = q.filter(Voucher.status == status)
    if period_id is not None:
        _period(db, book.id, period_id)
        q = q.filter(Voucher.period_id == period_id)
    total = q.count()
    rows = q.order_by(Voucher.voucher_date.desc(), Voucher.id.desc()).offset((page - 1) * size).limit(size).all()
    items = []
    for row in rows:
        entries, accounts = _entries(db, row.id)
        items.append(_serialize(row, entries, accounts))
    return {"total": total, "page": page, "size": size, "items": items}


@router.patch("/vouchers/{voucher_id}")
def update_voucher(voucher_id: int, body: VoucherPatch, x_account_book: str | None = Header(default=None), db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    book = _book_header(db, user, x_account_book)
    _role(db, user, book.id, {ROLE_FINANCE_CLERK, ROLE_FINANCE_MANAGER})
    voucher = _load_voucher(db, book.id, voucher_id)
    if voucher.status != "draft":
        _error(400, "F-VOUCHER-POSTED" if voucher.status == "posted" else "F-VOUCHER-STATE", "只有草稿凭证可以编辑")
    period = _period(db, book.id, body.period_id or voucher.period_id)
    voucher.period_id = period.id
    if body.voucher_no is not None:
        voucher.voucher_no = body.voucher_no.strip()
    if body.voucher_date is not None:
        voucher.voucher_date = body.voucher_date
    if not (period.start_date <= voucher.voucher_date <= period.end_date):
        _error(400, "F-PERIOD-CLOSED", "凭证日期不在所属期间")
    if body.summary is not None:
        voucher.summary = body.summary.strip()
    if body.lines is not None:
        _rebuild_entries(db, voucher, book.id, period, body.lines)
    voucher.updated_at = app_now()
    commit_audited(db, user.id, "update", "voucher", str(voucher.id), voucher.voucher_no)
    entries, accounts = _entries(db, voucher.id)
    return _serialize(voucher, entries, accounts)


@router.delete("/vouchers/{voucher_id}")
def delete_voucher(voucher_id: int, x_account_book: str | None = Header(default=None), db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    book = _book_header(db, user, x_account_book)
    _role(db, user, book.id, {ROLE_FINANCE_CLERK, ROLE_FINANCE_MANAGER})
    voucher = _load_voucher(db, book.id, voucher_id)
    if voucher.status != "draft":
        _error(400, "F-VOUCHER-STATE", "只有草稿凭证可以删除")
    db.delete(voucher)
    commit_audited(db, user.id, "delete", "voucher", str(voucher_id), "delete draft voucher")
    return {"deleted": True, "id": voucher_id}


def _transition(voucher: Voucher, expected: set[str], target: str):
    if voucher.status not in expected:
        _error(400, "F-VOUCHER-STATE", f"当前凭证状态不允许执行此操作：{voucher.status}")
    voucher.status = target
    voucher.updated_at = app_now()


@router.post("/vouchers/{voucher_id}/submit")
def submit_voucher(voucher_id: int, x_account_book: str | None = Header(default=None), db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    book = _book_header(db, user, x_account_book); _role(db, user, book.id, {ROLE_FINANCE_CLERK, ROLE_FINANCE_MANAGER}); voucher = _load_voucher(db, book.id, voucher_id)
    _transition(voucher, {"draft"}, "pending")
    commit_audited(db, user.id, "submit", "voucher", str(voucher.id), voucher.voucher_no)
    entries, accounts = _entries(db, voucher.id); return _serialize(voucher, entries, accounts)


@router.post("/vouchers/{voucher_id}/approve")
def approve_voucher(voucher_id: int, x_account_book: str | None = Header(default=None), db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    book = _book_header(db, user, x_account_book); _role(db, user, book.id, {ROLE_FINANCE_REVIEWER, ROLE_FINANCE_MANAGER}); voucher = _load_voucher(db, book.id, voucher_id)
    _transition(voucher, {"pending"}, "pending")
    voucher.reviewed_by = user.id
    commit_audited(db, user.id, "approve", "voucher", str(voucher.id), voucher.voucher_no)
    entries, accounts = _entries(db, voucher.id); return _serialize(voucher, entries, accounts)


@router.post("/vouchers/{voucher_id}/reject")
def reject_voucher(voucher_id: int, body: ReasonIn, x_account_book: str | None = Header(default=None), db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    book = _book_header(db, user, x_account_book); _role(db, user, book.id, {ROLE_FINANCE_REVIEWER, ROLE_FINANCE_MANAGER}); voucher = _load_voucher(db, book.id, voucher_id)
    if not body.reason.strip(): _error(400, "F-REASON-REQUIRED", "驳回凭证必须填写原因")
    _transition(voucher, {"pending"}, "draft"); voucher.decision_reason = body.reason.strip()
    commit_audited(db, user.id, "reject", "voucher", str(voucher.id), voucher.decision_reason)
    entries, accounts = _entries(db, voucher.id); return _serialize(voucher, entries, accounts)


def _update_balance(db: Session, voucher: Voucher, book_id: int):
    period = db.query(AccountingPeriod).filter_by(id=voucher.period_id, account_book_id=book_id).first()
    if not period: _error(400, "F-PERIOD-CLOSED", "凭证期间不存在")
    for entry in db.query(VoucherEntry).filter_by(voucher_id=voucher.id).all():
        balance = db.query(AccountBalance).filter_by(account_book_id=book_id, period_id=period.id, account_id=entry.account_id, aux_key="").with_for_update().first()
        if not balance:
            previous = (
                db.query(AccountBalance)
                .join(AccountingPeriod, AccountingPeriod.id == AccountBalance.period_id)
                .filter(
                    AccountBalance.account_book_id == book_id,
                    AccountBalance.account_id == entry.account_id,
                    AccountBalance.aux_key == "",
                    AccountingPeriod.period_index < period.period_index,
                )
                .order_by(AccountingPeriod.period_index.desc())
                .with_for_update()
                .first()
            )
            if previous:
                opening_debit, opening_credit = previous.ending_debit, previous.ending_credit
            else:
                opening = (
                    db.query(
                        func.coalesce(func.sum(OpeningBalance.debit), 0),
                        func.coalesce(func.sum(OpeningBalance.credit), 0),
                    )
                    .filter(
                        OpeningBalance.account_book_id == book_id,
                        OpeningBalance.account_id == entry.account_id,
                    )
                    .first()
                )
                opening_debit, opening_credit = opening[0] or 0, opening[1] or 0
            balance = AccountBalance(
                account_book_id=book_id,
                period_id=period.id,
                account_id=entry.account_id,
                aux_key="",
                opening_debit=opening_debit,
                opening_credit=opening_credit,
            )
            db.add(balance); db.flush()
        balance.debit_total += entry.debit
        balance.credit_total += entry.credit
        net = (
            balance.opening_debit
            - balance.opening_credit
            + balance.debit_total
            - balance.credit_total
        )
        balance.ending_debit = max(net, Decimal("0")); balance.ending_credit = max(-net, Decimal("0"))


def _period_profit_lines(db: Session, book_id: int, period_id: int):
    rows = (
        db.query(
            Account,
            func.coalesce(func.sum(VoucherEntry.debit), 0),
            func.coalesce(func.sum(VoucherEntry.credit), 0),
        )
        .join(VoucherEntry, VoucherEntry.account_id == Account.id)
        .join(Voucher, Voucher.id == VoucherEntry.voucher_id)
        .filter(
            Account.account_book_id == book_id,
            Account.category == "损益",
            Voucher.account_book_id == book_id,
            Voucher.period_id == period_id,
            Voucher.status == "posted",
            Voucher.source.notin_(["auto-close", "auto-reopen"]),
        )
        .group_by(Account.id)
        .all()
    )
    return rows


def _create_profit_carry_forward(db: Session, book_id: int, period: AccountingPeriod, user_id: int) -> Voucher | None:
    profit_account = (
        db.query(Account)
        .filter_by(account_book_id=book_id, code="3103", is_active=True, is_leaf=True)
        .first()
    )
    if not profit_account:
        _error(400, "F-CLOSE-BLOCKED", "未找到可用的本年利润科目")
    lines: list[dict[str, Any]] = []
    for account, debit, credit in _period_profit_lines(db, book_id, period.id):
        net = Decimal(str((debit or 0) - (credit or 0)))
        if not net:
            continue
        if net > 0:
            lines.append({"account_id": account.id, "summary": "结转损益", "debit": Decimal("0.00"), "credit": net, "aux_detail": {}, "cashflow_item": None})
            lines.append({"account_id": profit_account.id, "summary": "结转损益", "debit": net, "credit": Decimal("0.00"), "aux_detail": {}, "cashflow_item": None})
        else:
            amount = -net
            lines.append({"account_id": account.id, "summary": "结转损益", "debit": amount, "credit": Decimal("0.00"), "aux_detail": {}, "cashflow_item": None})
            lines.append({"account_id": profit_account.id, "summary": "结转损益", "debit": Decimal("0.00"), "credit": amount, "aux_detail": {}, "cashflow_item": None})
    if not lines:
        return None
    used = {row.voucher_no for row in db.query(Voucher).filter_by(account_book_id=book_id, period_id=period.id).all()}
    number = 1
    while f"结-{number:04d}" in used:
        number += 1
    total = sum((line["debit"] for line in lines), Decimal("0.00"))
    voucher = Voucher(
        account_book_id=book_id,
        period_id=period.id,
        voucher_no=f"结-{number:04d}",
        voucher_date=period.end_date,
        status="posted",
        source="auto-close",
        summary="结转损益",
        total_debit=total,
        total_credit=total,
        created_by=user_id,
        reviewed_by=user_id,
        posted_by=user_id,
        updated_at=app_now(),
    )
    db.add(voucher)
    db.flush()
    for line_no, line in enumerate(lines, 1):
        db.add(VoucherEntry(account_book_id=book_id, voucher_id=voucher.id, line_no=line_no, **line))
    _update_balance(db, voucher, book_id)
    return voucher


def _create_auto_reopen(db: Session, book_id: int, period: AccountingPeriod, user_id: int) -> Voucher | None:
    auto_close = (
        db.query(Voucher)
        .filter_by(account_book_id=book_id, period_id=period.id, source="auto-close", status="posted")
        .order_by(Voucher.id.desc())
        .first()
    )
    if not auto_close:
        return None
    existing = db.query(Voucher).filter_by(reversal_of=auto_close.id, source="auto-reopen").first()
    if existing:
        return existing
    entries, _accounts = _entries(db, auto_close.id)
    used = {row.voucher_no for row in db.query(Voucher).filter_by(account_book_id=book_id, period_id=period.id).all()}
    number = 1
    while f"反结-{number:04d}" in used:
        number += 1
    reversal = Voucher(
        account_book_id=book_id,
        period_id=period.id,
        voucher_no=f"反结-{number:04d}",
        voucher_date=period.end_date,
        status="posted",
        source="auto-reopen",
        summary="反结账冲回结转损益",
        total_debit=auto_close.total_debit,
        total_credit=auto_close.total_credit,
        created_by=user_id,
        reviewed_by=user_id,
        posted_by=user_id,
        reversal_of=auto_close.id,
        updated_at=app_now(),
    )
    db.add(reversal)
    db.flush()
    for line in entries:
        db.add(VoucherEntry(
            account_book_id=book_id,
            voucher_id=reversal.id,
            line_no=line.line_no,
            account_id=line.account_id,
            summary=line.summary,
            debit=line.credit,
            credit=line.debit,
            aux_detail=line.aux_detail,
            cashflow_item=line.cashflow_item,
        ))
    _update_balance(db, reversal, book_id)
    return reversal


@router.post("/vouchers/{voucher_id}/post")
def post_voucher(voucher_id: int, x_account_book: str | None = Header(default=None), db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    book = _book_header(db, user, x_account_book); _role(db, user, book.id, {ROLE_FINANCE_REVIEWER, ROLE_FINANCE_MANAGER}); voucher = db.query(Voucher).filter_by(id=voucher_id, account_book_id=book.id).with_for_update().first()
    if not voucher: _error(404, "F-VOUCHER-NOT-FOUND", "凭证不存在")
    voucher = cast(Voucher, voucher)
    _transition(voucher, {"pending"}, "posted")
    period = _period(db, book.id, voucher.period_id)
    if period.status != "open": _error(400, "F-PERIOD-CLOSED", "当前期间不可过账")
    if voucher.reviewed_by is None:
        _error(400, "F-SOD", "凭证必须先审核后过账")
    voucher.posted_by = user.id
    _update_balance(db, voucher, book.id)
    commit_audited(db, user.id, "post", "voucher", str(voucher.id), voucher.voucher_no)
    entries, accounts = _entries(db, voucher.id); return _serialize(voucher, entries, accounts)


@router.post("/vouchers/{voucher_id}/void")
def void_voucher(voucher_id: int, body: ReasonIn, x_account_book: str | None = Header(default=None), db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    book = _book_header(db, user, x_account_book); _role(db, user, book.id, {ROLE_FINANCE_MANAGER}); voucher = _load_voucher(db, book.id, voucher_id)
    if voucher.status not in {"draft", "pending"}: _error(400, "F-VOUCHER-STATE", "已过账凭证不能作废，请使用红字冲销")
    if not body.reason.strip(): _error(400, "F-REASON-REQUIRED", "作废凭证必须填写原因")
    voucher.status = "void"; voucher.voided_by = user.id; voucher.decision_reason = body.reason.strip(); voucher.updated_at = app_now()
    commit_audited(db, user.id, "void", "voucher", str(voucher.id), voucher.decision_reason)
    entries, accounts = _entries(db, voucher.id); return _serialize(voucher, entries, accounts)


@router.post("/vouchers/{voucher_id}/reverse")
def reverse_voucher(voucher_id: int, x_account_book: str | None = Header(default=None), db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    book = _book_header(db, user, x_account_book); _role(db, user, book.id, {ROLE_FINANCE_MANAGER}); original = _load_voucher(db, book.id, voucher_id)
    if original.status != "posted": _error(400, "F-VOUCHER-STATE", "只有已过账凭证可以红字冲销")
    period = _period(db, book.id, original.period_id)
    if period.status != "open": _error(400, "F-PERIOD-CLOSED", "当前期间不可生成冲销凭证")
    entries, accounts = _entries(db, original.id)
    used = {row.voucher_no for row in db.query(Voucher).filter_by(account_book_id=book.id, period_id=period.id).all()}
    number = 1
    while f"红-" + f"{number:04d}" in used: number += 1
    reversal = Voucher(account_book_id=book.id, period_id=period.id, voucher_no=f"红-{number:04d}", voucher_date=original.voucher_date, status="draft", source="reversal", summary=f"红字冲销：{original.summary}", total_debit=original.total_debit, total_credit=original.total_credit, created_by=user.id, reversal_of=original.id, updated_at=app_now())
    db.add(reversal); db.flush()
    for line in entries:
        db.add(VoucherEntry(account_book_id=book.id, voucher_id=reversal.id, line_no=line.line_no, account_id=line.account_id, summary=line.summary, debit=line.credit, credit=line.debit, aux_detail=line.aux_detail, cashflow_item=line.cashflow_item))
    commit_audited(db, user.id, "reverse", "voucher", str(original.id), str(reversal.id))
    new_entries, new_accounts = _entries(db, reversal.id); return _serialize(reversal, new_entries, new_accounts)


@router.get("/vouchers/gaps")
def voucher_gaps(period_id: int, x_account_book: str | None = Header(default=None), db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    book = _book_header(db, user, x_account_book); _period(db, book.id, period_id)
    numbers = []
    for row in db.query(Voucher.voucher_no).filter_by(account_book_id=book.id, period_id=period_id).all():
        try: numbers.append(int(row[0].split("-")[-1]))
        except (ValueError, IndexError): pass
    missing = [f"记-{number:04d}" for number in range(1, max(numbers or [0]) + 1) if number not in numbers]
    return {"period_id": period_id, "gaps": missing, "blocked": bool(missing)}


@router.get("/vouchers/{voucher_id}")
def get_voucher(voucher_id: int, x_account_book: str | None = Header(default=None), db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    book = _book_header(db, user, x_account_book)
    voucher = _load_voucher(db, book.id, voucher_id)
    entries, accounts = _entries(db, voucher.id)
    return _serialize(voucher, entries, accounts)


@router.get("/balances")
def balances(period_id: int, x_account_book: str | None = Header(default=None), db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    book = _book_header(db, user, x_account_book)
    period = _period(db, book.id, period_id)
    opening_rows = {
        row[0]: (row[1], row[2])
        for row in db.query(
            OpeningBalance.account_id,
            func.coalesce(func.sum(OpeningBalance.debit), 0),
            func.coalesce(func.sum(OpeningBalance.credit), 0),
        )
        .filter_by(account_book_id=book.id)
        .group_by(OpeningBalance.account_id)
        .all()
    }
    current_rows = {
        row[0]: (row[1], row[2])
        for row in db.query(
            VoucherEntry.account_id,
            func.coalesce(func.sum(VoucherEntry.debit), 0),
            func.coalesce(func.sum(VoucherEntry.credit), 0),
        )
        .join(Voucher, Voucher.id == VoucherEntry.voucher_id)
        .filter(
            Voucher.account_book_id == book.id,
            Voucher.period_id == period.id,
            Voucher.status == "posted",
        )
        .group_by(VoucherEntry.account_id)
        .all()
    }
    through_rows = {
        row[0]: (row[1], row[2])
        for row in db.query(
            VoucherEntry.account_id,
            func.coalesce(func.sum(VoucherEntry.debit), 0),
            func.coalesce(func.sum(VoucherEntry.credit), 0),
        )
        .join(Voucher, Voucher.id == VoucherEntry.voucher_id)
        .join(AccountingPeriod, AccountingPeriod.id == Voucher.period_id)
        .filter(
            Voucher.account_book_id == book.id,
            AccountingPeriod.period_index <= period.period_index,
            Voucher.status == "posted",
        )
        .group_by(VoucherEntry.account_id)
        .all()
    }
    account_ids = set(opening_rows) | set(through_rows) | set(current_rows)
    accounts = (
        db.query(Account)
        .filter(Account.account_book_id == book.id, Account.id.in_(account_ids or [0]))
        .order_by(Account.code)
        .all()
    )
    items = []
    for account in accounts:
        opening_debit, opening_credit = opening_rows.get(account.id, (0, 0))
        current_debit, current_credit = current_rows.get(account.id, (0, 0))
        through_debit, through_credit = through_rows.get(account.id, (0, 0))
        net = Decimal(str((opening_debit or 0) - (opening_credit or 0) + (through_debit or 0) - (through_credit or 0)))
        items.append({
            "account_id": account.id,
            "account_code": account.code,
            "account_name": account.name,
            "debit_total": str(current_debit or 0),
            "credit_total": str(current_credit or 0),
            "ending_debit": str(max(net, Decimal("0"))),
            "ending_credit": str(max(-net, Decimal("0"))),
        })
    return {"items": items}


@router.get("/ledger/general")
def general_ledger(period_id: int, x_account_book: str | None = Header(default=None), db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    data = balances(period_id, x_account_book, db, user)
    return {"period_id": period_id, "items": data["items"]}


@router.get("/ledger/detail")
def detail_ledger(period_id: int, account_id: int, x_account_book: str | None = Header(default=None), db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    book = _book_header(db, user, x_account_book); _period(db, book.id, period_id)
    rows = db.query(Voucher, VoucherEntry).join(VoucherEntry, VoucherEntry.voucher_id == Voucher.id).filter(Voucher.account_book_id == book.id, Voucher.period_id == period_id, Voucher.status == "posted", VoucherEntry.account_id == account_id).order_by(Voucher.voucher_date, Voucher.id, VoucherEntry.line_no).all()
    return {"period_id": period_id, "account_id": account_id, "items": [{"voucher_id": voucher.id, "voucher_no": voucher.voucher_no, "voucher_date": voucher.voucher_date.isoformat(), "summary": entry.summary, "debit": str(entry.debit), "credit": str(entry.credit), "aux_detail": entry.aux_detail} for voucher, entry in rows]}


def _posted_net_by_account(
    db: Session,
    book_id: int,
    period_id: int,
    through: bool = False,
    include_auto_close: bool = True,
):
    periods = db.query(AccountingPeriod.id).filter(AccountingPeriod.account_book_id == book_id)
    if through:
        current = db.query(AccountingPeriod.period_index).filter_by(id=period_id, account_book_id=book_id).scalar()
        periods = periods.filter(AccountingPeriod.period_index <= current)
    else:
        periods = periods.filter(AccountingPeriod.id == period_id)
    query = db.query(
        VoucherEntry.account_id,
        func.coalesce(func.sum(VoucherEntry.debit), 0),
        func.coalesce(func.sum(VoucherEntry.credit), 0),
    ).join(Voucher, Voucher.id == VoucherEntry.voucher_id).filter(
        Voucher.account_book_id == book_id,
        Voucher.period_id.in_(periods),
        Voucher.status == "posted",
    )
    if not include_auto_close:
        query = query.filter(Voucher.source.notin_(["auto-close", "auto-reopen"]))
    rows = query.group_by(VoucherEntry.account_id).all()
    return {account_id: (debit or 0, credit or 0) for account_id, debit, credit in rows}


@router.get("/reports/balance-sheet")
def balance_sheet(period_id: int, x_account_book: str | None = Header(default=None), db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    book = _book_header(db, user, x_account_book)
    _period(db, book.id, period_id)
    activity = _posted_net_by_account(db, book.id, period_id, through=True)
    rows = []
    assets = liabilities = equity = profit = Decimal("0.00")
    for account in db.query(Account).filter_by(account_book_id=book.id).order_by(Account.code).all():
        debit, credit = activity.get(account.id, (0, 0))
        opening = db.query(func.coalesce(func.sum(OpeningBalance.debit), 0), func.coalesce(func.sum(OpeningBalance.credit), 0)).filter_by(account_book_id=book.id, account_id=account.id).first()
        net = Decimal(str((opening[0] or 0) - (opening[1] or 0) + debit - credit))
        if account.direction == "C": net = -net
        if not net: continue
        if account.category == "资产": assets += net
        elif account.category == "负债": liabilities += net
        elif account.category == "权益": equity += net
        elif account.category == "损益": profit += net
        rows.append({"account_code": account.code, "account_name": account.name, "category": account.category, "balance": str(net)})
    reported_equity = equity + profit
    return {"period_id": period_id, "items": rows, "totals": {"assets": str(assets), "liabilities": str(liabilities), "equity": str(reported_equity), "profit_before_close": str(profit), "balanced": assets == liabilities + reported_equity}}


@router.get("/reports/income")
def income_statement(period_id: int, x_account_book: str | None = Header(default=None), db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    book = _book_header(db, user, x_account_book)
    _period(db, book.id, period_id)
    activity = _posted_net_by_account(db, book.id, period_id, include_auto_close=False)
    rows = []
    income = Decimal("0.00")
    expense = Decimal("0.00")
    for account in db.query(Account).filter_by(account_book_id=book.id).filter(Account.category == "损益").order_by(Account.code).all():
        debit, credit = activity.get(account.id, (0, 0))
        net = Decimal(str(credit - debit)) if account.direction == "C" else Decimal(str(debit - credit))
        if not net: continue
        if account.direction == "C": income += net
        else: expense += net
        rows.append({"account_code": account.code, "account_name": account.name, "balance": str(net), "direction": account.direction})
    return {"period_id": period_id, "items": rows, "totals": {"income": str(income), "expense": str(expense), "profit": str(income - expense)}}


@router.get("/reports/cashflow")
def cashflow_statement(period_id: int, x_account_book: str | None = Header(default=None), db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    book = _book_header(db, user, x_account_book)
    _period(db, book.id, period_id)
    rows = db.query(VoucherEntry.cashflow_item, func.coalesce(func.sum(VoucherEntry.debit), 0), func.coalesce(func.sum(VoucherEntry.credit), 0)).join(Voucher, Voucher.id == VoucherEntry.voucher_id).join(Account, Account.id == VoucherEntry.account_id).filter(Voucher.account_book_id == book.id, Voucher.period_id == period_id, Voucher.status == "posted", or_(Account.code.like("1001%"), Account.code.like("1002%"), Account.code.like("1012%"))).group_by(VoucherEntry.cashflow_item).all()
    unclassified = sum((debit or 0) + (credit or 0) for item, debit, credit in rows if not item)
    return {"period_id": period_id, "items": [{"cashflow_item": item or "UNCLASSIFIED", "inflow": str(debit or 0), "outflow": str(credit or 0)} for item, debit, credit in rows], "unclassified_amount": str(unclassified), "ready": unclassified == 0}


def _close_issues(db: Session, book_id: int, period: AccountingPeriod) -> list[dict[str, str]]:
    issues: list[dict[str, str]] = []
    pending = db.query(Voucher).filter_by(account_book_id=book_id, period_id=period.id, status="pending").count()
    drafts = db.query(Voucher).filter_by(account_book_id=book_id, period_id=period.id, status="draft").count()
    if pending:
        issues.append({"code": "F-UNREVIEWED-VOUCHER", "message": f"有 {pending} 张凭证待审核"})
    if drafts:
        issues.append({"code": "F-UNPOSTED-VOUCHER", "message": f"有 {drafts} 张凭证仍为草稿"})
    opening = db.query(func.coalesce(func.sum(OpeningBalance.debit), 0), func.coalesce(func.sum(OpeningBalance.credit), 0)).filter_by(account_book_id=book_id).first()
    if (opening[0] or 0) != (opening[1] or 0):
        issues.append({"code": "F-OPENING-UNBALANCED", "message": "账套期初余额借贷不平"})
    numbers: list[int] = []
    for (value,) in db.query(Voucher.voucher_no).filter_by(account_book_id=book_id, period_id=period.id).all():
        try:
            numbers.append(int(value.split("-")[-1]))
        except (ValueError, IndexError):
            issues.append({"code": "F-VOUCHER-NO", "message": f"凭证号格式无法检查：{value}"})
    missing = [f"记-{number:04d}" for number in range(1, max(numbers or [0]) + 1) if number not in numbers]
    if missing:
        issues.append({"code": "F-VOUCHER-GAP", "message": f"存在断号：{', '.join(missing)}"})
    totals = db.query(func.coalesce(func.sum(VoucherEntry.debit), 0), func.coalesce(func.sum(VoucherEntry.credit), 0)).join(Voucher, Voucher.id == VoucherEntry.voucher_id).filter(Voucher.account_book_id == book_id, Voucher.period_id == period.id, Voucher.status == "posted").first()
    if (totals[0] or 0) != (totals[1] or 0):
        issues.append({"code": "F-UNBALANCED", "message": "已过账凭证借贷不平"})
    cash_rows = db.query(VoucherEntry.cashflow_item, func.coalesce(func.sum(VoucherEntry.debit), 0), func.coalesce(func.sum(VoucherEntry.credit), 0)).join(Voucher, Voucher.id == VoucherEntry.voucher_id).join(Account, Account.id == VoucherEntry.account_id).filter(Voucher.account_book_id == book_id, Voucher.period_id == period.id, Voucher.status == "posted", or_(Account.code.like("1001%"), Account.code.like("1002%"), Account.code.like("1012%"))).group_by(VoucherEntry.cashflow_item).all()
    if any(not item for item, _debit, _credit in cash_rows):
        issues.append({"code": "F-CASHFLOW-UNCLASSIFIED", "message": "存在未分类现金流分录"})
    return issues


@router.post("/close/check")
def close_check(period_id: int, x_account_book: str | None = Header(default=None), db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    book = _book_header(db, user, x_account_book)
    _role(db, user, book.id, {ROLE_FINANCE_MANAGER})
    period = _period(db, book.id, period_id)
    if period.status != "open":
        _error(400, "F-PERIOD-CLOSED", "只有开放期间可以执行结账检查")
    issues = _close_issues(db, book.id, period)
    return {"period_id": period.id, "ready": not issues, "issues": issues}


@router.post("/close/run")
def close_run(period_id: int, x_account_book: str | None = Header(default=None), if_match: str | None = Header(default=None, alias="If-Match"), db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    book = _book_header(db, user, x_account_book)
    _role(db, user, book.id, {ROLE_FINANCE_MANAGER})
    period = db.query(AccountingPeriod).filter_by(id=period_id, account_book_id=book.id).with_for_update().first()
    if not period:
        _error(404, "F-PERIOD-CLOSED", "期间不存在")
    period = cast(AccountingPeriod, period)
    if if_match and if_match.strip('"') != str(period.version):
        _error(409, "F-PERIOD-CLOSED", "期间已被其他请求更新，请刷新后重试")
    if period.status != "open":
        _error(400, "F-PERIOD-CLOSED", "当前期间不可结账")
    issues = _close_issues(db, book.id, period)
    if issues:
        _error(400, "F-CLOSE-BLOCKED", "结账前置检查未通过", issues)
    _create_profit_carry_forward(db, book.id, period, user.id)
    period.status = "closed"
    period.version += 1
    period.closed_by = user.id
    period.closed_at = app_now()
    commit_audited(db, user.id, "close", "accounting_period", str(period.id), f"period={period.year:04d}-{period.month:02d}")
    return {"id": period.id, "status": period.status, "version": period.version}


@router.post("/close/reverse")
def close_reverse(period_id: int, confirm: bool = False, x_account_book: str | None = Header(default=None), if_match: str | None = Header(default=None, alias="If-Match"), db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    book = _book_header(db, user, x_account_book)
    _role(db, user, book.id, {ROLE_FINANCE_MANAGER})
    period = db.query(AccountingPeriod).filter_by(id=period_id, account_book_id=book.id).with_for_update().first()
    if not period:
        _error(404, "F-PERIOD-CLOSED", "期间不存在")
    period = cast(AccountingPeriod, period)
    if not confirm:
        _error(400, "F-PERIOD-CLOSED", "反结账必须二次确认")
    if if_match and if_match.strip('"') != str(period.version):
        _error(409, "F-PERIOD-CLOSED", "期间已被其他请求更新，请刷新后重试")
    if period.status != "closed":
        _error(400, "F-PERIOD-CLOSED", "只有已结账期间可以反结账")
    next_period = db.query(AccountingPeriod).filter(AccountingPeriod.account_book_id == book.id, AccountingPeriod.period_index > period.period_index, AccountingPeriod.status != "open").order_by(AccountingPeriod.period_index).first()
    if next_period:
        _error(400, "F-REVERSE-ORDER", "反结账必须按期间倒序执行")
    period.status = "open"
    period.version += 1
    period.closed_by = None
    period.closed_at = None
    _create_auto_reopen(db, book.id, period, user.id)
    commit_audited(db, user.id, "reverse_close", "accounting_period", str(period.id), f"period={period.year:04d}-{period.month:02d}")
    return {"id": period.id, "status": period.status, "version": period.version}
