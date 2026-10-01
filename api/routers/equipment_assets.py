"""公司设备资产台账，独立于财务固定资产。"""
import csv
import io
import json
import uuid
from zipfile import BadZipFile
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from urllib.parse import quote

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import StreamingResponse
from openpyxl import Workbook, load_workbook
from pydantic import BaseModel, Field
from sqlalchemy import case, func, or_, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..core.audit import commit_audited, write_audit
from ..core.database import get_db
from ..core.deps import get_current_user
from ..core.rbac import is_admin, require_admin
from ..core.timeutil import app_now, app_today, to_db
from ..models import Dict, EquipmentAsset, EquipmentBatch, EquipmentEvent, User

router = APIRouter(prefix="/equipment-assets", tags=["equipment-assets"])
FIELDS = ("name", "category_code", "serial_number", "brand", "model", "location", "note", "purchase_date", "purchase_price")

# ---------------------------------------------------------------------------
# 用户可见文案：数据库列名与接口契约保持英文 snake_case，
# 只有落到用户手里的文件（导出 / 导入模板）和报错文案才用中文。
# 两套名字集中在这里维护；前端 assets/page.tsx 的 STATUS 需与之保持一致。
# ---------------------------------------------------------------------------
FIELD_LABELS = {
    "code": "资产编号", "name": "设备名称", "category_code": "设备分类", "serial_number": "序列号",
    "brand": "品牌", "model": "型号", "location": "存放位置", "note": "备注",
    "purchase_date": "采购日期", "purchase_price": "采购金额", "status": "设备状态",
    "holder_id": "使用人", "due_date": "归还日期", "batch_id": "所属批次",
}
# 导出列：按台账阅读顺序排列，备注收尾。
EXPORT_FIELDS = ("code", "name", "category_code", "serial_number", "brand", "model", "location",
                 "purchase_date", "purchase_price", "status", "holder_id", "due_date", "batch_id", "note")
# 导入可写列：一次导入只负责「建档」，因此不含状态 / 使用人 / 归还日期等流转字段。
IMPORT_FIELDS = ("name", "category_code", "serial_number", "brand", "model", "location",
                 "purchase_date", "purchase_price", "note")
# 认得但导入时忽略的列（导出后再导回来就会出现），回给前端提示，避免用户以为写丢了。
IMPORT_IGNORED = ("code", "status", "holder_id", "due_date", "batch_id")
FIELD_HINTS = {
    "name": "必填。设备名称。",
    "category_code": "必填。填分类名称（如「电脑」），也接受分类编码（如 computer）。",
    "serial_number": "选填。厂商序列号，填了则全库不可重复。",
    "brand": "选填。品牌。",
    "model": "选填。型号。",
    "location": "选填。存放位置。",
    "purchase_date": "选填。支持 2026-01-05、2026/1/5、2026年1月5日。",
    "purchase_price": "选填。填数字即可，支持 ¥1,200.00，不能为负数。",
    "note": "选填。备注。",
}
STATUS_LABELS = {"pending_acceptance": "待验收", "available": "可用", "claimed": "已领用",
                 "borrowed": "借用中", "maintenance": "维修中", "scrapped": "已报废", "void": "已作废"}
PROTECTED_DELETE_ACTIONS = ("claim", "borrow", "return", "maintenance", "restore", "scrap", "void", "outbound")
PROTECTED_DELETE_LABELS = {"claim": "领用", "borrow": "借用", "return": "归还", "maintenance": "维修",
                           "restore": "恢复", "scrap": "报废", "void": "作废", "outbound": "出库"}

EXPORT_STEM = "设备台账"
TEMPLATE_STEM = "设备台账导入模板"
IMPORT_EXAMPLE = {"name": "示例笔记本电脑（导入前请删除本行）", "category_code": "",
                  "serial_number": "SN-EXAMPLE-0001", "brand": "示例品牌", "model": "Model-A",
                  "location": "总部 3 楼", "purchase_date": None, "purchase_price": 6800, "note": "示例行"}


class RowError(ValueError):
    """单行导入失败；message 已是可直接展示的中文。"""


def _csv_safe(value: str) -> str:
    # Spreadsheet applications may ignore leading whitespace/control characters
    # before deciding whether a cell is a formula.
    probe = value.lstrip("".join(chr(i) for i in range(33)))
    return "'" + value if probe.startswith(("=", "+", "-", "@")) else value


def _header_key(value) -> str:
    """表头归一化：去空白（含全角空格）、下划线与中英文标点差异，再小写。"""
    text = str(value or "").strip().lower()
    for ch in " \t\r\n　_（）()：:-/":
        text = text.replace(ch, "")
    return text


def _build_header_aliases() -> dict:
    table = {}
    for field, label in FIELD_LABELS.items():
        table[_header_key(field)] = field
        table[_header_key(label)] = field
    # 口语化别名，减少用户自己造列名、导不进来的概率。
    for alias, field in (("分类", "category_code"), ("分类名称", "category_code"),
                         ("分类编码", "category_code"), ("资产分类", "category_code"),
                         ("名称", "name"), ("设备", "name"), ("物品名称", "name"),
                         ("编号", "code"), ("资产编码", "code"),
                         ("购买日期", "purchase_date"), ("购入日期", "purchase_date"),
                         ("购置日期", "purchase_date"), ("金额", "purchase_price"),
                         ("价格", "purchase_price"), ("购置金额", "purchase_price"),
                         ("序号", "serial_number"), ("持有人", "holder_id"),
                         ("使用人姓名", "holder_id"), ("状态", "status"), ("备注信息", "note")):
        table[_header_key(alias)] = field
    return table


HEADER_ALIASES = _build_header_aliases()


def _parse_date(value):
    """容忍 Excel 日期单元格、2026-01-05、2026/1/5、2026年1月5日 等写法。"""
    if value is None or (isinstance(value, str) and not value.strip()):
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    text = str(value).strip()
    for ch in ("年", "月", "日", "/", ".", " "):
        text = text.replace(ch, "-")
    parts = [p for p in text.split("-") if p]
    if len(parts) != 3:
        return RowError("采购日期格式错误，请填 2026-01-05 这类日期")
    try:
        return date(int(parts[0]), int(parts[1]), int(parts[2]))
    except ValueError:
        return RowError("采购日期格式错误，请填 2026-01-05 这类日期")


def _parse_money(value):
    """容忍 ¥1,200.00 / 1200元 / 1,200 这类写法。"""
    if value is None or (isinstance(value, str) and not value.strip()):
        return None
    if isinstance(value, bool):
        return RowError("采购金额格式错误，请填数字")
    if isinstance(value, (int, float, Decimal)):
        return Decimal(str(value))
    text = str(value).strip().replace(",", "").replace("，", "").replace(" ", "")
    for symbol in ("¥", "￥", "元", "RMB"):
        text = text.replace(symbol, "").replace(symbol.lower(), "")
    try:
        return Decimal(text)
    except (InvalidOperation, ValueError):
        return RowError("采购金额格式错误，请填数字")


def _disposition(stem: str, extension: str) -> dict:
    """中文文件名：ASCII 回退给老客户端，RFC 5987 给现代浏览器。"""
    return {"Content-Disposition":
            f"attachment; filename=equipment_assets.{extension}; "
            f"filename*=UTF-8''{quote(f'{stem}.{extension}')}"}


class AssetIn(BaseModel):
    name: str
    category_code: str
    serial_number: str = ""
    brand: str = ""
    model: str = ""
    location: str = ""
    note: str = ""
    purchase_date: date | None = None
    purchase_price: Decimal | None = None
    quantity: int = Field(default=1, ge=1)
    inventory_managed: bool = False


class AssetCreateIn(AssetIn):
    batch_id: int | None = None


class BatchIn(BaseModel):
    name: str = ""
    batch_id: int | None = None
    inventory_managed: bool = False
    source: str = ""
    supplier: str = ""
    purchase_order_no: str = ""
    invoice_no: str = ""
    acceptance_status: str = "accepted"
    note: str = ""
    items: list[AssetIn]


class TransitionIn(BaseModel):
    due_date: date | None = None
    note: str = ""


class OutboundIn(BaseModel):
    quantity: int = Field(gt=0)
    customer: str = Field(default="", max_length=255)
    destination: str = Field(default="", max_length=255)
    shipped_at: datetime
    note: str = ""


class AssetDeleteIn(BaseModel):
    confirm_code: str
    reason: str


class CategoryIn(BaseModel):
    code: str
    label: str
    sort: int = 0


class CategoryPatch(BaseModel):
    label: str
    sort: int | None = None


class EquipmentBatchPatch(BaseModel):
    name: str


def _asset(a: EquipmentAsset) -> dict:
    return {"id": a.id, "code": a.code or "", "name": a.name or "", "category_code": a.category_code,
            "serial_number": a.serial_number or "", "brand": a.brand or "", "model": a.model or "",
            "location": a.location or "", "note": a.note or "", "purchase_date": a.purchase_date,
            "purchase_price": float(a.purchase_price) if a.purchase_price is not None else None,
            "status": a.status, "holder_id": a.holder_id, "due_date": a.due_date,
            "batch_id": a.batch_id, "quantity": a.quantity,
            "available_quantity": a.available_quantity,
            "inventory_managed": a.inventory_managed, "created_by": a.created_by,
            "created_at": a.created_at, "updated_at": a.updated_at}


def _export_row(a: EquipmentAsset, categories: dict, user_names: dict,
                batch_desc: dict, export_fields: tuple = EXPORT_FIELDS) -> list:
    """一行导出的值：中文表头对应中文取值，金额与日期保持原生类型。"""
    row = []
    for field in export_fields:
        if field == "category_code":
            row.append((categories or {}).get(a.category_code, a.category_code))
        elif field == "status":
            row.append(STATUS_LABELS.get(a.status, a.status))
        elif field == "holder_id":
            row.append((user_names or {}).get(a.holder_id, ""))
        elif field == "batch_id":
            row.append((batch_desc or {}).get(a.batch_id, ""))
        elif field == "purchase_date" and a.purchase_date is not None:
            row.append(a.purchase_date.isoformat())
        elif field == "due_date" and a.due_date is not None:
            row.append(a.due_date.isoformat())
        elif field == "purchase_price" and a.purchase_price is not None:
            row.append(float(a.purchase_price))
        elif field == "note":
            row.append(a.note or "")
        else:
            row.append(getattr(a, field, "") or "")
    return row


def _event(e: EquipmentEvent) -> dict:
    result = {"id": e.id, "asset_id": e.asset_id, "batch_id": e.batch_id,
              "action": e.action, "from_status": e.from_status, "to_status": e.to_status,
              "actor_id": e.actor_id, "holder_id": e.holder_id, "due_date": e.due_date,
              "quantity": e.quantity, "customer": e.customer, "destination": e.destination,
              "shipped_at": e.shipped_at, "note": e.note, "created_at": e.created_at}
    if e.action == "inbound" and e.quantity is not None:
        result["quantity"] = e.quantity
    return result


def _batch(b: EquipmentBatch, items=None, asset_count=None) -> dict:
    result = {"id": b.id, "name": b.name, "source": b.source, "supplier": b.supplier,
              "purchase_order_no": b.purchase_order_no, "invoice_no": b.invoice_no,
              "acceptance_status": b.acceptance_status, "note": b.note,
              "created_by": b.created_by, "created_at": b.created_at}
    if items is not None:
        result["items"] = []
        for asset in items:
            row = _asset(asset)
            if asset.inventory_managed:
                row["inbound_quantity"] = asset.quantity
                row["quantity"] = asset.quantity
            result["items"].append(row)
    if asset_count is not None:
        result["asset_count"] = asset_count
    elif items is not None:
        result["asset_count"] = len(items)
    return result


def _normalize_batch_name(name: str) -> str:
    normalized = name.strip()
    if not normalized:
        raise HTTPException(400, "批次名称必填")
    if len(normalized) > 128:
        raise HTTPException(400, "批次名称不能超过 128 个字符")
    return normalized


def _check_batch_name_available(db: Session, name: str, exclude_id: int | None = None):
    q = db.query(EquipmentBatch).filter(func.lower(EquipmentBatch.name) == name.lower())
    if exclude_id is not None:
        q = q.filter(EquipmentBatch.id != exclude_id)
    if q.first():
        raise HTTPException(400, "批次名称已存在，请选择已有批次或更换名称")


def _create_batch(db: Session, actor_id: int, *, name: str, source: str = "", supplier: str = "",
                  purchase_order_no: str = "", invoice_no: str = "", acceptance_status: str = "accepted",
                  note: str = "") -> EquipmentBatch:
    if acceptance_status not in {"pending_acceptance", "accepted"}:
        raise HTTPException(400, "验收状态只能为 pending_acceptance 或 accepted")
    normalized = _normalize_batch_name(name)
    _check_batch_name_available(db, normalized)
    batch = EquipmentBatch(name=normalized, source=source.strip(), supplier=supplier.strip(),
                            purchase_order_no=purchase_order_no.strip(), invoice_no=invoice_no.strip(),
                            acceptance_status=acceptance_status, note=note.strip(), created_by=actor_id)
    db.add(batch)
    try:
        db.flush()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(400, "批次名称已存在，请选择已有批次或更换名称") from exc
    return batch


def _get_batch(db: Session, batch_id: int, lock: bool = True) -> EquipmentBatch:
    q = db.query(EquipmentBatch).filter_by(id=batch_id)
    batch = (q.with_for_update() if lock else q).first()
    if not batch:
        raise HTTPException(404, "入库批次不存在")
    return batch


def _category(db, code):
    return db.query(Dict).filter_by(type="equipment_category", code=code).first()


def _validate(db, body: AssetIn, exclude_id=None):
    if not body.name.strip():
        raise HTTPException(400, "设备名称必填")
    if not _category(db, body.category_code.strip()):
        raise HTTPException(400, f"设备分类「{body.category_code.strip()}」不存在，请使用已有分类")
    if body.purchase_price is not None and (not body.purchase_price.is_finite() or body.purchase_price < 0):
        raise HTTPException(400, "采购金额必须为非负有限数")
    if not body.inventory_managed and body.quantity != 1:
        raise HTTPException(400, "非库存设备数量必须为 1")
    if body.inventory_managed and body.serial_number.strip():
        raise HTTPException(400, "库存物料不能填写单件序列号")
    serial = body.serial_number.strip()
    if serial:
        q = db.query(EquipmentAsset).filter_by(serial_number=serial)
        if exclude_id is not None:
            q = q.filter(EquipmentAsset.id != exclude_id)
        if q.first():
            raise HTTPException(400, "设备序列号已存在")


def _get(db, asset_id, lock=False):
    q = db.query(EquipmentAsset).filter_by(id=asset_id)
    a = (q.with_for_update() if lock else q).first()
    if not a:
        raise HTTPException(404, "设备不存在")
    return a


def _delete_check(db: Session, asset: EquipmentAsset) -> dict:
    actions = [action for (action,) in db.query(EquipmentEvent.action).filter_by(asset_id=asset.id).all()]
    protected = [action for action in PROTECTED_DELETE_ACTIONS if action in actions]
    status_blocked = asset.status not in {"pending_acceptance", "available"}
    if asset.inventory_managed:
        return {
            "allowed": False,
            "asset_id": asset.id,
            "code": asset.code,
            "reason": "库存入库和出库流水需长期保留，不能永久删除该库存记录",
            "event_count": len(actions),
            "protected_actions": protected,
        }
    reason = None
    if protected:
        labels = "、".join(PROTECTED_DELETE_LABELS[action] for action in protected)
        reason = f"该设备已有{labels}等业务记录，删除将永久丢失这些历史"
    elif status_blocked:
        reason = f"设备当前状态为{STATUS_LABELS.get(asset.status, asset.status)}，删除将永久丢失其流转历史"
    return {
        "allowed": not protected and not status_blocked,
        "asset_id": asset.id,
        "code": asset.code,
        "reason": reason,
        "event_count": len(actions),
        "protected_actions": protected,
    }


def _add_asset(db, body: AssetIn, actor_id: int, batch_id=None, action="create", status="available"):
    a = EquipmentAsset(code=f"EQ-{app_today().year}-{uuid.uuid4().hex[:12].upper()}",
                       name=body.name.strip(), category_code=body.category_code.strip(),
                       serial_number=body.serial_number.strip() or None, brand=body.brand.strip(),
                       model=body.model.strip(), location=body.location.strip(), note=body.note.strip(),
                       purchase_date=body.purchase_date, purchase_price=body.purchase_price,
                       quantity=body.quantity, available_quantity=body.quantity,
                       inventory_managed=body.inventory_managed,
                       batch_id=batch_id, created_by=actor_id, status=status)
    db.add(a)
    db.flush()
    event_action = "inbound" if body.inventory_managed and action == "create" else action
    db.add(EquipmentEvent(asset_id=a.id, batch_id=batch_id, action=event_action,
                          from_status=None, to_status=status, actor_id=actor_id,
                          quantity=body.quantity if body.inventory_managed else None,
                          note=body.note.strip()))
    return a


def _page(q, page, size):
    return {"total": q.count(), "page": page, "size": size,
            "items": [_asset(a) for a in q.order_by(EquipmentAsset.id.desc())
                      .offset((page-1)*size).limit(size).all()]}


@router.get("")
def list_assets(keyword: str = "", category_code: str = "", status: str = "", holder_id: int | None = None,
                page: int = Query(1, ge=1), size: int = Query(20, ge=1, le=100),
                db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    q = db.query(EquipmentAsset)
    if keyword:
        pattern = f"%{keyword.strip()}%"
        q = q.filter(or_(EquipmentAsset.name.ilike(pattern), EquipmentAsset.code.ilike(pattern),
                         EquipmentAsset.serial_number.ilike(pattern)))
    if category_code:
        q = q.filter_by(category_code=category_code)
    if status:
        q = q.filter_by(status=status)
    if holder_id is not None:
        q = q.filter_by(holder_id=holder_id)
    return _page(q, page, size)


@router.get("/overview")
def overview(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    units = case((EquipmentAsset.inventory_managed.is_(True), EquipmentAsset.quantity), else_=1)
    rows = dict(db.query(EquipmentAsset.status, func.sum(units)).group_by(EquipmentAsset.status).all())
    overdue = db.query(EquipmentAsset).filter(EquipmentAsset.status == "borrowed",
              EquipmentAsset.due_date < app_today()).count()
    return {"total": sum(rows.values()), "by_status": rows, "overdue": overdue}


@router.get("/overdue")
def overdue(page: int = Query(1, ge=1), size: int = Query(20, ge=1, le=100),
            db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    return _page(db.query(EquipmentAsset).filter(EquipmentAsset.status == "borrowed",
                 EquipmentAsset.due_date < app_today()), page, size)


@router.get("/statistics")
def statistics(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    units = case((EquipmentAsset.inventory_managed.is_(True), EquipmentAsset.quantity), else_=1)
    by_category = [{"category_code": code, "count": count} for code, count in
                   db.query(EquipmentAsset.category_code, func.sum(units)).group_by(EquipmentAsset.category_code).all()]
    by_status = [{"status": status, "count": count} for status, count in
                 db.query(EquipmentAsset.status, func.sum(units)).group_by(EquipmentAsset.status).all()]
    event_month = func.to_char(func.coalesce(EquipmentEvent.shipped_at, EquipmentEvent.created_at), "YYYY-MM")
    inbound_actions = ("create", "inbound", "import", "return")
    outbound_actions = ("claim", "borrow", "outbound")
    monthly_events = db.query(
        event_month.label("month"),
        func.sum(case((EquipmentEvent.action.in_(inbound_actions), func.coalesce(EquipmentEvent.quantity, 1)), else_=0)).label("inbound"),
        func.sum(case((EquipmentEvent.action.in_(outbound_actions), func.coalesce(EquipmentEvent.quantity, 1)), else_=0)).label("outbound"),
    ).group_by(event_month).order_by(event_month).all()
    by_month = [{"month": month, "inbound": inbound, "outbound": outbound}
                for month, inbound, outbound in monthly_events]
    by_holder = [{"user_id": uid, "name": name, "count": count} for uid, name, count in
                 db.query(User.id, User.real_name, func.count()).join(EquipmentAsset, EquipmentAsset.holder_id == User.id)
                 .group_by(User.id, User.real_name).all()]
    return {"by_category": by_category, "by_status": by_status, "by_month": by_month, "by_holder": by_holder}


@router.get("/categories")
def categories(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    return [{"code": d.code, "label": d.label, "sort": d.sort} for d in
            db.query(Dict).filter_by(type="equipment_category").order_by(Dict.sort, Dict.id).all()]


@router.post("/categories")
def create_category(body: CategoryIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    require_admin(user)
    code, label = body.code.strip(), body.label.strip()
    if not code or not label or _category(db, code):
        raise HTTPException(400, "分类编码或名称无效，或编码已存在")
    db.add(Dict(type="equipment_category", code=code, label=label, sort=body.sort))
    commit_audited(db, user.id, "create_equipment_category", "equipment_categories", code, label)
    return {"code": code, "label": label, "sort": body.sort}


@router.patch("/categories/{code}")
def update_category(code: str, body: CategoryPatch, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    require_admin(user)
    d = _category(db, code)
    if not d:
        raise HTTPException(404, "分类不存在")
    if not body.label.strip():
        raise HTTPException(400, "分类名称必填")
    d.label = body.label.strip()
    if body.sort is not None:
        d.sort = body.sort
    commit_audited(db, user.id, "update_equipment_category", "equipment_categories", code, d.label)
    return {"code": d.code, "label": d.label, "sort": d.sort}


@router.delete("/categories/{code}")
def delete_category(code: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    require_admin(user)
    d = _category(db, code)
    if not d:
        raise HTTPException(404, "分类不存在")
    if db.query(EquipmentAsset).filter_by(category_code=code).first():
        raise HTTPException(400, "分类已有设备，不能删除")
    db.delete(d)
    commit_audited(db, user.id, "delete_equipment_category", "equipment_categories", code)
    return {"ok": True}


@router.post("/inbound")
def inbound(body: BatchIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    require_admin(user)
    if not body.items:
        raise HTTPException(400, "入库设备不能为空")
    for item in body.items:
        item.inventory_managed = body.inventory_managed
    if (body.batch_id is not None and bool(body.name.strip())) or (body.batch_id is None and not body.name.strip()):
        raise HTTPException(400, "请选择已有批次，或填写新批次名称")
    serials = [item.serial_number.strip() for item in body.items if item.serial_number.strip()]
    if len(serials) != len(set(serials)):
        raise HTTPException(400, "入库文件中设备序列号重复")
    if body.acceptance_status not in {"pending_acceptance", "accepted"}:
        raise HTTPException(400, "验收状态只能为 pending_acceptance 或 accepted")
    for item in body.items:
        _validate(db, item)

    if body.batch_id is not None:
        batch = _get_batch(db, body.batch_id)
        existing_managed = db.query(EquipmentAsset.inventory_managed).filter_by(batch_id=batch.id).first()
        if existing_managed and existing_managed[0] != body.inventory_managed:
            raise HTTPException(400, "不能在同一批次混合单件设备和库存物料")
        if batch.acceptance_status != body.acceptance_status and body.name:
            raise HTTPException(400, "选择已有批次时不能覆盖其验收状态")
        action = "add_equipment_to_batch"
    else:
        batch = _create_batch(db, user.id, name=body.name, source=body.source, supplier=body.supplier,
                              purchase_order_no=body.purchase_order_no, invoice_no=body.invoice_no,
                              acceptance_status=body.acceptance_status, note=body.note)
        action = "inbound_equipment"
    asset_status = "pending_acceptance" if batch.acceptance_status == "pending_acceptance" else "available"
    for item in body.items:
        if item.inventory_managed and asset_status != "available":
            raise HTTPException(400, "库存物料入库不支持待验收状态")
    items = [_add_asset(db, item, user.id, batch.id, "inbound", asset_status) for item in body.items]
    commit_audited(db, user.id, action, "equipment_batches", batch.id, f"count={len(items)}")
    asset_count = db.query(EquipmentAsset).filter_by(batch_id=batch.id).count()
    return {"batch_id": batch.id, "inventory_managed": body.inventory_managed,
            **_batch(batch, items, asset_count=asset_count)}


@router.get("/batches")
def list_batches(keyword: str = "", page: int = Query(1, ge=1), size: int = Query(20, ge=1, le=100),
                 db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    q = db.query(EquipmentBatch, func.count(EquipmentAsset.id).label("asset_count"))\
        .outerjoin(EquipmentAsset, EquipmentAsset.batch_id == EquipmentBatch.id).group_by(EquipmentBatch.id)
    text_keyword = keyword.strip()
    if text_keyword:
        pattern = f"%{text_keyword}%"
        filters = [EquipmentBatch.name.ilike(pattern), EquipmentBatch.source.ilike(pattern)]
        batch_id = text_keyword.removeprefix("#")
        if batch_id.isdigit():
            filters.append(EquipmentBatch.id == int(batch_id))
        q = q.filter(or_(*filters))
    total = q.count()
    rows = q.order_by(EquipmentBatch.id.desc()).offset((page-1)*size).limit(size).all()
    return {"total": total, "page": page, "size": size,
            "items": [_batch(batch, asset_count=count) for batch, count in rows]}


@router.patch("/batches/{batch_id}")
def rename_batch(batch_id: int, body: EquipmentBatchPatch, db: Session = Depends(get_db),
                 user: User = Depends(get_current_user)):
    require_admin(user)
    batch = _get_batch(db, batch_id)
    name = _normalize_batch_name(body.name)
    _check_batch_name_available(db, name, exclude_id=batch_id)
    batch.name = name
    try:
        db.flush()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(400, "批次名称已存在，请选择已有批次或更换名称") from exc
    commit_audited(db, user.id, "rename_equipment_batch", "equipment_batches", batch.id, name)
    return _batch(batch, asset_count=db.query(EquipmentAsset).filter_by(batch_id=batch.id).count())


@router.delete("/batches/{batch_id}")
def delete_batch(batch_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    require_admin(user)
    batch = _get_batch(db, batch_id)
    has_assets = db.query(EquipmentAsset.id).filter_by(batch_id=batch.id).first()
    has_events = db.query(EquipmentEvent.id).filter_by(batch_id=batch.id).first()
    if has_assets or has_events:
        raise HTTPException(409, "批次仍有关联设备或流水，不能删除")
    name = batch.name
    db.delete(batch)
    commit_audited(db, user.id, "delete_equipment_batch", "equipment_batches", batch_id,
                   json.dumps({"name": name}, ensure_ascii=False))
    return {"ok": True, "id": batch_id}


@router.get("/batches/{batch_id}")
def batch_detail(batch_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    batch = db.query(EquipmentBatch).filter_by(id=batch_id).first()
    if not batch:
        raise HTTPException(404, "入库批次不存在")
    assets = db.query(EquipmentAsset).filter_by(batch_id=batch_id).order_by(EquipmentAsset.id).all()
    return _batch(batch, assets)


@router.post("/batches/{batch_id}/accept")
def accept_batch(batch_id: int, body: TransitionIn = TransitionIn(),
                 db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    require_admin(user)
    batch = db.query(EquipmentBatch).filter_by(id=batch_id).with_for_update().first()
    if not batch:
        raise HTTPException(404, "入库批次不存在")
    if batch.acceptance_status != "pending_acceptance":
        raise HTTPException(400, "入库批次无需验收")
    assets = db.query(EquipmentAsset).filter_by(batch_id=batch_id, status="pending_acceptance")\
        .with_for_update().order_by(EquipmentAsset.id).all()
    batch.acceptance_status = "accepted"
    for asset in assets:
        asset.status = "available"
        db.add(EquipmentEvent(asset_id=asset.id, batch_id=batch.id, action="acceptance",
                              from_status="pending_acceptance", to_status="available",
                              actor_id=user.id, note=body.note.strip()))
    commit_audited(db, user.id, "accept_equipment_batch", "equipment_batches", batch.id,
                   f"count={len(assets)};note={body.note.strip()}")
    return _batch(batch, assets)


@router.post("")
def create_asset(body: AssetCreateIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    require_admin(user)
    if body.inventory_managed:
        raise HTTPException(400, "库存物料请使用入库登记接口")
    _validate(db, body)
    batch = _get_batch(db, body.batch_id) if body.batch_id is not None else None
    if batch is not None:
        existing = db.query(EquipmentAsset.inventory_managed).filter_by(batch_id=batch.id).first()
        if existing and existing[0] != body.inventory_managed:
            raise HTTPException(400, "不能在同一批次混合单件设备和库存物料")
    status = "pending_acceptance" if batch and batch.acceptance_status == "pending_acceptance" else "available"
    if body.inventory_managed and status != "available":
        raise HTTPException(400, "库存物料入库不支持待验收状态")
    a = _add_asset(db, body, user.id, batch.id if batch else None, status=status)
    commit_audited(db, user.id, "create_equipment", "equipment_assets", a.id, a.code)
    return _asset(a)


@router.get("/export")
def export_assets(format: str = "csv", db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    require_admin(user)
    if format not in {"csv", "xlsx"}:
        raise HTTPException(400, "仅支持 csv 或 xlsx")
    records = db.query(EquipmentAsset).order_by(EquipmentAsset.id).all()
    categories = {d.code: d.label for d in db.query(Dict).filter_by(type="equipment_category").all()}
    holder_ids = {a.holder_id for a in records if a.holder_id is not None}
    user_names = {u.id: u.real_name for u in
                  db.query(User).filter(User.id.in_(holder_ids))} if holder_ids else {}
    batch_ids = {a.batch_id for a in records if a.batch_id is not None}
    batches = {b.id: f"{b.name} · 批次 #{b.id}"
               for b in db.query(EquipmentBatch).filter(EquipmentBatch.id.in_(batch_ids))} if batch_ids else {}
    rows = [_export_row(a, categories, user_names, batches) for a in records]
    if format == "csv":
        out = io.StringIO()
        writer = csv.writer(out)
        writer.writerow([FIELD_LABELS[f] for f in EXPORT_FIELDS])
        for row in rows:
            writer.writerow([_csv_safe(v) if isinstance(v, str) else v for v in row])
        content = ("\ufeff" + out.getvalue()).encode("utf-8")
        media = "text/csv; charset=utf-8"
    else:
        book = Workbook()
        sheet = book.active
        sheet.title = EXPORT_STEM
        sheet.append([FIELD_LABELS[f] for f in EXPORT_FIELDS])
        for row in rows:
            sheet.append(row)
            for cell, value in zip(sheet[sheet.max_row], row):
                if isinstance(value, str):
                    cell.data_type = "s"
        for letter, width in zip("ABCDEFGHIJKLMN", (20, 22, 12, 18, 12, 14, 16, 14, 12, 10, 10, 12, 22, 24)):
            sheet.column_dimensions[letter].width = width
        sheet.freeze_panes = "A2"
        out = io.BytesIO()
        book.save(out)
        content = out.getvalue()
        media = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    write_audit(db, user.id, "export_equipment", "equipment_assets", detail=f"count={len(rows)},format={format}")
    return StreamingResponse(io.BytesIO(content), media_type=media,
                             headers=_disposition(EXPORT_STEM, format))


@router.get("/import-template")
def import_template(format: str = "xlsx", db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """导入模板：中文表头 + 示例行，Excel 版附带「填写说明」页列出可选分类。"""
    require_admin(user)
    if format not in {"csv", "xlsx"}:
        raise HTTPException(400, "仅支持 csv 或 xlsx")
    labels = [FIELD_LABELS[f] for f in IMPORT_FIELDS]
    cats = db.query(Dict).filter_by(type="equipment_category").order_by(Dict.sort, Dict.id).all()
    example = [IMPORT_EXAMPLE[f] for f in IMPORT_FIELDS]
    if not cats:
        example[IMPORT_FIELDS.index("category_code")] = "（请先在「分类维护」中创建分类）"
    if format == "csv":
        out = io.StringIO()
        writer = csv.writer(out)
        writer.writerow(labels)
        writer.writerow(example)
        content = ("\ufeff" + out.getvalue()).encode("utf-8")
        media = "text/csv; charset=utf-8"
    else:
        book = Workbook()
        sheet = book.active
        sheet.title = "台账导入"
        sheet.append(labels)
        sheet.append(example)
        for letter, width in zip("ABCDEFGHI", (12, 30, 12, 20, 12, 14, 16, 14, 30)):
            sheet.column_dimensions[letter].width = width
        sheet.freeze_panes = "A2"
        guide = book.create_sheet("填写说明")
        guide.append(["列名", "是否必填", "填写说明"])
        for field in IMPORT_FIELDS:
            guide.append([FIELD_LABELS[field], "必填" if field in {"name", "category_code"} else "选填",
                          FIELD_HINTS.get(field, "")])
        guide.append(["", "", "导入时按表头识别列，列顺序随意，多余的列会被忽略。"])
        guide.append(["设备分类可选值", "", "、".join(d.label for d in cats) if cats else "（暂无，请先到「分类维护」创建）"])
        guide.column_dimensions["A"].width = 14
        guide.column_dimensions["B"].width = 10
        guide.column_dimensions["C"].width = 60
        out = io.BytesIO()
        book.save(out)
        content = out.getvalue()
        media = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    write_audit(db, user.id, "download_equipment_template", "equipment_assets", detail=f"format={format}")
    return StreamingResponse(io.BytesIO(content), media_type=media,
                             headers=_disposition(TEMPLATE_STEM, format))


def _resolve_category(value: str, categories: dict) -> str:
    """分类列接受中文名称或英文编码，导出→再导入能原样回填。"""
    text = (value or "").strip()
    if not text:
        raise RowError("设备分类必填")
    if text in categories:
        return text
    for code, label in categories.items():
        if label == text:
            return code
    raise RowError(f"设备分类「{text}」不存在，请使用已有分类名称或编码")


@router.post("/import")
def import_assets(file: UploadFile = File(...), batch_id: int | None = Form(None),
                 batch_name: str = Form(""), source: str = Form(""), supplier: str = Form(""),
                 purchase_order_no: str = Form(""), invoice_no: str = Form(""),
                 acceptance_status: str = Form("accepted"), note: str = Form(""),
                 db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    require_admin(user)
    raw = file.file.read(5_000_001)
    if len(raw) > 5_000_000:
        raise HTTPException(400, "文件超过 5 MB")
    extension = (file.filename or "").lower().rsplit(".", 1)[-1]
    try:
        if extension == "csv":
            rows = list(csv.DictReader(io.StringIO(raw.decode("utf-8-sig"))))
        elif extension == "xlsx":
            sheet = load_workbook(io.BytesIO(raw), read_only=True, data_only=True).active
            values = sheet.iter_rows(values_only=True)
            headers = [str(v or "").strip() for v in next(values)]
            rows = [dict(zip(headers, row)) for row in values]
        else:
            raise HTTPException(400, "仅支持 csv 或 xlsx")
    except HTTPException:
        raise
    except (UnicodeError, ValueError, OSError, StopIteration, csv.Error, BadZipFile) as exc:
        raise HTTPException(400, "文件无法读取") from exc
    if not rows:
        raise HTTPException(400, "文件没有任何数据行，请确认已按模板填写并保存")
    categories = {d.code: d.label for d in db.query(Dict).filter_by(type="equipment_category").all()}
    # 表头 → 原始列名：中文列名与英文列名都能对上，同时收集无法识别的列。
    columns, unknown = {}, []
    for title in rows[0]:
        title = str(title or "").strip()
        if not title:
            continue
        field = HEADER_ALIASES.get(_header_key(title))
        if field is None:
            unknown.append(title)
        else:
            columns.setdefault(field, title)
    for field in ("name", "category_code"):
        if field not in columns:
            raise HTTPException(400,
                f"文件缺少必需列「{FIELD_LABELS[field]}」，请下载「设备台账导入模板」后按中文表头填写")

    errors, parsed, seen = [], [], set()
    for number, row in enumerate(rows, 2):
        if not any(str(value or "").strip() for value in row.values()):
            continue
        def cell(field):
            title = columns.get(field)
            return row.get(title) if title is not None else None
        try:
            name = str(cell("name") or "").strip()
            if not name:
                raise RowError("设备名称必填")
            code = _resolve_category(cell("category_code"), categories)
            serial = (cell("serial_number") or "").strip() or None
            purchase_date = _parse_date(cell("purchase_date"))
            if isinstance(purchase_date, RowError):
                raise purchase_date
            purchase_price = _parse_money(cell("purchase_price"))
            if isinstance(purchase_price, RowError):
                raise purchase_price
            body = AssetIn(name=name, category_code=code, serial_number=serial or "",
                           brand=(cell("brand") or "").strip(), model=(cell("model") or "").strip(),
                           location=(cell("location") or "").strip(), note=(cell("note") or "").strip(),
                           purchase_date=purchase_date, purchase_price=purchase_price)
            _validate(db, body)
            serial = body.serial_number.strip()
            if serial and serial in seen:
                raise RowError("文件中设备序列号重复")
            seen.add(serial)
            parsed.append(body)
        except RowError as exc:
            errors.append({"row": number, "message": str(exc)})
        except (ValueError, InvalidOperation, HTTPException) as exc:
            errors.append({"row": number,
                           "message": exc.detail if isinstance(exc, HTTPException) else "日期或金额格式错误"})
    if errors:
        raise HTTPException(400, {"errors": errors, "message": f"共 {len(errors)} 行导入失败，请修正后重新导入"})
    if not parsed:
        raise HTTPException(400, "文件中没有可导入的设备行")
    if (batch_id is not None and bool(batch_name.strip())) or (batch_id is None and not batch_name.strip()):
        raise HTTPException(400, "请选择已有批次，或填写新批次名称")
    if batch_id is not None:
        batch = _get_batch(db, batch_id)
        existing = db.query(EquipmentAsset.inventory_managed).filter_by(batch_id=batch.id).first()
        if existing and existing[0]:
            raise HTTPException(400, "库存物料批次请使用库存入库接口")
    else:
        batch = _create_batch(db, user.id, name=batch_name, source=source.strip() or f"导入 {file.filename}",
                              supplier=supplier, purchase_order_no=purchase_order_no,
                              invoice_no=invoice_no, acceptance_status=acceptance_status, note=note)
    asset_status = "pending_acceptance" if batch.acceptance_status == "pending_acceptance" else "available"
    for body in parsed:
        _add_asset(db, body, user.id, batch.id, "import", asset_status)
    commit_audited(db, user.id, "import_equipment", "equipment_batches", batch.id, f"count={len(parsed)}")
    result = {"batch_id": batch.id, "batch_name": batch.name, "created": len(parsed)}
    ignored = [FIELD_LABELS[f] for f in IMPORT_IGNORED if f in columns]
    if unknown or ignored:
        result["ignored_columns"] = {"未识别": unknown, "仅导出用(导入时忽略)": ignored}
    return result


@router.get("/{asset_id}/delete-check")
def delete_check(asset_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    require_admin(user)
    return _delete_check(db, _get(db, asset_id))


@router.delete("/{asset_id}")
def delete_asset(asset_id: int, body: AssetDeleteIn, db: Session = Depends(get_db),
                 user: User = Depends(get_current_user)):
    require_admin(user)
    asset = _get(db, asset_id, lock=True)
    if asset.inventory_managed:
        raise HTTPException(409, "库存入库和出库流水需长期保留，不能永久删除该库存记录")
    if body.confirm_code.strip() != asset.code:
        raise HTTPException(400, "设备编号确认不一致")
    reason = body.reason.strip()
    if not reason:
        raise HTTPException(400, "删除原因必填")
    if len(reason) > 500:
        raise HTTPException(400, "删除原因不能超过 500 个字符")

    # 管理员可强制删除：这里只做技术校验（编号确认 + 原因），
    # 不再按生命周期闸门拦截——真实使用过的资产也允许清理，
    # 但强制删除的事实会写进审计快照的 force_delete / protected_actions。
    check = _delete_check(db, asset)

    snapshot = json.dumps({
        "code": asset.code,
        "name": asset.name,
        "serial_number": asset.serial_number,
        "category_code": asset.category_code,
        "batch_id": asset.batch_id,
        "status": asset.status,
        "purchase_price": float(asset.purchase_price) if asset.purchase_price is not None else None,
        "created_by": asset.created_by,
        "created_at": asset.created_at,
        "event_count": check["event_count"],
        "protected_actions": check["protected_actions"],
        "force_delete": not check["allowed"],
        "reason": reason,
    }, ensure_ascii=False, default=str, separators=(",", ":"))
    deleted_code = asset.code
    # equipment_events 挂了「流水不可变」触发器（0027 建、0030 加受控放行）。这里在同一
    # 事务内用 SET LOCAL 打开 app.allow_event_purge 开关，让本次管理员删除能带走该设备
    # 的录入阶段流水；事务提交/回滚后开关自动失效，任何其他写路径依旧删不掉、也改不掉
    # 流水。被删流水的关键信息已随 force_delete / protected_actions 写入审计快照。
    db.execute(text("SET LOCAL app.allow_event_purge = 'on'"))
    db.query(EquipmentEvent).filter_by(asset_id=asset.id).delete(synchronize_session=False)
    db.delete(asset)
    commit_audited(db, user.id, "delete_equipment", "equipment_assets", asset_id, snapshot)
    return {"ok": True, "id": asset_id, "code": deleted_code}


@router.get("/outbounds")
def list_outbounds(asset_id: int | None = None, page: int = Query(1, ge=1), size: int = Query(20, ge=1, le=100),
                  db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    q = db.query(EquipmentEvent, EquipmentAsset).join(EquipmentAsset, EquipmentAsset.id == EquipmentEvent.asset_id)\
        .filter(EquipmentEvent.action == "outbound")
    if asset_id is not None:
        q = q.filter(EquipmentEvent.asset_id == asset_id)
    total = q.count()
    rows = q.order_by(EquipmentEvent.shipped_at.desc(), EquipmentEvent.id.desc())\
        .offset((page - 1) * size).limit(size).all()
    return {
        "total": total,
        "page": page,
        "size": size,
        "items": [
            {**_event(event), "asset_name": asset.name, "asset_code": asset.code,
             "available_quantity": asset.available_quantity}
            for event, asset in rows
        ],
    }


@router.get("/{asset_id}")
def detail(asset_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    return _asset(_get(db, asset_id))


@router.patch("/{asset_id}")
def update_asset(asset_id: int, body: AssetIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    require_admin(user)
    a = _get(db, asset_id, lock=True)
    if body.inventory_managed and not a.inventory_managed:
        raise HTTPException(400, "不能通过档案编辑将单件设备改为库存物料")
    if a.inventory_managed:
        # 库存总量与可用量只能通过入库 / 出库流水改变；基础信息仍可维护。
        body.inventory_managed = True
        body.quantity = a.quantity
    if a.status in {"scrapped", "void"}:
        raise HTTPException(400, "终止状态设备不能修改")
    _validate(db, body, exclude_id=asset_id)
    if a.inventory_managed and body.serial_number.strip():
        raise HTTPException(400, "库存物料不能填写单件序列号")
    for key in FIELDS:
        value = getattr(body, key)
        setattr(a, key, value.strip() if isinstance(value, str) else value)
    a.serial_number = a.serial_number or None
    db.add(EquipmentEvent(asset_id=a.id, batch_id=a.batch_id, action="update", from_status=a.status,
                          to_status=a.status, actor_id=user.id, holder_id=a.holder_id, due_date=a.due_date))
    commit_audited(db, user.id, "update_equipment", "equipment_assets", a.id, a.code)
    return _asset(a)


@router.get("/{asset_id}/events")
def events(asset_id: int, page: int = Query(1, ge=1), size: int = Query(100, ge=1, le=100),
           db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    _get(db, asset_id)
    q = db.query(EquipmentEvent).filter_by(asset_id=asset_id)
    return {"total": q.count(), "page": page, "size": size,
            "items": [_event(e) for e in q.order_by(EquipmentEvent.id).offset((page-1)*size).limit(size).all()]}


def _change(db, user, asset_id, action, body):
    a = _get(db, asset_id, lock=True)
    if a.inventory_managed:
        raise HTTPException(400, "库存物料请使用出库操作，不支持单件领用、借用或状态流转")
    old = a.status
    if action in {"claim", "borrow"}:
        if old != "available":
            raise HTTPException(400, "设备当前不可领用或借用")
        if action == "borrow" and body.due_date is not None and body.due_date < app_today():
            raise HTTPException(400, "归还日期不能早于今天")
        a.status = "claimed" if action == "claim" else "borrowed"
        a.holder_id = user.id
        a.due_date = body.due_date if action == "borrow" else None
    elif action == "return":
        if old not in {"claimed", "borrowed"}:
            raise HTTPException(400, "设备当前无需归还")
        if not is_admin(user) and (old != "borrowed" or a.holder_id != user.id):
            raise HTTPException(403, "普通用户只能归还本人借用设备")
        a.status, a.holder_id, a.due_date = "available", None, None
    else:
        require_admin(user)
        allowed = {"maintenance": {"available"}, "restore": {"maintenance"},
                   "scrap": {"available", "maintenance"},
                   "void": {"available", "claimed", "borrowed", "maintenance"}}
        if old not in allowed[action]:
            raise HTTPException(400, "设备当前状态不允许此操作")
        a.status = {"maintenance": "maintenance", "restore": "available",
                    "scrap": "scrapped", "void": "void"}[action]
        if action == "void":
            a.holder_id, a.due_date = None, None
    db.add(EquipmentEvent(asset_id=a.id, batch_id=a.batch_id, action=action,
                          from_status=old, to_status=a.status, actor_id=user.id,
                          holder_id=a.holder_id, due_date=a.due_date, note=body.note.strip()))
    commit_audited(db, user.id, f"{action}_equipment", "equipment_assets", a.id, f"{old}->{a.status}")
    return _asset(a)


@router.post("/{asset_id}/outbound")
def outbound(asset_id: int, body: OutboundIn, db: Session = Depends(get_db),
             user: User = Depends(get_current_user)):
    require_admin(user)
    asset = _get(db, asset_id, lock=True)
    if not asset.inventory_managed:
        raise HTTPException(400, "仅库存型物料支持出库")
    if asset.status != "available":
        raise HTTPException(400, "该库存记录当前不可出库")
    customer = body.customer.strip()
    destination = body.destination.strip()
    if not customer and not destination:
        raise HTTPException(400, "请填写发货客户或去向")
    if body.quantity > asset.available_quantity:
        raise HTTPException(400, f"可用库存不足，当前仅剩 {asset.available_quantity}")

    asset.available_quantity -= body.quantity
    event = EquipmentEvent(
        asset_id=asset.id,
        batch_id=asset.batch_id,
        action="outbound",
        from_status=asset.status,
        to_status=asset.status,
        actor_id=user.id,
        quantity=body.quantity,
        customer=customer or None,
        destination=destination or None,
        shipped_at=to_db(body.shipped_at),
        note=body.note.strip(),
    )
    db.add(event)
    commit_audited(
        db,
        user.id,
        "outbound_equipment_inventory",
        "equipment_assets",
        asset.id,
        json.dumps(
            {"quantity": body.quantity, "customer": customer, "destination": destination,
             "shipped_at": to_db(body.shipped_at)},
            ensure_ascii=False,
            default=str,
        ),
    )
    return {**_event(event), "available_quantity": asset.available_quantity}


@router.post("/{asset_id}/claim")
def claim(asset_id: int, body: TransitionIn = TransitionIn(), db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    return _change(db, user, asset_id, "claim", body)


@router.post("/{asset_id}/borrow")
def borrow(asset_id: int, body: TransitionIn = TransitionIn(), db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    return _change(db, user, asset_id, "borrow", body)


@router.post("/{asset_id}/return")
def return_asset(asset_id: int, body: TransitionIn = TransitionIn(), db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    return _change(db, user, asset_id, "return", body)


@router.post("/{asset_id}/maintenance")
def maintenance(asset_id: int, body: TransitionIn = TransitionIn(), db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    require_admin(user)
    return _change(db, user, asset_id, "maintenance", body)


@router.post("/{asset_id}/restore")
def restore(asset_id: int, body: TransitionIn = TransitionIn(), db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    require_admin(user)
    return _change(db, user, asset_id, "restore", body)


@router.post("/{asset_id}/scrap")
def scrap(asset_id: int, body: TransitionIn = TransitionIn(), db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    require_admin(user)
    return _change(db, user, asset_id, "scrap", body)


@router.post("/{asset_id}/void")
def void(asset_id: int, body: TransitionIn = TransitionIn(), db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    require_admin(user)
    return _change(db, user, asset_id, "void", body)
