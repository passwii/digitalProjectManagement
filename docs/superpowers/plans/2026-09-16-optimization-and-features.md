# 优化与功能扩展 PLAN（弹窗化编辑 + 能力补全）

> **For agentic workers:** 按 Stage 顺序执行，每个 Stage 独立可验收。Stage 1 是后续所有 Stage 的交互地基，必须先做。

**Goal:** 把「内联表单 + 只读列表」升级为「点击条目 → 弹窗/抽屉内编辑明细」的现代控制台交互，并补齐附件、审批、通知、看板、性能等缺口。

**Architecture:** 新增一层通用交互组件（Dialog / Drawer / Confirm / Toast / Form 字段组），业务页只声明字段与校验规则，不再各自手写表单；后端补通知表与批量/分页能力，并把权限过滤与汇总下推到 SQL。

**Tech Stack:** 沿用 Next.js 14 + FastAPI + SQLite；新增依赖需逐项确认（见 §6 决策项）。

## Global Constraints

- 弹窗内编辑必须保留深链：`/projects/1` 可直接打开，弹窗打开时 URL 同步 `?edit=1` / `?task=5`
- 弹窗可访问性：`role="dialog"` + `aria-modal` + Esc 关闭 + 焦点锁定 + 关闭后焦点归位
- 脏数据保护：表单有修改时点遮罩/取消需二次确认
- 危险操作（删除/归档/特批/驳回）一律 Confirm Dialog，且写审计
- 所有列表必须有分页，禁止再出现 `size=100` 硬编码

---

## 进度

| Stage | 状态 | 说明 |
|---|---|---|
| 1 弹窗交互地基 | ✅ 已完成 | Dialog/Drawer/Confirm/Toast/Field/useForm/Pagination 就位，4 个业务页全部改为弹窗编辑 |
| 2 条目编辑闭环 | ✅ 已完成 | 附件下载/删除、跟进编辑删除、任务编辑删除、里程碑编辑删除、成员管理、字典 CRUD、预算调整、回收站、分页 |
| 3 审批中心 + 站内通知 | ✅ 已完成 | notifications 落库 + 铃铛 + 已读 + 审批中心（立项/预算调整/支出）+ 立项审批状态打通 |
| 4 工作台与看板 | ✅ 已完成 | recharts 趋势/占比/预算对比 + KPI + 项目健康度 + 本周动态 |
| 5 性能与工程加固 | ✅ 已完成（除注明项） | N+1 全修、权限下推 SQL、FTS5、通知节流、骨架屏/错误边界、24 项 pytest、压测脚本、Docker 文件、审计导出 |

### Stage 5 实测结果（2000 项目 / 6000 任务 / 4000 预算 / 4000 支出）

| 接口 | 优化前 | 优化后 |
|---|---|---|
| `GET /reports/warnings` | 2.002s | **0.097s**（20×） |
| `GET /reports/cost` | 1.360s | **0.817s** |
| `GET /notifications`（含同步） | 1.417s | **0.153s** |
| `GET /notifications/count`（轮询） | — | **0.002s** |
| `GET /projects`（列表） | — | **0.008s** |
| `GET /dashboard/summary` | — | **0.113s** |

### 未完成 / 有保留的项（诚实说明）

- **Playwright E2E 未做**：本环境无桌面浏览器，改用 24 项 pytest 覆盖接口级主链路（鉴权/状态机/审批/通知/软删除/检索/分页/越权）。浏览器交互层仍需人工点验。
- **Docker 未实跑**：`docker-compose.yml` 与两个 Dockerfile 已写好，但本机无 docker，未做 `docker compose up` 验证。
- **FTS5 有已知局限**：SQLite 默认 unicode61 分词器不切分中文（实测 MATCH 全落空），已改用 trigram；trigram 要求查询词 ≥3 字符，1-2 字关键词自动回退 LIKE。真正的中文全文检索应放在 PG 阶段（pg_trgm / zhparser）。
- **阶段进度改到 URL**：列表筛选/分页尚未写入 querystring，刷新会丢筛选条件。
- **通知 recipients 是大范围计算**：懒同步按 5 分钟节流 + 每类上限 50 条，2000 项目下不再灌爆通知表；更精细的「按项目订阅」留待后续。

---

## 1. 现状审计（已核实的缺口）

**交互层**
- 无 Dialog/Drawer/Toast/Confirm 组件；`projects` 新建表单与详情编辑均为内联展开
- 无分页组件，4 个页面硬编码 `size=100`
- 无加载骨架屏、无错误边界；提示靠页面内 banner（刷新即丢）
- 按钮级权限未做：非管理员也会看到无权操作的按钮，点了才 403

**功能缺口（后端接口已有但前端无入口）**
- 任务：`PATCH/DELETE /tasks/{id}` 存在，UI 无法编辑/删除任务
- 预算调整：`PATCH /budgets/{id}` + `POST /budget-adjusts/{id}/approve` 存在，UI 无入口
- 字典：`POST /admin/dicts` 存在，UI 只读

**功能缺口（两端都缺）**
- 附件只能上传和列出，**没有下载/预览，也没有删除** —— 上传了拿不回来
- 跟进记录只能新增，不能编辑/删除
- 项目成员只能看，不能增删（`member_ids` 无编辑入口）
- 里程碑可增可完成，不能编辑/删除
- 无站内通知表：`jobs.compute_warnings` 只实时算，没有已读、没有历史、不落库
- 无审批中心：立项审批、预算调整审批、支出审批散落各处，没有统一待办
- 无工作台首页：登录后直接落在项目列表，没有「我的待办/我的项目」
- 项目无删除/回收站

**性能问题（已核实，非猜测）**
- `list_tasks`：循环内对每个任务调 `_project()` 做一次查询 → N+1
- `list_projects`：`q.all()` 后在 Python 里 `can_read_project` 过滤 → 数据量大时全表载入
- `build_cost_rows`：项目 × 科目双层循环、每格一次查询 → N×M 次查询
- `execution()` 在预算列表里逐行调用 → N+1
- `list_projects` 无排序参数，前端无法按预算/进度排序

## 2. 弹窗交互规范（Stage 1 的验收基准）

| 场景 | 载体 | 说明 |
|---|---|---|
| 列表行点击 | Drawer（右侧 480px） | 只读详情 + 顶部「编辑」按钮，支持深链 `?id=` |
| 点「编辑」/双击字段 | Dialog（居中 560px） | 字段分组表单，底部 取消/保存 |
| 新建（项目/任务/支出/用户…） | Dialog | 与编辑共用同一表单组件 |
| 长表单（项目 10+ 字段） | Dialog + 分组折叠 | 基本信息 / 计划与预算 / 其他 |
| 删除、归档、特批、驳回 | Confirm Dialog | 危险色主按钮，要求填写原因（可选） |
| 保存结果 | Toast（右上 4s 自动消失） | 成功绿 / 失败红，失败保留弹窗内容 |
| 移动端 <900px | Dialog 变全屏 Drawer | 底部按钮吸底 |

组件 API（约定，后续 Stage 都按此调用）：

```tsx
<Dialog open onClose title size="md" footer={<...>} dirty={isDirty}>…</Dialog>
<Drawer open onClose title width={480}>…</Drawer>
<Confirm open title text danger onConfirm onCancel />
const toast = useToast(); toast.ok("已保存"); toast.err("编号重复");
```

---

## Stage 1：弹窗交互地基（P0，阻塞后续）

**后端**：无改动。

**前端**
- 新建 `components/ui/Dialog.tsx`（含 `useDialog`）、`Drawer.tsx`、`Confirm.tsx`、`Toast.tsx`（Provider + `useToast`）、`Field.tsx`（label + 错误 + 必填标记）、`FormGrid.tsx`
- 新建 `lib/useForm.ts`：字段值/错误/脏标记/提交态，支持 `rules: { required, min, pattern, custom }`
- 改造 4 个业务页：项目列表行点击 → Drawer；新建/编辑 → Dialog；删除销毁类 → Confirm；保存反馈 → Toast
- `app/(dashboard)/layout.tsx` 挂 `ToastProvider`
- 验收：全站无内联展开式表单；表单校验统一文案；Esc/遮罩/脏数据二次确认均生效；build 通过

**实际落地（与计划的差异）**
- 组件合并为 `components/ui/Modal.tsx`（导出 `Dialog` / `Drawer` / `Confirm`），共享一套焦点锁定、Esc、滚动锁定、脏数据二次确认逻辑，避免三份重复实现
- 追加 `components/ui/Pagination.tsx` 与 `components/ui/Toast.tsx`，`Field.tsx`、`lib/useForm.ts` 按计划实现
- 弹窗组件按业务就近放置：`projects/ProjectFormDialog.tsx`、`projects/FollowupDialog.tsx`、`progress/TaskDialog.tsx`、`progress/MilestoneDialog.tsx`、`progress/ReportDialog.tsx`、`costs/BudgetDialog.tsx`、`costs/ExpenseDialog.tsx`、`admin/UserDialog.tsx`、`admin/DictDialog.tsx`、`admin/ParamDialog.tsx`
- 已完成的改造：项目列表行点击开 Drawer（含状态流转与危险操作 Confirm）、项目新建/编辑 Dialog、详情页编辑 Dialog、跟进 Dialog、任务 Dialog（含编辑/删除）、里程碑 Dialog（含编辑/删除）、填报 Dialog、预算登记/调整 Dialog、支出 Dialog、用户 Dialog、字典 Dialog、参数 Dialog、日志 Drawer、审计日志分页

## Stage 2：条目编辑闭环（P1，把已有接口全部接上）

**后端**
- 新增 `GET /projects/{pid}/attachments/{aid}/download`（鉴权 + 归属校验，`FileResponse`，文件名 URL 编码）
- 新增 `DELETE /projects/{pid}/attachments/{aid}`（写审计）
- 新增 `PATCH/DELETE /projects/{pid}/followups/{fid}`（仅记录人/负责人/管理员）
- 新增 `PUT /projects/{pid}/members`（整体覆盖成员，写留痕）
- 新增 `DELETE /projects/{pid}`（软删除 + `deleted_at`，仅管理员）
- 预算调整：`POST /budgets/{id}/adjust` 语义明确化（申请→审批→生效），补 `GET /budget-adjusts?status=`
- 列表统一加分页参数与排序：`/tasks`、`/budgets`、`/expenses`、`/followups` 支持 `page/size/sort`

**前端**
- 附件：下载按钮、删除（Confirm）、图片/pdf 弹窗预览
- 跟进：编辑/删除弹窗
- 任务：编辑/删除/新增子任务弹窗、任务详情 Drawer（含填报历史）
- 里程碑：编辑/删除弹窗
- 项目成员：成员选择弹窗（多选 + 搜索）
- 预算：新增/调整申请弹窗、调整审批入口
- 系统管理：字典 CRUD、参数编辑改为 Dialog、日志详情 Drawer
- 新建 `components/ui/Pagination.tsx` + 表格排序表头
- 验收：上述每条都能在弹窗内完成且刷新后状态正确；附件下载成功且无权限者 403

## Stage 3：审批中心 + 站内通知（P2）

**后端**
- 新增 `notifications` 表：`id, user_id, type, title, body, ref_type, ref_id, read_at, created_at`
- `jobs.compute_warnings` 结果落库为通知（去重：同 `ref` 同日不重复）
- 新增 `POST /notifications/read`、`POST /notifications/read-all`、`GET /notifications?unread=1`
- 新增审批中心：`GET /approvals/pending`（立项 + 预算调整 + 支出统一列表）、`POST /approvals/{type}/{id}/decide`
- 立项审批开关打通：`approval_on=1` 时项目创建后进入 `pending_approval`，审批通过才 `filed`
- 新增 `GET /followups/due`（跨项目的到期跟进）

**前端**
- 顶栏铃铛 + 未读数 + 下拉通知面板 + 「全部已读」
- 新增 `/approvals` 页（审批中心，待我审批 / 我发起的）
- 项目创建后按开关展示「待审批」状态与审批流转记录
- 通知点击跳转对应条目并打开 Drawer
- 验收：80% 预警、里程碑临近、停滞、跟进到期四类都能生成通知并可已读；审批全链路可走通

## Stage 4：工作台与数据看板（P2）

**后端**
- `GET /dashboard/summary`：我的项目数/进行中/逾期任务数/待审批数/本月支出
- `GET /dashboard/health`：项目健康度（进度 vs 计划偏差、预算执行率、停滞天数）
- `GET /reports/weekly?project_id=`：周报数据（本周填报、进度变化、逾期、待办）

**前端**
- 新增首页 `/`（登录后落地）：KPI 卡 + 我的待办 + 最近跟进 + 项目健康度列表
- 项目卡片/列表增加健康度标识（正常/风险/逾期）
- 报表页增加趋势图（近 6 个月支出）、科目占比图
- 周报一键生成 + 导出
- 验收：首页数据与各业务页一致；图表随筛选联动

## Stage 5：性能与工程加固（P2/P3）

**后端**
- 修 N+1：`list_tasks` 批量取项目；`build_cost_rows` 改为一次聚合查询（GROUP BY project_id, subject）；`execution` 批量版
- 权限过滤下推 SQL：`list_projects` 用 JOIN 成员表 + 部门条件，不再 Python 全量过滤
- 全文检索增强：SQLite FTS5 虚表 + 触发器，`keyword` 走 FTS 并返回高亮片段
- 补齐 `deleted_at` 过滤到所有查询；回收站恢复接口
- 索引复核（排序字段、`notifications.user_id+read_at`）

**前端**
- 骨架屏、错误边界 `error.tsx`、请求去重与取消
- 列表筛选/分页/排序状态写入 URL（可分享、刷新不丢）
- 移动端走查（表格转卡片、弹窗全屏）

**工程**
- Playwright E2E：登录→建项→任务→填报→预算→支出→审批→导出 一条主链路
- 测试数据工厂 + 千级数据压测脚本（验证列表 ≤2s）
- Docker Compose 一键起（api + web + volume）
- 审计日志导出 Excel

---

## 3. 建议（我的优先排序理由）

1. **先做 Stage 1，不要先加功能。** 现在每个页面各写一套表单，功能加得越多返工越贵；弹窗地基一次性收口，后面每加一个条目编辑只写字段声明。
2. **Stage 2 优先于 Stage 3。** 附件不能下载是「功能残缺」，审批和通知是「体验增强」；先把已有接口接上，用户日常才用得起来。
3. **通知必须落库，不能只实时算。** 现在预警是每次请求现算，无法已读、无历史、无法推送；落库后邮件/企业微信只是加一个 channel 字段。
4. **性能问题现在修，不要等报慢。** N+1 在千级数据下就会明显（报表页 N×M 次查询），修起来是纯重构、无新功能风险。
5. **软删除早做。** 项目/支出一旦误删无法恢复是数据事故，`deleted_at` 成本极低。
6. **不建议本期做：** 自定义字段、评论@提及、SSO、甘特拖拽、移动端原生。投入大且不影响主流程，放 backlog。

## 4. Backlog（本期不做，记录备查）

自定义字段与表单设计器、评论/@提及、附件在线预览器、甘特图拖拽改期、项目模板与复制、财务系统对接、企业微信/邮件通知通道、SSO/LDAP、多语言、数据导入向导（图形化映射）。

## 5. 依赖决策项（已拍板）

| 项 | 决定 |
|---|---|
| 开工顺序 | Stage 1 弹窗地基先行，后续每个条目编辑只声明字段 |
| 图表 | 引入 `recharts`（Stage 4 使用）|
| 表单 | 手写 `lib/useForm.ts`，零依赖 |
| 通知通道 | 仅站内通知，`notifications` 表预留 `channel` 字段 |
| E2E | Playwright（Stage 5）|

## 6. 验收总表

| Stage | 可独立演示的成果 |
|---|---|
| 1 | 任意条目点击弹出编辑窗口，保存有 Toast，脏数据有确认 |
| 2 | 附件可下载/删除，任务/里程碑/跟进/成员/字典/预算调整全部可编辑 |
| 3 | 铃铛有未读数，四类预警生成通知，审批中心可批量处理 |
| 4 | 登录后先看到工作台，健康度与趋势图可用，周报可导出 |
| 5 | 报表页查询次数下降、千级列表 ≤2s、E2E 主链路绿、Docker 一键起 |
