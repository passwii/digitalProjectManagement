# 统一工作台页面头部 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为工作台一级页面建立统一的筛选/上下文左侧、主操作右侧页面头部，并迁移所有目标页面而不改变业务行为。

**Architecture:** 新增轻量 `PageHeader` 组件，只负责页面级语义标题和左右布局；页面继续拥有筛选状态、权限、操作和数据请求。Projects 使用 `ListPageLayout.toolbar` 承载 `PageHeader`，其他页面逐步移除 `PageActions`、`toolbar-card` 和仅用于一级头部的独立包装；页面内部业务分区继续使用现有 `section-head`。

**Tech Stack:** Next.js 14 App Router、React 18、TypeScript、CSS Modules、Vitest、Testing Library、现有全局按钮与表格样式。

## Global Constraints

- 不改变后端接口、数据结构、URL 参数名称、分页契约或业务状态机。
- 页面级头部最多保留一个视觉容器；筛选/上下文在左，主操作在最右侧。
- 保留现有按钮文案、蓝色主按钮样式、权限判断、数据请求、弹窗和 URL 行为。
- Reports 项目选择器桌面端使用 `min-width: 220px` 和 `max-width: min(34vw, 360px)` 的局部约束；空间不足时允许筛选区换行。
- 页面内部的 `section-head` 不在本次统一范围内。
- 任何行为变更先写失败测试并确认失败，再写生产代码。
- 使用 `apply_patch` 编辑，避免全文件格式化和无关重构。

---

### Task 1: 建立 PageHeader 组件契约

**Files:**
- Create: `web/lib/pageHeader.dom.vitest.test.tsx`
- Create: `web/components/ui/PageHeader.tsx`
- Create: `web/components/ui/PageHeader.module.css`

**Interfaces:**
- Produces `PageHeader({ title, filters?, actions?, className? })`。
- `filters` 和 `actions` 为任意 `ReactNode`，不由组件持有状态。

- [ ] **Step 1: Write the failing test**

```tsx
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import PageHeader from "../components/ui/PageHeader";

afterEach(() => cleanup());

describe("PageHeader", () => {
  it("保留页面标题并把筛选与操作放入左右区域", () => {
    render(
      <PageHeader
        title="项目台账"
        filters={<input aria-label="搜索项目" />}
        actions={<button type="button">新建项目</button>}
      />,
    );

    expect(document.querySelector("h1.sr-only")?.textContent).toBe("项目台账");
    expect(document.querySelector('[data-page-header="true"]')).not.toBeNull();
    expect(document.querySelector('[data-page-header-filters="true"] input')).not.toBeNull();
    expect(document.querySelector('[data-page-header-actions="true"] button')?.textContent).toBe("新建项目");
  });

  it("没有筛选或操作时不创建空区域", () => {
    render(<PageHeader title="审批中心" />);

    expect(document.querySelector('[data-page-header-filters="true"]')).toBeNull();
    expect(document.querySelector('[data-page-header-actions="true"]')).toBeNull();
  });

  it("把自定义 class 连接到头部视觉容器", () => {
    render(<PageHeader title="报表" className="reports-header" />);
    expect(document.querySelector('[data-page-header="true"].reports-header')).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run lib/pageHeader.dom.vitest.test.tsx`

Expected: FAIL because `../components/ui/PageHeader` does not exist.

- [ ] **Step 3: Write minimal implementation**

`PageHeader.tsx` 使用 `sr-only` 标题和可选的 filters/actions 容器；CSS 使用单层 card 外观，桌面端 filters 可换行、actions 贴右，`max-width: 900px` 与 `max-width: 520px` 下自然堆叠。

- [ ] **Step 4: Run focused test**

Run: `cd web && npx vitest run lib/pageHeader.dom.vitest.test.tsx`

Expected: PASS with 3 tests.

- [ ] **Step 5: Commit**

```bash
git add web/lib/pageHeader.dom.vitest.test.tsx web/components/ui/PageHeader.tsx web/components/ui/PageHeader.module.css
git commit -m "组件：新增统一页面头部"
```

### Task 2: 迁移 Projects、Partners、Contacts

**Files:**
- Modify: `web/app/(dashboard)/projects/page.tsx`
- Modify: `web/app/(dashboard)/partners/page.tsx`
- Modify: `web/app/(dashboard)/contacts/page.tsx`

**Interfaces:**
- Consumes `PageHeader` from Task 1.
- Produces one page-level header per page, preserving each page's current controls and handlers.

- [ ] **Step 1: Add a structural regression test**

在 `web/lib/pageHeader.dom.vitest.test.tsx` 增加源码契约测试，读取目标页面文本并断言迁移后的页面不再导入 `PageActions`，且 `partners` / `contacts` 不再使用页面级 `TableToolbar`。Projects 保留 `ListPageLayout`，但头部直接使用 `PageHeader`。

- [ ] **Step 2: Run the new contract test to verify it fails**

Run: `cd web && npx vitest run lib/pageHeader.dom.vitest.test.tsx`

Expected: FAIL because the three pages still contain the old page-head structure.

- [ ] **Step 3: Migrate page headers**

Projects: import `PageHeader`, remove `section.projects-control-section` and `MotionReveal` around the toolbar, pass the existing controls and create button to `filters`/`actions`, and provide it as `ListPageLayout.toolbar`.

Partners and Contacts: remove `PageActions`, pass existing action button to `actions`, and pass existing search/select/clear controls to `filters`; leave permissions and table rendering unchanged.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `cd web && npx vitest run lib/pageHeader.dom.vitest.test.tsx lib/tableToolbar.vitest.test.tsx && npx tsc --noEmit -p tsconfig.json`

Expected: PASS and no TypeScript errors.

- [ ] **Step 5: Commit**

```bash
git add 'web/app/(dashboard)/projects/page.tsx' 'web/app/(dashboard)/partners/page.tsx' 'web/app/(dashboard)/contacts/page.tsx' web/lib/pageHeader.dom.vitest.test.tsx
git commit -m "布局：统一项目友商通讯录页面头部"
```

### Task 3: 迁移 Progress 与 Costs

**Files:**
- Modify: `web/app/(dashboard)/progress/page.tsx`
- Modify: `web/app/(dashboard)/costs/page.tsx`

**Interfaces:**
- Consumes `PageHeader`。
- Keeps `ProjectPicker`, project probing, status URL state, dialogs, tables and pagination unchanged.

- [ ] **Step 1: Add failing DOM/source contract**

增加契约断言：两个页面引用 `PageHeader`，不再引用 `PageActions`，并且一级头部不再包含 `toolbar-card`。

- [ ] **Step 2: Run focused test and confirm red**

Run: `cd web && npx vitest run lib/pageHeader.dom.vitest.test.tsx`

Expected: FAIL on the old imports and `toolbar-card` references.

- [ ] **Step 3: Migrate controls**

Progress: project picker moves to `filters`; add-progress button moves to `actions`.

Costs: project picker and expense-status select move to `filters`; add-expense button moves to `actions`. Keep the status label and existing `history: "push"` behavior.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `cd web && npx vitest run lib/pageHeader.dom.vitest.test.tsx && npx tsc --noEmit -p tsconfig.json`

Expected: PASS and no TypeScript errors.

- [ ] **Step 5: Commit**

```bash
git add 'web/app/(dashboard)/progress/page.tsx' 'web/app/(dashboard)/costs/page.tsx' web/lib/pageHeader.dom.vitest.test.tsx
git commit -m "布局：合并进度与支出页面头部"
```

### Task 4: 迁移 Reports 并锁定项目选择器宽度

**Files:**
- Modify: `web/app/(dashboard)/reports/page.tsx`
- Modify: `web/components/ui/PageHeader.module.css`
- Modify: `web/lib/pageHeader.dom.vitest.test.tsx`

**Interfaces:**
- Consumes `PageHeader` and its className support.
- Produces `.reportsProjectFilter` scoped to Reports and no global ProjectPicker width regression.

- [ ] **Step 1: Add failing Reports contract**

增加源码契约断言：Reports 使用 `PageHeader`，项目选择器带 `reportsProjectFilter` class，CSS 包含 `min-width: 220px`、`max-width: min(34vw, 360px)` 和移动端宽度降级规则。

- [ ] **Step 2: Run focused test and confirm red**

Run: `cd web && npx vitest run lib/pageHeader.dom.vitest.test.tsx`

Expected: FAIL because Reports still has separate `PageActions` and `toolbar-card`, and no scoped width class.

- [ ] **Step 3: Migrate Reports**

Move project/dept/subject/month/clear controls into `filters`; move view buttons, print and export into `actions`; use `PageHeader title="支出报表" className="reports-header"`. Add the project picker wrapper class and use CSS Modules only for the Reports-specific sizing, preserving ProjectPicker behavior.

- [ ] **Step 4: Run focused test and typecheck**

Run: `cd web && npx vitest run lib/pageHeader.dom.vitest.test.tsx && npx tsc --noEmit -p tsconfig.json`

Expected: PASS and no TypeScript errors.

- [ ] **Step 5: Commit**

```bash
git add 'web/app/(dashboard)/reports/page.tsx' web/components/ui/PageHeader.module.css web/lib/pageHeader.dom.vitest.test.tsx
git commit -m "布局：统一支出报表页面头部"
```

### Task 5: 迁移 Dashboard 与 Approvals

**Files:**
- Modify: `web/app/(dashboard)/dashboard/page.tsx`
- Modify: `web/app/(dashboard)/approvals/page.tsx`

**Interfaces:**
- Consumes `PageHeader` without filters.
- Keeps dashboard links, approval refresh behavior, notices and data sections unchanged.

- [ ] **Step 1: Add failing no-empty-filter contract**

增加页面源码契约，要求 Dashboard 和 Approvals 使用 `PageHeader` 且不传 `filters`；运行 focused test 确认当前失败。

- [ ] **Step 2: Migrate headers**

Replace `PageActions` with `PageHeader`; pass the current action nodes to `actions`, preserving loading text and links.

- [ ] **Step 3: Run focused tests and typecheck**

Run: `cd web && npx vitest run lib/pageHeader.dom.vitest.test.tsx && npx tsc --noEmit -p tsconfig.json`

Expected: PASS and no TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add 'web/app/(dashboard)/dashboard/page.tsx' 'web/app/(dashboard)/approvals/page.tsx' web/lib/pageHeader.dom.vitest.test.tsx
git commit -m "布局：统一工作台与审批页面头部"
```

### Task 6: 迁移 Finance 与 Admin 一级头部

**Files:**
- Modify: `web/app/(dashboard)/finance/page.tsx`
- Modify: `web/app/(dashboard)/admin/page.tsx`

**Interfaces:**
- Consumes `PageHeader`。
- Keeps Finance internal `section-head` blocks and Admin tab behavior as existing business-level structures.

- [ ] **Step 1: Add failing source contract**

增加契约断言：Finance 和 Admin 引用 `PageHeader`；Finance 的账套选择不再位于一级 `toolbar-card`，Admin 的 tabs 不丢失。

- [ ] **Step 2: Migrate Finance**

Pass账套 selector to `filters`, current refresh/new-book/new-voucher controls to `actions`, and remove only the outer page-level `PageActions` and `toolbar-card`.

- [ ] **Step 3: Migrate Admin**

Replace `PageActions` with `PageHeader` while leaving `MotionTabs` as the content-level tab switcher and preserving existing `pageActions`.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `cd web && npx vitest run lib/pageHeader.dom.vitest.test.tsx && npx tsc --noEmit -p tsconfig.json`

Expected: PASS and no TypeScript errors.

- [ ] **Step 5: Commit**

```bash
git add 'web/app/(dashboard)/finance/page.tsx' 'web/app/(dashboard)/admin/page.tsx' web/lib/pageHeader.dom.vitest.test.tsx
git commit -m "布局：统一财务与系统管理页面头部"
```

### Task 7: Full verification and visual smoke test

**Files:**
- Verify all files changed in Tasks 1-6.

- [ ] **Step 1: Audit diff and source contracts**

Run `git diff --check`, `git diff --stat`, and search target pages for stale page-level `PageActions`/`toolbar-card` usage.

- [ ] **Step 2: Run frontend tests**

Run `cd web && npm test`.

- [ ] **Step 3: Run production build**

Run `cd web && npm run build`.

- [ ] **Step 4: Start dev server and inspect responsive layouts**

Run `cd web && npm run dev`, then inspect target pages at desktop wide, desktop narrow, and mobile widths. Verify Reports long project names remain readable and do not push right actions off-screen.

- [ ] **Step 5: Final diff audit**

Run `git status --short --branch` and `git diff HEAD~6 --stat` (or the equivalent range if commit count differs), then report only verified files and command results.
