# 手机 PWA 刷新与 Dock 单档面板实施计划

> **执行方式：** 当前会话内逐项实施并复核；无需派生任务。步骤使用复选框跟踪。

**目标：** 一次下拉确实更新当前页数据，一次点按 Dock 即呈现完整可操作入口。

**架构：** 页面刷新协调器收集当前路由内的异步加载器并等待完成。`useAsyncData` 自动注册，三个自管理请求页面显式注册。Dock 沿用现有五位内容、权限和卡片组件，面板收敛为单一模态高度和原生滚动。

**技术栈：** Next.js App Router、React、TypeScript、CSS Modules、现有 `useModalBehavior`。

## 全局约束

- 手机外壳断点为 `max-width: 767px`；桌面侧栏行为不变。
- 保留五位 Dock 和现有权限判定；支出记录与报表仍共用一位。
- 下拉触发阈值为 56px，最大指示器位移为 96px。
- 保留当前 URL、查询参数与页面本地筛选；项目详情未保存编辑时不刷新。
- 中文 UI 文案沿用控制台语气，Git 信息使用中文。

---

### 任务 1：页面刷新协调器

**文件：**
- 新建：`web/lib/pageRefresh.tsx`
- 修改：`web/lib/useAsyncData.ts`
- 修改：`web/app/(dashboard)/layout.tsx`

**接口：**

```ts
type RefreshHandler = (signal: AbortSignal) => Promise<unknown>;
interface PageRefreshContextValue {
  register: (handler: RefreshHandler) => () => void;
  refresh: () => Promise<void>;
}
export function PageRefreshProvider({ children }: { children: React.ReactNode }): React.ReactElement;
export function useRegisterPageRefresh(handler: RefreshHandler, enabled?: boolean): void;
export function usePageRefresh(): () => Promise<void>;
```

- [x] **步骤 1：** 实现稳定的 handler 注册表；刷新时快照当前 handler，并发等待结果；任一失败取消其余请求，10 秒未结束则取消并提示检查网络连接；无 handler 时调用 `router.refresh()`。
- [x] **步骤 2：** 将 `useAsyncData` 的请求执行抽成可等待的 `run(signal?: AbortSignal): Promise<void>`，保留 AbortController、序号、首载、依赖变化清空数据与手动 `reload()` 行为；启用时注册 `run`，10 秒超时后结束加载并显示原因。
- [x] **步骤 3：** 在 dashboard layout 的主内容外建立刷新 Provider；`PullToRefresh` 取得 `refresh()`，移除只调用 `router.refresh()` 的旧接线。
- [x] **步骤 4：** 核对已有 `useAsyncData` 生命周期验证，确保旧请求取消、错误状态和当前筛选数据不回退。

### 任务 2：自管理请求页面与编辑保护

**文件：**
- 修改：`web/app/(dashboard)/dashboard/page.tsx`
- 修改：`web/app/(dashboard)/approvals/page.tsx`
- 修改：`web/app/(dashboard)/projects/[id]/page.tsx`

**接口：** 三页的 `load` / `loadAll` 返回 `Promise<string | null>`：成功或主动取消返回 `null`，实际加载失败返回错误文字。注册函数将错误文字抛给刷新协调器。

```ts
useRegisterPageRefresh(async (signal) => {
  const message = await load(signal);
  if (message) throw new Error(message);
});
```

- [x] **步骤 1：** 工作台与审批页注册现有加载函数，使下拉等待真实请求并透传错误。
- [x] **步骤 2：** 项目详情注册 `loadAll`；当文档内容与已载入版本不同、保存进行中或业务提交进行中，拒绝刷新并提示“有未保存的内容，请保存后再刷新”。
- [x] **步骤 3：** 确认刷新不会改变本地筛选、标签、URL 或未保存文档内容。

### 任务 3：下拉手势与状态反馈

**文件：**
- 修改：`web/components/mobile/PullToRefresh.tsx`
- 修改：`web/app/globals.css`

**状态：** `idle → pulling → refreshing → idle | error`。`touchcancel` 直接回到 `idle`；`data-ptr-count` 只在 `onRefresh` 成功时增加。

- [x] **步骤 1：** 只接受手机端主内容顶部的单指纵向下拉；超过方向判定距离才占用手势，横滑、表单控件与嵌套滚动区退出识别；移除桌面鼠标拖动刷新。
- [x] **步骤 2：** 用非 passive 的 `touchmove` 监听在确定接管后阻止浏览器滚动；保留 56px 阈值和 96px 最大位移。
- [x] **步骤 3：** 指示器进入内容流，展示下拉、正在刷新、失败与重试；错误文字可被读屏读取，刷新中只执行一次。
- [x] **步骤 4：** 针对手势取消、失败后重试、成功次数与页面数据更新做针对性验证。

### 任务 4：Dock 单档面板

**文件：**
- 修改：`web/components/mobile/MobileDock.tsx`
- 修改：`web/components/mobile/BottomSheet.tsx`
- 修改：`web/components/mobile/BottomSheet.module.css`
- 修改：`web/components/mobile/sheets/index.ts`
- 修改：`web/components/mobile/SheetCard.tsx`
- 修改：`web/components/mobile/SheetCard.module.css`
- 修改：`web/components/mobile/sheets/sheets.module.css`
- 删除：`web/lib/sheetGesture.ts`（确认无使用者后）

**接口：** `BottomSheet` 只接受 `open / onClose / title / subtitle / action / children`；`SheetContent` 使用整宽列表卡。Dock 打开其他位时保持面板打开并滚到内容顶部。

- [x] **步骤 1：** 去掉 Dock 的档位状态、默认档位表与二次点按降档逻辑；同位再点关闭，不同位直接切换。
- [x] **步骤 2：** 去掉面板拖动、把手、动态高度测量和三档样式；保留退场动画、遮罩、焦点与滚动锁定，并加入明确关闭按钮。
- [x] **步骤 3：** 把所有卡片固定为单列列表；确保头部的业务直达入口在加载或失败时仍可使用，切换位时重置面板内部滚动。
- [x] **步骤 4：** 更新旧三档交互的针对性验证和移动走查约定，使其反映单档面板。

### 任务 5：收口

**文件：** 本计划改动的 UI 与文档文件。

- [x] **步骤 1：** 对照设计规格检查五位内容、权限、错误、空态、键盘、减少动效与安全区。
- [x] **步骤 2：** 在 390px 与低高度手机视口复核入口可见性与滚动；按同一 767px 断点检查 360px 样式，并在桌面视口复核侧栏。
- [x] **步骤 3：** 运行必要的构建与针对性验证；记录确实未能验证的运行环境限制。

**环境限制：** 本地后端未启动，真实登录数据的端到端走查尚不能运行。浏览器已检查面板、断点和刷新超时路径；客户端重取与失败回传由现有自动化验证覆盖。

### 全站刷新范围补齐（2026-09-26）

- [x] 将刷新协调器与统一手势提升到根布局，覆盖登录、密码修改、工作台、Spark 等所有路由。
- [x] 在窗口捕获阶段监听触摸，允许触点所在的纵向滚动区处于顶部后刷新；表单、弹层和仍在滚动的容器不触发。
- [x] 将内容流指示器收敛为顶栏下方的中性系统式转圈，保留失败重试和成功计数。
- [x] 更新刷新设计说明，消除“仅工作台刷新”的旧范围。
