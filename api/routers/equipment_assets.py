"""公司设备资产台账，独立于财务固定资产。"""
import csv
import io
import uuid
from zipfile import BadZipFile
from datetime import date
from decimal import Decimal, InvalidOperation

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from fastapi.responses import StreamingResponse
from openpyxl import Workbook, load_workbook
from pydantic import BaseModel
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from ..core.audit import commit_audited, write_audit
from ..core.database import get_db
from ..core.deps import get_current_user
from ..core.rbac import is_admin, require_admin
from ..core.timeutil import app_now, app_today
from ..models import Dict, EquipmentAsset, EquipmentBatch, EquipmentEvent, User

router = APIRouter(prefix="/equipment-assets", tags=["equipment-assets"])
FIELDS = ("name", "category_code", "serial_number", "brand", "model", "location", "note", "purchase_date", "purchase_price")
EXPORT_FIELDS = ("code", *FIELDS, "status", "holder_id", "due_date", "batch_id")


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


class BatchIn(BaseModel):
    source: str = ""
    note: str = ""
    items: list[AssetIn]


class TransitionIn(BaseModel):
    due_date: date | None = None
    note: str = ""


class CategoryIn(BaseModel):
    code: str
    label: str
    sort: int = 0


class CategoryPatch(BaseModel):
    label: str
    sort: int | None = None


def _asset(a: EquipmentAsset) -> dict:
    return {"id": a.id, "code": a.code, "name": a.name, "category_code": a.category_code,
            "serial_number": a.serial_number or "", "brand": a.brand, "model": a.model,
            "location": a.location, "note": a.note, "purchase_date": a.purchase_date,
            "purchase_price": float(a.purchase_price) if a.purchase_price is not None else None,
            "status": a.status, "holder_id": a.holder_id, "due_date": a.due_date,
            "batch_id": a.batch_id, "created_by": a.created_by,
            "created_at": a.created_at, "updated_at": a.updated_at}


def _event(e: EquipmentEvent) -> dict:
    return {"id": e.id, "asset_id": e.asset_id, "batch_id": e.batch_id,
            "action": e.action, "from_status": e.from_status, "to_status": e.to_status,
            "actor_id": e.actor_id, "holder_id": e.holder_id, "due_date": e.due_date,
            "note": e.note, "created_at": e.created_at}


def _category(db, code):
    return db.query(Dict).filter_by(type="equipment_category", code=code).first()


def _validate(db, body: AssetIn, exclude_id=None):
    if not body.name.strip():
        raise HTTPException(400, "设备名称必填")
    if not _category(db, body.category_code.strip()):
        raise HTTPException(400, "设备分类不存在")
    if body.purchase_price is not None and (not body.purchase_price.is_finite() or body.purchase_price < 0):
        raise HTTPException(400, "采购金额必须为非负有限数")
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


def _add_asset(db, body: AssetIn, actor_id: int, batch_id=None, action="create"):
    a = EquipmentAsset(code=f"EQ-{app_today().year}-{uuid.uuid4().hex[:12].upper()}",
                       name=body.name.strip(), category_code=body.category_code.strip(),
                       serial_number=body.serial_number.strip() or None, brand=body.brand.strip(),
                       model=body.model.strip(), location=body.location.strip(), note=body.note.strip(),
                       purchase_date=body.purchase_date, purchase_price=body.purchase_price,
                       batch_id=batch_id, created_by=actor_id, status="available")
    db.add(a)
    db.flush()
    db.add(EquipmentEvent(asset_id=a.id, batch_id=batch_id, action=action,
                          from_status=None, to_status="available", actor_id=actor_id,
                          note=body.note.strip()))
    return a


def _page(q, page, size):
    return {"total": q.count(), "page": page, "size": size,
            "items": [_asset(a) for a in q.order_by(EquipmentAsset.id.desc()).offset((page-1)*size).limit(size).all()]}


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
    rows = dict(db.query(EquipmentAsset.status, func.count()).group_by(EquipmentAsset.status).all())
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
    by_category = [{"category_code": code, "count": count} for code, count in
                   db.query(EquipmentAsset.category_code, func.count()).group_by(EquipmentAsset.category_code).all()]
    by_status = [{"status": status, "count": count} for status, count in
                 db.query(EquipmentAsset.status, func.count()).group_by(EquipmentAsset.status).all()]
    by_month = [{"month": month, "count": count} for month, count in
                db.query(func.to_char(EquipmentAsset.created_at, "YYYY-MM"), func.count())
                .group_by(func.to_char(EquipmentAsset.created_at, "YYYY-MM")).order_by(1).all()]
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
    serials = [item.serial_number.strip() for item in body.items if item.serial_number.strip()]
    if len(serials) != len(set(serials)):
        raise HTTPException(400, "入库文件中设备序列号重复")
    for item in body.items:
        _validate(db, item)
    batch = EquipmentBatch(source=body.source.strip(), note=body.note.strip(), created_by=user.id)
    db.add(batch)
    db.flush()
    items = [_add_asset(db, item, user.id, batch.id, "inbound") for item in body.items]
    commit_audited(db, user.id, "inbound_equipment", "equipment_batches", batch.id, f"count={len(items)}")
    return {"batch_id": batch.id, "items": [_asset(a) for a in items]}


@router.post("")
def create_asset(body: AssetIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    require_admin(user)
    _validate(db, body)
    a = _add_asset(db, body, user.id)
    commit_audited(db, user.id, "create_equipment", "equipment_assets", a.id, a.code)
    return _asset(a)


@router.get("/export")
def export_assets(format: str = "csv", db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    require_admin(user)
    if format not in {"csv", "xlsx"}:
        raise HTTPException(400, "仅支持 csv 或 xlsx")
    records = [_asset(a) for a in db.query(EquipmentAsset).order_by(EquipmentAsset.id).all()]
    if format == "csv":
        out = io.StringIO()
        writer = csv.writer(out)
        writer.writerow(EXPORT_FIELDS)
        writer.writerows([[str(r.get(field) or "") for field in EXPORT_FIELDS] for r in records])
        content = ("\ufeff" + out.getvalue()).encode("utf-8")
        media = "text/csv; charset=utf-8"
    else:
        book = Workbook()
        sheet = book.active
        sheet.append(EXPORT_FIELDS)
        for r in records:
            sheet.append([str(r.get(field) or "") for field in EXPORT_FIELDS])
        out = io.BytesIO()
        book.save(out)
        content = out.getvalue()
        media = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    write_audit(db, user.id, "export_equipment", "equipment_assets", detail=f"count={len(records)},format={format}")
    return StreamingResponse(io.BytesIO(content), media_type=media,
                             headers={"Content-Disposition": f"attachment; filename=equipment_assets.{format}"})


@router.post("/import")
def import_assets(file: UploadFile = File(...), db: Session = Depends(get_db), user: User = Depends(get_current_user)):
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
    if not rows or not {"name", "category_code"}.issubset(rows[0]):
        raise HTTPException(400, "文件须包含 name、category_code 且至少有一行设备")
    errors, parsed, seen = [], [], set()
    for number, row in enumerate(rows, 2):
        data = {key: row.get(key) or "" for key in FIELDS}
        data = {key: str(value).strip() if key not in {"purchase_date", "purchase_price"} else value
                for key, value in data.items()}
        try:
            if data["purchase_date"]:
                data["purchase_date"] = (data["purchase_date"] if isinstance(data["purchase_date"], date)
                                         else date.fromisoformat(str(data["purchase_date"])))
            else:
                data["purchase_date"] = None
            data["purchase_price"] = Decimal(str(data["purchase_price"])) if data["purchase_price"] != "" else None
            body = AssetIn(**data)
            _validate(db, body)
            serial = body.serial_number.strip()
            if serial and serial in seen:
                raise HTTPException(400, "文件中设备序列号重复")
            seen.add(serial)
            parsed.append(body)
        except (ValueError, InvalidOperation, HTTPException) as exc:
            message = exc.detail if isinstance(exc, HTTPException) else "日期或金额格式错误"
            errors.append({"row": number, "message": message})
    if errors:
        raise HTTPException(400, {"errors": errors})
    batch = EquipmentBatch(source=f"导入 {file.filename}", note="", created_by=user.id)
    db.add(batch)
    db.flush()
    for body in parsed:
        _add_asset(db, body, user.id, batch.id, "import")
    commit_audited(db, user.id, "import_equipment", "equipment_batches", batch.id, f"count={len(parsed)}")
    return {"batch_id": batch.id, "created": len(parsed)}


@router.get("/{asset_id}")
def detail(asset_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    return _asset(_get(db, asset_id))


@router.patch("/{asset_id}")
def update_asset(asset_id: int, body: AssetIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    require_admin(user)
    a = _get(db, asset_id, lock=True)
    if a.status in {"scrapped", "void"}:
        raise HTTPException(400, "终止状态设备不能修改")
    _validate(db, body, exclude_id=asset_id)
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
