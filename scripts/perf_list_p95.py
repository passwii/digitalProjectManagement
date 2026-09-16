#!/usr/bin/env python3
"""列表接口 P95 压测（Stage 3A 验收）：2000 项目规模下核心列表 P95 ≤ 2s。

用法
    python3 scripts/perf_list_p95.py                        # 2000 项目 / 每接口 30 次采样
    python3 scripts/perf_list_p95.py --projects 2000 --runs 30
    python3 scripts/perf_list_p95.py --projects 500 --runs 10 --keep-db

与 `scripts/seed_perf.py` 的区别
    · seed_perf.py 往真实的 data/app.db 灌数据（供浏览器手测）；
    · 本脚本在临时 sqlite 库上自建数据集，用依赖注入覆盖 get_db，走真实 ASGI 请求路径
      （含鉴权、分页、序列化开销），跑完即弃，不动开发库，可直接接 CI（P95 超阈值退出码 1）。
"""
import argparse
import random
import statistics
import sys
import tempfile
import time
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from sqlalchemy import create_engine  # noqa: E402
from sqlalchemy.orm import sessionmaker  # noqa: E402

from api.core.database import Base, ensure_fts, get_db  # noqa: E402
from api.core.security import hash_password  # noqa: E402
from api.main import app  # noqa: E402
from api.models import (  # noqa: E402
    Budget,
    Department,
    Expense,
    Followup,
    Milestone,
    Project,
    ProjectMember,
    Role,
    SysParam,
    Task,
    User,
    UserRole,
)

THRESHOLD_S = 2.0
SUBJECTS = ["人工", "采购", "外包", "差旅", "其他"]


def build_db(path: Path):
    eng = create_engine(f"sqlite:///{path}", connect_args={"check_same_thread": False})
    Base.metadata.create_all(bind=eng)
    ensure_fts(eng)          # 与生产一致：FTS5 trigram（不支持时静默回退 LIKE）
    return sessionmaker(bind=eng, autoflush=False, autocommit=False)


def seed(Session, n: int):
    """建 1 个管理员 + n 个项目，每个项目带任务/预算/支出（外加少量里程碑/跟进）。"""
    s = Session()
    try:
        dept = Department(name="压测部")
        s.add(dept)
        s.flush()
        for code in ("admin", "member"):
            s.add(Role(code=code, name=code))
        s.flush()
        admin = User(username="perfadmin", pwd_hash=hash_password("perf123456"),
                     real_name="压测管理员", dept_id=dept.id)
        s.add(admin)
        s.flush()
        s.add(UserRole(user_id=admin.id,
                       role_id=s.query(Role).filter_by(code="admin").first().id))
        for k, v in {"budget_warn_rate": "0.8", "budget_approval_on": "0",
                     "expense_approval_on": "0", "milestone_warn_days": "3"}.items():
            s.add(SysParam(key=k, value=v))
        s.flush()

        year = date.today().year
        t0 = time.time()
        for i in range(1, n + 1):
            start = date.today() - timedelta(days=random.randint(0, 400))
            p = Project(code=f"PJ-{year}-P{i:05d}", name=f"PERF-项目 {i:05d}",
                        type=random.choice(["研发", "实施", "咨询"]), dept_id=dept.id,
                        owner_id=admin.id, plan_start=start,
                        plan_end=start + timedelta(days=random.randint(30, 365)),
                        budget_total=random.choice([50_000, 100_000, 300_000]),
                        priority=random.choice(["高", "中", "低"]), client=f"客户{i % 97}",
                        description="压测数据，用于列表性能验证",
                        status=random.choice(["draft", "filed", "doing", "paused", "done"]),
                        created_by=admin.id)
            s.add(p)
            s.flush()
            s.add(ProjectMember(project_id=p.id, user_id=admin.id))
            for j in range(random.randint(1, 4)):
                s.add(Task(project_id=p.id, name=f"任务{j + 1}", owner_id=admin.id,
                           plan_start=start, plan_end=start + timedelta(days=30),
                           weight=1, progress=random.choice([0, 30, 60, 100])))
            for subj in random.sample(SUBJECTS, k=random.randint(1, 3)):
                s.add(Budget(project_id=p.id, subject=subj, amount=random.randint(5000, 50000),
                             period_start=start, period_end=start + timedelta(days=180)))
                s.add(Expense(project_id=p.id, subject=subj, amount=random.randint(100, 8000),
                              exp_date=start + timedelta(days=10), note="压测支出",
                              status="approved", by_id=admin.id))
            if i % 100 == 0:
                s.add(Milestone(project_id=p.id, name=f"里程碑{i}",
                                plan_date=start + timedelta(days=90), owner_id=admin.id))
                s.add(Followup(project_id=p.id, user_id=admin.id, content="压测跟进"))
            if i % 200 == 0:
                s.commit()
        s.commit()
        first_pid = s.query(Project.id).order_by(Project.id).first()[0]
        return first_pid, time.time() - t0
    finally:
        s.close()


def p95(samples):
    data = sorted(samples)
    rank = round(0.95 * (len(data) - 1))
    try:
        idx = min(len(data) - 1, int(rank))
    except (TypeError, ValueError):   # 防御性兜底：rank 理论上必为数值
        idx = len(data) - 1
    return data[idx]


def bench(client, headers, url, runs):
    client.get(url, headers=headers)          # 预热（跳过首帧连接/缓存开销）
    samples = []
    last = None
    for _ in range(runs):
        t0 = time.perf_counter()
        last = client.get(url, headers=headers)
        samples.append(time.perf_counter() - t0)
        assert last.status_code == 200, f"{url} -> {last.status_code} {last.text[:200]}"
    assert last is not None, "采样次数需 ≥1"
    body = last.json()
    return statistics.median(samples), p95(samples), len(body.get("items", [])), body.get("total")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--projects", type=int, default=2000, help="项目数量（默认 2000）")
    ap.add_argument("--runs", type=int, default=30, help="每个接口采样次数（默认 30）")
    ap.add_argument("--keep-db", action="store_true", help="保留临时库便于排查")
    args = ap.parse_args()

    tmpdir = Path(tempfile.mkdtemp(prefix="perf_list_p95_"))
    db_path = tmpdir / "perf.db"
    Session = build_db(db_path)
    pid, seed_cost = seed(Session, args.projects)
    print(f"临时库：{db_path}")
    print(f"数据集：{args.projects} 个项目（含任务/预算/支出）"
          f"，灌数据 {seed_cost:.1f}s（~{args.projects / max(seed_cost, .01):.0f} 项目/s）")

    def override():
        sess = Session()
        try:
            yield sess
        finally:
            sess.close()
    app.dependency_overrides[get_db] = override

    from fastapi.testclient import TestClient
    client = TestClient(app)
    r = client.post("/api/v1/auth/login",
                    json={"username": "perfadmin", "password": "perf123456"})
    assert r.status_code == 200, r.text
    headers = {"Authorization": f"Bearer {r.json()['access_token']}"}

    targets = [
        ("项目列表（翻页）", "/api/v1/projects?page=2&size=20&sort=-id"),
        ("项目列表（关键词+状态+排序）", "/api/v1/projects?keyword=PERF&status=doing&sort=-budget_total&size=20"),
        ("项目选择器（最小字段）", "/api/v1/projects/options?keyword=PERF&page=1&size=20"),
        ("任务列表（跨项目）", "/api/v1/tasks?page=1&size=20&sort=-id"),
        ("任务列表（单项目）", f"/api/v1/tasks?project_id={pid}&page=1&size=20"),
        ("预算列表", "/api/v1/budgets?page=1&size=20"),
        ("支出列表（按金额排序）", "/api/v1/expenses?page=1&size=20&sort=-amount"),
        ("预算调整单列表", "/api/v1/budget-adjusts?page=1&size=20"),
        ("里程碑列表", "/api/v1/milestones?page=1&size=20"),
        ("填报历史列表", "/api/v1/progress-logs?page=1&size=20"),
        ("审计日志列表", "/api/v1/admin/logs?page=1&size=20"),
        ("用户列表", "/api/v1/admin/users?page=1&size=20"),
        ("审批待办聚合", "/api/v1/approvals/pending?limit=50"),
    ]

    print(f"\n采样 {args.runs} 次/接口（预热 1 次，含鉴权与序列化开销）；阈值 P95 ≤ {THRESHOLD_S}s\n")
    print(f"{'接口':<26}{'median':>10}{'P95':>10}{'items':>8}{'total':>10}")
    print("-" * 64)
    failures = []
    for name, url in targets:
        median, p95v, n_items, total = bench(client, headers, url, args.runs)
        flag = "" if p95v <= THRESHOLD_S else "  ❌ 超阈值"
        print(f"{name:<26}{median:>9.3f}s{p95v:>9.3f}s{n_items:>8}{total!s:>10}{flag}")
        if p95v > THRESHOLD_S:
            failures.append((name, url, p95v))

    app.dependency_overrides.clear()
    if not args.keep_db:
        import shutil
        try:
            shutil.rmtree(tmpdir, ignore_errors=True)
        except OSError as e:      # 临时库清理失败不影响压测结论
            print(f"（临时库清理失败，已保留：{tmpdir}：{e}）")

    print("\n复现命令：python3 scripts/perf_list_p95.py "
          f"--projects {args.projects} --runs {args.runs}")
    if failures:
        print(f"\n❌ {len(failures)} 个接口 P95 超过 {THRESHOLD_S}s：")
        for name, url, p95v in failures:
            print(f"   {name} ({url}) P95={p95v:.3f}s")
        return 1
    print(f"\n✅ 全部 {len(targets)} 个核心列表接口 P95 ≤ {THRESHOLD_S}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
