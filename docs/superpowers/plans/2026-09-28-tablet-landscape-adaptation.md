# 横屏平板适配实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为全站已登录业务页面补齐 1180–1366 CSS px 横屏平板适配，同时保持手机 PWA、桌面布局和所有业务行为不变。

**Architecture:** 先增加可重复的真实浏览器验收基线，再集中调整主业务 shell 和共享页面模式，之后按 Dashboard、高密度业务页与 Spark 独立样式分组走查。以 CSS 视口 media query 适配，表格、表单、筛选和弹层仅在出现可复现问题时局部调整；最后对目标与邻接视口做全路由回归。

**Tech Stack:** Next.js 14 App Router、React 18、TypeScript、CSS Modules、现有 Vitest 测试、Python Playwright 验收脚本。

## Global Constraints

- 本轮专项适配范围：**1180–1366 CSS px**，以横屏平板为主；最低目标视口为 `1180×820`。
- 重点验证视口：`1180×820`、`1280×800`、`1366×900`。
- `≤767px` 保留现有手机 PWA、底部 Dock 和手机页面布局，不纳入本轮改造。
- `768–1179px` 保留当前行为，不作为本轮平板专项目标；只做断点邻接回归。
- `≥1367px` 保留当前桌面布局，并做宽屏回归抽查。
- 使用 CSS 视口宽度和 CSS media queries 判断布局，不使用设备型号、User-Agent 或 JavaScript 设备检测。
- 平板保留桌面侧边栏与顶栏；不引入平板专用 Dock 或新的导航模式。
- 不隐藏关键字段、行内操作、状态或权限入口；宽表格只能在其自身容器内横向滚动。
- 主要触控目标约 `44×44px`；交互不依赖 hover，并保留键盘焦点和鼠标操作。
- 延续深浅主题、减少动效、对比度、滚动、弹层焦点与错误反馈约定。
- 不改后端 API、权限模型、数据口径、业务写入流程、URL 状态、登录/改密流程或手机专属导航。
- 只修复目标视口中可复现的拥挤、遮挡、溢出或不可操作问题，不做无关重排或全站视觉翻新。

---

## 文件结构与职责

### 新增

- `scripts/acceptance_tablet_landscape.py`：真实 Chromium 的平板横屏几何与路由走查；复用现有验收脚本约定，输出 PASS/FAIL 和临时截图，不写业务数据。

### 修改候选（须以基线走查证据决定具体规则）

- `web/components/ui/Shell.module.css`：主业务侧栏、顶栏、内容区及 tablet media query。
- `web/app/globals.css`：共享页面标题、工具栏、表格滚动容器、KPI、表单等全局工作面规则。
- `web/components/ui/PageHeader.module.css`：共享业务页标题、筛选和操作区。
- `web/components/ui/TableToolbar.module.css`：表格页筛选、导出和操作区。
- `web/components/ui/Modal.module.css`：Dialog/Drawer 的平板几何；只有浏览器发现问题才修改。
- `web/app/(dashboard)/dashboard/dashboard.module.css`：工作台 KPI、图表、摘要和动态区。
- `web/components/dashboard/DashboardInterventionQueue.module.css`、`DashboardReadout.module.css`、`DashboardRouteField.module.css`：Dashboard 子区中经走查确认的问题。
- `web/app/(dashboard)/assets/assets.css`、`finance/finance.module.css`、`changelog/changelog.module.css`：资产、财务与功能更新的页面局部布局。
- `web/components/spark/SparkShell.module.css`、`web/components/spark/SparkPages.module.css`：Spark 独立 shell 和演示页，使用其自身布局边界。
- `scripts/acceptance_tablet_landscape.py`：在实现阶段扩充具体发现对应的断言。

### 明确保持不变，除非走查发现违反目标验收的缺陷

- `web/components/mobile/MobileDock.module.css`、`web/components/mobile/BottomSheet.module.css` 和各手机 sheet 样式。
- `web/components/ui/CardList.module.css` 的 `767px` 视图切换；平板继续显示桌面表格，不新增卡片视图。
- 页面业务 TSX、API 与权限逻辑；纯样式缺陷优先由 CSS 修复。

## 执行前 Git 前置检查

当前工作区最后检查状态为 `main`，`HEAD` 与 `origin/main` 同为 `c1f5c69`；当时唯一未跟踪文件是本次设计稿 `docs/superpowers/specs/2026-09-28-tablet-landscape-adaptation-design.md`。先重新检查工作区，不依赖旧状态推断。

在执行任何实现任务前：

1. 确认当前仍在 `main`，且除本设计稿和本实施计划外没有新的未提交文件或用户改动。
2. 保留并携带已批准的设计稿与实施计划，在最新 `main` 基线上创建 `feat/tablet-landscape-adaptation`。
3. 若出现任何额外修改或分支状态变化，停止切分支/实现，先与用户确认如何保全这些内容；不 stash、不覆盖、不重置、不带入新任务提交。
4. 分支建好后再运行初始验收脚本并进入 Task 1；不得在 `main` 上实现 UI。

建议命令（仅在前置检查通过后执行）：

```bash
git status --short --branch
git switch -c feat/tablet-landscape-adaptation
```

---

### Task 1：建立真实浏览器适配基线

**Files:**
- Create: `scripts/acceptance_tablet_landscape.py`
- Reference: `scripts/acceptance_blf1141_user_menu.py`
- Reference: `scripts/acceptance_blf1127_mobile.py`

**Interfaces:**
- Consumes: 本机运行的前端、可读写的本地验收环境、管理员测试账号和 Python Playwright。
- Produces: 命令 `python3 scripts/acceptance_tablet_landscape.py`；按视口和路由输出几何检查结果，并在系统临时目录 `tablet-landscape-shots` 保存失败页面及目标尺寸截图。脚本不得创建、更新或删除业务记录。

- [ ] **Step 1：** 新建验收脚本，按现有 `acceptance_blf1141_user_menu.py` 的接口约定读取 `FE_BASE`、`TABLET_USER`、`TABLET_PASSWORD`、`SHOT_DIR`；缺少账号或前端不可达时打印可执行的前置条件并以非零状态退出。管理员账号通过登录页登录，不在脚本中开户或调用写 API。
- [ ] **Step 2：** 编写登录与视口循环：视口按 `1180×820`、`1280×800`、`1366×900`、`1179×820`、`1367×900`、`390×844`、`1440×900` 顺序检查；浏览器 `device_scale_factor=1`，目标是 CSS px，不模拟设备型号。
- [ ] **Step 3：** 对三个目标 tablet 视口分别访问 `/dashboard`、`/projects`、`/progress`、`/costs`、`/approvals`、`/opportunities`、`/assets`、`/finance`、`/reports`、`/contacts`、`/partners`、`/admin`、`/changelog`、`/spark/dashboard`、`/spark/stores`、`/spark/billing`、`/spark/security`、`/spark/ops`、`/spark/permission`；再从项目台账第一条可见记录打开一个项目详情。如果测试环境没有项目记录，详情项输出明确 SKIP，不伪造业务写入。为控制总时长，1179px、1367px、390px、1440px 只走查 `/dashboard`、`/projects`、`/finance`、`/spark/dashboard` 四条代表路由。
- [ ] **Step 4：** 对目标视口的每个路由、以及边界/回归视口的代表路由断言：页面导航完成；非手机宽度主业务侧栏可见且底部 Dock 不可见；`document.documentElement.scrollWidth <= window.innerWidth + 1`；主内容、标题、表格容器边界不造成页面级横向滚动。宽表格自身允许 `scrollWidth > clientWidth`。保留失败时的 URL、视口、元素选择器和矩形尺寸，保存截图。
- [ ] **Step 5：** 在 `1180×820` 检查页面标题与首个主操作不相交、顶栏和账号菜单不越出视口；如果目标元素未渲染，标记为页面状态差异而不是静默跳过。浏览器脚本的几何辅助函数对空元素返回 `None`，对布局测量使用 1px 公差。
- [ ] **Step 6：** 运行初始基线：先启动本地 API 和 Web，再执行验收脚本。使用 `TABLET_USER` / `TABLET_PASSWORD` 指向本机可写入的管理员测试账号，脚本本身只读。记录每个真实 FAIL 的路由、视口和截图位置，作为后续 CSS 修改依据；如果 1180px 基线全绿，保留脚本用于防回归，不为了制造失败而改写断言。

运行命令：

```bash
python3 scripts/acceptance_tablet_landscape.py
```

预期：脚本能够覆盖全量目标路由，并对每个视口打印可追踪的 PASS/FAIL/SKIP；环境缺失时明确失败，不能把“未登录”或 API 错误误报成布局通过。

---

### Task 2：收敛主业务 shell 的平板布局

**Files:**
- Modify: `web/components/ui/Shell.module.css`
- Modify: `scripts/acceptance_tablet_landscape.py`
- Regression: `web/lib/identityRender.dom.vitest.test.tsx`

**Interfaces:**
- Consumes: Task 1 的浏览器基线与当前 `DashboardShell` 双外壳、权限菜单和折叠侧栏实现。
- Produces: `1180–1366px` CSS media query 内的紧凑主业务 shell；手机侧栏/Dock 切换契约和桌面主 shell DOM 不变。

- [ ] **Step 1：** 在浏览器脚本中补充目标宽度 shell 断言：侧栏可见；Dock 不显示；顶栏高度、菜单和内容区均在 viewport 内；折叠侧栏后内容区仍占据剩余空间；`1179px`、`1367px` 不匹配 tablet 专属布局。
- [ ] **Step 2：** 运行 Task 1 脚本确认新增断言在当前 CSS 下的实际状态。若出现问题，保留能稳定复现问题的最小路由和 viewport，不因断言波动而先改生产样式。
- [ ] **Step 3：** 在 `Shell.module.css` 现有 `901–1180px` 紧凑规则之后、`max-width: 767px` 手机规则之前增加明确的 `@media (min-width: 1180px) and (max-width: 1366px)` tablet 规则；只设置经测量需要的侧栏宽度、品牌区/导航间距、顶栏留白和内容区 padding。现有 220px 侧栏作为候选起点，只有当内容宽度或导航几何证明需要时才更改。
- [ ] **Step 4：** 通过浏览器脚本检查 `1180×820`、`1280×800`、`1366×900` 与 `1179/1367` 边界。若发生重叠或页面级溢出，按壳宽度、`.main` 起始位置、`.content` padding 的实测盒模型修正规则；不要修改 `layout.tsx` 断点逻辑或添加 JS `matchMedia`。
- [ ] **Step 5：** 在 `web/lib/identityRender.dom.vitest.test.tsx` 现有 shell DOM 测试附近增加结构回归断言：主侧栏仍渲染，MobileDock 仍与侧栏共用当前权限外壳，侧栏仍有折叠按钮；不要在 jsdom 中伪造 media query 几何。
- [ ] **Step 6：** 运行 `cd web && npx vitest run lib/identityRender.dom.vitest.test.tsx`，再运行浏览器验收脚本中 shell 检查。两者都通过后再进入下个任务。

---

### Task 3：共享页面头部、工具栏、表格与弹层

**Files:**
- Modify: `web/components/ui/PageHeader.module.css`
- Modify: `web/components/ui/TableToolbar.module.css`
- Modify: `web/components/ui/ListPageLayout.module.css`
- Modify: `web/app/globals.css`
- Modify: `web/components/ui/Modal.module.css`（仅在浏览器验收发现问题时）
- Test: `web/lib/pageHeader.dom.vitest.test.tsx`
- Test: `web/lib/listPageLayout.dom.vitest.test.tsx`
- Test: `scripts/acceptance_tablet_landscape.py`

**Interfaces:**
- Consumes: Task 2 已稳定的 `.shell` tablet 内容宽度与真实页面基线。
- Produces: 共用页面头部/筛选、表格滚动与 Dialog/Drawer 在目标宽度下的样式契约；CardList 仍只在 `≤767px` 显示。

- [ ] **Step 1：** 从失败截图中选取各一条代表性页面：筛选字段最多的列表页、操作最多的列表页、宽表格页、打开共享 Dialog 的页面。给浏览器验收脚本加几何断言，验证筛选和操作区不重叠，表格在自身容器内滚动，弹层边界留在 viewport 内。
- [ ] **Step 2：** 对 `PageHeader.module.css` 和 `TableToolbar.module.css` 仅在 `1180–1366px` 中调整 flex basis、字段最小宽度、间距和换行。不得令 `actions` 依赖 hover，或把主要操作移出首屏后不可达。
- [ ] **Step 3：** 对 `globals.css` 共享规则先核对 `.table-scroll`、`table.grid`、`.form-grid`、`.page-head`、`.kpi-row` 的实际计算样式；只修复已复现的全局问题。确认宽表格滚动发生于 `.table-scroll` / `DesktopTableFrame` 内，而 `documentElement.scrollWidth` 不扩大。
- [ ] **Step 4：** 对 `ListPageLayout.module.css` 只补充目标宽度需要的尺寸/弹性规则；不改手机 `≤767px` 的 table/card 显隐，不隐藏数据字段。`Modal.module.css` 目前 `≤900px` 才进入全屏模式，平板保持居中 Dialog / 右侧 Drawer；除非验收证明面板越界或操作被遮挡，否则不改其行为。
- [ ] **Step 5：** 在 `pageHeader.dom.vitest.test.tsx` 与 `listPageLayout.dom.vitest.test.tsx` 保持现有结构契约并增加必要 DOM 回归项；媒体查询的几何与不溢出必须由真实浏览器脚本测量，而不是只断言 CSS 字符串。
- [ ] **Step 6：** 运行 `cd web && npx vitest run lib/pageHeader.dom.vitest.test.tsx lib/listPageLayout.dom.vitest.test.tsx`，以及浏览器脚本中代表列表、宽表格和弹层的目标视口检查。

---

### Task 4：工作台与 Dashboard 子组件

**Files:**
- Modify: `web/app/(dashboard)/dashboard/dashboard.module.css`
- Modify: `web/components/dashboard/DashboardInterventionQueue.module.css`
- Modify: `web/components/dashboard/DashboardReadout.module.css`
- Modify: `web/components/dashboard/DashboardRouteField.module.css`
- Test: `web/lib/dashboardPage.dom.vitest.test.tsx`
- Test: `scripts/acceptance_tablet_landscape.py`

**Interfaces:**
- Consumes: Task 2–3 的 shell 与共享页面规则。
- Produces: Dashboard 在 1180–1366px 有足够宽度的 KPI、图表、路线/干预卡和动态区；加载、错误、空态和交互逻辑不变。

- [ ] **Step 1：** 在浏览器脚本加入 Dashboard 布局观测：测量 KPI 卡片数与盒宽、`commandGrid`/`pulseGrid` 列宽、图表盒、干预队列和路线字段；检测卡片/子项相交、文本/图例越界及页面级横向溢出，并保存 `dashboard-{width}.png`。
- [ ] **Step 2：** 检查当前 `.readoutRail`、`.commandGrid`、`.pulseGrid` 在 `1180/1280/1366px` 的计算轨道。保留 Dashboard 现有 `max-width: 1180px` 和 `max-width: 900px` 的窄屏语义；仅增加目标区间内必要的列数、最小列宽或 gap 覆盖，并把新规则放在现有规则之后以明确优先级。
- [ ] **Step 3：** 分别走查 `DashboardReadout`、`DashboardRouteField`、`DashboardInterventionQueue`。只有独立子组件有复现问题时才修改对应 CSS Module；使用 `min-width: 0`、允许需要的文案换行/省略和清楚的操作区边界，不能通过删除指标或操作消除拥挤。
- [ ] **Step 4：** 在 `dashboardPage.dom.vitest.test.tsx` 确认 Dashboard 关键指标、主要链接、空/错状态仍有 DOM；如本轮纯 CSS 没有 DOM 行为变化，不增加无关的快照断言。
- [ ] **Step 5：** 执行 `cd web && npx vitest run lib/dashboardPage.dom.vitest.test.tsx` 与浏览器脚本的 Dashboard 检查，另在 `390×844`、`1440×900` 截图回归确认手机与宽屏无样式泄漏。

---

### Task 5：资产、财务、报表、管理及其余业务路由

**Files:**
- Modify only when evidence requires: `web/app/(dashboard)/assets/assets.css`
- Modify only when evidence requires: `web/app/(dashboard)/finance/finance.module.css`
- Modify only when evidence requires: `web/app/(dashboard)/changelog/changelog.module.css`
- Modify only when evidence requires: `web/app/globals.css`
- Test: `scripts/acceptance_tablet_landscape.py`

**Interfaces:**
- Consumes: 前述共享样式稳定版本和已有页面路由；项目详情及各一级业务页作为浏览器验收对象。
- Produces: 目标视口下全站已登录业务页的路由覆盖证据；页面局部 CSS 只包含经过验收复现的问题修复。

- [ ] **Step 1：** 按页面逐一走查 `/projects`、项目详情、`/progress`、`/costs`、`/approvals`、`/opportunities`、`/assets`、`/finance`、`/reports`、`/contacts`、`/partners`、`/admin` 与 `/changelog`。对每个路由的标题/筛选/主操作、首个列表或图表、分页、空错态与可打开弹层记录 PASS/FAIL。
- [ ] **Step 2：** 先使用共享 `PageHeader`、全局表格与 `.table-scroll` 规则消除共性问题；不得仅因页面内容宽而把 tablet 切换成手机 CardList。对无法共用修复的问题，记录对应页面及选择器后再改该页现有 CSS Module。
- [ ] **Step 3：** 针对资产页面检查统计卡、状态 grid、入库/编辑表单和详情 Drawer；针对财务检查一级操作、账簿区、KPI、宽表格与表单 Dialog；针对功能更新检查时间线、标签和多栏内容。保持字段、金额和按钮完整。
- [ ] **Step 4：** 对商机、通讯录、友商、项目/详情、进度、支出、审批、报表和系统管理完成至少一个有数据状态与一个空/错误状态的检查。表格可以容器内横滚；列表/卡片不在本轮普遍重排。
- [ ] **Step 5：** 更新浏览器脚本只为实际修复加入稳定断言；运行全路由三档 tablet 验收。管理员菜单缺失或测试数据权限不足时脚本必须报告具体路由与权限前置条件，不得将缺页判为通过。

---

### Task 6：Spark 独立 shell 和演示页

**Files:**
- Modify only when evidence requires: `web/components/spark/SparkShell.module.css`
- Modify only when evidence requires: `web/components/spark/SparkPages.module.css`
- Test: `scripts/acceptance_tablet_landscape.py`

**Interfaces:**
- Consumes: Spark 独立 layout、侧栏折叠逻辑与本地 mock 页面。
- Produces: Spark dashboard、stores、billing、security、ops、permission 页面在目标宽度的布局回归证据；不依赖主业务 shell 的 CSS selector。

- [ ] **Step 1：** 在 `/spark/dashboard`、`/spark/stores`、`/spark/billing`、`/spark/security`、`/spark/ops`、`/spark/permission` 目标视口测量 Spark 侧栏、搜索框、顶栏区域、metric/split/three/four/five grids 与表格容器；追加失败截图。
- [ ] **Step 2：** 评估当前 `SparkShell.module.css` 的 `max-width: 900px` 与 `SparkPages.module.css` 的 `max-width: 1100px` 是否使 1180–1366px 主栏拥挤。仅对真实问题新增独立 tablet 区间规则；保持桌面侧栏可见和 Spark 手机 `≤767px` 抽屉式侧栏规则不变。
- [ ] **Step 3：** 验证 Spark 表格横滚仅在 `.tableWrap` 内，所有指标和内容 grid 不发生页面级溢出；无需为全空的主站业务 API 提供 Spark 数据 mock。
- [ ] **Step 4：** 运行浏览器脚本全部 Spark 路由检查，截图核对目标宽度与 `390px` 手机、`1440px` 桌面回归。

---

### Task 7：集中回归、文档和分支收口

**Files:**
- Modify: `docs/superpowers/plans/2026-09-28-tablet-landscape-adaptation.md`（只更新步骤勾选和实际验收结果）
- Test: `scripts/acceptance_tablet_landscape.py`
- Test: `web` 全部测试及生产构建

**Interfaces:**
- Consumes: Tasks 1–6 的实现和浏览器验收结果。
- Produces: 全路由、视口、主题和自动化检查记录；可审查的功能分支 diff。

- [ ] **Step 1：** 以 tablet 三个目标视口访问全量路径；逐项确认无页面级横向溢出、侧栏/顶栏/操作未遮挡、宽表格内滚动、弹层在视口内、触控与键盘可用。
- [ ] **Step 2：** 在浏览器切换深色/浅色主题，对工作台、列表、宽表格、弹层各至少检查一页；启用 `prefers-reduced-motion: reduce` 检查内容仍清晰、操作状态可识别。
- [ ] **Step 3：** 运行断点邻接与非回归尺寸：`1179×820`、`1367×900`、`390×844`、`1440×900`。确认手机 Dock、桌面侧栏、手机卡片/桌面表格切换与既有业务交互保持原样。
- [ ] **Step 4：** 运行 `cd web && npm test`，预期 unit、motion 两套测试均通过；再运行 `cd web && npm run build`，预期 Next.js 生产构建成功。已有构建/ESLint 警告应单独记录，不把既有警告描述为本轮新失败。
- [ ] **Step 5：** 再运行 `python3 scripts/acceptance_tablet_landscape.py`，确认路由覆盖与截图输出无未解释 FAIL；更新本计划的任务状态、浏览器视口、主题、项目详情是否执行及构建/测试结果。
- [ ] **Step 6：** 检查 `git diff --check` 与 `git status --short --branch`，只暂存本功能分支内的实现、验收脚本和本计划；设计稿如需纳入本分支，只能从已批准的同一版本添加，不得带入任何其他文件。
- [ ] **Step 7：** 经用户确认后再提交本分支；本计划不授权推送、合并或创建 PR。

最终浏览器验收命令：

```bash
python3 scripts/acceptance_tablet_landscape.py
```

最终自动化验证命令：

```bash
cd web && npm test
cd web && npm run build
git diff --check
```

## 验收路由清单

| 页面组 | 路由 | 目标视口核查重点 |
| --- | --- | --- |
| 工作台 | `/dashboard` | KPI、图表、摘要、干预/路线内容与刷新区 |
| 项目 | `/projects`、从列表进入一条 `/projects/{id}` | 筛选、操作列、表格、详情 tabs、合同/进度/支出区、Dialog |
| 进度/支出/审批 | `/progress`、`/costs`、`/approvals` | 筛选、表格、分页、行内操作、表单与确认弹层 |
| 经营与资产 | `/opportunities`、`/assets` | 页面标题、列表、状态/统计卡、资产表单与详情 Drawer |
| 财务与报表 | `/finance`、`/reports` | 多区块导航、金额对齐、筛选、宽表格、导出和 Dialog |
| 组织与管理 | `/contacts`、`/partners`、`/admin` | 宽表、筛选与操作区、详情 Drawer、管理分区 |
| 内容页 | `/changelog` | 时间线/版本卡片、标签与长文案 |
| Spark 演示站 | `/spark/dashboard`、`stores`、`billing`、`security`、`ops`、`permission` | 独立侧栏、顶栏、指标布局和自有表格滚动 |

## Self-Review

- **Spec coverage:** 1180–1366 目标尺寸由 Task 1–7 覆盖；手机、桌面与 1179/1367 边界由 Task 1、2、4、6、7 覆盖；shell、Dashboard、列表表格、筛选、表单弹层、高密度业务模块和 Spark 分别由 Task 2–6 覆盖；全路由、主题、减少动效、键鼠/触控、自动化测试和生产构建由 Task 7 覆盖；业务/API/权限/URL 不变由全局约束和每项走查约束。
- **Placeholder scan:** 文档无 TBD/TODO/占位项；所有验收命令、目标视口、路由和输出证据均已明确。
- **Type consistency:** 验收脚本只有一个入口 `scripts/acceptance_tablet_landscape.py`；环境变量名、路由列表、输出截图目录和浏览器断言在 Task 1 及后续任务中保持一致。目标视口执行全路由；边界/回归视口只执行 Dashboard、项目台账、财务、Spark 总览四条代表路由。
- **Scope check:** 本轮为同一响应式 UI 适配工作流，主业务 shell、共享组件、页面模块和 Spark 是可独立验收的顺序任务，不拆分为 API 或业务子项目。
