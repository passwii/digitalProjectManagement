"""系统管理（用户/角色/字典/参数/日志）：管理与审批面，admin 专属。

权限契约（Stage 1 收敛）：所有接口统一走 core.rbac.require_admin，非管理员恒定 403。
"""
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

from ..core.audit import commit_audited, write_audit
from ..core.database import get_db
from ..core.deps import get_current_user
from ..core.paging import DEFAULT_PAGE_SIZE, paginate
from ..core.rbac import require_admin
from ..core.security import hash_password
from ..models import AuditLog, Dict, Project, Role, SysParam, User, UserRole

router = APIRouter(prefix="/admin", tags=["admin"])

# 统一门禁：定义在 core.rbac（唯一管理员判定来源），此处仅做别名以保持调用点简短
_admin = require_admin

# 排序白名单（Stage 3A）：字段名 → ORM 列
USER_SORTS = {
    "id": User.id, "username": User.username, "real_name": User.real_name,
    "status": User.status, "dept_id": User.dept_id, "created_at": User.created_at,
}
LOG_SORTS = {
    "id": AuditLog.id, "user_id": AuditLog.user_id, "action": AuditLog.action,
    "resource": AuditLog.resource, "created_at": AuditLog.created_at,
}


def _u(u: User):
    return {"id": u.id, "username": u.username, "real_name": u.real_name,
            "status": u.status, "dept_id": u.dept_id,
            "roles": [{"code": r.code, "name": r.name} for r in u.roles]}


class UserIn(BaseModel):
    username: str
    password: str = "123456"
    real_name: str = ""
    dept_id: int | None = None
    roles: list[str] = []


@router.get("/users")
def list_users(keyword: str = "", status: str = "", dept_id: int = 0, sort: str = "id",
               page: int = 1, size: int = DEFAULT_PAGE_SIZE,
               db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """用户列表（仅管理员）：统一分页信封 + 关键词/部门/状态筛选 + 排序白名单。"""
    _admin(user)
    q = db.query(User)
    if keyword:
        like = f"%{keyword}%"
        q = q.filter((User.username.like(like)) | (User.real_name.like(like)))
    if status:
        q = q.filter(User.status == status)
    if dept_id:
        q = q.filter(User.dept_id == dept_id)
    return paginate(q, page=page, size=size, allowed=USER_SORTS,
                    default_sort="id", sort=sort, map_row=_u)


@router.post("/users")
def create_user(body: UserIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    _admin(user)
    if db.query(User).filter_by(username=body.username).first():
        raise HTTPException(400, "用户名已存在")
    u = User(username=body.username, pwd_hash=hash_password(body.password),
             real_name=body.real_name, dept_id=body.dept_id,
             created_at=datetime.now(timezone.utc))
    db.add(u)
    db.flush()
    for code in body.roles:
        r = db.query(Role).filter_by(code=code).first()
        if r:
            db.add(UserRole(user_id=u.id, role_id=r.id))
    commit_audited(db, user.id, "create_user", "users", u.id, body.username)
    return _u(db.query(User).filter_by(id=u.id).first())


@router.patch("/users/{uid}")
def update_user(uid: int, body: dict, db: Session = Depends(get_db),
                user: User = Depends(get_current_user)):
    _admin(user)
    u = db.query(User).filter_by(id=uid).first()
    if not u:
        raise HTTPException(404, "用户不存在")
    for f in ("real_name", "status", "dept_id"):
        if f in body:
            setattr(u, f, body[f])
    if body.get("password"):
        u.pwd_hash = hash_password(body["password"])
        u.must_change_pwd = False
    if "roles" in body:
        db.query(UserRole).filter_by(user_id=uid).delete()
        for code in body["roles"]:
            r = db.query(Role).filter_by(code=code).first()
            if r:
                db.add(UserRole(user_id=uid, role_id=r.id))
    if body.get("status") == "active":
        u.failed_count, u.locked_until = 0, None
    commit_audited(db, user.id, "update_user", "users", uid, str(sorted(body.keys())))
    return _u(u)


@router.get("/demo-data")
def get_demo_data(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """演示数据开关状态 + 数据量概览（仅管理员）。"""
    _admin(user)
    from ..core.rbac import demo_data_on

    total = db.query(func.count(Project.id)).filter(Project.is_demo.is_(True)).scalar() or 0
    hidden_deleted = db.query(func.count(Project.id)).filter(
        Project.is_demo.is_(True), Project.deleted_at.isnot(None)).scalar() or 0
    return {"on": demo_data_on(db), "demo_projects": int(total),
            "demo_projects_deleted": int(hidden_deleted)}


@router.put("/demo-data")
def set_demo_data_flag(body: dict, db: Session = Depends(get_db),
                       user: User = Depends(get_current_user)):
    """打开/关闭演示数据展示（仅管理员，全局生效）。"""
    _admin(user)
    from ..core.rbac import demo_data_on, set_demo_data

    on = bool(body.get("on", False))
    set_demo_data(db, on)
    commit_audited(db, user.id, "toggle_demo_data", "sys_params", 0,
                "demo_data_on=1" if on else "demo_data_on=0")
    return {"on": demo_data_on(db)}


@router.get("/roles")
def list_roles(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    _admin(user)
    return [{"id": r.id, "code": r.code, "name": r.name} for r in db.query(Role).all()]


@router.get("/dicts")
def list_dicts(type: str = "", db: Session = Depends(get_db),
               user: User = Depends(get_current_user)):
    _admin(user)
    q = db.query(Dict).order_by(Dict.type, Dict.sort)
    if type:
        q = q.filter_by(type=type)
    return [{"id": d.id, "type": d.type, "code": d.code, "label": d.label} for d in q.all()]


@router.post("/dicts")
def create_dict(body: dict, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    _admin(user)
    d = Dict(type=body["type"], code=body["code"], label=body.get("label", ""), sort=body.get("sort", 0))
    db.add(d)
    db.flush()
    commit_audited(db, user.id, "create_dict", "dicts", d.id, f"{body['type']}:{body['code']}")
    return {"id": d.id}


@router.get("/params")
def list_params(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    _admin(user)
    return {p.key: p.value for p in db.query(SysParam).all()}


@router.put("/params")
def set_params(body: dict, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    _admin(user)
    for k, v in body.items():
        p = db.query(SysParam).filter_by(key=k).first()
        if p:
            p.value = str(v)
        else:
            db.add(SysParam(key=k, value=str(v)))
    commit_audited(db, user.id, "set_params", "sys_params", "", str(sorted(body.keys())))
    return {"ok": True}


@router.get("/logs/export")
def export_logs(action: str = "", user_id: int = 0, limit: int = 5000,
                db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """审计日志导出 Excel（仅管理员）。"""
    import io

    from fastapi.responses import StreamingResponse
    from openpyxl import Workbook

    _admin(user)
    q = db.query(AuditLog).order_by(AuditLog.id.desc())
    if action:
        q = q.filter_by(action=action)
    if user_id:
        q = q.filter_by(user_id=user_id)
    rows = q.limit(min(max(limit, 1), 20000)).all()

    wb = Workbook()
    ws = wb.active
    ws.append(["时间", "操作人ID", "动作", "资源", "资源ID", "详情", "IP"])
    for l in rows:
        ws.append([l.created_at.isoformat() if l.created_at else "", l.user_id, l.action,
                   l.resource, l.resource_id, l.detail, l.ip])
    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    write_audit(db, user.id, "export_logs", "audit_logs", "", f"{len(rows)} rows")
    return StreamingResponse(
        buf, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": "attachment; filename=audit_logs.xlsx"})


@router.get("/logs")
def list_logs(action: str = "", user_id: int = 0, sort: str = "-id",
              page: int = 1, size: int = DEFAULT_PAGE_SIZE,
              db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """审计日志列表（仅管理员）：统一分页信封（默认 `-id` 最新在前）+ 排序白名单。"""
    _admin(user)
    q = db.query(AuditLog)
    if action:
        q = q.filter(AuditLog.action == action)
    if user_id:
        q = q.filter(AuditLog.user_id == user_id)

    def _log(l: AuditLog):
        return {"id": l.id, "user_id": l.user_id, "action": l.action, "resource": l.resource,
                "resource_id": l.resource_id, "detail": l.detail, "ip": l.ip,
                "created_at": l.created_at.isoformat() if l.created_at else None}

    return paginate(q, page=page, size=size, allowed=LOG_SORTS,
                    default_sort="-id", sort=sort, map_row=_log)
