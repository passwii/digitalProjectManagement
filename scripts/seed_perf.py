#!/usr/bin/env python3
"""千级数据压测脚本（Stage 5）：生成 N 个项目 + 任务 + 预算 + 支出，用于验证列表 ≤2s。

用法：
    python3 scripts/seed_perf.py 2000          # 2000 个项目
    python3 scripts/seed_perf.py 2000 --clean  # 先清理 perf 前缀数据
"""
import argparse
import random
import sys
import time
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from api.core.database import SessionLocal, engine  # noqa: E402
from api.models import (Base, Budget, Department, Expense, Project,  # noqa: E402
                        ProjectMember, Task, User)

SUBJECTS = ["人工", "采购", "外包", "差旅", "其他"]
PREFIX = "PERF-"


def ensure_refs(db):
    if not db.query(Department).first():
        db.add(Department(name="压测部"))
        db.commit()
    if not db.query(User).first():
        from api.core.security import hash_password
        db.add(User(username="perfuser", pwd_hash=hash_password("perf123456"),
                    real_name="压测用户"))
        db.commit()
    return db.query(User).first().id


def clean(db):
    rows = db.query(Project).filter(Project.name.like(f"{PREFIX}%")).all()
    for p in rows:
        db.query(Task).filter_by(project_id=p.id).delete()
        db.query(Budget).filter_by(project_id=p.id).delete()
        db.query(Expense).filter_by(project_id=p.id).delete()
        db.query(ProjectMember).filter_by(project_id=p.id).delete()
        db.delete(p)
    db.commit()
    print(f"cleaned {len(rows)} perf projects")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("count", type=int, nargs="?", default=2000)
    ap.add_argument("--clean", action="store_true")
    args = ap.parse_args()

    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    try:
        if args.clean:
            clean(db)
            return
        owner = ensure_refs(db)
        base_year = date.today().year
        t0 = time.time()
        for i in range(1, args.count + 1):
            start = date.today() - timedelta(days=random.randint(0, 400))
            p = Project(
                code=f"PJ-{base_year}-P{i:05d}", name=f"{PREFIX}项目 {i:05d}",
                type=random.choice(["研发", "实施", "咨询", "工程"]),
                dept_id=1, owner_id=owner, plan_start=start,
                plan_end=start + timedelta(days=random.randint(30, 365)),
                budget_total=random.choice([50_000, 100_000, 300_000, 800_000]),
                priority=random.choice(["高", "中", "低"]),
                client=f"客户{i % 97}", description="压测数据，用于列表性能验证",
                status=random.choice(["draft", "filed", "doing", "paused", "done"]),
                created_by=owner,
            )
            db.add(p)
            db.flush()
            db.add(ProjectMember(project_id=p.id, user_id=owner))
            for j in range(random.randint(1, 5)):
                db.add(Task(project_id=p.id, name=f"任务{j + 1}", owner_id=owner,
                            plan_start=start, plan_end=start + timedelta(days=30),
                            weight=1, progress=random.choice([0, 30, 60, 100])))
            for s in random.sample(SUBJECTS, k=random.randint(1, 3)):
                db.add(Budget(project_id=p.id, subject=s, amount=random.randint(5000, 50000),
                              period_start=start, period_end=start + timedelta(days=180)))
                db.add(Expense(project_id=p.id, subject=s, amount=random.randint(100, 8000),
                               exp_date=start + timedelta(days=10), note="压测支出",
                               status="approved", by_id=owner))
            if i % 200 == 0:
                db.commit()
        db.commit()
        cost = time.time() - t0
        print(f"seeded {args.count} projects in {cost:.1f}s "
              f"(~{args.count / max(cost, 0.01):.0f} projects/s)")
        print("\n下一步：登录后访问 /projects 与 /reports，用浏览器 Network 面板看接口耗时")
    finally:
        db.close()


if __name__ == "__main__":
    main()
