import os

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .core.cookies import UNSAFE_METHODS, csrf_header_valid, request_uses_cookie_auth
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

## 列表分页与查询契约（Stage 3A 定稿，2026-09-16）

- **统一信封**：所有列表接口返回 `{"total", "page", "size", "items"}`；省略分页参数 = `page=1&size=20`，
  不会因为不传参数而返回无界数据。`total` 与 `items` 同一次查询条件（含权限与软删除过滤）。
- **参数校验**：`page` ≥1、`size` 1—100（默认 20）、`sort` 为字段白名单（逗号分隔最多 3 个，前缀 `-` 倒序）；
  非法取值一律 `400`（中文原因），排序字段只做白名单查表，**用户输入不会拼入 SQL**。
- **翻页语义**：越过末页返回空 `items`（不报错、不重复）；排序在请求字段之后自动追加主键 `id` 兜底，翻页不重不漏。
- **覆盖接口**：`/projects`、`/projects/options`、`/projects/recycle-bin/list`、`/projects/{id}/followups`、`/tasks`、
  `/progress-logs`、`/milestones`、`/budgets`、`/budget-adjusts`、`/expenses`、`/admin/users`、`/admin/logs`。
- **选择器与字典**：项目选择器用 `GET /projects/options`（最小字段 + 关键词分页）；人员搜索用 `GET /meta/users/search`；
  `/meta/users`、`/meta/depts` 为「一次取回本地映射」字典接口，服务端硬上限 500 行。
- **审批待办有界**：`GET /approvals/pending` 每类最多 `limit` 条（默认 200，上限 500），并返回 `totals` 与 `limit`。
- **边界不变**：子表列表与审批待办继续执行「可见 + 未软删除」过滤；管理员全局 ≠ 包含回收站。
- 实现与细节见 `api/core/paging.py`、README「列表分页与查询契约」节；回归测试见 `tests/test_mvp.py` 第 31—37 项。
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

CSRF_EXEMPT_PATHS = {"/api/v1/auth/login"}


@app.middleware("http")
async def csrf_protect(request: Request, call_next):
    is_api_write = (
        request.method in UNSAFE_METHODS
        and request.url.path.startswith("/api/v1/")
        and request.url.path not in CSRF_EXEMPT_PATHS
    )
    if is_api_write and request_uses_cookie_auth(request) and not csrf_header_valid(request):
        return JSONResponse({"detail": "CSRF 校验失败"}, status_code=403)
    return await call_next(request)

for r in (auth.router, meta.router, admin.router, projects.router, tasks.router,
          milestones.router, budgets.router, expenses.router, reports.router,
          notifications.router, approvals.router, dashboard.router):
    app.include_router(r, prefix="/api/v1")


@app.get("/health")
def health():
    return {"ok": True}
