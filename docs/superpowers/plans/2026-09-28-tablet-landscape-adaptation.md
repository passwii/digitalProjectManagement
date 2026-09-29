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

- `scripts/acceptance_tablet_landscape.py`：真实 Chromium 的平板横屏几何与路由走查；只使用空态 fixture、阻断所有写请求，输出 PASS/FAIL 和临时截图，不访问后端业务数据。
- `scripts/test_acceptance_tablet_landscape.py`：验收路由、视口、shell 断点和几何 helper 的 unittest。
- `scripts/test_tablet_layout_browser.py`：专用只读 Chromium 样式回归，必要时向特定 GET 返回内存中的测试 fixture，用于验证数据态排版和触控目标。

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

### Task 1：建立只读浏览器适配基线

**Files:**
- Create: `scripts/acceptance_tablet_landscape.py`
- Reference: `scripts/acceptance_blf1141_user_menu.py`
- Reference: `scripts/acceptance_blf1127_mobile.py`

**Interfaces:**
- Consumes: 当前 worktree 本地 Web 服务与 Python Playwright；验收 API 由脚本本地夹具提供。
- Produces: 命令 `python3 scripts/acceptance_tablet_landscape.py`；按视口和路由输出几何检查结果，并仅在失败时将截图和盒模型 JSON 保存到系统临时目录。脚本只 mock 读取响应并阻断所有写请求，不访问或修改业务数据。

- [x] **Step 1：** 新建验收脚本，只接受 `FE_BASE` 指向 localhost/127.0.0.1；用布局专用身份/菜单 fixture 进入受保护的页面，不使用真实账号、不请求登录 API、不转发 API 网络请求。所有 GET/HEAD 响应来自本地空态 fixture，所有写请求直接阻断。
- [x] **Step 2：** 编写登录态注入与视口循环：视口按 `1180×820`、`1280×800`、`1366×900`、`1179×820`、`1367×900`、`390×844`、`1440×900` 顺序检查；浏览器 `device_scale_factor=1`，目标是 CSS px，不模拟设备型号。
- [x] **Step 3：** 对三个目标 tablet 视口分别访问 `/dashboard`、`/projects`、`/progress`、`/costs`、`/approvals`、`/opportunities`、`/assets`、`/finance`、`/reports`、`/contacts`、`/partners`、`/admin`、`/changelog`、`/spark/dashboard`、`/spark/stores`、`/spark/billing`、`/spark/security`、`/spark/ops`、`/spark/permission`；边界和回归视口走查 Dashboard、项目、审批、资产、财务、报表、管理与 Spark 总览八条代表路由。项目详情在主空态验收中 SKIP，另由隔离浏览器 fixture 验证 Drawer。
- [x] **Step 4：** 对每个执行的路由/视口断言页面级无横向溢出、当前主内容壳可见；主业务页检查导航壳（手机视口验证 Dock、其余视口验证侧栏）与顶栏边界。宽表格自身允许在容器内滚动。失败时保存 URL、视口、元素矩形和截图。
- [x] **Step 5：** 在 `1180×820` 检查标题与首个主操作不相交，布局测量采用 1px 公差；识别主业务 shell 与 Spark shell 各自的主内容容器。
- [x] **Step 6：** 运行验收脚本 unittest 和全路由只读浏览器基线。空态 fixture 的 1180×820、1280×800、1366×900 全目标路由与 1179×820、1367×900、390×844、1440×900 八条代表路由均通过几何检查；项目详情在空态基线跳过，由隔离浏览器 fixture 单测 Drawer。内容态截图走查使用隔离 Playwright 页面、只拦截 GET 且仅保存在系统临时目录，不访问后端真实数据。

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

- [x] **Step 1：** 在空态只读浏览器验收中确认目标宽度主业务侧栏可见、Dock 隐藏、顶栏与内容区在视口内；折叠态暂由现有 DOM 契约保障，后续内容态走查复核。
- [x] **Step 2：** 实测 1180/1280/1366px 侧栏分别为 220/252/252px，内容区域不扩出 document；1179/1367px 边界稳定。
- [x] **Step 3：** 未增加 tablet shell media query：实测的当前 shell 在目标视口没有遮挡或溢出，1180px 下 220px 紧凑侧栏已提供足够内容宽度，1280/1366px 使用 252px 原有侧栏。遵守证据优先原则，不为加断点而改样式。
- [x] **Step 4：** 浏览器验收通过 1180×820、1280×800、1366×900 和 1179/1367 边界的侧栏、顶栏及页面宽度断言；没有 JS `matchMedia` 或 `layout.tsx` 行为变化。
- [x] **Step 5：** 既有 `identityRender.dom.vitest.test.tsx` 已覆盖侧栏存在及折叠按钮；CSS 断点几何不在 jsdom 伪测，不需添加重复结构断言。
- [x] **Step 6：** `cd web && npx vitest run lib/identityRender.dom.vitest.test.tsx` 与本地只读浏览器 shell 验收通过。

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
- Test: `scripts/test_acceptance_tablet_landscape.py`
- Test: `scripts/test_tablet_layout_browser.py`
- Test: `scripts/acceptance_tablet_landscape.py`

**Interfaces:**
- Consumes: Task 2 已稳定的 `.shell` tablet 内容宽度与真实页面基线。
- Produces: 共用页面头部/筛选、表格滚动与 Dialog/Drawer 在目标宽度下的样式契约；CardList 仍只在 `≤767px` 显示。

- [x] **Step 1：** 建立 Finance header 矩形回归测试，先在 1180×820 复现“当前账套”标签与 select/说明同排重叠；并建立页头所有主要触控控件 ≥44px 的失败测试。浏览器脚本保留项目筛选/表格几何检查。
- [x] **Step 2：** 在 `PageHeader.module.css` 添加仅针对 `1180–1366px` 的双行 grid：标题与 actions 首行、filters 次行；toolbar 字段宽度受控、select/input 与操作控件设 44px 最小高度。没有依赖 hover，也未更改窄屏和桌面断点。
- [x] **Step 3：** 检查全局 `.table-scroll` 与项目表格：1066px 表格在 905px/961px/1047px 容器内部横向滚动，document 宽度未扩出视口；不需修改 `globals.css`。
- [x] **Step 4：** `ListPageLayout.module.css`、`Modal.module.css` 无复现缺陷，不做改动；手机 CardList 仍只在 767px 断点切换，完整保留列与操作。
- [x] **Step 5：** 共享组件 DOM 契约未变；增加 Python Chromium 几何回归，覆盖页头标签/控件交叉、页头动作与标题布局、触控高度以及 767/768/900/901/1179/1180/1366/1367 边界。
- [x] **Step 6：** `cd web && npx vitest run lib/pageHeader.dom.vitest.test.tsx lib/listPageLayout.dom.vitest.test.tsx`（14 项通过）、`python3 -m unittest scripts.test_tablet_layout_browser -v`（12 项通过）和空态全路由浏览器基线通过。

---

### Task 4：工作台与 Dashboard 子组件

**Files:**
- Modify: `web/app/(dashboard)/dashboard/dashboard.module.css`
- Modify: `web/components/dashboard/DashboardInterventionQueue.module.css`
- Modify: `web/components/dashboard/DashboardReadout.module.css`
- Modify: `web/components/dashboard/DashboardRouteField.module.css`
- Test: `web/lib/dashboardPage.dom.vitest.test.tsx`
- Test: `scripts/test_tablet_layout_browser.py`
- Test: `scripts/acceptance_tablet_landscape.py`

**Interfaces:**
- Consumes: Task 2–3 的 shell 与共享页面规则。
- Produces: Dashboard 在 1180–1366px 有足够宽度的 KPI、图表、路线/干预卡和动态区；加载、错误、空态和交互逻辑不变。

- [x] **Step 1：** 在 `scripts/test_tablet_layout_browser.py` 加入 1180×820、1280×800、1366×900 的 Dashboard 内容态检查：确认主文档无横向溢出，readout/KPI、commandGrid 与 pulseGrid 的子块不重叠，并保存 `dashboard-{width}.png` 临时截图。
- [x] **Step 2：** 检查 `.readoutRail`、`.commandGrid`、`.pulseGrid` 三档计算布局。KPI 在 1180px 折为两列、1280/1366px 为四列；项目航迹与介入区保持双列，数据脉冲面板保持可读，子项未相交。保留既有 1180/900px 断点，不新增 Dashboard 覆盖规则。
- [x] **Step 3：** 走查路线与干预内容；当前数据态在 1180px 下标题、名称、风险标签、进度与入口均可读，内容未裁切到主视口之外。未发现需要修改 Dashboard 子组件 CSS 的可复现问题。
- [x] **Step 4：** `dashboardPage.dom.vitest.test.tsx` 已确认关键指标、主要链接和状态 DOM；本轮只有 CSS 页面头部共享适配，不对 Dashboard 新增无关 DOM 快照。
- [x] **Step 5：** `cd web && npx vitest run lib/dashboardPage.dom.vitest.test.tsx` 与 `scripts/test_tablet_layout_browser.py` 的三档 Dashboard 测试通过；390/1440 的壳与无溢出回归由只读主验收脚本覆盖。

---

### Task 5：资产、财务、报表、管理及其余业务路由

**Files:**
- Modify only when evidence requires: `web/app/(dashboard)/assets/assets.css`
- Modify only when evidence requires: `web/app/(dashboard)/finance/finance.module.css`
- Modify only when evidence requires: `web/app/(dashboard)/changelog/changelog.module.css`
- Modify only when evidence requires: `web/app/globals.css`
- Test: `scripts/test_tablet_layout_browser.py`
- Test: `scripts/acceptance_tablet_landscape.py`

**Interfaces:**
- Consumes: 前述共享样式稳定版本和已有页面路由；项目详情及各一级业务页作为浏览器验收对象。
- Produces: 目标视口下全站已登录业务页的路由覆盖证据；页面局部 CSS 只包含经过验收复现的问题修复。

- [x] **Step 1：** 对项目、进度、支出、审批、商机、资产、财务、报表、通讯录、友商、管理和功能更新逐路由检查空态工作区、页头、主容器与三档平板视口。项目内容态只存在于专用 Playwright context 的内存 fixture，不发往后端。
- [x] **Step 2：** 共享 `PageHeader` 重排解决财务筛选挤压；项目宽表格保持 1066px intrinsic width，在 905/961/1047px 的专属滚动框内浏览，不触发页面宽度扩展；未将桌面表格切换成手机卡片。
- [x] **Step 3：** 检查资产、财务与功能更新的三档目标视口。财务 9 个页签、账套筛选与 Dialog 在 1180px 通过几何检查；资产/功能更新空态工作区无视口溢出，未发现需要页面专属规则的问题。
- [x] **Step 4：** 商机、通讯录、友商、项目/详情、进度、支出、审批、报表与管理路由均完成只读空态与内容壳检查；项目列表数据态由独立内存 fixture 覆盖 Drawer 和行内操作。
- [x] **Step 5：** 浏览器脚本仅使用本地 mock，不会将缺失管理员菜单或后端错误冒充为通过；全站目标路由三档验收已通过，Spark shell 由独立测试分开检查。

---

### Task 6：Spark 独立 shell 和演示页

**Files:**
- Modify only when evidence requires: `web/components/spark/SparkShell.module.css`
- Modify only when evidence requires: `web/components/spark/SparkPages.module.css`
- Test: `scripts/acceptance_tablet_landscape.py`

**Interfaces:**
- Consumes: Spark 独立 layout、侧栏折叠逻辑与本地 mock 页面。
- Produces: Spark dashboard、stores、billing、security、ops、permission 页面在目标宽度的布局回归证据；不依赖主业务 shell 的 CSS selector。

- [x] **Step 1：** 使用真实 Chromium 在 1180/1280/1366px 走查 Spark dashboard、stores、compute、billing、content、security、ops 与 permission 的 shell、顶部搜索与响应式内容 grid。
- [x] **Step 2：** 当前独立 Spark shell 的 232px 导航和工作区宽度都保持在 viewport 内；1080px 以下已有网格规则在目标范围外，无需增加 Spark tablet media query。
- [x] **Step 3：** 8 个演示模块均无页面级横向溢出，网格子项不相交；表格仍在其 `.tableWrap` 内滚动。本轮无 Spark 样式修改。
- [x] **Step 4：** Spark 页面三档目标视口通过；手机 390px 和桌面 1440px 的代表性 Spark/dashboard 由最终边界检查覆盖。

---

### Task 7：集中回归、文档和分支收口

**Files:**
- Modify: `docs/superpowers/plans/2026-09-28-tablet-landscape-adaptation.md`（只更新步骤勾选和实际验收结果）
- Test: `scripts/acceptance_tablet_landscape.py`
- Test: `web` 全部测试及生产构建

**Interfaces:**
- Consumes: Tasks 1–6 的实现和浏览器验收结果。
- Produces: 全路由、视口、主题和自动化检查记录；可审查的功能分支 diff。

- [x] **Step 1：** 三档 tablet 全路由只读验收通过：无页面横向溢出、壳可见、标题筛选/表格容器几何有效；弹层与触控目标由独立内容态浏览器测试验证。
- [x] **Step 2：** 在 1180×820 对项目列表深色/浅色、Dashboard 浅色及 `prefers-reduced-motion: reduce` 完成浏览器检查；无页面溢出，视口和主题状态正确。
- [x] **Step 3：** 1179/1367 边界、390×844 手机、1440×900 Dashboard/项目/审批/资产/财务/报表/管理/Spark 代表页均通过；手机 Dock 与 tablet/desktop 侧栏壳未泄漏，CardList 断点保持 767px。
- [x] **Step 4：** `cd web && npm test`：unit 195 项通过，Vitest 38 files / 227 tests 通过；`python3 -m unittest scripts.test_acceptance_tablet_landscape -v`：21 项通过；`python3 -m unittest scripts.test_tablet_layout_browser -v`：12 项通过；`cd web && npm run build` 成功。构建输出了既有 hooks/`<img>` lint warnings，非本轮 TSX。
- [x] **Step 5：** 本地空态全路由验收通过；浏览器内容态测试全部使用隔离内存 fixture，写请求被阻断。项目 Drawer 内容态视口测试通过；截图仅存于系统临时目录。生产产物的跨路由 SPA RSC 导航在自动化环境偶发 fallback，因此测试使用完整文档导航并记录此限制。
- [x] **Step 6：** `git diff --check` 通过；本次适配、验收脚本与设计/计划文档已提交到 `feat/tablet-landscape-adaptation`。提交记录：规划 `49ec389`、实现 `217e4be`、审查修正 `3d4bf8a`、验收加固 `338869d`（当前分支随后追加 shell 可见性验证修正，待最终提交）。PR 与合并状态由最终 GitHub 流程跟踪。

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
- **Type consistency:** 验收脚本只有一个入口 `scripts/acceptance_tablet_landscape.py`；目标视口执行全路由；边界/回归视口执行 Dashboard、项目、审批、财务、资产、报表、管理与 Spark 总览八条代表路由。内容态专用浏览器测试位于 `scripts/test_tablet_layout_browser.py`，只使用隔离 fixture。
- **Scope check:** 本轮为同一响应式 UI 适配工作流，主业务 shell、共享组件、页面模块和 Spark 是可独立验收的顺序任务，不拆分为 API 或业务子项目。
