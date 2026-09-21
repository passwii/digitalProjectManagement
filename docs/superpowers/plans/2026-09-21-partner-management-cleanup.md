# 友商管理清理与合同附件上传实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 移除友商类型和人员信息链路，保留友商名称搜索、业绩合同，并在添加业绩入口旁接入现有 R2 合同附件上传和在线预览。

**Architecture:** 后端从模型、Pydantic 入参、序列化和路由中完整移除 `partner_type` 与 `PartnerMember`；前端同步删除类型筛选、类型表单和人员区域。合同附件按钮复用 `useUploadQueue`、`partnersApi.upload` 和现有附件预览组件，固定使用 `contract` 分类。新增 Alembic 迁移删除数据库结构，部署沿用 `scripts/deploy_vps.py`。

**Tech Stack:** FastAPI、SQLAlchemy、Alembic、PostgreSQL、Next.js 14、React、TypeScript、Node test、pytest、Docker Compose、Cloudflare R2。

## Global Constraints

- 保留 `/partners` 模块、管理员权限、友商删除、业绩合同、附件下载/删除和 PDF/图片预览。
- 友商搜索只匹配 `partners.name`，列表不再发送 `partner_type`。
- 合同附件必须走现有 R2 上传链路，不新增本地持久化实现。
- 数据库降级只能恢复空结构，不能恢复已删除的人员数据。
- 不覆盖工作区已有的项目台账改动，提交时按文件精确暂存。
- Git 提交信息使用中文，VPS 发布只使用已有生产 Compose 配置和 `/opt/pm`。

---

### Task 1: 先写并验证失败测试

**Files:**
- Modify: `tests/test_partners.py`
- Create: `web/lib/partnerManagementFields.test.ts`

**Interfaces:** 测试定义 Task 2–3 必须满足的 API 和页面源码契约。

- [ ] **Step 1: 调整后端友商测试契约**

将 `_create_partner` 默认 body 改为 `{"name": "嵩讯科技", **overrides}`；移除旧的类型筛选、人员 CRUD、人员级联和类型字典断言；保留合同和附件测试，并加入：

```python
def test_partner_search_is_name_only(client, db):
    h = login(client, "admin")
    _create_partner(client, h, name="名称命中友商", contact_name="联系人命中")
    _create_partner(client, h, name="另一个友商", phone="13800138000")

    assert client.get("/api/v1/partners?keyword=名称命中", headers=h).json()["total"] == 1
    assert client.get("/api/v1/partners?keyword=联系人命中", headers=h).json()["total"] == 0
    assert client.get("/api/v1/partners?keyword=13800138000", headers=h).json()["total"] == 0


def test_partner_payload_excludes_removed_fields(client, db):
    h = login(client, "admin")
    created = _create_partner(client, h, name="字段清理友商", partner_type="旧类型")
    assert "partner_type" not in created
    assert "members" not in created
    assert "member_count" not in created

    detail = client.get(f"/api/v1/partners/{created['id']}", headers=h).json()
    assert "partner_type" not in detail
    assert "members" not in detail
    assert client.get(f"/api/v1/partners/{created['id']}/members", headers=h).status_code == 404
```

附件测试另外断言 `category="contract"` 的 PDF 上传返回合同分类并可从合同分类列表读取。

- [ ] **Step 2: 新增前端源代码契约测试**

创建 `web/lib/partnerManagementFields.test.ts`：

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const root = join(process.cwd(), "app/(dashboard)/partners");
const list = readFileSync(join(root, "page.tsx"), "utf8");
const drawer = readFileSync(join(root, "PartnerDrawer.tsx"), "utf8");

test("友商列表只保留名称搜索", () => {
  assert.doesNotMatch(list, /partner_type|友商类型|人员数/);
  assert.match(list, /搜索友商名称/);
});

test("友商档案移除类型和人员区域", () => {
  assert.doesNotMatch(drawer, /partner_type|友商类型|人员信息|PartnerMember|membersApi/);
});

test("添加业绩旁使用合同分类上传附件", () => {
  assert.match(drawer, /合同附件/);
  assert.match(drawer, /partnersApi\.upload\(partner\.id,\s*["']contract["']/);
  assert.match(drawer, /useUploadQueue/);
});
```

- [ ] **Step 3: 运行红测**

运行 `pytest -q tests/test_partners.py` 和 `cd web && npm run test:unit`；预期失败原因是现有代码仍暴露旧字段/人员区域且尚未有合同上传按钮，不能接受测试语法错误。

---

### Task 2: 移除后端友商类型和人员信息

**Files:**
- Modify: `api/models/__init__.py`
- Modify: `api/routers/partners.py`
- Modify: `api/seed.py`
- Create: `api/alembic/versions/0023_remove_partner_type_and_members.py`
- Test: `tests/test_partners.py`

**Interfaces:** Partner 创建、更新、列表、详情不再返回 `partner_type`、`member_count`、`members`；合同和附件路由保持可用。

- [ ] **Step 1: 修改模型和路由**

删除 `Partner.partner_type`、`Partner.members`、整个 `PartnerMember` 类及 `partners.py` 中对应 import、Pydantic 类、序列化函数、校验函数和人员 CRUD 路由。将后端常量收敛为：

```python
PARTNER_SORTS = {"id": Partner.id, "name": Partner.name, "updated_at": Partner.updated_at}
PARTNER_TEXT_LIMITS = {
    "contact_name": 64,
    "phone": 64,
    "email": 128,
    "address": 255,
    "remark": 1000,
}
```

`PartnerIn` 只保留 `name`、`contact_name`、`phone`、`email`、`address`、`remark`；列表签名删除 `partner_type`，keyword 条件只使用 `Partner.name.ilike(...)`；详情只附加合同列表，列表只附加 `contract_count`。从 `api/seed.py` 删除 `partner_type` 字典项。

- [ ] **Step 2: 添加迁移**

创建 `api/alembic/versions/0023_remove_partner_type_and_members.py`，upgrade 检查表/列后删除 `partner_members` 和 `partners.partner_type`，downgrade 恢复空列和空表：

```python
"""移除友商类型字段和人员子表。"""
from alembic import op
import sqlalchemy as sa

revision = "0023_remove_partner_type_and_members"
down_revision = "0022_remove_project_directional_contracts"
branch_labels = None
depends_on = None

def upgrade():
    inspector = sa.inspect(op.get_bind())
    if "partner_members" in inspector.get_table_names():
        op.drop_table("partner_members")
    if "partner_type" in {c["name"] for c in inspector.get_columns("partners")}:
        op.drop_column("partners", "partner_type")
```

降级需要用 `op.add_column`、`op.create_table` 和 `op.create_index("ix_partner_members_partner_id", ...)` 恢复原结构，不能尝试恢复人员数据。

- [ ] **Step 3: 运行后端绿测**

运行 `pytest -q tests/test_partners.py`；若失败只修正本次字段/路由契约或测试，不恢复已删除的接口。

---

### Task 3: 更新前端并接入合同附件上传

**Files:**
- Modify: `web/app/(dashboard)/partners/page.tsx`
- Modify: `web/app/(dashboard)/partners/PartnerDrawer.tsx`
- Modify: `web/lib/api.ts`
- Test: `web/lib/partnerManagementFields.test.ts`

**Interfaces:** `Partner` 不再暴露旧字段；`partnersApi.upload(partnerId, "contract", file, options)` 是合同附件唯一写入口。

- [ ] **Step 1: 清理 API 类型与方法**

从 `web/lib/api.ts` 删除 `PartnerMember`、Partner 的 `partner_type`/`member_count`/`members` 以及成员方法，保留 `PartnerContract` 和合同方法。

- [ ] **Step 2: 精简列表**

在 `page.tsx` 使用 `const URL_DEFAULTS = { q: "", page: "1", size: "20" }`；删除类型字典加载、类型 state、筛选参数、类型筛选器和类型/人员数量列。搜索 placeholder 改为 `搜索友商名称…`，列表 query 只传 `keyword: url.q.trim()` 和分页排序参数。

- [ ] **Step 3: 清理档案抽屉**

删除 `DictItem`、`PartnerMember`、`partner_type` 表单字段、成员 draft/state/CRUD/effect 和“人员信息” JSX；组件 props 删除 `typeOptions`；保留基本信息、业绩合同和附件区。

- [ ] **Step 4: 在添加业绩后接入 R2 合同上传**

将上传函数改为 `uploadPicked(files: File[], uploadCategory: PartnerAttachmentCategory = category)`，内部调用 `partnersApi.upload(partner.id, uploadCategory, file, options)`；在“添加业绩”后增加按钮型 `FileDropZone`，关键属性为：

```tsx
label="上传合同附件"
accept={PARTNER_ATTACHMENT_EXTENSIONS}
onFiles={(picked) => void uploadPicked(picked, "contract")}
```

普通附件分类选择器过滤掉 `contract`，合同列表仍使用现有预览、下载和删除逻辑。

- [ ] **Step 5: 运行前端绿测**

运行 `cd web && npm run test:unit && npm run test:motion`，确认源码契约、TypeScript 和已有 Vitest 测试通过。

---

### Task 4: 全量验证并提交

**Files:** Task 1–3 文件；不改 `.env` 或 VPS 配置。

- [ ] **Step 1: 运行验证**

运行：

```bash
pytest -q
cd web && npm run test:unit && npm run test:motion && npm run build
cd .. && git diff --check && python -m compileall -q api scripts
```

确认 Alembic 链为 `0023 -> 0022`，构建和测试均成功。

- [ ] **Step 2: 精确暂存并提交**

保留工作区已有项目台账改动，至少精确暂存本次友商文件和测试：

```bash
git add api/models/__init__.py api/routers/partners.py api/seed.py \
  api/alembic/versions/0023_remove_partner_type_and_members.py tests/test_partners.py \
  web/app/'(dashboard)'/partners/page.tsx web/app/'(dashboard)'/partners/PartnerDrawer.tsx \
  web/lib/api.ts web/lib/partnerManagementFields.test.ts
git commit -m "功能：清理友商字段并支持合同附件上传"
```

---

### Task 5: 推送并部署 VPS

**Files:** Use `scripts/deploy_vps.py`; do not edit production secrets.

- [ ] **Step 1: 检查远端并推送**

运行 `git fetch origin main`、`git log --oneline -3 origin/main`、`git status --short`；确认没有远端分叉且工作区干净后，运行 `git push origin HEAD:main`。若远端发生分叉则停止，不强推。

- [ ] **Step 2: 执行标准发布**

运行 `python scripts/deploy_vps.py`。脚本必须完成 `/opt/pm` 快进拉取、Docker Compose 重建、服务状态检查以及 `http://127.0.0.1:8001/health` 检查。

- [ ] **Step 3: 验证生产迁移**

运行：

```bash
ssh -o BatchMode=yes -o ConnectTimeout=20 root@145.79.143.98 \
  'cd /opt/pm && docker compose -f docker-compose.yml -f docker-compose.prod.yml exec -T api alembic current'
```

预期版本包含 `0023_remove_partner_type_and_members`；若部署或健康检查失败，报告实际错误并停止，不声称部署成功。
