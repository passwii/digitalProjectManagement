"""RBAC：超级管理员身份、模块权限与业务数据边界。

当前授权契约：
  · User.is_super_admin 是唯一系统管理身份；旧 admin 角色及其他角色关联仅为兼容/历史数据，不授予权限。
  · 超级管理员拥有全局数据范围；/admin 仅其可访问。业务页面由
    opportunities/projects/assets/reports/contacts/partners/approvals/finance 模块控制。
  · 财务模块统一控制全部财务路由；account_book_members 账套成员记录不授予访问权限。
  · 审批能力由 approvals 模块决定；权限拒绝在业务读写前稳定返回 403。
  · 普通用户仍按「项目负责人 / 项目成员」参与业务（立项、任务、进度填报、跟进、预算/支出登记），
    本轮不收敛该参与路径。
  · 角色目录、user_roles、账套成员模型继续保留以兼容历史记录；角色字段当前不参与系统授权判定。
"""
from fastapi import HTTPException

from ..models import Project

# 角色目录仅保留兼容及历史用途；系统身份只由 User.is_super_admin 决定。
ROLE_ADMIN = "admin"
ROLE_PM = "project_manager"
ROLE_DEPT = "dept_manager"
ROLE_MEMBER = "member"
ROLE_COST = "cost_admin"
ROLE_EXEC = "executive"
ROLE_FINANCE_CLERK = "finance_clerk"
ROLE_FINANCE_REVIEWER = "finance_reviewer"
ROLE_CASHIER = "cashier"
ROLE_FINANCE_MANAGER = "finance_manager"
ROLE_FINANCE_AUDITOR = "finance_auditor"

RESERVED_ROLES = [ROLE_PM, ROLE_DEPT, ROLE_MEMBER, ROLE_COST, ROLE_EXEC]
FINANCE_ROLES = [ROLE_FINANCE_CLERK, ROLE_FINANCE_REVIEWER, ROLE_CASHIER, ROLE_FINANCE_MANAGER, ROLE_FINANCE_AUDITOR]
ALL_ROLES = [ROLE_ADMIN, *RESERVED_ROLES, *FINANCE_ROLES]

# ---------------- 功能模块（Stage 5：页面可见性改为按用户手动分配） ----------------
#
# 管理权限只由 User.is_super_admin 决定；业务页面按模块目录与 user_modules 分配。
# admin 菜单是超管专属入口，不属于可分配模块；财务 API 由财务模块统一控制访问。
MODULE_OPPORTUNITIES = "opportunities"
MODULE_PROJECTS = "projects"
MODULE_ASSETS = "assets"
MODULE_REPORTS = "reports"
MODULE_CONTACTS = "contacts"
MODULE_PARTNERS = "partners"
MODULE_APPROVALS = "approvals"
MODULE_FINANCE = "finance"

# (key, label, href)：后端是模块目录的单一事实来源，前端菜单与用户弹窗都消费它。
MODULE_CATALOG: list[tuple[str, str, str]] = [
    (MODULE_OPPORTUNITIES, "商机管理", "/opportunities"),
    (MODULE_PROJECTS, "项目台账", "/projects"),
    (MODULE_ASSETS, "资产管理", "/assets"),
    (MODULE_REPORTS, "支出报表", "/reports"),
    (MODULE_CONTACTS, "通讯录", "/contacts"),
    (MODULE_PARTNERS, "我的友商", "/partners"),
    (MODULE_APPROVALS, "审批中心", "/approvals"),
    (MODULE_FINANCE, "财务管理", "/finance"),
]
ALL_MODULES = [key for key, _label, _href in MODULE_CATALOG]
# 存量/未显式分配用户的默认模块：与本次改动前的基础导航一致，保证升级后既有
# 普通用户行为不变；超级管理员身份来自 is_super_admin，而非 admin 角色。
DEFAULT_MODULES = [MODULE_OPPORTUNITIES, MODULE_PROJECTS, MODULE_ASSETS, MODULE_REPORTS]


def user_module_codes(user) -> set:
    """已显式写入 user_modules 的模块集合（不含默认回落）。"""
    return {m.module for m in getattr(user, "modules", []) or []}


def effective_modules(user) -> set:
    """用户实际生效的可分配模块；普通用户忽略历史残留的 admin 键。"""
    if is_super_admin(user):
        return set(ALL_MODULES)
    if getattr(user, "modules_assigned", False):
        return user_module_codes(user) & set(ALL_MODULES)
    return set(DEFAULT_MODULES)


def has_module(user, module: str) -> bool:
    return module in effective_modules(user)


def require_module(user, *modules: str) -> None:
    """模块门禁：至少拥有其中一个模块才放行（超级管理员天然全量）。

    用于路由级依赖与端点内校验，保证「前端能看到入口」与「后端接口放行」同一判定，
    不会出现入口可见但接口 403 的错位契约。
    """
    if not (effective_modules(user) & set(modules)):
        raise HTTPException(403, "无权访问该功能模块")


def role_codes(user) -> set:
    return {r.code for r in getattr(user, "roles", []) or []}


def is_admin(user) -> bool:
    """历史调用方兼容别名；管理权限仅由超级管理员标志决定。"""
    return bool(user.is_super_admin)


def is_super_admin(user) -> bool:
    return bool(user.is_super_admin)


def can_approve(user) -> bool:
    """审批资格：拥有「审批中心」模块（管理员天然拥有）即可审批。

    `GET /approvals/pending` 行内的 can_decide 与各决策入口共用本判定，
    保证「列表里能点」与「接口放行」永远一致，不出现按钮可见但接口 403 的错位契约。
    """
    return has_module(user, MODULE_APPROVALS)


def require_admin(user) -> None:
    """系统管理及特权写操作仅允许超级管理员。"""
    if not is_super_admin(user):
        raise HTTPException(403, "仅超级管理员可操作")


def member_ids(project) -> set:
    """项目参与人 = 负责人 + 项目成员。普通用户参与业务的唯一依据。"""
    ids = {project.owner_id} if getattr(project, "owner_id", None) else set()
    for m in getattr(project, "members", []) or []:
        ids.add(m.user_id)
    return ids


def can_read_project(user, project, db=None) -> bool:
    """读权限：超级管理员全局；其他用户仅限自己负责或参与的项目。"""
    if is_admin(user):
        return True
    return user.id in member_ids(project)


def check_project_access(user, project, write: bool = False, db=None,
                         hidden_msg: str = "项目不存在") -> None:
    """读：可见即可；写：超级管理员或项目参与人。

    传 db 时额外执行演示数据门禁：演示开关关闭时，演示项目视为不存在（404），
    与列表/统计口径保持一致，避免「列表里看不到、直接访问 URL 却能打开」。
    """
    if db is not None and is_demo_hidden(project, db):
        raise HTTPException(404, hidden_msg)
    if is_admin(user):
        return
    if not can_read_project(user, project):
        raise HTTPException(403, "无权访问该项目")
    if write and user.id not in member_ids(project):
        raise HTTPException(403, "仅项目成员可写")


def visible_project_condition(user):
    """把「可见项目」规则下推为 SQL 条件（避免全表载入后在 Python 过滤）。

    返回 None 表示无需过滤：仅超级管理员，全局可见（跨部门、跨项目、不限成员）。
    其余用户：负责人 或 项目成员；部门隔离规则已随本次契约收敛取消。
    """
    from sqlalchemy import exists, or_

    from ..models import ProjectMember

    if is_admin(user):
        return None
    return or_(
        Project.owner_id == user.id,
        exists().where((ProjectMember.project_id == Project.id) &
                       (ProjectMember.user_id == user.id)),
    )


DEMO_PARAM_KEY = "demo_data_on"


def demo_data_on(db) -> bool:
    """演示数据开关：系统参数 demo_data_on（0=隐藏，1=显示）。缺省视为隐藏。"""
    if db is None:
        return False
    from ..models import SysParam

    row = db.query(SysParam).filter_by(key=DEMO_PARAM_KEY).first()
    return bool(row and row.value == "1")


def set_demo_data(db, on: bool) -> bool:
    """写入开关值（调用方负责鉴权与提交）。"""
    from ..models import SysParam

    row = db.query(SysParam).filter_by(key=DEMO_PARAM_KEY).first()
    value = "1" if on else "0"
    if row:
        row.value = value
    else:
        db.add(SysParam(key=DEMO_PARAM_KEY, value=value, desc="演示数据开关 0隐藏/1显示"))
    return on


def is_demo_hidden(project, db) -> bool:
    """该项目当前是否因演示开关关闭而应视为隐藏。"""
    return bool(getattr(project, "is_demo", False)) and not demo_data_on(db)


def project_scope_condition(user, db=None):
    """可见项目范围 = 权限范围 ∩ 演示数据开关。

    返回 None 表示无任何过滤（超级管理员 + 演示开关打开）。
    开关关闭时演示项目在全站（列表/工作台/报表/预警/任务）一并排除，保证统计口径一致。
    """
    from sqlalchemy import and_

    conds = []
    vis = visible_project_condition(user)
    if vis is not None:
        conds.append(vis)
    if db is not None and not demo_data_on(db):
        conds.append(Project.is_demo.is_(False))
    if not conds:
        return None
    return and_(*conds)


def active_projects(db):
    """未软删除项目查询基座：普通业务列表与写入一律基于 active 项目。

    软删除项目只能通过回收站（`/projects/recycle-bin/list`）查看、通过恢复接口回到正常业务。
    """
    return db.query(Project).filter(Project.deleted_at.is_(None))


def get_active_project(db, pid: int, user=None, write: bool = False,
                       msg: str = "项目不存在") -> Project:
    """按 id 取一个未软删除项目；不存在或已软删除 → 404（默认 msg 可覆盖）。

    传 user 时附带参与人读/写校验（超级管理员全局放行）。子表接口（预算/支出/里程碑/任务/填报）
    的项目边界统一走这里，避免各自 `filter_by(id=...)` 漏掉软删除与可见性。
    """
    p = active_projects(db).filter(Project.id == pid).first()
    if not p:
        raise HTTPException(404, msg)
    if is_demo_hidden(p, db):
        raise HTTPException(404, msg)   # 演示数据已隐藏，按不存在处理
    if user is not None:
        check_project_access(user, p, write=write)
    return p


def visible_project_ids(db, user):
    """「可见 + 未软删除」的项目 id 子查询，供子表列表下推过滤。

    用法：`q.filter(Expense.project_id.in_(visible_project_ids(db, user)))`。
    列表接口在没有指定 project_id 时一律用它收口，避免跨项目数据泄露与软删除项目回流。
    """
    from sqlalchemy import select

    stmt = select(Project.id).where(Project.deleted_at.is_(None))
    cond = project_scope_condition(user, db)   # 含演示数据开关
    if cond is not None:
        stmt = stmt.where(cond)
    return stmt


def visible_project_id_list(db, user) -> set[int]:
    """「可见 + 未软删除」项目 id 集合（需要在 Python 侧做集合判断的场景，如跨项目任务列表）。"""
    return {pid for (pid,) in db.execute(visible_project_ids(db, user)).all()}


def scope_child_query(query, model, db, user):
    """把「可见 + 未软删除」项目边界下推为子表列表的 SQL 过滤。

    用法：`q = scope_child_query(db.query(Task), Task, db, user)`。
    超级管理员是唯一全局范围身份：不按参与人过滤（跨部门、跨项目可见），
    但仍必须排除软删除项目——「管理员全局 ≠ 包含回收站」是 Stage 1 已确认契约，
    子表列表一律通过 `visible_project_ids` 子查询收口，避免回收站数据回流。
    """
    return query.filter(model.project_id.in_(visible_project_ids(db, user)))
