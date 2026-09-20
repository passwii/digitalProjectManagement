# 可复用列表页与表格布局 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为列表页建立可复用的布局与桌面表格外壳，并先将项目台账迁移到“正常桌面视口底部对齐、矮视口自然流、移动端卡片流”的统一结构。

**Architecture:** 新增 `ListPageLayout`、`ListViewport` 和 `DesktopTableFrame` 三个轻量 UI 组件。页面继续负责数据、状态、表格列和卡片内容；`ListViewport` 只负责 table/card 内容与分页的垂直弹性轨道，使用 `margin-top: auto` 对齐分页，不使用 fixed/sticky。项目台账作为首个消费者，后续页面可逐步迁移。

**Tech Stack:** Next.js 14 App Router、React 18、TypeScript、CSS Modules、全局 `table.grid` 规范、Vitest、Testing Library。

## Global Constraints

- 不改变 `Pagination` 的数据接口、URL 分页行为、页码收敛逻辑和每页条数选项。
- 不使用 `position: fixed` 或 `position: sticky` 固定分页。
- 桌面正常视口启用弹性底部对齐；`@media (max-height: 720px) and (min-width: 768px)` 下恢复自然流。
- `max-width: 767px` 继续使用现有 `CardList`，不显示桌面表格，不引入桌面弹性空白。
- 具体 `<table>`、复杂单元格、行操作、权限逻辑和移动端卡片内容继续由业务页面拥有。
- 编辑前必须先写一个能证明新行为的失败测试，并运行确认失败；实现后运行同一测试确认通过。
- 使用 ASCII 编辑新增代码和文档标点，遵循当前项目既有中文文案与格式。
- 不修改无关页面，不做 column-driven 通用 DataTable，不顺手重构 API 或分页状态管理。

## 文件地图

### 将创建

- `web/components/ui/ListPageLayout.tsx`：页面级布局、列表弹性轨道和桌面表格外壳的 React 结构。
- `web/components/ui/ListPageLayout.module.css`：布局高度、分页 footer、矮视口、移动端和打印规则。
- `web/lib/listPageLayout.dom.vitest.test.tsx`：组件 DOM 契约和结构测试。

### 将修改

- `web/app/(dashboard)/projects/page.tsx`：用新布局包装当前项目台账工具栏、表格/卡片主体和分页，保持所有数据与交互代码不变。
- `web/components/ui/CardList.tsx`：让既有 `DesktopTable` 委托或兼容新的 `DesktopTableFrame`，避免同一套桌面外壳出现两个长期名称。
- `web/components/ui/CardList.module.css`：只在确认需要时保留现有移动/打印规则；桌面外壳新规则集中到 `ListPageLayout.module.css`。
- `web/lib/cardList.dom.vitest.test.tsx`：更新桌面外壳测试，确保传入 table 原样渲染并与新组件 API 兼容。

### 设计文档

- `docs/superpowers/specs/2026-09-20-reusable-table-list-layout-design.md`：已确认的设计、组件边界、CSS 策略和验收标准。

### 不修改

- `web/components/ui/Pagination.tsx` 与 `Pagination.module.css`：分页行为和控件本身不属于本次布局抽象。
- `web/app/globals.css`：现有 `table.grid`、`.table-scroll` 和项目列宽规范继续作为底层视觉基础。
- 其他业务页：只在后续迁移任务中使用新组件，不在本次改变其布局。

## Task 1: 建立列表布局组件的失败测试

**Files:**
- Create: `web/lib/listPageLayout.dom.vitest.test.tsx`

**Interfaces:**
- Consumes: 尚未实现的 `ListPageLayout`, `ListViewport`, `DesktopTableFrame`。
- Produces: 组件 DOM 契约，供 Task 2 实现和 Task 4 迁移使用。

- [ ] **Step 1: Write the failing test**

在新测试文件中加入以下测试骨架，覆盖页面级容器、分页 footer 和桌面表格原样渲染：

```tsx
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import React from "react";
import {
  DesktopTableFrame,
  ListPageLayout,
  ListViewport,
} from "../components/ui/ListPageLayout";

afterEach(() => cleanup());

describe("ListPageLayout", () => {
  it("保留工具栏、提示和主体的列表页结构", () => {
    render(
      <ListPageLayout
        toolbar={<div data-testid="toolbar">筛选</div>}
        notice={<div data-testid="notice">演示数据</div>}
      >
        <div data-testid="body">列表主体</div>
      </ListPageLayout>,
    );

    expect(document.querySelector('[data-list-page="true"]')).not.toBeNull();
    expect(document.querySelector('[data-list-toolbar="true"]')).not.toBeNull();
    expect(document.querySelector('[data-list-notice="true"]')).not.toBeNull();
    expect(document.querySelector('[data-list-content="true"]')).not.toBeNull();
  });

  it("把分页放在列表轨道 footer，主体和分页同属一个 viewport", () => {
    render(
      <ListViewport
        pagination={<nav data-testid="pagination">分页</nav>}
      >
        <div data-testid="body">表格</div>
      </ListViewport>,
    );

    const viewport = document.querySelector('[data-list-viewport="true"]');
    expect(viewport?.querySelector('[data-list-body="true"]')).not.toBeNull();
    expect(viewport?.querySelector('[data-list-pagination="true"]')).not.toBeNull();
    expect(viewport?.querySelector('[data-list-body="true"] + [data-list-pagination="true"]')).not.toBeNull();
  });

  it("桌面表格外壳不改写传入 table", () => {
    render(
      <DesktopTableFrame className="project-table-frame">
        <table className="grid"><tbody><tr><td>行</td></tr></tbody></table>
      </DesktopTableFrame>,
    );

    const table = document.querySelector("table.grid");
    expect(table?.querySelector("td")?.textContent).toBe("行");
    expect(document.querySelector(".project-table-frame")).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run lib/listPageLayout.dom.vitest.test.tsx`

Expected: FAIL because `../components/ui/ListPageLayout` does not exist yet. If the test fails for JSX or environment setup instead, fix only the test setup and rerun until the failure is specifically the missing component.

- [ ] **Step 3: Commit the red test**

```bash
git add web/lib/listPageLayout.dom.vitest.test.tsx
git commit -m "test: define reusable list layout contract"
```

## Task 2: 实现列表布局、弹性轨道和桌面表格外壳

**Files:**
- Create: `web/components/ui/ListPageLayout.tsx`
- Create: `web/components/ui/ListPageLayout.module.css`

**Interfaces:**
- Consumes: Task 1 的 DOM 契约。
- Produces: `ListPageLayout`, `ListViewport`, `DesktopTableFrame` 三个可复用组件。

- [ ] **Step 1: Write the minimal implementation**

创建 `ListPageLayout.tsx`，使用以下接口和结构。组件不持有分页状态，不判断加载/空态，也不依赖项目类型：

```tsx
"use client";

import type { ReactNode } from "react";
import s from "./ListPageLayout.module.css";

export function ListPageLayout({
  toolbar,
  notice,
  children,
}: {
  toolbar: ReactNode;
  notice?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={s.page} data-list-page="true">
      <div className={s.toolbar} data-list-toolbar="true">{toolbar}</div>
      {notice && <div className={s.notice} data-list-notice="true">{notice}</div>}
      <div className={s.content} data-list-content="true">{children}</div>
    </div>
  );
}

export function ListViewport({
  children,
  pagination,
  className,
}: {
  children: ReactNode;
  pagination?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`${s.viewport}${className ? ` ${className}` : ""}`}
      data-list-viewport="true"
    >
      <div className={s.body} data-list-body="true">{children}</div>
      {pagination && (
        <div className={s.pagination} data-list-pagination="true">
          {pagination}
        </div>
      )}
    </div>
  );
}

export function DesktopTableFrame({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`${s.tableFrame}${className ? ` ${className}` : ""}`}
      data-desktop-table-frame="true"
    >
      {children}
    </div>
  );
}
```

创建 `ListPageLayout.module.css`，集中实现布局策略。桌面正常高度让列表页占满内容区的最小高度；`ListViewport` 伸展，分页 footer 自动落到底部；矮桌面和移动端关闭弹性高度；打印时关闭弹性空白：

```css
.page {
  min-width: 0;
  min-height: calc(100dvh - 140px);
  display: flex;
  flex-direction: column;
}

.toolbar,
.notice,
.content { min-width: 0; }
.notice { margin-top: 12px; }
.content {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.viewport {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.body { min-width: 0; }
.pagination {
  margin-top: auto;
  padding-top: 18px;
}

.tableFrame {
  width: 100%;
  min-width: 0;
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
}

@media (max-height: 720px) and (min-width: 768px) {
  .page { min-height: 0; }
  .content,
  .viewport { flex: none; }
  .pagination { margin-top: 0; }
}

@media (max-width: 767px) {
  .page { min-height: 0; }
  .content,
  .viewport { flex: none; }
  .pagination { margin-top: 0; padding-top: 0; }
  .tableFrame { display: none; }
}

@media print {
  .page,
  .content,
  .viewport { min-height: 0; display: block; }
  .pagination { display: none; }
  .tableFrame { display: block; overflow: visible; }
}
```

实现时将 `100dvh - 140px` 拆成当前 Shell 桌面顶栏和内容上下 padding 的明确注释；如果通过现有 CSS 变量更清晰，则在 `Shell.module.css` 增加同名尺寸变量并在该模块引用，不能用 JS 读取 viewport。

- [ ] **Step 2: Run the focused test to verify it passes**

Run: `cd web && npx vitest run lib/listPageLayout.dom.vitest.test.tsx`

Expected: PASS with all three component tests green.

- [ ] **Step 3: Commit the component**

```bash
git add web/components/ui/ListPageLayout.tsx web/components/ui/ListPageLayout.module.css
git commit -m "feat: add reusable list page layout"
```

## Task 3: 兼容现有 `DesktopTable` 并补回归测试

**Files:**
- Modify: `web/components/ui/CardList.tsx`
- Modify: `web/lib/cardList.dom.vitest.test.tsx`

**Interfaces:**
- Consumes: Task 2 的 `DesktopTableFrame`。
- Produces: 现有调用方继续可用的 `DesktopTable`，以及新外壳的回归覆盖。

- [ ] **Step 1: Write the failing regression test**

在 `cardList.dom.vitest.test.tsx` 增加：

```tsx
it("DesktopTableFrame 与 DesktopTable 都保留 table-scroll 语义", () => {
  render(
    <>
      <DesktopTable><table className="grid"><tbody><tr><td>旧</td></tr></tbody></table></DesktopTable>
      <DesktopTableFrame><table className="grid"><tbody><tr><td>新</td></tr></tbody></table></DesktopTableFrame>
    </>,
  );

  expect(document.querySelectorAll("table.grid")).toHaveLength(2);
  expect(document.querySelectorAll(".table-scroll")).toHaveLength(2);
  expect(document.body.textContent).toContain("旧");
  expect(document.body.textContent).toContain("新");
});
```

为此从 `ListPageLayout` 导入 `DesktopTableFrame`。如果新组件当前不保留 `.table-scroll` 兼容类，测试应先失败，说明兼容边界尚未实现。

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run lib/cardList.dom.vitest.test.tsx -t "DesktopTableFrame"`

Expected: FAIL because the new frame does not yet expose the existing `.table-scroll` compatibility class.

- [ ] **Step 3: Implement compatibility**

在 `DesktopTableFrame` 的 className 中加入 `table-scroll`，并让 `DesktopTable` 复用它：

```tsx
export function DesktopTable({ children }: { children: ReactNode }) {
  return <DesktopTableFrame className={s.desktopOnly}>{children}</DesktopTableFrame>;
}
```

`DesktopTableFrame` 的最终外层 class 应同时包含 `table-scroll`、模块 CSS 的 frame class 和调用方传入的 class。这样旧页面获得新的桌面表格组件，而不改变它们的 DOM 内容或 CSS 选择器。

- [ ] **Step 4: Run focused tests**

Run: `cd web && npx vitest run lib/cardList.dom.vitest.test.tsx lib/listPageLayout.dom.vitest.test.tsx`

Expected: PASS，现有 CardList 测试和新布局测试全部通过。

- [ ] **Step 5: Commit compatibility**

```bash
git add web/components/ui/CardList.tsx web/lib/cardList.dom.vitest.test.tsx
git commit -m "refactor: share desktop table frame"
```

## Task 4: 迁移项目台账到新列表布局

**Files:**
- Modify: `web/app/(dashboard)/projects/page.tsx`

**Interfaces:**
- Consumes: Task 2 的 `ListPageLayout`, `ListViewport`, `DesktopTableFrame`；Task 3 的兼容 `DesktopTable`。
- Produces: 项目台账的稳定分页位置和未来页面可复制的接线范例。

- [ ] **Step 1: Write the failing integration contract**

在 `web/lib/listPageLayout.dom.vitest.test.tsx` 增加一个接近项目台账的组合测试：工具栏、卡片列表、桌面表格和分页必须位于同一 `ListViewport`，分页不应成为 viewport 外的兄弟节点：

```tsx
it("列表页面把响应式主体和分页接入同一轨道", () => {
  render(
    <ListPageLayout toolbar={<div>工具栏</div>}>
      <ListViewport pagination={<nav>分页</nav>}>
        <div data-cardlist="项目台账">卡片</div>
        <DesktopTableFrame><table className="grid"><tbody><tr><td>表格</td></tr></tbody></table></DesktopTableFrame>
      </ListViewport>
    </ListPageLayout>,
  );

  const viewport = document.querySelector('[data-list-viewport="true"]');
  expect(viewport?.querySelector('[data-cardlist="项目台账"]')).not.toBeNull();
  expect(viewport?.querySelector("table.grid")).not.toBeNull();
  expect(viewport?.querySelector('[data-list-pagination="true"]')).not.toBeNull();
  expect(document.querySelector('[data-list-content="true"] > [data-list-viewport="true"]')).not.toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails against the current project page contract**

Run: `cd web && npx vitest run lib/listPageLayout.dom.vitest.test.tsx -t "响应式主体和分页"`

Expected: FAIL until the page uses the new composition. Do not change the assertion to match the old structure.

- [ ] **Step 3: Update project page imports and outer structure**

在 `projects/page.tsx` 中新增：

```tsx
import {
  DesktopTableFrame,
  ListPageLayout,
  ListViewport,
} from "@/components/ui/ListPageLayout";
```

将现有操作筛选 section 作为 `toolbar` 传给 `ListPageLayout`，将 `demoOn` 的 `warn-banner` 作为 `notice` 传入。保留错误、加载和空态在布局下方的业务判断，但将有数据分支改为：

```tsx
<ListViewport
  pagination={
    <Pagination
      page={page}
      size={size}
      total={total}
      loading={loading}
      sizeOptions={SIZE_OPTIONS}
      scopeText={scopeText}
      ariaLabel="项目台账分页"
      onChange={(next) =>
        setUrl(
          { page: String(next.page), size: String(next.size) },
          { history: next.page === page ? "replace" : "push" },
        )
      }
    />
  }
>
  <CardList label="项目台账">{/* 保留现有 CardItem map */}</CardList>
  <DesktopTableFrame>
    <table className="grid project-table">{/* 保留现有 table */}</table>
  </DesktopTableFrame>
</ListViewport>
```

不要改动项目列表请求、过滤器、URL、行点击、编辑按钮、权限判断、弹窗和抽屉逻辑。为了减少迁移风险，`DesktopTable` 可以先继续使用兼容组件；如果直接换成 `DesktopTableFrame`，必须保留 `desktopOnly` class 的移动端退场语义。

- [ ] **Step 4: Run focused tests and typecheck**

Run: `cd web && npx vitest run lib/listPageLayout.dom.vitest.test.tsx lib/cardList.dom.vitest.test.tsx && npx tsc -p tsconfig.test.json`

Expected: PASS with no TypeScript errors. If type errors mention `ReactNode` or CSS module names, fix the component types/imports rather than loosening TypeScript strictness.

- [ ] **Step 5: Commit project migration**

```bash
git add 'web/app/(dashboard)/projects/page.tsx' web/lib/listPageLayout.dom.vitest.test.tsx
git commit -m "feat: align project list pagination to viewport"
```

## Task 5: 完整验证视觉规则和现有回归

**Files:**
- Modify: `web/lib/listPageLayout.dom.vitest.test.tsx` only if a discovered CSS contract needs a stable assertion.

**Interfaces:**
- Consumes: Tasks 1-4 的组件和项目台账迁移。
- Produces: 可交付的测试证据和浏览器验收结果。

- [ ] **Step 1: Run all frontend tests**

Run: `cd web && npm test`

Expected: `test:unit` and `test:motion` both pass with no failures.

- [ ] **Step 2: Run the production build**

Run: `cd web && npm run build`

Expected: Next.js build completes successfully without TypeScript, CSS module, or route errors.

- [ ] **Step 3: Start the dev server**

Run: `cd web && npm run dev`

Expected: server listens on `http://localhost:3001`. If that port is occupied, use the repository's existing alternate-port convention and record the actual URL in the final report.

- [ ] **Step 4: Verify the project page at normal desktop height**

Use the browser verification tool against `/projects` with a desktop viewport such as `1440x900`. Confirm:

- toolbar and table load without horizontal page overflow;
- first page with 15 rows has pagination at the bottom of the list content area;
- changing to the final page with fewer than 15 rows keeps pagination in the same bottom region;
- clicking a row still opens the detail drawer and clicking 编辑 does not open the drawer.

- [ ] **Step 5: Verify short desktop and mobile degradation**

Use viewports `1440x650` and `390x844`. Confirm:

- at `1440x650`, the page is naturally scrollable and pagination is fully reachable below the table;
- at `390x844`, cards show, the desktop table is absent, there is no large elastic blank area, and pagination remains usable above the mobile dock safe area.

- [ ] **Step 6: Inspect the final diff**

Run: `git diff HEAD~4..HEAD --stat && git status --short`

Expected: only the planned layout components, project page migration, focused tests, and documentation commits are present; no unrelated files are modified and no dev server process is left running.

## Execution Notes

After this plan is approved, execute tasks in order. Each task ends with a focused test and commit. Do not migrate other list pages during this cycle; use the project page implementation as the reference integration for future pages.
