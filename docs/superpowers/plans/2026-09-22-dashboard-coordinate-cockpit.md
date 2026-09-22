# Dashboard「交付坐标盘」Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Dashboard 重构为继承 Login 科幻身份握手视觉的「交付坐标盘」，以状态读数、项目航迹、介入队列和数据脉冲替代旧的 KPI 卡片与健康度主表格。

**Architecture:** 保留现有 `dashboardApi.summary()` / `weekly()`、权限菜单和移动端导航契约，只替换 Dashboard 页面组合与 Dashboard 专属视觉组件。页面继续负责请求与错误恢复，三个展示单元分别负责读数、航迹和介入队列，图表使用现有 Recharts 数据源；Dashboard 外壳通过已有 `data-dashboard-shell` 做局部深色主题，不影响其它业务路由。

**Tech Stack:** Next.js 14 App Router、React 18、TypeScript、CSS Modules、Framer Motion、Recharts、Vitest + Testing Library。

## Global Constraints

- 保留 Login 页现有视觉世界和所有业务文案，不修改 `web/app/login/**`。
- 不修改认证接口、Dashboard API 契约、权限判断和移动端 `MobileDock`/Sheet 契约。
- 所有业务数据必须来自 `DashboardSummary` / `Weekly`；不生成虚假项目、同步率、预算或安全指标。
- 直角实面、1px 边界、信号青/酸橙/中断橙；不使用玻璃拟态、轨道扫描、雷达图、装饰性渐变和新主表格。
- 动效使用 transform/opacity/clip-path 等合成属性，并支持 `prefers-reduced-motion`。
- 每个任务先写失败测试，再实现最小代码，测试通过后提交中文 Git 信息；不覆盖工作区中与本任务无关的既有改动。

---

### Task 1: 建立交付坐标盘的组件契约测试

**Files:**
- Modify: `web/lib/dashboardPage.dom.vitest.test.tsx`
- Delete: `web/lib/dashboardMetricCard.dom.vitest.test.tsx`
- Create: `web/lib/dashboardReadout.dom.vitest.test.tsx`

**Interfaces:**
- Consumes: 当前 `DashboardSummary`、`Weekly` mock 和 `DashboardPage`。
- Produces: 供页面实现遵循的 `data-dashboard-zone`、`data-dashboard-readout`、`data-dashboard-intervention`、`data-dashboard-route` 语义契约。

- [ ] **Step 1: 写失败测试**

在 Dashboard DOM 测试中补充以下断言：

```tsx
expect(screen.getByTestId("dashboard-zone-readouts")).not.toBeNull();
expect(screen.getByTestId("dashboard-zone-routes")).not.toBeNull();
expect(screen.getByTestId("dashboard-zone-interventions")).not.toBeNull();
expect(screen.getByTestId("dashboard-zone-pulse")).not.toBeNull();
expect(screen.getAllByTestId("dashboard-readout")).toHaveLength(4);
expect(screen.getByTestId("dashboard-route-list")).not.toBeNull();
```

把健康数据 mock 改为至少一条项目行，并把 weekly mock 改为包含一条逾期任务、一条即将到期任务和一条进度填报，断言项目名称、逾期任务和“待我审批”仍然可见。保留原有刷新保留旧数据和失败重试测试。

新建 `dashboardReadout.dom.vitest.test.tsx`，覆盖 `DashboardReadout` 的标签、读数、辅助文案、tone 和 `aria-label`。

- [ ] **Step 2: 运行失败测试**

Run: `cd web && npm run test:motion -- lib/dashboardPage.dom.vitest.test.tsx lib/dashboardReadout.dom.vitest.test.tsx`

Expected: FAIL，因为新区域和组件尚未存在。

- [ ] **Step 3: 提交测试契约**

```bash
git add web/lib/dashboardPage.dom.vitest.test.tsx web/lib/dashboardReadout.dom.vitest.test.tsx web/lib/dashboardMetricCard.dom.vitest.test.tsx
git commit -m "测试：锁定交付坐标盘 Dashboard 结构"
```

### Task 2: 新增读数、项目航迹和介入队列组件

**Files:**
- Create: `web/components/dashboard/DashboardReadout.tsx`
- Create: `web/components/dashboard/DashboardReadout.module.css`
- Create: `web/components/dashboard/DashboardRouteField.tsx`
- Create: `web/components/dashboard/DashboardRouteField.module.css`
- Create: `web/components/dashboard/DashboardInterventionQueue.tsx`
- Create: `web/components/dashboard/DashboardInterventionQueue.module.css`
- Delete: `web/components/dashboard/DashboardMetricCard.tsx`
- Delete: `web/components/dashboard/DashboardMetricCard.module.css`

**Interfaces:**
- `DashboardReadout({ label, value, detail, tone, format? })`：输出 `[data-dashboard-readout]`，展示数字或金额读数。
- `DashboardRouteField({ health })`：接收 `HealthRow[]`，输出语义列表，每行项目名称链接到 `/projects/{id}`，同时展示进度、执行率、逾期任务、状态和计划结束日期。
- `DashboardInterventionQueue({ weekly, kpi, isAdmin })`：接收 `Weekly | null`、`DashboardKpi`、管理员权限，输出按“审批/逾期/临近到期/最近填报”排序的可操作列表；weekly 为空时只保留 KPI 可推导事项，完全无项时输出 `Empty`。

- [ ] **Step 1: 实现 DashboardReadout**

使用 `<article data-dashboard-readout data-tone={tone} aria-label={label}>`，不使用卡片圆角；数值通过 `CountUp`，金额通过 `format`，状态点仅作为辅助并保留文本。

- [ ] **Step 2: 实现 DashboardRouteField**

使用 `<ol>`/`<li>` 而非 table；每行包含项目链接、`Badge` 状态、`ProgressBar`、百分比、逾期数字和计划结束日期。使用 `health.health` 决定行的 accent，但不要仅以颜色传达风险。

- [ ] **Step 3: 实现 DashboardInterventionQueue**

将 `pending_approvals`、`overdue`、`due_soon`、`progress_logs` 映射为统一队列项，每项包含中文类型、标题、辅助信息和站内链接。审批项链接 `/approvals`，项目/任务项链接 `/projects/{project_id}` 或 `/progress`；不改变后端权限。

- [ ] **Step 4: 运行组件测试**

Run: `cd web && npm run test:motion -- lib/dashboardReadout.dom.vitest.test.tsx lib/dashboardPage.dom.vitest.test.tsx`

Expected: 新组件测试通过，页面结构测试仍因页面尚未接入而失败，下一任务接入。

- [ ] **Step 5: 提交组件**

```bash
git add web/components/dashboard web/lib/dashboardReadout.dom.vitest.test.tsx
git commit -m "新增：建立交付坐标盘核心工作单元"
```

### Task 3: 重写 Dashboard 页面组合

**Files:**
- Modify: `web/app/(dashboard)/dashboard/page.tsx`

**Interfaces:**
- Consumes: Task 2 的 `DashboardReadout`、`DashboardRouteField`、`DashboardInterventionQueue`。
- Produces: 页面区域标记 `dashboard-zone-readouts/routes/interventions/pulse`，保留 `aria-busy`、加载、错误、刷新、空状态和现有链接。

- [ ] **Step 1: 接入四段工作面**

移除 `DashboardMetricCard`、主健康度 table 和两个平级 chart surface，页面改为：

```tsx
<section data-testid="dashboard-zone-readouts">...</section>
<div className={s.commandGrid}>
  <section data-testid="dashboard-zone-routes"> <DashboardRouteField health={data.health} /> </section>
  <section data-testid="dashboard-zone-interventions"> <DashboardInterventionQueue ... /> </section>
</div>
<section data-testid="dashboard-zone-pulse">趋势图 + 构成条带 + 交付日志</section>
```

保留趋势数据转换、`ResponsiveContainer`、`Empty`、`CountUp`、刷新失败 banner 和 `MotionStagger`，但将图表标题和状态文案改为中文“资金脉冲 / 科目构成 / 交付日志”。

- [ ] **Step 2: 运行 Dashboard DOM 测试**

Run: `cd web && npm run test:motion -- lib/dashboardPage.dom.vitest.test.tsx`

Expected: PASS；刷新保留旧数据、失败重试、四段区域和真实内容断言均通过。

- [ ] **Step 3: 提交页面组合**

```bash
git add 'web/app/(dashboard)/dashboard/page.tsx'
git commit -m "重构：将 Dashboard 改为交付坐标盘"
```

### Task 4: 完成交付坐标盘视觉、动效和外壳主题

**Files:**
- Modify: `web/app/(dashboard)/dashboard/dashboard.module.css`
- Modify: `web/components/dashboard/DashboardReadout.module.css`
- Modify: `web/components/dashboard/DashboardRouteField.module.css`
- Modify: `web/components/dashboard/DashboardInterventionQueue.module.css`
- Modify: `web/components/ui/Shell.module.css`

**Interfaces:**
- Consumes: Task 3 的区域 class 与 `data-*` 标记。
- Produces: 桌面、窄屏、移动端和 reduced-motion 的完整视觉表现。

- [ ] **Step 1: 建立 Dashboard 局部 token**

以 Login token 为语义来源，在 Dashboard 根节点定义背景、表面、线条、信号青、锁定酸橙、中断橙和等宽读数变量；通过 `.shell[data-dashboard-shell="true"]` 让内容区进入同一深色环境，其他路由继续使用现有主题。

- [ ] **Step 2: 实现首屏层级**

使用纵向基线、细线、局部辉光和不对称两列结构；禁止新增圆角卡片、侧边粗色条、雷达/轨道背景、渐变文字和装饰性数字。

- [ ] **Step 3: 实现 authored motion**

使用现有 `MotionStagger` 作为区域序列，航迹线以 `transform: scaleX()` 进入，队列使用 `clip-path`/opacity，hover 使用 translate/box-shadow；所有循环动画只保留低频信号点并在 reduced motion 下关闭。

- [ ] **Step 4: 实现响应式**

900px 以下改为单列，767px 以下适配现有 MobileDock，520px 以下读数带横向滚动且不挤压关键数值；所有项目名、任务名和队列动作保持可读与可点击。

- [ ] **Step 5: 提交视觉改造**

```bash
git add 'web/app/(dashboard)/dashboard/dashboard.module.css' web/components/dashboard web/components/ui/Shell.module.css
git commit -m "设计：完成交付坐标盘科技工作面"
```

### Task 5: 质量验证与收尾

**Files:**
- Verify: `web/app/(dashboard)/dashboard/page.tsx`
- Verify: `web/app/(dashboard)/dashboard/dashboard.module.css`
- Verify: `web/components/dashboard/*`
- Verify: `web/components/ui/Shell.module.css`

- [ ] **Step 1: 跑完整测试**

Run: `cd web && npm test`

Expected: unit 与 motion 全部通过。

- [ ] **Step 2: 跑生产构建**

Run: `cd web && npm run build`

Expected: Next.js 构建成功，只有已知的非 Dashboard ESLint warning。

- [ ] **Step 3: 检查格式与差异**

Run: `git diff --check`

Expected: 无空白错误。

- [ ] **Step 4: 运行 Impeccable detector**

Run once after UI work is complete:

```bash
/Users/damon/.agents/skills/impeccable/scripts/impeccable detect --json \
  'web/app/(dashboard)/dashboard/page.tsx' \
  'web/app/(dashboard)/dashboard/dashboard.module.css' \
  web/components/dashboard/DashboardReadout.tsx \
  web/components/dashboard/DashboardReadout.module.css \
  web/components/dashboard/DashboardRouteField.tsx \
  web/components/dashboard/DashboardRouteField.module.css \
  web/components/dashboard/DashboardInterventionQueue.tsx \
  web/components/dashboard/DashboardInterventionQueue.module.css \
  web/components/ui/Shell.module.css
```

Expected: no new detector findings requiring code changes; pre-existing findings must be recorded separately.

- [ ] **Step 5: 视觉验证**

在 `http://127.0.0.1:3001/dashboard` 通过已启动的本地 API 登录后，检查桌面宽屏、窄高窗口和移动宽度：首屏区域、真实数据、刷新保留、空/错状态、键盘焦点和移动 Dock。

- [ ] **Step 6: 收尾提交**

```bash
git status --short
git log --oneline -6
```

确保只包含本次 Dashboard 改造文件和既有用户改动，使用中文分节和中文提交信息向用户汇报验证结果。
