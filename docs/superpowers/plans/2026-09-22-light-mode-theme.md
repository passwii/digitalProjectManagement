# Light Mode 主题 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为数科云办公工作台增加默认深色、浅色、跟随系统三档主题，并从顶栏用户 hover 菜单完成选择、持久化和全站视觉适配，验证后发布到 VPS。

**Architecture:** 主题状态由无依赖的 `ThemeProvider` 统一管理，纯函数负责模式合法性与系统解析；首屏脚本先写入 `<html data-theme>`，避免已选择浅色的用户刷新时闪烁深色。全站 CSS 以语义 token 映射浅色/深色，Portal 组件继承根节点 token，UserMenu 只负责入口与可访问的 `menuitemradio` 选择器。

**Tech Stack:** Next.js 14 App Router、React 18、TypeScript、CSS Modules、Vitest、Node test、Docker Compose、SSH。

## Global Constraints

- 默认主题必须是 `dark`；未设置、非法存储值、存储读写异常均回退到 `dark`。
- 主题选项固定为 `light`、`dark`、`system`，存储键固定为 `shuzhi-theme-mode`。
- 不改变认证接口、会话保存、路由门禁、API 合约、表格列宽、Dialog/Drawer 编辑流程和既有 Login 科幻深色世界。
- 用户菜单继续支持 hover / focus / tap、延迟关闭、方向键、Home、End、Esc；主题项点击后菜单保持打开。
- 浅色模式必须同步覆盖桌面、窄屏、移动 Dock、Dialog、Drawer、Toast、BottomSheet、表格和状态提示。
- 现有 Login、`.impeccable/`、`DESIGN.md` 未提交文件不能加入本轮代码提交。
- 所有 Git 提交标题与分节抬头使用中文；部署前必须先完成本地构建、测试和生产路由验证。

---

### Task 1: 建立主题模式纯逻辑与回归测试

**Files:**
- Create: `web/components/theme/theme.ts`
- Test: `web/lib/theme.test.ts`

**Interfaces:**
- Produces `ThemeMode`, `ResolvedTheme`, `THEME_STORAGE_KEY`。
- Produces `isThemeMode(value: unknown): value is ThemeMode`。
- Produces `parseStoredTheme(value: string | null): ThemeMode`。
- Produces `resolveTheme(mode: ThemeMode, prefersDark: boolean): ResolvedTheme`。

- [ ] **Step 1: Write the failing tests**

在 `web/lib/theme.test.ts` 用 Node test/assert 覆盖以下固定行为：

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { parseStoredTheme, resolveTheme } from "../components/theme/theme";

test("未设置或非法值默认深色", () => {
  assert.equal(parseStoredTheme(null), "dark");
  assert.equal(parseStoredTheme("solarized"), "dark");
});

test("三档主题解析保持确定性", () => {
  assert.equal(resolveTheme("light", false), "light");
  assert.equal(resolveTheme("dark", true), "dark");
  assert.equal(resolveTheme("system", false), "light");
  assert.equal(resolveTheme("system", true), "dark");
});

test("合法存储值被保留", () => {
  assert.equal(parseStoredTheme("light"), "light");
  assert.equal(parseStoredTheme("dark"), "dark");
  assert.equal(parseStoredTheme("system"), "system");
});
```

- [ ] **Step 2: Run the focused test and confirm it fails**

Run: `cd web && npm run test:unit -- --test-name-pattern="主题"`

Expected: FAIL because `components/theme/theme.ts` and its exports do not exist。

- [ ] **Step 3: Implement the minimal pure module**

`web/components/theme/theme.ts` 必须包含以下实现语义：

```ts
export type ThemeMode = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";
export const THEME_STORAGE_KEY = "shuzhi-theme-mode";

export function isThemeMode(value: unknown): value is ThemeMode {
  return value === "light" || value === "dark" || value === "system";
}

export function parseStoredTheme(value: string | null): ThemeMode {
  return isThemeMode(value) ? value : "dark";
}

export function resolveTheme(mode: ThemeMode, prefersDark: boolean): ResolvedTheme {
  if (mode === "system") return prefersDark ? "dark" : "light";
  return mode;
}
```

- [ ] **Step 4: Run the focused test and confirm it passes**

Run: `cd web && npm run test:unit -- --test-name-pattern="主题"`

Expected: all theme logic tests pass。

- [ ] **Step 5: Commit the isolated logic**

```bash
git add web/components/theme/theme.ts web/lib/theme.test.ts
git commit -m "新增：建立主题模式解析逻辑"
```

### Task 2: 接入 Provider、首屏初始化和主题选择器

**Files:**
- Create: `web/components/theme/ThemeProvider.tsx`
- Create: `web/components/theme/ThemeModePicker.tsx`
- Create: `web/components/theme/ThemeModePicker.module.css`
- Modify: `web/app/layout.tsx`

**Interfaces:**
- `ThemeProvider({ children }: { children: React.ReactNode })` 在客户端提供主题上下文。
- `useTheme(): { mode: ThemeMode; resolvedTheme: ResolvedTheme; setMode(mode: ThemeMode): void }`。
- `ThemeModePicker({ mode, onChange }: { mode: ThemeMode; onChange: (mode: ThemeMode) => void })` 渲染三个 `role="menuitemradio"`。
- Provider 导出 `themeBootstrapScript`，供根布局以 `beforeInteractive` 注入。

- [ ] **Step 1: Add provider contract tests**

增加 `web/lib/themeProvider.dom.vitest.test.tsx`，使用 jsdom 与 Testing Library 验证：Provider 初始默认 `dark`；点击选择器的 `浅色` 后 `<html data-theme="light">`、`color-scheme: light` 和 `localStorage["shuzhi-theme-mode"] === "light"` 同时成立；选择 `跟随系统` 后存储值为 `system`。

- [ ] **Step 2: Run the new DOM test and confirm it fails**

Run: `cd web && npx vitest run lib/themeProvider.dom.vitest.test.tsx`

Expected: FAIL because Provider and picker do not exist。

- [ ] **Step 3: Implement provider and bootstrap**

Provider 必须：

1. 初始 React 状态使用 `dark`，挂载后读取 `parseStoredTheme(window.localStorage.getItem(THEME_STORAGE_KEY))`。
2. 为 `system` 模式订阅 `window.matchMedia("(prefers-color-scheme: dark)")` 的 `change` 事件，卸载时移除监听。
3. 在解析主题变化时同步 `document.documentElement.dataset.theme` 与 `document.documentElement.style.colorScheme`。
4. `setMode` 先更新状态，再安全写入 localStorage；写入异常不阻断主题应用。
5. Bootstrap 脚本只读取三档合法值；无值或异常直接写 `dark`，并在脚本中设置 `data-theme` 与 `color-scheme`。

- [ ] **Step 4: Implement the picker**

选择器使用中文标签“浅色 / 深色 / 跟随系统”，每项为真实 `<button type="button" role="menuitemradio">`，提供 `aria-checked`、当前态视觉标记、SVG 图标和可见焦点；组件不读写 localStorage，只调用 `onChange`。

- [ ] **Step 5: Wire the root layout**

在 `web/app/layout.tsx`：

```tsx
<html lang="zh-CN" suppressHydrationWarning>
  <body>
    <Script id="theme-bootstrap" strategy="beforeInteractive">
      {themeBootstrapScript}
    </Script>
    <ThemeProvider>
      {children}
      <InstallPrompt />
    </ThemeProvider>
  </body>
</html>
```

保留既有 metadata、viewport、InstallPrompt 和路由结构。

- [ ] **Step 6: Run focused provider tests**

Run: `cd web && npx vitest run lib/themeProvider.dom.vitest.test.tsx`

Expected: provider/picker tests pass。

- [ ] **Step 7: Commit theme runtime**

```bash
git add web/components/theme web/app/layout.tsx web/lib/themeProvider.dom.vitest.test.tsx
git commit -m "新增：接入主题持久化与首屏初始化"
```

### Task 3: 把三档主题接入顶栏用户菜单

**Files:**
- Modify: `web/app/(dashboard)/layout.tsx`
- Modify: `web/components/ui/Shell.module.css`
- Test: `web/lib/themeMenu.dom.vitest.test.tsx`

**Interfaces:**
- UserMenu 内部读取 `useTheme()`，将 `mode` 与 `setMode` 传给 `ThemeModePicker`。
- 现有 `menuItems()` 查询器扩展为 `[role="menuitem"], [role="menuitemradio"]`。

- [ ] **Step 1: Add failing menu tests**

测试用户菜单包含 `显示模式`、三个中文主题选项，当前主题 `aria-checked="true"`；点击“浅色”保持菜单打开且更新当前项；方向键能够在普通菜单项与主题项之间循环；现有“功能更新”“修改密码”“退出登录”仍保留。

- [ ] **Step 2: Run the menu test and confirm it fails**

Run: `cd web && npx vitest run lib/themeMenu.dom.vitest.test.tsx`

Expected: FAIL because UserMenu does not render theme controls。

- [ ] **Step 3: Integrate the picker without changing account behavior**

在现有菜单中保留三个账号动作，并在修改密码之后插入主题分隔区。主题选项点击后不调用 `closeMenu()`；UserMenu 的 hover 延时、focus 归属、pointerDown 防抖、Esc 还焦逻辑保持原样。

- [ ] **Step 4: Extend keyboard navigation and mobile sizing**

`menuItems()` 同时收集 `menuitem` 与 `menuitemradio`，方向键/Home/End 按 DOM 顺序移动；主题按钮在 `max-width: 767px` 下沿用 `var(--m-tap)` 最小高度，桌面菜单增加分组标题、分隔线和紧凑选中标记。

- [ ] **Step 5: Run menu and existing identity tests**

Run: `cd web && npx vitest run lib/themeMenu.dom.vitest.test.tsx lib/identityRender.dom.vitest.test.tsx`

Expected: all new and existing user identity/menu tests pass。

- [ ] **Step 6: Commit menu integration**

```bash
git add 'web/app/(dashboard)/layout.tsx' web/components/ui/Shell.module.css web/lib/themeMenu.dom.vitest.test.tsx
git commit -m "新增：在用户菜单加入三档主题切换"
```

### Task 4: 完成全站 Light Mode 语义 token 与组件适配

**Files:**
- Modify: `web/app/globals.css`
- Modify: `web/components/ui/Shell.module.css`
- Modify: `web/components/ui/Modal.module.css`
- Modify: `web/components/mobile/MobileDock.module.css`
- Modify: `web/components/pwa/InstallPrompt.module.css`
- Modify: `web/components/theme/ThemeModePicker.module.css`

**Interfaces:**
- `:root` 保留深色 token 作为默认值。
- `:root[data-theme="light"]` 覆盖 `--bg`、`--card`、`--th-bg`、`--ink`、`--ink-2`、`--ink-3`、`--line`、`--line-soft`、`--brand`、`--brand-hover`、`--brand-soft`、`--navy`、状态色、阴影和导航语义 token。
- Shell 与全局组件只消费语义变量，不通过页面级重复规则硬编码深色背景。

- [ ] **Step 1: Create a token audit checklist from the current CSS**

Run: `rg -n "#07131F|#0D1D2C|#081622|#EAF9FB|#fff|rgba\\(13, 29, 44|rgba\\(108, 243, 255" web/app/globals.css web/components/ui/Shell.module.css web/components/ui/Modal.module.css web/components/mobile/MobileDock.module.css web/components/pwa/InstallPrompt.module.css`

每个命中点按“画布 / 表面 / 导航 / 主文字 / 次文字 / 交互 / 状态 / 阴影”归类；只改工作台相关硬编码，Login 专属视觉仍由 Login 模块自己的变量和颜色控制。

- [ ] **Step 2: Add composed light tokens**

在全局 CSS 中实现规格确定的浅色关系：冷白画布 `#F3F7FA`、白色表面 `#FFFFFF`、浅蓝灰次表面 `#EAF2F6`、深海军主文字 `#10263A`、链路青 `#006E86`、酸橙行动色 `#B8E86B`，并为 `--nav-bg`、`--nav-ink`、`--nav-muted`、`--nav-active-bg`、`--overlay`、`--shadow-card`、`--shadow-float` 建立语义 token。

- [ ] **Step 3: Refactor console surfaces to consume tokens**

Shell 侧栏、顶栏、用户 chip、菜单、页面头、卡片、表格、KPI、Tab、状态提示、移动 Dock、Dialog/Drawer/Toast/BottomSheet 只使用 token；删除会覆盖根节点浅色 token 的本地深色定义，保留直角、边界、密度和已有动效。

- [ ] **Step 4: Preserve responsive behavior and reduced motion**

不修改既有 900px、767px、520px 结构断点；只在对应主题下调整颜色和边界。主题切换过渡使用 `color`、`background-color`、`border-color`、`box-shadow`，并在 `prefers-reduced-motion: reduce` 下关闭过渡。

- [ ] **Step 5: Run the CSS and type checks**

Run: `cd web && npm run test:motion -- --run lib/pageHeader.dom.vitest.test.tsx lib/listPageLayout.dom.vitest.test.tsx`

Expected: shared layout and motion regression tests pass。

- [ ] **Step 6: Commit the theme surface**

```bash
git add web/app/globals.css web/components/ui/Shell.module.css web/components/ui/Modal.module.css web/components/mobile/MobileDock.module.css web/components/pwa/InstallPrompt.module.css
git commit -m "设计：完成全站 Light Mode 表面适配"
```

### Task 5: 全量验证、视觉走查和发布前收口

**Files:**
- Modify only files revealed by failing tests or visual audit; do not touch existing Login-only dirty files。

- [ ] **Step 1: Run the complete frontend test suite**

Run: `cd web && npm test`

Expected: unit tests and motion/DOM tests all pass with zero failures。

- [ ] **Step 2: Build production output in isolation**

先确保没有并发的 `next dev` 写入 `.next`，再运行：`cd web && npm run build`。

Expected: Next.js build exits 0；允许既有 ESLint warning，但不能有 TypeScript、route、manifest 或 page data 错误。

- [ ] **Step 3: Run static hygiene checks**

Run: `git diff --check`；`/Users/damon/.agents/skills/impeccable/scripts/impeccable detect --json --scope layout web/app/globals.css web/components/ui/Shell.module.css web/app/'(dashboard)'`

Expected: no whitespace errors and no new layout detector findings。

- [ ] **Step 4: Run local route and API checks**

启动唯一一个 `npm run dev` 实例，检查 `/login` 为 200、未认证 `/dashboard` 为 307、`http://127.0.0.1:8001/health` 为 200；停留在同一实例上做视觉预览，不与 `npm run build` 并发。

- [ ] **Step 5: Perform bounded visual review**

在桌面和移动视口各检查一次：工作台、项目台账表格、一个 Dialog、用户 hover 菜单、移动顶栏/Dock。依次验证深色、浅色、跟随系统；确认刷新后选择保持，当前项标记、焦点环、表格密度、正文宽度和登录页深色视觉不回退。

- [ ] **Step 6: Create the final Chinese implementation commit**

确认暂存区只含本轮主题代码、测试和计划/规格文档之后，提交：

```bash
git add web/components/theme web/app/layout.tsx 'web/app/(dashboard)/layout.tsx' web/app/globals.css web/components/ui/Shell.module.css web/components/ui/Modal.module.css web/components/mobile/MobileDock.module.css web/components/pwa/InstallPrompt.module.css web/lib/theme*.test.tsx web/lib/theme.test.ts docs/superpowers/specs/2026-09-22-light-mode-theme-design.md docs/superpowers/plans/2026-09-22-light-mode-theme.md
git commit -m "新增：完成全站三档主题模式"
```

### Task 6: 合并主线并部署 VPS

**Files:**
- Modify: Git history and remote `main` only after local verification is complete。
- Reference: `scripts/deploy_vps.py`, `docker-compose.yml`, `docker-compose.prod.yml`。

- [ ] **Step 1: Inspect divergence before integration**

Run: `git rev-list --left-right --count HEAD...origin/main` and `git status --short`。

如果 `origin/main` 有远端提交，先在当前已验证提交上执行 `git merge --no-ff origin/main -m "合并：同步远端主线后发布主题模式"`；冲突只处理本轮涉及的主题文件，已有 Login dirty 文件不得被覆盖。

- [ ] **Step 2: Verify the merge result**

Run: `git diff --check`、`cd web && npm run build`、`python -m unittest tests/test_deploy_vps.py`。

Expected: merge 后构建和部署脚本契约测试仍通过。

- [ ] **Step 3: Publish the branch state required by the VPS deploy script**

由于 `scripts/deploy_vps.py` 固定执行 `git pull --ff-only origin main`，只有在本地 merge 结果验证后才将合并后的提交推送到 `origin/main`；若远端 main 在校验期间继续前进，停止并报告，不强推、不覆盖远端历史。

- [ ] **Step 4: Run the production deployment**

Run: `python scripts/deploy_vps.py`。

脚本必须完成 `/opt/pm` 的 fast-forward、双 Compose 文件构建、容器状态检查和 `http://127.0.0.1:8001/health` 检查；任何一步失败都停止，不宣称部署成功。

- [ ] **Step 5: Verify the deployed web surface**

通过 VPS 公网入口检查 `/login` HTTP 200、未认证 `/dashboard` 的登录跳转、静态资源无 404、API 健康检查 200；在用户菜单中选择浅色并刷新，确认本地主题选择仍保持。

- [ ] **Step 6: Report final state**

汇报中文提交/合并提交、部署目标、健康检查结果、测试结果、VPS 入口和仍保留的既有未提交文件；不把未能验证的视觉或发布状态写成已完成。
