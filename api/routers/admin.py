"""系统管理（用户/角色/字典/参数/日志）：系统管理模块面。

权限契约（Stage 5）：所有接口统一走 core.rbac.require_module(user, "admin")，
未分配「系统管理」模块的账号恒定 403；管理员天然拥有全部模块。
"""
import re

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

from ..core.audit import commit_audited, write_audit
from ..core.database import get_db
from ..core.deps import get_current_user
from ..core.paging import DEFAULT_PAGE_SIZE, paginate
from ..core.rbac import (
    ALL_MODULES,
    MODULE_ADMIN,
    MODULE_CATALOG,
    effective_modules,
    require_module,
)
from ..core.security import hash_password
from ..core.timeutil import app_now, iso
from ..models import (
    AuditLog,
    ContactProfile,
    Dict,
    Project,
    Role,
    SysParam,
    User,
    UserModule,
    UserRole,
)

router = APIRouter(prefix="/admin", tags=["admin"])
PHONE_RE = re.compile(r"^1\d{10}$")

# 统一门禁：系统管理模块（管理员天然拥有；也可由管理员分配给其他用户）
def _admin(user: User) -> None:
    require_module(user, MODULE_ADMIN)

# 排序白名单（Stage 3A）：字段名 → ORM 列
USER_SORTS = {
    "id": User.id, "username": User.username, "real_name": User.real_name,
    "status": User.status, "dept_id": User.dept_id, "created_at": User.created_at,
}
LOG_SORTS = {
    "id": AuditLog.id, "user_id": AuditLog.user_id, "action": AuditLog.action,
    "resource": AuditLog.resource, "created_at": AuditLog.created_at,
}


def _operator_name(user_id: int | None, account: User | None = None) -> str:
    """返回审计日志中稳定、可读且可追溯的操作人展示值。

    审计记录只保存 user_id，不能把姓名快照写回历史记录；读取时优先使用
    当前账号姓名，其次账号，最后保留原始 ID。用户已删除或登录失败没有账号
    记录时也返回明确的可读兜底，而不是让前端自行拼接展示文案。
    """
    if account is not None:
        real_name = str(account.real_name or "").strip()
        if real_name:
            return real_name
        username = str(account.username or "").strip()
        if username:
            return username
    return f"用户#{user_id}" if user_id is not None else "未知用户"


def _u(u: User):
    return {"id": u.id, "username": u.username, "real_name": u.real_name,
            "status": u.status, "dept_id": u.dept_id,
            "roles": [{"code": r.code, "name": r.name} for r in u.roles],
            "modules": _sorted_modules(u)}


def _sorted_modules(u: User) -> list[str]:
    """按模块目录顺序回带生效模块，前端弹窗直接回填当前勾选。"""
    effective = effective_modules(u)
    return [key for key in ALL_MODULES if key in effective]


class UserIn(BaseModel):
    username: str
    password: str = "admin123456"
    real_name: str = ""
    dept_id: int | None = None
    roles: list[str] = []
    modules: list[str] | None = None


def _apply_modules(db: Session, uid: int, modules: list[str]) -> None:
    """整表覆盖式写入用户模块分配，并把用户标记为「已显式分配」。

    只接受模块目录内取值（去重、忽略非法值）；空列表表示显式不分配任何模块。
    """
    wanted = [m for m in dict.fromkeys(modules) if m in ALL_MODULES]
    db.query(UserModule).filter_by(user_id=uid).delete()
    for module in wanted:
        db.add(UserModule(user_id=uid, module=module))
    account = db.query(User).filter_by(id=uid).first()
    if account is not None:
        account.modules_assigned = True


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
    username = str(body.username or "").strip()
    if not PHONE_RE.match(username):
        raise HTTPException(400, "登录账号须为 11 位手机号")
    password = body.password or "admin123456"
    if len(password) < 8 or not any(c.isalpha() for c in password) or not any(c.isdigit() for c in password):
        raise HTTPException(400, "初始密码至少 8 位且需同时包含字母与数字")
    if db.query(User).filter_by(username=username).first():
        raise HTTPException(400, "手机号已存在")
    u = User(username=username, pwd_hash=hash_password(password),
             real_name=body.real_name, dept_id=body.dept_id,
             must_change_pwd=True,
             created_at=app_now())
    db.add(u)
    db.flush()
    contact = db.query(ContactProfile).filter(
        ContactProfile.user_id.is_(None),
        ContactProfile.mobile == username,
    ).first()
    if contact:
        contact.user_id = u.id
        contact.name = contact.name or body.real_name or username
        contact.dept_id = contact.dept_id or body.dept_id
        contact.updated_by = user.id
    else:
        db.add(ContactProfile(
            user_id=u.id,
            name=body.real_name or username,
            mobile=username,
            dept_id=body.dept_id,
            employment_type="正式",
            employment_status="active",
            updated_by=user.id,
        ))
    for code in body.roles:
        r = db.query(Role).filter_by(code=code).first()
        if r:
            db.add(UserRole(user_id=u.id, role_id=r.id))
    if body.modules is not None:
        _apply_modules(db, u.id, body.modules)
    commit_audited(db, user.id, "create_user", "users", u.id, username)
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
        u.must_change_pwd = True
    if "roles" in body:
        db.query(UserRole).filter_by(user_id=uid).delete()
        for code in body["roles"]:
            r = db.query(Role).filter_by(code=code).first()
            if r:
                db.add(UserRole(user_id=uid, role_id=r.id))
    if "modules" in body and isinstance(body["modules"], list):
        _apply_modules(db, uid, [str(m) for m in body["modules"]])
    if body.get("status") == "active":
        u.failed_count, u.locked_until = 0, None
    contact = db.query(ContactProfile).filter_by(user_id=uid).first()
    if contact:
        contact.name = u.real_name or u.username
        contact.mobile = contact.mobile or u.username
        contact.dept_id = u.dept_id
        contact.updated_by = user.id
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


@router.get("/modules")
def list_modules(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """功能模块目录（仅系统管理模块可见）：供用户弹窗渲染可分配模块与排序。"""
    _admin(user)
    return [{"key": key, "label": label, "href": href}
            for key, label, href in MODULE_CATALOG]


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
    user_ids = {l.user_id for l in rows if l.user_id is not None}
    accounts = {}
    if user_ids:
        accounts = {
            account.id: account
            for account in db.query(User).filter(User.id.in_(user_ids)).all()
        }

    wb = Workbook()
    ws = wb.active
    ws.append(["时间", "操作人名称", "操作人ID", "动作", "资源", "资源ID", "详情", "IP"])
    for l in rows:
        ws.append([iso(l.created_at) if l.created_at else "",
                   _operator_name(l.user_id, accounts.get(l.user_id)), l.user_id,
                   l.action, l.resource, l.resource_id, l.detail, l.ip])
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
    # 外连接保证历史记录在账号已删除时仍可返回；姓名为空时由
    # _operator_name 依次回落到账号和原始 ID。
    q = db.query(AuditLog, User).outerjoin(User, AuditLog.user_id == User.id)
    if action:
        q = q.filter(AuditLog.action == action)
    if user_id:
        q = q.filter(AuditLog.user_id == user_id)

    def _log(row):
        log_row, account = row
        return {"id": log_row.id, "user_id": log_row.user_id,
                "operator_name": _operator_name(log_row.user_id, account),
                "action": log_row.action, "resource": log_row.resource,
                "resource_id": log_row.resource_id, "detail": log_row.detail, "ip": log_row.ip,
                "created_at": iso(log_row.created_at)}

    return paginate(q, page=page, size=size, allowed=LOG_SORTS,
                    default_sort="-id", sort=sort, map_row=_log)
