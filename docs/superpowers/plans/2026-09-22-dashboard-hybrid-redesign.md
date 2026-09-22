# Dashboard 混合科技工作台实施计划

> **执行说明：** 本计划按任务逐项执行；推荐使用 executing-plans skill，在每个任务完成后运行对应测试并检查变更范围。

**目标：** 在保留现有 Dashboard 数据、table Layout、Dialog 编辑和移动端导航习惯的前提下，落地「深色科技外壳 + 高可读工作面」的 Dashboard 混合升级。

**架构：** Dashboard 页面使用专属 CSS Module 和 DashboardMetricCard，把科技视觉限制在工作台内容区；共享外壳只增加 Dashboard 路由标记，顶栏与弹层通过低对比度深色/青色细节建立统一识别。数据请求保持现有并发方式，刷新从“清空后等待”改为“保留上次成功数据并标记刷新中”。

**技术栈：** Next.js 14.2、React 18、TypeScript、Framer Motion 13、Recharts 3、CSS Modules、Vitest、Testing Library。

## 全局约束

- 保留当前工作台页头、四项 KPI、两张图表、项目健康度表格和本周动态的顺序与数据口径。
- 不修改 Dashboard API、权限规则、路由结构、表格字段或 Dialog 表单字段。
- table 继续承担浏览/筛选/进入详情，Dialog/Drawer/Confirm 继续承担编辑/审批/确认。
- 保留 Escape 关闭、焦点回收、滚动锁定、脏表单确认和移动端弹层行为。
- 不引入轨道扫描场、中心雷达、持续高频闪烁或没有数据来源的趋势指标。
- Dashboard 内容保持浅色高可读工作面；深色科技层只用于导航、顶栏和少量状态装饰。
- 所有新增动画都必须在 prefers-reduced-motion: reduce 下退化为即时或极短过渡。
- 只提交本次 Dashboard 相关文件；工作区中已有的登录页改动、.impeccable/design.json 和 DESIGN.md 不得被覆盖、回退或顺带提交。

---

## 文件边界

### 新建

- web/components/dashboard/DashboardMetricCard.tsx：Dashboard KPI 卡片的结构、tone 和 CountUp 组合。
- web/components/dashboard/DashboardMetricCard.module.css：KPI 卡片的局部视觉、状态光标和 reduced-motion 规则。
- web/app/(dashboard)/dashboard/dashboard.module.css：Dashboard 布局、图表、健康度表格、动态区、刷新状态和响应式规则。
- web/lib/dashboardMetricCard.dom.vitest.test.tsx：KPI 卡片 DOM 契约测试。
- web/lib/dashboardPage.dom.vitest.test.tsx：Dashboard 首次加载、成功刷新和刷新失败保留旧数据的 DOM 测试。

### 修改

- web/app/(dashboard)/dashboard/page.tsx：接入页面样式模块、KPI 组件、刷新保留数据逻辑和语义化区块。
- web/app/(dashboard)/layout.tsx：为 /dashboard 的 Shell 增加路由级 data 标记，不改变导航/权限行为。
- web/components/motion/MotionStagger.tsx：增加可选 className，让 Dashboard 能控制动画容器的局部布局。
- web/components/ui/Shell.module.css：仅在 Dashboard data 标记下增强顶栏的深色科技层，不改变其他页面。
- web/components/ui/Modal.module.css：统一弹层的遮罩、边界高光和进入层次，保留所有交互行为。
- web/components/ui/Badge.module.css：提高状态徽标的辨识度和轻量状态点表现，保持原有 tone 名称。
- web/components/ui/ProgressBar.module.css：提高进度轨道可读性，保持 ProgressBar props 和 aria 契约。

---

## 任务一：建立 Dashboard KPI 组件与动效契约

文件：

- Create: web/components/dashboard/DashboardMetricCard.tsx
- Create: web/components/dashboard/DashboardMetricCard.module.css
- Test: web/lib/dashboardMetricCard.dom.vitest.test.tsx

接口：

- Consumes: CountUp、ReactNode、DashboardMetricTone。
- Produces: 带有 data-dashboard-metric 和 data-tone 的 article，供 Dashboard 页面和 DOM 测试稳定识别。

- [ ] 步骤 1：先写 KPI 卡片失败测试

在 web/lib/dashboardMetricCard.dom.vitest.test.tsx 中写入以下测试，锁定中文标签、状态 tone、辅助说明和最终值的可访问语义：

~~~tsx
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import DashboardMetricCard from "../components/dashboard/DashboardMetricCard";

afterEach(() => cleanup());

describe("DashboardMetricCard", () => {
  it("渲染标签、数值、辅助说明和语义 tone", () => {
    render(
      <DashboardMetricCard
        label="逾期任务"
        value={3}
        detail={<>我负责 <span className="mono">1</span></>}
        tone="danger"
      />,
    );

    const card = screen.getByTestId("dashboard-metric");
    expect(card).toHaveAttribute("data-tone", "danger");
    expect(card).toHaveTextContent("逾期任务");
    expect(card).toHaveTextContent("我负责");
    expect(card.querySelector('[data-metric-value="3"]')).not.toBeNull();
  });

  it("默认使用中性 tone，并允许格式化金额", () => {
    render(
      <DashboardMetricCard
        label="本月支出"
        value={12800}
        format={(value) => "¥" + Math.round(value).toLocaleString("zh-CN")}
        detail="按已通过支出统计"
      />,
    );

    const card = screen.getByTestId("dashboard-metric");
    expect(card).toHaveAttribute("data-tone", "neutral");
    expect(card).toHaveAttribute("aria-label", "本月支出");
    expect(card).toHaveTextContent("按已通过支出统计");
  });
});
~~~

- [ ] 步骤 2：运行测试确认组件尚未存在

运行：

~~~bash
cd web
npm run test:motion -- lib/dashboardMetricCard.dom.vitest.test.tsx
~~~

预期：失败，原因是 DashboardMetricCard 模块尚未创建。

- [ ] 步骤 3：实现组件和局部样式

DashboardMetricCard.tsx 使用以下确定的接口和结构：

~~~tsx
"use client";

import type { ReactNode } from "react";
import CountUp from "@/components/motion/CountUp";
import s from "./DashboardMetricCard.module.css";

export type DashboardMetricTone = "neutral" | "warn" | "danger" | "done";

export default function DashboardMetricCard({
  label,
  value,
  format,
  detail,
  tone = "neutral",
}: {
  label: string;
  value: number;
  format?: (value: number) => string;
  detail: ReactNode;
  tone?: DashboardMetricTone;
}) {
  return (
    <article
      className={s.card + " " + s[tone]}
      data-dashboard-metric="true"
      data-testid="dashboard-metric"
      data-tone={tone}
      aria-label={label}
    >
      <div className={s.head}>
        <span className={s.label}>{label}</span>
        <span className={s.signal} aria-hidden="true" />
      </div>
      <div className={s.value} data-metric-value={value}>
        <CountUp value={value} format={format} />
      </div>
      <div className={s.detail}>{detail}</div>
    </article>
  );
}
~~~

DashboardMetricCard.module.css 至少包含以下结构：

~~~css
.card {
  position: relative;
  min-width: 0;
  min-height: 132px;
  padding: 18px 18px 16px;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--card);
  box-shadow: var(--shadow-card);
  transition: border-color var(--motion-base) ease, box-shadow var(--motion-base) ease, transform var(--motion-base) ease;
}
.card::after {
  position: absolute;
  right: 0;
  bottom: 0;
  left: 0;
  height: 2px;
  content: "";
  background: linear-gradient(90deg, transparent, var(--metric-accent), transparent);
  opacity: .42;
}
.card:hover { border-color: var(--line-blue); box-shadow: 0 12px 28px rgba(23, 43, 77, .09); transform: translateY(-1px); }
.neutral { --metric-accent: var(--brand); }
.warn { --metric-accent: #d48806; }
.danger { --metric-accent: var(--danger); }
.done { --metric-accent: var(--done); }
.head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.label { color: var(--ink-2); font-size: 13px; font-weight: 650; letter-spacing: .03em; }
.signal { width: 7px; height: 7px; flex: none; border-radius: 50%; background: var(--metric-accent); box-shadow: 0 0 0 4px rgba(22, 119, 255, .08); }
.value { margin-top: 14px; color: var(--ink); font-size: clamp(24px, 2.2vw, 30px); font-weight: 720; line-height: 1.08; font-variant-numeric: tabular-nums; }
.detail { min-height: 22px; margin-top: 12px; color: var(--ink-3); font-size: 13px; line-height: 1.45; }
@media (prefers-reduced-motion: reduce) {
  .card { transition: none; }
  .card:hover { transform: none; }
}
~~~

如需为不同 tone 调整光晕，只能使用明确的 CSS 类，不引入运行时颜色计算或 JS 样式逻辑。

- [ ] 步骤 4：运行测试确认通过

运行：

~~~bash
cd web
npm run test:motion -- lib/dashboardMetricCard.dom.vitest.test.tsx
~~~

预期：2 个 KPI 卡片测试全部通过。

- [ ] 步骤 5：提交独立任务

~~~bash
git add web/components/dashboard web/lib/dashboardMetricCard.dom.vitest.test.tsx
git commit -m "新增：建立 Dashboard KPI 指标卡片"
~~~

## 任务二：重构 Dashboard 页面结构与刷新状态

文件：

- Modify: web/app/(dashboard)/dashboard/page.tsx:1-224
- Modify: web/components/motion/MotionStagger.tsx:1-28
- Test: web/lib/dashboardPage.dom.vitest.test.tsx

接口：

- Consumes: DashboardMetricCard、现有 dashboardApi.summary()、dashboardApi.weekly()、useActivity()、PageHeader。
- Produces: 带 data-dashboard-page="true" 和 aria-busy 的工作台根节点；刷新时保留上一份 DashboardSummary。

- [ ] 步骤 1：先写刷新行为失败测试

新建 web/lib/dashboardPage.dom.vitest.test.tsx，使用模块替身隔离 API、菜单、身份和图表库。测试必须覆盖首次成功后刷新中的保留和刷新失败后的保留：

~~~tsx
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { DashboardSummary, Weekly } from "./api";

const mocks = vi.hoisted(() => ({
  summary: vi.fn(),
  weekly: vi.fn(),
  beginActivity: vi.fn(),
  finish: vi.fn(),
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

vi.mock("@/lib/useMeta", () => ({
  useMeta: () => ({ userName: () => "张伟", deptName: () => "产品部" }),
  useMe: () => ({ me: { dept_id: 3 } }),
  useMenus: () => ({ isAdmin: true }),
}));

vi.mock("@/lib/useActivity", () => ({
  useActivity: () => ({ beginActivity: mocks.beginActivity }),
}));

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("./api")>("./api");
  return {
    ...actual,
    dashboardApi: { summary: () => mocks.summary(), weekly: () => mocks.weekly() },
  };
});

vi.mock("recharts", () => {
  const Box = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  return {
    CartesianGrid: Box, Cell: Box, Legend: Box, Line: Box, LineChart: Box,
    Pie: Box, PieChart: Box, ResponsiveContainer: Box, Tooltip: Box, XAxis: Box, YAxis: Box,
  };
});

import DashboardPage from "../app/(dashboard)/dashboard/page";

function summary(overrides: Partial<DashboardSummary["kpi"]> = {}): DashboardSummary {
  return {
    kpi: {
      my_projects: 6, active_projects: 4, overdue_tasks: 2, my_overdue_tasks: 1,
      near_milestones: 1, stagnant_projects: 0, total_budget: 100000,
      total_spent: 42000, total_rate: .42, month_spent: 12800, month: "2026-09",
      pending_approvals: 2, unread_notifications: 3, ...overrides,
    },
    trend: [{ month: "2026-09", spent: 12800 }],
    by_subject: [{ subject: "张伟", budget: 40000, spent: 12800 }],
    health: [],
  };
}

const weekly: Weekly = {
  range: { from: "2026-09-15", to: "2026-09-22" }, project_id: null,
  progress_logs: [], log_count: 0, overdue: [], due_soon: [], projects: [],
};

beforeEach(() => {
  mocks.summary.mockReset();
  mocks.weekly.mockReset();
  mocks.finish.mockReset();
  mocks.beginActivity.mockReset().mockReturnValue(mocks.finish);
  mocks.weekly.mockResolvedValue(weekly);
});

afterEach(() => cleanup());

it("刷新时保留上一份成功数据，并在完成后结束忙碌状态", async () => {
  let resolveRefresh!: (value: DashboardSummary) => void;
  mocks.summary
    .mockResolvedValueOnce(summary({ my_projects: 6 }))
    .mockImplementationOnce(() => new Promise((resolve) => { resolveRefresh = resolve; }));

  render(<DashboardPage />);
  const refresh = await screen.findByRole("button", { name: "刷新" });
  const page = document.querySelector('[data-dashboard-page="true"]');
  expect(page).toHaveAttribute("aria-busy", "false");

  fireEvent.click(refresh);
  expect(screen.getByRole("button", { name: "刷新中" })).toBeDisabled();
  expect(screen.getByText("我的项目")).toBeInTheDocument();
  expect(page).toHaveAttribute("aria-busy", "true");

  await act(async () => resolveRefresh(summary({ my_projects: 7 })));
  await waitFor(() => expect(screen.getByRole("button", { name: "刷新" })).toBeEnabled());
  expect(page).toHaveAttribute("aria-busy", "false");
});

it("刷新失败时保留已成功数据并显示可重试提示", async () => {
  mocks.summary.mockResolvedValueOnce(summary()).mockRejectedValueOnce(new Error("服务暂不可用"));
  render(<DashboardPage />);
  const refresh = await screen.findByRole("button", { name: "刷新" });

  fireEvent.click(refresh);
  await screen.findByRole("alert");
  expect(screen.getByText("刷新失败，以下为上次成功数据。服务暂不可用")).toBeInTheDocument();
  expect(screen.getByText("我的项目")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
});
~~~

运行：

~~~bash
cd web
npm run test:motion -- lib/dashboardPage.dom.vitest.test.tsx
~~~

预期：测试先失败，因为当前页面会在刷新时返回 LoadingBlock，没有 刷新中 状态，也没有保留数据的页面根节点。

- [ ] 步骤 2：扩展 MotionStagger 的局部 className 接口

将组件签名改为：

~~~tsx
export default function MotionStagger({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const reduced = useReducedMotion();
  return (
    <m.div
      className={className}
      variants={reduced ? undefined : parent}
      initial={reduced ? false : "hidden"}
      animate="show"
    >
      {Array.isArray(children)
        ? children.map((item, index) => <m.div key={index} variants={reduced ? undefined : child}>{item}</m.div>)
        : children}
    </m.div>
  );
}
~~~

不改变现有调用方的默认行为；未传 className 时仍然输出同样的动画结构。

- [ ] 步骤 3：实现 Dashboard 的初始加载、刷新和失败分支

在 page.tsx 中保留现有 data/weekly 类型与 API 调用，只把加载分支改为“无数据时骨架，有数据时保留”：

~~~tsx
const [loading, setLoading] = useState(true);

const load = useCallback(async () => {
  const finish = beginActivity({ label: "刷新工作台", scope: "content" });
  setLoading(true);
  setErr("");
  try {
    const [s, w] = await Promise.all([
      dashboardApi.summary(),
      dashboardApi.weekly().catch(() => null),
    ]);
    setData(s);
    setWeekly(w);
  } catch (e) {
    setErr(errText(e));
  } finally {
    setLoading(false);
    finish();
  }
}, [beginActivity]);

useEffect(() => { load(); }, [load]);

if (!data) {
  if (loading) return <LoadingBlock kpis={4} />;
  return (
    <div className={s.initialError} role="alert">
      <strong>工作台加载失败</strong>
      <span>{err || "暂时无法获取工作台数据。"}</span>
      <button className="btn-primary" type="button" onClick={load}>重试</button>
    </div>
  );
}
~~~

根节点和刷新操作使用以下契约：

~~~tsx
<div className={s.dashboard} data-dashboard-page="true" aria-busy={loading}>
  <PageHeader
    title="工作台"
    className={s.pageHeader}
    actions={
      <>
        <button
          className="btn-ghost"
          type="button"
          onClick={load}
          disabled={loading}
          aria-busy={loading}
        >
          {loading ? "刷新中" : "刷新"}
        </button>
        {isAdmin && (
          <Link className="btn-primary" href="/approvals">
            待审批 {k.pending_approvals}
          </Link>
        )}
      </>
    }
  />
  {err && (
    <div className={s.staleBanner} role="alert">
      <span>刷新失败，以下为上次成功数据。{err}</span>
      <button className="btn-ghost" type="button" onClick={load} disabled={loading}>重试</button>
    </div>
  )}
  {/* KPI、图表和明细三组直接作为 MotionStagger 子项，保证分层 reveal。 */}
</div>
~~~

旧的内联 .kpi 卡片替换为四个 DashboardMetricCard：

~~~tsx
<div className={s.metricGrid}>
  <DashboardMetricCard label="我的项目" value={k.my_projects} detail={<>进行中 <CountUp value={k.active_projects} /></>} />
  <DashboardMetricCard label="逾期任务" value={k.overdue_tasks} tone={k.overdue_tasks > 0 ? "danger" : "neutral"} detail={<>我负责 <CountUp value={k.my_overdue_tasks} /></>} />
  {isAdmin ? (
    <DashboardMetricCard label="待我审批" value={k.pending_approvals} tone={k.pending_approvals > 0 ? "warn" : "neutral"} detail={<>未读通知 <CountUp value={k.unread_notifications} /></>} />
  ) : (
    <DashboardMetricCard label="未读通知" value={k.unread_notifications} detail="审批结果会通过通知告知您" />
  )}
  <DashboardMetricCard label={k.month + " 支出"} value={k.month_spent} format={fmtMoney} detail="按已通过支出统计" />
</div>
~~~

图表和明细区改为语义化 section，并使用 dashboard.module.css 的本地类名替代布局/间距内联样式；Recharts 的数据、动画时长和 reduced-motion 判断继续沿用当前逻辑。项目健康度仍然使用 table.grid，weekly 内容仍然使用 ul.timeline，只增加局部 wrapper 类名。

- [ ] 步骤 4：运行 Dashboard DOM 测试确认通过

运行：

~~~bash
cd web
npm run test:motion -- lib/dashboardPage.dom.vitest.test.tsx lib/dashboardMetricCard.dom.vitest.test.tsx
~~~

预期：刷新保留、刷新失败提示、KPI tone 和组件语义测试全部通过。

- [ ] 步骤 5：提交页面行为任务

~~~bash
git add 'web/app/(dashboard)/dashboard/page.tsx' web/components/motion/MotionStagger.tsx web/lib/dashboardPage.dom.vitest.test.tsx
git commit -m "优化：升级 Dashboard 刷新状态与信息层级"
~~~

## 任务三：落地 Dashboard 高可读工作面与响应式布局

文件：

- Create: web/app/(dashboard)/dashboard/dashboard.module.css
- Modify: web/app/(dashboard)/dashboard/page.tsx:70-230（补齐局部 className）

接口：

- Consumes: 任务一的 DashboardMetricCard、任务二的 data-dashboard-page 和 MotionStagger className。
- Produces: 桌面四列 KPI/两列图表/两列明细，平板堆叠，移动单列且健康度 table 在自身容器内横滑。

- [ ] 步骤 1：写入页面样式模块

dashboard.module.css 使用以下布局骨架，所有选择器只作用于 Dashboard：

~~~css
.dashboard { --dashboard-cyan: #6cf3ff; --dashboard-lime: #c6ff72; min-width: 0; }
.pageHeader[data-page-header="true"] { position: relative; overflow: hidden; border-color: rgba(22, 119, 255, .2); background: linear-gradient(110deg, rgba(108, 243, 255, .08), transparent 38%), var(--card); }
.pageHeader[data-page-header="true"]::before { position: absolute; inset: 0 auto 0 0; width: 3px; content: ""; background: linear-gradient(var(--dashboard-cyan), var(--brand)); }
.metricGrid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; margin-bottom: 18px; }
.chartGrid, .detailGrid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.chartGrid { margin-bottom: 18px; }
.surface { min-width: 0; padding: 20px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--card); box-shadow: var(--shadow-card); }
.chartSurface { min-height: 292px; }
.sectionTitle { display: flex; align-items: baseline; gap: 10px; margin: 0 0 14px; color: var(--ink); font-size: 16px; font-weight: 700; }
.sectionSub { color: var(--ink-3); font-size: 13px; font-weight: 500; }
.chart { width: 100%; height: 220px; }
.healthBlock, .activityBlock { min-width: 0; }
.healthTableScroll { overflow-x: auto; overscroll-behavior-x: contain; }
.healthTable { min-width: 560px; }
.healthTable td:first-child { min-width: 170px; }
.progressCell { min-width: 130px; }
.activityCard { min-height: 240px; }
.activityGroup { margin-bottom: 14px; }
.activityGroup:last-child { margin-bottom: 0; }
.activityLabel { margin-bottom: 5px; color: var(--ink-2); font-size: 13px; font-weight: 650; }
.activityList { margin: 0; padding-left: 18px; font-size: 14px; }
.activityList li + li { margin-top: 5px; }
.metaNote { margin: 9px 0 0; }
.valueDanger { color: var(--danger); }
.initialError { display: grid; justify-items: start; gap: 8px; padding: 28px; border: 1px solid var(--line-danger); border-radius: var(--radius); background: var(--danger-bg); color: var(--danger); }
.initialError strong { font-size: 16px; }
.staleBanner { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: -4px 0 14px; padding: 10px 12px; border: 1px solid var(--line-warn); border-radius: var(--radius); background: var(--warn-bg); color: var(--warn); }
.staleBanner button { flex: none; }
.motion { min-width: 0; }
@media (max-width: 1180px) { .metricGrid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 900px) { .chartGrid, .detailGrid { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 640px) {
  .metricGrid { gap: 10px; }
  .surface { padding: 16px 14px; }
  .chartSurface { min-height: 270px; }
  .chart { height: 208px; }
  .sectionTitle { font-size: 15px; }
  .staleBanner { align-items: flex-start; flex-direction: column; }
  .staleBanner button { width: 100%; }
}
@media (prefers-reduced-motion: reduce) {
  .pageHeader::before { opacity: .6; }
}
~~~

避免使用 color-mix 作为 Dashboard 布局依赖；局部 CSS 使用现有颜色变量与已确认的青色/荧光绿色十六进制值，避免不支持时造成关键文字不可见。

- [ ] 步骤 2：把图表和动态区的内联尺寸替换为局部 class

至少完成以下替换，避免继续堆叠 inline style：

~~~tsx
<div className={s.chartSurface}>
  <h2 className={s.sectionTitle}>近 6 个月支出趋势</h2>
  <div className={s.chart}><ResponsiveContainer>...</ResponsiveContainer></div>
</div>
<div className={s.healthBlock}>
  <h2 className={s.sectionTitle}>项目健康度</h2>
  <div className={s.healthTableScroll}><table className={"grid " + s.healthTable}>...</table></div>
</div>
<div className={s.activityBlock}>
  <h2 className={s.sectionTitle}>本周动态 <span className={s.sectionSub}>...</span></h2>
  <div className={s.surface + " " + s.activityCard}>...</div>
  <p className={"tiny " + s.metaNote}>...</p>
</div>
~~~

表格里的逾期和执行率危险色改为 s.valueDanger，进度条所在单元格包裹为 s.progressCell；不得删除 table.grid、table-scroll、health-table 的现有语义和滚动行为。

- [ ] 步骤 3：在窄屏和 reduced-motion 下检查布局

运行 Dashboard 专属测试：

~~~bash
cd web
npm run test:motion -- lib/dashboardPage.dom.vitest.test.tsx
~~~

预期：测试不因 CSS Module class 名变化而失败，页面结构仍能找到刷新、审批和工作台区块。

- [ ] 步骤 4：提交内容工作面任务

~~~bash
git add 'web/app/(dashboard)/dashboard/page.tsx' 'web/app/(dashboard)/dashboard/dashboard.module.css'
git commit -m "优化：打磨 Dashboard 内容工作面与响应式布局"
~~~

## 任务四：统一科技外壳、Badge、ProgressBar 与 Dialog 反馈

文件：

- Modify: web/app/(dashboard)/layout.tsx:428-432
- Modify: web/components/ui/Shell.module.css:172-227
- Modify: web/components/ui/Modal.module.css:1-80
- Modify: web/components/ui/Badge.module.css:1-14
- Modify: web/components/ui/ProgressBar.module.css:1-9

接口：

- Consumes: /dashboard 路径信息、现有 BadgeTone、BarTone、Modal AnimatePresence 和 focus/dirty 行为。
- Produces: Dashboard 顶栏科技外壳和跨页面一致但克制的状态/弹层视觉；不改变任何组件 props 或交互事件。

- [ ] 步骤 1：增加 Dashboard Shell data 标记

在 layout.tsx 的外壳根节点增加属性，不改变类名和折叠逻辑：

~~~tsx
<div
  className={s.shell + (collapsed ? " " + s.collapsed : "")}
  data-dashboard-shell={pathname === "/dashboard" ? "true" : undefined}
>
~~~

- [ ] 步骤 2：只在 Dashboard 顶栏增加深色科技关系

在 Shell.module.css 增加以下作用域规则，其他业务路由继续使用当前浅色顶栏：

~~~css
.shell[data-dashboard-shell="true"] .topbar {
  color: #eaf7ff;
  background: linear-gradient(100deg, rgba(7, 19, 31, .98), rgba(11, 27, 41, .94));
  border-bottom-color: rgba(108, 243, 255, .18);
  box-shadow: 0 1px 0 rgba(108, 243, 255, .08), 0 10px 28px rgba(7, 19, 31, .12);
}
.shell[data-dashboard-shell="true"] .crumb { color: rgba(213, 237, 249, .66); }
.shell[data-dashboard-shell="true"] .crumb b { color: #fff; }
.shell[data-dashboard-shell="true"] .topDate { color: rgba(213, 237, 249, .62); }
.shell[data-dashboard-shell="true"] .userChipWrap { border-left-color: rgba(108, 243, 255, .2); }
.shell[data-dashboard-shell="true"] .userChipText b { color: #fff; }
.shell[data-dashboard-shell="true"] .userChip:hover,
.shell[data-dashboard-shell="true"] .userChip[aria-expanded="true"] { background: rgba(108, 243, 255, .1); }
~~~

保留账号菜单的浅色卡片背景，保证菜单文字与操作对比度，不把整个账号菜单改成暗色弹层。

- [ ] 步骤 3：升级共享状态与弹层的视觉细节

在 Modal.module.css 只调整表现层：遮罩使用更深的蓝黑透明层和稍强的 blur；.panel 与 .drawer 增加低对比度青色边界光；.head 保持 var(--card) 高可读背景并加入轻微顶部高光；不修改 z-index、尺寸、滚动、.inner 脏数据确认和移动端规则。

在 Badge.module.css 保持 todo/doing/paused/warn/danger/done 六个类名，为 .badge 增加 letter-spacing: .01em 和 transition: background 120ms ease-out, border-color 120ms ease-out，使用 ::before 添加 4px 装饰点；装饰点只作为辅助，文本仍然完整显示。

在 ProgressBar.module.css 将 .track 高度从 4px 调整为 6px，将 .fill 的过渡保留为 width/background 短过渡；保留 .wrap 的 role="progressbar" 和现有 title。

所有新增阴影、光晕和过渡都加入对应的 prefers-reduced-motion: reduce 规则：取消 transform/box-shadow 动画，只保留静态边界。

- [ ] 步骤 4：运行共享行为回归测试

运行：

~~~bash
cd web
npm run test:unit
npm run test:motion
~~~

预期：现有身份外壳、PageHeader、Modal focus、移动导航和动效测试全部通过；共享 CSS 改动不得引起 TypeScript 或 DOM 契约失败。

- [ ] 步骤 5：提交外壳与共享视觉任务

~~~bash
git add 'web/app/(dashboard)/layout.tsx' web/components/ui/Shell.module.css web/components/ui/Modal.module.css web/components/ui/Badge.module.css web/components/ui/ProgressBar.module.css
git commit -m "优化：统一 Dashboard 科技外壳与交互反馈"
~~~

## 任务五：浏览器验收、构建和 Impeccable 检查

文件：

- Verify: web/app/(dashboard)/dashboard/page.tsx
- Verify: web/app/(dashboard)/dashboard/dashboard.module.css
- Verify: web/components/dashboard/DashboardMetricCard.tsx
- Verify: web/components/dashboard/DashboardMetricCard.module.css
- Verify: web/components/ui/Shell.module.css
- Verify: web/components/ui/Modal.module.css
- Verify: web/components/ui/Badge.module.css
- Verify: web/components/ui/ProgressBar.module.css

- [ ] 步骤 1：运行全量测试

~~~bash
cd web
npm test
~~~

预期：unit 和 motion 两套测试全部通过；若出现已有的非 Dashboard ESLint 警告，只记录，不扩大本次修改范围。

- [ ] 步骤 2：运行生产构建

开发服务器运行期间不要覆盖 .next。如当前端口 3001 的开发服务器仍在使用，先记录其会话，再停止服务器，执行：

~~~bash
cd web
npm run build
~~~

构建通过后，将构建产物移动到任务临时目录 /tmp/login-review-20260922/.next-build-after-dashboard，再恢复 npm run dev，确保浏览器预览继续使用端口 3001。构建日志中的既有 ESLint warning 与本次 Dashboard 错误分开记录。

- [ ] 步骤 3：用本地浏览器验证真实页面

在当前 http://127.0.0.1:3001/login?preview=remove-orbit 预览标签页中导航到 /dashboard，至少检查：

1. 桌面宽度：深色顶栏、四项 KPI、两列图表、健康度与动态并列，页面没有横向溢出。
2. 刷新：已有数据不消失，按钮显示“刷新中”，完成后恢复“刷新”；失败时旧数据保留并出现重试提示。
3. 平板宽度：KPI 折成两列，图表和明细堆叠，文字和图例不互相覆盖。
4. 移动宽度：MobileDock 保持存在，内容单列，健康度表格只在自身容器内横向滚动。
5. 键盘：Tab 可到刷新/审批/项目链接，焦点可见；页面已有 Dialog 打开后 Escape、焦点回收和脏表单确认不回归。
6. reduced-motion：关闭进入/数字/图表动效后，内容仍完整可见，刷新反馈仍可理解。

- [ ] 步骤 4：只运行一次 Impeccable detector

确认 UI 修改已经完成后运行一次：

~~~bash
/Users/damon/.agents/skills/impeccable/scripts/impeccable detect --json \
  'web/app/(dashboard)/dashboard/page.tsx' \
  'web/app/(dashboard)/dashboard/dashboard.module.css' \
  web/components/dashboard/DashboardMetricCard.tsx \
  web/components/dashboard/DashboardMetricCard.module.css \
  web/components/ui/Shell.module.css \
  web/components/ui/Modal.module.css \
  web/components/ui/Badge.module.css \
  web/components/ui/ProgressBar.module.css
~~~

只修复 detector 指向本次 Dashboard 变更且不违反高可读工作面约束的问题；不得借机重做登录页或其他业务页面。

- [ ] 步骤 5：检查最终范围并提交整合变更

~~~bash
git diff --check
git status --short
git diff --stat HEAD~4..HEAD
~~~

确认暂存/提交内容只包含 Dashboard 实施文件后，若前四个任务已分别提交，则不再 squash；如果 detector 产生了额外的小修复，使用中文提交信息：

~~~bash
git add 'web/app/(dashboard)/dashboard' 'web/app/(dashboard)/layout.tsx' web/components/dashboard web/components/motion/MotionStagger.tsx web/components/ui/Shell.module.css web/components/ui/Modal.module.css web/components/ui/Badge.module.css web/components/ui/ProgressBar.module.css web/lib/dashboardMetricCard.dom.vitest.test.tsx web/lib/dashboardPage.dom.vitest.test.tsx
git commit -m "修复：完成 Dashboard 混合科技工作台验收"
~~~

## 计划自检

- 规格中的视觉方向由任务三的 Dashboard 内容样式和任务四的 Shell/共享反馈覆盖。
- 规格中的信息架构由任务二保留四项 KPI、两张图表、健康度 table 和本周动态覆盖。
- 刷新保留数据、错误保留旧数据、局部 aria-busy 和重试入口由任务二的 DOM 测试锁定。
- table/Dialog 约束由任务二的 markup 保留和任务四的“只改表现层”边界覆盖。
- 页面 reveal、CountUp、Recharts、Dialog transition 和 reduced-motion 由任务一、二、三、四共同覆盖。
- 桌面/平板/移动布局、键盘、移动 Dock、滚动 table 和浏览器真实验收由任务三与任务五覆盖。
- 计划未引入 API、依赖、路由或新业务指标；所有文件路径、组件接口和测试命令已经明确。

计划完成后，执行阶段按任务逐项勾选；每个任务先测试、再实现、再验证并单独提交，避免把已有登录页工作区改动带入 Dashboard 提交。
