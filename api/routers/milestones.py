"""Stage 2：里程碑（到期前 3 天预警/逾期标红/填实际日关闭）。"""
from datetime import date

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..core.audit import write_audit
from ..core.database import get_db, parse_date
from ..core.deps import get_current_user
from ..core.rbac import check_project_access
from ..models import Milestone, Project, SysParam, User

router = APIRouter(prefix="/milestones", tags=["milestones"])


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
def list_milestones(project_id: int = 0, db: Session = Depends(get_db),
                    user: User = Depends(get_current_user)):
    q = db.query(Milestone).order_by(Milestone.plan_date)
    if project_id:
        p = db.query(Project).filter_by(id=project_id).first()
        if not p:
            raise HTTPException(404, "项目不存在")
        check_project_access(user, p)
        q = q.filter_by(project_id=project_id)
    wd = _warn_days(db)
    return [_m(m, wd) for m in q.all()]


@router.post("")
def create_milestone(body: MilestoneIn, db: Session = Depends(get_db),
                     user: User = Depends(get_current_user)):
    p = db.query(Project).filter_by(id=body.project_id).first()
    if not p:
        raise HTTPException(404, "项目不存在")
    check_project_access(user, p, write=True)
    m = Milestone(project_id=body.project_id, name=body.name,
                  plan_date=body.plan_date, owner_id=body.owner_id or user.id)
    db.add(m)
    db.commit()
    write_audit(db, user.id, "create_milestone", "milestones", m.id, body.name)
    return _m(m, _warn_days(db))


@router.patch("/{mid}")
def update_milestone(mid: int, body: dict, db: Session = Depends(get_db),
                     user: User = Depends(get_current_user)):
    m = db.query(Milestone).filter_by(id=mid).first()
    if not m:
        raise HTTPException(404, "里程碑不存在")
    p = db.query(Project).filter_by(id=m.project_id).first()
    check_project_access(user, p, write=True)
    for f in ("name", "plan_date", "owner_id"):
        if f in body:
            v = body[f]
            if f == "plan_date":
                v = parse_date(v)
            setattr(m, f, v)
    if "actual_date" in body:  # 填实际日即关闭
        m.actual_date = parse_date(body["actual_date"])
        m.status = "closed" if body["actual_date"] else "open"
    db.commit()
    write_audit(db, user.id, "update_milestone", "milestones", mid, str(list(body.keys())))
    return _m(m, _warn_days(db))


@router.delete("/{mid}")
def delete_milestone(mid: int, db: Session = Depends(get_db),
                     user: User = Depends(get_current_user)):
    m = db.query(Milestone).filter_by(id=mid).first()
    if not m:
        raise HTTPException(404, "里程碑不存在")
    p = db.query(Project).filter_by(id=m.project_id).first()
    check_project_access(user, p, write=True)
    db.delete(m)
    db.commit()
    return {"ok": True}
