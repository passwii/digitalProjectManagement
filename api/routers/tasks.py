"""Stage 2：WBS 任务（5 级/环检测）+ 填报 + Excel 导入。"""
from datetime import date, datetime, timezone

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..core.audit import write_audit
from ..core.database import get_db, parse_date
from ..core.deps import get_current_user
from ..core.paging import DEFAULT_PAGE_SIZE, paginate
from ..core.rbac import (get_active_project, scope_child_query, visible_project_ids)
from ..models import ProgressLog, Project, Task, User

router = APIRouter(prefix="", tags=["tasks"])

MAX_LEVEL = 5

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
            "predecessor_id": t.predecessor_id}


def _project(db: Session, pid: int, user: User, write=False) -> Project:
    """子表接口的项目边界：未软删除 + 参与人校验（软删除项目一律 404）。"""
    return get_active_project(db, pid, user, write=write)


def _check_cycle(db: Session, task_id: int | None, predecessor_id: int | None, project_id: int):
    seen, cur = set(), predecessor_id
    while cur:
        if cur == task_id or cur in seen:
            raise HTTPException(400, "前置依赖存在环，已拦截")
        seen.add(cur)
        pre = db.query(Task).filter_by(id=cur, project_id=project_id).first()
        cur = pre.predecessor_id if pre else None


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
    · 不带 `project_id` → 「可见 + 未软删除」项目集合直接下推 SQL（不再 q.all() 后 Python 过滤）；
    · `keyword` 按任务名模糊匹配；`owner_id` / `status` 为等值筛选。
    """
    q = db.query(Task)
    if project_id:
        _project(db, project_id, user)   # 单次项目鉴权
        q = q.filter(Task.project_id == project_id)
    else:
        # 跨项目查询：权限与软删除边界下推 SQL，避免全表载入后 Python 过滤
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
    p = _project(db, body.project_id, user, write=True)
    if p.status == "archived":
        raise HTTPException(400, "已归档项目只读")
    level = 1
    if body.parent_id:
        parent = db.query(Task).filter_by(id=body.parent_id, project_id=body.project_id).first()
        if not parent:
            raise HTTPException(400, "父任务不存在")
        level = parent.level + 1
        if level > MAX_LEVEL:
            raise HTTPException(400, "任务层级最多 5 级")
    _check_cycle(db, None, body.predecessor_id, body.project_id)
    warn = ""
    if body.predecessor_id:
        pre = db.query(Task).filter_by(id=body.predecessor_id).first()
        if not pre or pre.project_id != body.project_id:
            raise HTTPException(400, "前置任务须为同一项目")
        if pre and pre.progress < 100:
            warn = "前置任务尚未完成"
    t = Task(project_id=body.project_id, parent_id=body.parent_id, level=level,
             name=body.name, owner_id=body.owner_id or user.id,
             plan_start=body.plan_start, plan_end=body.plan_end,
             weight=body.weight or 1, predecessor_id=body.predecessor_id)
    db.add(t)
    db.commit()
    write_audit(db, user.id, "create_task", "tasks", t.id, body.name)
    r = _t(t)
    r["warn"] = warn
    return r


@router.patch("/tasks/{tid}")
def update_task(tid: int, body: dict, db: Session = Depends(get_db),
                user: User = Depends(get_current_user)):
    t = db.query(Task).filter_by(id=tid).first()
    if not t:
        raise HTTPException(404, "任务不存在")
    _project(db, t.project_id, user, write=True)
    if "predecessor_id" in body:
        _check_cycle(db, tid, body["predecessor_id"], t.project_id)
        if body["predecessor_id"]:
            pre = db.query(Task).filter_by(id=body["predecessor_id"]).first()
            if not pre or pre.project_id != t.project_id:
                raise HTTPException(400, "前置任务须为同一项目")
    for f in ("name", "owner_id", "plan_start", "plan_end", "weight", "status", "predecessor_id"):
        if f in body:
            v = body[f]
            if f in ("plan_start", "plan_end"):
                v = parse_date(v)
            setattr(t, f, v)
    if "progress" in body:  # 直接改进度同步写一条 log
        t.progress = body["progress"]
        db.add(ProgressLog(task_id=tid, project_id=t.project_id, user_id=user.id,
                           progress=body["progress"], note=body.get("note", "")))
    db.commit()
    write_audit(db, user.id, "update_task", "tasks", tid, str(list(body.keys())))
    return _t(t)


@router.delete("/tasks/{tid}")
def delete_task(tid: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    t = db.query(Task).filter_by(id=tid).first()
    if not t:
        raise HTTPException(404, "任务不存在")
    _project(db, t.project_id, user, write=True)
    db.delete(t)
    db.commit()
    write_audit(db, user.id, "delete_task", "tasks", tid, "")
    return {"ok": True}


class LogIn(BaseModel):
    task_id: int
    progress: float
    note: str = ""
    remaining_days: int | None = None


@router.get("/progress-logs")
def list_logs(task_id: int = 0, project_id: int = 0, sort: str = "-id",
              page: int = 1, size: int = DEFAULT_PAGE_SIZE,
              db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """填报历史：task_id / project_id 均需可见；两者都不传时只返回可见且未软删除项目的记录。

    统一分页信封（默认 `-id` 最新在前），避免跨项目全量取数。
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

    def _log(l: ProgressLog):
        return {"id": l.id, "task_id": l.task_id, "project_id": l.project_id,
                "user_id": l.user_id, "progress": l.progress, "note": l.note,
                "remaining_days": l.remaining_days,
                "created_at": l.created_at.isoformat() if l.created_at else None}

    return paginate(q, page=page, size=size, allowed=LOG_SORTS,
                    default_sort="-id", sort=sort, map_row=_log)


@router.post("/progress-logs")
def create_log(body: LogIn, db: Session = Depends(get_db),
               user: User = Depends(get_current_user)):
    t = db.query(Task).filter_by(id=body.task_id).first()
    if not t:
        raise HTTPException(404, "任务不存在")
    _project(db, t.project_id, user, write=True)
    # 成员只能报自己的任务（管理员/负责人除外）
    from ..core.rbac import is_admin
    p = get_active_project(db, t.project_id)
    if not is_admin(user) and p.owner_id != user.id and t.owner_id != user.id:
        raise HTTPException(403, "只能填报自己的任务")
    if not (0 <= body.progress <= 100):
        raise HTTPException(400, "进度须为 0-100")
    t.progress = body.progress
    if body.progress >= 100:
        t.status = "done"
    elif body.progress > 0:
        t.status = "doing"
    log = ProgressLog(task_id=t.id, project_id=t.project_id, user_id=user.id,
                      progress=body.progress, note=body.note,
                      remaining_days=body.remaining_days,
                      created_at=datetime.now(timezone.utc))
    db.add(log)
    db.commit()
    write_audit(db, user.id, "report_progress", "progress_logs", log.id, f"task={t.id} {body.progress}%")
    return {"id": log.id, "progress": t.progress}


@router.post("/tasks/import")
def import_tasks(project_id: int, file: UploadFile = File(...),
                 db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """Excel 模板列：层级/名称/负责人账号/计划开始/计划结束/权重（首行表头校验，逐行报错带行号）。"""
    from openpyxl import load_workbook
    _project(db, project_id, user, write=True)
    try:
        wb = load_workbook(file.file, read_only=True)
        ws = wb.active
    except Exception:
        raise HTTPException(400, "Excel 解析失败")
    EXPECT = ["层级", "名称", "负责人账号", "计划开始", "计划结束", "权重"]
    errors, created, parents = [], 0, {}
    header_checked = False
    for i, row in enumerate(ws.iter_rows(values_only=True), start=1):
        if i == 1:
            vals = [str(c or "").strip() for c in (list(row) + [None] * 6)[:6]]
            if vals != EXPECT:
                errors.append(f"第1行：表头须为 {EXPECT}，实际为 {vals}")
                # 表头不对则整体拒收，避免列错位脏写
                return {"created": 0, "errors": errors}
            header_checked = True
            continue
        if not any(row):
            continue
        try:
            level, name, owner_name, start, end, weight = (list(row) + [None] * 6)[:6]
            if not name:
                raise ValueError("名称必填")
            level = int(level or 1)
            if not 1 <= level <= MAX_LEVEL:
                raise ValueError("层级须为 1-5")
            owner = db.query(User).filter_by(username=str(owner_name or "").strip()).first() if owner_name else None
            parent_id = parents.get(level - 1) if level > 1 else None
            t = Task(project_id=project_id, parent_id=parent_id, level=level,
                     name=str(name).strip(), owner_id=owner.id if owner else user.id,
                     plan_start=start.date() if isinstance(start, datetime) else start,
                     plan_end=end.date() if isinstance(end, datetime) else end,
                     weight=float(weight or 1))
            db.add(t)
            db.flush()
            parents[level] = t.id
            created += 1
        except Exception as e:
            errors.append(f"第{i}行：{e}")
            db.rollback()
    db.commit()
    write_audit(db, user.id, "import_tasks", "tasks", project_id, f"created={created}")
    return {"created": created, "errors": errors}
