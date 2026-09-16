"""Stage 2：里程碑（到期前 3 天预警/逾期标红/填实际日关闭）。"""
from datetime import date

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..core.audit import commit_audited
from ..core.database import get_db, parse_date
from ..core.deps import get_current_user
from ..core.paging import DEFAULT_PAGE_SIZE, paginate
from ..core.rbac import get_active_project, scope_child_query
from ..models import Milestone, SysParam, User

router = APIRouter(prefix="/milestones", tags=["milestones"])

# 排序白名单（Stage 3A）：字段名 → ORM 列
MILESTONE_SORTS = {
    "id": Milestone.id, "project_id": Milestone.project_id,
    "name": Milestone.name, "plan_date": Milestone.plan_date,
    "actual_date": Milestone.actual_date, "status": Milestone.status,
}


def _m(m: Milestone, warn_days: int = 3):
    overdue = bool(m.plan_date and not m.actual_date and m.plan_date < date.today())
    near = bool(m.plan_date and not m.actual_date and
                0 <= (m.plan_date - date.today()).days <= warn_days)
    return {"id": m.id, "project_id": m.project_id, "name": m.name,
            "plan_date": m.plan_date.isoformat() if m.plan_date else None,
            "actual_date": m.actual_date.isoformat() if m.actual_date else None,
            "owner_id": m.owner_id, "status": m.status,
            "overdue": overdue, "near": near}


def _warn_days(db: Session) -> int:
    p = db.query(SysParam).filter_by(key="milestone_warn_days").first()
    return int(p.value) if p else 3


class MilestoneIn(BaseModel):
    project_id: int
    name: str
    plan_date: date | None = None
    owner_id: int | None = None


@router.get("")
def list_milestones(project_id: int = 0, status: str = "", sort: str = "plan_date",
                    page: int = 1, size: int = DEFAULT_PAGE_SIZE,
                    db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """里程碑列表：统一分页信封（默认按 `plan_date` 升序，便于看板/甘特排序）。

    指定 project_id 时按该项目鉴权；否则只返回「可见 + 未软删除」项目的里程碑（下推 SQL）。
    """
    q = db.query(Milestone)
    if project_id:
        get_active_project(db, project_id, user)
        q = q.filter(Milestone.project_id == project_id)
    else:
        q = scope_child_query(q, Milestone, db, user)
    if status:
        q = q.filter(Milestone.status == status)
    wd = _warn_days(db)
    return paginate(q, page=page, size=size, allowed=MILESTONE_SORTS,
                    default_sort="plan_date", sort=sort,
                    map_row=lambda m: _m(m, wd))


@router.post("")
def create_milestone(body: MilestoneIn, db: Session = Depends(get_db),
                     user: User = Depends(get_current_user)):
    get_active_project(db, body.project_id, user, write=True)
    m = Milestone(project_id=body.project_id, name=body.name,
                  plan_date=body.plan_date, owner_id=body.owner_id or user.id)
    db.add(m)
    db.flush()
    commit_audited(db, user.id, "create_milestone", "milestones", m.id, body.name)
    return _m(m, _warn_days(db))


@router.patch("/{mid}")
def update_milestone(mid: int, body: dict, db: Session = Depends(get_db),
                     user: User = Depends(get_current_user)):
    m = db.query(Milestone).filter_by(id=mid).first()
    if not m:
        raise HTTPException(404, "里程碑不存在")
    get_active_project(db, m.project_id, user, write=True)
    for f in ("name", "plan_date", "owner_id"):
        if f in body:
            v = body[f]
            if f == "plan_date":
                v = parse_date(v)
            setattr(m, f, v)
    if "actual_date" in body:  # 填实际日即关闭
        m.actual_date = parse_date(body["actual_date"])
        m.status = "closed" if body["actual_date"] else "open"
    commit_audited(db, user.id, "update_milestone", "milestones", mid, str(list(body.keys())))
    return _m(m, _warn_days(db))


@router.delete("/{mid}")
def delete_milestone(mid: int, db: Session = Depends(get_db),
                     user: User = Depends(get_current_user)):
    m = db.query(Milestone).filter_by(id=mid).first()
    if not m:
        raise HTTPException(404, "里程碑不存在")
    get_active_project(db, m.project_id, user, write=True)
    db.delete(m)
    db.flush()
    commit_audited(db, user.id, "delete_milestone", "milestones", mid, m.name)
    return {"ok": True}
