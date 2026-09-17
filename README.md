# 数慧致科OA管理平台

Next.js 14（前端）+ FastAPI（后端）+ SQLite（单文件库）实现的 MVP。计划与设计见 `docs/superpowers/plans/`。

## 本版本交付口径（2026-09-16）

- 全站品牌标题为「数慧致科OA管理平台」，登录账号统一使用手机号，系统不提供自助注册。
- 初始管理员账号 `15796280534` / `admin123456`，首次登录强制修改密码。管理员签发的其他账号同样强制首登改密。
- 项目台账支持手填项目编号、固定负责人列表、合同状态、前向/后向合同及合同附件。
- 项目完整档案默认进入可编辑白板，可自动保存文字并上传图片素材。
- 进度跟踪仅保留列表模式，按钮为「添加进度」，字段只有进度节点时间和进度关键内容。
- 支出登记不再使用预算科目，人员为固定下拉列表，保留支出金额、日期和费用说明。
- 全站采用 Teambition 式商务蓝，已完成手机端、iPad 竖屏和横屏适配。

## 启动

后端（端口 8001）：

```bash
cd api
export PYTHONPATH=$(cd .. && pwd)
alembic upgrade head        # 首次：建表
python3 -m api.seed         # 首次：种子数据（幂等，可重复执行）
uvicorn api.main:app --port 8001
```

前端（端口 3001）：

```bash
cd web
npm install                 # 首次
npm run build && npx next start --port 3001
# 开发模式：npx next dev --port 3001
```

打开 http://localhost:3001/login

## 认证会话配置

开发环境默认使用 `dev-secret-change-me` 和 HTTP Cookie。生产环境必须设置：

```bash
export APP_ENV=production
export APP_SECRET="$(openssl rand -hex 32)"
export COOKIE_SECURE=1
```

登录成功后，后端设置：

- `pm_access_token`：HttpOnly access Cookie。
- `pm_refresh_token`：HttpOnly refresh Cookie，Path 限制为 `/api/v1/auth`。
- `pm_csrf_token`：JavaScript 可读 CSRF Cookie。
- `pm_session`：HttpOnly 会话提示 Cookie，供 Next.js middleware 在 access Cookie 过期后放行受保护页面并触发刷新。

前端写请求自动发送 `X-CSRF-Token`，token 不再写入 localStorage。

生产环境 Web 与 API 应部署在同一 site/host（推荐同源反向代理）。CSRF Cookie 需要前端 JavaScript 读取，会话提示也需要被 Next.js middleware 看到；跨主机或仅跨子域部署时必须另行设计 Cookie Domain 与同站策略。

跨标签页刷新与登出串行依赖 Web Locks API，生产环境必须使用安全上下文（HTTPS；`localhost` 开发环境例外）。浏览器不支持 Web Locks 时，前端仍用模块内队列保证同一标签页的刷新/登出并发安全，但无法协调多个标签页同时刷新。

## 演示数据开关（全站生效）

`scripts/seed_mock.py` 写入的演示数据带 `is_demo` 标记。系统参数 `demo_data_on` 控制是否展示：

- **默认关闭**：演示项目在项目台账、工作台、报表、预警、任务里全部排除，直接访问 URL 也按不存在处理，保证各处统计口径一致
- **打开方式**（仅管理员）：
  - 项目台账页头右上角「显示演示数据」开关
  - 系统管理 → 参数 → `demo_data_on`
  - 直连：`PUT /api/v1/admin/demo-data` body `{"on": true}`
- 开关打开时页面顶部有提示条，避免误把演示数据当成真实数据
- 非管理员只读该状态（用于显示提示），不能切换

## 账号

| 账号 | 密码 | 角色 |
|---|---|---|
| 15796280534 | admin123456 | 系统管理员（首次登录强制改密） |

首次登录会跳转 `/change-password`，设置新密码后进入系统。若忘记密码，重置：

```bash
cd api && python3 -c "
import sys; sys.path.insert(0,'..')
from api.core.database import SessionLocal
from api.core.security import hash_password
from api.models import User
db=SessionLocal(); u=db.query(User).filter_by(username='15796280534').first()
u.pwd_hash=hash_password('admin123456'); u.must_change_pwd=False; db.commit(); print('reset ok')"
```

## 已验证功能（对照需求说明书）

- 登录：空值拦截、错密不泄露用户存在、连续 5 次锁定 15 分钟、JWT 2h/7d、登出拉黑 jti、登录审计
- 台账：编号 `PJ-2026-0001` 自动生成唯一、状态机 7 态非法流转 400、字段变更留痕时间线、附件白名单 20MB、跟进记录 + 到期提醒、组合筛选 + 拼音无关关键字检索
- 进度：里程碑（临近 3 天/逾期预警）、多级 WBS（≤5 级 + 前置依赖环检测 + Excel 导入）、进度填报（仅本人任务，越权 403）、加权进度 `Σ(进度×权重)/Σ权重`、负责人确认快照、列表/看板/只读甘特图、逾期/临近/停滞三预警
- 成本：预算按项目×科目（期间须落在项目计划内）、调整审批留痕、支出登记与审批、`已支出=已通过Σ`、执行率实时计算、80% 预警（阈值可配置）、超预算拦截 + 特批放行、四维度报表（项目/科目/部门/月）+ Excel 导出（与页面同 service 同口径）
- 系统管理：用户/角色/字典/参数/审计日志（admin 专属）、单一管理员全局管理与审批边界（非 admin 稳定 403）

## 功能一览

**登录与权限**
- 首屏 `/login`，首次登录强制改密，连续 5 次错误锁定 15 分钟（可配）
- JWT access 2h / refresh 7d，登出拉黑 jti，未登录访问一律 401 并跳登录
- **权限边界（已确认契约，2026-09-16）**：
  - 管理员（`admin`）是唯一的管理与审批角色，也是唯一拥有全局数据范围的用户：跨部门、跨项目读取和操作。
  - 管理接口（`/admin/*`）、审批接口（`/approvals/*`、`/budget-adjusts/{id}/approve`、`/expenses/{id}/approve|reject|exception`）、
    回收站（`/projects/recycle-bin/list`、项目软删除与恢复）**仅管理员可用**；非管理员稳定 403，且鉴权先于业务读写，不产生任何状态变更。
  - 审批中心 `GET /approvals/pending` 行内的 `can_decide`、`GET /meta/me/menus` 的 `can_approve` 与各决策入口共用同
    一判定（`core.rbac.can_approve`），不存在「按钮可见但接口拒绝」的错位契约。
  - `project_manager` / `dept_manager` / `member` / `cost_admin` / `executive` 仅作为未来扩展的结构字段保留，当前不参与授
    权判定（不再有部门隔离、成员授权优先于部门隔离、高层只读、成本管理员独立全局权限）。
  - 普通用户按「项目负责人 / 项目成员」参与业务（立项、任务、进度填报、跟进、预算/支出登记），该参与路径本轮不变。
  - 管理员全局 ≠ 包含回收站：正常业务列表仍排除软删除项目，回收站单独查看与恢复。
  - **子表边界统一**：预算、调整单、支出、里程碑、任务、填报历史、报表在未指定 `project_id` 时只返回「可见 + 未软删除」项目的数据；
    子表写入口与决策入口对软删除项目一律 404（不静默写入、不产生状态变更）；审批待办与「待我审批」计数同样排除软删除项目。
  - 接口契约同步写在 OpenAPI 描述里（启动后 `/docs` 可见，来源 `api/main.py`）。

**工作台（`/dashboard`）**
- KPI：我的项目 / 逾期任务 / 待我审批 / 本月支出
- 图表（recharts）：近 6 个月支出趋势、科目支出构成、预算 vs 支出对比
- 项目健康度（正常/风险/异常）、本周动态（逾期、7 天内到期、最近填报）

**项目台账（`/projects`）**
- 列表：关键字全文检索（FTS5 高亮片段）、状态/负责人筛选、分页、行点击开右侧详情抽屉
- 新建/编辑走弹窗；状态机 7 态流转（含「待立项审批」），危险流转二次确认
- 详情 4 Tab：档案 / 变更留痕时间线 / 附件（上传·下载·删除）/ 跟进（增删改 + 到期提醒）
- 成员管理弹窗（多选 + 搜索，负责人不可移除）
- 回收站：软删除 + 恢复（仅管理员，进行中项目不可删）

**进度跟进（`/progress`）**
- 任务：弹窗新建/编辑/删除，多级（≤5）与前置依赖环检测，Excel 导入
- 进度填报弹窗（含填报历史），加权进度 `Σ(进度×权重)/Σ权重`，负责人一键确认快照
- 里程碑：弹窗新建/编辑/删除/完成，临近 3 天与逾期预警
- 三视图：列表 / 看板 / 只读甘特图；逾期任务标红

**成本支出（`/costs`）**
- 预算登记与调整申请（弹窗），期间须落在项目计划内
- 支出登记弹窗；审批开关开启或超预算时转「待审批」；超预算直接登记被拦截
- 执行率实时计算、80% 预警（阈值可配）、待审批单可 通过 / 驳回 / 特批放行（均二次确认）

**审批中心（`/approvals`）**
- 管理员审批中心（非管理员访问稳定 403）：三类待办聚合：立项审批 / 预算调整 / 支出审批，行内 `can_decide` 与决策入口同一判定
- 决策可填审批意见，结果以站内通知回推给申请人；立项/预算/支出审批人一律为管理员

**通知（顶栏铃铛）**
- 五类通知落库：任务逾期 / 里程碑 / 项目停滞 / 预算预警 / 跟进到期 / 审批结果
- 未读计数（每分钟刷新）、下拉面板、单条已读、全部已读、点击跳转对应条目
- 懒同步 5 分钟节流 + 按天去重 + 每类上限，避免重复与灌爆

**报表（`/reports`）**
- 四维度筛选（项目/部门/科目/月份）+ 明细 + 按科目/按部门汇总
- Excel 导出与页面同 service 同口径，注明「管理口径，与财务账差异」

**系统管理（`/admin`）**
- 用户（弹窗新增/编辑/角色多选/停用启用）、角色、字典（可新增）、参数（弹窗编辑，即时生效）、审计日志（分页 + Drawer 详情 + 导出 Excel）、回收站

## 列表分页与查询契约（Stage 3A，2026-09-16 定稿）

所有列表接口统一分页、排序与查询边界，前端与回归测试可直接依赖（实现见 `api/core/paging.py`）：

- **响应信封**：`{"total": int, "page": int, "size": int, "items": [...]}`
  - `total` = 当前筛选 + 权限 + 软删除条件下的全量条数（与 `items` 同一次查询条件）。
  - **省略分页参数 = `page=1&size=20`**：任何列表都不会因为「不传参数」而返回无界数据。
  - 越过末页（`page` 超过最后一页）返回空 `items`，不抛异常、不重复上一页数据。
- **请求参数**：`page`（≥1，默认 1）、`size`（1—100，默认 20）、`sort`（白名单字段，逗号分隔最多 3 个，前缀 `-` 表示倒序）。
  - 非法 `page`/`size`/`sort` 一律 `400` 并返回中文原因（不做静默截断）。
  - `sort` 只做「字段名 → ORM 列」白名单查表，**用户输入永远不会被拼进 SQL**。
  - 排序稳定性：请求的 `sort` 之后自动追加主键 `id` 兜底，连续翻页不重不漏。
- **覆盖接口**：`/projects`、`/projects/options`、`/projects/recycle-bin/list`、`/projects/{id}/followups`、
  `/tasks`、`/progress-logs`、`/milestones`、`/budgets`、`/budget-adjusts`、`/expenses`、
  `/admin/users`、`/admin/logs`。
- **项目选择器最小字段**：`GET /projects/options` 只回 `id/code/name/status/owner_id/dept_id`，
  关键词按名称/编号匹配（不走 FTS，避免命中集预截断造成 `total` 失真），前端不必再靠 `?size=100` 拉全量。
- **字典类接口硬上限**：`GET /meta/users`（支持 `keyword`/`dept_id`/`status`/`ids` 筛选）、`GET /meta/depts`
  保留「一次取回后本地映射 id→名称」的用法，但**服务端硬上限 500 行**；需要搜索式分页（如人员选择器）
  用 `GET /meta/users/search`（返回信封）。
- **审批待办有界**：`GET /approvals/pending` 每类最多返回 `limit` 条（默认 200，上限 500），
  同时返回 `totals`（三类待办真实总数）与 `limit`，前端可提示「还有 N 条」；行内 `can_decide` 与决策入口同一判定不变。
  待办行的关联名称改为批量取，消除原来的 N+1。
- **权限与软删除边界不变**：子表列表与审批待办继续执行「可见 + 未软删除」下推过滤；
  管理员全局 ≠ 包含回收站，回收站单独分页查看与恢复。

> ⚠️ 破坏性变更（Stage 3B 前端需同步）：`/tasks`、`/budgets`、`/budget-adjusts`、`/expenses`、
> `/projects/{id}/followups`、`/milestones`、`/projects/recycle-bin/list`、`/progress-logs`
> 过去在省略分页参数时返回**裸数组**（部分接口只在显式传 `page` 时才回信封），现在**一律返回信封**；
> 消费方统一用 `unwrapPaged`（`web/lib/api.ts`）取值即可。

## 进度 / 成本 / 审批 / 通知闭环契约（Stage 4A，2026-09-16 定稿）

补齐「每个状态都有来源、去向和审计记录」，实现见 `api/core/validation.py`、`api/core/timeline.py`、
`api/core/audit.py`、`api/core/notify.py`、`api/core/jobs.py`。

### 服务端入参校验（非法请求零副作用）

所有校验都在**任何写库动作之前**完成，失败返回 `400` + 中文原因，且不留下部分修改：

| 对象 | 规则 |
|---|---|
| 任务 | 名称非空（≤128 字）；权重 **>0** 且有限；计划开始 ≤ 计划结束；任务计划区间须落在项目计划区间内；父任务须同项目且层级 ≤5；前置任务须同项目且不成环；状态仅限 `todo/doing/paused/done` 的合法流转 |
| 进度填报 | `0 ≤ progress ≤ 100`；`remaining_days` 0—3650；**前置任务未完成时不得报 100% 或置 `done`** |
| 支出 | 科目须在 `人工/采购/外包/差旅/其他` 内；金额 **>0** 且有限（拒绝 `NaN`/`Infinity`）；支出日期不早于项目计划开始、距今不超过 1 年 |
| 预算 / 调整 | 金额 ≥0（调整需与现值不同）；期间开始 ≤ 结束且落在项目计划起止内；科目白名单 |
| 通知 | `page`/`size` 边界；`state`/`type` 白名单 |

`NaN` / `Infinity` 是被显式拒绝的：JSON 里它们能被解析成 `float('nan')`，一旦落库会让后续所有金额比较静默为 `False`。

### 进度填报历史不可覆盖

`/progress-logs` **只有 POST 与 GET**（`PATCH`/`DELETE` 返回 `405`）；任务上的 `progress` 是「最新填报快照」，
任何进度变化都会**追加**一条 log。因此 `progress` 永远可由 log 序列复现，不存在历史被直接改写的路径。

### 支出闭环：凭证 / 驳回重提 / 审批意见

- **凭证附件**（`attachments.ref_type='expense'` + `ref_id`）：
  `POST /expenses/{id}/vouchers`（上传，`pdf/docx/xlsx/png/jpg/jpeg`，≤20MB）、
  `GET /expenses/{id}/vouchers`、`GET /expenses/{id}/vouchers/{aid}/download`、
  `DELETE /expenses/{id}/vouchers/{aid}`（上传者本人或管理员）。
  ⚠️ **凭证与项目附件互不串门**：`GET /projects/{id}/attachments` 只回项目级附件，项目附件下载/删除入口也拒绝支出凭证（反之亦然）。
- **驳回后重新提交**：`POST /expenses/{id}/resubmit`，仅「已驳回」且申请人本人（或管理员）可用；可同时修正
  科目/金额/日期/说明；成功后回到 `pending`、`resubmit_count` +1，**驳回意见保留在时间线里不被覆盖**。
- **审批意见**：支出行直接带 `decision_reason` / `decided_at` / `approved_by` / `resubmit_count` /
  `can_resubmit`，列表即可看到驳回原因；`reject` 与 `exception` **意见/理由必填**。
- **申请人可查的时间线**：`GET /expenses/{id}/timeline`（非管理员可查自己可见的支出）、
  `GET /budget-adjusts/{id}/timeline`（申请人可查），管理员另有 `GET /approvals/{kind}/{id}/timeline`。
  时间线写在 `approval_records`（kind=expense/budget_adjust/project_filing），含 `action` / `from_status → to_status` /
  `actor_id` / `reason` / `created_at`；`action` 取值：`submit`/`resubmit`/`approve`/`reject`/`exception`/`auto_approve`。
- **自动生效不冒充人工审批**：预算审批开关关闭时系统自动生效，走 `auto_approve` 且 `approved_by` 留空。
- **筛选**：`GET /expenses?mine=1`、`GET /budget-adjusts?mine=1` 供申请人自查单据。

### 通知：可定位引用 + 可追踪处理状态 + 去重窗口

- **引用三元组**：每条通知都带 `ref_type` / `ref_id` / `project_id`；`ref_type` 白名单
  `project/task/milestone/expense/budget_adjust/followup`（白名单外降级为空，不写入无法解析的引用）。
- **跳转链接**：响应额外回 `link`（服务端给出唯一跳转路径）与 `ref_complete`，前端不必自猜规则；
  `GET /notifications/{id}` 另回 `ref_available`（引用对象已删除/不可见时为 `false`），供「对象不存在」的兜底提示。
  `link` 形如 `/progress?project_id=1&task_id=2`、`/costs?project_id=1&expense_id=5`、`/approvals?budget_adjust_id=3`。
- **处理状态**：`state` = `pending` 待处理 / `done` 已处理 / `ignored` 已忽略，配 `handled_at` / `handled_by` / `handle_note`。
  `POST /notifications/{id}/handle`（单条）、`POST /notifications/handle-all`（批量，支持 `type` 限定）；
  列表支持 `?state=` / `?type=` 筛选，`/notifications/count` 同时回 `unread` 与 `pending`。
- **去重窗口**：`notify_dedup_days`（默认 1 天）——**时间窗口**而非自然日切分，跨零点不会立刻重推同一到期记录；
  去重键含引用 id（如 `overdue_task:12`），不同任务/里程碑/支出/跟进互不影响。置 0 = 关闭去重。
  `GET /notifications/dedup/config` 可读当前窗口（便于解释「为什么同一条预警没有重复出现」）。
- **跟进提醒可追踪**：`followups.remind_state` = `pending`（待提醒）/ `done`（已通知或已处理）/ `ignored` / `none`（无提醒时间）。
  到期扫描**只取未推送过的**，推送后自动标记 `done` + `reminded_at`，同一到期记录不会重复灌入；
  处理入口 `POST /projects/{id}/followups/{fid}/remind`。
- **四类预警的引用**：逾期任务 → `task`；里程碑临近 → `milestone`；项目停滞 → `project`；
  预算预警 → `project`（去重键仍按 `项目:科目` 区分）。

### 审计：关键写操作与业务变更原子提交

- 关键写路径（任务/支出/预算调整/审批决策/特批/项目状态流转/成员/参数/用户）统一用
  `core.audit.commit_audited()`：**业务行 + 时间线 + 通知 + 审计行同一次 commit**。
  审计写失败 → 整体回滚 + `500`（`审计写入失败，本次操作已回滚，请重试或联系管理员`），**绝不静默当成功**。
- `write_audit()` 保留给「业务已提交、审计作为独立后续动作」的场景（登录/下载/导出），失败同样抛 `500`。

### 审批中心

`GET /approvals/pending` 每类待办各一次 COUNT + 一次取当页，项目名/科目名/申请人名**批量映射**（无 N+1）；
新增可选 `kind`（`project_filing`/`budget_adjust`/`expense`）只看一类，但 `totals` 仍给全量口径。
`decide` 入口的 `expense` 分支补充了超预算校验（与 `/expenses/{id}/approve` 同口径：超预算必须走特批或先调预算）。

## 性能（已实测，2000 项目规模）

列表分页与查询边界的 P95 实测（临时 sqlite 库 + 真实 ASGI 请求路径，每接口采样 30 次，含鉴权与序列化）：

| 接口 | median | P95 | total |
|---|---|---|---|
| `GET /projects?page=2&size=20&sort=-id` | 0.007s | 0.013s | 2000 |
| `GET /projects?keyword=PERF&status=doing&sort=-budget_total` | 0.010s | 0.012s | 96 |
| `GET /projects/options?keyword=PERF` | 0.005s | 0.006s | 2000 |
| `GET /tasks?page=1&size=20&sort=-id`（跨项目 5057 条） | 0.006s | 0.007s | 5057 |
| `GET /budgets?page=1&size=20`（3972 条） | 0.015s | 0.018s | 3972 |
| `GET /expenses?page=1&size=20&sort=-amount`（3972 条） | 0.006s | 0.007s | 3972 |
| `GET /approvals/pending?limit=50` | 0.005s | 0.006s | — |

13 个核心列表接口 P95 全部 ≤ 0.018s（阈值 2s）。复现：

```bash
python3 scripts/perf_list_p95.py --projects 2000 --runs 30
python3 scripts/perf_list_p95.py --projects 500 --runs 10 --keep-db   # 小规模/保留临时库排查
```

其余既有基准：

| 接口 | 耗时 |
|---|---|
| `GET /projects` 列表 | 0.008s |
| `GET /reports/warnings` | 0.097s |
| `GET /dashboard/summary` | 0.113s |
| `GET /reports/cost`（约 4000 行） | 0.817s |
| `GET /notifications`（含懒同步） | 0.153s |

压测数据生成与清理：

```bash
python3 scripts/seed_perf.py 2000          # 生成 2000 个项目及任务/预算/支出
python3 scripts/seed_perf.py 0 --clean     # 清理压测数据
```

## 测试

```bash
cd /Users/damon/DamonProjects/digitalProjectManagement
python3 -m pytest -q        # 97 项：覆盖鉴权/状态机/越权/加权/预警/拦截/审批/通知/软删除/检索/分页/认证配置。
                            #  · tests/test_mvp.py：核心主链路、管理员全局范围、Stage 3A 列表契约、Cookie 与 CSRF。
                            #  · tests/test_stage4a_closure.py：Stage 4A 闭环、校验、时间线、通知与去重。
                            #  · tests/test_security_config.py：生产密钥与 Cookie 配置边界。
```

## 已知限制

- SQLite FTS5 的 trigram 分词要求查询词 ≥3 字符，1-2 字关键词回退 LIKE（中文全文检索的完整方案留给 PostgreSQL 阶段）
- FTS 命中集在检索时预先截断为 500 条（`fts_search` 的性能护栏），因此 `GET /projects?keyword=` 的 `total` 在命中超过
  500 条时会低估；需要精确总数/分页的选择器场景请用 `GET /projects/options`（走 LIKE，`total` 准确）
- 字典类接口（`/meta/users`、`/meta/depts`）为「一次取回本地映射」设计，服务端硬上限 500 行；超出请用 `/meta/users/search`
- 列表筛选/分页未写入 URL，刷新会丢筛选条件（Stage 3B 前端处理）
- Stage 4A 新增的 `link` / `state` / `can_resubmit` / `decision_reason` 等字段后端已就绪，
  但前端 Stage 4B 尚未消费（通知跳转目前仍由 `web/components/ui/Bell.tsx` 自行拼路径，
  建议改用服务端返回的 `link`，避免两处跳转规则漂移）
- Docker Compose 只定义 `api` 与 `web` 两个服务，不启动数据库容器。

## 启动方式二：Docker（仅前后端，可连接本地 PostgreSQL）

```bash
docker compose up --build
# web: http://localhost:3001
# api: http://localhost:8001
```

不设置 `DATABASE_URL` 时默认使用容器内 SQLite：

```text
sqlite:////app/data/app.db
```

连接宿主机 PostgreSQL 时，在项目根目录创建 `.env`：

```dotenv
DATABASE_URL=postgresql+psycopg://oa_user:change_me@host.docker.internal:5432/oa_platform
DATA_VOLUME=pm-pg-data
CORS_ORIGINS=http://localhost:3001,http://127.0.0.1:3001
```

Compose 已为 Linux 添加 `host.docker.internal:host-gateway`。本机 PostgreSQL 需要允许 Docker 网段连接，
即确认 `listen_addresses` 不只绑定 `127.0.0.1`，并在 `pg_hba.conf` 中允许对应 Docker 子网访问业务库和业务账号。
首次启动 `api` 会自动执行 Alembic 迁移和幂等种子。附件仍持久化在 `pm-data` 卷，与数据库位置无关。

## 运维

```bash
bash scripts/backup_db.sh   # 备份 data/app.db，保留 7 天
python3 -m api.core.jobs    # 跟进到期扫描（建议 cron 每 10 分钟）
```

## 说明

- 本地默认数据库为 SQLite（`data/app.db`）；设置 `DATABASE_URL` 后可切换 PostgreSQL，SQLite 专用 FTS 会自动降级为 LIKE。
- Docker 仅运行前后端，不运行数据库；可连接宿主机已有 PostgreSQL。
- CORS 默认放行 `localhost:3000/3001`，Docker 默认放行 `3001`，可用环境变量 `CORS_ORIGINS` 覆盖。
---

## Review 2026-09-16：从 MVP 到可推广的推进建议

当前项目已经不是“想法草稿”，而是一个可运行的内部 MVP：后端 97 项 pytest 全部通过，前端 `next build` 通过；本地浏览器已走通登录、首次改密、工作台和核心业务页。下一步不建议继续横向堆功能，先把数据正确性、权限边界和日常闭环做成可托付的产品。

### 先给结论

按“搭积木”推进，建议分成四层：

1. **可信底座**：会话安全、输入校验、事务/审计、软删除和数据备份恢复。
2. **主流程闭环**：项目 → 任务/里程碑 → 进度填报 → 预算/支出 → 审批 → 通知。
3. **管理效率**：提醒可执行、筛选可分享、批量导入/导出、角色视图和可解释的健康度。
4. **上线运营**：试点、培训、指标、故障处理、备份演练和部署自动化。

### P0：先修再扩

- **生产密钥与 Cookie 会话**：生产启动在缺少 `APP_SECRET` 或密钥短于 32 字符时拒绝启动，并默认启用 Secure Cookie；后续需补充密钥轮换策略。
- **附件路径存在安全和可靠性风险**：`api/routers/projects.py` 直接使用上传文件名拼路径。应生成服务端文件名、限制文件名字符、校验最终路径位于项目附件目录，并将“数据库记录 + 文件写入失败回滚”设计成一致流程。
- **登录防护仍只按用户计数**：连续错误锁定用户，但没有 IP/账号组合限流；refresh 轮换/吊销与 Cookie + CSRF 会话已实现。上线前仍需增加请求速率限制。
- ~~**权限规则需先定稿**~~（**已定稿，2026-09-16**）：项目负责人、成本管理员、高层都不再是审批人。已确认边界为「单一管理员、全局可见、全局可操作、管理员统一审批」，并已落成后端契约（`api/core/rbac.py` 的 `require_admin` / `can_approve`）与接口测试（`tests/test_mvp.py` 第 25—28 项），见上文「登录与权限」中的权限边界契约。
- **所有领域输入仍需服务端约束**：例如任务更新允许直接写 `progress/status`，管理员参数可写入任意 key，字典新增没有重复/空值校验。前端校验只能改善体验，不能承担安全边界。
- **审计不能吞异常**：`write_audit` 捕获所有异常后只 rollback，业务调用方仍可能以为审计成功。关键操作应在事务边界内可靠写入，失败时明确阻止操作或进入可观测的告警路径。

### P1：做成真正可用的日常工作流

- 项目、任务、预算、支出列表统一服务端分页、排序和筛选；目前进度/成本/报表/管理部分仍通过 `?size=100` 拉项目下拉数据，后台列表也有无界查询。项目选择器应改为搜索式分页或“最近使用 + 关键词”接口。
- 进度填报要保留完整历史，并补“谁能填、谁能改、谁能确认、填报截止”的业务规则；任务更新接口需要校验项目归属、日期/权重/状态转移和父子任务一致性。
- 支出/预算要支持凭证附件、驳回后重提、审批意见和申请人可见的状态时间线；审批中心的 pending 聚合需要按当前用户真正可审批范围过滤，并避免每行查询项目/预算造成 N+1。
- 预警要区分“计算结果”和“已通知状态”：跟进到期目前可重复命中同一记录，建议保存处理/通知时间；通知列表需要可定位到具体任务、里程碑、支出或跟进，而不是只跳到模块首页。
- 筛选、分页、当前项目和视图状态写入 URL；现在刷新页面会丢筛选，浏览器回退也无法恢复工作上下文。
- 用真实组织与项目模板试点，不用压测数据代替验收；先选一个部门、10—20 个真实项目，跑通一周填报和一次月度成本盘点。

### P2：在使用数据证明需求后再做

- 周报确认、项目健康度解释、项目模板/复制、批量操作和更强的中文检索。
- 企业微信/邮件通知、财务系统对接、SSO/LDAP、细粒度订阅。先保留适配接口，不要提前承诺交付时间。
- 甘特图拖拽、自定义字段、评论/@提及、原生移动端。这些都不是当前主流程的瓶颈。

### 建议的验收指标

- 关键写操作：项目、任务、预算、支出、审批、附件均能在审计日志中还原“谁、何时、对什么、改前/改后、结果”。
- 权限：管理/审批唯一角色 = 管理员（全局范围），其余角色字段保留但不参与授权；管理/审批接口对非管理员稳定返回 403，不依赖前端隐藏按钮。
- 数据：预算执行率、加权进度、通知去重和报表导出分别用边界数据手工核算；页面与导出使用同一口径。
- 性能：在目标部署配置下，以真实查询组合测量 P95，而不是只看单次平均耗时；项目、任务、支出和通知列表分页后 P95 ≤ 2s。
- 运营：完成备份恢复、密钥配置、附件恢复、日志留存和故障联系人的演练，再扩大试点。

### 需要业务方先确认的 5 个决策

1. 立项审批是否必须开启？审批人是项目负责人、部门负责人，还是独立审批角色？
2. 成本管理员是否应该看到并修改全公司所有项目，还是只处理被授权部门/项目？
3. 支出“审批通过”是否等于项目管理口径的已支出？财务系统对接前，谁负责月度对账？
4. 项目附件是否包含合同、发票等敏感文件？保留期限、下载权限和备份加密要求是什么？
5. 第一批试点部门、真实项目数量、每周填报责任人和上线日期是什么？

**已确认（2026-09-16，业务方回复）**：管理和审批固定就是管理员（只有一个人），管理员即全局（全部门、全项目），暂时不做其他权限。
由此收敛：

- 第 1 问：审批人 = 管理员；项目负责人不再审批自己的立项。
- 第 2 问：成本管理员不再是全局角色，仅作为保留字段；全局范围只属于管理员。
- 第 4 问：附件、第 3/5 问（对账口径、试点范围）仍待确认，由后续 Stage 处理。
- 已落地：后端管理/审批边界（`api/core/rbac.py`、`api/routers/{admin,approvals,budgets,expenses,meta}.py`）与接口回归测试（`tests/test_mvp.py` 第 25—28 项）。
- 非目标：删除角色表、把全员改成 admin 账号、关闭普通用户的任务填报/跟进参与路径——本轮均未做。

其余决策确定后，再把每一层拆成独立改动；每层只解决一类可验收问题，避免在尚未验证流程时继续扩大模型和页面数量。
