# 功能更新 Changelog 页面 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 dashboard 用户账号菜单中增加「功能更新」入口，并实现一个默认展示 V2、可切换 V1/V2 的产品更新时间线页面。

**Architecture:** 新增 `web/lib/changelog.ts` 作为唯一静态内容来源，页面 `web/app/(dashboard)/changelog/page.tsx` 只负责版本状态与展示，样式放在同目录 CSS Module。现有 `UserMenu` 仅新增一个 `/changelog` 链接，复用已有账号菜单交互与样式。

**Tech Stack:** Next.js 14 App Router、React 18、TypeScript、CSS Modules、node:test、Vitest + Testing Library。

## Global Constraints

- 默认显示 V2；V1/V2 切换不改变 URL，也不发请求。
- 账号菜单顺序固定为「功能更新、修改密码、退出登录」。
- 不修改后端 API、权限菜单契约、数据库、移动 Dock 导航或既有账号菜单交互模型。
- 过滤过程性 git 提交，只展示手动归并后的用户可理解内容。
- ≤767px 使用单列时间线，版本切换区可横向滚动，不能引入页面级水平溢出。
- `prefers-reduced-motion: reduce` 下不依赖动画表达状态。
- 生产实现前必须先写并运行会失败的测试。

## File Map

- Create: `web/lib/changelog.ts` - V1/V2 的类型、静态数据和可测试的顺序。
- Create: `web/app/(dashboard)/changelog/page.tsx` - 功能更新页面和版本切换交互。
- Create: `web/app/(dashboard)/changelog/changelog.module.css` - 页面标题、分段按钮、时间线和移动端布局。
- Modify: `web/app/(dashboard)/layout.tsx` - 在现有用户菜单中插入 `/changelog` 入口。
- Modify: `web/lib/identityRender.dom.vitest.test.tsx` - 增加菜单顺序与入口行为回归测试。
- Create: `web/lib/changelog.test.ts` - 静态数据契约和默认排序测试。

### Task 1: Add failing tests for changelog data and menu behavior

**Files:**
- Create: `web/lib/changelog.test.ts`
- Modify: `web/lib/identityRender.dom.vitest.test.tsx`

**Interfaces:**
- Tests will consume `CHANGELOG_VERSIONS` from `web/lib/changelog.ts` once implemented.
- DOM tests will consume the real `DashboardShell` and assert the existing `UserMenu` order.

- [ ] **Step 1: Write the failing static data tests**

Add tests that import `CHANGELOG_VERSIONS` and assert:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CHANGELOG_VERSIONS } from "./changelog";

describe("changelog data", () => {
  it("contains V2 before V1 and each version has dated updates", () => {
    assert.deepEqual(CHANGELOG_VERSIONS.map((version) => version.id), ["v2", "v1"]);
    for (const version of CHANGELOG_VERSIONS) {
      assert.ok(version.title.length > 0);
      assert.ok(version.days.length > 0);
      assert.ok(version.days.every((day) => /^\\d{4}-\\d{2}-\\d{2}$/.test(day.date)));
      assert.ok(version.days.every((day, index) => index === 0 || day.date <= version.days[index - 1].date));
      assert.ok(version.days.every((day) => day.entries.length > 0));
    }
  });
});
```

- [ ] **Step 2: Run the data test and verify the expected failure**

Run `npm test -- --runInBand` is not the project runner; use the focused command:

```bash
cd web && npx tsc -p tsconfig.test.json && node --test .test-dist/lib/changelog.test.js
```

Expected: fail because `web/lib/changelog.ts` does not exist yet.

- [ ] **Step 3: Add the menu regression test**

Extend the existing account-menu describe block in `web/lib/identityRender.dom.vitest.test.tsx` with a test that opens the menu and asserts the menuitem order and href:

```ts
it("按功能更新、修改密码、退出登录顺序显示账号操作", async () => {
  renderShell();
  await waitForIdentity();
  fireEvent.mouseEnter(userMenuWrap());

  const items = within(screen.getByRole("menu")).getAllByRole("menuitem");
  expect(items.map((item) => item.textContent?.replace(/\\s+/g, "").trim())).toEqual([
    "功能更新",
    "修改密码",
    "退出登录",
  ]);
  expect(items[0].getAttribute("href")).toBe("/changelog");
});
```

Use the existing helpers and imports in that file rather than introducing a second render harness.

- [ ] **Step 4: Run the focused DOM test and verify the expected failure**

Run:

```bash
cd web && npx vitest run lib/identityRender.dom.vitest.test.tsx
```

Expected: the new test fails because the menu currently starts with 「修改密码」.

### Task 2: Implement the static changelog content

**Files:**
- Create: `web/lib/changelog.ts`

**Interfaces:**
- Produces `ChangelogKind`, `ChangelogEntry`, `ChangelogDay`, `ChangelogVersion` and `CHANGELOG_VERSIONS`.
- The page will rely on `CHANGELOG_VERSIONS[0]` being V2 and all date arrays being newest-first.

- [ ] **Step 1: Add typed content**

Create the type definitions and static data with user-facing entries grouped into:

- V2: finance, mobile PWA, contacts/partners, attachments, project experience, stability.
- V1: dashboard, project ledger, progress, approvals, costs/reports, account and permissions.

Use stable dates from the current git history, with entries on `2026-09-20`, `2026-09-19`, and `2026-09-18` for V2, and a concise `2026-09` entry for V1 if no earlier product date is available. Do not include commit hashes, agent snapshots, merge commits, or internal review wording.

- [ ] **Step 2: Run the focused data test and verify it passes**

Run:

```bash
cd web && npx tsc -p tsconfig.test.json && node --test .test-dist/lib/changelog.test.js
```

Expected: 1 passing test, 0 failures.

- [ ] **Step 3: Commit the data unit**

```bash
git add web/lib/changelog.ts web/lib/changelog.test.ts
git commit -m "feat: add changelog content model"
```

### Task 3: Implement the changelog page and responsive timeline

**Files:**
- Create: `web/app/(dashboard)/changelog/page.tsx`
- Create: `web/app/(dashboard)/changelog/changelog.module.css`

**Interfaces:**
- Consumes `CHANGELOG_VERSIONS` and the changelog types.
- Renders a client page with `role="tablist"`, two tab buttons, and one `role="tabpanel"`.

- [ ] **Step 1: Write page behavior tests before the page implementation**

Add a Vitest DOM test for the new page component that asserts:

```ts
it("默认展示 V2，并能切换到 V1", async () => {
  render(<ChangelogPage />);
  expect(screen.getByRole("tabpanel")).toHaveTextContent("V2 · 扩展能力");
  expect(screen.getByText("财务能力"), "V2 content is visible").toBeTruthy();
  expect(screen.getByRole("tab", { name: /V2/ })).toHaveAttribute("aria-selected", "true");

  fireEvent.click(screen.getByRole("tab", { name: /V1/ }));
  expect(screen.getByRole("tabpanel")).toHaveTextContent("V1 · 基础项目管理");
  expect(screen.getByText("工作台"), "V1 content is visible").toBeTruthy();
  expect(screen.getByRole("tab", { name: /V1/ })).toHaveAttribute("aria-selected", "true");
  expect(screen.getByRole("tab", { name: /V2/ })).toHaveAttribute("aria-selected", "false");
});
```

- [ ] **Step 2: Run the page test and verify it fails for the missing page**

Run `cd web && npx vitest run lib/changelogPage.dom.vitest.test.tsx`.

Expected: fail because the page module does not exist yet. If the test file is placed under another existing test file, run that focused path instead.

- [ ] **Step 3: Implement the page**

Use a small client component with `useState<ChangelogVersionId>("v2")`; render the title block, current version marker, tablist, summary, dates and entries. Use `aria-controls` and a stable panel id. Keep the content data out of JSX.

- [ ] **Step 4: Implement the CSS Module**

Use existing variables (`--ink`, `--ink-2`, `--brand`, `--line`, `--card`, `--row-hover`) with a restrained blue/green/amber/gray tag palette. Use a desktop grid for date / node / content, then at `@media (max-width: 767px)` convert the timeline to a single column with the date above each group and keep the tablist horizontally scrollable without widening the page.

- [ ] **Step 5: Run the focused page test and verify it passes**

Run `cd web && npx vitest run lib/changelogPage.dom.vitest.test.tsx`.

Expected: all page behavior assertions pass.

### Task 4: Add the account-menu entry and run full verification

**Files:**
- Modify: `web/app/(dashboard)/layout.tsx`
- Modify: `web/lib/identityRender.dom.vitest.test.tsx`

**Interfaces:**
- Existing `UserMenu` keeps all current focus, hover, tap, Esc and logout behavior.
- New menu item uses the existing `userMenuItem` class and calls `closeMenu` on navigation.

- [ ] **Step 1: Add the `/changelog` link above `/change-password`**

Insert a `Link` with `role="menuitem"`, an update/history icon, `href="/changelog"`, and visible text `功能更新` immediately before the existing password link.

- [ ] **Step 2: Run the focused menu test and verify it passes**

Run `cd web && npx vitest run lib/identityRender.dom.vitest.test.tsx`.

Expected: all account menu tests pass, including the new order assertion.

- [ ] **Step 3: Run the full frontend test suite**

Run:

```bash
cd web && npm test
```

Expected: `test:unit` and `test:motion` both exit 0 with no failed tests.

- [ ] **Step 4: Run the production build**

Run:

```bash
cd web && npm run build
```

Expected: Next.js build exits 0 and includes `/changelog` in the generated routes.

- [ ] **Step 5: Run browser verification**

Start the dev server with `cd web && npm run dev`, use the existing browser verification skill/tooling to check:

- dashboard account hover menu order and `/changelog` navigation;
- default V2 content and V1/V2 switching;
- desktop and ≤767px layout with no horizontal overflow;
- no new browser console errors.

- [ ] **Step 6: Inspect the final diff and commit**

Run `git diff --check`, `git status --short`, and `git diff --stat`, then commit only the changelog implementation and its tests:

```bash
git add web/app/(dashboard)/changelog web/app/(dashboard)/layout.tsx web/lib/changelog.ts web/lib/changelog.test.ts web/lib/changelogPage.dom.vitest.test.tsx web/lib/identityRender.dom.vitest.test.tsx
git commit -m "feat: add changelog page"
```
