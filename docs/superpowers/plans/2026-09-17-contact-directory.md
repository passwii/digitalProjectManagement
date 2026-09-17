# 通讯录花名册 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 增加管理员专用的通讯录花名册，支持无账号人员建档、可选关联现有账号和六类证件/合同附件管理。

**Architecture:** `contact_profiles` 是人员主数据，`user_id` 可选唯一关联现有账号；附件复用 `attachments` 的 `contact + contact_id` 归属；FastAPI 提供 admin-only API，Next.js 新增 `/contacts` 页面和编辑抽屉。

**Tech Stack:** FastAPI、SQLAlchemy、Alembic、PostgreSQL、pytest、Next.js 14、React 18、TypeScript。

## Global Constraints

- 通讯录所有 API 仅管理员可访问，非管理员先鉴权后读写并返回 `403`。
- 人员可以没有系统账号；账号关联是可选能力。
- 附件单文件不超过 20MB，扩展名仅允许 `.pdf/.doc/.docx/.xls/.xlsx/.png/.jpg/.jpeg`。
- 敏感附件和档案更新必须写审计。
- 沿用现有列表分页信封、`require_admin`、`commit_audited`、`Dialog/Drawer/Field` 组件。

---

### Task 1: 数据模型与迁移

**Files:**
- Modify: `api/models/__init__.py`
- Create: `api/alembic/versions/0008_contact_profiles.py`
- Create: `api/alembic/versions/0009_contact_roster_independent.py`
- Create: `tests/test_contacts.py`

**Interfaces:**
- Produces: `ContactProfile` ORM 模型，字段见 `docs/superpowers/specs/2026-09-17-contact-directory-design.md`。
- Produces: Alembic revision `0008_contact_profiles`，`down_revision="0007_project_contracts"`。

- [x] **Step 1: 写模型存在性与唯一约束测试**

```python
def test_contact_profile_model(db):
    from api.models import ContactProfile
    S = db()
    row = ContactProfile(user_id=1, employee_no="E001", position="工程师")
    S.add(row)
    S.commit()
    assert row.id
```

- [x] **Step 2: 运行测试确认失败**

Run: `pytest tests/test_contacts.py::test_contact_profile_model -q`
Expected: FAIL，`ContactProfile` 不存在。

- [x] **Step 3: 添加模型与迁移**

在 `api/models/__init__.py` 新增 `ContactProfile`；`0008` 创建基础表，`0009` 将通讯录升级为人员主表，把 `user_id` 改为可选关联，并回填现有账号人员。

- [x] **Step 4: 运行模型测试**

Run: `pytest tests/test_contacts.py::test_contact_profile_model -q`
Expected: PASS。

### Task 2: 管理员通讯录 API

**Files:**
- Create: `api/routers/contacts.py`
- Modify: `api/main.py`
- Modify: `tests/test_contacts.py`

**Interfaces:**
- Consumes: `ContactProfile`、`Attachment`、`require_admin`、`paginate`、`commit_audited`。
- Produces: `GET /api/v1/contacts`、`GET/PATCH /api/v1/contacts/{uid}`。

- [x] **Step 1: 写权限、分页、upsert 和工号唯一测试**

```python
def test_contacts_admin_only(client):
    h = login(client, "pm")
    assert client.get("/api/v1/contacts", headers=h).status_code == 403

def test_contact_upsert(client):
    h = login(client, "admin")
    r = client.patch("/api/v1/contacts/1", headers=h, json={"employee_no": "E001"})
    assert r.status_code == 200 and r.json()["employee_no"] == "E001"
```

- [x] **Step 2: 运行测试确认失败**

Run: `pytest tests/test_contacts.py -q`
Expected: contacts 路由与断言失败。

- [x] **Step 3: 实现路由并注册**

实现合并查询、日期/身份/合同校验、唯一工号、账号姓名与部门同步、审计。

- [x] **Step 4: 运行 API 测试**

Run: `pytest tests/test_contacts.py -q`
Expected: PASS。

### Task 3: 通讯录附件

**Files:**
- Modify: `api/routers/contacts.py`
- Modify: `tests/test_contacts.py`

**Interfaces:**
- Produces: 附件列表、上传、下载、删除接口。

- [x] **Step 1: 写附件全链路和类型拦截测试**

```python
def test_contact_attachment_flow(client):
    h = login(client, "admin")
    r = client.post("/api/v1/contacts/1/attachments", headers=h,
                    data={"category": "id_card"},
                    files={"file": ("id.png", b"png", "image/png")})
    assert r.status_code == 200
```

- [x] **Step 2: 运行测试确认失败**

Run: `pytest tests/test_contacts.py::test_contact_attachment_flow -q`
Expected: FAIL，接口不存在。

- [x] **Step 3: 实现附件接口**

使用 `ROOT / "data" / "files" / "contacts"`，随机文件名，分类白名单和扩展名白名单。

- [x] **Step 4: 运行附件测试**

Run: `pytest tests/test_contacts.py -q`
Expected: PASS。

### Task 4: 菜单与前端 API

**Files:**
- Modify: `api/routers/meta.py`
- Modify: `web/lib/api.ts`
- Modify: `web/app/(dashboard)/layout.tsx`

**Interfaces:**
- Produces: `contactsApi` TypeScript 客户端和 `/contacts` 管理员菜单。

- [x] **Step 1: 写菜单契约测试**

```python
def test_contacts_menu_admin_only(client):
    assert any(m["href"] == "/contacts" for m in client.get("/api/v1/meta/me/menus", headers=login(client, "admin")).json()["menus"])
    assert all(m["href"] != "/contacts" for m in client.get("/api/v1/meta/me/menus", headers=login(client, "pm")).json()["menus"])
```

- [x] **Step 2: 运行测试确认失败**

Run: `pytest tests/test_contacts.py::test_contacts_menu_admin_only -q`
Expected: FAIL，管理员菜单没有 `/contacts`。

- [x] **Step 3: 添加菜单、类型与请求方法**

菜单只在 admin 下追加；前端类型覆盖档案、筛选、附件分类和上传方法；导航加入通讯录图标和“管理与审批”分组。

- [x] **Step 4: 运行菜单测试**

Run: `pytest tests/test_contacts.py::test_contacts_menu_admin_only -q`
Expected: PASS。

### Task 5: 通讯录页面

**Files:**
- Create: `web/app/(dashboard)/contacts/page.tsx`
- Create: `web/app/(dashboard)/contacts/ContactDrawer.tsx`

**Interfaces:**
- Consumes: `contactsApi`、`useMeta`、`Drawer`、`Field`、`PageState`、`Pagination`、`Toast`。
- Produces: `/contacts` 完整列表、筛选、录入抽屉和附件上传下载删除。

- [x] **Step 1: 实现列表与筛选**

展示姓名、手机号、工号、部门、岗位、用工类型、任职状态、入职日期、附件数、建档状态；筛选写入 URL。

- [x] **Step 2: 实现档案抽屉**

所有字段分组编辑，保存后刷新列表和抽屉；空档案可一次补录。

- [x] **Step 3: 实现附件区**

分类选择、上传、下载、删除；失败使用 Toast 提示。

- [x] **Step 4: 前端构建**

Run: `cd web && npm run build`
Expected: 编译通过，0 errors。

### Task 6: 全量验证

**Files:**
- Modify: `README.md`

- [x] **Step 1: 更新功能文档**

在 README 的功能一览中新增通讯录说明。

- [x] **Step 2: 运行后端测试**

Run: `TEST_DATABASE_URL="$DATABASE_URL" pytest tests/test_contacts.py -q`
Expected: PASS。

- [x] **Step 3: 运行现有回归**

Run: `TEST_DATABASE_URL="$DATABASE_URL" pytest tests/test_mvp.py tests/test_stage4a_closure.py -q`
Expected: PASS。

- [x] **Step 4: 运行前端构建**

Run: `cd web && npm run build`
Expected: PASS。
