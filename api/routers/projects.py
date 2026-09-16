"""Stage 1：项目台账 CRUD + 状态机 + 变更留痕 + 附件 + 跟进 + 加权进度。"""
from datetime import date, datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy import or_, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..core.audit import commit_audited, write_audit
from ..core.database import ROOT, get_db, parse_date
from ..core.deps import get_current_user
from ..core.paging import DEFAULT_PAGE_SIZE, paginate
from ..core.rbac import (
    check_project_access,
    is_admin,
    project_scope_condition,
    require_admin,
)
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
    "id": Project.id, "code": Project.code, "name": Project.name,
    "status": Project.status, "priority": Project.priority,
    "budget_total": Project.budget_total, "progress": Project.progress,
    "plan_start": Project.plan_start, "plan_end": Project.plan_end,
    "created_at": Project.created_at, "dept_id": Project.dept_id,
    "owner_id": Project.owner_id,
}
FOLLOWUP_SORTS = {
    "id": Followup.id, "happened_at": Followup.happened_at,
    "remind_at": Followup.remind_at, "user_id": Followup.user_id,
    "method": Followup.method,
}

# 状态机：草稿/待立项审批/已立项/进行中/暂停/已完成/已归档/已取消
TRANSITIONS = {
    "draft": {"pending", "filed", "cancelled"},
    "pending": {"filed", "cancelled"},   # 立项审批（approval 开关开启时）
    "filed": {"doing", "cancelled"},
    "doing": {"paused", "done"},
    "paused": {"doing", "done"},
    "done": {"archived"},
    "archived": {"doing"},  # 管理员可解归档
    "cancelled": set(),
}
ALLOWED_EXT = {".pdf", ".docx", ".xlsx", ".png", ".jpg", ".jpeg"}
CONTRACT_STATUSES = {"已签订", "未签订"}
MAX_SIZE = 20 * 1024 * 1024


def _p(p: Project):
    return {"id": p.id, "code": p.code, "name": p.name, "type": p.type,
            "dept_id": p.dept_id, "owner_id": p.owner_id,
            "owner_name": p.owner_name or "",
            "member_ids": [m.user_id for m in p.members],
            "plan_start": p.plan_start.isoformat() if p.plan_start else None,
            "plan_end": p.plan_end.isoformat() if p.plan_end else None,
            "budget_total": p.budget_total, "priority": p.priority,
            "client": p.client, "description": p.description,
            "contract_status": p.contract_status or "",
            "forward_contract": p.forward_contract or "",
            "backward_contract": p.backward_contract or "",
            "status": p.status, "progress": p.progress}


def _next_code(db: Session) -> str:
    y = date.today().year
    prefix = f"PJ-{y}-"
    last = db.query(Project).filter(Project.code.like(prefix + "%")).order_by(Project.code.desc()).first()
    n = int(last.code.rsplit("-", 1)[1]) + 1 if last else 1
    return f"{prefix}{n:04d}"

def _get(db: Session, pid: int, user: User, write=False) -> Project:
    p = db.query(Project).filter_by(id=pid, deleted_at=None).first()
    if not p:
        raise HTTPException(404, "项目不存在")
    check_project_access(user, p, write=write, db=db)
    return p


def fts_search(db: Session, keyword: str, limit: int = 500) -> dict[int, str]:
    """FTS5 trigram 全文检索：返回 {project_id: 高亮片段}。

    trigram 分词器要求查询词 ≥3 字符，短词（1-2 字，如「示例」「改版」）
    无法命中，返回 {} 由调用方回退 LIKE。FTS 不可用环境同样返回 {}。
    """
    import re

    terms = [t for t in re.split(r"\s+", keyword.strip()) if t]
    if not terms or any(len(t) < 3 for t in terms):
        return {}   # 含短词：整体回退 LIKE，避免漏召回
    query = " OR ".join(f'"{t}"' for t in terms)
    try:
        rows = db.execute(
            text(
                "SELECT rowid, snippet(projects_fts, 0, '<mark>', '</mark>', '…', 12) "
                "FROM projects_fts WHERE projects_fts MATCH :q ORDER BY rank LIMIT :lim"
            ),
            {"q": query, "lim": limit},
        ).all()
    except Exception:
        return {}
    return {int(r[0]): (r[1] or "") for r in rows}


def keyword_condition(db: Session, keyword: str):
    """关键词过滤：优先 FTS5 命中 id 集合，失败/短词时回退 LIKE。返回 (条件, 片段表)。"""
    hits = fts_search(db, keyword)
    if hits:
        return Project.id.in_(list(hits.keys())), hits
    kw = f"%{keyword}%"
    return (or_(Project.name.like(kw), Project.code.like(kw),
                Project.client.like(kw), Project.description.like(kw))), {}


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
    description: str = ""
    contract_status: str = ""
    forward_contract: str = ""
    backward_contract: str = ""


def _code(value: str) -> str:
    return str(value or "").strip()


def _owner(db: Session, owner_id: int | None, owner_name: str) -> tuple[int | None, str]:
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
def list_projects(name: str = "", code: str = "", status: str = "", owner_id: int = 0,
                  dept_id: int = 0, keyword: str = "", date_from: str = "",
                  date_to: str = "", sort: str = "-id",
                  page: int = 1, size: int = DEFAULT_PAGE_SIZE,
                  db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """组合筛（名称/编号/状态/负责人/部门/关键字/计划时间）+ 统一分页信封。

    关键字优先 FTS5 全文检索（返回高亮片段），不可用时回退 LIKE。
    排序白名单见 `PROJECT_SORTS`，默认 `-id`（最新在前）；`size` 上限 100。
    """
    q = db.query(Project).filter(Project.deleted_at.is_(None))
    snips: dict[int, str] = {}
    if name:
        q = q.filter(Project.name.like(f"%{name}%"))
    if code:
        q = q.filter(Project.code.like(f"%{code}%"))
    if keyword:
        cond, snips = keyword_condition(db, keyword)
        q = q.filter(cond)
    if status:
        q = q.filter_by(status=status)
    if owner_id:
        q = q.filter_by(owner_id=owner_id)
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
        d = _p(p)
        if keyword and snips:
            d["snippet"] = snips.get(p.id, "")
        return d

    return paginate(q, page=page, size=size, allowed=PROJECT_SORTS,
                    default_sort="-id", sort=sort, map_row=_row)


@router.get("/options")
def project_options(keyword: str = "", status: str = "", owner_id: int = 0,
                    sort: str = "-id", page: int = 1, size: int = DEFAULT_PAGE_SIZE,
                    db: Session = Depends(get_db),
                    user: User = Depends(get_current_user)):
    """项目选择器专用：最小字段 + 关键词分页，替代前端 `?size=100` 全量下拉。

    只返回 id/code/name/status/owner_id/dept_id（不含描述、成员等大字段），
    权限与软删除边界与 `GET /projects` 完全一致（同一次可见性下推）。
    关键词按「名称/编号」模糊匹配（选择器实际输入的就是项目名或编号）：
    不走 FTS——FTS 命中集预先截断为 500 条，会让分页的 `total` 失真。
    注意：本路由必须定义在 `/{pid}` 之前，否则会被单段路径参数抢先匹配。
    """
    q = db.query(Project.id, Project.code, Project.name, Project.status,
                 Project.owner_id, Project.dept_id).filter(Project.deleted_at.is_(None))
    if keyword:
        like = f"%{keyword}%"
        q = q.filter(or_(Project.name.like(like), Project.code.like(like)))
    if status:
        q = q.filter(Project.status == status)
    if owner_id:
        q = q.filter(Project.owner_id == owner_id)
    vis = project_scope_condition(user, db)   # 含演示数据开关
    if vis is not None:
        q = q.filter(vis)

    def _opt(r):
        return {"id": r.id, "code": r.code, "name": r.name, "status": r.status,
                "owner_id": r.owner_id, "dept_id": r.dept_id}

    return paginate(q, page=page, size=size, allowed=PROJECT_SORTS,
                    default_sort="-id", sort=sort, map_row=_opt)


@router.post("")
def create_project(body: ProjectIn, db: Session = Depends(get_db),
                   user: User = Depends(get_current_user)):
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
            p = Project(code=code or _next_code(db), name=body.name, type=body.type,
                        dept_id=body.dept_id if body.dept_id else user.dept_id,
                        owner_id=owner_id or user.id, owner_name=owner_name,
                        plan_start=body.plan_start,
                        plan_end=body.plan_end, budget_total=body.budget_total,
                        priority=body.priority, client=body.client,
                        description=body.description,
                        contract_status=body.contract_status,
                        forward_contract=body.forward_contract,
                        backward_contract=body.backward_contract,
                        status="pending" if filing_on else "draft",
                        created_by=user.id)
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
                record_timeline(db, KIND_PROJECT_FILING, p.id, ACTION_SUBMIT,
                                from_status="draft", to_status="pending",
                                project_id=p.id, actor_id=user.id)
                push_many(db, approval_recipients(db), "approval",
                          f"立项审批待处理：{p.name}",
                          f"编号 {p.code}，预算 {p.budget_total}",
                          ref_type="project", ref_id=p.id, project_id=p.id,
                          dedup_key=f"filing-request:{p.id}")
            db.flush()
            commit_audited(db, user.id, "create_project", "projects", p.id, p.code)
            break
        except HTTPException:
            db.rollback()
            raise
        except IntegrityError:   # 编号唯一索引冲突 → 重试取号
            db.rollback()
            continue
        except Exception:
            db.rollback()
            raise
    else:
        raise HTTPException(500, "编号生成冲突，请重试")
    return _p(db.query(Project).filter_by(id=p.id).first())


@router.get("/{pid}")
def get_project(pid: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    return _p(_get(db, pid, user))


@router.patch("/{pid}")
def update_project(pid: int, body: dict, db: Session = Depends(get_db),
                   user: User = Depends(get_current_user)):
    p = _get(db, pid, user, write=True)
    if p.status == "archived":
        raise HTTPException(400, "已归档项目只读")
    allowed = {"code", "name", "type", "dept_id", "owner_id", "owner_name",
               "plan_start", "plan_end", "budget_total", "priority", "client",
               "description", "contract_status", "forward_contract", "backward_contract"}
    now = datetime.now(timezone.utc)
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
            owner_id, owner_name = _owner(db, int(v) if v else None, body.get("owner_name", p.owner_name))
            if owner_id != p.owner_id:
                old_owner = p.owner_id
                p.owner_id = owner_id
                db.add(ProjectChange(project_id=pid, field="owner_id", old=str(old_owner or ""),
                                     new=str(owner_id or ""), by_id=user.id, at=now))
            if owner_name != (p.owner_name or ""):
                p.owner_name = owner_name
                db.add(ProjectChange(project_id=pid, field="owner_name", old="", new=owner_name,
                                     by_id=user.id, at=now))
            continue
        if f == "owner_name":
            v = str(v or "").strip()
        if f in ("plan_start", "plan_end"):
            v = parse_date(v)
        old = getattr(p, f)
        old_s = old.isoformat() if isinstance(old, date) else str(old if old is not None else "")
        if str(v or "") != old_s:
            if f == "name" and db.query(Project).filter(Project.name == v, Project.id != pid).first():
                raise HTTPException(400, "项目名称已存在")
            setattr(p, f, v)
            db.add(ProjectChange(project_id=pid, field=f, old=old_s, new=str(v or ""),
                                 by_id=user.id, at=now))
    if "member_ids" in body:
        db.query(ProjectMember).filter_by(project_id=pid).delete()
        for uid in set(body["member_ids"]) | ({p.owner_id} if p.owner_id else set()):
            if db.query(User).filter_by(id=uid).first():
                db.add(ProjectMember(project_id=pid, user_id=uid))
        db.add(ProjectChange(project_id=pid, field="member_ids", old="", new=str(body["member_ids"]),
                             by_id=user.id, at=now))
    if p.owner_id and "member_ids" not in body:
        db.add(ProjectMember(project_id=pid, user_id=p.owner_id)) if not db.query(ProjectMember).filter_by(
            project_id=pid, user_id=p.owner_id).first() else None
    commit_audited(db, user.id, "update_project", "projects", pid, str(list(body.keys())))
    return _p(p)


@router.post("/{pid}/status")
def change_status(pid: int, body: dict, db: Session = Depends(get_db),
                  user: User = Depends(get_current_user)):
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
    now = datetime.now(timezone.utc)
    db.add(ProjectChange(project_id=pid, field="status", old=old, new=to,
                         by_id=user.id, at=now))
    # 立项审批的最终状态也进时间线（申请人可查「谁在什么时候批/驳了什么」）
    if old in ("pending", "draft") and to in ("filed", "cancelled"):
        from ..core.timeline import (ACTION_APPROVE, ACTION_REJECT, ACTION_SUBMIT,
                                     KIND_PROJECT_FILING, record as record_timeline)
        record_timeline(db, KIND_PROJECT_FILING, pid, ACTION_SUBMIT, from_status="draft",
                        to_status="pending", project_id=pid, actor_id=p.owner_id)
        record_timeline(db, KIND_PROJECT_FILING, pid,
                        ACTION_APPROVE if to == "filed" else ACTION_REJECT,
                        from_status="pending", to_status=to, project_id=pid,
                        actor_id=user.id, reason=reason)
    commit_audited(db, user.id, "project_status", "projects", pid, f"{old}->{to} {reason}")
    return _p(p)


@router.get("/{pid}/changes")
def list_changes(pid: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    _get(db, pid, user)
    rows = db.query(ProjectChange).filter_by(project_id=pid).order_by(ProjectChange.id.desc()).all()
    return [{"id": c.id, "field": c.field, "old": c.old, "new": c.new,
             "by_id": c.by_id, "at": c.at.isoformat() if c.at else None} for c in rows]


@router.post("/{pid}/attachments")
def upload(pid: int, file: UploadFile = File(...), ref_type: str = Form(""),
           db: Session = Depends(get_db),
           user: User = Depends(get_current_user)):
    p = _get(db, pid, user, write=True)
    if p.status == "archived":
        raise HTTPException(400, "已归档禁传附件")
    ext = Path(file.filename or "").suffix.lower()
    if ext not in ALLOWED_EXT:
        raise HTTPException(400, f"仅允许 {sorted(ALLOWED_EXT)}")
    data = file.file.read()
    if len(data) > MAX_SIZE:
        raise HTTPException(400, "单文件最大 20MB")
    if ref_type not in ("", "contract"):
        raise HTTPException(400, "附件类型不支持")
    d = ROOT / "data" / "files" / str(pid) / (ref_type or "project")
    d.mkdir(parents=True, exist_ok=True)
    fp = d / file.filename
    fp.write_bytes(data)
    a = Attachment(project_id=pid, filename=file.filename, path=str(fp),
                   size=len(data), content_type=file.content_type or "",
                   uploaded_by=user.id, uploaded_at=datetime.now(timezone.utc),
                   ref_type=ref_type, ref_id=None)
    db.add(a)
    db.flush()
    commit_audited(db, user.id, "upload_attachment", "attachments", a.id, file.filename)
    return {"id": a.id, "filename": a.filename, "size": a.size}


@router.get("/{pid}/attachments")
def list_attachments(pid: int, ref_type: str = "", db: Session = Depends(get_db),
                     user: User = Depends(get_current_user)):
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
    return [{"id": a.id, "filename": a.filename, "size": a.size,
             "ref_type": a.ref_type or "",
             "content_type": a.content_type or "",
             "uploaded_by": a.uploaded_by,
             "uploaded_at": a.uploaded_at.isoformat() if a.uploaded_at else None}
            for a in rows]


@router.get("/{pid}/attachments/{aid}/download")
def download_attachment(pid: int, aid: int, db: Session = Depends(get_db),
                        user: User = Depends(get_current_user)):
    """附件下载：校验项目可见性 + 附件归属，防越权取件。

    只允许项目级附件；支出凭证要经 `/expenses/{id}/vouchers/{aid}/download` 取，
    以保证「支出可见性」与「凭证可见性」永远同源。
    """
    from urllib.parse import quote

    _get(db, pid, user)
    a = db.query(Attachment).filter(
        Attachment.id == aid, Attachment.project_id == pid,
        or_(Attachment.ref_type.in_(("", "contract")), Attachment.ref_type.is_(None)),
    ).first()
    if not a:
        raise HTTPException(404, "附件不存在")
    fp = Path(a.path)
    if not fp.exists():
        raise HTTPException(404, "附件文件已丢失，请联系管理员")
    write_audit(db, user.id, "download_attachment", "attachments", a.id, a.filename)
    return FileResponse(
        fp,
        media_type=a.content_type or "application/octet-stream",
        filename=a.filename,
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(a.filename)}"},
    )


@router.delete("/{pid}/attachments/{aid}")
def delete_attachment(pid: int, aid: int, db: Session = Depends(get_db),
                      user: User = Depends(get_current_user)):
    """删除附件：项目可写者或上传者本人，同时清理磁盘文件。只限项目级附件。"""
    _get(db, pid, user, write=True)
    a = db.query(Attachment).filter(
        Attachment.id == aid, Attachment.project_id == pid,
        or_(Attachment.ref_type.in_(("", "contract")), Attachment.ref_type.is_(None)),
    ).first()
    if not a:
        raise HTTPException(404, "附件不存在")
    if a.uploaded_by != user.id and not is_admin(user):
        raise HTTPException(403, "仅上传者或管理员可删除附件")
    try:
        Path(a.path).unlink(missing_ok=True)
    except OSError:
        pass
    name = a.filename
    db.delete(a)
    db.flush()
    commit_audited(db, user.id, "delete_attachment", "attachments", aid, name)
    return {"ok": True}


@router.put("/{pid}/members")
def set_members(pid: int, body: dict, db: Session = Depends(get_db),
                user: User = Depends(get_current_user)):
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
    old = sorted({m.user_id for m in db.query(ProjectMember).filter_by(project_id=pid).all()})
    db.query(ProjectMember).filter_by(project_id=pid).delete()
    for uid in wanted:
        db.add(ProjectMember(project_id=pid, user_id=uid))
    db.add(ProjectChange(project_id=pid, field="members",
                         old=",".join(map(str, old)), new=",".join(map(str, sorted(wanted))),
                         by_id=user.id, at=datetime.now(timezone.utc)))
    db.commit()
    write_audit(db, user.id, "set_members", "projects", pid, f"{old}->{sorted(wanted)}")
    return _p(db.query(Project).filter_by(id=pid).first())


@router.delete("/{pid}")
def delete_project(pid: int, db: Session = Depends(get_db),
                   user: User = Depends(get_current_user)):
    """软删除项目：仅管理员，数据保留可恢复（回收站见 GET /projects/recycle-bin）。"""
    require_admin(user)
    p = db.query(Project).filter_by(id=pid, deleted_at=None).first()
    if not p:
        raise HTTPException(404, "项目不存在")
    if p.status in ("doing", "filed"):
        raise HTTPException(400, "进行中/已立项项目不可删除，请先取消或归档")
    p.deleted_at = datetime.now(timezone.utc)
    db.commit()
    write_audit(db, user.id, "delete_project", "projects", pid, p.code)
    return {"ok": True, "id": pid}


@router.post("/{pid}/restore")
def restore_project(pid: int, db: Session = Depends(get_db),
                    user: User = Depends(get_current_user)):
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
def recycle_bin(sort: str = "-deleted_at", page: int = 1, size: int = DEFAULT_PAGE_SIZE,
                db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """回收站列表（仅管理员）：正常业务列表不看已软删除项目，回收站单独查看与恢复。

    统一分页信封；排序白名单 `id` / `deleted_at` / `code` / `name`，默认按删除时间倒序。
    """
    require_admin(user)
    q = db.query(Project).filter(Project.deleted_at.isnot(None))

    def _row(p: Project):
        return {"id": p.id, "code": p.code, "name": p.name, "status": p.status,
                "deleted_at": p.deleted_at.isoformat() if p.deleted_at else None}

    return paginate(q, page=page, size=size,
                    allowed={"id": Project.id, "deleted_at": Project.deleted_at,
                             "code": Project.code, "name": Project.name},
                    default_sort="-deleted_at", sort=sort, map_row=_row)


class FollowupIn(BaseModel):
    happened_at: datetime | None = None
    method: str = ""
    content: str = ""
    next_step: str = ""
    remind_at: datetime | None = None


FOLLOWUP_METHODS = {"电话", "会议", "现场", "邮件", "其他"}
FOLLOWUP_STATES = ("pending", "done", "ignored")


@router.get("/{pid}/followups")
def list_followups(pid: int, user_id: int = 0, date_from: str = "", date_to: str = "",
                   remind_state: str = "", sort: str = "-id", page: int = 1,
                   size: int = DEFAULT_PAGE_SIZE,
                   db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """跟进列表：按人/时间/提醒状态筛 + 统一分页信封（默认 `-id`，最新在前）。

    `remind_state` 区分跟进提醒的可追踪状态（pending 待处理 / done 已通知或已处理 / ignored 已忽略），
    remind 定时扫描见 `core.jobs.due_followups`，每 10min。
    """
    _get(db, pid, user)
    if remind_state and remind_state not in FOLLOWUP_STATES:
        raise HTTPException(400, f"remind_state 须为 {list(FOLLOWUP_STATES)} 之一，收到 {remind_state!r}")
    q = db.query(Followup).filter_by(project_id=pid)
    if user_id:
        q = q.filter_by(user_id=user_id)
    if remind_state:
        q = q.filter(Followup.remind_state == remind_state)
    df, dt = parse_date(date_from or None), parse_date(date_to or None)
    if df:
        q = q.filter(or_(Followup.happened_at.is_(None),
                         Followup.happened_at >= datetime(df.year, df.month, df.day)))
    if dt:
        q = q.filter(or_(Followup.happened_at.is_(None),
                         Followup.happened_at < datetime(dt.year, dt.month, dt.day, 23, 59, 59)))

    def _f(f: Followup):
        return {"id": f.id, "user_id": f.user_id, "method": f.method, "content": f.content,
                "next_step": f.next_step,
                "remind_at": f.remind_at.isoformat() if f.remind_at else None,
                "remind_state": f.remind_state or "none",
                "reminded_at": f.reminded_at.isoformat() if f.reminded_at else None,
                "handled_at": f.handled_at.isoformat() if f.handled_at else None,
                "handled_by": f.handled_by,
                "handle_note": f.handle_note or "",
                "happened_at": f.happened_at.isoformat() if f.happened_at else None}

    return paginate(q, page=page, size=size, allowed=FOLLOWUP_SORTS,
                    default_sort="-id", sort=sort, map_row=_f)


@router.post("/{pid}/followups")
def create_followup(pid: int, body: FollowupIn, db: Session = Depends(get_db),
                    user: User = Depends(get_current_user)):
    """新建跟进：带 remind_at 时初始为 pending（待提醒），否则为 none（不参与提醒）。"""
    _get(db, pid, user, write=True)
    method = str(body.method or "").strip()
    if method and method not in FOLLOWUP_METHODS:
        raise HTTPException(400, f"跟进方式须为 {sorted(FOLLOWUP_METHODS)} 之一，收到 {method!r}")
    if body.remind_at is not None and body.happened_at and body.remind_at < body.happened_at:
        raise HTTPException(400, "提醒时间不能早于跟进时间")
    f = Followup(project_id=pid, user_id=user.id,
                 happened_at=body.happened_at or datetime.now(timezone.utc),
                 method=method, content=body.content,
                 next_step=body.next_step, remind_at=body.remind_at,
                 remind_state="pending" if body.remind_at else "none",
                 created_at=datetime.now(timezone.utc))
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
def update_followup(pid: int, fid: int, body: FollowupIn, db: Session = Depends(get_db),
                    user: User = Depends(get_current_user)):
    _get(db, pid, user, write=True)
    f = _followup(db, pid, fid, user)
    method = body.method or f.method
    if method and method not in FOLLOWUP_METHODS:
        raise HTTPException(400, f"跟进方式须为 {sorted(FOLLOWUP_METHODS)} 之一，收到 {method!r}")
    new_remind = body.remind_at
    if new_remind is not None and (body.happened_at or f.happened_at) \
            and new_remind < (body.happened_at or f.happened_at):
        raise HTTPException(400, "提醒时间不能早于跟进时间")
    f.happened_at = body.happened_at or f.happened_at
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
    return {"id": f.id, "content": f.content, "next_step": f.next_step, "method": f.method,
            "remind_state": f.remind_state or "none",
            "happened_at": f.happened_at.isoformat() if f.happened_at else None,
            "remind_at": f.remind_at.isoformat() if f.remind_at else None}


@router.post("/{pid}/followups/{fid}/remind")
def handle_followup_remind(pid: int, fid: int, body: dict, db: Session = Depends(get_db),
                           user: User = Depends(get_current_user)):
    """处理跟进提醒（记录人或管理员）：标记已处理/已忽略，或重新打开为待处理。

    这是「跟进到期通知可追踪」的写入端：处理状态与处理人、时间、备注一并落库，
    避免同一到期跟进反复出现在提醒队列里。
    """
    from ..core.jobs import handle_followup

    _get(db, pid, user, write=True)
    f = _followup(db, pid, fid, user)
    state = str(body.get("state", "done") or "done")
    if state not in FOLLOWUP_STATES:
        raise HTTPException(400, f"state 须为 {list(FOLLOWUP_STATES)} 之一，收到 {state!r}")
    if not f.remind_at:
        raise HTTPException(400, "该跟进没有设置提醒时间，无需处理提醒")
    handle_followup(db, f, state, user.id, str(body.get("note", "") or ""))
    commit_audited(db, user.id, "handle_followup_remind", "followups", fid,
                   f"state={state} project={pid}")
    return {"id": f.id, "remind_state": f.remind_state,
            "handled_at": f.handled_at.isoformat() if f.handled_at else None,
            "handled_by": f.handled_by, "handle_note": f.handle_note or ""}


@router.delete("/{pid}/followups/{fid}")
def delete_followup(pid: int, fid: int, db: Session = Depends(get_db),
                    user: User = Depends(get_current_user)):
    _get(db, pid, user, write=True)
    f = _followup(db, pid, fid, user)
    db.delete(f)
    db.flush()
    commit_audited(db, user.id, "delete_followup", "followups", fid, f"project={pid}")
    return {"ok": True}


@router.get("/{pid}/progress")
def project_progress(pid: int, db: Session = Depends(get_db),
                     user: User = Depends(get_current_user)):
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
def confirm_progress(pid: int, db: Session = Depends(get_db),
                     user: User = Depends(get_current_user)):
    """负责人一键确认快照：重算加权进度并写入 project_changes 留痕+审计。"""
    p = _get(db, pid, user, write=True)
    if user.id != p.owner_id and not is_admin(user):
        raise HTTPException(403, "仅负责人或管理员可确认")
    tasks = db.query(Task).filter_by(project_id=pid).all()
    num = sum((t.progress or 0) * (t.weight or 1) for t in tasks)
    den = sum((t.weight or 1) for t in tasks) or 1
    val = round(num / den, 2) if tasks else 0
    old = str(p.progress or 0)
    now = datetime.now(timezone.utc)
    p.progress = val
    db.add(ProjectChange(project_id=pid, field="progress_snapshot", old=old,
                         new=str(val), by_id=user.id, at=now))
    db.commit()
    write_audit(db, user.id, "confirm_progress", "projects", pid,
                f"snapshot {old}->{val} tasks={len(tasks)}")
    return {"project_id": pid, "progress": val, "task_count": len(tasks),
            "confirmed_by": user.id, "confirmed_at": now.isoformat()}
