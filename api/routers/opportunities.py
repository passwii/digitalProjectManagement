"""商机管理：按项目台账的列表样式提供轻量 CRUD。"""

from datetime import date

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..core.audit import commit_audited
from ..core.database import get_db, parse_date
from ..core.deps import get_current_user
from ..core.paging import DEFAULT_PAGE_SIZE, paginate
from ..core.timeutil import app_now, app_today
from ..models import Opportunity, User

router = APIRouter(prefix="/opportunities", tags=["opportunities"])

OPPORTUNITY_SORTS = {
  "id": Opportunity.id,
  "code": Opportunity.code,
  "name": Opportunity.name,
  "client": Opportunity.client,
  "stage": Opportunity.stage,
  "budget_total": Opportunity.budget_total,
  "expected_close": Opportunity.expected_close,
  "created_at": Opportunity.created_at,
}
OPPORTUNITY_STAGES = {"new", "qualified", "proposal", "negotiation", "won", "lost"}


class OpportunityIn(BaseModel):
  code: str = ""
  name: str
  client: str = ""
  owner_id: int | None = None
  owner_name: str = ""
  budget_total: float = 0
  stage: str = "new"
  expected_close: date | None = None
  description: str = ""


def _code(value: str) -> str:
  return str(value or "").strip()


def _next_code(db: Session) -> str:
  prefix = f"OPP-{app_today().year}-"
  last = (
    db.query(Opportunity)
    .filter(Opportunity.code.like(prefix + "%"))
    .order_by(Opportunity.code.desc())
    .first()
  )
  try:
    number = int(last.code.rsplit("-", 1)[1]) + 1 if last else 1
  except (ValueError, AttributeError):
    number = 1
  return f"{prefix}{number:04d}"


def _owner(db: Session, owner_id: int | None, owner_name: str, fallback: User | None = None):
  name = str(owner_name or "").strip()
  if owner_id:
    user = db.query(User).filter_by(id=owner_id).first()
    if not user:
      raise HTTPException(400, "商机负责人不存在")
    return user.id, name or user.real_name or user.username
  if name:
    user = db.query(User).filter(User.real_name == name).first()
    if user:
      return user.id, name
  if fallback:
    return fallback.id, name or fallback.real_name or fallback.username
  return None, name


def _o(item: Opportunity) -> dict:
  return {
    "id": item.id,
    "code": item.code,
    "name": item.name,
    "client": item.client or "",
    "owner_id": item.owner_id,
    "owner_name": item.owner_name or "",
    "budget_total": item.budget_total or 0,
    "stage": item.stage or "new",
    "expected_close": item.expected_close.isoformat() if item.expected_close else None,
    "description": item.description or "",
  }


def _get(db: Session, oid: int) -> Opportunity:
  item = (
    db.query(Opportunity)
    .filter(Opportunity.id == oid, Opportunity.deleted_at.is_(None))
    .first()
  )
  if not item:
    raise HTTPException(404, "商机不存在")
  return item


@router.get("")
def list_opportunities(
  keyword: str = "",
  stage: str = "",
  owner: str = "",
  sort: str = "-id",
  page: int = 1,
  size: int = DEFAULT_PAGE_SIZE,
  db: Session = Depends(get_db),
  user: User = Depends(get_current_user),
):
  q = db.query(Opportunity).filter(Opportunity.deleted_at.is_(None))
  if keyword.strip():
    like = f"%{keyword.strip()}%"
    q = q.filter(
      or_(
        Opportunity.name.ilike(like),
        Opportunity.code.ilike(like),
        Opportunity.client.ilike(like),
        Opportunity.description.ilike(like),
      )
    )
  if stage:
    q = q.filter(Opportunity.stage == stage)
  if owner.strip():
    q = q.filter(Opportunity.owner_name == owner.strip())
  return paginate(
    q,
    page=page,
    size=size,
    allowed=OPPORTUNITY_SORTS,
    default_sort="-id",
    sort=sort,
    map_row=_o,
  )


@router.post("")
def create_opportunity(
  body: OpportunityIn,
  db: Session = Depends(get_db),
  user: User = Depends(get_current_user),
):
  name = str(body.name or "").strip()
  if not name:
    raise HTTPException(400, "商机名称必填")
  code = _code(body.code)
  if len(code) > 32:
    raise HTTPException(400, "商机编号最多 32 个字符")
  if code and db.query(Opportunity).filter_by(code=code).first():
    raise HTTPException(400, "商机编号已存在")
  if db.query(Opportunity).filter(Opportunity.name == name, Opportunity.deleted_at.is_(None)).first():
    raise HTTPException(400, "商机名称已存在")
  if body.stage not in OPPORTUNITY_STAGES:
    raise HTTPException(400, "商机阶段不合法")
  if body.budget_total < 0:
    raise HTTPException(400, "预计金额不能为负数")
  owner_id, owner_name = _owner(db, body.owner_id, body.owner_name, user)
  item = Opportunity(
    code=code or _next_code(db),
    name=name,
    client=str(body.client or "").strip(),
    owner_id=owner_id,
    owner_name=owner_name,
    budget_total=body.budget_total,
    stage=body.stage,
    expected_close=body.expected_close,
    description=body.description or "",
    created_by=user.id,
  )
  db.add(item)
  try:
    db.flush()
    commit_audited(db, user.id, "create_opportunity", "opportunities", item.id, item.code)
  except IntegrityError:
    db.rollback()
    raise HTTPException(400, "商机编号已存在")
  return _o(item)


@router.get("/{oid}")
def get_opportunity(oid: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
  return _o(_get(db, oid))


@router.patch("/{oid}")
def update_opportunity(
  oid: int,
  body: dict,
  db: Session = Depends(get_db),
  user: User = Depends(get_current_user),
):
  item = _get(db, oid)
  allowed = {
    "code", "name", "client", "owner_id", "owner_name", "budget_total",
    "stage", "expected_close", "description",
  }
  for field, value in body.items():
    if field not in allowed:
      continue
    if field == "code":
      value = _code(value)
      if not value or len(value) > 32:
        raise HTTPException(400, "商机编号必填且最多 32 个字符")
      if db.query(Opportunity).filter(Opportunity.code == value, Opportunity.id != oid).first():
        raise HTTPException(400, "商机编号已存在")
    if field == "name":
      value = str(value or "").strip()
      if not value:
        raise HTTPException(400, "商机名称必填")
      if db.query(Opportunity).filter(Opportunity.name == value, Opportunity.id != oid, Opportunity.deleted_at.is_(None)).first():
        raise HTTPException(400, "商机名称已存在")
    if field == "stage" and value not in OPPORTUNITY_STAGES:
      raise HTTPException(400, "商机阶段不合法")
    if field == "budget_total":
      try:
        value = float(value)
      except (TypeError, ValueError):
        raise HTTPException(400, "预计金额必须是数字")
      if value < 0:
        raise HTTPException(400, "预计金额不能为负数")
    if field == "expected_close":
      try:
        value = parse_date(value) if value else None
      except (TypeError, ValueError):
        raise HTTPException(400, "预计签约日期格式不正确")
    if field == "owner_id":
      owner_id, owner_name = _owner(db, int(value) if value else None, body.get("owner_name", item.owner_name), user)
      item.owner_id, item.owner_name = owner_id, owner_name
      continue
    if field == "owner_name":
      item.owner_id, value = _owner(db, body.get("owner_id", item.owner_id), str(value or ""), user)
    setattr(item, field, value)
  item.updated_at = app_now()
  commit_audited(db, user.id, "update_opportunity", "opportunities", item.id, item.code)
  return _o(item)


@router.delete("/{oid}")
def delete_opportunity(
  oid: int,
  db: Session = Depends(get_db),
  user: User = Depends(get_current_user),
):
  item = _get(db, oid)
  item.deleted_at = app_now()
  commit_audited(db, user.id, "delete_opportunity", "opportunities", item.id, item.code)
  return {"ok": True}
