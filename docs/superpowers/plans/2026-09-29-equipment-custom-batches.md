# 设备资产自定义批次实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让设备录入和整份文件导入可创建或复用带唯一自定义名称的批次，并允许管理员维护批次名称及删除空批次。

**Architecture:** 在 `EquipmentBatch` 上增加数据库唯一名称（lower-case expression index）并通过 Alembic 回填历史名称。资产 API 统一负责批次选择、验收状态继承、完整事务及审计；前端在现有入库表单、导入弹窗和批次列表中加入选择、搜索、重命名与空批次删除交互。

**Tech Stack:** FastAPI、Pydantic、SQLAlchemy、Alembic、PostgreSQL、Next.js/React、TypeScript、pytest、Vitest/Testing Library。

## Global Constraints

- 批次名称最长 128 个字符，首尾空白会去除，名称不得为空；名称按不区分大小写的全局唯一规则校验。
- 迁移为历史批次回填 `批次 #<id>`，不改变资产批次 ID、验收状态或设备/流水关联。
- 复用批次创建设备时继承其当前验收状态，且不覆盖来源、供应商、采购单号、发票号、备注或验收状态。
- 一份 CSV/Excel 文件只进入一个批次；任何行校验失败都不得创建空批次或部分设备。
- 仅管理员可以重命名或删除批次；只有无关联设备且无关联流水的批次允许删除；批次删除必须二次确认并审计。
- 设备被删除时不自动删除批次；设备详情与流转信息界面不在本次范围。
- 不新增依赖；关键批次变更和审计必须在同一事务提交。

---

## 文件结构

- `api/alembic/versions/0031_equipment_batch_names.py`：增加并回填批次名称，建立非空约束及大小写不敏感唯一索引。
- `api/models/__init__.py`：为 `EquipmentBatch` 增加 `name` 和唯一索引声明，确保测试建表结构与迁移后的 schema 一致。
- `api/routers/equipment_assets.py`：扩展批次/资产请求模型；实现名称校验、分页搜索、批次名维护和空批次删除；使入库、单件建档、导入按所选批次原子写入并继承状态；导出与响应返回名称及设备数。
- `tests/test_equipment_assets.py`：增加 API、事务、权限、审计、状态继承及空批次删除契约测试。
- `tests/test_migration_revision_ids.py`：确认新迁移 revision 唯一且不超过 Alembic 版本列限制；必要时新增迁移回填契约测试文件。
- `web/lib/api.ts`：定义批次名称/设备数类型及带搜索的批次 API、重命名/删除 API、新建或复用的入库与导入请求类型。
- `web/lib/equipmentAssetsApi.vitest.test.ts`：验证新增批次查询、写入和导入 multipart/API 路由。
- `web/app/(dashboard)/assets/page.tsx`：增加远程批次选择器；扩展入库、导入和列表交互，显示批次名称与设备数，支持重命名和确认删除。
- `web/lib/assetsPage.dom.vitest.test.tsx`：覆盖模式切换、批次复用、整份导入、验收状态、重命名和空批次删除交互。

## Task 1: Schema migration and batch identity

**Files:**
- Create: `api/alembic/versions/0031_equipment_batch_names.py`
- Modify: `api/models/__init__.py:962-974`
- Modify: `tests/test_migration_revision_ids.py`
- Test: `tests/test_migration_revision_ids.py`

**Interfaces:**
- Produces: `EquipmentBatch.name: str`，必填，最长 128 个字符；PostgreSQL expression unique index `uq_equipment_batches_name_lower`。
- Migration: `revision = "0031_equipment_batch_names"`，`down_revision = "0030_equipment_event_purge_gate"`。

- [ ] **Step 1: Write schema contract tests**：在 `tests/test_equipment_assets.py` 增加批次名 trim、空名/超长/大小写重名拒绝测试；在迁移 revision 测试确认 revision 唯一且长度不超过 32。
- [ ] **Step 2: Run targeted tests and confirm the expected failure**：运行 `pytest tests/test_equipment_assets.py -q`；未实现时，批次响应尚无 `name` 或请求校验不满足新契约。若未设置 `TEST_DATABASE_URL`，记录该套件被 fixture skip，并用静态迁移测试验证结构。
- [ ] **Step 3: Add model and migration**：`EquipmentBatch` 增加非空 `name = Column(String(128), nullable=False)`；模型的 `__table_args__` 声明 `Index("uq_equipment_batches_name_lower", func.lower(name), unique=True)`。迁移依次新增可空列、执行 `UPDATE equipment_batches SET name = '批次 #' || id::text`、设为非空、创建同名 lower 唯一索引。downgrade 删除索引和列。
- [ ] **Step 4: Verify revision and schema tests**：运行 `pytest tests/test_migration_revision_ids.py tests/test_equipment_assets.py -q`；revision 静态测试通过；API 测试在 PostgreSQL 测试环境运行通过或明确标记跳过。
- [ ] **Step 5: Commit schema unit**：`git add api/alembic/versions/0031_equipment_batch_names.py api/models/__init__.py tests/test_migration_revision_ids.py tests/test_equipment_assets.py && git commit -m "feat: add equipment batch names"`。

## Task 2: Batch API, audit, lifecycle and creation endpoints

**Files:**
- Modify: `api/routers/equipment_assets.py`
- Modify: `tests/test_equipment_assets.py`

**Interfaces:**
- `BatchIn`: 增加 `name: str = ""`、`batch_id: int | None = None`；创建新批次时 name 必填且 batch_id 为空；复用时 batch_id 必填，name 为空。supplier 等既有元数据仅用于新建批次。
- `AssetCreateIn(AssetIn)`: 增加 `batch_id: int | None = None`；省略时保留既有无批次行为。
- `EquipmentBatchPatch`: `{name: str}`。
- `GET /equipment-assets/batches`: 接受 `keyword`, `page`, `size`；每个批次返回 `asset_count`。
- `PATCH /equipment-assets/batches/{batch_id}`：管理员重命名，返回更新后的批次。
- `DELETE /equipment-assets/batches/{batch_id}`：管理员删除无资产、无流水的空批次，返回 `{ok: true, id: number}`。
- Produces: `_normalize_batch_name(name) -> str`、`_create_batch(db, user, ...)` 和 `_get_batch(db, batch_id, lock=True)` 共用批次验证/锁定逻辑。

- [ ] **Step 1: Add failing API tests**：覆盖新批次创建并返回名称、跨两次入库复用同 `batch_id`、批次元数据不变、待验收/已验收状态继承、单件建档传 `batch_id`、名称重命名成功/重复拒绝/权限/审计、搜索分页和计数、空批次删除成功/有资产或流水拒绝/权限/审计。
- [ ] **Step 2: Run each focused test and confirm failures**：运行 `pytest tests/test_equipment_assets.py -q`；在有 `TEST_DATABASE_URL` 时应因路由/响应尚未实现而失败，未配置数据库时应明确报告 fixture skip。
- [ ] **Step 3: Implement shared validation and lock helpers**：trim 后校验名称非空、长度 ≤128；先查重并在 `flush()` 捕获 `IntegrityError`，转为 HTTP 400“批次名称已存在，请选择已有批次或更换名称”；已有批次用 `with_for_update()` 加锁并返回 404（不存在）。
- [ ] **Step 4: Implement inbound and single-asset batch association**：入库请求严格要求二选一：新建名称或已有 batch_id；复用时忽略/拒绝新建元数据，不改原批次；按 `acceptance_status` 设置每件设备状态。单件 POST 可传 batch_id，复用时状态同样从批次派生；省略 batch_id 时仍创建无批次 `available` 资产。
- [ ] **Step 5: Implement batch listing, rename and deletion**：列表在分页查询中 join/group count 当前资产，keyword 匹配 name/source 及批次 ID；rename 校验管理员和名称唯一后调用 `commit_audited(..., "rename_equipment_batch", ...)`。delete 管理员锁批次后检查 `EquipmentAsset` 与 `EquipmentEvent` 引用；非空返回 HTTP 409；空批次先保存 ID/name 审计细节并同事务删除与审计。
- [ ] **Step 6: Verify API contract and regressions**：运行 `pytest tests/test_equipment_assets.py -q`；检查新增场景通过且既有设备生命周期、不可变流水、导入和统计测试不回归。
- [ ] **Step 7: Commit backend batch API**：`git add api/routers/equipment_assets.py tests/test_equipment_assets.py && git commit -m "feat: manage reusable equipment batches"`。

## Task 3: Atomic file import and export compatibility

**Files:**
- Modify: `api/routers/equipment_assets.py`
- Modify: `tests/test_equipment_assets.py`

**Interfaces:**
- `POST /equipment-assets/import` multipart fields：`file` 必填；二选一提供 `batch_id` 或新建 `batch_name`。新建时可选 `source`, `supplier`, `purchase_order_no`, `invoice_no`, `acceptance_status`, `note`；默认 source 为 `导入 <文件名>`，acceptance_status 为 `accepted`。
- `EquipmentImportResult`: `{batch_id: number, batch_name: string, created: number, ignored_columns?: ...}`。
- 所有导入资产通过前序任务的 `_create_batch` 或 `_get_batch(..., lock=True)` 关联，并从所选批次得到初始状态。

- [ ] **Step 1: Write failing CSV/XLSX import tests**：对 CSV 与 XLSX 测试整文件复用已有批次、待验收状态继承、批次元数据不变；对新建批次测试自定义名称/导入来源默认值；不合格行后断言 batch、asset、event 数量都没有改变。
- [ ] **Step 2: Run focused import tests**：运行 `pytest tests/test_equipment_assets.py -q`；未实现时新请求字段测试失败，确认旧导入兼容测试仍可定位。
- [ ] **Step 3: Extend multipart import signature**：从 FastAPI `Form` 读取上述字段；保持文件大小、CSV/XLSX解析、表头识别、逐行校验和忽略列响应原逻辑。
- [ ] **Step 4: Commit batch only after row validation**：解析全部行并通过 `_validate` 后才创建或锁定批次；在同一 DB transaction 内 flush 批次、写全部资产和事件、调用 `commit_audited`。失败则 rollback；复用待验收批次时传 `pending_acceptance` 给 `_add_asset`。
- [ ] **Step 5: Include batch identity in results and exports**：导入成功返回 batch_name；导出台账“所属批次”使用 `<name> · 批次 #<id>`；旧导入模板设备列不增加批次列。
- [ ] **Step 6: Verify both formats and existing import rules**：运行 `pytest tests/test_equipment_assets.py -q`；确认 CSV/XLSX、新旧模板、序列号重复、行错误原子性及导出公式防护均通过。
- [ ] **Step 7: Commit import/export unit**：`git add api/routers/equipment_assets.py tests/test_equipment_assets.py && git commit -m "feat: import equipment into selected batches"`。

## Task 4: TypeScript API contracts and request tests

**Files:**
- Modify: `web/lib/api.ts:1781-1856`
- Modify: `web/lib/equipmentAssetsApi.vitest.test.ts`

**Interfaces:**
- `EquipmentBatch` 增加 `name: string`、`asset_count: number`。
- `EquipmentBatchSelection` 为 `{ batch_id: number } | { batch_id?: undefined; name: string; source?: string; supplier?: string; purchase_order_no?: string; invoice_no?: string; acceptance_status?: "pending_acceptance" | "accepted"; note?: string }`。
- `equipmentAssetsApi.batches(params: {keyword?: string; page?: number; size?: number}, signal?)`；`renameBatch(id, {name})`；`removeBatch(id)`；`inbound(selection & {items: EquipmentWrite[]})`；`upload(file, selection)`。

- [ ] **Step 1: Add failing API wrapper tests**：用 mock fetch 断言批次搜索参数、PATCH 重命名 body、DELETE route、入库新建/复用 body，以及上传 FormData 的 file、batch_id 或 batch_name 字段。
- [ ] **Step 2: Run the focused Vitest file**：`cd web && npx vitest run lib/equipmentAssetsApi.vitest.test.ts`；新路由尚不存在时测试失败。
- [ ] **Step 3: Extend types and API methods**：按接口类型定义批次元信息；统一 `batches` 入参；增加 rename/removeBatch；inbound 传完整选择联合类型；upload 将 file 与 selection 共同 append 到 FormData。
- [ ] **Step 4: Verify API wrapper tests and types**：运行 `cd web && npx vitest run lib/equipmentAssetsApi.vitest.test.ts && npx tsc --noEmit`；断言 multipart 只含当前模式所需字段。
- [ ] **Step 5: Commit API contract**：`git add web/lib/api.ts web/lib/equipmentAssetsApi.vitest.test.ts && git commit -m "feat: expose equipment batch APIs"`。

## Task 5: Batch selector, inbound and import UX

**Files:**
- Modify: `web/app/(dashboard)/assets/page.tsx`
- Modify: `web/lib/assetsPage.dom.vitest.test.tsx`
- Modify: `web/app/(dashboard)/assets/assets.css`（只在现有样式无法表达选择器/批次控件时新增局部样式）

**Interfaces:**
- 页面内 `BatchPicker` 使用 `equipmentAssetsApi.batches({keyword, page: 1, size: 20}, signal)` 远程搜索，选择值为 `EquipmentBatch | null`。
- `InboundForm` 提交 `EquipmentBatchSelection & {items: EquipmentWrite[]}`；新建/复用两种模式互斥。
- `ImportDialog` 的 `onImported` 继续接收 `batch_id`, `created`，并增加 `batch_name`。

- [ ] **Step 1: Add failing DOM tests for inbound mode selection**：测试默认/新建批次需要名称；可切换到复用并按关键词选择批次；一件和多件设备都提交相同的选择对象；已有批次的状态提示可见且批次元数据不作为更新提交。
- [ ] **Step 2: Add failing DOM tests for import selection**：测试整份 CSV/XLSX 只上传一次所选 batch selection；新建批次模式将 name 与 `导入 <filename>` 来源传给 API；待验收状态可选择；模板下载入口保留。
- [ ] **Step 3: Implement remote `BatchPicker`**：搜索输入使用 250 ms debounce；输入变更后通过 `useAsyncData` 拉取第一页 20 个结果；每项显示名称、批次编号、来源、验收状态；加载/空结果/错误在控件旁显示；更改模式时清空不匹配的选择状态。
- [ ] **Step 4: Refactor `InboundForm` submission**：新增模式渲染批次名称和当前元数据/验收表单；复用模式显示 BatchPicker 及选中批次信息；提交函数根据模式构造互斥 payload；件数 1-30 的既有规则不变。
- [ ] **Step 5: Refactor `ImportDialog`**：上传前校验选择；在 API 请求前把选中文件名写入默认 source；新建模式可编辑 name、验收状态及采购元数据，复用模式提交 batch_id；成功通知显示 `batch_name · 批次 #id` 和数量。
- [ ] **Step 6: Run focused DOM tests and type checking**：运行 `cd web && npx vitest run lib/assetsPage.dom.vitest.test.tsx && npx tsc --noEmit`；确认既有资产详情、删除、批次分页及导入错误测试通过。
- [ ] **Step 7: Commit entry and import UX**：`git add 'web/app/(dashboard)/assets/page.tsx' web/lib/assetsPage.dom.vitest.test.tsx 'web/app/(dashboard)/assets/assets.css' && git commit -m "feat: select equipment batches when entering assets"`（若 CSS 没有变化，从 git add 命令中省略 CSS 路径）。

## Task 6: Batch list management and destructive confirmation

**Files:**
- Modify: `web/app/(dashboard)/assets/page.tsx`
- Modify: `web/lib/assetsPage.dom.vitest.test.tsx`
- Modify: `web/app/(dashboard)/assets/assets.css`

**Interfaces:**
- 列表操作调用 `equipmentAssetsApi.renameBatch(id, {name})` 和 `equipmentAssetsApi.removeBatch(id)`。
- 删除确认只对 `asset_count === 0` 且管理员显示；删除确认窗口关闭或取消时不得调用 API。

- [ ] **Step 1: Add failing batch list tests**：断言批次名称/编号、设备数、空批次标签和分页/搜索显示；管理员能重命名且冲突错误显示；空批次删除需确认，取消不调用 API，确认调用一次并刷新；有设备时无删除按钮；非管理员没有维护按钮。
- [ ] **Step 2: Run focused DOM tests and confirm failure**：运行 `cd web && npx vitest run lib/assetsPage.dom.vitest.test.tsx`；新批次维护断言失败。
- [ ] **Step 3: Implement list search and counts**：批次列表增加搜索输入并将 keyword 传给 batches API；行内显示批次名、编号、来源/采购信息、状态、设备数/空批次；加载设备明细仍用 batch detail。
- [ ] **Step 4: Implement rename interaction**：管理员打开轻量编辑对话框，预填名称；trim 后调用 renameBatch；后端错误通过 `errText` 显示；成功关闭对话框、刷新列表与选择器可见数据并提示。
- [ ] **Step 5: Implement guarded delete interaction**：管理员且计数为 0 才显示删除按钮；Dialog 展示批次名称/编号和无设备提示；busy 时禁用取消/确认；确认成功后清除当前 batch detail（如果相同）、刷新列表并提示。
- [ ] **Step 6: Verify UI and API wrapper tests**：运行 `cd web && npx vitest run lib/assetsPage.dom.vitest.test.tsx lib/equipmentAssetsApi.vitest.test.ts && npx tsc --noEmit`。
- [ ] **Step 7: Commit batch list management**：`git add 'web/app/(dashboard)/assets/page.tsx' web/lib/assetsPage.dom.vitest.test.tsx 'web/app/(dashboard)/assets/assets.css' && git commit -m "feat: manage empty equipment batches"`。

## Task 7: Migration and full regression verification

**Files:**
- Review: `api/alembic/versions/0031_equipment_batch_names.py`
- Review: `tests/test_equipment_assets.py`
- Review: `web/app/(dashboard)/assets/page.tsx`

- [ ] **Step 1: Run migration graph check**：运行 `cd api && alembic heads`，期望唯一 head 为 `0031_equipment_batch_names`；运行 `alembic upgrade head --sql`，确认 SQL 有回填语句及 lower(name) 唯一索引。
- [ ] **Step 2: Run backend regression tests**：运行 `pytest tests/test_equipment_assets.py tests/test_migration_revision_ids.py -q`；若 `TEST_DATABASE_URL` 缺失，单独记录接口测试被跳过，不能把 skip 说成通过。
- [ ] **Step 3: Run frontend regression tests**：运行 `cd web && npm test`，期望 unit、Vitest 两套测试退出码均为 0。
- [ ] **Step 4: Inspect final diff and status**：运行 `git diff --check`、`git status --short`、`git diff --stat`；确认没有改动设计范围外的设备流转界面或无关文件。
- [ ] **Step 5: Report evidence and remaining environment constraints**：汇报具体运行命令、通过/失败/跳过结果、Alembic head 和分支/worktree；不得将未运行或被跳过的测试表述为通过。
