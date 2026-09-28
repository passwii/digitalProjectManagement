# 设备报废 / 作废二次确认实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在设备详情抽屉中为「报废」和「作废」增加应用内二次确认，避免一次点击就进入不可逆终态。

**Architecture:** 只修改资产前端详情组件、组件样式与对应 DOM 测试。复用现有 `Dialog`，新增待确认操作本地状态；最终确认继续调用现有 `onAction`/transition API，不改后端、状态机、审计或数据库。

**Tech Stack:** Next.js 14、React、TypeScript、共享 `Dialog`、Vitest + Testing Library。

## Global Constraints

- 报废、作废确认不要求输入关键词。
- 确认窗口展示设备编号、名称、当前状态和不可恢复/不可编辑说明。
- 当前状态为已领用或借用中时，作废确认需提示会清空使用人和到期日。
- 送修和恢复可用流程保持不变。
- 不改后端 API、权限、状态机、审计事件、数据库结构或强制删除流程。

---

## 文件结构

- `web/app/(dashboard)/assets/page.tsx`：`AssetDetail` 的终态操作触发、确认状态、Dialog 文案和确认回调。
- `web/app/(dashboard)/assets/assets.css`：二次确认内容的紧凑信息区、终态警告和响应式排布；沿用现有 `asset-danger` / `asset-delete-blocked` token。
- `web/lib/assetsPage.dom.vitest.test.tsx`：验证第一次点击只打开窗口、取消不提交、最终确认提交正确动作、作废清空提示条件、维修操作不受影响。

### Task 1: 锁定终态二次确认交互

**Files:**
- Modify: `web/lib/assetsPage.dom.vitest.test.tsx`

**Interfaces:**
- Consumes: 当前 `AssetsPage` 测试 setup；mock `api.transition(assetId, action, body)`。
- Produces: 明确描述报废/作废确认行为的 DOM 测试，后续实现必须满足这些断言。

- [x] **Step 1: 添加报废取消与确认测试**

在 `describe("资产页面分页和刷新", ...)` 内新增独立用例，并用 `cleanup(); setup();` 重置前一测试 DOM，避免与 `beforeEach` 的默认渲染冲突。`api.get` mock `available` 设备（`api.get.mockResolvedValue(asset({ status: "available" }))`）。切换到「设备台账」、打开「查看」、点击「报废」，检查标题/设备编号/设备名称/当前状态和不可恢复说明；确认 `api.transition` 尚未调用；点「取消」后对话框消失且无请求。再次点击「报废」并点「确认报废」，断言 `api.transition` 收到 `(1, "scrap", { note: "" })`。

- [x] **Step 2: 添加作废的清空提示条件测试**

新测试也先 `cleanup(); setup();`，然后设 `api.get.mockResolvedValue(asset({ status: "borrowed", holder_id: 42, due_date: "2026-12-31" }))`。切换到「设备台账」、打开详情并点击「作废」；在确认窗口内断言显示“清空使用人和到期日”的提示，同时显示“借用中”。确认前 `api.transition` 不得调用；点「确认作废」后断言 `api.transition` 以 `(1, "void", { note: "" })` 调用一次。

- [x] **Step 3: 运行新增测试并确认失败**

Run: `cd web && npx vitest run lib/assetsPage.dom.vitest.test.tsx`
Expected: 新增用例失败，原因是现有「报废/作废」按钮直接提交、没有确认窗口。

### Task 2: 实现报废 / 作废确认窗口

**Files:**
- Modify: `web/app/(dashboard)/assets/page.tsx`
- Modify: `web/app/(dashboard)/assets/assets.css`
- Test: `web/lib/assetsPage.dom.vitest.test.tsx`

**Interfaces:**
- Consumes: `onAction(action, { note })`、共享 `Dialog`、本地 `STATUS` label map。
- Produces: `pendingTerminalAction: "scrap" | "void" | null` 状态；确认时调用 `onAction` 一次并清空待确认状态。

- [x] **Step 1: 加入待确认终态操作 state**

在 `AssetDetail` 已有 `deleteOpen` state 附近新增：

```tsx
const [pendingTerminalAction, setPendingTerminalAction] = useState<"scrap" | "void" | null>(null);
```

定义明确的确认处理器：

```tsx
const confirmTerminalAction = () => {
  if (!pendingTerminalAction || busy) return;
  const action = pendingTerminalAction;
  setPendingTerminalAction(null);
  onAction(action, { note });
};
```

- [x] **Step 2: 改造「报废」和「作废」按钮**

把报废按钮的 `onClick` 改为 `setPendingTerminalAction("scrap")`；把作废按钮改为 `setPendingTerminalAction("void")`。保留原来的可见条件、`disabled={busy}`、样式和送修/恢复可用行为。

- [x] **Step 3: 在 AssetDetail 内渲染共享 Dialog**

当 `pendingTerminalAction` 非空时渲染 `<Dialog open ...>`：
- `onClose={() => { if (!busy) setPendingTerminalAction(null); }}`
- `maskClosable={!busy}`、`size="sm"`
- 标题为「确认报废设备」或「确认作废设备」
- 正文包含设备编号、名称、当前状态 `STATUS[asset.status] ?? asset.status`
- 报废正文明确：将进入「已报废」，后续不能恢复或编辑档案。
- 作废正文明确：将进入「已作废」，后续不能恢复或编辑档案。
- `asset.status` 为 `claimed` 或 `borrowed` 且待确认 action 为 `void` 时，额外展示醒目的说明：确认后会清空使用人和到期日。
- footer 提供「取消」与 `asset-danger` 风格的「确认报废」/「确认作废」；busy 时按钮禁用，确认期间标签为「处理中…」。
- 不添加关键词输入，也不触碰 `note` 输入值。

- [x] **Step 4: 增加局部样式**

在 `assets.css` 终态确认样式中新增局部类，使用现有 CSS 变量：普通信息紧凑排版；设备编号使用 `--font-mono`；后果说明使用 `--line-danger`、`--danger-bg`、`--danger`。移动视口下允许长编号换行。不要修改共享 Dialog 样式或全局设计 token。

- [x] **Step 5: 运行 DOM 测试并确认通过**

Run: `cd web && npx vitest run lib/assetsPage.dom.vitest.test.tsx`
Expected: 本文件所有测试通过，新增用例确认首次点击不提交，最终确认只调用一次 transition。

### Task 3: 验证兼容行为与提交

**Files:**
- Verify: `web/app/(dashboard)/assets/page.tsx`
- Verify: `web/app/(dashboard)/assets/assets.css`
- Verify: `web/lib/assetsPage.dom.vitest.test.tsx`

**Interfaces:**
- Consumes: Task 2 的终态确认 Dialog。
- Produces: 通过的相关前端测试与构建验证。

- [x] **Step 1: 执行资产 API 和 DOM 测试**

Run: `cd web && npx vitest run lib/assetsPage.dom.vitest.test.tsx lib/equipmentAssetsApi.vitest.test.ts`
Expected: 相关测试全部通过。

- [x] **Step 2: 执行前端 build**

Run: `cd web && npm run build`
Expected: Next.js build 成功；若环境缺少构建所需的配置/密钥，记录具体阻塞信息，不伪报成功。

- [x] **Step 3: 检查 diff 并提交**

Run: `git diff --check && git status --short && git diff --stat`
Expected: 仅本计划的三个实现文件和计划/设计文档有变更；确认无误后提交实现。

```bash
git add 'web/app/(dashboard)/assets/page.tsx' 'web/app/(dashboard)/assets/assets.css' web/lib/assetsPage.dom.vitest.test.tsx docs/superpowers/plans/2026-09-28-equipment-scrap-void-confirmation.md
git commit -m "feat(assets): confirm scrap and void actions"
```
