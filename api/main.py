import os
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware

# 确保模型注册
from . import models  # noqa: F401
from .core.deps import get_current_user
from .core.rbac import (
    MODULE_APPROVALS,
    MODULE_ASSETS,
    MODULE_CONTACTS,
    MODULE_FINANCE,
    MODULE_OPPORTUNITIES,
    MODULE_PARTNERS,
    MODULE_PROJECTS,
    MODULE_REPORTS,
    require_module,
)
from .core.storage import storage_profile, validate_storage_settings
from .routers import (
  admin,
  approvals,
  auth,
  budgets,
  contacts,
  dashboard,
  expenses,
  equipment_assets,
  finance,
  finance_accounting,
  meta,
  milestones,
  notifications,
  opportunities,
  partners,
  project_receivables,
  projects,
  reports,
  tasks,
)


@asynccontextmanager
async def lifespan(_app: FastAPI):
  """启动期校验：配置自相矛盾就**不让进程起来**，而不是绿着启动、每个请求才炸。

  `STORAGE_BACKEND=r2`/`auto` 而 `R2_*` 不全、或生产环境选本地后端时
  `validate_storage_settings()` 抛 `RuntimeError`，uvicorn 启动失败
  （容器重启并留在日志里）——这是「R2 是附件正文唯一持久化口径」的执行点。
  """
  settings = validate_storage_settings()
  if settings.backend == "r2" and settings.r2 is not None:
    print(f"[storage] 附件后端：r2（bucket={settings.r2.bucket}）——正文唯一持久化口径")
  else:
    print("[storage] 附件后端：本地临时暂存（仅开发/测试，正文不持久化）")
  yield


app = FastAPI(
  title="项目管理系统 API",
  version="0.1.0",
  lifespan=lifespan,
  description="""
## 功能模块与页面可见性契约（Stage 5，2026-09-28）

- **身份与模块目录**：唯一系统管理身份是 `User.is_super_admin`；旧 `admin` 角色和 `user_roles` 仅为兼容/历史数据，
  不授予权限。可分配功能模块目录为
  （`opportunities/projects/assets/reports/contacts/partners/approvals/finance`）∩ 用户生效模块；系统管理不属于可分配模块，仅超级管理员可访问。
- **生效规则**：超级管理员身份天然拥有全部可分配业务模块；普通用户以 `user_modules` 显式分配为准；
  存量/未显式分配用户回落到四个基础模块（升级平滑，行为不变）。
- **前端菜单与后端接口同一判定**：`GET /meta/me/menus` 与各路由 `require_module` 共用
  `core.rbac.effective_modules`，不会出现入口可见但接口 403 的错位契约。
- **审批资格** = 拥有「审批中心」模块（`can_approve`）；**系统管理**仅限超级管理员。
- **财务**（`/finance`）入口与全部财务路由（`finance`、`finance_accounting`）均由 finance 模块统一控制；
  账套成员行不授予访问权。模块用户具有相同访问权，账套期间、凭证状态、借贷平衡、辅助资料及项目可见范围校验继续生效；
  设备资产的特权写操作仍要求超级管理员。
- 超级管理员身份用于全局数据范围（跨部门/跨项目）与演示数据开关等高权限判定。

## 管理与审批边界契约（Stage 1 收敛，2026-09-16 确认；Stage 5 起模块化）

- **超级管理员**拥有全部可分配模块与全局数据范围：可跨部门、跨项目读取和操作。
- 管理接口（`/admin/*`）仅限超级管理员；审批接口（`/approvals/*`、`/budget-adjusts/{id}/approve`、
  `/expenses/{id}/approve|reject|exception`）、回收站（`/projects/recycle-bin/list`、项目删除与恢复）
  与项目删除/恢复分别要求超级管理员 / `approvals` 模块；鉴权先于任何业务读写。
- 审批中心 `GET /approvals/pending` 行内的 `can_decide` 与各决策入口共用同一判定
  （`core.rbac.can_approve`），不会出现按钮可见但接口拒绝的错位契约。
- **管理员全局 ≠ 包含回收站**：正常业务列表仍排除软删除项目，回收站单独查看与恢复。
- 普通用户按「项目负责人 / 项目成员」参与业务（立项、任务、进度填报、跟进、预算/支出登记），该参与路径本轮不变。
- 角色目录、`user_roles` 与 `account_book_members` 历史记录继续保留以兼容；这些旧角色/成员行不参与本次身份或模块授权判定。
- `project_manager` / `dept_manager` / `member` / `cost_admin` / `executive` 当前不参与授权判定；
  项目负责人/成员仍按既有业务对象规则参与项目业务。

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

# CORS：本地开发、Docker 与生产统一使用前端 3001，可用 CORS_ORIGINS 覆盖
_default_origins = "http://localhost:3001,http://127.0.0.1:3001"
origins = [
  o.strip() for o in os.getenv("CORS_ORIGINS", _default_origins).split(",") if o.strip()
]
app.add_middleware(
  CORSMiddleware,
  allow_origins=origins,
  allow_credentials=True,
  allow_methods=["*"],
  allow_headers=["*"],
  expose_headers=["Content-Disposition"],
)

def _module_guard(*modules: str):
    """路由级模块门禁依赖：拥有其中任一模块（超级管理员天然全量）才放行整个路由。

    前端菜单与后端接口共用 core.rbac.effective_modules，避免「入口可见但接口 403」。
    """
    def _dep(user=Depends(get_current_user)):
        require_module(user, *modules)
    return _dep


# 路由 → 允许的模块（任一即可）。auth/meta/dashboard/notifications 为全站公共面，不设模块门禁：
#   · projects 是项目详情、跨模块选择器与回收站（仅超级管理员）的共用读源，放行全部基础业务模块；
#   · reports 被支出页用于预算执行汇总，故同时放行 projects 等基础模块；
#   · tasks/milestones/budgets/expenses 是项目详情/进度/支出子页面的子资源，无独立导航模块，保持开放；
#   · finance / finance_accounting 由 finance 模块统一门禁，业务校验保留在各端点中。
_ROUTER_MODULES: list[tuple[object, tuple[str, ...]]] = [
    (contacts.router, (MODULE_CONTACTS,)),
    (partners.router, (MODULE_PARTNERS,)),
    (approvals.router, (MODULE_APPROVALS,)),
    (opportunities.router, (MODULE_OPPORTUNITIES,)),
    (equipment_assets.router, (MODULE_ASSETS,)),
    (reports.router, (MODULE_REPORTS, MODULE_PROJECTS, MODULE_OPPORTUNITIES, MODULE_ASSETS)),
    (project_receivables.router, (MODULE_OPPORTUNITIES, MODULE_PROJECTS, MODULE_ASSETS,
                                  MODULE_REPORTS)),
    (projects.router, (MODULE_OPPORTUNITIES, MODULE_PROJECTS, MODULE_ASSETS,
                       MODULE_REPORTS)),
]

for r in (
    admin.router,
    auth.router,
    meta.router,
    dashboard.router,
    notifications.router,
    tasks.router,
    milestones.router,
    budgets.router,
    expenses.router,
):
    app.include_router(r, prefix="/api/v1")

for r in (finance.router, finance_accounting.router):
    app.include_router(
        r,
        prefix="/api/v1",
        dependencies=[Depends(_module_guard(MODULE_FINANCE))],
    )

for r, _mods in _ROUTER_MODULES:
    app.include_router(
        r,
        prefix="/api/v1",
        dependencies=[Depends(_module_guard(*_mods))],
    )


@app.get("/health")
def health():
  """健康检查：额外回报附件存储后端，便于确认「是否真的接上了 R2」。

  只回后端名与桶名，**不含任何密钥**；`local` 表示尚未接对象存储。
  这里仍显式解析配置：若进程是在配置损坏后被探活，能直接报到 500（启动校验已经拦过一道）。
  """
  profile = storage_profile()
  body = {"ok": True, "storage_backend": profile["backend"]}
  if "bucket" in profile:
    body["storage_bucket"] = profile["bucket"]
  return body
