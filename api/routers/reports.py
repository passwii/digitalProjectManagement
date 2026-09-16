"""Stage 3/2：成本报表（四维度）+ Excel 导出 + 三预警（逾期/停滞/预算）。"""
import io
from datetime import date, datetime, timezone

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from sqlalchemy import func
from sqlalchemy.orm import Session

from ..core.costs import PASS, budget_total, execution, spent
from ..core.database import get_db
from ..core.deps import get_current_user
from ..core.rbac import can_read_project, project_scope_condition
from ..models import Budget, Department, Expense, Milestone, ProgressLog, Project, SysParam, Task, User

router = APIRouter(prefix="/reports", tags=["reports"])


def _visible_projects(db: Session, user: User):
    """报表取数用的可见项目：只选需要的列（避免加载全量 ORM 对象），权限下推 SQL。"""
    q = db.query(Project.id, Project.code, Project.name, Project.dept_id) \
        .filter(Project.deleted_at.is_(None))
    vis = project_scope_condition(user, db)
    if vis is not None:
        q = q.filter(vis)
    return q.all()


def _visible_project_ids(db: Session, user: User) -> list[int]:
    q = db.query(Project.id).filter(Project.deleted_at.is_(None))
    vis = project_scope_condition(user, db)
    if vis is not None:
        q = q.filter(vis)
    return [pid for (pid,) in q.all()]


MANAGE_NOTE = "成本为项目管理口径，与财务账存在差异"


def build_cost_rows(db: Session, projects: list, subject: str = "",
                    month: str = "") -> list[dict]:
    """报表与导出共用同一 service 函数，保证口径一致。

    Stage 5 优化：预算/支出各一次聚合查询（GROUP BY project_id, subject），
    替代原先「项目 × 科目」双层循环逐格查询的 N×M 次查询。
    """
    pids = [p.id for p in projects]
    if not pids:
        return []

    bq = db.query(Budget.project_id, Budget.subject, func.sum(Budget.amount)) \
        .filter(Budget.project_id.in_(pids))
    if subject:
        bq = bq.filter(Budget.subject == subject)
    budget_map: dict[tuple[int, str], float] = {
        (pid, s or ""): float(amt or 0) for pid, s, amt in
        bq.group_by(Budget.project_id, Budget.subject).all()
    }

    eq = db.query(Expense.project_id, Expense.subject, func.sum(Expense.amount)) \
        .filter(Expense.project_id.in_(pids), Expense.status.in_(PASS))
    if month:  # YYYY-MM：使用闭开日期区间，SQLite / PostgreSQL 均可用
        try:
            y, m = (int(x) for x in month.split("-", 1))
            start = date(y, m, 1)
            end = date(y + (m == 12), 1 if m == 12 else m + 1, 1)
        except (TypeError, ValueError):
            start = end = None
        if start and end:
            eq = eq.filter(Expense.exp_date >= start, Expense.exp_date < end)
    if subject:
        eq = eq.filter(Expense.subject == subject)
    spent_map: dict[tuple[int, str], float] = {
        (pid, s or ""): float(amt or 0) for pid, s, amt in
        eq.group_by(Expense.project_id, Expense.subject).all()
    }

    rows = []
    for p in projects:
        keys = sorted({k[1] for k in budget_map if k[0] == p.id} |
                      {k[1] for k in spent_map if k[0] == p.id}) or [""]
        for s in keys:
            b = round(budget_map.get((p.id, s), 0.0), 2)
            sp = round(spent_map.get((p.id, s), 0.0), 2)
            rate = round(sp / b, 4) if b else 0
            rows.append({"project_id": p.id, "project_code": p.code, "project_name": p.name,
                         "dept_id": p.dept_id, "subject": s, "budget": b, "spent": sp,
                         "balance": round(b - sp, 2), "rate": rate,
                         "note": MANAGE_NOTE})
    return rows


@router.get("/cost")
def cost_report(project_id: int = 0, dept_id: int = 0, subject: str = "",
                month: str = "", db: Session = Depends(get_db),
                user: User = Depends(get_current_user)):
    """四维度汇总：项目/科目/部门/时间。与导出同口径（同 service）。"""
    projects = _visible_projects(db, user)
    if project_id:
        projects = [p for p in projects if p.id == project_id]
    if dept_id:
        projects = [p for p in projects if p.dept_id == dept_id]
    rows = build_cost_rows(db, projects, subject=subject, month=month)
    return {"items": rows, "note": "成本为项目管理口径，与财务账差异见备注"}


@router.get("/cost/export")
def cost_export(project_id: int = 0, dept_id: int = 0, subject: str = "",
                month: str = "", db: Session = Depends(get_db),
                user: User = Depends(get_current_user)):
    from openpyxl import Workbook
    projects = _visible_projects(db, user)
    if project_id:
        projects = [p for p in projects if p.id == project_id]
    if dept_id:
        projects = [p for p in projects if p.dept_id == dept_id]
    data = build_cost_rows(db, projects, subject=subject, month=month)  # 同 service，同口径
    wb = Workbook()
    ws = wb.active
    ws.append(["项目编号", "项目名称", "部门ID", "科目", "预算", "已支出", "余额", "执行率"])
    for r in data:
        ws.append([r["project_code"], r["project_name"], r["dept_id"], r["subject"],
                   r["budget"], r["spent"], r["balance"], r["rate"]])
    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    return StreamingResponse(
        buf, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": "attachment; filename=cost_report.xlsx"})


@router.get("/warnings")
def warnings(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """三预警：任务逾期 / 里程碑临近逾期 / 项目停滞 / 预算80% + 跟进remind到期。"""
    from ..core.jobs import compute_warnings
    # 预警只需 id/name/status，避免加载全量 ORM 对象
    q = db.query(Project).filter(Project.deleted_at.is_(None))
    vis = project_scope_condition(user, db)
    if vis is not None:
        q = q.filter(vis)
    return compute_warnings(db, q.all())
