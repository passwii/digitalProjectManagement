# Spark 内置演示站实施计划

> **For agentic workers:** 本计划按任务分步执行。项目约束与路径均在此文档中给出；每一任务结束后检查该任务涉及的页面行为。

**Goal:** 在当前 Next.js 项目新增一个免登录、使用本地 mock fixtures 的 Spark/NebulaCloud 管理演示站，并从主项目桌面及手机入口可达。

**Architecture:** `/spark` 在 middleware 中作为公共路由，拥有独立 App Router layout 和深色 Spark shell。主项目侧栏增加本地 Spark 分组，手机端从「我的」抽屉打开；八个管理模块通过 Spark 内部路由和本地静态数据渲染。

**Tech Stack:** Next.js 14 App Router、React 18、TypeScript、CSS Modules、已安装的 Recharts；不增加依赖。

## 全局约束

- Spark 所有路由都可在没有 `pm_access_token` 时访问；主项目现有路由保护继续生效。
- Spark 只消费本地 mock 数据，不请求主项目业务 API、原 Coze 站点或数据库。
- 主项目后端 `/meta/me/menus` 契约与五位手机 Dock 不变。
- Spark 样式必须限定在 Spark root/classes/CSS Modules 内，不能改主项目全局浅色 token。
- 页面包含八个已采集模块；原站登录页与其凭据不进入演示 UI。
- 不新增测试文件或运行测试套件；通过 Next build 和本地浏览器手动走查验证。
- Git 提交说明如需产生，标题使用中文；不暂存现有 `ui-study/` 档案。

## 文件职责

| 文件 | 职责 |
| --- | --- |
| `web/middleware.ts` | 放行 `/spark` 及子路由 |
| `web/app/(dashboard)/layout.tsx` | 在已有桌面导航中加入 Spark 分组入口 |
| `web/components/mobile/sheets/MineSheet.tsx` | 在手机「我的」抽屉加入免登录 Spark 入口 |
| `web/app/spark/layout.tsx` | Spark 独立页面壳和 metadata |
| `web/app/spark/page.tsx` | 将 `/spark` 默认落到 `/spark/dashboard` |
| `web/app/spark/[section]/page.tsx` | 校验模块路由并载入模块内容 |
| `web/components/spark/SparkShell.tsx` | 深色品牌区、导航、顶栏、移动抽屉和页面框架 |
| `web/components/spark/SparkShell.module.css` | Spark 壳、侧栏和窄屏导航样式 |
| `web/components/spark/SparkUI.tsx` | 共用指标卡、玻璃卡片、状态标记、分区标题与表格 primitives |
| `web/components/spark/SparkPages.module.css` | 八个模块共用栅格、卡片、表格、筛选与图表样式 |
| `web/components/spark/pages/*.tsx` | 各模块自己的展示和局部 mock 交互 |
| `web/lib/spark/*.ts` | 各模块静态 mock fixtures 与共享数据类型 |

## 实施任务

### 任务 1：公共路由与主项目入口

**文件：** `web/middleware.ts`、`web/app/(dashboard)/layout.tsx`、`web/components/mobile/sheets/MineSheet.tsx`

- [ ] 在 `PUBLIC_PATHS` 中增加 `/spark`。middleware 的现有前缀匹配应同时放行 `/spark/dashboard` 等子路由。
- [ ] 在主项目侧栏中增加 `Spark` 分组，子项命名为 `NebulaCloud 演示站`、链接 `/spark`。它是本地静态菜单项，不写入 `useMenus()` 返回的后端菜单，也不参与管理员分组。
- [ ] 在 `MineSheet` 的通用入口区增加 `Spark 演示站` `SheetCard`，链接 `/spark`，点击后由现有 `onSelect` 收起抽屉。
- [ ] 确认五位 `DOCK_SLOTS` 与管理/审批菜单过滤逻辑无修改。

桌面 nav 项可按现有结构增加到 `navItems` 的最终列表：

```tsx
out.push({
  href: "/spark",
  label: "NebulaCloud 演示站",
  icon: <SparkIcon />,
});
```

分组标题只在 `/spark` 项之前渲染，折叠侧栏时沿用现有 `navGroupLabel` 的视觉规则。

**验收：** middleware 对 `/spark` 和 `/spark/permission` 返回 `NextResponse.next()`；无 session 打开 `/dashboard` 仍跳登录；已有会话下桌面与手机「我的」入口均能打开 `/spark`。

### 任务 2：Spark 路由壳与响应式导航

**文件：** `web/app/spark/layout.tsx`、`web/app/spark/page.tsx`、`web/app/spark/[section]/page.tsx`、`web/components/spark/SparkShell.tsx`、`web/components/spark/SparkShell.module.css`

- [ ] 创建独立的 Spark layout，metadata 标题为 `NebulaCloud 苏州 · 云电竞管理平台`，不包进 `(dashboard)` 用户身份/API 壳。
- [ ] `/spark` 服务端重定向至 `/spark/dashboard`。
- [ ] 建立固定 route 表：`dashboard`、`stores`、`compute`、`billing`、`content`、`security`、`ops`、`permission`；无效 section 调用 `notFound()`。
- [ ] 壳内导航使用 `<Link>` 指向 `/spark/<section>`，按 `usePathname()` 设置 `aria-current="page"`；顶栏提供返回数科云办公 `/dashboard` 的链接。
- [ ] 桌面侧栏可折叠；窄屏以可访问按钮打开模块抽屉，选中导航后关闭；根容器使用 `min-height: 100dvh` 并处理安全区。
- [ ] 在 CSS Module 内定义 Spark 深色 token 和 `prefers-reduced-motion` 处理；不要在 `globals.css` 设全局 dark overrides。

**验收：** 直接打开八个 URL 和刷新子路由都保留 Spark 壳；未登录时 `/spark` 不跳 `/login`；未知路径返回 404。

### 任务 3：共享 UI 与总览、门店、算力

**文件：** `web/components/spark/SparkUI.tsx`、`web/components/spark/SparkPages.module.css`、`web/components/spark/pages/DashboardPage.tsx`、`StoresPage.tsx`、`ComputePage.tsx`、`web/lib/spark/types.ts`、`dashboard.ts`、`stores.ts`、`compute.ts`

- [ ] 建立本地数据类型：`Metric`、`Store`、`GpuNode`、`Alert`、`RevenuePoint` 和各自的状态联合类型。
- [ ] 以学习档案的 route 文案与 mock 记录创建本地 fixtures；总览、门店和算力页面只从 fixtures 读取数据。
- [ ] 建立共用 `SparkCard`、`MetricCard`、`StatusBadge`、`SectionHeading`、`DataTable` 和筛选 chip，统一暗色边框、圆角、表格数值与状态色。
- [ ] 总览绘制 24 小时营收趋势、平台健康度、GPU 资源、区县营收、事件告警和营收 Top 6。
- [ ] 门店页渲染统计和门店卡片，区县与负载/营业状态筛选可用；保留 `stores-high-load` 对应状态。
- [ ] 算力页渲染负载、GPU 节点表、套餐、策略选项及弹性伸缩开关/滑块；策略切换可见地更新选择态。

**验收：** 三个模块字段与文案对照 `ui-study/raw/*.json` 和 `ui-study/mock-content/mock-copy.json`；筛选、策略、开关、滑块不会触发网络请求。

### 任务 4：计费与内容模块

**文件：** `web/components/spark/pages/BillingPage.tsx`、`ContentPage.tsx`、`web/lib/spark/billing.ts`、`content.ts`、`web/components/spark/SparkPages.module.css`

- [ ] 计费 fixtures 覆盖收入 KPI、7 日营收构成、支付渠道和计费规则。
- [ ] 计费的「收银台」「会员中心」页签切换表格/列表内容，对应 `billing-cashier` 和 `billing-members`。
- [ ] 内容 fixtures 覆盖游戏内容库、分类、赛事、增值内容和合规审核页签。
- [ ] 分类筛选和关键词搜索作用于本地内容列表；「电竞赛事」「增值内容」「合规审核」页签可切换。
- [ ] 为移动端表格提供横向滚动容器，并保证空结果有说明文字。

**验收：** `billing`、`content` 两路由可直接加载，页签/筛选/搜索状态独立、可重复切换。

### 任务 5：安全、运维与权限模块

**文件：** `web/components/spark/pages/SecurityPage.tsx`、`OpsPage.tsx`、`PermissionPage.tsx`、`web/lib/spark/security.ts`、`ops.ts`、`permission.ts`

- [ ] 安全页展示合规 KPI、安全策略、审计日志、加密/容灾和监管对接信息；策略按钮带 `role="switch"`、`aria-checked` 并本地切换。
- [ ] 运维页展示工单 KPI、六类子系统状态、SLA 和状态筛选；筛选能改变表格行集合。
- [ ] 权限页展示成员表、角色筛选、角色权限面板、操作日志；角色切换更新当前权限矩阵。
- [ ] 所有 mock 状态以组件 state 管理，不发写请求、不写 localStorage、不改变主项目登录状态。

**验收：** `security-toggle`、`ops-pending`、`permissions-roles`、`permissions-logs`、`permissions-manager-filter` 对应状态可重现；表格窄屏下可读。

### 任务 6：接线、构建与手动走查

**文件：** `web/app/spark/[section]/page.tsx`、`web/components/spark/SparkShell.tsx`、`ui-study/README.md`

- [ ] 将八个 section 映射到独立页面组件，侧栏标签与标题一致。
- [ ] 在 `ui-study/README.md` 增加「Spark 内置演示站」入口说明与运行路径，不复制凭据。
- [ ] 从 `web/` 执行 `npm run build`；本计划不添加或运行测试套件。
- [ ] 本地手动打开 `/spark`、每个 section、主项目桌面侧栏入口与手机「我的」入口，检查控制台错误、页面溢出、点击反馈和直达刷新。
- [ ] 检查浏览器 Network：Spark 路由无原 Coze 域名和主项目业务 API 请求。

**验收：** production build 返回 0；八页均可直达；桌面宽屏、窄屏各走查一次；主项目登录门禁及 Dock 行为保持原状。

## 计划自检

- 设计中的公开免登录边界覆盖于任务 1、2、6。
- 主项目桌面/手机入口及权限/Dock 约束覆盖于任务 1、2。
- 八个页面、数据源、交互和响应式覆盖于任务 3 至 5。
- 无外部 API、无新增依赖、Spark 样式隔离覆盖于全局约束和任务 2 至 6。
- 未加入未定义的接口、占位类型或待定事项。
