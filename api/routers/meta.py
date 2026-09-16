"""元数据：供任意登录用户拉取选项（用户/部门/字典），用于表单下拉与 id→名称映射。

非管理员也能读，仅返回 id/名称等非敏感字段。
管理与审批边界见 `GET /meta/me/menus`：管理员入口只对 admin 返回，供前端做单一入口控制。
"""
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from ..core.database import get_db
from ..core.deps import get_current_user
from ..models import Department, Dict, User

router = APIRouter(prefix="/meta", tags=["meta"])


@router.get("/users")
def users(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    rows = db.query(User).order_by(User.id).all()
    return [{"id": u.id, "username": u.username, "real_name": u.real_name or u.username,
             "dept_id": u.dept_id, "status": u.status,
             "roles": [r.code for r in u.roles]} for u in rows]


@router.get("/depts")
def depts(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    return [{"id": d.id, "name": d.name, "parent_id": d.parent_id}
            for d in db.query(Department).order_by(Department.id).all()]


@router.get("/dicts")
def dicts(type: str = "", db: Session = Depends(get_db),
          user: User = Depends(get_current_user)):
    q = db.query(Dict).order_by(Dict.sort, Dict.id)
    if type:
        q = q.filter_by(type=type)
    return [{"type": d.type, "code": d.code, "label": d.label} for d in q.all()]


@router.get("/me/menus")
def menus(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """按角色返回可见菜单，供前端做单一入口控制（避免硬编码多套角色判断）。

    契约（Stage 1 收敛）：
      · 管理员 = 唯一管理与审批角色 → 额外拿到「审批中心」「系统管理」入口，且 can_approve=true。
      · 非管理员不返回管理与审批入口；直接请求管理与审批接口会稳定拿到 403。
      · role 字段保留为未来扩展结构；readonly 恒为 false（高层只读规则已取消）。
    另附演示数据开关状态：所有登录用户都需知道当前是否展示演示数据，仅管理员可切换。
    """
    from ..core.rbac import ROLE_ADMIN, can_approve, demo_data_on, role_codes
    codes = role_codes(user)
    admin = ROLE_ADMIN in codes
    items = [
        {"key": "projects", "label": "项目台账", "href": "/projects"},
        {"key": "progress", "label": "进度跟进", "href": "/progress"},
        {"key": "costs", "label": "成本支出", "href": "/costs"},
        {"key": "reports", "label": "报表", "href": "/reports"},
    ]
    if admin:
        items.append({"key": "approvals", "label": "审批中心", "href": "/approvals"})
        items.append({"key": "admin", "label": "系统管理", "href": "/admin"})
    return {"roles": sorted(codes), "is_admin": admin, "can_approve": can_approve(user),
            "menus": items, "readonly": False,
            "demo_on": demo_data_on(db), "can_toggle_demo": admin}
