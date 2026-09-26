"""P0-B/C 财务凭证、余额、账簿与基础报表 API。

首期沿用 admin-only 财务权限。项目管理的 Budget/Expense 不会自动写入本模块；
所有会计事实都从本路由的已过账凭证产生。
"""

import io
import json
import re
from datetime import date
from decimal import Decimal, InvalidOperation
from typing import Any, cast

from fastapi import APIRouter, Depends, File, Header, HTTPException, Query, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import func, or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..core.audit import audit_row, commit_audited
from ..core.database import get_db
from ..core.deps import get_current_user
from ..core.rbac import ROLE_CASHIER, ROLE_FINANCE_CLERK, ROLE_FINANCE_MANAGER, ROLE_FINANCE_REVIEWER, is_admin, require_finance, visible_project_ids
from ..core.timeutil import app_now
from ..models import ARAPAllocation, ARAPTransaction, Account, AccountBalance, AccountBook, AccountingPeriod, AssetDepreciation, AuxiliaryItem, BankStatement, CashTransaction, Expense, FixedAsset, OpeningBalance, Project, User, Voucher, VoucherEntry, VoucherTemplate
from .finance import _book_header

router = APIRouter(prefix="/finance", tags=["finance-accounting"])
EXTERNAL_VOUCHER_SOURCES = {"manual", "template", "import"}
INTERNAL_VOUCHER_SOURCES = EXTERNAL_VOUCHER_SOURCES | {"cash", "auto-close", "auto-reopen", "reversal", "auto-asset", "project-expense"}


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


def _money_text(value: Decimal) -> str:
    return str(value.quantize(Decimal("0.01")))


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


class ProjectExpenseLineIn(BaseModel):
    account_id: int
    aux_detail: dict = Field(default_factory=dict)
    cashflow_item: str | None = Field(default=None, max_length=32)


class ProjectExpenseVoucherIn(BaseModel):
    period_id: int
    voucher_date: date
    summary: str = Field(default="", max_length=255)
    debit: ProjectExpenseLineIn
    credit: ProjectExpenseLineIn


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


class ARAPIn(BaseModel):
    period_id: int
    transaction_date: date
    party_id: int | None = None
    customer_id: int | None = None
    vendor_id: int | None = None
    amount: Decimal
    account_id: int | None = None
    offset_account_id: int | None = None
    receivable_account_id: int | None = None
    payable_account_id: int | None = None
    revenue_account_id: int | None = None
    expense_account_id: int | None = None
    summary: str = Field(default="", max_length=255)


class ARAPAllocationIn(BaseModel):
    target_id: int = Field(gt=0)
    amount: Decimal


class ARAPPaymentIn(BaseModel):
    period_id: int
    transaction_date: date
    party_id: int | None = None
    customer_id: int | None = None
    vendor_id: int | None = None
    amount: Decimal
    cash_account_id: int
    account_id: int | None = None
    cashflow_item: str | None = None
    summary: str = Field(default="", max_length=255)
    allocations: list[ARAPAllocationIn] | None = None


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
        "source_expense_id": voucher.source_expense_id,
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


def _load_voucher(db: Session, book_id: int, voucher_id: int, for_update: bool = False) -> Voucher:
    query = db.query(Voucher).filter_by(id=voucher_id, account_book_id=book_id)
    if for_update:
        query = query.with_for_update()
    row = query.first()
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


def _build_draft_voucher(db: Session, book: AccountBook, body: VoucherIn, user: User, source_expense_id: int | None = None) -> Voucher:
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
    voucher = Voucher(account_book_id=book.id, period_id=period.id, voucher_no=voucher_no, voucher_date=body.voucher_date, status="draft", source=body.source, source_expense_id=source_expense_id, summary=body.summary.strip(), total_debit=debit, total_credit=credit, created_by=user.id, updated_at=app_now())
    db.add(voucher)
    db.flush()
    for line_no, item in enumerate(prepared, 1):
        db.add(VoucherEntry(account_book_id=book.id, voucher_id=voucher.id, line_no=line_no, account_id=item["account"].id, summary=item["summary"], debit=item["debit"], credit=item["credit"], aux_detail=item["aux_detail"], cashflow_item=item["cashflow_item"]))
    return voucher


def _source_voucher_summary(voucher: Voucher, book_id: int) -> dict:
    if voucher.account_book_id != book_id:
        return {"converted": True, "message": "已在其他账套转换"}
    return {
        "id": voucher.id,
        "voucher_no": voucher.voucher_no,
        "voucher_date": voucher.voucher_date.isoformat(),
        "status": voucher.status,
        "summary": voucher.summary,
    }


def _linked_expense_conflict(db: Session, expense_id: int, book_id: int) -> None:
    linked = db.query(Voucher).filter_by(source_expense_id=expense_id).first()
    if linked:
        raise HTTPException(409, detail={
            "code": "F-PROJECT-EXPENSE-LINKED",
            "message": "项目支出已生成凭证" if linked.account_book_id == book_id else "已在其他账套转换",
            "details": [],
            "source_voucher_summary": _source_voucher_summary(linked, book_id),
        })


def _validate_project_expense_line(db: Session, book_id: int, line: ProjectExpenseLineIn, field: str) -> dict[str, int]:
    account = db.query(Account).filter_by(id=line.account_id, account_book_id=book_id, is_active=True, is_leaf=True).first()
    if not account:
        _error(400, "F-INVALID-VOUCHER", "凭证分录校验失败", [{"field": f"{field}.account_id", "reason": "只能使用当前账套启用的末级科目"}])
    flags = account.aux_flags or {}
    aux = line.aux_detail or {}
    kinds = {"customer": "customer", "vendor": "vendor", "dept": "department", "employee": "employee", "project": "project"}
    errors = []
    normalized_aux = {}
    for key, kind in kinds.items():
        value = aux.get(key)
        if flags.get(key) and value in (None, ""):
            errors.append({"field": f"{field}.aux_detail.{key}", "reason": "缺少科目要求的辅助核算"})
        if value not in (None, ""):
            if type(value) is int:
                item_id = value
            elif isinstance(value, str) and len(value) <= 10 and re.fullmatch(r"[0-9]+", value):
                item_id = int(value)
            else:
                item_id = -1
            item = db.query(AuxiliaryItem).filter_by(id=item_id, account_book_id=book_id, kind=kind, is_active=True).first() if 0 < item_id <= 2_147_483_647 else None
            if not item:
                errors.append({"field": f"{field}.aux_detail.{key}", "reason": "辅助资料不存在、类型不符或不属于当前账套"})
            else:
                normalized_aux[key] = item_id
    for key in aux.keys() - kinds.keys():
        errors.append({"field": f"{field}.aux_detail.{key}", "reason": "不支持的辅助核算类型"})
    if flags.get("cashflow") and not line.cashflow_item:
        errors.append({"field": f"{field}.cashflow_item", "reason": "现金类科目必须填写现金流项目"})
    if line.cashflow_item:
        item = db.query(AuxiliaryItem).filter_by(account_book_id=book_id, kind="cashflow", code=line.cashflow_item, is_active=True).first()
        if not item:
            errors.append({"field": f"{field}.cashflow_item", "reason": "现金流项目不属于当前账套"})
    if errors:
        _error(400, "F-INVALID-VOUCHER", "凭证分录校验失败", errors)
    return normalized_aux


@router.get("/project-expenses")
def list_project_expenses(
    project_id: int | None = Query(default=None, gt=0),
    status: str | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
    page: int = Query(default=1, ge=1),
    size: int = Query(default=20, ge=1, le=100),
    x_account_book: str | None = Header(default=None),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    book = _book_header(db, user, x_account_book)
    _role(db, user, book.id)
    query = db.query(Expense, Project).join(Project, Project.id == Expense.project_id).filter(
        Expense.project_id.in_(visible_project_ids(db, user)),
        Expense.status.in_(("approved", "exception")),
    )
    if project_id is not None:
        query = query.filter(Expense.project_id == project_id)
    if status:
        query = query.filter(Expense.status == status)
    if date_from:
        query = query.filter(Expense.exp_date >= date_from)
    if date_to:
        query = query.filter(Expense.exp_date <= date_to)
    total = query.count()
    rows = query.order_by(Expense.id.desc()).offset((page - 1) * size).limit(size).all()
    expense_ids = [expense.id for expense, _ in rows]
    linked = {voucher.source_expense_id: voucher for voucher in db.query(Voucher).filter(Voucher.source_expense_id.in_(expense_ids)).all()} if expense_ids else {}
    return {
        "total": total, "page": page, "size": size,
        "items": [
            {
                "id": expense.id, "project_id": expense.project_id, "subject": expense.subject,
                "amount": expense.amount, "exp_date": expense.exp_date.isoformat() if expense.exp_date else None,
                "note": expense.note, "status": expense.status, "by_id": expense.by_id,
                "approved_by": expense.approved_by,
                "project": {"id": project.id, "code": project.code, "name": project.name},
                "source_voucher_summary": _source_voucher_summary(linked[expense.id], book.id) if expense.id in linked else None,
            }
            for expense, project in rows
        ],
    }


@router.post("/project-expenses/{expense_id}/voucher")
def create_project_expense_voucher(
    expense_id: int,
    body: ProjectExpenseVoucherIn,
    x_account_book: str | None = Header(default=None),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    book = _book_header(db, user, x_account_book)
    _role(db, user, book.id, {ROLE_FINANCE_CLERK, ROLE_FINANCE_MANAGER})
    try:
        period = db.query(AccountingPeriod).filter_by(id=body.period_id, account_book_id=book.id).with_for_update().first()
        if not period or period.status != "open" or not (period.start_date <= body.voucher_date <= period.end_date):
            _error(400, "F-PERIOD-CLOSED", "期间关闭或凭证日期不在所属期间")
        expense = db.query(Expense).filter_by(id=expense_id).with_for_update().first()
        if not expense or not db.query(Project.id).filter(Project.id == expense.project_id, Project.id.in_(visible_project_ids(db, user))).first():
            _error(404, "F-PROJECT-EXPENSE-NOT-FOUND", "项目支出不存在")
        _linked_expense_conflict(db, expense_id, book.id)
        if expense.status not in ("approved", "exception"):
            _error(400, "F-PROJECT-EXPENSE-STATUS", "项目支出尚未通过审批")
        amount = _money(expense.amount, "项目支出金额")
        if amount <= 0:
            _error(400, "F-INVALID-AMOUNT", "项目支出金额必须大于零")
        if amount >= Decimal("10000000000000000"):
            _error(400, "F-INVALID-AMOUNT", "项目支出金额超出凭证可入账范围")
        debit_aux = _validate_project_expense_line(db, book.id, body.debit, "debit")
        credit_aux = _validate_project_expense_line(db, book.id, body.credit, "credit")
        numbers = db.query(Voucher.voucher_no).filter_by(account_book_id=book.id, period_id=period.id).all()
        next_number = max((int(match.group(1)) for (number,) in numbers if (match := re.fullmatch(r"记-(\d+)", number))), default=0) + 1
        payload = VoucherIn(
            period_id=period.id, voucher_no=f"记-{next_number:04d}", voucher_date=body.voucher_date,
            summary=body.summary, source="project-expense",
            lines=[
                EntryIn(account_id=body.debit.account_id, summary=body.summary, debit=amount, aux_detail=debit_aux, cashflow_item=body.debit.cashflow_item),
                EntryIn(account_id=body.credit.account_id, summary=body.summary, credit=amount, aux_detail=credit_aux, cashflow_item=body.credit.cashflow_item),
            ],
        )
        voucher = _build_draft_voucher(db, book, payload, user, source_expense_id=expense.id)
        audit_row(db, user.id, "create_project_expense_voucher", "expenses", expense.id, f"voucher={voucher.id}")
        db.commit()
        entries, accounts = _entries(db, voucher.id)
        return _serialize(voucher, entries, accounts)
    except IntegrityError as exc:
        db.rollback()
        _linked_expense_conflict(db, expense_id, book.id)
        if getattr(getattr(exc.orig, "diag", None), "constraint_name", None) == "uq_voucher_book_period_no":
            _error(409, "F-DUP-VOUCHER-NO", "凭证号在当前期间已存在")
        raise
    except HTTPException:
        db.rollback()
        raise
    except Exception:
        db.rollback()
        raise


def _release_arap_allocations(
    db: Session,
    book_id: int,
    source_voucher_id: int,
    user_id: int,
    reason: str,
    release_voucher_id: int | None = None,
) -> int:
    """释放一个收付款凭证仍有效的核销分配，保留行记录作为历史。"""
    allocations = (
        db.query(ARAPAllocation)
        .filter_by(account_book_id=book_id, source_id=source_voucher_id)
        .filter(ARAPAllocation.released_at.is_(None))
        .order_by(ARAPAllocation.target_id, ARAPAllocation.id)
        .with_for_update()
        .all()
    )
    released_at = app_now()
    for allocation in allocations:
        target = (
            db.query(ARAPTransaction)
            .filter_by(account_book_id=book_id, id=allocation.target_id)
            .with_for_update()
            .first()
        )
        if not target:
            _error(409, "F-ARAP-ALLOCATION-STATE", "核销目标单据不存在，无法安全释放分配")
        current = Decimal(str(target.applied_amount or 0))
        allocated = Decimal(str(allocation.amount))
        if current < allocated:
            _error(409, "F-ARAP-ALLOCATION-STATE", "已核销余额小于待释放金额，请联系管理员核对账套数据")
        target.applied_amount = current - allocated
        allocation.released_at = released_at
        allocation.released_by = user_id
        allocation.release_reason = reason.strip()
        allocation.release_voucher_id = release_voucher_id
    return len(allocations)


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


def _arap_items(db: Session, book_id: int, kind: str, party_id: int | None = None):
    query = db.query(ARAPTransaction).filter_by(account_book_id=book_id, kind=kind)
    if party_id is not None:
        query = query.filter_by(party_id=party_id)
    rows = query.order_by(ARAPTransaction.transaction_date, ARAPTransaction.id).all()
    voucher_ids = {row.voucher_id for row in rows if row.voucher_id is not None}
    reversed_voucher_ids = {
        row[0]
        for row in db.query(Voucher.reversal_of)
        .filter(
            Voucher.account_book_id == book_id,
            Voucher.status == "posted",
            Voucher.reversal_of.in_(voucher_ids or {0}),
        )
        .all()
        if row[0] is not None
    }
    reversing_voucher_ids = {
        row[0]
        for row in db.query(Voucher.reversal_of)
        .filter(
            Voucher.account_book_id == book_id,
            Voucher.status.in_(("draft", "pending")),
            Voucher.reversal_of.in_(voucher_ids or {0}),
        )
        .all()
        if row[0] is not None
    }
    vouchers = {
        voucher.id: voucher
        for voucher in db.query(Voucher).filter(
            Voucher.account_book_id == book_id,
            Voucher.id.in_(voucher_ids or {0}),
        ).all()
    }
    return [{
        "id": row.id,
        "period_id": row.period_id,
        "transaction_date": row.transaction_date.isoformat(),
        "party_id": row.party_id,
        "account_id": row.account_id,
        "amount": str(row.amount),
        "applied_amount": str(row.applied_amount),
        "outstanding": str(Decimal("0.00") if row.voucher_id in reversed_voucher_ids else row.amount - row.applied_amount),
        "summary": row.summary,
        "voucher_id": row.voucher_id,
        "voucher_no": vouchers[row.voucher_id].voucher_no if row.voucher_id in vouchers else None,
        "voucher_status": vouchers[row.voucher_id].status if row.voucher_id in vouchers else None,
        "is_reversed": row.voucher_id in reversed_voucher_ids,
        "is_reversing": row.voucher_id in reversing_voucher_ids,
    } for row in rows]


def _create_arap_transaction(kind: str, body: ARAPIn, book: AccountBook, db: Session, user: User):
    _role(db, user, book.id, {ROLE_FINANCE_CLERK, ROLE_FINANCE_MANAGER})
    amount = _money(body.amount)
    party_id = body.party_id or body.customer_id or body.vendor_id
    account_id = body.account_id or body.receivable_account_id or body.payable_account_id
    offset_account_id = body.offset_account_id or body.revenue_account_id or body.expense_account_id
    if not party_id or not account_id or not offset_account_id:
        _error(400, "F-ARAP-INVALID", "往来主体和科目不能为空")
    _period(db, book.id, body.period_id)
    account = db.query(Account).filter_by(id=account_id, account_book_id=book.id, is_active=True, is_leaf=True).first()
    offset = db.query(Account).filter_by(id=offset_account_id, account_book_id=book.id, is_active=True, is_leaf=True).first()
    if not account or not offset:
        _error(400, "F-ARAP-INVALID", "往来科目必须是当前账套启用的末级科目")
    if kind == "receivable":
        lines = [EntryIn(account_id=account_id, summary=body.summary, debit=amount, credit=Decimal("0"), aux_detail={"customer": str(party_id)}), EntryIn(account_id=offset_account_id, summary=body.summary, debit=Decimal("0"), credit=amount)]
    else:
        lines = [EntryIn(account_id=offset_account_id, summary=body.summary, debit=amount, credit=Decimal("0")), EntryIn(account_id=account_id, summary=body.summary, debit=Decimal("0"), credit=amount, aux_detail={"vendor": str(party_id)})]
    payload = VoucherIn(period_id=body.period_id, voucher_no=f"往来-{app_now().strftime('%H%M%S%f')[:8]}", voucher_date=body.transaction_date, summary=body.summary, source="manual", lines=lines)
    voucher = _build_draft_voucher(db, book, payload, user)
    row = ARAPTransaction(account_book_id=book.id, period_id=body.period_id, kind=kind, transaction_date=body.transaction_date, party_id=party_id, amount=amount, applied_amount=Decimal("0"), account_id=account_id, offset_account_id=offset_account_id, summary=body.summary.strip(), voucher_id=voucher.id, created_by=user.id, created_at=app_now())
    db.add(row)
    commit_audited(db, user.id, "create_arap", "arap_transactions", str(row.id), f"voucher={voucher.id}")
    entries, accounts = _entries(db, voucher.id)
    return {"id": row.id, "kind": kind, "amount": str(amount), "outstanding": str(amount), "voucher": _serialize(voucher, entries, accounts)}


@router.post("/receivables")
def create_receivable(body: ARAPIn, x_account_book: str | None = Header(default=None), db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    book = _book_header(db, user, x_account_book)
    return _create_arap_transaction("receivable", body, book, db, user)


@router.get("/receivables")
def list_receivables(party_id: int | None = None, x_account_book: str | None = Header(default=None), db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    book = _book_header(db, user, x_account_book)
    items = _arap_items(db, book.id, "receivable", party_id)
    return {"total": len(items), "items": items}


@router.post("/payables")
def create_payable(body: ARAPIn, x_account_book: str | None = Header(default=None), db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    book = _book_header(db, user, x_account_book)
    return _create_arap_transaction("payable", body, book, db, user)


@router.get("/payables")
def list_payables(party_id: int | None = None, x_account_book: str | None = Header(default=None), db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    book = _book_header(db, user, x_account_book)
    items = _arap_items(db, book.id, "payable", party_id)
    return {"total": len(items), "items": items}


def _apply_arap_payment(kind: str, body: ARAPPaymentIn, book: AccountBook, db: Session, user: User):
    _role(db, user, book.id, {ROLE_CASHIER, ROLE_FINANCE_MANAGER})
    amount = _money(body.amount)
    if amount <= 0:
        _error(400, "F-ARAP-INVALID", "收付款金额必须大于零")
    party_id = body.party_id or body.customer_id or body.vendor_id
    if not party_id:
        _error(400, "F-ARAP-INVALID", "往来主体不能为空")
    manual = body.allocations is not None
    if manual:
        if not body.allocations:
            _error(400, "F-ARAP-INVALID", "核销明细不能为空")
        target_ids = [item.target_id for item in body.allocations]
        if len(set(target_ids)) != len(target_ids):
            _error(400, "F-ARAP-INVALID", "核销目标不能重复")
    candidate_query = (
        db.query(ARAPTransaction)
        .join(Voucher, Voucher.id == ARAPTransaction.voucher_id)
        .filter(
            ARAPTransaction.account_book_id == book.id,
            ARAPTransaction.kind == kind,
            ARAPTransaction.party_id == party_id,
            Voucher.account_book_id == book.id,
            Voucher.status == "posted",
            Voucher.voucher_date <= body.transaction_date,
        )
    )
    active_reversal_source_ids = (
        db.query(Voucher.reversal_of)
        .filter(
            Voucher.account_book_id == book.id,
            Voucher.reversal_of.is_not(None),
            Voucher.status != "void",
        )
    )
    candidate_query = candidate_query.filter(~ARAPTransaction.voucher_id.in_(active_reversal_source_ids))
    if body.account_id is not None:
        candidate_query = candidate_query.filter(ARAPTransaction.account_id == body.account_id)
    if manual:
        candidate_query = candidate_query.filter(ARAPTransaction.id.in_(target_ids))
    candidates = candidate_query.order_by(ARAPTransaction.transaction_date, ARAPTransaction.id).with_for_update(of=ARAPTransaction).all()
    # Recheck after taking the target-row locks. A reversal draft can be created
    # while this request waits for one of those locks, after the SQL predicate ran.
    active_reversal_source_ids = {
        row[0]
        for row in db.query(Voucher.reversal_of)
        .filter(
            Voucher.account_book_id == book.id,
            Voucher.reversal_of.is_not(None),
            Voucher.status != "void",
        )
        .all()
        if row[0] is not None
    }
    candidates = [target for target in candidates if target.voucher_id not in active_reversal_source_ids]
    allocations: list[tuple[ARAPTransaction, Decimal]] = []
    if manual:
        targets = {target.id: target for target in candidates}
        if len(targets) != len(target_ids):
            _error(400, "F-ARAP-INVALID", "目标单据不符合当前核销条件")
        if len({target.account_id for target in candidates}) != 1:
            _error(400, "F-ARAP-INVALID", "目标单据不符合当前核销条件")
        total = Decimal("0.00")
        for item in body.allocations:
            target = targets[item.target_id]
            applied = _money(item.amount, "核销明细金额")
            if applied <= 0:
                _error(400, "F-ARAP-INVALID", "核销明细金额必须大于零")
            outstanding = Decimal(target.amount) - Decimal(target.applied_amount)
            if applied > outstanding:
                _error(400, "F-ARAP-OVER-APPLY", "核销金额超过目标单据未核销余额")
            allocations.append((target, applied))
            total += applied
        if total != amount:
            _error(400, "F-ARAP-INVALID", "核销明细合计必须等于收付款金额")
    else:
        remaining = amount
        # A single cash voucher has one counterparty account. Keep FIFO within it.
        selected_account_id = next(
            (target.account_id for target in candidates if Decimal(target.amount) > Decimal(target.applied_amount)),
            None,
        )
        for target in candidates:
            if target.account_id != selected_account_id:
                continue
            outstanding = Decimal(target.amount) - Decimal(target.applied_amount)
            if outstanding <= 0:
                continue
            applied = min(remaining, outstanding)
            allocations.append((target, applied))
            remaining -= applied
            if remaining <= 0:
                break
        if remaining > 0:
            _error(400, "F-ARAP-OVER-APPLY", "收付款金额超过未核销余额")
    first = allocations[0][0]
    account = db.query(Account).filter_by(id=body.cash_account_id, account_book_id=book.id, is_active=True, is_leaf=True).first()
    if not account:
        _error(400, "F-ARAP-INVALID", "资金科目必须是当前账套启用的末级科目")
    direction = "receipt" if kind == "receivable" else "payment"
    cash_body = CashTransactionIn(period_id=body.period_id, kind=direction, transaction_date=body.transaction_date, amount=amount, account_id=body.cash_account_id, offset_account_id=first.account_id, summary=body.summary, counterparty="", cashflow_item=body.cashflow_item)
    payload = _cash_voucher_payload(book.id, cash_body, account, account, user)
    payload.lines[1 if direction == "receipt" else 0].account_id = first.account_id
    payload.lines[1 if direction == "receipt" else 0].aux_detail = {"customer": str(party_id)} if kind == "receivable" else {"vendor": str(party_id)}
    voucher = _build_draft_voucher(db, book, payload, user)
    for target, applied in allocations:
        target.applied_amount += applied
        db.add(ARAPAllocation(account_book_id=book.id, source_id=voucher.id, target_id=target.id, amount=applied, created_by=user.id, created_at=app_now()))
    commit_audited(db, user.id, "apply_arap", "arap_transactions", str(first.id), f"voucher={voucher.id},amount={amount}")
    entries, accounts = _entries(db, voucher.id)
    key = "receivable_id" if kind == "receivable" else "payable_id"
    return {"allocations": [{key: target.id, "amount": str(applied)} for target, applied in allocations], "voucher": _serialize(voucher, entries, accounts)}


@router.post("/receivable-collections")
def receive_arap(body: ARAPPaymentIn, x_account_book: str | None = Header(default=None), db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    return _apply_arap_payment("receivable", body, _book_header(db, user, x_account_book), db, user)


@router.post("/payable-payments")
def pay_arap(body: ARAPPaymentIn, x_account_book: str | None = Header(default=None), db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    return _apply_arap_payment("payable", body, _book_header(db, user, x_account_book), db, user)


def _posted_arap_events(db: Session, book_id: int, kind: str) -> list[dict[str, Any]]:
    transaction_rows = (
        db.query(ARAPTransaction, Voucher)
        .join(Voucher, Voucher.id == ARAPTransaction.voucher_id)
        .filter(
            ARAPTransaction.account_book_id == book_id,
            ARAPTransaction.kind == kind,
            Voucher.account_book_id == book_id,
        )
        .all()
    )
    posted_transactions: dict[int, ARAPTransaction] = {}
    source_voucher_transactions: dict[int, list[ARAPTransaction]] = {}
    events: list[dict[str, Any]] = []

    def add_event(
        transaction: ARAPTransaction,
        voucher: Voucher,
        event_type: str,
        signed_amount: Decimal,
        priority: int,
    ) -> None:
        events.append({
            "transaction_id": transaction.id,
            "party_id": transaction.party_id,
            "account_id": transaction.account_id,
            "transaction_date": voucher.voucher_date,
            "voucher_id": voucher.id,
            "voucher_no": voucher.voucher_no,
            "event_type": event_type,
            "summary": voucher.summary or transaction.summary,
            "signed_amount": signed_amount,
            "priority": priority,
        })

    for transaction, voucher in transaction_rows:
        if voucher.status != "posted":
            continue
        posted_transactions[transaction.id] = transaction
        source_voucher_transactions.setdefault(voucher.id, []).append(transaction)
        add_event(transaction, voucher, "单据", Decimal(transaction.amount), 10)

    source_voucher_ids = set(source_voucher_transactions)
    if not source_voucher_ids:
        return events

    source_reversals = (
        db.query(Voucher)
        .filter(
            Voucher.account_book_id == book_id,
            Voucher.status == "posted",
            Voucher.reversal_of.in_(source_voucher_ids),
        )
        .all()
    )
    for reversal in source_reversals:
        for transaction in source_voucher_transactions.get(reversal.reversal_of, []):
            add_event(transaction, reversal, "单据冲销", -Decimal(transaction.amount), 40)

    allocation_rows = (
        db.query(ARAPAllocation, Voucher)
        .join(Voucher, Voucher.id == ARAPAllocation.source_id)
        .filter(
            ARAPAllocation.account_book_id == book_id,
            ARAPAllocation.target_id.in_(set(posted_transactions) or {-1}),
            Voucher.account_book_id == book_id,
            Voucher.status == "posted",
        )
        .all()
    )
    release_voucher_ids = {
        allocation.release_voucher_id
        for allocation, _payment_voucher in allocation_rows
        if allocation.release_voucher_id is not None
    }
    release_vouchers = {
        voucher.id: voucher
        for voucher in db.query(Voucher)
        .filter(
            Voucher.account_book_id == book_id,
            Voucher.status == "posted",
            Voucher.id.in_(release_voucher_ids or {-1}),
        )
        .all()
    }
    for allocation, payment_voucher in allocation_rows:
        transaction = posted_transactions.get(allocation.target_id)
        if transaction is None:
            continue
        add_event(transaction, payment_voucher, "收付款", -Decimal(allocation.amount), 20)
        release_voucher = release_vouchers.get(allocation.release_voucher_id)
        if release_voucher:
            add_event(transaction, release_voucher, "收付款冲销恢复", Decimal(allocation.amount), 30)

    events.sort(key=lambda item: (
        item["transaction_date"], item["priority"], item["voucher_no"], item["voucher_id"], item["transaction_id"],
    ))
    return events


def _arap_aging(kind: str, as_of: date, book: AccountBook, db: Session, party_id: int | None, account_id: int | None):
    events = _posted_arap_events(db, book.id, kind)
    source_dates = {
        event["transaction_id"]: event["transaction_date"]
        for event in events
        if event["event_type"] == "单据"
    }
    transaction_balances: dict[int, Decimal] = {}
    for event in events:
        if event["transaction_date"] > as_of:
            continue
        if party_id is not None and event["party_id"] != party_id:
            continue
        if account_id is not None and event["account_id"] != account_id:
            continue
        transaction_id = event["transaction_id"]
        transaction_balances[transaction_id] = transaction_balances.get(transaction_id, Decimal("0")) + event["signed_amount"]

    buckets = {"0_30": Decimal("0"), "31_60": Decimal("0"), "61_90": Decimal("0"), "90_plus": Decimal("0")}
    for transaction_id, balance in transaction_balances.items():
        if balance <= 0:
            continue
        source_date = source_dates.get(transaction_id)
        if source_date is None or source_date > as_of:
            continue
        age = (as_of - source_date).days
        key = "0_30" if age <= 30 else "31_60" if age <= 60 else "61_90" if age <= 90 else "90_plus"
        buckets[key] += balance
    return {
        "as_of": as_of.isoformat(),
        "age_basis": "voucher_date",
        "total_outstanding": _money_text(sum(buckets.values(), Decimal("0"))),
        "buckets": {key: _money_text(value) for key, value in buckets.items()},
    }


@router.get("/receivables/aging")
def receivable_aging(as_of: date, party_id: int | None = None, account_id: int | None = None, x_account_book: str | None = Header(default=None), db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    book = _book_header(db, user, x_account_book)
    return _arap_aging("receivable", as_of, book, db, party_id, account_id)


@router.get("/payables/aging")
def payable_aging(as_of: date, party_id: int | None = None, account_id: int | None = None, x_account_book: str | None = Header(default=None), db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    book = _book_header(db, user, x_account_book)
    return _arap_aging("payable", as_of, book, db, party_id, account_id)


def _arap_statement(kind: str, party_id: int, account_id: int | None, from_date: date, to_date: date, page: int, page_size: int, book: AccountBook, db: Session):
    if from_date > to_date:
        _error(400, "F-ARAP-DATE-RANGE", "开始日期不能晚于结束日期")
    all_events = _posted_arap_events(db, book.id, kind)
    events = [
        event for event in all_events
        if event["party_id"] == party_id and (account_id is None or event["account_id"] == account_id)
    ]
    opening_balance = sum(
        (event["signed_amount"] for event in events if event["transaction_date"] < from_date),
        Decimal("0"),
    )
    period_events = [event for event in events if from_date <= event["transaction_date"] <= to_date]
    period_increase = sum((event["signed_amount"] for event in period_events if event["signed_amount"] > 0), Decimal("0"))
    period_decrease = sum((-event["signed_amount"] for event in period_events if event["signed_amount"] < 0), Decimal("0"))
    running_balance = opening_balance
    serialized_events = []
    for event in period_events:
        signed_amount = event["signed_amount"]
        running_balance += signed_amount
        serialized_events.append({
            "transaction_id": event["transaction_id"],
            "transaction_date": event["transaction_date"].isoformat(),
            "voucher_id": event["voucher_id"],
            "voucher_no": event["voucher_no"],
            "event_type": event["event_type"],
            "summary": event["summary"],
            "direction": "increase" if signed_amount > 0 else "decrease",
            "amount": _money_text(abs(signed_amount)),
            "balance_after": _money_text(running_balance),
        })
    total_lines = len(serialized_events)
    start = (page - 1) * page_size
    return {
        "kind": kind,
        "party_id": party_id,
        "account_id": account_id,
        "from_date": from_date.isoformat(),
        "to_date": to_date.isoformat(),
        "opening_balance": _money_text(opening_balance),
        "period_increase": _money_text(period_increase),
        "period_decrease": _money_text(period_decrease),
        "closing_balance": _money_text(opening_balance + period_increase - period_decrease),
        "total_lines": total_lines,
        "page": page,
        "page_size": page_size,
        "items": serialized_events[start:start + page_size],
    }


@router.get("/receivables/statement")
def receivable_statement(party_id: int, from_date: date, to_date: date, account_id: int | None = None, page: int = Query(1, ge=1), page_size: int = Query(50, ge=1, le=200), x_account_book: str | None = Header(default=None), db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    book = _book_header(db, user, x_account_book)
    return _arap_statement("receivable", party_id, account_id, from_date, to_date, page, page_size, book, db)


@router.get("/payables/statement")
def payable_statement(party_id: int, from_date: date, to_date: date, account_id: int | None = None, page: int = Query(1, ge=1), page_size: int = Query(50, ge=1, le=200), x_account_book: str | None = Header(default=None), db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    book = _book_header(db, user, x_account_book)
    return _arap_statement("payable", party_id, account_id, from_date, to_date, page, page_size, book, db)


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
    voucher = _load_voucher(db, book.id, voucher_id, for_update=True)
    if voucher.status != "draft":
        _error(400, "F-VOUCHER-POSTED" if voucher.status == "posted" else "F-VOUCHER-STATE", "只有草稿凭证可以编辑")
    has_active_arap = (
        db.query(ARAPAllocation.id)
        .filter_by(account_book_id=book.id, source_id=voucher.id)
        .filter(ARAPAllocation.released_at.is_(None))
        .first()
    )
    if has_active_arap:
        _error(400, "F-VOUCHER-ARAP-LOCKED", "收付款凭证已占用核销余额，不能编辑；请删除草稿后重新录入")
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
        source_amount = voucher.total_debit if voucher.source_expense_id is not None else None
        _rebuild_entries(db, voucher, book.id, period, body.lines)
        if source_amount is not None and voucher.total_debit != source_amount:
            _error(400, "F-PROJECT-EXPENSE-AMOUNT-LOCKED", "项目支出来源凭证金额不可修改；如需重做请删除草稿并重新生成")
    voucher.updated_at = app_now()
    commit_audited(db, user.id, "update", "voucher", str(voucher.id), voucher.voucher_no)
    entries, accounts = _entries(db, voucher.id)
    return _serialize(voucher, entries, accounts)


@router.delete("/vouchers/{voucher_id}")
def delete_voucher(voucher_id: int, x_account_book: str | None = Header(default=None), db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    book = _book_header(db, user, x_account_book)
    _role(db, user, book.id, {ROLE_FINANCE_CLERK, ROLE_FINANCE_MANAGER})
    voucher = _load_voucher(db, book.id, voucher_id, for_update=True)
    if voucher.status != "draft":
        _error(400, "F-VOUCHER-STATE", "只有草稿凭证可以删除")
    released = _release_arap_allocations(
        db, book.id, voucher.id, user.id, f"删除收付款草稿凭证 {voucher.voucher_no}"
    )
    db.delete(voucher)
    commit_audited(db, user.id, "delete", "voucher", str(voucher_id), f"删除草稿凭证；释放核销分配 {released} 笔")
    return {"deleted": True, "id": voucher_id}


def _transition(voucher: Voucher, expected: set[str], target: str):
    if voucher.status not in expected:
        _error(400, "F-VOUCHER-STATE", f"当前凭证状态不允许执行此操作：{voucher.status}")
    voucher.status = target
    voucher.updated_at = app_now()


@router.post("/vouchers/{voucher_id}/submit")
def submit_voucher(voucher_id: int, x_account_book: str | None = Header(default=None), db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    book = _book_header(db, user, x_account_book); _role(db, user, book.id, {ROLE_FINANCE_CLERK, ROLE_FINANCE_MANAGER}); voucher = _load_voucher(db, book.id, voucher_id, for_update=True)
    _transition(voucher, {"draft"}, "pending")
    commit_audited(db, user.id, "submit", "voucher", str(voucher.id), voucher.voucher_no)
    entries, accounts = _entries(db, voucher.id); return _serialize(voucher, entries, accounts)


@router.post("/vouchers/{voucher_id}/approve")
def approve_voucher(voucher_id: int, x_account_book: str | None = Header(default=None), db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    book = _book_header(db, user, x_account_book); _role(db, user, book.id, {ROLE_FINANCE_REVIEWER, ROLE_FINANCE_MANAGER}); voucher = _load_voucher(db, book.id, voucher_id, for_update=True)
    _transition(voucher, {"pending"}, "pending")
    voucher.reviewed_by = user.id
    commit_audited(db, user.id, "approve", "voucher", str(voucher.id), voucher.voucher_no)
    entries, accounts = _entries(db, voucher.id); return _serialize(voucher, entries, accounts)


@router.post("/vouchers/{voucher_id}/reject")
def reject_voucher(voucher_id: int, body: ReasonIn, x_account_book: str | None = Header(default=None), db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    book = _book_header(db, user, x_account_book); _role(db, user, book.id, {ROLE_FINANCE_REVIEWER, ROLE_FINANCE_MANAGER}); voucher = _load_voucher(db, book.id, voucher_id, for_update=True)
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
    if voucher.source == "reversal" and voucher.reversal_of is not None:
        arap_targets = (
            db.query(ARAPTransaction)
            .filter_by(account_book_id=book.id, voucher_id=voucher.reversal_of)
            .order_by(ARAPTransaction.id)
            .with_for_update()
            .all()
        )
        target_ids = {target.id for target in arap_targets}
        active_allocation = (
            db.query(ARAPAllocation.id)
            .filter(
                ARAPAllocation.account_book_id == book.id,
                ARAPAllocation.target_id.in_(target_ids or {-1}),
                ARAPAllocation.released_at.is_(None),
            )
            .first()
        )
        if active_allocation:
            _error(409, "F-ARAP-OPEN-ALLOCATIONS", "该往来单据出现新的收付款核销；请先处理收付款核销，再冲销往来单据")
    _transition(voucher, {"pending"}, "posted")
    period = _period(db, book.id, voucher.period_id)
    if period.status != "open": _error(400, "F-PERIOD-CLOSED", "当前期间不可过账")
    if voucher.reviewed_by is None:
        _error(400, "F-SOD", "凭证必须先审核后过账")
    voucher.posted_by = user.id
    _update_balance(db, voucher, book.id)
    released = 0
    if voucher.reversal_of is not None:
        released = _release_arap_allocations(
            db,
            book.id,
            voucher.reversal_of,
            user.id,
            f"冲销凭证 {voucher.voucher_no} 已过账",
            release_voucher_id=voucher.id,
        )
    detail = voucher.voucher_no
    if released:
        detail += f"；冲销后释放核销分配 {released} 笔"
    commit_audited(db, user.id, "post", "voucher", str(voucher.id), detail)
    entries, accounts = _entries(db, voucher.id); return _serialize(voucher, entries, accounts)


@router.post("/vouchers/{voucher_id}/void")
def void_voucher(voucher_id: int, body: ReasonIn, x_account_book: str | None = Header(default=None), db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    book = _book_header(db, user, x_account_book); _role(db, user, book.id, {ROLE_FINANCE_MANAGER}); voucher = _load_voucher(db, book.id, voucher_id, for_update=True)
    if voucher.status not in {"draft", "pending"}: _error(400, "F-VOUCHER-STATE", "已过账凭证不能作废，请使用红字冲销")
    if not body.reason.strip(): _error(400, "F-REASON-REQUIRED", "作废凭证必须填写原因")
    voucher.status = "void"; voucher.voided_by = user.id; voucher.decision_reason = body.reason.strip(); voucher.updated_at = app_now()
    released = _release_arap_allocations(db, book.id, voucher.id, user.id, body.reason.strip())
    detail = voucher.decision_reason
    if released:
        detail += f"；释放核销分配 {released} 笔"
    commit_audited(db, user.id, "void", "voucher", str(voucher.id), detail)
    entries, accounts = _entries(db, voucher.id); return _serialize(voucher, entries, accounts)


@router.post("/vouchers/{voucher_id}/reverse")
def reverse_voucher(voucher_id: int, x_account_book: str | None = Header(default=None), db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    book = _book_header(db, user, x_account_book); _role(db, user, book.id, {ROLE_FINANCE_MANAGER}); original = _load_voucher(db, book.id, voucher_id, for_update=True)
    if original.status != "posted": _error(400, "F-VOUCHER-STATE", "只有已过账凭证可以红字冲销")
    if original.reversal_of is not None:
        _error(400, "F-VOUCHER-STATE", "冲销凭证不能再次冲销")
    arap_targets = (
        db.query(ARAPTransaction)
        .filter_by(account_book_id=book.id, voucher_id=original.id)
        .order_by(ARAPTransaction.id)
        .with_for_update()
        .all()
    )
    target_ids = {target.id for target in arap_targets}
    open_arap_allocation = (
        db.query(ARAPAllocation.id)
        .filter(
            ARAPAllocation.account_book_id == book.id,
            ARAPAllocation.target_id.in_(target_ids or {-1}),
            ARAPAllocation.released_at.is_(None),
        )
        .first()
    )
    if open_arap_allocation:
        _error(409, "F-ARAP-OPEN-ALLOCATIONS", "该往来单据仍有收付款核销；请先作废未过账收付款，或冲销并过账已过账收付款，再冲销往来单据")
    active_reversal = (
        db.query(Voucher.id)
        .filter_by(account_book_id=book.id, reversal_of=original.id)
        .filter(Voucher.status != "void")
        .first()
    )
    if active_reversal:
        _error(400, "F-VOUCHER-STATE", "该凭证已有未作废的冲销凭证，不能重复冲销")
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
