"""Stage 2 / Stage 4A：WBS 任务（5 级/环检测）+ 填报 + Excel 导入。

Stage 4A 补齐的服务端校验（全部在任何写库动作之前执行，非法请求零副作用）：
  · 日期：计划开始不得晚于计划结束，且任务计划区间须落在项目计划区间内；
  · 权重：严格大于 0 的有限数字；
  · 进度：0-100 的有限数字（NaN / Infinity 一律 400）；
  · 状态：只允许 todo/doing/paused/done 之间的合法流转；
  · 父子任务：父任务必须属于同一项目，层级不超过 5 级；
  · 依赖：前置任务必须同项目、不得成环，且**前置未完成时不得将任务置为 done**。

填报历史（progress_logs）的不可覆盖性：
  · `/progress-logs` 只提供创建与查询，没有任何 update / delete 接口 —— 历史只能追加；
  · 任务上的 `progress` 是「最新填报的快照」，任何进度变化都会同时追加一条 log；
  · 因此 `progress` 永远可由 log 序列复现，不存在「历史被直接改写」的路径。
"""
from datetime import date, datetime, timezone

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..core.audit import commit_audited, write_audit
from ..core.database import get_db, parse_date
from ..core.deps import get_current_user
from ..core.paging import DEFAULT_PAGE_SIZE, paginate
from ..core.rbac import get_active_project, is_admin, scope_child_query
from ..core.validation import (check_date_range, check_progress, check_weight,
                               as_number)
from ..models import ProgressLog, Project, Task, User

router = APIRouter(prefix="", tags=["tasks"])

MAX_LEVEL = 5

# 任务状态机（Stage 4A）：与前端 TASK_STATUS_ORDER 对齐
TASK_STATUS = ("todo", "doing", "paused", "done")
TASK_TRANSITIONS = {
    "todo": {"doing", "paused", "done"},
    "doing": {"todo", "paused", "done"},
    "paused": {"todo", "doing", "done"},
    "done": {"doing", "todo"},   # 允许回退：验收后发现返工是真实场景，但必须留痕
}

# 排序白名单（Stage 3A）：字段名 → ORM 列
TASK_SORTS = {
    "id": Task.id, "project_id": Task.project_id, "name": Task.name,
    "level": Task.level, "status": Task.status, "progress": Task.progress,
    "weight": Task.weight, "plan_start": Task.plan_start,
    "plan_end": Task.plan_end, "owner_id": Task.owner_id,
}
LOG_SORTS = {
    "id": ProgressLog.id, "task_id": ProgressLog.task_id,
    "project_id": ProgressLog.project_id, "progress": ProgressLog.progress,
    "created_at": ProgressLog.created_at,
}


def _t(t: Task):
    return {"id": t.id, "project_id": t.project_id, "parent_id": t.parent_id,
            "level": t.level, "name": t.name, "owner_id": t.owner_id,
            "plan_start": t.plan_start.isoformat() if t.plan_start else None,
            "plan_end": t.plan_end.isoformat() if t.plan_end else None,
            "weight": t.weight, "progress": t.progress, "status": t.status,
            "predecessor_id": t.predecessor_id,
            "created_at": t.created_at.isoformat() if t.created_at else None}


def _project(db: Session, pid: int, user: User, write=False) -> Project:
    """子表接口的项目边界：未软删除 + 参与人校验（软删除项目一律 404）。"""
    return get_active_project(db, pid, user, write=write)


def _name(value) -> str:
    name = str(value or "").strip()
    if not name:
        raise HTTPException(400, "任务名称必填")
    if len(name) > 128:
        raise HTTPException(400, "任务名称最多 128 个字符")
    return name


def _check_cycle(db: Session, task_id: int | None, predecessor_id: int | None, project_id: int):
    """前置依赖成环检测（含跨项目前置一律拒绝）。"""
    seen, cur = set(), predecessor_id
    while cur:
        if cur == task_id or cur in seen:
            raise HTTPException(400, "前置依赖存在环，已拦截")
        seen.add(cur)
        pre = db.query(Task).filter_by(id=cur, project_id=project_id).first()
        if not pre:
            raise HTTPException(400, "前置任务须为同一项目")
        cur = pre.predecessor_id


def _check_predecessor(db: Session, predecessor_id: int | None, project_id: int) -> Task | None:
    """前置任务存在性 + 同项目校验。返回前置任务或 None。"""
    if not predecessor_id:
        return None
    pre = db.query(Task).filter_by(id=predecessor_id).first()
    if not pre or pre.project_id != project_id:
        raise HTTPException(400, "前置任务须为同一项目")
    return pre


def _check_parent(db: Session, parent_id: int | None, project_id: int) -> Task | None:
    """父任务存在性 + 同项目校验（不回显他人项目是否存在的额外信息）。"""
    if not parent_id:
        return None
    parent = db.query(Task).filter_by(id=parent_id, project_id=project_id).first()
    if not parent:
        raise HTTPException(400, "父任务不存在或不属于本项目")
    return parent


def _check_task_dates(plan_start: date | None, plan_end: date | None, project: Project) -> None:
    """任务计划区间自洽，且不越出项目计划区间。"""
    check_date_range(plan_start, plan_end, start_field="计划开始", end_field="计划结束")
    if plan_start and project.plan_start and plan_start < project.plan_start:
        raise HTTPException(400, "任务计划开始不能早于项目计划开始")
    if plan_end and project.plan_end and plan_end > project.plan_end:
        raise HTTPException(400, "任务计划结束不能晚于项目计划结束")


def _check_status_transition(t: Task, to: str) -> None:
    if to not in TASK_STATUS:
        raise HTTPException(400, f"任务状态须为 {list(TASK_STATUS)} 之一，收到 {to!r}")
    if to == t.status:
        return
    if to not in TASK_TRANSITIONS.get(t.status, set()):
        raise HTTPException(400, f"不允许任务从 {t.status} 流转到 {to}")


def _check_dependency_ready(db: Session, t: Task, to_status: str | None,
                            progress: float | None) -> None:
    """依赖一致性：前置任务未完成时，不得把任务置为 done / 100%。"""
    if not t.predecessor_id:
        return
    finishing = to_status == "done" or (progress is not None and progress >= 100)
    if not finishing:
        return
    pre = db.query(Task).filter_by(id=t.predecessor_id).first()
    if pre and ((pre.progress or 0) < 100 and pre.status != "done"):
        raise HTTPException(400, "前置任务尚未完成，不能将本任务标记为完成")


class TaskIn(BaseModel):
    project_id: int
    parent_id: int | None = None
    name: str
    owner_id: int | None = None
    plan_start: date | None = None
    plan_end: date | None = None
    weight: float = 1
    predecessor_id: int | None = None


@router.get("/tasks")
def list_tasks(project_id: int = 0, status: str = "", owner_id: int = 0, keyword: str = "",
               sort: str = "id", page: int = 1, size: int = DEFAULT_PAGE_SIZE,
               db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """任务列表：统一分页信封 + 排序白名单（默认 `id` 升序，保持既有任务序）。

    · 带 `project_id` → 先做单次项目鉴权，再按项目取数；
    · 不带 `project_id` → 「可见 + 未软删除」项目集合直接下推 SQL；
    · `keyword` 按任务名模糊匹配；`owner_id` / `status` 为等值筛选。
    """
    q = db.query(Task)
    if project_id:
        _project(db, project_id, user)   # 单次项目鉴权
        q = q.filter(Task.project_id == project_id)
    else:
        q = scope_child_query(q, Task, db, user)
    if status:
        q = q.filter(Task.status == status)
    if owner_id:
        q = q.filter(Task.owner_id == owner_id)
    if keyword:
        q = q.filter(Task.name.like(f"%{keyword}%"))
    return paginate(q, page=page, size=size, allowed=TASK_SORTS,
                    default_sort="id", sort=sort, map_row=_t)


@router.post("/tasks")
def create_task(body: TaskIn, db: Session = Depends(get_db),
                user: User = Depends(get_current_user)):
    """新建任务：全部校验先于任何写库动作（校验失败零副作用）。"""
    p = _project(db, body.project_id, user, write=True)
    if p.status == "archived":
        raise HTTPException(400, "已归档项目只读")
    name = _name(body.name)
    weight = check_weight(body.weight if body.weight is not None else 1)
    _check_task_dates(body.plan_start, body.plan_end, p)

    parent = _check_parent(db, body.parent_id, body.project_id)
    level = (parent.level + 1) if parent else 1
    if level > MAX_LEVEL:
        raise HTTPException(400, f"任务层级最多 {MAX_LEVEL} 级")

    _check_cycle(db, None, body.predecessor_id, body.project_id)
    pre = _check_predecessor(db, body.predecessor_id, body.project_id)
    warn = "前置任务尚未完成" if pre and (pre.progress or 0) < 100 and pre.status != "done" else ""

    if body.owner_id and not db.query(User).filter_by(id=body.owner_id).first():
        raise HTTPException(400, "负责人不存在")

    t = Task(project_id=body.project_id, parent_id=body.parent_id, level=level,
             name=name, owner_id=body.owner_id or user.id,
             plan_start=body.plan_start, plan_end=body.plan_end,
             weight=weight, predecessor_id=body.predecessor_id)
    db.add(t)
    db.flush()
    commit_audited(db, user.id, "create_task", "tasks", t.id, name)
    r = _t(t)
    r["warn"] = warn
    return r


@router.patch("/tasks/{tid}")
def update_task(tid: int, body: dict, db: Session = Depends(get_db),
                user: User = Depends(get_current_user)):
    """更新任务：先做完整校验（含新父任务、新前置依赖、日期区间、状态流转与依赖一致性），
    再一次性赋值提交。任何一项校验失败都不会留下部分修改。"""
    t = db.query(Task).filter_by(id=tid).first()
    if not t:
        raise HTTPException(404, "任务不存在")
    p = _project(db, t.project_id, user, write=True)

    unknown = set(body) - {"name", "owner_id", "plan_start", "plan_end", "weight",
                           "status", "predecessor_id", "parent_id", "progress", "note"}
    if unknown:
        raise HTTPException(400, f"不支持的字段：{sorted(unknown)}")

    # ---- 1) 把入参解析成候选值（不落库） ----
    new_name = _name(body["name"]) if "name" in body else t.name
    new_weight = check_weight(body["weight"]) if "weight" in body else (t.weight or 1)
    new_start = parse_date(body["plan_start"]) if "plan_start" in body else t.plan_start
    new_end = parse_date(body["plan_end"]) if "plan_end" in body else t.plan_end
    new_progress = None
    if "progress" in body:
        new_progress = check_progress(body["progress"])

    # ---- 2) 校验 ----
    _check_task_dates(new_start, new_end, p)

    new_parent_id = t.parent_id
    if "parent_id" in body:
        candidate = body["parent_id"]
        new_parent_id = int(candidate) if candidate not in (None, "", 0) else None
        if new_parent_id == tid:
            raise HTTPException(400, "父任务不能是任务自身")
        parent = _check_parent(db, new_parent_id, t.project_id)
        level = (parent.level + 1) if parent else 1
        if level > MAX_LEVEL:
            raise HTTPException(400, f"任务层级最多 {MAX_LEVEL} 级")
        # 新父任务不能是自己的子孙（否则形成父子环）
        child_ids, stack = set(), [tid]
        while stack:
            cur = stack.pop()
            for (cid,) in db.query(Task.id).filter(Task.parent_id == cur).all():
                if cid not in child_ids:
                    child_ids.add(cid)
                    stack.append(cid)
        if new_parent_id in child_ids:
            raise HTTPException(400, "父任务不能是本任务的子任务")

    if "predecessor_id" in body:
        _check_cycle(db, tid, body["predecessor_id"], t.project_id)
        _check_predecessor(db, body["predecessor_id"], t.project_id)

    if "status" in body:
        _check_status_transition(t, body["status"])
    _check_dependency_ready(db, t, body.get("status"), new_progress)

    if "owner_id" in body and body["owner_id"]:
        if not db.query(User).filter_by(id=body["owner_id"]).first():
            raise HTTPException(400, "负责人不存在")

    # ---- 3) 校验全过才赋值 ----
    t.name = new_name
    if "owner_id" in body:
        t.owner_id = body["owner_id"] or None
    t.plan_start, t.plan_end = new_start, new_end
    t.weight = new_weight
    if new_parent_id != t.parent_id:
        t.parent_id = new_parent_id
        parent = db.query(Task).filter_by(id=new_parent_id).first() if new_parent_id else None
        t.level = (parent.level + 1) if parent else 1
    if "predecessor_id" in body:
        t.predecessor_id = body["predecessor_id"] or None
    if "status" in body:
        t.status = body["status"]
    if new_progress is not None:
        # 进度变化必须追加历史（历史只能追加，不可覆盖）
        t.progress = new_progress
        db.add(ProgressLog(task_id=tid, project_id=t.project_id, user_id=user.id,
                           progress=new_progress, note=body.get("note", ""),
                           created_at=datetime.now(timezone.utc)))

    commit_audited(db, user.id, "update_task", "tasks", tid, str(sorted(body.keys())))
    return _t(t)


@router.delete("/tasks/{tid}")
def delete_task(tid: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    t = db.query(Task).filter_by(id=tid).first()
    if not t:
        raise HTTPException(404, "任务不存在")
    _project(db, t.project_id, user, write=True)
    # 删除前先清空指向本任务的前置依赖，避免留下悬挂引用
    db.query(Task).filter(Task.predecessor_id == tid).update({"predecessor_id": None})
    db.delete(t)
    commit_audited(db, user.id, "delete_task", "tasks", tid, t.name)
    return {"ok": True}


class LogIn(BaseModel):
    task_id: int
    progress: float
    note: str = ""
    remaining_days: int | None = None


def _log(l: ProgressLog):
    return {"id": l.id, "task_id": l.task_id, "project_id": l.project_id,
            "user_id": l.user_id, "progress": l.progress, "note": l.note,
            "remaining_days": l.remaining_days,
            "created_at": l.created_at.isoformat() if l.created_at else None}


@router.get("/progress-logs")
def list_logs(task_id: int = 0, project_id: int = 0, sort: str = "-id",
              page: int = 1, size: int = DEFAULT_PAGE_SIZE,
              db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """填报历史（只读）：task_id / project_id 均需可见；两者都不传时只返回可见项目的记录。

    历史不可改写：本接口只有 GET，没有对应的 PATCH / DELETE —— 填报记录只能追加。
    """
    q = db.query(ProgressLog)
    if task_id:
        t = db.query(Task).filter_by(id=task_id).first()
        if not t:
            raise HTTPException(404, "任务不存在")
        _project(db, t.project_id, user)
        q = q.filter(ProgressLog.task_id == task_id)
    if project_id:
        _project(db, project_id, user)
        q = q.filter(ProgressLog.project_id == project_id)
    if not task_id and not project_id:
        q = scope_child_query(q, ProgressLog, db, user)
    return paginate(q, page=page, size=size, allowed=LOG_SORTS,
                    default_sort="-id", sort=sort, map_row=_log)


@router.post("/progress-logs")
def create_log(body: LogIn, db: Session = Depends(get_db),
               user: User = Depends(get_current_user)):
    """填报进度（只能追加历史，不可覆盖既有记录）。"""
    t = db.query(Task).filter_by(id=body.task_id).first()
    if not t:
        raise HTTPException(404, "任务不存在")
    _project(db, t.project_id, user, write=True)
    # 成员只能报自己的任务（管理员/负责人除外）
    p = get_active_project(db, t.project_id)
    if not is_admin(user) and p.owner_id != user.id and t.owner_id != user.id:
        raise HTTPException(403, "只能填报自己的任务")
    progress = check_progress(body.progress)
    if body.remaining_days is not None:
        rd = as_number(body.remaining_days, field="剩余天数")
        if rd < 0 or rd > 3650:
            raise HTTPException(400, "剩余天数须为 0-3650 的整数")
    _check_dependency_ready(db, t, None, progress)

    from_status = t.status
    t.progress = progress
    if progress >= 100:
        t.status = "done"
    elif progress > 0 and t.status in ("todo", "done"):
        t.status = "doing"
    log = ProgressLog(task_id=t.id, project_id=t.project_id, user_id=user.id,
                      progress=progress, note=body.note,
                      remaining_days=body.remaining_days,
                      created_at=datetime.now(timezone.utc))
    db.add(log)
    db.flush()
    commit_audited(db, user.id, "report_progress", "progress_logs", log.id,
                   f"task={t.id} {progress}%")
    return {"id": log.id, "progress": t.progress, "status": t.status,
            "from_status": from_status}


@router.get("/progress-logs/{lid}")
def get_log(lid: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """单条填报详情（不可修改，保留 note / remaining_days 等原始内容）。"""
    l = db.query(ProgressLog).filter_by(id=lid).first()
    if not l:
        raise HTTPException(404, "填报记录不存在")
    _project(db, l.project_id, user)
    return _log(l)


@router.post("/tasks/import")
def import_tasks(project_id: int, file: UploadFile = File(...),
                 db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """Excel 模板列：层级/名称/负责人账号/计划开始/计划结束/权重（首行表头校验，逐行报错带行号）。

    Stage 4A：逐行同样执行权重、层级与日期区间校验，任何一行非法只跳过该行并回报行号，
    不会因为单行错误写入半条数据；表头错误则整批拒收（避免列错位脏写）。
    """
    from openpyxl import load_workbook
    p = _project(db, project_id, user, write=True)
    try:
        wb = load_workbook(file.file, read_only=True)
        ws = wb.active
    except Exception:
        raise HTTPException(400, "Excel 解析失败")
    EXPECT = ["层级", "名称", "负责人账号", "计划开始", "计划结束", "权重"]
    errors, created, parents = [], 0, {}
    for i, row in enumerate(ws.iter_rows(values_only=True), start=1):
        if i == 1:
            vals = [str(c or "").strip() for c in (list(row) + [None] * 6)[:6]]
            if vals != EXPECT:
                return {"created": 0, "errors": [f"第1行：表头须为 {EXPECT}，实际为 {vals}"]}
            continue
        if not any(row):
            continue
        try:
            level, name, owner_name, start, end, weight = (list(row) + [None] * 6)[:6]
            if not name:
                raise ValueError("名称必填")
            level = int(level or 1)
            if not 1 <= level <= MAX_LEVEL:
                raise ValueError(f"层级须为 1-{MAX_LEVEL}")
            w = check_weight(weight if weight not in (None, "") else 1)
            s = start.date() if isinstance(start, datetime) else start
            e = end.date() if isinstance(end, datetime) else end
            if s and not isinstance(s, date):
                raise ValueError("计划开始格式须为日期（YYYY-MM-DD）")
            if e and not isinstance(e, date):
                raise ValueError("计划结束格式须为日期（YYYY-MM-DD）")
            check_date_range(s, e, start_field="计划开始", end_field="计划结束")
            if s and p.plan_start and s < p.plan_start:
                raise ValueError("计划开始不能早于项目计划开始")
            if e and p.plan_end and e > p.plan_end:
                raise ValueError("计划结束不能晚于项目计划结束")
            owner = db.query(User).filter_by(username=str(owner_name or "").strip()).first() if owner_name else None
            parent_id = parents.get(level - 1) if level > 1 else None
            t = Task(project_id=project_id, parent_id=parent_id, level=level,
                     name=_name(name), owner_id=owner.id if owner else user.id,
                     plan_start=s, plan_end=e, weight=w)
            db.add(t)
            db.flush()
            parents[level] = t.id
            created += 1
        except HTTPException as e:
            errors.append(f"第{i}行：{e.detail}")
        except Exception as e:
            errors.append(f"第{i}行：{e}")
    db.flush()
    commit_audited(db, user.id, "import_tasks", "tasks", project_id, f"created={created}")
    return {"created": created, "errors": errors}
