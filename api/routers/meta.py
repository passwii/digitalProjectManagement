"""元数据：供任意登录用户拉取选项（用户/部门/字典），用于表单下拉与 id→名称映射。

非管理员也能读，仅返回 id/名称等非敏感字段。
管理与审批边界见 `GET /meta/me/menus`：管理员入口只对 admin 返回，供前端做单一入口控制。

查询边界（Stage 3A）：字典类接口（`/meta/users`、`/meta/depts`、`/meta/dicts`）是「全量小字段映射」用
（前端一次预取后本地映射 id→名称），响应有服务端硬上限 `META_MAX_ROWS`，不会无界放大；
需要搜索式分页（如人员选择器）时用 `GET /meta/users/search`。
"""
from fastapi import APIRouter, Depends
from sqlalchemy import or_
from sqlalchemy.orm import Session

from ..core.database import get_db
from ..core.deps import get_current_user
from ..core.paging import DEFAULT_PAGE_SIZE, paginate
from ..models import AccountBook, AccountBookMember, Department, Dict, User

router = APIRouter(prefix="/meta", tags=["meta"])

# 字典类接口的服务端硬上限：即使前端不传分页参数，响应也是有界的
META_MAX_ROWS = 500

# 排序白名单（Stage 3A）
META_USER_SORTS = {"id": User.id, "username": User.username,
                  "real_name": User.real_name, "dept_id": User.dept_id,
                  "status": User.status}


def _u(u: User):
    return {"id": u.id, "username": u.username, "real_name": u.real_name or u.username,
            "dept_id": u.dept_id, "status": u.status,
            "roles": [r.code for r in u.roles]}


def _user_query(db: Session, keyword: str = "", dept_id: int = 0, status: str = "",
                ids: str = ""):
    """人员查询基座：`/meta/users` 与 `/meta/users/search` 共用同一套筛选语义。"""
    q = db.query(User)
    if keyword:
        like = f"%{keyword}%"
        q = q.filter(or_(User.username.like(like), User.real_name.like(like)))
    if dept_id:
        q = q.filter(User.dept_id == dept_id)
    if status:
        q = q.filter(User.status == status)
    if ids:
        wanted: list[int] = []
        for token in ids.split(","):
            try:
                wanted.append(int(token.strip()))
            except (TypeError, ValueError):
                continue   # 非法 id 片段直接忽略（如 “²” 这类 isdigit 为真但 int() 失败的值）
        q = q.filter(User.id.in_(wanted or [0]))
    return q


@router.get("/users")
def users(keyword: str = "", dept_id: int = 0, status: str = "", ids: str = "",
          db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """人员字典（最小字段）：带服务端硬上限，超出请用 `/meta/users/search` 分页搜索。

    `keyword` 匹配账号/姓名，`dept_id`、`status` 等值筛选，`ids` 逗号分隔按 id 批量取（供 id→名称映射）。
    """
    rows = _user_query(db, keyword, dept_id, status, ids).order_by(User.id).limit(META_MAX_ROWS).all()
    return [_u(u) for u in rows]


@router.get("/users/search")
def search_users(keyword: str = "", dept_id: int = 0, status: str = "",
                 sort: str = "id", page: int = 1, size: int = DEFAULT_PAGE_SIZE,
                 db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """人员搜索（分页信封）：供人员选择器搜索式分页，不再依赖 `?size=100` 拉全量。"""
    q = _user_query(db, keyword, dept_id, status)
    return paginate(q, page=page, size=size, allowed=META_USER_SORTS,
                    default_sort="id", sort=sort, map_row=_u)


@router.get("/depts")
def depts(keyword: str = "", db: Session = Depends(get_db),
          user: User = Depends(get_current_user)):
    """部门字典（最小字段）：带服务端硬上限，`keyword` 按名称模糊匹配。"""
    q = db.query(Department)
    if keyword:
        q = q.filter(Department.name.like(f"%{keyword}%"))
    rows = q.order_by(Department.id).limit(META_MAX_ROWS).all()
    return [{"id": d.id, "name": d.name, "parent_id": d.parent_id} for d in rows]


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
    from ..core.rbac import ROLE_ADMIN, can_approve, demo_data_on, finance_role, role_codes
    codes = role_codes(user)
    admin = ROLE_ADMIN in codes
    items = [
        {"key": "opportunities", "label": "商机管理", "href": "/opportunities"},
        {"key": "projects", "label": "项目台账", "href": "/projects"},
        {"key": "assets", "label": "资产管理", "href": "/assets"},
        {"key": "reports", "label": "支出报表", "href": "/reports"},
    ]
    if admin:
        items.append({"key": "contacts", "label": "通讯录", "href": "/contacts"})
        items.append({"key": "partners", "label": "我的友商", "href": "/partners"})
        items.append({"key": "approvals", "label": "审批中心", "href": "/approvals"})
        items.append({"key": "admin", "label": "系统管理", "href": "/admin"})
    finance_books = (
        db.query(AccountBookMember.account_book_id)
        .join(AccountBook, AccountBook.id == AccountBookMember.account_book_id)
        .filter(AccountBookMember.user_id == user.id, AccountBook.deleted_at.is_(None))
        .count()
    )
    can_finance = admin or finance_books > 0
    if can_finance and not any(item["key"] == "finance" for item in items):
        items.append({"key": "finance", "label": "财务管理", "href": "/finance"})
    return {"roles": sorted(codes), "is_admin": admin, "can_approve": can_approve(user), "can_finance": can_finance,
            "menus": items, "readonly": False,
            "demo_on": demo_data_on(db), "can_toggle_demo": admin}
