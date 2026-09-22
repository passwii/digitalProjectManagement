# 审计日志中文展示实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `/admin?tab=日志` 的动作、对象和详情全部使用中文展示，同时保留英文动作码作为筛选和排查依据。

**Architecture:** 新增纯函数模块 `web/lib/auditLogLabels.ts`，集中完成审计动作、资源和详情格式化；日志页面在渲染边界调用该模块，后端 API、数据库和导出结构保持不变。映射未知值使用中文兜底，动态业务事实值原样保留。

**Tech Stack:** Next.js App Router、React、TypeScript、Node `node:test`、npm。

## Global Constraints

- 不修改 `audit_logs` 表结构、后端审计写入入口和 `GET /admin/logs` 响应结构。
- 页面日志字段不直接渲染原始 `action`、`resource`、`detail`；英文动作码只作为筛选参数和排查依据。
- 文件名、项目名、项目编码、用户输入原因、金额、编号等动态业务事实值保持原样。
- 映射函数必须是纯函数，不发请求、不修改输入对象、不依赖 React 状态。
- 按 TDD 执行：先写失败测试，确认失败，再写最小实现并复跑。
- Git 提交信息使用中文。

---

### Task 1: 建立审计日志格式化行为测试

**Files:**
- Create: `web/lib/auditLogLabels.test.ts`
- Reference: `web/tsconfig.test.json`

**Interfaces:**
- Consumes: planned exports from `web/lib/auditLogLabels.ts`:
  `auditActionLabel(action: string, resource?: string): string`,
  `auditResourceLabel(resource: string): string`,
  `auditResourceDisplay(resource: string, resourceId?: string | null): string`,
  `auditDetailLabel(action: string, resource: string, detail: string): string`.
- Produces: executable expectations for all display-layer rules before implementation.

- [ ] **Step 1: Write the failing test**

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  auditActionLabel,
  auditDetailLabel,
  auditResourceDisplay,
  auditResourceLabel,
} from "./auditLogLabels";

describe("审计日志中文展示", () => {
  it("将明确动作和资源码转换为中文", () => {
    assert.equal(auditActionLabel("create_project", "projects"), "创建项目");
    assert.equal(auditActionLabel("create", "voucher"), "创建凭证");
    assert.equal(auditActionLabel("update", "accounting_period"), "更新会计期间");
    assert.equal(auditResourceLabel("projects"), "项目");
  });

  it("对未知动作和资源使用中文兜底", () => {
    assert.equal(auditActionLabel("future_action", "future_resource"), "其他操作");
    assert.equal(auditResourceLabel("future_resource"), "其他资源");
  });

  it("组合中文资源和资源编号", () => {
    assert.equal(auditResourceDisplay("projects", "123"), "项目 #123");
    assert.equal(auditResourceDisplay("projects", ""), "项目");
    assert.equal(auditResourceDisplay("future_resource", "7"), "其他资源 #7");
  });

  it("翻译结构化详情并保留动态值", () => {
    assert.equal(
      auditDetailLabel("update_followup", "followups", "project=12"),
      "项目：12",
    );
    assert.equal(
      auditDetailLabel("apply_arap", "arap_transactions", "voucher=12,amount=300"),
      "凭证：12；金额：300",
    );
    assert.equal(
      auditDetailLabel("project_status", "projects", "doing->done 客户已验收"),
      "原状态：进行中 → 新状态：已完成；客户已验收",
    );
    assert.equal(
      auditDetailLabel("toggle_demo_data", "sys_params", "demo_data_on=1"),
      "演示数据：已开启",
    );
  });

  it("保留中文详情、业务文件名并处理空详情", () => {
    assert.equal(auditDetailLabel("login", "auth", "登录成功"), "登录成功");
    assert.equal(auditDetailLabel("upload_attachment", "attachments", "报告.pdf"), "报告.pdf");
    assert.equal(auditDetailLabel("future_action", "future_resource", ""), "操作详情已记录");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npm run test:unit`

Expected: FAIL during TypeScript compilation because `lib/auditLogLabels.ts` does not exist yet. The failure must point to the planned module import, not to a test syntax error.

- [ ] **Step 3: Commit the failing test**

```bash
git add web/lib/auditLogLabels.test.ts
git commit -m "测试：补充审计日志中文映射用例"
```

### Task 2: 实现集中中文映射与详情格式化

**Files:**
- Create: `web/lib/auditLogLabels.ts`
- Test: `web/lib/auditLogLabels.test.ts`

**Interfaces:**
- Consumes: raw `action`, `resource`, `resourceId` and `detail` strings from `AuditLog`.
- Produces: the four pure string-formatting functions imported by the tests and the admin page.

- [ ] **Step 1: Add explicit action, resource, field and status maps**

Implement the maps with Chinese labels for the current audit call sites, including `login`, `login_fail`, `logout`, `change_password`, project, attachment, follow-up, task, milestone, contact, partner, budget, expense, approval, finance, admin and log-export actions. Add resource labels for `auth`, `projects`, `attachments`, `followups`, `tasks`, `milestones`, `contact_profiles`, `partners`, `budgets`, `budget_adjusts`, `expenses`, `vouchers`, `accounting_period`, `audit_logs`, `users`, `dicts`, `sys_params` and the finance resources used by the API.

Use resource-specific labels for generic actions:

```ts
const GENERIC_ACTIONS: Record<string, string> = {
  create: "创建",
  update: "更新",
  delete: "删除",
  submit: "提交",
  approve: "审核通过",
  reject: "驳回",
  post: "过账",
  void: "作废",
  reverse: "冲销",
  close: "结账",
};
```

- [ ] **Step 2: Implement resource and action formatting**

`auditResourceLabel` trims the input and returns a mapped label or `其他资源`. `auditActionLabel` first checks a specific action map, then uses the generic action plus the mapped resource, and otherwise returns `其他操作`.

`auditResourceDisplay` returns the localized resource label and appends ` #${resourceId}` only for a non-empty identifier.

- [ ] **Step 3: Implement safe detail formatting**

Parse only known display structures. Split comma-separated `key=value` pairs into `；`-joined Chinese segments, format `old->new` as a status transition, convert known keys (`project`, `task`, `voucher`, `period`, `book`, `count`, `amount`, `active`, `created`, `demo_data_on`) and known status codes using the existing label vocabulary. Keep Chinese text and recognized business values unchanged. Return `操作详情已记录` for empty or unrecognized machine-only details, while allowing known file-name and business-value actions to keep their detail value.

- [ ] **Step 4: Run focused tests to verify they pass**

Run: `cd web && npm run test:unit`

Expected: the new audit-log tests PASS and the existing unit suite remains green.

- [ ] **Step 5: Commit the formatter**

```bash
git add web/lib/auditLogLabels.ts web/lib/auditLogLabels.test.ts
git commit -m "功能：增加审计日志中文格式化"
```

### Task 3: 接入系统管理日志页

**Files:**
- Modify: `web/app/(dashboard)/admin/page.tsx:1-20,330-445`
- Modify: `web/lib/chineseCopy.test.ts:20-30`
- Test: `web/lib/auditLogLabels.test.ts`

**Interfaces:**
- Consumes: formatter functions from `@/lib/auditLogLabels` and the unchanged `AuditLog` response.
- Produces: Chinese action, resource and detail text in both the table and detail drawer.

- [ ] **Step 1: Update the source-level regression test first**

Replace the old assertion that requires direct `l.action` and `l.detail` rendering with assertions that the admin page imports and calls the formatter functions, and that the old English-display placeholder assertion is removed:

```ts
it("审计日志使用集中中文格式化，不直接展示原始编码", () => {
  const admin = source("app/(dashboard)/admin/page.tsx");
  assert.match(admin, /auditActionLabel/);
  assert.match(admin, /auditResourceDisplay/);
  assert.match(admin, /auditDetailLabel/);
  assert.doesNotMatch(admin, /<td className="mono tiny">\{l\.action\}<\/td>/);
  assert.doesNotMatch(admin, /title=\{l\.detail\}/);
});
```

- [ ] **Step 2: Run the regression test to verify it fails**

Run: `cd web && npm run test:unit`

Expected: FAIL because `admin/page.tsx` still renders the raw action and detail fields and does not import the formatter module.

- [ ] **Step 3: Wire the formatter into the admin page**

Add the import:

```ts
import {
  auditActionLabel,
  auditDetailLabel,
  auditResourceDisplay,
} from "@/lib/auditLogLabels";
```

Use the same expressions in the table and drawer:

```tsx
<td className="tiny">{auditActionLabel(l.action, l.resource)}</td>
<td className="tiny">{auditResourceDisplay(l.resource, l.resource_id)}</td>
<td>
  <span
    className="ellipsis"
    title={auditDetailLabel(l.action, l.resource, l.detail)}
  >
    {auditDetailLabel(l.action, l.resource, l.detail)}
  </span>
</td>
```

In the drawer, replace the raw action/resource/detail expressions with the same formatter calls. Keep the raw `url.logq` value in the request query and input value so English action-code filtering remains unchanged.

- [ ] **Step 4: Run the regression and full unit tests**

Run: `cd web && npm run test:unit`

Expected: the updated `chineseCopy.test.ts`, the formatter tests and all existing Node unit tests PASS.

- [ ] **Step 5: Commit the page integration**

```bash
git add 'web/app/(dashboard)/admin/page.tsx' web/lib/chineseCopy.test.ts
git commit -m "优化：系统日志页面改用中文展示"
```

### Task 4: 完整验证与交付检查

**Files:**
- Verify: `docs/superpowers/specs/2026-09-22-audit-log-chinese-display-design.md`
- Verify: `docs/superpowers/plans/2026-09-22-audit-log-chinese-display.md`
- Verify: all changed files and Git diff

**Interfaces:**
- Consumes: completed formatter and admin-page integration.
- Produces: fresh test/build evidence and a clean, reviewable diff.

- [ ] **Step 1: Run the complete frontend test suite**

Run: `cd web && npm test`

Expected: exit code 0; Node unit tests and Vitest motion/DOM tests report no failures.

- [ ] **Step 2: Run the production build**

Run: `cd web && npm run build`

Expected: exit code 0 and Next.js completes the production build without TypeScript or route errors.

- [ ] **Step 3: Inspect the final diff and status**

Run: `git diff --check`, `git diff --stat`, `git status --short`

Expected: no whitespace errors, only the intended spec/plan/formatter/test/admin-page files changed, and no generated build artifacts are staged.

- [ ] **Step 4: Commit final verification adjustments if needed**

If verification requires a correction in the formatter or page integration, rerun the affected test first, then commit the known implementation files with a Chinese message such as:

```bash
git add web/lib/auditLogLabels.ts 'web/app/(dashboard)/admin/page.tsx'
git commit -m "修复：完善审计日志中文展示兜底"
```
