#!/usr/bin/env python3
"""模拟数据填充：一套「全流程 + 全状态」示例数据，用于演示与验收。

RBAC 前提（与当前代码契约一致）：
  · admin 是唯一管理与审批角色，也是唯一拥有全局数据范围的用户
  · 非管理员只能看到「自己负责或参与」的项目；project_manager / dept_manager /
    member / cost_admin / executive 目前仅作结构字段保留，不参与授权判定
  因此本脚本把每个非管理员账号都设为相关项目的**负责人或成员**，保证他们的视角有数据可看。

覆盖范围（对齐 Stage 1-5 全部能力）：
  · 9 个项目覆盖全部 8 种状态：草稿 / 待立项审批 / 已立项 / 进行中 / 暂停 / 已完成 / 已归档 / 已取消
  · WBS 多级任务 + 前置依赖 + 逾期任务 + 权重加权进度
  · 进度填报历史（含近 7 天记录与「停滞 8 天」项目，驱动周报与停滞预警）
  · 里程碑：已完成 / 临近（2 天内）/ 逾期，驱动里程碑预警
  · 预算按科目编制，执行率覆盖 健康 / 80% 预警 / 超支
  · 支出跨 6 个月（驱动工作台趋势图），含 待审批 / 驳回 / 特批通过
  · 预算调整单待审批（审批中心有可处理事项）
  · 跟进记录 + 到期提醒（含已到期，生成站内通知）
  · 附件真实落盘（可下载/删除）
  · 变更留痕时间线、状态流转历史
  · 站内通知（预警 + 审批待办），已读/未读混合

用法：
    python3 scripts/seed_mock.py            # 填充（已有示例数据则跳过）
    python3 scripts/seed_mock.py --reset    # 清理后重新填充
    python3 scripts/seed_mock.py --clean    # 只清理
"""
from __future__ import annotations

import argparse
import sys
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from api.core.database import DATA_DIR, SessionLocal, engine, ensure_fts  # noqa: E402
from api.core.notify import push, user_ids_with_role  # noqa: E402
from api.core.security import hash_password  # noqa: E402
from api.models import (Attachment, Budget, BudgetAdjust, Department, Expense,  # noqa: E402
                        Followup, Milestone, Notification, ProgressLog, Project,
                        ProjectChange, ProjectMember, Role, Task, User, UserRole)

# ---------------------------------------------------------------- 常量与工具

CODE_BASE = 9000          # 示例项目编号 PJ-2026-9xxx，便于识别与清理
CODE_PREFIX = f"PJ-{date.today().year}-9"
DEMO_PASSWORD = "demo123456"

TODAY = date.today()


def d(offset: int) -> date:
    """相对今天偏移的日期（负数=过去）。"""
    return TODAY + timedelta(days=offset)


def ts(offset: int, hour: int = 9) -> datetime:
    """相对今天偏移的 UTC 时间戳。"""
    return datetime.combine(TODAY + timedelta(days=offset), time(hour, 0), tzinfo=timezone.utc)


DEPTS = ["产品研发部", "交付实施部", "财务部", "综合部"]

# username, 姓名, 部门, 角色
USERS = [
    ("demo_admin", "演示管理员", "综合部", ["admin"]),
    ("zhangwei", "张伟", "产品研发部", ["project_manager", "member"]),
    ("lina", "李娜", "交付实施部", ["project_manager", "member"]),
    ("wangqiang", "王强", "产品研发部", ["member"]),
    ("zhaomin", "赵敏", "产品研发部", ["member"]),
    ("liuyang", "刘洋", "交付实施部", ["member"]),
    ("chenjing", "陈静", "财务部", ["cost_admin"]),
    ("sunlei", "孙磊", "产品研发部", ["dept_manager"]),
    ("zhouzong", "周正", "综合部", ["executive"]),
]

SUBJECTS = ["人工", "采购", "外包", "差旅", "其他"]


def log(msg: str) -> None:
    print(f"  {msg}")


# ---------------------------------------------------------------- 基础数据

def ensure_depts(db) -> dict[str, int]:
    out = {}
    for name in DEPTS:
        dep = db.query(Department).filter_by(name=name).first()
        if not dep:
            dep = Department(name=name)
            db.add(dep)
            db.flush()
        out[name] = dep.id
    return out


def ensure_users(db, dept_ids: dict[str, int]) -> dict[str, User]:
    out: dict[str, User] = {}
    role_map = {r.code: r.id for r in db.query(Role).all()}
    for username, real_name, dept, roles in USERS:
        u = db.query(User).filter_by(username=username).first()
        if not u:
            u = User(username=username, pwd_hash=hash_password(DEMO_PASSWORD),
                     real_name=real_name, dept_id=dept_ids[dept], status="active",
                     must_change_pwd=False, created_at=ts(-400))
            db.add(u)
            db.flush()
        else:
            u.real_name, u.dept_id, u.status = real_name, dept_ids[dept], "active"
            u.pwd_hash = hash_password(DEMO_PASSWORD)
            u.must_change_pwd = False
        # 角色补齐
        have = {r.code for r in u.roles}
        for code in roles:
            if code not in have and code in role_map:
                db.add(UserRole(user_id=u.id, role_id=role_map[code]))
        db.flush()
        out[username] = u
    return out


def uid(users: dict[str, User], username: str) -> int:
    return users[username].id


# ---------------------------------------------------------------- 子结构写入

def add_task(db, pid: int, name: str, owner: int, start: date, end: date,
             weight: float = 1, progress: float = 0, parent: int | None = None,
             level: int = 1, pred: int | None = None) -> Task:
    status = "done" if progress >= 100 else ("doing" if progress > 0 else "todo")
    t = Task(project_id=pid, parent_id=parent, level=level, name=name, owner_id=owner,
             plan_start=start, plan_end=end, weight=weight, progress=progress,
             status=status, predecessor_id=pred, created_at=ts(-300), updated_at=ts(-3))
    db.add(t)
    db.flush()
    return t


def add_log(db, pid: int, task: Task, progress: float, note: str, days_ago: int,
            user_id: int, remaining: int | None = None) -> None:
    db.add(ProgressLog(task_id=task.id, project_id=pid, user_id=user_id,
                       progress=progress, note=note, remaining_days=remaining,
                       created_at=ts(-days_ago, hour=15)))


def add_budget(db, pid: int, subject: str, amount: float,
               p_start: date, p_end: date) -> Budget:
    b = Budget(project_id=pid, subject=subject, amount=amount,
               period_start=p_start, period_end=p_end, created_at=ts(-280))
    db.add(b)
    db.flush()
    return b


def add_expense(db, pid: int, subject: str, amount: float, exp_date: date, note: str,
                status: str, by_id: int, approved_by: int | None = None) -> Expense:
    back = max(0, (TODAY - exp_date).days)
    e = Expense(project_id=pid, subject=subject, amount=amount, exp_date=exp_date,
                note=note, status=status, by_id=by_id, approved_by=approved_by,
                created_at=ts(-back, hour=16))
    db.add(e)
    db.flush()
    return e


def add_milestone(db, pid: int, name: str, plan: date, owner: int,
                  actual: date | None = None) -> Milestone:
    m = Milestone(project_id=pid, name=name, plan_date=plan, actual_date=actual,
                  owner_id=owner, status="closed" if actual else "open",
                  created_at=ts(-290))
    db.add(m)
    db.flush()
    return m


def add_followup(db, pid: int, user_id: int, days_ago: int, method: str, content: str,
                 next_step: str, remind_offset: int | None = None) -> Followup:
    f = Followup(project_id=pid, user_id=user_id, happened_at=ts(-days_ago, hour=14),
                 method=method, content=content, next_step=next_step,
                 remind_at=ts(remind_offset, hour=9) if remind_offset is not None else None,
                 created_at=ts(-days_ago, hour=14))
    db.add(f)
    db.flush()
    return f


def add_change(db, pid: int, field: str, old: str, new: str, by_id: int,
               days_ago: int) -> None:
    db.add(ProjectChange(project_id=pid, field=field, old=old, new=new,
                         by_id=by_id, at=ts(-days_ago, hour=11)))


def add_attachment(db, pid: int, filename: str, by_id: int, days_ago: int,
                   payload: bytes) -> None:
    folder = DATA_DIR / "files" / str(pid)
    folder.mkdir(parents=True, exist_ok=True)
    fp = folder / filename
    fp.write_bytes(payload)
    ext = Path(filename).suffix.lower()
    ctype = {".pdf": "application/pdf", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
             ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
             ".png": "image/png", ".jpg": "image/jpeg"}.get(ext, "application/octet-stream")
    db.add(Attachment(project_id=pid, filename=filename, path=str(fp), size=len(payload),
                      content_type=ctype, uploaded_by=by_id, uploaded_at=ts(-days_ago, hour=10)))


def new_project(db, code_n: int, **kw) -> Project:
    p = Project(code=f"{CODE_PREFIX}{code_n:03d}", **kw)
    db.add(p)
    db.flush()
    return p


def recalc_progress(db, p: Project) -> float:
    tasks = db.query(Task).filter_by(project_id=p.id).all()
    if not tasks:
        return 0.0
    num = sum((t.progress or 0) * (t.weight or 1) for t in tasks)
    den = sum((t.weight or 1) for t in tasks) or 1
    val = round(num / den, 2)
    p.progress = val
    return val


# ---------------------------------------------------------------- 造数主流程

def seed(db) -> dict:
    dept_ids = ensure_depts(db)
    users = ensure_users(db, dept_ids)
    summary: list[tuple[str, str, str]] = []

    # ---------- ① 企业官网改版：进行中，健康项目，数据最全 ----------
    p1 = new_project(
        db, 1, name="企业官网改版", type="研发", dept_id=dept_ids["产品研发部"],
        owner_id=uid(users, "zhangwei"), plan_start=d(-120), plan_end=d(60),
        budget_total=1200000, priority="高", client="市场部（内部）",
        description="官网整体视觉与信息架构升级，含多语言与 SEO 改造，一期覆盖 PC 与移动端。",
        status="doing", created_by=uid(users, "zhangwei"), created_at=ts(-125))
    for u in ["zhangwei", "wangqiang", "zhaomin", "sunlei", "chenjing", "zhouzong"]:
        db.add(ProjectMember(project_id=p1.id, user_id=uid(users, u)))

    t1 = add_task(db, p1.id, "需求调研与评审", uid(users, "zhangwei"), d(-120), d(-95), 3, 100)
    t2 = add_task(db, p1.id, "视觉设计", uid(users, "zhaomin"), d(-96), d(-70), 2, 100, pred=t1.id)
    t3 = add_task(db, p1.id, "前端开发", uid(users, "wangqiang"), d(-70), d(12), 4, 72, pred=t2.id)
    t4 = add_task(db, p1.id, "后端接口与 CMS", uid(users, "wangqiang"), d(-70), d(8), 3, 65, pred=t2.id)
    t5 = add_task(db, p1.id, "测试与上线", uid(users, "zhangwei"), d(-12), d(25), 3, 10, pred=t3.id)
    # 二级任务
    add_task(db, p1.id, "首页与导航", uid(users, "wangqiang"), d(-70), d(-40), 2, 100, parent=t3.id, level=2)
    add_task(db, p1.id, "产品详情页", uid(users, "wangqiang"), d(-45), d(3), 2, 80, parent=t3.id, level=2)
    add_task(db, p1.id, "响应式适配", uid(users, "zhaomin"), d(-25), d(10), 2, 45, parent=t3.id, level=2)
    # 逾期任务（计划已过、未完成）→ 逾期预警
    add_task(db, p1.id, "多语言文案校对", uid(users, "zhaomin"), d(-30), d(-6), 1, 30)
    add_log(db, p1.id, t3, 40, "首页与导航完成，开始产品详情页", 6, uid(users, "wangqiang"), 15)
    add_log(db, p1.id, t3, 60, "产品详情页完成 80%，响应式适配进行中", 3, uid(users, "wangqiang"), 10)
    add_log(db, p1.id, t3, 72, "详情页完成，适配剩余 3 个断点", 1, uid(users, "wangqiang"), 7)
    add_log(db, p1.id, t4, 65, "CMS 接口联调完成，剩余权限模块", 2, uid(users, "wangqiang"), 12)

    add_milestone(db, p1.id, "需求冻结", d(-95), uid(users, "zhangwei"), actual=d(-93))
    add_milestone(db, p1.id, "设计交付", d(-70), uid(users, "zhaomin"), actual=d(-68))
    add_milestone(db, p1.id, "一期上线", d(2), uid(users, "zhangwei"))          # 临近 → 预警
    add_milestone(db, p1.id, "验收结项", d(45), uid(users, "zhangwei"))

    add_budget(db, p1.id, "人工", 620000, d(-120), d(60))
    add_budget(db, p1.id, "采购", 300000, d(-120), d(60))
    add_budget(db, p1.id, "外包", 180000, d(-120), d(60))
    add_budget(db, p1.id, "差旅", 70000, d(-120), d(60))
    add_budget(db, p1.id, "其他", 30000, d(-120), d(60))

    for off, subj, amt, note in [
        (-150, "人工", 96000, "1 月人力成本"), (-118, "人工", 98000, "2 月人力成本"),
        (-88, "人工", 92000, "3 月人力成本"), (-60, "采购", 120000, "云资源年付"),
        (-45, "人工", 88000, "4 月人力成本"), (-30, "外包", 60000, "视觉外包一期"),
        (-18, "差旅", 12000, "客户现场调研差旅"), (-8, "人工", 76000, "5 月人力成本"),
        (-4, "其他", 6000, "团队培训"),
    ]:
        add_expense(db, p1.id, subj, amt, d(off), note, "approved",
                    uid(users, "chenjing"), uid(users, "chenjing"))
    add_expense(db, p1.id, "外包", 45000, d(-2), "外包二期预付款", "pending", uid(users, "zhangwei"))
    add_expense(db, p1.id, "其他", 38000, d(-9), "团建费用（超标）", "rejected",
                uid(users, "zhangwei"), uid(users, "chenjing"))
    add_expense(db, p1.id, "采购", 52000, d(-6), "显示器与测试机（超预算特批）", "exception",
                uid(users, "zhangwei"), uid(users, "chenjing"))

    add_followup(db, p1.id, uid(users, "zhangwei"), 21, "会议", "与市场部确认首页信息架构",
                 "输出信息架构终稿", -20)   # 提醒已到期 → 通知
    add_followup(db, p1.id, uid(users, "zhangwei"), 12, "电话", "确认外包二期的交付范围",
                 "等待外包方报价", None)
    add_followup(db, p1.id, uid(users, "zhaomin"), 5, "现场", "设计走查，收集视觉反馈",
                 "按反馈调整 3 处间距与配色", 3)   # 未来提醒
    add_attachment(db, p1.id, "立项报告.pdf", uid(users, "zhangwei"), 124, b"%PDF-1.4 demo lixiang baogao\n")
    add_attachment(db, p1.id, "需求说明书.docx", uid(users, "zhangwei"), 110, b"PK demo requirement doc\n")
    add_attachment(db, p1.id, "报价单.xlsx", uid(users, "chenjing"), 100, b"demo quotation\n")

    add_change(db, p1.id, "status", "draft", "filed", uid(users, "zhangwei"), 122)
    add_change(db, p1.id, "status", "filed", "doing", uid(users, "zhangwei"), 118)
    add_change(db, p1.id, "budget_total", "900000", "1200000", uid(users, "chenjing"), 60)
    add_change(db, p1.id, "plan_end", str(d(30)), str(d(60)), uid(users, "zhangwei"), 30)
    add_change(db, p1.id, "progress_snapshot", "58.0", "66.4", uid(users, "zhangwei"), 7)
    recalc_progress(db, p1)
    summary.append((p1.code, p1.name, "进行中：任务/里程碑/预算/支出/跟进/附件/留痕齐全，含逾期任务与临近里程碑"))

    # ---------- ② CRM 系统一期实施：停滞（9 天无填报）+ 预算 87% 预警 ----------
    p2 = new_project(
        db, 2, name="CRM 系统一期实施", type="实施", dept_id=dept_ids["交付实施部"],
        owner_id=uid(users, "lina"), plan_start=d(-90), plan_end=d(90),
        budget_total=600000, priority="高", client="销售中心",
        description="CRM 一期落地：客户主数据、商机与合同流程上线，覆盖 3 个销售大区。",
        status="doing", created_by=uid(users, "lina"), created_at=ts(-95))
    for u in ["lina", "liuyang", "chenjing"]:
        db.add(ProjectMember(project_id=p2.id, user_id=uid(users, u)))

    m1 = add_task(db, p2.id, "业务蓝图确认", uid(users, "lina"), d(-90), d(-70), 2, 100)
    m2 = add_task(db, p2.id, "系统配置与数据迁移", uid(users, "liuyang"), d(-70), d(-15), 4, 85, pred=m1.id)
    m3 = add_task(db, p2.id, "用户培训与试运行", uid(users, "lina"), d(-15), d(30), 3, 20, pred=m2.id)
    add_task(db, p2.id, "客户主数据清洗", uid(users, "liuyang"), d(-70), d(-40), 2, 100, parent=m2.id, level=2)
    add_task(db, p2.id, "商机流程配置", uid(users, "liuyang"), d(-45), d(-20), 2, 70, parent=m2.id, level=2)
    # 最后一次填报在 9 天前 → 停滞预警
    add_log(db, p2.id, m2, 70, "商机流程配置完成 70%", 14, uid(users, "liuyang"), 25)
    add_log(db, p2.id, m2, 85, "数据迁移脚本调试中，遇到编码问题", 9, uid(users, "liuyang"), 20)

    add_milestone(db, p2.id, "蓝图评审通过", d(-70), uid(users, "lina"), actual=d(-71))
    add_milestone(db, p2.id, "系统上线试运行", d(-5), uid(users, "lina"))   # 逾期 → 预警
    add_milestone(db, p2.id, "一期验收", d(40), uid(users, "lina"))

    add_budget(db, p2.id, "人工", 320000, d(-90), d(90))
    add_budget(db, p2.id, "外包", 180000, d(-90), d(90))
    add_budget(db, p2.id, "差旅", 60000, d(-90), d(90))
    add_budget(db, p2.id, "其他", 40000, d(-90), d(90))
    for off, subj, amt, note in [
        (-88, "人工", 104000, "实施人力 1-3 月"), (-60, "人工", 98000, "实施人力 4 月"),
        (-40, "外包", 90000, "数据迁移外包"), (-22, "人工", 86000, "实施人力 5 月"),
        (-12, "差旅", 24000, "三地现场差旅"), (-5, "外包", 60000, "培训材料制作"),
    ]:
        add_expense(db, p2.id, subj, amt, d(off), note, "approved",
                    uid(users, "chenjing"), uid(users, "chenjing"))

    add_followup(db, p2.id, uid(users, "lina"), 9, "会议", "与销售中心确认上线时间窗口",
                 "等待业务方确认", -30)
    add_change(db, p2.id, "status", "draft", "filed", uid(users, "lina"), 92)
    add_change(db, p2.id, "status", "filed", "doing", uid(users, "lina"), 88)
    recalc_progress(db, p2)
    summary.append((p2.code, p2.name, "进行中但停滞 9 天 + 预算 87% + 里程碑逾期，触发三类预警"))

    # ---------- ③ 数据中台咨询：已立项待开工 ----------
    p3 = new_project(
        db, 3, name="数据中台建设咨询", type="咨询", dept_id=dept_ids["产品研发部"],
        owner_id=uid(users, "sunlei"), plan_start=d(7), plan_end=d(120),
        budget_total=380000, priority="中", client="集团信息中心",
        description="数据治理体系与中台建设路线图咨询，输出总体架构与分期实施建议。",
        status="filed", created_by=uid(users, "sunlei"), created_at=ts(-20))
    db.add(ProjectMember(project_id=p3.id, user_id=uid(users, "sunlei")))
    db.add(ProjectMember(project_id=p3.id, user_id=uid(users, "zhangwei")))
    add_task(db, p3.id, "现状调研", uid(users, "zhangwei"), d(7), d(30), 1, 0)
    add_task(db, p3.id, "架构方案设计", uid(users, "zhangwei"), d(31), d(80), 1, 0)
    add_milestone(db, p3.id, "项目启动会", d(8), uid(users, "sunlei"))
    add_budget(db, p3.id, "人工", 260000, d(7), d(120))
    add_budget(db, p3.id, "差旅", 80000, d(7), d(120))
    add_budget(db, p3.id, "其他", 40000, d(7), d(120))
    add_expense(db, p3.id, "差旅", 8600, d(-1), "启动会差旅预支", "pending", uid(users, "sunlei"))
    add_change(db, p3.id, "status", "draft", "filed", uid(users, "sunlei"), 18)
    add_followup(db, p3.id, uid(users, "sunlei"), 4, "会议", "与信息中心对齐交付边界",
                 "输出调研提纲", 10)
    summary.append((p3.code, p3.name, "已立项待开工：有预算与待审批支出（审批中心可处理）"))

    # ---------- ④ 智能仓储改造工程：暂停 + 采购 95% 预警 + 预算调整待审批 ----------
    p4 = new_project(
        db, 4, name="智能仓储改造工程", type="工程", dept_id=dept_ids["交付实施部"],
        owner_id=uid(users, "lina"), plan_start=d(-150), plan_end=d(-10),
        budget_total=1200000, priority="高", client="供应链中心",
        description="一号仓智能化改造：AGV 调度、WMS 对接、库位改造，分两期实施。",
        status="paused", created_by=uid(users, "lina"), created_at=ts(-155))
    for u in ["lina", "liuyang", "chenjing"]:
        db.add(ProjectMember(project_id=p4.id, user_id=uid(users, u)))
    g1 = add_task(db, p4.id, "库位与场地改造", uid(users, "liuyang"), d(-150), d(-100), 3, 100)
    g2 = add_task(db, p4.id, "设备采购与到货", uid(users, "lina"), d(-140), d(-60), 4, 90, pred=g1.id)
    add_task(db, p4.id, "WMS 对接联调", uid(users, "liuyang"), d(-70), d(-20), 4, 55, pred=g2.id)
    add_task(db, p4.id, "AGV 调度调试", uid(users, "liuyang"), d(-40), d(-12), 3, 35, pred=g2.id)
    add_log(db, p4.id, g2, 90, "设备到货 90%，剩余一台 AGV 未到", 20, uid(users, "lina"), 10)
    add_milestone(db, p4.id, "设备到货", d(-60), uid(users, "lina"), actual=d(-58))
    add_milestone(db, p4.id, "联调完成", d(-3), uid(users, "liuyang"))   # 逾期
    add_budget(db, p4.id, "采购", 600000, d(-150), d(-10))
    add_budget(db, p4.id, "外包", 400000, d(-150), d(-10))
    add_budget(db, p4.id, "人工", 200000, d(-150), d(-10))
    for off, subj, amt, note in [
        (-145, "采购", 180000, "货架与输送线"), (-120, "采购", 200000, "AGV 首批 4 台"),
        (-95, "外包", 150000, "场地改造外包"), (-70, "采购", 120000, "AGV 第二批 + 配件"),
        (-50, "外包", 120000, "WMS 对接外包"), (-25, "人工", 60000, "现场实施人力"),
        (-8, "采购", 70000, "备件与耗材（超预算特批）"),
    ]:
        st = "exception" if note.endswith("特批）") else "approved"
        add_expense(db, p4.id, subj, amt, d(off), note, st,
                    uid(users, "chenjing"), uid(users, "chenjing"))
    add_expense(db, p4.id, "采购", 46000, d(-3), "第三批 AGV 追加（超预算）", "pending", uid(users, "lina"))

    b4 = db.query(Budget).filter_by(project_id=p4.id, subject="采购").first()
    db.add(BudgetAdjust(budget_id=b4.id, project_id=p4.id, old_amount=600000,
                        new_amount=700000, reason="AGV 追加一台，采购预算需上调 10 万",
                        status="pending", by_id=uid(users, "lina"), created_at=ts(-3, hour=16)))
    add_change(db, p4.id, "status", "doing", "paused", uid(users, "lina"), 12)
    add_followup(db, p4.id, uid(users, "lina"), 12, "现场", "与供应链中心沟通暂停期间的到场安排",
                 "待确认复工时间", -8)
    recalc_progress(db, p4)
    summary.append((p4.code, p4.name, "暂停：采购执行率超 80% + 超支特批 + 预算调整待审批（审批中心可处理）"))

    # ---------- ⑤ 移动端 App 重构：已完成 ----------
    p5 = new_project(
        db, 5, name="移动端 App 重构", type="研发", dept_id=dept_ids["产品研发部"],
        owner_id=uid(users, "zhangwei"), plan_start=d(-200), plan_end=d(-30),
        budget_total=620000, priority="中", client="C 端用户",
        description="App 架构与交互重构，性能优化与新版设计语言落地，已通过验收。",
        status="done", created_by=uid(users, "zhangwei"), created_at=ts(-205))
    for u in ["zhangwei", "wangqiang", "zhaomin"]:
        db.add(ProjectMember(project_id=p5.id, user_id=uid(users, u)))
    k1 = add_task(db, p5.id, "架构重构", uid(users, "wangqiang"), d(-200), d(-120), 3, 100)
    k2 = add_task(db, p5.id, "新版视觉落地", uid(users, "zhaomin"), d(-140), d(-60), 2, 100, pred=k1.id)
    add_task(db, p5.id, "性能优化与验收", uid(users, "zhangwei"), d(-60), d(-30), 3, 100, pred=k2.id)
    add_milestone(db, p5.id, "重构完成", d(-120), uid(users, "zhangwei"), actual=d(-118))
    add_milestone(db, p5.id, "验收通过", d(-30), uid(users, "zhangwei"), actual=d(-31))
    add_budget(db, p5.id, "人工", 520000, d(-200), d(-30))
    add_budget(db, p5.id, "其他", 100000, d(-200), d(-30))
    for off, subj, amt, note in [
        (-190, "人工", 150000, "重构人力 1-2 月"), (-140, "人工", 140000, "重构人力 3-4 月"),
        (-90, "人工", 120000, "重构人力 5 月"), (-60, "其他", 70000, "测试设备与工具"),
    ]:
        add_expense(db, p5.id, subj, amt, d(off), note, "approved",
                    uid(users, "chenjing"), uid(users, "chenjing"))
    for f, old, new, day in [("status", "draft", "filed", 200), ("status", "filed", "doing", 195),
                             ("status", "doing", "done", 30)]:
        add_change(db, p5.id, f, old, new, uid(users, "zhangwei"), day)
    recalc_progress(db, p5)
    summary.append((p5.code, p5.name, "已完成：全任务 100%，预算执行 92%，可作为结项样板"))

    # ---------- ⑥ 年度运维服务外包：已归档（只读） ----------
    p6 = new_project(
        db, 6, name="2025 年度运维服务外包", type="服务", dept_id=dept_ids["交付实施部"],
        owner_id=uid(users, "lina"), plan_start=d(-400), plan_end=d(-35),
        budget_total=300000, priority="低", client="综合部",
        description="上一年度基础设施运维外包服务，已结项归档，仅供查询与追溯。",
        status="archived", created_by=uid(users, "lina"), created_at=ts(-405))
    db.add(ProjectMember(project_id=p6.id, user_id=uid(users, "lina")))
    add_task(db, p6.id, "日常运维值守", uid(users, "liuyang"), d(-400), d(-35), 1, 100)
    add_milestone(db, p6.id, "服务期满", d(-35), uid(users, "lina"), actual=d(-35))
    add_budget(db, p6.id, "外包", 300000, d(-400), d(-35))
    add_expense(db, p6.id, "外包", 290000, d(-40), "全年运维外包结算", "approved",
                uid(users, "chenjing"), uid(users, "chenjing"))
    add_change(db, p6.id, "status", "done", "archived", uid(users, "lina"), 34)
    recalc_progress(db, p6)
    summary.append((p6.code, p6.name, "已归档：只读，可在回收站/归档列表中验证只读约束"))

    # ---------- ⑦ 内部工具立项：待立项审批 ----------
    p7 = new_project(
        db, 7, name="内部效能工具建设", type="研发", dept_id=dept_ids["产品研发部"],
        owner_id=uid(users, "zhangwei"), plan_start=d(15), plan_end=d(150),
        budget_total=150000, priority="低", client="内部",
        description="面向研发团队的效能度量与自动化工具建设，立项审批中。",
        status="pending", created_by=uid(users, "zhangwei"), created_at=ts(-2))
    db.add(ProjectMember(project_id=p7.id, user_id=uid(users, "zhangwei")))
    summary.append((p7.code, p7.name, "待立项审批：审批中心有立项待办，通过后进入「已立项」"))

    # ---------- ⑧ 试点失败项目：已取消 ----------
    p8 = new_project(
        db, 8, name="线下门店数字化试点", type="实施", dept_id=dept_ids["交付实施部"],
        owner_id=uid(users, "lina"), plan_start=d(-180), plan_end=d(-60),
        budget_total=200000, priority="低", client="门店运营部",
        description="因业务方向调整终止，保留数据用于复盘。",
        status="cancelled", created_by=uid(users, "lina"), created_at=ts(-185))
    db.add(ProjectMember(project_id=p8.id, user_id=uid(users, "lina")))
    add_task(db, p8.id, "门店调研", uid(users, "lina"), d(-180), d(-140), 1, 100)
    add_expense(db, p8.id, "差旅", 18000, d(-150), "门店走访差旅", "approved",
                uid(users, "chenjing"), uid(users, "chenjing"))
    add_change(db, p8.id, "status", "filed", "cancelled", uid(users, "lina"), 100)
    add_followup(db, p8.id, uid(users, "lina"), 100, "会议", "确认试点终止，转入复盘",
                 "输出复盘纪要并归档", None)
    recalc_progress(db, p8)
    summary.append((p8.code, p8.name, "已取消：终态，用于验证状态机与复盘场景"))

    # ---------- ⑨ 智能客服知识库建设：草稿（新建未立项） ----------
    p9 = new_project(
        db, 9, name="智能客服知识库建设", type="研发", dept_id=dept_ids["产品研发部"],
        owner_id=uid(users, "zhangwei"), plan_start=d(20), plan_end=d(140),
        budget_total=0, priority="低", client="客服中心",
        description="基于历史工单构建客服知识库，仍在草稿阶段，尚未提交立项审批。",
        status="draft", created_by=uid(users, "zhangwei"), created_at=ts(-1))
    db.add(ProjectMember(project_id=p9.id, user_id=uid(users, "zhangwei")))
    summary.append((p9.code, p9.name, "草稿：新建未立项，验证「草稿 → 已立项/待审批」流转与未填预算场景"))

    # ---------- 站内通知：预警落库 + 立项待办 ----------
    db.commit()
    from api.core.jobs import sync_notifications
    projects = [p1, p2, p3, p4, p5, p6, p7, p8, p9]
    created = sync_notifications(db, projects)
    # 立项审批待办通知（管理员 + 负责人）
    for target in {*user_ids_with_role(db, "admin"), uid(users, "zhangwei")}:
        push(db, target, "approval", f"立项审批待处理：{p7.name}",
             f"编号 {p7.code}，预算 {p7.budget_total}",
             ref_type="project", ref_id=p7.id, project_id=p7.id,
             dedup_key=f"filing-request:{p7.id}")
    db.commit()
    log(f"站内通知已生成（预警 {created.get('total', 0)} 条 + 立项待办）")

    # 让通知有已读/未读混合状态
    notifs = db.query(Notification).order_by(Notification.id).all()
    for n in notifs[: max(1, len(notifs) // 3)]:
        n.read_at = ts(-1, hour=17)
    db.commit()
    return {"projects": len(projects), "summary": summary, "notifications": len(notifs)}


# ---------------------------------------------------------------- 清理

def clean(db) -> int:
    """只清理示例数据（编号 PJ-YYYY-9xxx + 示例用户 + 其附件文件）。"""
    rows = db.query(Project).filter(Project.code.like(f"{CODE_PREFIX}%")).all()
    pids = [p.id for p in rows]
    removed_files = 0
    if pids:
        # 先删附件文件
        for a in db.query(Attachment).filter(Attachment.project_id.in_(pids)).all():
            try:
                Path(a.path).unlink(missing_ok=True)
                removed_files += 1
            except Exception:
                pass
        for folder in [DATA_DIR / "files" / str(pid) for pid in pids]:
            try:
                if folder.exists() and not any(folder.iterdir()):
                    folder.rmdir()
            except Exception:
                pass
        for model in (Notification, ProjectChange, Followup, Attachment, ProgressLog,
                      Milestone, Task, BudgetAdjust, Budget, Expense, ProjectMember):
            col = getattr(model, "project_id", None)
            if col is not None:
                db.query(model).filter(col.in_(pids)).delete(synchronize_session=False)
        db.query(Project).filter(Project.id.in_(pids)).delete(synchronize_session=False)
        db.commit()

    # 示例用户（保留 admin）
    usernames = [u[0] for u in USERS]
    uids = [u.id for u in db.query(User).filter(User.username.in_(usernames)).all()]
    if uids:
        db.query(Notification).filter(Notification.user_id.in_(uids)).delete(synchronize_session=False)
        db.query(UserRole).filter(UserRole.user_id.in_(uids)).delete(synchronize_session=False)
        from api.models import AuditLog, TokenBlacklist
        db.query(AuditLog).filter(AuditLog.user_id.in_(uids)).update({"user_id": None},
                                                                    synchronize_session=False)
        db.query(TokenBlacklist).filter(TokenBlacklist.user_id.in_(uids)).delete(synchronize_session=False)
        db.query(User).filter(User.id.in_(uids)).delete(synchronize_session=False)
        db.commit()

    print(f"已清理：项目 {len(pids)} 个、示例用户 {len(uids)} 个、附件文件 {removed_files} 个")
    return len(pids)


# ---------------------------------------------------------------- 入口

def main() -> None:
    ap = argparse.ArgumentParser(description="填充全流程模拟数据")
    ap.add_argument("--reset", action="store_true", help="先清理示例数据再填充")
    ap.add_argument("--clean", action="store_true", help="只清理示例数据")
    args = ap.parse_args()

    ensure_fts(engine)
    db = SessionLocal()
    try:
        if args.clean:
            clean(db)
            return

        exists = db.query(Project).filter(Project.code.like(f"{CODE_PREFIX}%")).count()
        if exists and not args.reset:
            print(f"检测到已有 {exists} 个示例项目；如需重建请加 --reset")
            return
        if exists and args.reset:
            clean(db)

        print("开始填充模拟数据 ...")
        result = seed(db)
        print()
        print(f"完成：{result['projects']} 个项目、{result['notifications']} 条通知")
        for code, name, desc in result["summary"]:
            print(f"  {code}  {name}\n      {desc}")
        print()
        print("示例账号（密码统一 demo123456）：")
        scope = {
            "demo_admin": "管理员：全部项目 + 审批中心 + 系统管理",
            "zhangwei": "负责人：9001/9003/9005/9007",
            "lina": "负责人：9002/9004/9006/9008",
            "wangqiang": "参与人：9001/9005",
            "zhaomin": "参与人：9001/9005",
            "liuyang": "参与人：9002/9004/9006",
            "chenjing": "参与人：9001/9002/9004（费用登记）",
            "sunlei": "负责人 9003、参与人 9001",
            "zhouzong": "参与人：9001（非管理员不再具备全局只读视图）",
        }
        for username, real_name, dept, roles in USERS:
            print(f"  {username:<12} {real_name:<6} {dept:<6} {'/'.join(roles):<24} {scope.get(username, '')}")
        print("  审批中心与系统管理仅管理员可用 → 用 demo_admin 演示（不影响你自己的 admin 密码）")
        print()
        print("建议验收路径：/dashboard → /projects → 项目详情四个 Tab → /progress → /costs → /approvals → 顶栏铃铛")
    finally:
        db.close()


if __name__ == "__main__":
    main()
