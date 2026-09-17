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

## 进度 / 成本 / 审批 / 通知闭环契约（Stage 4A 定稿，2026-09-16）

- **入参校验零副作用**：任务（名称/权重>0/计划区间落在项目内/父任务同项目且≤5级/前置同项目不成环/状态合法流转）、
  进度（0—100，前置未完成不得报 100%）、支出（科目白名单/金额>0/日期范围）、预算（金额≥0/期间自洽且落在项目内）
  全部在**任何写库之前**校验；非法一律 `400` + 中文原因，且**不留部分修改**。`NaN`/`Infinity` 被显式拒绝。
- **填报历史只可追加**：`/progress-logs` 无 PATCH/DELETE（`405`），任务 `progress` 是快照、每次变化都追加一条 log。
- **支出闭环**：凭证附件（`POST|GET /expenses/{id}/vouchers`、`/{aid}/download`、`DELETE`）；
  驳回后重新提交（`POST /expenses/{id}/resubmit`，仅申请人本人 + 仅「已驳回」状态，`resubmit_count` 累加，
  驳回意见保留在时间线）；审批意见 `decision_reason` / `decided_at` / `approved_by` 落在行上，
  驳回与特批**意见必填**；申请人可查 `GET /expenses/{id}/timeline` 与 `GET /budget-adjusts/{id}/timeline`。
  凭证与项目附件**互不串门**：项目附件列表/下载/删除只认项目级附件。
- **`mine=1`**：`/expenses?mine=1`、`/budget-adjusts?mine=1` 供申请人自查自己单据的驳回原因与状态。
- **时间线**：`approval_records` 记录每次状态变化（`action`: submit/resubmit/approve/reject/exception/auto_approve，
  含 `from_status`→`to_status`、`actor_id`、`reason`、`created_at`）；预算审批开关关闭时走 `auto_approve` 且 `approved_by` 留空。
- **通知可定位**：每条通知都带 `ref_type`/`ref_id`/`project_id`（`ref_type` 白名单），响应额外回 `link` 与 `ref_complete`；
  `GET /notifications/{id}` 另回 `ref_available`（引用对象已删除时为 false）。
- **通知可追踪**：`state` = pending/done/ignored + `handled_at`/`handled_by`/`handle_note`；
  `POST /notifications/{id}/handle`、`POST /notifications/handle-all`；`/notifications/count` 回 `unread` 与 `pending`。
- **去重窗口**：`sys_params.notify_dedup_days`（默认 1 天，**时间窗口**而非自然日切分，跨零点不重推）；置 0 = 关闭去重。
- **跟进提醒可追踪**：`followups.remind_state` = pending/done/ignored/none；到期扫描只取未推送过的，
  推送后自动标记 done，同一到期记录不会重复灌入；处理入口 `POST /projects/{id}/followups/{fid}/remind`。
- **审计原子**：关键写操作统一 `core.audit.commit_audited()`（业务行 + 时间线 + 通知 + 审计行同一次 commit）；
  审计写失败 → 整体回滚 + `500`，**绝不静默当成功**。
- **审批中心无 N+1**：`GET /approvals/pending` 每类各一次 COUNT + 一次取当页，关联名称批量映射；
  可选 `kind` 只看一类，`totals` 仍给全量口径。
- 实现见 `api/core/validation.py`、`api/core/timeline.py`、`api/core/notify.py`、`api/core/jobs.py`、`api/core/audit.py`；
  README「进度 / 成本 / 审批 / 通知闭环契约」节；回归测试见 `tests/test_stage4a_closure.py`。
""",
)

# CORS：默认放行本地前端 3001（保留 3000 方便 Next dev），可用 CORS_ORIGINS 覆盖
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

CSRF_EXEMPT_PATHS = {"/api/v1/auth/login", "/api/v1/auth/logout"}


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
