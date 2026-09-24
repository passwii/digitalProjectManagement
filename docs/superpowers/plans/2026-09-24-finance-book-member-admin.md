# 财务账套成员与角色管理实施计划

> **面向执行者：** 本计划由当前会话在隔离工作区内联执行；每一步均对应可检查的交付。

**目标：** 在财务工作台为系统管理员增加按账套查看、授予、调整和移除成员角色的操作界面。

**架构：** `web/lib/api.ts` 封装既有账套成员 API 与人员分页搜索 API；独立的 `BookMembersDialog.tsx` 负责账套成员列表、搜索、角色保存和确认移除；财务工作台只负责根据管理员状态和当前账套展示入口并挂载弹窗。后端继续执行管理员鉴权和审计，不新增数据库迁移。

**技术栈：** Next.js 14、React 18、TypeScript、现有 `useAsyncData`、`financeApi`/`metaApi`、通用 `Dialog`/`Confirm`/`Toast`。

## 全局约束

- 只允许系统管理员访问成员管理入口；后端既有管理员鉴权是最终安全边界。
- 成员角色仅限 `finance_clerk`、`finance_reviewer`、`cashier`、`finance_manager`、`finance_auditor`。
- 新授权候选人来自 `/meta/users/search`，查询条件为 `status=active`，每页 20 人。
- 不新增或运行测试套件；交付前执行 TypeScript 静态检查、Next 生产构建和 `git diff --check`。

---

## 文件职责

- 修改 `web/lib/api.ts`：增加 `FinanceBookMember`、成员 CRUD 客户端以及分页用户搜索客户端。
- 创建 `web/app/(dashboard)/finance/BookMembersDialog.tsx`：独立封装成员列表、用户搜索、角色增改、移除确认和异步状态。
- 修改 `web/app/(dashboard)/finance/page.tsx`：在管理员和当前账套条件成立时显示入口并挂载成员弹窗。
- 设计与计划分别保存在 `docs/superpowers/specs/2026-09-24-finance-book-member-admin-design.md` 和本文件。

## 任务一：补齐 API 客户端

**接口定义：**

```ts
export type FinanceRole =
  | "finance_clerk"
  | "finance_reviewer"
  | "cashier"
  | "finance_manager"
  | "finance_auditor";

export interface FinanceBookMember {
  id: number;
  user_id: number;
  username: string;
  real_name: string;
  role: string;
}
```

在 `financeApi` 内添加：

```ts
members: (bookId: number, signal?: AbortSignal) =>
  apiGet<FinanceBookMember[]>(`/finance/books/${bookId}/members`, signal),
saveMember: (bookId: number, userId: number, role: FinanceRole) =>
  apiPut<FinanceBookMember>(`/finance/books/${bookId}/members/${userId}`, { role }),
removeMember: (bookId: number, userId: number) =>
  apiDelete<{ deleted: boolean; user_id: number }>(`/finance/books/${bookId}/members/${userId}`),
```

在 `metaApi` 添加分页搜索：

```ts
searchUsers: (
  params: { keyword?: string; status?: string; page?: number; size?: number },
  signal?: AbortSignal,
) => apiGet<Paged<UserOption>>(`/meta/users/search${buildQuery(params)}`, signal),
```

- [x] 确认 `apiPut`、`apiDelete`、`Paged<T>` 和 `buildQuery` 的现有签名。
- [x] 增加类型和三个账套成员方法，URL/body 与后端接口保持一致。
- [x] 增加分页用户搜索方法，不改变 `metaApi.users(signal)` 的既有签名。

## 任务二：实现成员管理弹窗

**新建：** `web/app/(dashboard)/finance/BookMembersDialog.tsx`

**属性：**

```ts
interface BookMembersDialogProps {
  open: boolean;
  book: FinanceBook | null;
  onClose: () => void;
  onChanged: (change: "granted" | "role_changed" | "removed") => void;
}
```

- [x] 用 `useAsyncData` 加载 `financeApi.members(book.id, signal)`，依赖 `open` 和 `book.id`；关闭弹窗时清空成员/搜索缓存，组件按账套 ID 隔离，切换账套时禁用旧请求并重置数据。
- [x] 用独立 `useAsyncData` 搜索 `metaApi.searchUsers({ keyword: debouncedKeyword, status: "active", page: userPage, size: 20 }, signal)`；结果过滤当前账套已有 `user_id`，并提供上一页/下一页及总人数提示。
- [x] 显示姓名、账号、中文角色名称；历史非财务角色显示原值提示，选择合法角色后可保存；每行提供角色选择、仅在角色变化时可用的保存按钮和移除按钮。
- [x] 新增区从分页搜索结果选择一个用户，并选择五种财务角色之一；重复成员不能再次选择。
- [x] 角色名称映射为：`finance_clerk` → 制单会计，`finance_reviewer` → 审核会计，`cashier` → 出纳，`finance_manager` → 财务主管，`finance_auditor` → 审计员。
- [x] 用 `Confirm` 询问是否移除该成员在当前账套的财务授权；请求期间锁定确认动作，取消不发请求。
- [x] 每次新增、改角色或移除成功后显示 Toast、刷新成员列表并调用 `onChanged`；失败时显示 `errText(error)`，保留当前编辑选择。
- [x] 加入首屏加载、重试、空成员、无匹配用户和保存/移除错误反馈；按钮在对应请求进行时禁用。

## 任务三：接入财务工作台

**修改：** `web/app/(dashboard)/finance/page.tsx`

- [x] 增加成员管理弹窗开关状态并导入 `BookMembersDialog`。
- [x] 仅当 `isAdmin && book` 时在 `PageHeader` 显示“成员与权限”按钮。
- [x] 以当前 `book` 对象挂载弹窗；账套变化时弹窗的依赖重置保证不串数据。
- [x] 新增或调整角色后提示“账套成员授权已更新”；移除成员后提示“成员财务授权已移除”。
- [x] 核对管理员是唯一入口，普通成员不会挂载弹窗。

## 任务四：静态核验与交付

- [x] 执行 `./node_modules/.bin/tsc --noEmit --target es2018 --incremental false`，确认退出码为 0。
- [x] 执行 `npm run build`，确认生产构建成功并记录已有非本功能警告。
- [x] 执行 `git diff --check`，审阅权限判断、分页搜索、状态重置和 API 载荷。
- [x] 用中文 commit 标题提交实现与设计文档；创建中文 PR，正文使用中文分节标题。
