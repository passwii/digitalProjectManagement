"""Stage 1：项目台账 CRUD + 状态机 + 变更留痕 + 附件 + 跟进 + 加权进度。"""

from datetime import date, datetime
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel
from sqlalchemy import and_, func, or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..core.attachments import (
    attachment_response,
    remove_attachment_blob,
    store_attachment,
)
from ..core.audit import commit_audited, write_audit
from ..core.database import get_db, parse_date
from ..core.deps import get_current_user
from ..core.limits import MAX_ATTACHMENT_SIZE, read_within_limit
from ..core.paging import DEFAULT_PAGE_SIZE, paginate
from ..core.project_changes import (
    AUTO_SAVE_FIELD,
    coalesce_project_changes,
    record_project_change,
)
from ..core.rbac import (
    check_project_access,
    is_admin,
    project_scope_condition,
    require_admin,
    require_module,
)
from ..core.timeutil import app_now, app_today, iso, to_db
from ..models import (
    Attachment,
    Followup,
    Project,
    ProjectChange,
    ProjectMember,
    SysParam,
    Task,
    User,
)

router = APIRouter(prefix="/projects", tags=["projects"])

# 排序白名单（Stage 3A）：字段名 → ORM 列，用户输入永不拼进 SQL
PROJECT_SORTS = {
    "id": Project.id,
    "code": Project.code,
    "name": Project.name,
    "status": Project.status,
    "priority": Project.priority,
    "budget_total": Project.budget_total,
    "progress": Project.progress,
    "plan_start": Project.plan_start,
    "plan_end": Project.plan_end,
    "created_at": Project.created_at,
    "dept_id": Project.dept_id,
    "owner_id": Project.owner_id,
}
FOLLOWUP_SORTS = {
    "id": Followup.id,
    "happened_at": Followup.happened_at,
    "remind_at": Followup.remind_at,
    "user_id": Followup.user_id,
    "method": Followup.method,
}

# 状态机：草稿/待立项审批/已立项/进行中/暂停/已完成/已归档/已取消
TRANSITIONS = {
    "draft": {"pending", "filed", "cancelled"},
    "pending": {"filed", "cancelled"},  # 立项审批（approval 开关开启时）
    "filed": {"doing", "cancelled"},
    "doing": {"paused", "done"},
    "paused": {"doing", "done"},
    "done": {"archived"},
    "archived": {"doing"},  # 管理员可解归档
    "cancelled": set(),
}
ALLOWED_EXT = {".pdf", ".docx", ".xlsx", ".png", ".jpg", ".jpeg"}
CONTRACT_STATUSES = {"已签订", "未签订"}
# 负责人筛选项的服务端硬上限（与 /meta/* 字典接口同思路：一次取回本地渲染，但有界）
OWNER_OPTION_MAX = 200
# 体积上限与超限文案统一来自 core.limits（前端单一来源为 web/lib/uploadLimits.ts）
MAX_SIZE = MAX_ATTACHMENT_SIZE


def _p(p: Project):
    return {
        "id": p.id,
        "code": p.code,
        "name": p.name,
        "type": p.type,
        "dept_id": p.dept_id,
        "owner_id": p.owner_id,
        "owner_name": p.owner_name or "",
        "member_ids": [m.user_id for m in p.members],
        "plan_start": p.plan_start.isoformat() if p.plan_start else None,
        "plan_end": p.plan_end.isoformat() if p.plan_end else None,
        "budget_total": p.budget_total,
        "priority": p.priority,
        "client": p.client,
        "client_contact": p.client_contact or "",
        "client_phone": p.client_phone or "",
        "description": p.description,
        "contract_status": p.contract_status or "",
        "status": p.status,
        "progress": p.progress,
    }


def _next_code(db: Session) -> str:
    y = app_today().year
    prefix = f"PJ-{y}-"
    last = (
        db.query(Project)
        .filter(Project.code.like(prefix + "%"))
        .order_by(Project.code.desc())
        .first()
    )
    n = int(last.code.rsplit("-", 1)[1]) + 1 if last else 1
    return f"{prefix}{n:04d}"


def _get(db: Session, pid: int, user: User, write=False) -> Project:
    p = db.query(Project).filter_by(id=pid, deleted_at=None).first()
    if not p:
        raise HTTPException(404, "项目不存在")
    check_project_access(user, p, write=write, db=db)
    return p


def keyword_condition(keyword: str):
    """关键词过滤：使用 PostgreSQL 大小写不敏感模糊匹配。"""
    kw = f"%{keyword}%"
    return or_(
        Project.name.ilike(kw),
        Project.code.ilike(kw),
        Project.client.ilike(kw),
        Project.description.ilike(kw),
    )


def owner_condition(db: Session, owner_id: int = 0, owner: str = ""):
    """负责人过滤：`owner` 按姓名精确匹配（台账主用），`owner_id` 按账号精确匹配。

    姓名匹配同时覆盖两列：`owner_name` 精确相等，或 `owner_id` 指向同名账号。
    后者兼容「展示名是某人、但 `owner_id` 陈旧/为空」的历史与建档数据：
    `create_project` 在负责人没有登录账号时会把 `owner_id` 落成**创建人**的 id，
    所以按 `owner_id` 筛会「选谁都像是创建人的项目」——按姓名筛才是与列表展示一致的口径。
    姓名的兜底名同样接受账号：没有 `real_name` 的账号在 `/meta/users` 与服务端的
    展示名一律回退为 `username`，这里必须同口径，否则这类行筛不出来。
    无条件时返回 None（不过滤）。
    """
    conds = []
    if owner_id:
        conds.append(Project.owner_id == owner_id)
    name = (owner or "").strip()
    if name:
        same_name_ids = [
            row[0]
            for row in db.query(User.id)
            .filter(or_(User.real_name == name, User.username == name))
            .all()
        ]
        # `owner_name` 是台账实际展示口径；只有展示名为空时，才允许用
        # `owner_id` 按账号姓名兜底。不能把两列无条件 OR，否则历史脏数据中
        # 多个展示姓名共用同一个 owner_id 时，会把其他负责人的项目一起筛出。
        name_cond = Project.owner_name == name
        if same_name_ids:
            empty_display_name = func.coalesce(Project.owner_name, "") == ""
            name_cond = or_(name_cond, and_(empty_display_name, Project.owner_id.in_(same_name_ids)))
        conds.append(name_cond)
    if not conds:
        return None
    return and_(*conds) if len(conds) > 1 else conds[0]


def account_display_name():
    """账号侧「负责人展示名」的 SQL 口径：`real_name` 缺省回退 `username`。

    与 `/meta/users` 的 `_u()`（`real_name or username`）和台账列的展示值同口径；
    两侧不一致会让「列表里看得到的名字」筛不出来。
    """
    return func.coalesce(func.nullif(func.coalesce(User.real_name, ""), ""), User.username)



def _keyword_snippet(project: Project, keyword: str) -> str:
    """关键词命中的纯文本摘要；不返回 HTML，避免把用户输入当标记渲染。"""
    sources = [project.description, project.name, project.client, project.code]
    text = next(
        (str(v) for v in sources if v and keyword.lower() in str(v).lower()), ""
    )
    if not text:
        text = str(project.description or project.name or project.code or "")
    idx = text.lower().find(keyword.lower())
    if idx < 0:
        return text[:80]
    start = max(0, idx - 20)
    end = min(len(text), idx + len(keyword) + 30)
    return f"{'…' if start else ''}{text[start:end]}{'…' if end < len(text) else ''}"


class ProjectIn(BaseModel):
    code: str = ""
    name: str
    type: str = ""
    dept_id: int | None = None
    owner_id: int | None = None
    owner_name: str = ""
    member_ids: list[int] = []
    plan_start: date | None = None
    plan_end: date | None = None
    budget_total: float = 0
    priority: str = "中"
    client: str = ""
    client_contact: str = ""
    client_phone: str = ""
    description: str = ""
    contract_status: str = ""


def _code(value: str) -> str:
    return str(value or "").strip()


def _owner(
    db: Session, owner_id: int | None, owner_name: str
) -> tuple[int | None, str]:
    selected_name = str(owner_name or "").strip()
    if owner_id:
        u = db.query(User).filter_by(id=owner_id).first()
        if not u:
            raise HTTPException(400, "项目负责人不存在")
        return u.id, selected_name or u.real_name or u.username
    if selected_name:
        u = db.query(User).filter_by(real_name=selected_name).first()
        if u:
            return u.id, selected_name
    return None, selected_name


@router.get("")
def list_projects(
    name: str = "",
    code: str = "",
    status: str = "",
    owner_id: int = 0,
    owner: str = "",
    dept_id: int = 0,
    keyword: str = "",
    date_from: str = "",
    date_to: str = "",
    sort: str = "-id",
    page: int = 1,
    size: int = DEFAULT_PAGE_SIZE,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """组合筛（名称/编号/状态/负责人/部门/关键字/计划时间）+ 统一分页信封。

    关键字使用 PostgreSQL 模糊匹配。
    排序白名单见 `PROJECT_SORTS`，默认 `-id`（最新在前）；`size` 上限 100。
    """
    q = db.query(Project).filter(Project.deleted_at.is_(None))
    if name:
        q = q.filter(Project.name.like(f"%{name}%"))
    if code:
        q = q.filter(Project.code.like(f"%{code}%"))
    if keyword:
        q = q.filter(keyword_condition(keyword))
    if status:
        q = q.filter_by(status=status)
    owner_cond = owner_condition(db, owner_id=owner_id, owner=owner)
    if owner_cond is not None:
        q = q.filter(owner_cond)
    if dept_id:
        q = q.filter_by(dept_id=dept_id)
    df, dt = parse_date(date_from or None), parse_date(date_to or None)
    if df:
        q = q.filter(or_(Project.plan_end.is_(None), Project.plan_end >= df))
    if dt:
        q = q.filter(or_(Project.plan_start.is_(None), Project.plan_start <= dt))
    # 权限过滤下推 SQL（Stage 5）：不再 q.all() 后 Python 全量过滤
    vis = project_scope_condition(user, db)
    if vis is not None:
        q = q.filter(vis)

    def _row(p: Project):
        row = _p(p)
        if keyword:
            row["snippet"] = _keyword_snippet(p, keyword)
        return row

    return paginate(
        q,
        page=page,
        size=size,
        allowed=PROJECT_SORTS,
        default_sort="-id",
        sort=sort,
        map_row=_row,
    )


@router.get("/options")
def project_options(
    keyword: str = "",
    status: str = "",
    owner_id: int = 0,
    owner: str = "",
    sort: str = "-id",
    page: int = 1,
    size: int = DEFAULT_PAGE_SIZE,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """项目选择器专用：最小字段 + 关键词分页，替代前端 `?size=100` 全量下拉。

    只返回 id/code/name/status/owner_id/dept_id（不含描述、成员等大字段），
    权限与软删除边界与 `GET /projects` 完全一致（同一次可见性下推）。
    关键词按「名称/编号」模糊匹配（选择器实际输入的就是项目名或编号）：
    不走 FTS——FTS 命中集预先截断为 500 条，会让分页的 `total` 失真。
    注意：本路由必须定义在 `/{pid}` 之前，否则会被单段路径参数抢先匹配。
    """
    q = db.query(
        Project.id,
        Project.code,
        Project.name,
        Project.status,
        Project.owner_id,
        Project.dept_id,
    ).filter(Project.deleted_at.is_(None))
    if keyword:
        like = f"%{keyword}%"
        q = q.filter(or_(Project.name.like(like), Project.code.like(like)))
    if status:
        q = q.filter(Project.status == status)
    owner_cond = owner_condition(db, owner_id=owner_id, owner=owner)
    if owner_cond is not None:
        q = q.filter(owner_cond)
    vis = project_scope_condition(user, db)  # 含演示数据开关
    if vis is not None:
        q = q.filter(vis)

    def _opt(r):
        return {
            "id": r.id,
            "code": r.code,
            "name": r.name,
            "status": r.status,
            "owner_id": r.owner_id,
            "dept_id": r.dept_id,
        }

    return paginate(
        q,
        page=page,
        size=size,
        allowed=PROJECT_SORTS,
        default_sort="-id",
        sort=sort,
        map_row=_opt,
    )


@router.get("/owners")
def project_owners(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """负责人筛选项（字典式小字段接口）：返回台账「负责人」列实际出现的姓名 + 项目数。

    为什么选项不取 `/meta/users`（账号字典），过滤也不按 `owner_id`：
    · 台账列展示的是建档时选定的 `owner_name`；负责人没有登录账号时，
      `create_project` 会把 `owner_id` 落成**创建人**的 id —— 于是「按 id 筛」
      选谁都像是创建人的项目（表现就是「筛选后还是全部结果」）；
    · 没有账号的负责人（演示数据、历史数据）根本不在账号字典里，选都选不出来。
    因此选项取「展示口径」的姓名，过滤由 `GET /projects?owner=<姓名>` 完成
    （`owner_condition` 同时覆盖 `owner_name` 精确匹配与同名账号的 `owner_id`）。

    口径与 `GET /projects` 完全一致：软删除 + 权限可见性 + 演示数据开关；
    `owner_name` 为空、只挂了 `owner_id` 的行按账号姓名归组，保证选项不漏人。
    响应服务端硬上限 `OWNER_OPTION_MAX`，按项目数倒序、姓名升序，避免无界放大。
    注意：本路由必须定义在 `/{pid}` 之前，否则会被单段路径参数抢先匹配。
    """
    scope = project_scope_condition(user, db)  # 含演示数据开关

    def _scoped(query):
        query = query.filter(Project.deleted_at.is_(None))
        return query.filter(scope) if scope is not None else query

    name_col = func.coalesce(Project.owner_name, "")
    counts: dict[str, int] = {}

    # ① 有 owner_name 的行：按展示名归组（含「展示名是某人、owner_id 是创建人」的历史数据）
    named = (
        _scoped(db.query(name_col, func.count()))
        .filter(name_col != "")
        .group_by(name_col)
        .all()
    )
    for name, count in named:
        counts[name] = counts.get(name, 0) + int(count)

    # ② owner_name 为空、只挂了账号的行：按账号展示名归组，避免选项漏人
    #    展示名表达式只构造一次：重复构造会生成不同的绑定参数，PostgreSQL 会
    #    把 SELECT 与 GROUP BY 当成两个表达式而报「must appear in the GROUP BY clause」。
    display_name_col = account_display_name()
    linked = (
        _scoped(
            db.query(display_name_col, func.count()).join(
                Project, Project.owner_id == User.id
            )
        )
        .filter(name_col == "")
        .group_by(display_name_col)
        .all()
    )
    for display_name, count in linked:
        label = str(display_name or "").strip()
        if label:
            counts[label] = counts.get(label, 0) + int(count)

    ranked = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
    return [{"name": name, "count": count} for name, count in ranked[:OWNER_OPTION_MAX]]


@router.post("")
def create_project(
    body: ProjectIn,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    if not body.name:
        raise HTTPException(400, "项目名称必填")
    code = _code(body.code)
    if code and len(code) > 32:
        raise HTTPException(400, "项目编号最多 32 个字符")
    if code and db.query(Project).filter_by(code=code).first():
        raise HTTPException(400, "项目编号已存在")
    if db.query(Project).filter_by(name=body.name).first():
        raise HTTPException(400, "项目名称已存在")
    if body.contract_status and body.contract_status not in CONTRACT_STATUSES:
        raise HTTPException(400, "合同状态须为「已签订」或「未签订」")
    owner_id, owner_name = _owner(db, body.owner_id, body.owner_name)
    if body.plan_start and body.plan_end and body.plan_start > body.plan_end:
        raise HTTPException(400, "计划开始不能晚于结束")
    for _ in range(3):  # 并发取号重试（唯一索引兜底）
        try:
            # 立项审批开关：开启则项目进入「待立项审批」，由审批中心放行
            ap = db.query(SysParam).filter_by(key="project_approval_on").first()
            filing_on = bool(ap and ap.value == "1")
            p = Project(
                code=code or _next_code(db),
                name=body.name,
                type=body.type,
                dept_id=body.dept_id if body.dept_id else user.dept_id,
                owner_id=owner_id or user.id,
                owner_name=owner_name,
                plan_start=body.plan_start,
                plan_end=body.plan_end,
                budget_total=body.budget_total,
                priority=body.priority,
                client=body.client,
                client_contact=body.client_contact,
                client_phone=body.client_phone,
                description=body.description,
                contract_status=body.contract_status,
                status="pending" if filing_on else "draft",
                created_by=user.id,
            )
            db.add(p)
            db.flush()
            for uid in set(body.member_ids) | {p.owner_id}:
                if db.query(User).filter_by(id=uid).first():
                    db.add(ProjectMember(project_id=p.id, user_id=uid))
            if filing_on:
                # 立项审批人 = 管理员（唯一审批角色），申请人收到结果通知即可
                from ..core.notify import approval_recipients, push_many
                from ..core.timeline import ACTION_SUBMIT, KIND_PROJECT_FILING
                from ..core.timeline import record as record_timeline

                record_timeline(
                    db,
                    KIND_PROJECT_FILING,
                    p.id,
                    ACTION_SUBMIT,
                    from_status="draft",
                    to_status="pending",
                    project_id=p.id,
                    actor_id=user.id,
                )
                push_many(
                    db,
                    approval_recipients(db),
                    "approval",
                    f"立项审批待处理：{p.name}",
                    f"编号 {p.code}，预算 {p.budget_total}",
                    ref_type="project",
                    ref_id=p.id,
                    project_id=p.id,
                    dedup_key=f"filing-request:{p.id}",
                )
            db.flush()
            commit_audited(db, user.id, "create_project", "projects", p.id, p.code)
            break
        except HTTPException:
            db.rollback()
            raise
        except IntegrityError:  # 编号唯一索引冲突 → 重试取号
            db.rollback()
            continue
        except Exception:
            db.rollback()
            raise
    else:
        raise HTTPException(500, "编号生成冲突，请重试")
    return _p(db.query(Project).filter_by(id=p.id).first())


@router.get("/{pid}")
def get_project(
    pid: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)
):
    return _p(_get(db, pid, user))


@router.patch("/{pid}")
def update_project(
    pid: int,
    body: dict,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    p = _get(db, pid, user, write=True)
    if p.status == "archived":
        raise HTTPException(400, "已归档项目只读")
    allowed = {
        "code",
        "name",
        "type",
        "dept_id",
        "owner_id",
        "owner_name",
        "plan_start",
        "plan_end",
        "budget_total",
        "priority",
        "client",
        "client_contact",
        "client_phone",
        "description",
        "contract_status",
    }
    now = app_now()
    for f, v in body.items():
        if f == "member_ids":
            continue
        if f not in allowed:
            continue
        if f == "code":
            v = _code(v)
            if not v:
                raise HTTPException(400, "项目编号不能为空")
            if len(v) > 32:
                raise HTTPException(400, "项目编号最多 32 个字符")
            if db.query(Project).filter(Project.code == v, Project.id != pid).first():
                raise HTTPException(400, "项目编号已存在")
        if f == "contract_status" and v not in ("", *CONTRACT_STATUSES):
            raise HTTPException(400, "合同状态须为「已签订」或「未签订」")
        if f == "owner_id":
            owner_id, owner_name = _owner(
                db, int(v) if v else None, body.get("owner_name", p.owner_name)
            )
            if owner_id != p.owner_id:
                old_owner = p.owner_id
                p.owner_id = owner_id
                db.add(
                    ProjectChange(
                        project_id=pid,
                        field="owner_id",
                        old=str(old_owner or ""),
                        new=str(owner_id or ""),
                        by_id=user.id,
                        at=now,
                    )
                )
            if owner_name != (p.owner_name or ""):
                p.owner_name = owner_name
                db.add(
                    ProjectChange(
                        project_id=pid,
                        field="owner_name",
                        old="",
                        new=owner_name,
                        by_id=user.id,
                        at=now,
                    )
                )
            continue
        if f == "owner_name":
            v = str(v or "").strip()
            # 仅改名未带 owner_id 时尝试重链（BLF-1148）：新名精确命中唯一用户则同步
            # owner_id，避免「展示名是 A、筛选 id 却是 B」的口径分裂；命中不到/多个则
            # 保持原 owner_id（读侧 owner 条件同时覆盖 owner_name，不会筛丢）。
            if "owner_id" not in body and v and v != (p.owner_name or ""):
                linked = db.query(User).filter(User.real_name == v).all()
                # 纯值比较（str 化）：实例属性在右侧时保持 bool 语义，避免 Column 表达式
                if len(linked) == 1 and str(linked[0].id) != str(p.owner_id or ""):
                    old_owner = p.owner_id
                    p.owner_id = linked[0].id
                    db.add(
                        ProjectChange(
                            project_id=pid,
                            field="owner_id",
                            old=str(old_owner or ""),
                            new=str(linked[0].id),
                            by_id=user.id,
                            at=now,
                        )
                    )
        if f in ("plan_start", "plan_end"):
            v = parse_date(v)
        old = getattr(p, f)
        old_s = (
            iso(old)
            if isinstance(old, date)
            else str(old if old is not None else "")
        )
        if str(v or "") != old_s:
            if (
                f == "name"
                and db.query(Project)
                .filter(Project.name == v, Project.id != pid)
                .first()
            ):
                raise HTTPException(400, "项目名称已存在")
            setattr(p, f, v)
            if f == AUTO_SAVE_FIELD:
                record_project_change(
                    db,
                    pid,
                    f,
                    str(v or ""),
                    old=old_s,
                    user_id=user.id,
                    at=now,
                )
            else:
                db.add(
                    ProjectChange(
                        project_id=pid,
                        field=f,
                        old=old_s,
                        new=str(v or ""),
                        by_id=user.id,
                        at=now,
                    )
                )
    if "member_ids" in body:
        db.query(ProjectMember).filter_by(project_id=pid).delete()
        for uid in set(body["member_ids"]) | ({p.owner_id} if p.owner_id else set()):
            if db.query(User).filter_by(id=uid).first():
                db.add(ProjectMember(project_id=pid, user_id=uid))
        db.add(
            ProjectChange(
                project_id=pid,
                field="member_ids",
                old="",
                new=str(body["member_ids"]),
                by_id=user.id,
                at=now,
            )
        )
    if p.owner_id and "member_ids" not in body:
        db.add(ProjectMember(project_id=pid, user_id=p.owner_id)) if not db.query(
            ProjectMember
        ).filter_by(project_id=pid, user_id=p.owner_id).first() else None
    commit_audited(
        db, user.id, "update_project", "projects", pid, str(list(body.keys()))
    )
    return _p(p)


@router.post("/{pid}/status")
def change_status(
    pid: int,
    body: dict,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    p = _get(db, pid, user, write=True)
    to = body.get("status", "")
    reason = str(body.get("reason", "") or "")
    if to not in (TRANSITIONS.get(p.status, set())):
        raise HTTPException(400, f"不允许从 {p.status} 流转到 {to}")
    if to == "archived" and not is_admin(user) and p.owner_id != user.id:
        raise HTTPException(403, "仅负责人或管理员可归档")
    if p.status == "archived" and to == "doing" and not is_admin(user):
        raise HTTPException(403, "仅管理员可解归档")
    old = p.status
    p.status = to
    now = app_now()
    db.add(
        ProjectChange(
            project_id=pid, field="status", old=old, new=to, by_id=user.id, at=now
        )
    )
    # 立项审批的最终状态也进时间线（申请人可查「谁在什么时候批/驳了什么」）
    if old in ("pending", "draft") and to in ("filed", "cancelled"):
        from ..core.timeline import (
            ACTION_APPROVE,
            ACTION_REJECT,
            ACTION_SUBMIT,
            KIND_PROJECT_FILING,
        )
        from ..core.timeline import record as record_timeline

        record_timeline(
            db,
            KIND_PROJECT_FILING,
            pid,
            ACTION_SUBMIT,
            from_status="draft",
            to_status="pending",
            project_id=pid,
            actor_id=p.owner_id,
        )
        record_timeline(
            db,
            KIND_PROJECT_FILING,
            pid,
            ACTION_APPROVE if to == "filed" else ACTION_REJECT,
            from_status="pending",
            to_status=to,
            project_id=pid,
            actor_id=user.id,
            reason=reason,
        )
    commit_audited(
        db, user.id, "project_status", "projects", pid, f"{old}->{to} {reason}"
    )
    return _p(p)


@router.get("/{pid}/changes")
def list_changes(
    pid: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)
):
    _get(db, pid, user)
    rows = (
        db.query(ProjectChange)
        .filter_by(project_id=pid)
        .order_by(ProjectChange.id.desc())
        .all()
    )
    return [
        {
            "id": c.id,
            "field": c.field,
            "old": c.old,
            "new": c.new,
            "by_id": c.by_id,
            "at": iso(c.at),
        }
        for c in coalesce_project_changes(rows)
    ]


@router.post("/{pid}/attachments")
def upload(
    pid: int,
    file: UploadFile = File(...),
    ref_type: str = Form(""),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    p = _get(db, pid, user, write=True)
    if p.status == "archived":
        raise HTTPException(400, "已归档禁传附件")
    ext = Path(file.filename or "").suffix.lower()
    if ext not in ALLOWED_EXT:
        raise HTTPException(400, f"仅允许 {sorted(ALLOWED_EXT)}")
    # 有界读取：超限在读完 limit+1 字节时就 400，不会把无界数据读进内存
    data = read_within_limit(file, MAX_SIZE)
    if ref_type not in ("", "contract"):
        raise HTTPException(400, "附件类型不支持")
    # 正文落位（本地磁盘 / R2）由 core.attachments 收口，本处只管业务语义与鉴权
    a = store_attachment(
        db,
        domain="contract" if ref_type == "contract" else "project",
        filename=file.filename or "attachment",
        content_type=file.content_type or "",
        data=data,
        project_id=pid,
        ref_type=ref_type,
        ref_id=None,
        uploaded_by=user.id,
    )
    commit_audited(db, user.id, "upload_attachment", "attachments", a.id, file.filename)
    return {"id": a.id, "filename": a.filename, "size": a.size}


@router.get("/{pid}/attachments")
def list_attachments(
    pid: int,
    ref_type: str = "",
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """项目附件列表（只含项目级附件）。

    支出凭证（`ref_type="expense"`）挂在同一张表上，必须按 `ref_type` 排除，
    否则项目附件列表会泄漏支出单据的凭证文件名与上传人。
    """
    _get(db, pid, user)
    if ref_type not in ("", "contract"):
        raise HTTPException(400, "附件类型不支持")
    q = db.query(Attachment).filter(Attachment.project_id == pid)
    if ref_type:
        q = q.filter(Attachment.ref_type == ref_type)
    else:
        q = q.filter(or_(Attachment.ref_type == "", Attachment.ref_type.is_(None)))
    rows = q.all()
    return [
        {
            "id": a.id,
            "filename": a.filename,
            "size": a.size,
            "ref_type": a.ref_type or "",
            "content_type": a.content_type or "",
            "uploaded_by": a.uploaded_by,
            "uploaded_at": iso(a.uploaded_at),
        }
        for a in rows
    ]


@router.get("/{pid}/attachments/{aid}/download")
def download_attachment(
    pid: int,
    aid: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """附件下载：校验项目可见性 + 附件归属，防越权取件。

    只允许项目级附件；支出凭证要经 `/expenses/{id}/vouchers/{aid}/download` 取，
    以保证「支出可见性」与「凭证可见性」永远同源。
    """
    _get(db, pid, user)
    a = (
        db.query(Attachment)
        .filter(
            Attachment.id == aid,
            Attachment.project_id == pid,
            or_(
                Attachment.ref_type.in_(("", "contract")), Attachment.ref_type.is_(None)
            ),
        )
        .first()
    )
    if not a:
        raise HTTPException(404, "附件不存在")
    write_audit(db, user.id, "download_attachment", "attachments", a.id, a.filename)
    return attachment_response(a)


@router.delete("/{pid}/attachments/{aid}")
def delete_attachment(
    pid: int,
    aid: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """删除附件：项目可写者或上传者本人，同时清理磁盘文件。只限项目级附件。"""
    _get(db, pid, user, write=True)
    a = (
        db.query(Attachment)
        .filter(
            Attachment.id == aid,
            Attachment.project_id == pid,
            or_(
                Attachment.ref_type.in_(("", "contract")), Attachment.ref_type.is_(None)
            ),
        )
        .first()
    )
    if not a:
        raise HTTPException(404, "附件不存在")
    if a.uploaded_by != user.id and not is_admin(user):
        raise HTTPException(403, "仅上传者或管理员可删除附件")
    # 先删正文、再删元数据：R2 删不掉时抛 502 并保留元数据，避免产生无人追踪的孤儿对象
    remove_attachment_blob(a)
    name = a.filename
    db.delete(a)
    db.flush()
    commit_audited(db, user.id, "delete_attachment", "attachments", aid, name)
    return {"ok": True}


@router.put("/{pid}/members")
def set_members(
    pid: int,
    body: dict,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """整体覆盖项目成员：负责人始终保留，变更写入留痕。"""
    from ..models import ProjectMember

    p = _get(db, pid, user, write=True)
    ids = body.get("user_ids", [])
    if not isinstance(ids, list):
        raise HTTPException(400, "user_ids 须为数组")
    wanted = {int(i) for i in ids if str(i).isdigit()}
    if p.owner_id:
        wanted.add(p.owner_id)
    for uid in wanted:
        if not db.query(User).filter_by(id=uid).first():
            raise HTTPException(400, f"用户 {uid} 不存在")
    old = sorted(
        {m.user_id for m in db.query(ProjectMember).filter_by(project_id=pid).all()}
    )
    db.query(ProjectMember).filter_by(project_id=pid).delete()
    for uid in wanted:
        db.add(ProjectMember(project_id=pid, user_id=uid))
    db.add(
        ProjectChange(
            project_id=pid,
            field="members",
            old=",".join(map(str, old)),
            new=",".join(map(str, sorted(wanted))),
            by_id=user.id,
            at=app_now(),
        )
    )
    db.commit()
    write_audit(db, user.id, "set_members", "projects", pid, f"{old}->{sorted(wanted)}")
    return _p(db.query(Project).filter_by(id=pid).first())


@router.delete("/{pid}")
def delete_project(
    pid: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)
):
    """软删除项目：仅管理员，数据保留可恢复（回收站见 GET /projects/recycle-bin）。

    已取消/已归档/进行中/已立项等任意状态均可删除：删除只把项目移入回收站，
    关联的任务、支出、附件、跟进与审批记录全部保留，管理员可在回收站恢复。
    """
    require_admin(user)
    p = db.query(Project).filter_by(id=pid, deleted_at=None).first()
    if not p:
        raise HTTPException(404, "项目不存在")
    p.deleted_at = app_now()
    db.commit()
    write_audit(db, user.id, "delete_project", "projects", pid, p.code)
    return {"ok": True, "id": pid}


@router.post("/{pid}/restore")
def restore_project(
    pid: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)
):
    """从回收站恢复（仅管理员）。"""
    require_admin(user)
    p = db.query(Project).filter_by(id=pid).first()
    if not p or not p.deleted_at:
        raise HTTPException(404, "回收站中无此项目")
    p.deleted_at = None
    db.commit()
    write_audit(db, user.id, "restore_project", "projects", pid, p.code)
    return _p(p)


@router.get("/recycle-bin/list")
def recycle_bin(
    sort: str = "-deleted_at",
    page: int = 1,
    size: int = DEFAULT_PAGE_SIZE,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """回收站列表（仅管理员）：正常业务列表不看已软删除项目，回收站单独查看与恢复。

    统一分页信封；排序白名单 `id` / `deleted_at` / `code` / `name`，默认按删除时间倒序。
    """
    require_admin(user)
    q = db.query(Project).filter(Project.deleted_at.isnot(None))

    def _row(p: Project):
        return {
            "id": p.id,
            "code": p.code,
            "name": p.name,
            "status": p.status,
            "deleted_at": iso(p.deleted_at),
        }

    return paginate(
        q,
        page=page,
        size=size,
        allowed={
            "id": Project.id,
            "deleted_at": Project.deleted_at,
            "code": Project.code,
            "name": Project.name,
        },
        default_sort="-deleted_at",
        sort=sort,
        map_row=_row,
    )


class FollowupIn(BaseModel):
    happened_at: datetime | None = None
    method: str = ""
    content: str = ""
    next_step: str = ""
    remind_at: datetime | None = None


FOLLOWUP_METHODS = {"电话", "会议", "现场", "邮件", "其他"}
FOLLOWUP_STATES = ("pending", "done", "ignored")


@router.get("/{pid}/followups")
def list_followups(
    pid: int,
    user_id: int = 0,
    date_from: str = "",
    date_to: str = "",
    remind_state: str = "",
    sort: str = "-id",
    page: int = 1,
    size: int = DEFAULT_PAGE_SIZE,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """跟进列表：按人/时间/提醒状态筛 + 统一分页信封（默认 `-id`，最新在前）。

    `remind_state` 区分跟进提醒的可追踪状态（pending 待处理 / done 已通知或已处理 / ignored 已忽略），
    remind 定时扫描见 `core.jobs.due_followups`，每 10min。
    """
    _get(db, pid, user)
    if remind_state and remind_state not in FOLLOWUP_STATES:
        raise HTTPException(
            400,
            f"remind_state 须为 {list(FOLLOWUP_STATES)} 之一，收到 {remind_state!r}",
        )
    q = db.query(Followup).filter_by(project_id=pid)
    if user_id:
        q = q.filter_by(user_id=user_id)
    if remind_state:
        q = q.filter(Followup.remind_state == remind_state)
    df, dt = parse_date(date_from or None), parse_date(date_to or None)
    if df:
        q = q.filter(
            or_(
                Followup.happened_at.is_(None),
                Followup.happened_at >= datetime(df.year, df.month, df.day),
            )
        )
    if dt:
        q = q.filter(
            or_(
                Followup.happened_at.is_(None),
                Followup.happened_at < datetime(dt.year, dt.month, dt.day, 23, 59, 59),
            )
        )

    def _f(f: Followup):
        return {
            "id": f.id,
            "user_id": f.user_id,
            "method": f.method,
            "content": f.content,
            "next_step": f.next_step,
            "remind_at": iso(f.remind_at),
            "remind_state": f.remind_state or "none",
            "reminded_at": iso(f.reminded_at),
            "handled_at": iso(f.handled_at),
            "handled_by": f.handled_by,
            "handle_note": f.handle_note or "",
            "happened_at": iso(f.happened_at),
        }

    return paginate(
        q,
        page=page,
        size=size,
        allowed=FOLLOWUP_SORTS,
        default_sort="-id",
        sort=sort,
        map_row=_f,
    )


@router.post("/{pid}/followups")
def create_followup(
    pid: int,
    body: FollowupIn,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """新建跟进：带 remind_at 时初始为 pending（待提醒），否则为 none（不参与提醒）。"""
    _get(db, pid, user, write=True)
    method = str(body.method or "").strip()
    if method and method not in FOLLOWUP_METHODS:
        raise HTTPException(
            400, f"跟进方式须为 {sorted(FOLLOWUP_METHODS)} 之一，收到 {method!r}"
        )
    if (
        body.remind_at is not None
        and body.happened_at
        and body.remind_at < body.happened_at
    ):
        raise HTTPException(400, "提醒时间不能早于跟进时间")
    # 入参带偏移（如 `Z` / `+00:00`）时按瞬时折算成北京时间墙钟：
    # 直接交给 PG 会按会话时区二次折算，同一请求在不同环境落不同的值（BLF-1138）。
    happened_at = to_db(body.happened_at)
    remind_at = to_db(body.remind_at)
    f = Followup(
        project_id=pid,
        user_id=user.id,
        happened_at=happened_at or app_now(),
        method=method,
        content=body.content,
        next_step=body.next_step,
        remind_at=remind_at,
        remind_state="pending" if remind_at else "none",
        created_at=app_now(),
    )
    db.add(f)
    db.flush()
    commit_audited(db, user.id, "create_followup", "followups", f.id, str(pid))
    return {"id": f.id, "remind_state": f.remind_state}


def _followup(db: Session, pid: int, fid: int, user: User):
    f = db.query(Followup).filter_by(id=fid, project_id=pid).first()
    if not f:
        raise HTTPException(404, "跟进记录不存在")
    if f.user_id != user.id and not is_admin(user):
        raise HTTPException(403, "仅记录人或管理员可修改")
    return f


@router.patch("/{pid}/followups/{fid}")
def update_followup(
    pid: int,
    fid: int,
    body: FollowupIn,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    _get(db, pid, user, write=True)
    f = _followup(db, pid, fid, user)
    method = body.method or f.method
    if method and method not in FOLLOWUP_METHODS:
        raise HTTPException(
            400, f"跟进方式须为 {sorted(FOLLOWUP_METHODS)} 之一，收到 {method!r}"
        )
    new_remind = to_db(body.remind_at)
    new_happened = to_db(body.happened_at)
    if (
        new_remind is not None
        and (new_happened or f.happened_at)
        and new_remind < (new_happened or f.happened_at)
    ):
        raise HTTPException(400, "提醒时间不能早于跟进时间")
    f.happened_at = new_happened or f.happened_at
    f.method = method
    f.content = body.content
    f.next_step = body.next_step
    f.remind_at = new_remind
    # 提醒时间被（重新）设定时回到「待提醒」；被清空时退出提醒队列
    if new_remind is None:
        f.remind_state = "none"
        f.reminded_at, f.handled_at, f.handled_by, f.handle_note = None, None, None, ""
    elif f.remind_state in ("none", None):
        f.remind_state = "pending"
        f.reminded_at, f.handled_at, f.handled_by, f.handle_note = None, None, None, ""
    commit_audited(db, user.id, "update_followup", "followups", fid, f"project={pid}")
    return {
        "id": f.id,
        "content": f.content,
        "next_step": f.next_step,
        "method": f.method,
        "remind_state": f.remind_state or "none",
        "happened_at": iso(f.happened_at),
        "remind_at": iso(f.remind_at),
    }


@router.post("/{pid}/followups/{fid}/remind")
def handle_followup_remind(
    pid: int,
    fid: int,
    body: dict,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """处理跟进提醒（记录人或管理员）：标记已处理/已忽略，或重新打开为待处理。

    这是「跟进到期通知可追踪」的写入端：处理状态与处理人、时间、备注一并落库，
    避免同一到期跟进反复出现在提醒队列里。
    """
    from ..core.jobs import handle_followup

    _get(db, pid, user, write=True)
    f = _followup(db, pid, fid, user)
    state = str(body.get("state", "done") or "done")
    if state not in FOLLOWUP_STATES:
        raise HTTPException(
            400, f"state 须为 {list(FOLLOWUP_STATES)} 之一，收到 {state!r}"
        )
    if not f.remind_at:
        raise HTTPException(400, "该跟进没有设置提醒时间，无需处理提醒")
    handle_followup(db, f, state, user.id, str(body.get("note", "") or ""))
    commit_audited(
        db,
        user.id,
        "handle_followup_remind",
        "followups",
        fid,
        f"state={state} project={pid}",
    )
    return {
        "id": f.id,
        "remind_state": f.remind_state,
        "handled_at": iso(f.handled_at),
        "handled_by": f.handled_by,
        "handle_note": f.handle_note or "",
    }


@router.delete("/{pid}/followups/{fid}")
def delete_followup(
    pid: int,
    fid: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    _get(db, pid, user, write=True)
    f = _followup(db, pid, fid, user)
    db.delete(f)
    db.flush()
    commit_audited(db, user.id, "delete_followup", "followups", fid, f"project={pid}")
    return {"ok": True}


@router.get("/{pid}/progress")
def project_progress(
    pid: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)
):
    """加权进度 Σ(进度×权重)/Σ权重（权重缺省均分）。"""
    p = _get(db, pid, user)
    tasks = db.query(Task).filter_by(project_id=pid).all()
    if not tasks:
        return {"project_id": pid, "progress": 0, "task_count": 0}
    num = sum((t.progress or 0) * (t.weight or 1) for t in tasks)
    den = sum((t.weight or 1) for t in tasks) or 1
    val = round(num / den, 2)
    p.progress = val
    db.commit()
    return {"project_id": pid, "progress": val, "task_count": len(tasks)}


@router.post("/{pid}/progress/confirm")
def confirm_progress(
    pid: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)
):
    """负责人一键确认快照：重算加权进度并写入 project_changes 留痕+审计。"""
    p = _get(db, pid, user, write=True)
    if user.id != p.owner_id and not is_admin(user):
        raise HTTPException(403, "仅负责人或管理员可确认")
    tasks = db.query(Task).filter_by(project_id=pid).all()
    num = sum((t.progress or 0) * (t.weight or 1) for t in tasks)
    den = sum((t.weight or 1) for t in tasks) or 1
    val = round(num / den, 2) if tasks else 0
    old = str(p.progress or 0)
    now = app_now()
    p.progress = val
    db.add(
        ProjectChange(
            project_id=pid,
            field="progress_snapshot",
            old=old,
            new=str(val),
            by_id=user.id,
            at=now,
        )
    )
    db.commit()
    write_audit(
        db,
        user.id,
        "confirm_progress",
        "projects",
        pid,
        f"snapshot {old}->{val} tasks={len(tasks)}",
    )
    return {
        "project_id": pid,
        "progress": val,
        "task_count": len(tasks),
        "confirmed_by": user.id,
        "confirmed_at": iso(now),
    }
