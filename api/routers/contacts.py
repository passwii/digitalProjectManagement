"""管理员通讯录花名册：人员主数据、可选账号关联与证件/合同附件。"""
import re
from datetime import date, datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel
from sqlalchemy import func, or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..core.attachments import (
    attachment_response,
    remove_attachment_blob,
    store_attachment,
)
from ..core.audit import commit_audited, write_audit
from ..core.database import get_db
from ..core.deps import get_current_user
from ..core.limits import MAX_ATTACHMENT_SIZE, read_within_limit
from ..core.paging import DEFAULT_PAGE_SIZE, paginate
from ..core.rbac import require_admin
from ..models import Attachment, ContactProfile, Department, User

router = APIRouter(prefix="/contacts", tags=["contacts"])

EMPLOYMENT_TYPES = {"正式", "试用", "实习", "劳务", "兼职", "返聘"}
EMPLOYMENT_STATUSES = {"active", "probation", "leave"}
CONTRACT_TYPES = {"劳动合同", "劳务合同", "实习协议", "顾问协议", "其他"}
GENDERS = {"男", "女", "未填写"}
ATTACHMENT_CATEGORIES = {
    "id_card", "education", "degree", "professional_cert", "labor_contract", "other",
}
ALLOWED_EXT = {".pdf", ".doc", ".docx", ".xls", ".xlsx", ".png", ".jpg", ".jpeg"}
# 体积上限与超限文案统一来自 core.limits（前端单一来源为 web/lib/uploadLimits.ts）
MAX_SIZE = MAX_ATTACHMENT_SIZE
ID_CARD_RE = re.compile(r"^(?:\d{15}|\d{17}[\dXx])$")
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

CONTACT_SORTS = {
    "id": ContactProfile.id,
    "name": ContactProfile.name,
    "mobile": ContactProfile.mobile,
    "dept_id": ContactProfile.dept_id,
    "employee_no": ContactProfile.employee_no,
    "position": ContactProfile.position,
    "employment_status": ContactProfile.employment_status,
    "employment_type": ContactProfile.employment_type,
    "hire_date": ContactProfile.hire_date,
    "updated_at": ContactProfile.updated_at,
}

PROFILE_TEXT_LIMITS = {
    "mobile": 32,
    "position": 64,
    "work_email": 128,
    "office_phone": 32,
    "work_location": 128,
    "id_card_no": 32,
    "native_place": 64,
    "political_status": 32,
    "marital_status": 16,
    "address": 255,
    "highest_education": 32,
    "school": 128,
    "major": 128,
    "degree": 32,
    "emergency_contact": 64,
    "emergency_relation": 32,
    "emergency_phone": 32,
    "remark": 1000,
}


class ContactIn(BaseModel):
    name: str | None = None
    mobile: str | None = None
    dept_id: int | None = None
    user_id: int | None = None
    employee_no: str | None = None
    position: str | None = None
    manager_id: int | None = None
    employment_type: str | None = None
    employment_status: str | None = None
    hire_date: date | None = None
    regular_date: date | None = None
    leave_date: date | None = None
    work_email: str | None = None
    office_phone: str | None = None
    work_location: str | None = None
    contract_type: str | None = None
    contract_start: date | None = None
    contract_end: date | None = None
    gender: str | None = None
    birth_date: date | None = None
    id_card_no: str | None = None
    native_place: str | None = None
    political_status: str | None = None
    marital_status: str | None = None
    address: str | None = None
    highest_education: str | None = None
    school: str | None = None
    major: str | None = None
    graduation_date: date | None = None
    degree: str | None = None
    emergency_contact: str | None = None
    emergency_relation: str | None = None
    emergency_phone: str | None = None
    remark: str | None = None


def _admin(user: User) -> None:
    require_admin(user)


def _iso(value):
    return value.isoformat() if value else None


def _mask_id_card(value: str) -> str:
    if not value:
        return ""
    if len(value) <= 8:
        return "*" * len(value)
    return f"{value[:6]}{'*' * (len(value) - 10)}{value[-4:]}"


def _clean_text(value: str | None) -> str:
    return (value or "").strip()


def _contact_or_404(db: Session, cid: int) -> ContactProfile:
    profile = db.query(ContactProfile).filter_by(id=cid).first()
    if not profile:
        raise HTTPException(404, "通讯录人员不存在")
    return profile


def _attachment_count_query(db: Session):
    return (
        db.query(func.count(Attachment.id))
        .filter(Attachment.ref_type == "contact", Attachment.ref_id == ContactProfile.id)
        .correlate(ContactProfile)
        .scalar_subquery()
    )


def _joined_query(db: Session):
    return (
        db.query(
            ContactProfile,
            User,
            Department,
            _attachment_count_query(db).label("attachment_count"),
        )
        .outerjoin(User, User.id == ContactProfile.user_id)
        .outerjoin(Department, Department.id == ContactProfile.dept_id)
    )


def _serialize(profile: ContactProfile, account: User | None, dept_name: str = "",
               attachment_count: int = 0, manager_name: str = "",
               sensitive: bool = False) -> dict:
    id_card = profile.id_card_no or ""
    name = profile.name or (account.real_name if account else "") or (account.username if account else "")
    return {
        "id": profile.id,
        "user_id": profile.user_id,
        "username": account.username if account else "",
        "real_name": name,
        "name": name,
        "mobile": profile.mobile or (account.username if account else ""),
        "dept_id": profile.dept_id,
        "dept_name": dept_name,
        "account_status": account.status if account else "none",
        "has_account": account is not None,
        "employee_no": profile.employee_no or "",
        "position": profile.position or "",
        "manager_id": profile.manager_id,
        "manager_name": manager_name,
        "employment_type": profile.employment_type or "正式",
        "employment_status": profile.employment_status or "active",
        "hire_date": _iso(profile.hire_date),
        "regular_date": _iso(profile.regular_date),
        "leave_date": _iso(profile.leave_date),
        "work_email": profile.work_email or "",
        "office_phone": profile.office_phone or "",
        "work_location": profile.work_location or "",
        "contract_type": profile.contract_type or "",
        "contract_start": _iso(profile.contract_start),
        "contract_end": _iso(profile.contract_end),
        "gender": profile.gender or "",
        "birth_date": _iso(profile.birth_date),
        "id_card_no": id_card if sensitive else "",
        "id_card_masked": _mask_id_card(id_card),
        "native_place": profile.native_place or "",
        "political_status": profile.political_status or "",
        "marital_status": profile.marital_status or "",
        "address": profile.address or "",
        "highest_education": profile.highest_education or "",
        "school": profile.school or "",
        "major": profile.major or "",
        "graduation_date": _iso(profile.graduation_date),
        "degree": profile.degree or "",
        "emergency_contact": profile.emergency_contact or "",
        "emergency_relation": profile.emergency_relation or "",
        "emergency_phone": profile.emergency_phone or "",
        "remark": profile.remark or "",
        "has_profile": True,
        "attachment_count": int(attachment_count or 0),
        "updated_at": profile.updated_at.isoformat() if profile.updated_at else None,
    }


def _manager_name(db: Session, profile: ContactProfile) -> str:
    if not profile.manager_id:
        return ""
    manager = db.query(ContactProfile).filter_by(id=profile.manager_id).first()
    return manager.name if manager else ""


def _detail(db: Session, cid: int, sensitive: bool) -> dict:
    row = _joined_query(db).filter(ContactProfile.id == cid).first()
    if not row:
        raise HTTPException(404, "通讯录人员不存在")
    profile, account, dept, attachment_count = row
    return _serialize(
        profile, account, dept.name if dept else "", attachment_count,
        _manager_name(db, profile), sensitive=sensitive,
    )


def _validate_employee_no(db: Session, cid: int | None, value: str | None) -> str | None:
    employee_no = _clean_text(value) or None
    if employee_no and len(employee_no) > 32:
        raise HTTPException(400, "工号最多 32 个字符")
    if employee_no:
        query = db.query(ContactProfile).filter(ContactProfile.employee_no == employee_no)
        if cid is not None:
            query = query.filter(ContactProfile.id != cid)
        if query.first():
            raise HTTPException(400, "工号已存在")
    return employee_no


def _validate_user_link(db: Session, cid: int | None, user_id: int | None) -> User | None:
    if user_id is None:
        return None
    account = db.query(User).filter_by(id=user_id).first()
    if not account:
        raise HTTPException(400, "关联账号不存在")
    query = db.query(ContactProfile).filter(ContactProfile.user_id == user_id)
    if cid is not None:
        query = query.filter(ContactProfile.id != cid)
    if query.first():
        raise HTTPException(400, "该账号已关联其他通讯录人员")
    return account


def _apply_payload(db: Session, profile: ContactProfile, data: dict, actor_id: int) -> None:
    if "name" in data:
        name = _clean_text(data["name"])
        if not name:
            raise HTTPException(400, "姓名不能为空")
        if len(name) > 64:
            raise HTTPException(400, "姓名最多 64 个字符")
        profile.name = name

    if "dept_id" in data:
        dept_id = data["dept_id"]
        if dept_id is not None and not db.query(Department).filter_by(id=dept_id).first():
            raise HTTPException(400, "部门不存在")
        profile.dept_id = dept_id

    linked_account: User | None = None
    if "user_id" in data:
        linked_account = _validate_user_link(db, profile.id, data["user_id"])
        profile.user_id = data["user_id"]

    if "employee_no" in data:
        profile.employee_no = _validate_employee_no(db, profile.id, data["employee_no"])

    for field, limit in PROFILE_TEXT_LIMITS.items():
        if field not in data:
            continue
        value = _clean_text(data[field])
        if len(value) > limit:
            raise HTTPException(400, f"{field} 最多 {limit} 个字符")
        setattr(profile, field, value)

    if "manager_id" in data:
        manager_id = data["manager_id"]
        if manager_id == profile.id:
            raise HTTPException(400, "直属上级不能选择本人")
        if manager_id is not None and not db.query(ContactProfile).filter_by(id=manager_id).first():
            raise HTTPException(400, "直属上级不存在")
        profile.manager_id = manager_id

    if "employment_type" in data:
        value = _clean_text(data["employment_type"])
        if value not in EMPLOYMENT_TYPES:
            raise HTTPException(400, f"用工类型仅支持 {'/'.join(sorted(EMPLOYMENT_TYPES))}")
        profile.employment_type = value

    if "employment_status" in data:
        value = _clean_text(data["employment_status"])
        if value not in EMPLOYMENT_STATUSES:
            raise HTTPException(400, "任职状态仅支持 active/probation/leave")
        profile.employment_status = value

    if "contract_type" in data:
        value = _clean_text(data["contract_type"])
        if value and value not in CONTRACT_TYPES:
            raise HTTPException(400, f"合同类型仅支持 {'/'.join(sorted(CONTRACT_TYPES))}")
        profile.contract_type = value

    if "gender" in data:
        value = _clean_text(data["gender"])
        if value and value not in GENDERS:
            raise HTTPException(400, "性别仅支持 男/女/未填写")
        profile.gender = value

    for field in ("hire_date", "regular_date", "leave_date", "contract_start",
                  "contract_end", "birth_date", "graduation_date"):
        if field in data:
            setattr(profile, field, data[field])

    if profile.birth_date and profile.birth_date > date.today():
        raise HTTPException(400, "出生日期不能晚于今天")
    if profile.hire_date and profile.regular_date and profile.hire_date > profile.regular_date:
        raise HTTPException(400, "入职日期不能晚于转正日期")
    if profile.regular_date and profile.leave_date and profile.regular_date > profile.leave_date:
        raise HTTPException(400, "转正日期不能晚于离职日期")
    if profile.hire_date and profile.leave_date and profile.hire_date > profile.leave_date:
        raise HTTPException(400, "入职日期不能晚于离职日期")
    if profile.contract_start and profile.contract_end and profile.contract_start > profile.contract_end:
        raise HTTPException(400, "合同开始日期不能晚于结束日期")

    if profile.id_card_no and not ID_CARD_RE.match(profile.id_card_no):
        raise HTTPException(400, "身份证号须为 15 位或 18 位中国居民身份证格式")
    if profile.id_card_no:
        profile.id_card_no = profile.id_card_no.upper()
    if profile.work_email and not EMAIL_RE.match(profile.work_email):
        raise HTTPException(400, "工作邮箱格式不正确")

    account = linked_account if "user_id" in data else (
        db.query(User).filter_by(id=profile.user_id).first() if profile.user_id else None
    )
    if account:
        account.real_name = profile.name
        account.dept_id = profile.dept_id

    profile.updated_by = actor_id
    profile.updated_at = datetime.now(timezone.utc)


@router.get("")
def list_contacts(keyword: str = "", dept_id: int = 0, employment_status: str = "",
                  sort: str = "id", page: int = 1, size: int = DEFAULT_PAGE_SIZE,
                  db: Session = Depends(get_db),
                  user: User = Depends(get_current_user)):
    """管理员通讯录列表：人员主数据，不要求存在登录账号。"""
    _admin(user)
    if employment_status and employment_status not in EMPLOYMENT_STATUSES:
        raise HTTPException(400, "任职状态仅支持 active/probation/leave")

    q = _joined_query(db)
    if keyword:
        like = f"%{keyword.strip()}%"
        q = q.filter(or_(
            ContactProfile.name.ilike(like),
            ContactProfile.mobile.ilike(like),
            User.username.ilike(like),
            ContactProfile.employee_no.ilike(like),
            ContactProfile.position.ilike(like),
            ContactProfile.work_email.ilike(like),
        ))
    if dept_id:
        q = q.filter(ContactProfile.dept_id == dept_id)
    if employment_status:
        q = q.filter(ContactProfile.employment_status == employment_status)

    return paginate(
        q,
        page=page,
        size=size,
        allowed=CONTACT_SORTS,
        default_sort="id",
        sort=sort,
        map_row=lambda row: _serialize(
            row[0], row[1], row[2].name if row[2] else "",
            attachment_count=row[3], sensitive=False,
        ),
    )


@router.get("/options")
def contact_options(keyword: str = "", limit: int = 500,
                    db: Session = Depends(get_db),
                    user: User = Depends(get_current_user)):
    """通讯录人员最小字段，供直属上级选择器使用。"""
    _admin(user)
    limit = max(1, min(limit, 500))
    q = db.query(ContactProfile)
    if keyword:
        q = q.filter(ContactProfile.name.ilike(f"%{keyword.strip()}%"))
    rows = q.order_by(ContactProfile.id).limit(limit).all()
    return [{"id": row.id, "name": row.name, "dept_id": row.dept_id,
             "position": row.position or ""} for row in rows]


@router.post("")
def create_contact(body: ContactIn, db: Session = Depends(get_db),
                   user: User = Depends(get_current_user)):
    """新建通讯录人员，不要求先创建系统账号。"""
    _admin(user)
    data = body.model_dump(exclude_unset=True)
    if not _clean_text(data.get("name")):
        raise HTTPException(400, "姓名不能为空")
    profile = ContactProfile(name=_clean_text(data["name"]),
                             employment_type="正式", employment_status="active",
                             updated_by=user.id)
    db.add(profile)
    db.flush()
    _apply_payload(db, profile, data, user.id)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise HTTPException(400, "工号或关联账号已存在")
    commit_audited(db, user.id, "create_contact", "contact_profiles", profile.id, profile.name)
    return _detail(db, profile.id, sensitive=True)


@router.get("/{cid}")
def get_contact(cid: int, db: Session = Depends(get_db),
                user: User = Depends(get_current_user)):
    _admin(user)
    return _detail(db, cid, sensitive=True)


@router.patch("/{cid}")
def update_contact(cid: int, body: ContactIn, db: Session = Depends(get_db),
                   user: User = Depends(get_current_user)):
    """更新人员档案；如已关联账号，同步账号姓名和部门。"""
    _admin(user)
    profile = _contact_or_404(db, cid)
    _apply_payload(db, profile, body.model_dump(exclude_unset=True), user.id)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise HTTPException(400, "工号或关联账号已存在")
    commit_audited(db, user.id, "update_contact", "contact_profiles", profile.id, profile.name)
    return _detail(db, cid, sensitive=True)


def _attachment(a: Attachment) -> dict:
    return {
        "id": a.id,
        "filename": a.filename,
        "size": a.size,
        "category": a.category or "",
        "content_type": a.content_type or "",
        "uploaded_by": a.uploaded_by,
        "uploaded_at": a.uploaded_at.isoformat() if a.uploaded_at else None,
    }


@router.get("/{cid}/attachments")
def list_attachments(cid: int, category: str = "", db: Session = Depends(get_db),
                     user: User = Depends(get_current_user)):
    _admin(user)
    _contact_or_404(db, cid)
    if category and category not in ATTACHMENT_CATEGORIES:
        raise HTTPException(400, "附件分类不支持")
    q = db.query(Attachment).filter(
        Attachment.project_id.is_(None),
        Attachment.ref_type == "contact",
        Attachment.ref_id == cid,
    )
    if category:
        q = q.filter(Attachment.category == category)
    rows = q.order_by(Attachment.id.desc()).all()
    return [_attachment(row) for row in rows]


@router.post("/{cid}/attachments")
def upload_attachment(cid: int, file: UploadFile = File(...),
                      category: str = Form(...), db: Session = Depends(get_db),
                      user: User = Depends(get_current_user)):
    _admin(user)
    _contact_or_404(db, cid)
    if category not in ATTACHMENT_CATEGORIES:
        raise HTTPException(400, "附件分类不支持")

    original = Path((file.filename or "attachment").replace("\\", "/")).name or "attachment"
    ext = Path(original).suffix.lower()
    if ext not in ALLOWED_EXT:
        raise HTTPException(400, f"仅允许 {sorted(ALLOWED_EXT)}")
    # 有界读取：超限在读完 limit+1 字节时就 400，不会把无界数据读进内存
    data = read_within_limit(file, MAX_SIZE)

    # 正文落位（本地磁盘 / R2）由 core.attachments 收口
    row = store_attachment(
        db, domain="contact", filename=original, content_type=file.content_type or "",
        data=data, project_id=None, ref_type="contact", ref_id=cid,
        category=category, uploaded_by=user.id,
    )
    commit_audited(db, user.id, "upload_contact_attachment", "attachments",
                   row.id, f"{cid}:{category}:{original}")
    return _attachment(row)


@router.get("/{cid}/attachments/{aid}/download")
def download_attachment(cid: int, aid: int, db: Session = Depends(get_db),
                        user: User = Depends(get_current_user)):
    _admin(user)
    _contact_or_404(db, cid)
    row = db.query(Attachment).filter(
        Attachment.id == aid,
        Attachment.project_id.is_(None),
        Attachment.ref_type == "contact",
        Attachment.ref_id == cid,
    ).first()
    if not row:
        raise HTTPException(404, "附件不存在")
    filename = row.filename
    write_audit(db, user.id, "download_contact_attachment", "attachments", row.id,
                f"{cid}:{filename}")
    return attachment_response(row)


@router.delete("/{cid}/attachments/{aid}")
def delete_attachment(cid: int, aid: int, db: Session = Depends(get_db),
                      user: User = Depends(get_current_user)):
    _admin(user)
    _contact_or_404(db, cid)
    row = db.query(Attachment).filter(
        Attachment.id == aid,
        Attachment.project_id.is_(None),
        Attachment.ref_type == "contact",
        Attachment.ref_id == cid,
    ).first()
    if not row:
        raise HTTPException(404, "附件不存在")
    filename = row.filename
    # 先删正文、再删元数据：R2 删不掉时抛 502 并保留元数据，避免产生孤儿对象
    remove_attachment_blob(row)
    db.delete(row)
    db.flush()
    commit_audited(db, user.id, "delete_contact_attachment", "attachments", aid,
                   f"{cid}:{filename}")
    return {"ok": True}
