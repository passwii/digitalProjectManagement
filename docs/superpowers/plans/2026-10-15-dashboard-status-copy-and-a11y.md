# 工作台状态文案直白化与键盘可达性修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把工作台首页的系统状态文案从科幻隐喻改成直白中文，并补上项目台账表格行与自绘 Select 弹层的键盘/可访问性缺口。

**Architecture:** 三处彼此独立的定点修改：(1) `dashboard/page.tsx` 的状态字符串替换与对应测试断言更新；(2) `Select.tsx` 的 listbox 改用 `aria-labelledby` 关联触发器，使包裹式 `<label>` 写法下弹层也有可访问名；(3) `ProjectsListContent.tsx` 操作列新增「查看」按钮，让键盘用户获得与整行点击等价的详情入口。不改样式、不改接口、不动其他页面。

**Tech Stack:** Next.js 14 App Router、React 18、TypeScript、CSS Modules；测试用 Vitest + jsdom + @testing-library/react（DOM 测试）与 tsc + node:test（单测）；`dom-accessibility-api` 已在依赖树中，可用于可访问名断言。

## Global Constraints

- 不改变工作台视觉样式、颜色、排版与动效。
- 不重命名首页标题「交付坐标盘」及分区名称「当前工作态势 / 项目航迹 / 需要介入 / 数据脉冲」。
- 不修改除项目列表外的其余 6 处点击行。
- 不引入第三方组件库；不改变接口、权限语义、字段名称。
- 所有命令在 `web/` 目录下执行（`web/package.json` 是唯一 package.json）。
- 提交信息使用中文 Conventional Commits 风格，与本仓库既有提交一致。
- 每个任务结束时 `npm run test` 与 `npm run lint` 不得比改动前更差。

---

## 文件结构

| 文件 | 责任 | 本计划动作 |
| --- | --- | --- |
| `web/app/(dashboard)/dashboard/page.tsx` | 工作台首页；承载加载/刷新/错误状态文案 | 替换 6 处状态字符串 |
| `web/components/dashboard/DashboardRouteField.tsx` | 项目航迹列表；空状态提示 | 替换 1 处空状态提示 |
| `web/lib/dashboardPage.dom.vitest.test.tsx` | 首页 DOM 行为测试 | 更新 4 处断言 |
| `web/components/ui/Select.tsx` | 全站自绘下拉；触发器与弹层 | 弹层改用 `aria-labelledby` |
| `web/lib/selectA11y.dom.vitest.test.tsx` | Select 可访问名测试（新建） | 新增 |
| `web/app/(dashboard)/projects/ProjectsListContent.tsx` | 项目台账列表；表格与移动卡片 | 操作列新增「查看」按钮 |
| `web/lib/projectsListKeyboard.dom.vitest.test.tsx` | 项目列表键盘入口测试（新建） | 新增 |

---

### Task 1: 工作台首页状态文案直白化

**Files:**
- Modify: `web/app/(dashboard)/dashboard/page.tsx:167,174,176,183,202,214`
- Modify: `web/components/dashboard/DashboardRouteField.tsx:29`
- Test: `web/lib/dashboardPage.dom.vitest.test.tsx:208,213,219,229,233`

**Interfaces:**
- Consumes: 无
- Produces: 无（纯文案变更，不改变组件签名、props 或导出）

- [ ] **Step 1: 更新测试断言，使其表达新文案**

先把测试改成期望值，让它失败。修改 `web/lib/dashboardPage.dom.vitest.test.tsx` 中三处：

第 208 行、213 行、219 行：

```tsx
    const refresh = await screen.findByRole("button", { name: "刷新数据" });
    const page = document.querySelector('[data-dashboard-page="true"]');
    expect(page?.getAttribute("aria-busy")).toBe("false");

    fireEvent.click(refresh);
    const refreshing = screen.getByRole("button", { name: "刷新中" });
    expect(refreshing.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("我的项目")).not.toBeNull();
    expect(page?.getAttribute("aria-busy")).toBe("true");

    await act(async () => resolveRefresh(summary({ my_projects: 7 })));
    await waitFor(() => expect(screen.getByRole("button", { name: "刷新数据" }).hasAttribute("disabled")).toBe(false));
```

第 229 与 233 行：

```tsx
    const refresh = await screen.findByRole("button", { name: "刷新数据" });

    fireEvent.click(refresh);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("数据刷新失败，以下为上次成功数据。服务暂不可用");
    expect(screen.getByText("我的项目")).not.toBeNull();
    expect(screen.getByRole("button", { name: "重试" })).not.toBeNull();
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd web && npx vitest run lib/dashboardPage.dom.vitest.test.tsx`
Expected: FAIL —— 找不到名为「刷新数据」的按钮（`Unable to find role="button" and name "刷新数据"`）。

- [ ] **Step 3: 修改首页状态文案**

在 `web/app/(dashboard)/dashboard/page.tsx` 中按顺序替换 6 处字符串：

第 167 行：

```tsx
          <LoadingBlock title={false} kpis={4} label="正在加载工作台数据…" />
```

第 174 与 176 行：

```tsx
        <strong>暂时无法加载工作台数据</strong>
        <span>{err || "暂时无法获取工作台数据。"}</span>
        <button className={s.headerButton} type="button" onClick={() => void load()}>重新加载</button>
```

第 183 行：

```tsx
  const actionState = loading ? "刷新中" : err ? "需注意" : "已更新";
```

第 202 行：

```tsx
              {loading ? "刷新中" : "刷新数据"}
```

第 214 行：

```tsx
          <span><b>数据刷新失败，以下为上次成功数据。</b> {err}</span>
```

注意：`title="交付坐标盘"`（第 190 行）与分区标题「当前工作态势 / 项目航迹 / 需要介入 / 数据脉冲」保持不变。

- [ ] **Step 4: 修改项目航迹空状态提示**

`web/components/dashboard/DashboardRouteField.tsx:29`：

```tsx
        <Empty title="暂无项目航迹" hint="新建项目后，交付状态会显示在这里。" />
```

- [ ] **Step 5: 运行测试，确认通过**

Run: `cd web && npx vitest run lib/dashboardPage.dom.vitest.test.tsx`
Expected: PASS（该文件全部用例通过）。

- [ ] **Step 6: 确认没有遗留隐喻文案**

Run: `cd web && grep -rn "坐标\|校准\|接入\|链路未完成" app/\(dashboard\)/dashboard components/dashboard`
Expected: 只剩第 190 行的 `title="交付坐标盘"` 与 `DashboardRouteField` 中的「项目航迹」相关命名；不应再有「校准中 / 刷新坐标 / 重新接入 / 链路未完成校准 / 建立坐标」。

- [ ] **Step 7: 提交**

```bash
cd web && git add "app/(dashboard)/dashboard/page.tsx" components/dashboard/DashboardRouteField.tsx lib/dashboardPage.dom.vitest.test.tsx
git commit -m "文案(工作台): 状态与操作改为直白中文，保留分区命名"
```

---

### Task 2: 自绘 Select 弹层可访问名

**Files:**
- Modify: `web/components/ui/Select.tsx:92,324-326`
- Test: `web/lib/selectA11y.dom.vitest.test.tsx`（新建）

**Interfaces:**
- Consumes: 无
- Produces: 无新增导出；`Select` 的公开 props（`value` / `defaultValue` / `onChange` / `name` / `required` / `disabled` / `aria-label` / `title` / `className` / `surface` / `children`）保持不变。

**背景（实现者必读）：** 触发器现在有两种命名来源——显式 `aria-label`，或外层 `<label>` 包裹。`listbox` 目前写 `aria-label={ariaLabel}`，包裹式写法下 `ariaLabel` 为空，弹层没有可访问名。因为 `Select` 已经用 `useId()` 生成 `id`，可以直接让 `listbox` 通过 `aria-labelledby` 指向触发器：浏览器会把触发器的可访问名（无论来自 `aria-label` 还是包裹 `<label>`）作为弹层名字。已验证：包裹式与显式 `aria-label` 两种写法都能得到正确名字。

- [ ] **Step 1: 写失败的测试**

新建 `web/lib/selectA11y.dom.vitest.test.tsx`：

```tsx
// @vitest-environment jsdom
/**
 * 自绘 Select 的可访问名契约。
 *
 * 触发器（button[role=combobox]）的名字有两种来源：
 *   · 显式 aria-label；
 *   · 外层 <label> / <Field>（内部也是 <label>）包裹 —— 全库多数调用点是这种。
 * 展开后的 listbox 必须同样有可访问名，否则读屏用户在弹层里失去上下文。
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { computeAccessibleName } from "dom-accessibility-api";

import Select from "../components/ui/Select";
import Field from "../components/ui/Field";

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

describe("自绘 Select 的可访问名", () => {
  it("Field 包裹时，触发器与展开的 listbox 都有可访问名", () => {
    render(
      <Field label="项目负责人">
        <Select defaultValue="u1">
          <option value="u1">张伟</option>
          <option value="u2">李娜</option>
        </Select>
      </Field>,
    );

    const trigger = screen.getByRole("combobox");
    expect(computeAccessibleName(trigger)).toContain("项目负责人");

    fireEvent.click(trigger);
    const listbox = screen.getByRole("listbox");
    expect(computeAccessibleName(listbox)).toContain("项目负责人");
  });

  it("显式 aria-label 时，listbox 沿用同一个名字", () => {
    render(
      <Select aria-label="选择入库批次" defaultValue="b1">
        <option value="b1">批次一</option>
      </Select>,
    );

    fireEvent.click(screen.getByRole("combobox"));
    expect(computeAccessibleName(screen.getByRole("listbox"))).toContain("选择入库批次");
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd web && npx vitest run lib/selectA11y.dom.vitest.test.tsx`
Expected: FAIL —— 第二个用例应为 `expected '' to contain '选择入库批次'`（`aria-label` 写法在本改动前已通过，若第一个用例先失败也属预期：包裹式写法的 listbox 名为空）。

如果两个用例都通过，说明实现已存在，跳过 Step 3。

- [ ] **Step 3: 让 listbox 用 aria-labelledby 指向触发器**

在 `web/components/ui/Select.tsx` 第 92 行附近新增触发器 id：

```tsx
  const id = useId().replace(/:/g, "");
  const listId = `select-list-${id}`;
  const triggerId = `select-trigger-${id}`;
```

在第 281 行的触发器上补 `id`（`ref={triggerRef}` 之后）：

```tsx
        ref={triggerRef}
        id={triggerId}
```

第 324-326 行的弹层改为（删除 `aria-label={ariaLabel}`，改用 `aria-labelledby`）：

```tsx
          id={listId}
          role="listbox"
          aria-labelledby={triggerId}
```

保留第 288 行触发器上的 `aria-label={ariaLabel}` 不变——显式标签仍由它提供名字，`aria-labelledby` 指向触发器后两种写法都能生效。

- [ ] **Step 4: 运行测试，确认通过**

Run: `cd web && npx vitest run lib/selectA11y.dom.vitest.test.tsx`
Expected: PASS（两个用例都通过）。

- [ ] **Step 5: 运行既有下拉相关测试，确认没有被破坏**

Run: `cd web && npx vitest run lib/motionTabs.dom.vitest.test.tsx lib/pagination.dom.vitest.test.tsx lib/assetsPage.dom.vitest.test.tsx lib/financeProjectExpense.dom.vitest.test.tsx`
Expected: PASS。注意 `lib/testing/selectDriver.ts` 用「最后一个 listbox」定位，不依赖名字，因此不受影响。

- [ ] **Step 6: 提交**

```bash
cd web && git add components/ui/Select.tsx lib/selectA11y.dom.vitest.test.tsx
git commit -m "无障碍(下拉): 弹层改用 aria-labelledby 关联触发器，包裹式标签下也有可访问名"
```

---

### Task 3: 项目台账表格行键盘入口

**Files:**
- Modify: `web/app/(dashboard)/projects/ProjectsListContent.tsx:234-252`（表格操作列）
- Test: `web/lib/projectsListKeyboard.dom.vitest.test.tsx`（新建）

**Interfaces:**
- Consumes: `ProjectsListContentProps.onSelect?: (project: Project) => void`（已存在，与整行点击同一回调）
- Produces: 桌面表格每行新增一个可聚焦按钮 `查看`；无新增 props、无新增导出。

**背景（实现者必读）：** 桌面表格行是 `<tr className="clickable-row" onClick=...>`，`<tr>` 无法通过键盘访问。方案不是给 `<tr>` 加 `tabIndex`（键盘用户要逐行 Tab 扫过表格，且会破坏表格读屏语义），而是在操作列提供一个真实按钮，与「编辑 / 删除」同规格，调用同一回调。移动端卡片已有可聚焦标题按钮（`CardList.tsx:84`），本轮不动。

- [ ] **Step 1: 写失败的测试**

新建 `web/lib/projectsListKeyboard.dom.vitest.test.tsx`：

```tsx
// @vitest-environment jsdom
/**
 * 项目台账桌面表格的键盘入口。
 *
 * 表格行整行点击进详情是为鼠标设计的；<tr> 不可聚焦，键盘用户没有等价入口。
 * 本测试锁定：操作列存在「查看」按钮，且触发与整行点击相同的 onSelect 回调。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { ProjectsListContent } from "../app/(dashboard)/projects/ProjectsListContent";
import type { Project } from "../lib/api";

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

const PROJECT: Project = {
  id: 7,
  code: "PJ-2026-0007",
  name: "河西数据中心",
  type: "",
  dept_id: null,
  owner_id: 1,
  owner_name: "张伟",
  member_ids: [1],
  plan_start: null,
  plan_end: null,
  budget_total: 1200000,
  priority: "中",
  client: "河西集团",
  client_contact: "",
  client_phone: "",
  description: "",
  contract_status: "",
  status: "doing",
  progress: 0,
};

function renderList(onSelect = vi.fn()) {
  render(
    <ProjectsListContent
      items={[PROJECT]}
      page={1}
      size={15}
      total={1}
      loading={false}
      scopeText=""
      onPageChange={() => {}}
      onSelect={onSelect}
    />,
  );
  return onSelect;
}

describe("项目台账表格行的键盘入口", () => {
  it("桌面表格每行提供可聚焦的「查看」按钮并打开同一详情", () => {
    const onSelect = renderList();
    const view = screen.getAllByRole("button", { name: "查看" });
    expect(view.length).toBeGreaterThanOrEqual(1);

    view[0].focus();
    expect(document.activeElement).toBe(view[0]);

    fireEvent.click(view[0]);
    expect(onSelect).toHaveBeenCalledWith(PROJECT);
  });

  it("「查看」按钮的点击不冒泡到整行，避免重复触发", () => {
    const onSelect = renderList();
    fireEvent.click(screen.getAllByRole("button", { name: "查看" })[0]);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd web && npx vitest run lib/projectsListKeyboard.dom.vitest.test.tsx`
Expected: FAIL —— `Unable to find role="button" and name "查看"`。

- [ ] **Step 3: 在操作列新增「查看」按钮**

在 `web/app/(dashboard)/projects/ProjectsListContent.tsx` 的表格操作列，把 `table-actions` 内的按钮顺序改为「查看 → 编辑 → 删除」，在「编辑」之前插入：

```tsx
                    <span className="table-actions">
                      <button
                        className="btn-ghost btn-xs"
                        onClick={(e) => {
                          e.stopPropagation();
                          onSelect?.(p);
                        }}
                      >
                        查看
                      </button>
                      <button
                        className="btn-ghost btn-xs"
                        onClick={(e) => {
                          e.stopPropagation();
                          onEdit?.(p);
                        }}
                      >
                        编辑
                      </button>
```

「删除」按钮及其 `canDelete` 条件保持不变。整行 `onClick={() => onSelect?.(p)}`、`title="点击查看详情"` 与 `clickable-row` 类名保持不变。

- [ ] **Step 4: 运行测试，确认通过**

Run: `cd web && npx vitest run lib/projectsListKeyboard.dom.vitest.test.tsx lib/projectsDeleteFlow.dom.vitest.test.tsx lib/listPageLayout.dom.vitest.test.tsx`
Expected: PASS。若 `projectsDeleteFlow` 或 `listPageLayout` 中按 `getAllByRole("button", ...)` 计数「编辑」的断言变红，说明新增按钮改变了序号假设，需在那些断言里改为按名字定位而不是按 index。

- [ ] **Step 5: 运行完整测试与 lint**

Run: `cd web && npm run test && npm run lint`
Expected: 全部通过；lint 无新增 error（既有 warning 不因本改动增加）。

- [ ] **Step 6: 提交**

```bash
cd web && git add "app/(dashboard)/projects/ProjectsListContent.tsx" lib/projectsListKeyboard.dom.vitest.test.tsx
git commit -m "无障碍(项目台账): 表格行操作列补充可键盘聚焦的查看入口"
```

---

## 收尾

- [ ] 三个任务提交后，运行一次完整验证：`cd web && npm run test && npm run lint`
- [ ] 用 `git status` 确认改动只落在本计划的 6 个文件内（另有 `DESIGN.md` 的方向性说明视用户决定是否一并提交）。

## 已记录但不处理

- `Field` 包裹式写法下提示文字会进入触发器可访问名（实测「项目负责人 留空默认当前用户」）。修正需要在 `Field` 中建立 `id`/`aria-labelledby` 关联，属结构调整，留待后续统一处理。
- 其余 6 处点击行的同类键盘缺口：`web/app/(dashboard)/contacts/page.tsx:222`、`partners/page.tsx:207`、`admin/page.tsx:246`、`admin/page.tsx:382`、`projects/[id]/page.tsx:751`、`projects/[id]/ProjectReceivablesPanel.tsx:262`。倾向的后续方向是在 `CardList` 同一层引入共享的 `ClickableRow` 原语，让新页面默认正确。
