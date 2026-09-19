"""我的友商模块（BLF-1152）：竞对 / 陪标单位信息管理，仅管理员维护。

口径与通讯录模块（`routers/contacts.py`）对齐：

  · 全接口 `require_admin`（非管理员稳定 403，鉴权先于任何业务读写）；
  · 列表走 `core.paging.paginate` 统一信封 `{total,page,size,items}`；
  · 附件复用 `attachments` 表（`ref_type='partner'` + 分类），正文读写经
    `core.attachments` 收口（本地 / R2 双后端），体积上限与扩展名白名单与
    `core.limits.MAX_ATTACHMENT_SIZE` 同一来源；
  · 写操作经 `commit_audited`（业务行 + 审计同一次提交），附件下载经
    `write_audit` 留痕；
  · 时间口径走 `core.timeutil`（naive 北京时间墙钟，对外带偏移 ISO8601）。
"""

import math
import re
from datetime import date
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel
from sqlalchemy import or_
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
from ..core.timeutil import app_now, iso
from ..models import Attachment, Partner, PartnerContract, PartnerMember, User

router = APIRouter(prefix="/partners", tags=["partners"])

# 附件分类：qual_cert 资质证书 / performance 业绩证明 / contract 合同扫描 / other 其他
ATTACHMENT_CATEGORIES = {
    "qual_cert",
    "performance",
    "contract",
    "other",
}
ATTACHMENT_CATEGORY_LABELS = {
    "qual_cert": "资质证书",
    "performance": "业绩证明",
    "contract": "合同扫描",
    "other": "其他",
}
ALLOWED_EXT = {".pdf", ".doc", ".docx", ".xls", ".xlsx", ".png", ".jpg", ".jpeg"}
# 体积上限与超限文案统一来自 core.limits（与通讯录 / 项目 / 支出凭证同一来源）
MAX_SIZE = MAX_ATTACHMENT_SIZE
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

PARTNER_SORTS = {
    "id": Partner.id,
    "name": Partner.name,
    "partner_type": Partner.partner_type,
    "updated_at": Partner.updated_at,
}

PARTNER_TEXT_LIMITS = {
    "partner_type": 32,
    "contact_name": 64,
    "phone": 64,
    "email": 128,
    "address": 255,
    "remark": 1000,
}

MEMBER_TEXT_LIMITS = {
    "position": 64,
    "phone": 64,
    "email": 128,
    "remark": 1000,
}


class PartnerIn(BaseModel):
    name: str | None = None
    partner_type: str | None = None
    contact_name: str | None = None
    phone: str | None = None
    email: str | None = None
    address: str | None = None
    remark: str | None = None


class PartnerMemberIn(BaseModel):
    name: str | None = None
    position: str | None = None
    phone: str | None = None
    email: str | None = None
    remark: str | None = None


class PartnerContractIn(BaseModel):
    project_name: str | None = None
    amount: float | None = None
    signed_date: date | None = None
    remark: str | None = None


def _admin(user: User) -> None:
    require_admin(user)


def _iso(value):
    return value.isoformat() if value else None


def _clean_text(value: str | None) -> str:
    return (value or "").strip()


def _check_email(value: str, label: str = "邮箱") -> None:
    if value and not EMAIL_RE.match(value):
        raise HTTPException(400, f"{label}格式不正确")


def _partner_or_404(db: Session, pid: int) -> Partner:
    partner = db.query(Partner).filter_by(id=pid).first()
    if not partner:
        raise HTTPException(404, "友商不存在")
    return partner


def _member_or_404(db: Session, pid: int, mid: int) -> PartnerMember:
    row = (
        db.query(PartnerMember)
        .filter(PartnerMember.id == mid, PartnerMember.partner_id == pid)
        .first()
    )
    if not row:
        raise HTTPException(404, "友商人员不存在")
    return row


def _contract_or_404(db: Session, pid: int, cid: int) -> PartnerContract:
    row = (
        db.query(PartnerContract)
        .filter(PartnerContract.id == cid, PartnerContract.partner_id == pid)
        .first()
    )
    if not row:
        raise HTTPException(404, "业绩合同不存在")
    return row


def _attachment_count(db: Session, pid: int) -> int:
    return (
        db.query(Attachment)
        .filter(
            Attachment.project_id.is_(None),
            Attachment.ref_type == "partner",
            Attachment.ref_id == pid,
        )
        .count()
    )


def _serialize(partner: Partner, db: Session, detail: bool = False) -> dict:
    body = {
        "id": partner.id,
        "name": partner.name or "",
        "partner_type": partner.partner_type or "",
        "contact_name": partner.contact_name or "",
        "phone": partner.phone or "",
        "email": partner.email or "",
        "address": partner.address or "",
        "remark": partner.remark or "",
        "attachment_count": _attachment_count(db, partner.id),
        "updated_at": iso(partner.updated_at),
        "created_at": iso(partner.created_at),
    }
    if detail:
        body["members"] = [_serialize_member(m) for m in (partner.members or [])]
        body["contracts"] = [_serialize_contract(c) for c in (partner.contracts or [])]
    else:
        body["member_count"] = len(partner.members or [])
        body["contract_count"] = len(partner.contracts or [])
    return body


def _serialize_member(m: PartnerMember) -> dict:
    return {
        "id": m.id,
        "partner_id": m.partner_id,
        "name": m.name or "",
        "position": m.position or "",
        "phone": m.phone or "",
        "email": m.email or "",
        "remark": m.remark or "",
        "created_at": iso(m.created_at),
    }


def _serialize_contract(c: PartnerContract) -> dict:
    return {
        "id": c.id,
        "partner_id": c.partner_id,
        "project_name": c.project_name or "",
        "amount": c.amount if c.amount is not None else 0,
        "signed_date": _iso(c.signed_date),
        "remark": c.remark or "",
        "created_at": iso(c.created_at),
    }


def _apply_partner_payload(partner: Partner, data: dict, actor_id: int) -> None:
    if "name" in data:
        name = _clean_text(data["name"])
        if not name:
            raise HTTPException(400, "友商名称不能为空")
        if len(name) > 128:
            raise HTTPException(400, "友商名称最多 128 个字符")
        partner.name = name
    for field, limit in PARTNER_TEXT_LIMITS.items():
        if field not in data:
            continue
        value = _clean_text(data[field])
        if len(value) > limit:
            raise HTTPException(400, f"{field} 最多 {limit} 个字符")
        setattr(partner, field, value)
    _check_email(partner.email or "")
    partner.updated_by = actor_id
    partner.updated_at = app_now()


def _apply_member_payload(member: PartnerMember, data: dict) -> None:
    if "name" in data:
        name = _clean_text(data["name"])
        if not name:
            raise HTTPException(400, "人员姓名不能为空")
        if len(name) > 64:
            raise HTTPException(400, "人员姓名最多 64 个字符")
        member.name = name
    for field, limit in MEMBER_TEXT_LIMITS.items():
        if field not in data:
            continue
        value = _clean_text(data[field])
        if len(value) > limit:
            raise HTTPException(400, f"{field} 最多 {limit} 个字符")
        setattr(member, field, value)
    _check_email(member.email or "")


def _apply_contract_payload(contract: PartnerContract, data: dict) -> None:
    if "project_name" in data:
        name = _clean_text(data["project_name"])
        if not name:
            raise HTTPException(400, "项目名称不能为空")
        if len(name) > 128:
            raise HTTPException(400, "项目名称最多 128 个字符")
        contract.project_name = name
    if "amount" in data:
        amount = data["amount"]
        if amount is None or not isinstance(amount, (int, float)) or not math.isfinite(amount):
            raise HTTPException(400, "合同金额须为有效数字")
        if amount < 0:
            raise HTTPException(400, "合同金额不能为负数")
        contract.amount = float(amount)
    if "signed_date" in data:
        contract.signed_date = data["signed_date"]
    if "remark" in data:
        remark = _clean_text(data["remark"])
        if len(remark) > 1000:
            raise HTTPException(400, "remark 最多 1000 个字符")
        contract.remark = remark


def _attachment(a: Attachment) -> dict:
    return {
        "id": a.id,
        "filename": a.filename,
        "size": a.size,
        "category": a.category or "",
        "category_label": ATTACHMENT_CATEGORY_LABELS.get(a.category or "", ""),
        "content_type": a.content_type or "",
        "uploaded_by": a.uploaded_by,
        "uploaded_at": iso(a.uploaded_at),
    }


# ============ 友商主数据 ============


@router.get("")
def list_partners(
    keyword: str = "",
    partner_type: str = "",
    sort: str = "-id",
    page: int = 1,
    size: int = DEFAULT_PAGE_SIZE,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """友商列表（统一分页信封）：keyword 匹配名称/联系人/电话，partner_type 等值筛选。"""
    _admin(user)
    q = db.query(Partner)
    if keyword:
        like = f"%{keyword.strip()}%"
        q = q.filter(
            or_(
                Partner.name.ilike(like),
                Partner.contact_name.ilike(like),
                Partner.phone.ilike(like),
            )
        )
    if partner_type:
        q = q.filter(Partner.partner_type == partner_type.strip())
    return paginate(
        q,
        page=page,
        size=size,
        allowed=PARTNER_SORTS,
        default_sort="-id",
        sort=sort,
        map_row=lambda row: _serialize(row, db),
    )


@router.post("")
def create_partner(
    body: PartnerIn,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """新建友商：名称必填且全局唯一。"""
    _admin(user)
    data = body.model_dump(exclude_unset=True)
    name = _clean_text(data.get("name"))
    if not name:
        raise HTTPException(400, "友商名称不能为空")
    if len(name) > 128:
        raise HTTPException(400, "友商名称最多 128 个字符")
    partner = Partner(
        name=name,
        created_by=user.id,
        updated_by=user.id,
    )
    db.add(partner)
    try:
        db.flush()
        _apply_partner_payload(partner, data, user.id)
        db.flush()
    except IntegrityError:
        db.rollback()
        raise HTTPException(400, "友商名称已存在")
    commit_audited(db, user.id, "create_partner", "partners", partner.id, partner.name)
    return _serialize(_partner_or_404(db, partner.id), db, detail=True)


@router.get("/{pid}")
def get_partner(
    pid: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)
):
    """友商详情：基本信息 + 人员 + 业绩合同 + 附件计数。"""
    _admin(user)
    return _serialize(_partner_or_404(db, pid), db, detail=True)


@router.patch("/{pid}")
def update_partner(
    pid: int,
    body: PartnerIn,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """更新友商基本信息（部分字段）。"""
    _admin(user)
    partner = _partner_or_404(db, pid)
    _apply_partner_payload(partner, body.model_dump(exclude_unset=True), user.id)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise HTTPException(400, "友商名称已存在")
    commit_audited(db, user.id, "update_partner", "partners", partner.id, partner.name)
    return _serialize(_partner_or_404(db, pid), db, detail=True)


@router.delete("/{pid}")
def delete_partner(
    pid: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)
):
    """删除友商：人员与业绩合同级联删除，附件正文先删、再删元数据。"""
    _admin(user)
    partner = _partner_or_404(db, pid)
    name = partner.name or ""
    attachments = (
        db.query(Attachment)
        .filter(
            Attachment.project_id.is_(None),
            Attachment.ref_type == "partner",
            Attachment.ref_id == pid,
        )
        .all()
    )
    # 先删正文、再删元数据：正文删不掉抛 502 并保留全部数据，避免孤儿对象
    for row in attachments:
        remove_attachment_blob(row)
        db.delete(row)
    db.delete(partner)
    db.flush()
    commit_audited(db, user.id, "delete_partner", "partners", pid, name)
    return {"ok": True}


# ============ 人员子表 ============


@router.get("/{pid}/members")
def list_members(
    pid: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)
):
    """单个友商下的人员列表（作用域内小集合，返回数组）。"""
    _admin(user)
    _partner_or_404(db, pid)
    rows = (
        db.query(PartnerMember)
        .filter(PartnerMember.partner_id == pid)
        .order_by(PartnerMember.id)
        .all()
    )
    return [_serialize_member(m) for m in rows]


@router.post("/{pid}/members")
def create_member(
    pid: int,
    body: PartnerMemberIn,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """新增友商人员：姓名必填。"""
    _admin(user)
    _partner_or_404(db, pid)
    data = body.model_dump(exclude_unset=True)
    if not _clean_text(data.get("name")):
        raise HTTPException(400, "人员姓名不能为空")
    member = PartnerMember(partner_id=pid, name=_clean_text(data["name"]))
    db.add(member)
    db.flush()
    _apply_member_payload(member, data)
    commit_audited(
        db, user.id, "create_partner_member", "partner_members", member.id, member.name
    )
    return _serialize_member(member)


@router.patch("/{pid}/members/{mid}")
def update_member(
    pid: int,
    mid: int,
    body: PartnerMemberIn,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """更新友商人员（部分字段）。"""
    _admin(user)
    _partner_or_404(db, pid)
    member = _member_or_404(db, pid, mid)
    _apply_member_payload(member, body.model_dump(exclude_unset=True))
    commit_audited(
        db, user.id, "update_partner_member", "partner_members", member.id, member.name
    )
    return _serialize_member(member)


@router.delete("/{pid}/members/{mid}")
def delete_member(
    pid: int,
    mid: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """删除友商人员。"""
    _admin(user)
    _partner_or_404(db, pid)
    member = _member_or_404(db, pid, mid)
    name = member.name or ""
    db.delete(member)
    db.flush()
    commit_audited(db, user.id, "delete_partner_member", "partner_members", mid, name)
    return {"ok": True}


# ============ 业绩合同子表 ============


@router.get("/{pid}/contracts")
def list_contracts(
    pid: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)
):
    """单个友商下的业绩合同列表（作用域内小集合，返回数组）。"""
    _admin(user)
    _partner_or_404(db, pid)
    rows = (
        db.query(PartnerContract)
        .filter(PartnerContract.partner_id == pid)
        .order_by(PartnerContract.id)
        .all()
    )
    return [_serialize_contract(c) for c in rows]


@router.post("/{pid}/contracts")
def create_contract(
    pid: int,
    body: PartnerContractIn,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """新增业绩合同：项目名必填，金额须为 ≥0 的有效数字。"""
    _admin(user)
    _partner_or_404(db, pid)
    data = body.model_dump(exclude_unset=True)
    if not _clean_text(data.get("project_name")):
        raise HTTPException(400, "项目名称不能为空")
    contract = PartnerContract(partner_id=pid, project_name=_clean_text(data["project_name"]))
    db.add(contract)
    db.flush()
    _apply_contract_payload(contract, data)
    commit_audited(
        db,
        user.id,
        "create_partner_contract",
        "partner_contracts",
        contract.id,
        contract.project_name,
    )
    return _serialize_contract(contract)


@router.patch("/{pid}/contracts/{cid}")
def update_contract(
    pid: int,
    cid: int,
    body: PartnerContractIn,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """更新业绩合同（部分字段）。"""
    _admin(user)
    _partner_or_404(db, pid)
    contract = _contract_or_404(db, pid, cid)
    _apply_contract_payload(contract, body.model_dump(exclude_unset=True))
    commit_audited(
        db,
        user.id,
        "update_partner_contract",
        "partner_contracts",
        contract.id,
        contract.project_name,
    )
    return _serialize_contract(contract)


@router.delete("/{pid}/contracts/{cid}")
def delete_contract(
    pid: int,
    cid: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """删除业绩合同。"""
    _admin(user)
    _partner_or_404(db, pid)
    contract = _contract_or_404(db, pid, cid)
    name = contract.project_name or ""
    db.delete(contract)
    db.flush()
    commit_audited(
        db, user.id, "delete_partner_contract", "partner_contracts", cid, name
    )
    return {"ok": True}


# ============ 资质证书及其他附件 ============


@router.get("/{pid}/attachments")
def list_attachments(
    pid: int,
    category: str = "",
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """友商附件列表（`ref_type='partner'`），可按分类过滤。"""
    _admin(user)
    _partner_or_404(db, pid)
    if category and category not in ATTACHMENT_CATEGORIES:
        raise HTTPException(400, "附件分类不支持")
    q = db.query(Attachment).filter(
        Attachment.project_id.is_(None),
        Attachment.ref_type == "partner",
        Attachment.ref_id == pid,
    )
    if category:
        q = q.filter(Attachment.category == category)
    rows = q.order_by(Attachment.id.desc()).all()
    return [_attachment(row) for row in rows]


@router.post("/{pid}/attachments")
def upload_attachment(
    pid: int,
    file: UploadFile = File(...),
    category: str = Form(...),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """上传友商资料：分类必填，扩展名白名单 + 体积上限与全站同一来源。"""
    _admin(user)
    _partner_or_404(db, pid)
    if category not in ATTACHMENT_CATEGORIES:
        raise HTTPException(400, "附件分类不支持")

    original = (
        Path((file.filename or "attachment").replace("\\", "/")).name or "attachment"
    )
    ext = Path(original).suffix.lower()
    if ext not in ALLOWED_EXT:
        raise HTTPException(400, f"仅允许 {sorted(ALLOWED_EXT)}")
    # 有界读取：超限在读完 limit+1 字节时就 400，不会把无界数据读进内存
    data = read_within_limit(file, MAX_SIZE)

    # 正文落位（本地磁盘 / R2）由 core.attachments 收口
    row = store_attachment(
        db,
        domain="partner",
        filename=original,
        content_type=file.content_type or "",
        data=data,
        project_id=None,
        ref_type="partner",
        ref_id=pid,
        category=category,
        uploaded_by=user.id,
    )
    commit_audited(
        db,
        user.id,
        "upload_partner_attachment",
        "attachments",
        row.id,
        f"{pid}:{category}:{original}",
    )
    return _attachment(row)


@router.get("/{pid}/attachments/{aid}/download")
def download_attachment(
    pid: int,
    aid: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """下载友商附件（下载动作写审计）。"""
    _admin(user)
    _partner_or_404(db, pid)
    row = (
        db.query(Attachment)
        .filter(
            Attachment.id == aid,
            Attachment.project_id.is_(None),
            Attachment.ref_type == "partner",
            Attachment.ref_id == pid,
        )
        .first()
    )
    if not row:
        raise HTTPException(404, "附件不存在")
    filename = row.filename
    write_audit(
        db,
        user.id,
        "download_partner_attachment",
        "attachments",
        row.id,
        f"{pid}:{filename}",
    )
    return attachment_response(row)


@router.delete("/{pid}/attachments/{aid}")
def delete_attachment(
    pid: int,
    aid: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """删除友商附件：先删正文、再删元数据。"""
    _admin(user)
    _partner_or_404(db, pid)
    row = (
        db.query(Attachment)
        .filter(
            Attachment.id == aid,
            Attachment.project_id.is_(None),
            Attachment.ref_type == "partner",
            Attachment.ref_id == pid,
        )
        .first()
    )
    if not row:
        raise HTTPException(404, "附件不存在")
    filename = row.filename
    # 先删正文、再删元数据：R2 删不掉时抛 502 并保留元数据，避免产生孤儿对象
    remove_attachment_blob(row)
    db.delete(row)
    db.flush()
    commit_audited(
        db,
        user.id,
        "delete_partner_attachment",
        "attachments",
        aid,
        f"{pid}:{filename}",
    )
    return {"ok": True}
