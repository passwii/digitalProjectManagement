# 全站交付控制台重构实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将所有已登录业务页面统一到 Login + Dashboard 的「全站交付控制台」设计语言，同时保留现有数据、权限、Table 和 Dialog/Drawer 工作流。

**Architecture:** 先把视觉令牌和共享组件改成控制台主题，再按“台账 / 交付决策 / 财务洞察 / 管理系统”四类页面收敛页面结构。优先使用现有全局 class 和共享组件，只有需要真实语义层级的局部结构才新增页面级样式；不重写 API 或业务状态机。

**Tech Stack:** Next.js 14 App Router、React 18、TypeScript、CSS Modules、全局 CSS、Framer Motion、Recharts、Vitest、Node test runner。

## Global Constraints

- 视觉基准固定为 `#07131F` / `#081622` / `#0D1D2C` / `#6CF3FF` / `#C6FF72` / `#FF9A6A`。
- 默认控制台容器与表格不使用圆角；移动 BottomSheet 顶部圆角、头像和状态点除外。
- 不修改 API、权限、认证、路由门禁、数据语义和现有 Table/Dialog/Drawer 工作流。
- 动效只使用 opacity、transform、边界/背景状态，不动画化 width、height、padding、margin。
- 所有中文页面文案保持中文；英文只保留真实技术读数或已存在的文件/编号内容。
- `prefers-reduced-motion: reduce` 必须关闭循环动画、延迟 reveal 和 transition。
- 每一批结束都运行对应测试并使用中文 commit message；不得暂存已有 Login 页面未提交改动。

---

### Task 1：建立全站控制台令牌与 Shell 契约

**Files:**

- Modify: `web/app/(dashboard)/layout.tsx`
- Modify: `web/app/globals.css`
- Modify: `web/components/ui/Shell.module.css`
- Modify: `web/components/ui/PageHeader.module.css`
- Modify: `web/components/ui/ListPageLayout.module.css`
- Modify: `web/components/ui/TableToolbar.module.css`
- Test: `web/lib/pageHeader.dom.vitest.test.tsx`

**Interfaces:** `DashboardShell` 增加 `data-console-shell="true"` 与 `data-console-route`；`PageHeader`、`ListPageLayout` 和 `DesktopTableFrame` 保持现有 props 与 data attributes。

- [ ] Step 1：运行 `cd web && npm run test:motion -- lib/pageHeader.dom.vitest.test.tsx lib/listPageLayout.dom.vitest.test.tsx`，记录共享契约基线。
- [ ] Step 2：在 Shell 根节点加入 `data-console-shell="true" data-console-route={pathname}`，不改变 PullToRefresh、ActivityBar、MobileDock 的挂载层级。
- [ ] Step 3：将 `globals.css` 的页面令牌切到深色控制台；`--radius` / `--radius-sm` 为 `0px`，保留 `--radius-pill` 给头像和状态点；同步表单、按钮、卡片、表格、KPI、工具栏、分页和状态条。
- [ ] Step 4：将 Shell、PageHeader、ListPageLayout、TableToolbar 收敛为无白卡命令带；状态与选中只使用 opacity、transform、边界或背景过渡。
- [ ] Step 5：重跑共享测试与 `git diff --check`，提交 `设计：统一全站交付控制台骨架`。

### Task 2：打磨控制台基础组件与状态反馈

**Files:**

- Modify: `web/components/ui/Modal.module.css`
- Modify: `web/components/ui/PageState.module.css`
- Modify: `web/components/ui/Empty.module.css`
- Modify: `web/components/ui/Badge.module.css`
- Modify: `web/components/ui/ProgressBar.module.css`
- Modify: `web/components/ui/CardList.module.css`
- Modify: `web/components/ui/Pagination.module.css`
- Modify: `web/components/ui/FileDropZone.module.css`
- Modify: `web/components/ui/Toast.module.css`
- Modify: `web/components/ui/Bell.module.css`
- Modify: `web/components/ui/ProjectPicker.module.css`
- Modify: `web/components/mobile/MobileDock.module.css`
- Modify: `web/components/mobile/SheetCard.module.css`
- Modify: `web/components/mobile/sheets/sheets.module.css`
- Test: existing modal/card/upload/attachment/identity DOM tests under `web/lib/`

**Interfaces:** 保持所有组件 props、事件、ARIA、data attributes、Dialog/Drawer 行为和移动端短确认行为。

- [ ] Step 1：运行 `cd web && npm run test:motion -- lib/modalFocus.dom.vitest.test.ts lib/cardList.dom.vitest.test.tsx lib/uploadQueue.dom.vitest.test.tsx lib/attachmentPreview.dom.vitest.test.tsx lib/identityRender.dom.vitest.test.tsx`。
- [ ] Step 2：统一 Modal/Drawer/Toast/Bell 的深色实面、顶部信号线、底部操作带；进入/退出只用 opacity + translateY。
- [ ] Step 3：统一 Loading、Empty、Badge、ProgressBar、FileDropZone、AttachmentPreview、Pagination、ProjectPicker 的表面、焦点环、状态词和 reduced-motion。
- [ ] Step 4：重跑基础回归、`git diff --check`，提交 `设计：统一控制台基础组件状态`。

### Task 3：打磨台账与项目档案工作面

**Files:**

- Modify: `web/app/(dashboard)/projects/page.tsx`
- Modify: `web/app/(dashboard)/projects/[id]/page.tsx`
- Modify: `web/app/(dashboard)/opportunities/page.tsx`
- Modify: `web/app/(dashboard)/partners/page.tsx`
- Modify: `web/app/(dashboard)/contacts/page.tsx`
- Test: `web/lib/tableToolbar.vitest.test.tsx`、`web/lib/listPageLayout.dom.vitest.test.tsx` 与附件预览回归

**Interfaces:** 项目、商机、友商继续使用 `ListPageLayout` + `DesktopTableFrame`；编辑继续打开 Dialog/Drawer；手机端保留现有卡片结构和横向表格契约。

- [ ] Step 1：保留并补充 `data-list-page`、`data-list-toolbar`、`data-desktop-table-frame` 断言，确认筛选和分页节点仍存在。
- [ ] Step 2：统一项目、商机、友商、通讯录的命令带、表头读数、行 hover、定位行和操作按钮；不改变字段、筛选 URL 或编辑回调。
- [ ] Step 3：把项目详情页 Tabs、`kv`、文档编辑器、附件预览和成员 Dialog 接入控制台表面；保留在线预览和保存状态。
- [ ] Step 4：运行 `cd web && npm run test:motion -- lib/tableToolbar.vitest.test.tsx lib/listPageLayout.dom.vitest.test.tsx lib/attachmentPreview.dom.vitest.test.tsx`，提交 `设计：打磨台账与项目档案工作面`。

### Task 4：打磨交付、审批、成本、报表、财务和管理页

**Files:**

- Modify: `web/app/(dashboard)/progress/page.tsx`
- Modify: `web/app/(dashboard)/costs/page.tsx`
- Modify: `web/app/(dashboard)/approvals/page.tsx`
- Modify: `web/app/(dashboard)/reports/page.tsx`
- Modify: `web/app/(dashboard)/finance/page.tsx`
- Modify: `web/app/(dashboard)/admin/page.tsx`
- Modify: existing global styles for `kpi-row`、`section-head`、`tabs`、`timeline`、`kv`、`warning-list` and table utilities
- Test: full motion suite and existing page contracts

**Interfaces:** 保持当前 API、分页、审批动作、财务期间、报表导出、权限入口和所有 Dialog。

- [ ] Step 1：将旧 KPI/section/table 表面替换为读数带与命令分区，只调整已有指标的层级、间距和颜色，不新增指标。
- [ ] Step 2：让进度、审批、成本状态复用现有中文 `Badge` tone，用节点、边界和短位移表达待处理/完成/阻断。
- [ ] Step 3：让报表和财务页的金额、日期、编号使用等宽读数；保留表格横向滚动，期间选择和导出操作集中在命令带。
- [ ] Step 4：运行 `cd web && npm test` 与 `git diff --check`，提交 `设计：统一交付审批财务工作面`。

### Task 5：完成系统页、移动端和最终质量校验

**Files:**

- Modify: `web/app/(dashboard)/changelog/page.tsx`
- Modify: `web/app/(dashboard)/changelog/changelog.module.css`
- Modify: `web/app/change-password/page.tsx`
- Modify: `web/app/(dashboard)/error.tsx`
- Modify: `web/app/(dashboard)/loading.tsx`
- Modify: mobile Dock、Sheet 和移动状态组件样式
- Test: changelog、mobileNav、bottomSheet DOM tests

**Interfaces:** 修改密码、错误、加载和功能更新保留现有路由、恢复动作、ARIA；MobileDock 入口集合与 Sheet 手势状态机不变。

- [ ] Step 1：统一加载、错误、修改密码、功能更新的标题、状态线、恢复按钮和中文反馈。
- [ ] Step 2：统一 MobileDock 与 Sheets 的表面、选中信号、触控尺寸、安全区和 reduced-motion。
- [ ] Step 3：所有 UI 修改完成后仅运行一次 Impeccable detector，并一次性处理新发现的问题。
- [ ] Step 4：运行 `cd web && npm test && npm run build`、`git diff --check`、登录/API 健康检查，提交 `设计：完成全站交付控制台收尾`；不得暂存既有 Login 未提交改动。
