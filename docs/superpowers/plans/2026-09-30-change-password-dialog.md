# 修改密码弹窗实施计划

> **For agentic workers:** 本计划由当前会话逐项实施；每个行为先写失败测试，再做最小实现并验证。

**目标：** 普通改密从工作台入口以控制台 Dialog 展示并保留所在页面；首次强制改密维持独立流程且文案正确。

**架构：** 把字段、校验和提交抽为共享表单。根 `/change-password` 页面根据 `useMe().me.must_change_pwd` 决定首次/普通标题；dashboard 并行 `@modal` 插槽与拦截路由使用同一表单承载普通改密 Dialog。dashboard 检测到强制改密时应使用整页导航，让根路由承接强制流程，不被拦截为可关闭弹窗。

**技术栈：** Next.js 14 App Router、React 18、TypeScript、共享 `Dialog`、Vitest + Testing Library + jsdom。

## 全局约束

- 只在服务端返回的 `must_change_pwd` 为真时，首次强制改密才不可关闭；URL 或来源不充当授权。
- 密码规则、`authApi.changePassword` 请求体和接口不变。
- 普通改密成功后关闭弹窗并留在来源页面；强制流程成功后进入工作台。
- 不增加依赖，不改后端认证/会话契约；普通改密的桌面和移动账号入口继续使用 `/change-password`。

---

### 任务 1：共享改密表单和根路由场景文案

**文件：**
- 新建 `web/components/auth/ChangePasswordForm.tsx`
- 新建 `web/components/auth/ChangePasswordForm.module.css`
- 修改 `web/app/change-password/page.tsx`
- 新建 `web/lib/changePassword.dom.vitest.test.tsx`

**接口：**
- 表单 props：`required: boolean`、`onClose?: () => void`、`onSuccess?: () => void`。
- 根页面用服务端确认的 `me.must_change_pwd` 作为 `required`；身份尚未加载时显示中性加载态，不显示不准确标题。

- [ ] 为普通标题、首次标题与文案、校验、普通成功回调/强制成功导航写 DOM 测试并确认先失败。
- [ ] 抽取单份表单，保留现有校验、API 调用、错误呈现及当前密码自动完成语义。
- [ ] 根页面接入 `useMe`，`must_change_pwd` 为真时不可退出/关闭且成功去 `/dashboard`；为假时仅呈现通用修改文案。
- [ ] 运行该 DOM 测试与前端 TypeScript 测试。

### 任务 2：dashboard 拦截路由 Dialog 与强制改密隔离

**文件：**
- 新建 `web/app/(dashboard)/@modal/default.tsx`
- 新建 `web/app/(dashboard)/@modal/(..)change-password/page.tsx`
- 修改 `web/app/(dashboard)/layout.tsx`
- 修改 `web/lib/changePassword.dom.vitest.test.tsx`

**接口：**
- `DashboardLayout` 接收并渲染 `modal: React.ReactNode` 并行路由插槽。
- 拦截路由呈现共享表单 Dialog；关闭通过 `router.back()` 返回来源页；提交中禁止关闭和重复提交。

- [ ] 为普通 Dialog 标题、关闭/来源页保持、提交中不可关闭写测试并确认先失败。
- [ ] 实现默认空插槽、`(.)change-password` 拦截页面和共享外壳渲染。
- [ ] 强制改密从 dashboard 以浏览器整页替换到 `/change-password`，避免路由拦截把必做流程变成可跳过的普通弹窗。
- [ ] 运行 DOM 回归测试、`npm run test:unit`、`npm run test:motion`、`npm run build` 与 `git diff --check`。
