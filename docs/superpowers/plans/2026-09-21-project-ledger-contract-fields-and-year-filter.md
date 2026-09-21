# 项目台账合同字段与年份筛选修复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 从项目台账全链路移除前向合同/后向合同字段，并让年度筛选根据项目合同编号中的四位年份段工作，例如 `SHZK-2026-009` 归入 2026 年。

**Architecture:** 保留现有 `year` URL 状态和服务端 `code` 模糊过滤契约，但把过滤片段从固定的 `PJ-YYYY-` 改为通用的 `-YYYY-`，同时把编号解析改为与前缀无关的四位年份段。前后向合同字段从当前 ORM/API/前端契约移除，并新增幂等数据库迁移删除存量列；历史迁移文件保持不改以维护迁移链。

**Tech Stack:** FastAPI、SQLAlchemy、Alembic、Next.js、React、TypeScript、Node `node:test`、Vitest。

## Global Constraints

- 所有 Git/PR 信息使用中文标题和中文分节抬头。
- 年份必须匹配合同编号中由连字符包围的四位数字段，不依赖前缀名称。
- 前向合同/后向合同不再出现在项目台账当前 API 响应、请求组装、ORM 模型、前端表单、详情页或标签字典中。
- 不修改已发布的历史迁移 `0007_project_contracts.py`；通过新迁移兼容已有数据库。
- 每项行为先写失败测试并确认失败，再实现最小修复并回归测试。

---

### Task 1: 锁定通用合同编号年份筛选行为

**Files:**
- Modify: `web/lib/projectYear.test.ts`
- Modify: `web/lib/projectFilters.test.ts`
- Modify: `web/lib/projectYear.ts`

**Interfaces:**
- Produces `extractProjectYear(code): string`，支持 `SHZK-2026-009`。
- Produces `yearToCodeFilter(year): string`，将 `2026` 转为 `-2026-`，供现有 `buildProjectListQuery` 传给后端。

- [x] **Step 1: Write the failing tests**

在 `web/lib/projectYear.test.ts` 增加：

```ts
it("从任意合同编号前缀提取年份", () => {
  assert.equal(extractProjectYear("SHZK-2026-009"), "2026");
  assert.equal(extractProjectYear("ABC-2024-1"), "2024");
});

it("年份筛选只匹配合同编号的年份段", () => {
  assert.equal(yearToCodeFilter("2026"), "-2026-");
});
```

把 `web/lib/projectFilters.test.ts` 中的筛选契约示例改为 `code: "-2026-"`，并将期望查询字符串改为 `code=-2026-`。

- [x] **Step 2: Run tests to verify they fail**

运行：`cd web && npm run test:unit -- --test-name-pattern='编号派生年份|年份转后端 code 过滤|项目台账负责人查询'`

预期：失败，因为当前实现只识别 `PJ-` 前缀，并生成 `PJ-2026-`。

- [x] **Step 3: Write the minimal implementation**

在 `web/lib/projectYear.ts` 中把编号正则改为匹配任意前缀的 `-YYYY-` 年份段，并把 `yearToCodeFilter` 返回值改为 `-${y}-`；同步更新注释，说明 `GET /projects` 会在服务端外围补充 `%`。

- [x] **Step 4: Run tests to verify they pass**

运行：`cd web && npm run test:unit -- --test-name-pattern='编号派生年份|年份转后端 code 过滤|项目台账负责人查询'`

预期：相关测试全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add web/lib/projectYear.ts web/lib/projectYear.test.ts web/lib/projectFilters.test.ts
git commit -m "修复项目台账合同编号年份筛选"
```

### Task 2: 移除项目台账前后向合同字段

**Files:**
- Modify: `api/models/__init__.py`
- Modify: `api/routers/projects.py`
- Create: `api/alembic/versions/0022_remove_project_directional_contracts.py`
- Modify: `web/lib/api.ts`
- Modify: `web/lib/labels.ts`
- Modify: `web/app/(dashboard)/projects/ProjectFormDialog.tsx`
- Modify: `web/app/(dashboard)/projects/page.tsx`
- Modify: `web/app/(dashboard)/projects/[id]/page.tsx`
- Modify: `tests/test_mvp.py`

**Interfaces:**
- `Project` ORM、`ProjectIn`、`_p()` 和更新白名单不再含 `forward_contract` / `backward_contract`。
- `Project` 前端类型、表单 payload、列表详情抽屉和完整档案合同卡片不再展示或提交这两个字段。
- Alembic revision `0022_remove_project_directional_contracts` 删除已有 `projects` 表中的两列，且重复执行安全。

- [x] **Step 1: Write the failing tests**

在 `tests/test_mvp.py::test_project_custom_code_contract_and_contract_attachment_scope` 的创建请求继续带上历史字段，但增加：

```python
    assert "forward_contract" not in p
    assert "backward_contract" not in p
```

新增 `web/lib/projectLedgerFields.test.ts`，验证项目台账页面源代码与标签字典不再包含两个字段名或对应中文标签：

```ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("项目台账合同字段", () => {
  it("不再暴露前向合同和后向合同字段", () => {
    const paths = [
      "lib/api.ts",
      "lib/labels.ts",
      "app/(dashboard)/projects/ProjectFormDialog.tsx",
      "app/(dashboard)/projects/page.tsx",
      "app/(dashboard)/projects/[id]/page.tsx",
    ];
    for (const path of paths) {
      const text = source(path);
      assert.doesNotMatch(text, /forward_contract|backward_contract|前向合同|后向合同/);
    }
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

运行：`cd web && npm run test:unit -- --test-name-pattern='项目台账合同字段'`

预期：失败，因为前端当前仍定义、提交和展示这些字段。

- [x] **Step 3: Write the minimal implementation**

移除 ORM 属性、接口序列化和 `ProjectIn`/更新白名单字段；创建 `0022` 迁移，使用 `sa.inspect(op.get_bind()).get_columns("projects")` 判断列存在后再删除；移除前端类型、标签映射、表单状态/回填/payload/输入控件、列表详情字段和完整档案合同卡片字段；保留合同状态、金额和合同附件功能。

- [x] **Step 4: Run tests to verify they pass**

运行：

```bash
cd web && npm run test:unit
cd .. && python -m compileall -q api
```

如已配置 `TEST_DATABASE_URL`，再运行：`pytest tests/test_mvp.py -k project_custom_code_contract_and_contract_attachment_scope -q`。

预期：前端单元测试、Python 编译检查和可用的后端回归测试全部通过。

- [ ] **Step 5: Commit**

```bash
git add api/models/__init__.py api/routers/projects.py api/alembic/versions/0022_remove_project_directional_contracts.py web/lib/api.ts web/lib/labels.ts 'web/app/(dashboard)/projects/ProjectFormDialog.tsx' 'web/app/(dashboard)/projects/page.tsx' 'web/app/(dashboard)/projects/[id]/page.tsx' web/lib/projectLedgerFields.test.ts tests/test_mvp.py
git commit -m "移除项目台账前后向合同字段"
```

### Task 3: 全量验证并复核残留引用

**Files:**
- Verify: `api/`, `web/`, `tests/`

- [x] **Step 1: Run targeted frontend tests**

运行：`cd web && npm run test:unit -- --test-name-pattern='编号派生年份|年度下拉选项|项目台账负责人查询|项目台账合同字段'`。

- [x] **Step 2: Run the complete frontend suite**

运行：`cd web && npm test`。

- [x] **Step 3: Run backend checks**

运行：`cd .. && python -m compileall -q api && pytest -q`；若测试环境未设置 `TEST_DATABASE_URL`，记录测试被 fixture 跳过而非将其误报为失败。

- [x] **Step 4: Audit current-code references**

运行：`rg -n -i 'forward_contract|backward_contract|前向合同|后向合同' api web tests`，确认只剩历史迁移兼容说明或明确的回归输入，不存在当前模型、接口、页面字段。

- [x] **Step 5: Review final diff**

运行：`git diff --check && git diff --stat && git status --short`，确保没有无关改动。
