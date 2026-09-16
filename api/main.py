import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .core.database import Base, engine, ensure_fts
from .routers import (admin, approvals, auth, budgets, dashboard, expenses, meta,
                      milestones, notifications, projects, reports, tasks)

# 确保模型注册后再建表
from . import models  # noqa: F401

Base.metadata.create_all(bind=engine)
ensure_fts(engine)  # 全文检索表（幂等；不支持 FTS5 时自动回退 LIKE）

app = FastAPI(
    title="项目管理系统 API",
    version="0.1.0",
    description="""
## 管理与审批边界契约（Stage 1 收敛，2026-09-16 确认）

- **管理员（`admin`）是唯一的管理与审批角色**，也是唯一拥有全局数据范围的用户：可跨部门、跨项目读取和操作。
- 管理接口（`/admin/*`：用户/角色/字典/参数/审计日志）、审批接口（`/approvals/*`、`/budget-adjusts/{id}/approve`、
  `/expenses/{id}/approve|reject|exception`）、回收站（`/projects/recycle-bin/list`、项目删除与恢复）**仅管理员可用**。
- 非管理员调用上述接口**稳定返回 403**，且鉴权先于业务读写，不会产生任何业务状态变更。
- 审批中心 `GET /approvals/pending` 行内的 `can_decide` 与各决策入口共用同一判定（`core.rbac.can_approve`），
  不会出现按钮可见但接口拒绝的错位契约。
- **管理员全局 ≠ 包含回收站**：正常业务列表仍排除软删除项目，回收站单独查看与恢复。
- 普通用户按「项目负责人 / 项目成员」参与业务（立项、任务、进度填报、跟进、预算/支出登记），该参与路径本轮不变。
- `project_manager` / `dept_manager` / `member` / `cost_admin` / `executive` 仅作为未来扩展的结构字段保留，
  当前不参与授权判定（不再有部门隔离、成员优先、高层只读、成本管理员独立全局权限）。
""",
)

# CORS：默认放行本地前端（3000/3001），可用 CORS_ORIGINS 覆盖（逗号分隔）
_default_origins = (
    "http://localhost:3000,http://127.0.0.1:3000,"
    "http://localhost:3001,http://127.0.0.1:3001"
)
origins = [o.strip() for o in os.getenv("CORS_ORIGINS", _default_origins).split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["Content-Disposition"],
)

for r in (auth.router, meta.router, admin.router, projects.router, tasks.router,
          milestones.router, budgets.router, expenses.router, reports.router,
          notifications.router, approvals.router, dashboard.router):
    app.include_router(r, prefix="/api/v1")


@app.get("/health")
def health():
    return {"ok": True}
