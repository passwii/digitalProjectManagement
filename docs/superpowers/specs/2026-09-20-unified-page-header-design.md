# 工作台统一页面头部设计

## 背景

当前工作台一级页面的头部存在多种写法：`PageActions` 单独渲染右上角操作，`TableToolbar` 再单独渲染筛选，部分页面使用 `toolbar-card`，部分页面使用 `section-head`。这些写法在视觉上容易形成多层嵌套，尤其项目台账已经接近统一形态但仍保留了外层 section 和动画包装。

本次调整将所有工作台一级页面的页面级筛选、上下文选择和主操作收敛到统一的 `PageHeader`。页面内容、数据请求、URL 状态、权限逻辑和页面内部业务分区不属于本次统一范围。

## 目标

- 统一一级页面的页面头部结构：左侧为筛选或上下文，右侧为主操作。
- 取消 `PageActions` 与 `TableToolbar` 在同一页面上分离堆叠的结构。
- 简化 Projects 顶部层级，移除仅为包裹工具栏而存在的额外 section 和重复布局壳。
- 保留所有现有按钮文案、权限、交互、URL 筛选和数据行为。
- Reports 的项目筛选器在桌面端可展示项目名称，同时具有明确的最小宽度和最大宽度，不挤压其他筛选项和右侧操作。
- 统一桌面、窄桌面和移动端的换行策略，不让按钮、输入框或项目名称溢出父容器。

## 非目标

- 不改变后端接口、数据结构、URL 参数名称、分页契约或业务状态机。
- 不把所有页面内部的 `section-head` 都改造成一级 `PageHeader`。
- 不重做项目详情页、财务页面内部业务分区、弹窗和表格列。
- 不删除仍有其他消费者需要的 `PageActions`，除非迁移完成后确认没有消费者。
- 不做全局字体、颜色、按钮样式或无关 CSS 重构。

## 页面范围

统一以下工作台一级页面的头部：

- `dashboard`：无筛选，右侧保留刷新、报表、待审批等入口。
- `projects`：搜索、状态、负责人、年度和清除筛选在左侧，新建项目在最右侧。
- `progress`：项目选择在左侧，添加进度在最右侧。
- `costs`：项目选择和支出状态筛选在左侧，新增支出在最右侧。
- `reports`：项目、部门、人员、月份和清除筛选在左侧；明细/汇总、打印、导出在最右侧。
- `approvals`：无筛选，刷新在最右侧。
- `contacts`：搜索、部门、任职状态和清除筛选在左侧，新建人员在最右侧。
- `partners`：搜索、友商类型和清除筛选在左侧，新建友商在最右侧。
- `finance`：账套上下文选择在左侧，刷新、新建账套和新建凭证在最右侧。
- `admin`：保留系统管理的页签和已有页面操作语义，一级头部统一为同一容器；页签本身不与业务筛选混合。

## 组件设计

### `PageHeader`

建议新增：

- `web/components/ui/PageHeader.tsx`
- `web/components/ui/PageHeader.module.css`

组件 API：

```tsx
interface PageHeaderProps {
  title: string;
  filters?: ReactNode;
  actions?: ReactNode;
  className?: string;
}
```

行为约定：

- 始终渲染一个视觉隐藏的 `h1`，保证一级页面的可访问语义。
- `filters` 存在时放入左侧可伸缩区域；不存在时不渲染空的左侧容器。
- `actions` 存在时放入右侧操作区域；不存在时不渲染空的操作区域。
- 组件只负责页面级横向布局，不持有状态，不判断权限，不处理 URL，不实现按钮行为。
- 页面传入的筛选控件和操作节点保持原样，不改变控件文案和业务事件。

推荐 DOM 结构：

```text
PageHeader
├── sr-only h1
└── header.pageHeader
    ├── div.pageHeaderFilters（可选）
    └── div.pageHeaderActions（可选）
```

`PageHeader` 的外层视觉容器只承载一次背景、边框、圆角和内边距。页面不再额外包一层 `PageActions`、`toolbar-card` 或仅为布局存在的 section。

### `TableToolbar`

保留现有组件以兼容其他调用方，并将其内部布局逐步调整为与 `PageHeader` 相同的左右分区语义。一级页面迁移完成后，带筛选和主操作的页面直接使用 `PageHeader`；需要独立导出状态或特殊表格工具行为的调用方可继续使用 `TableToolbar`。

## 布局策略

### 桌面端

- `header.pageHeader` 使用 flex 布局，筛选区域 `flex: 1 1 auto`，操作区域 `margin-left: auto`。
- 筛选控件允许换行，但右侧操作区保持自身完整宽度。
- 输入框和 select 不设置会导致项目名称不可见的过大固定宽度。
- 页面头部与列表内容之间保留一个统一的底部间距，避免页面逐个写 margin。

### Reports 项目筛选

Reports 的项目选择器是唯一需要明显展示长项目名称的筛选控件：

- 桌面端作为左侧筛选区的弹性项。
- 设置明确的 `min-width`，保证短项目编号和常见项目名称可读。
- 设置明确的 `max-width`，避免长项目名称吞掉部门、人员、月份筛选和右侧操作空间。
- 选择器内部继续使用现有省略和 title 语义；不改变 ProjectPicker 的数据和搜索行为。
- 在窄桌面宽度不足时允许筛选区整体换行，不能压缩到不可操作的宽度。

建议初始 CSS 约束为桌面端 `min-width: 220px`、`max-width: min(34vw, 360px)`；实际值以浏览器验收和现有 Shell 可用宽度为准，并集中在 Reports 的局部 class 中，避免影响其他 ProjectPicker。

### 移动端

- 页面头部自然换行，不使用横向滚动承载主要操作。
- 筛选控件按现有控件语义堆叠并保持可操作宽度。
- 右侧操作区在窄屏可占满一行，按钮保持现有蓝色主按钮样式和触控高度。
- 不显示空的标题行或额外装饰层。

## 迁移边界

迁移只调整页面头部 JSX 外层和必要的局部 CSS class：

- 保留 `useUrlState`、`useAsyncData`、权限检查、toast、弹窗状态和数据表格。
- 保留 `ListPageLayout`、`ListViewport`、`DesktopTableFrame` 的列表主体职责。
- Projects 仅移除 `section` 和多余 Motion 包装，使用 `PageHeader` 作为 `ListPageLayout.toolbar`。
- Partners、Contacts 直接把现有 `PageActions` action 传入 `PageHeader.actions`，筛选节点传入 `PageHeader.filters`。
- Progress、Costs 将现有项目选择卡片合并进 `PageHeader.filters`，并把 Costs 的状态选择放入同一筛选区。
- Reports 将视图模式、打印、导出传入 `PageHeader.actions`，筛选控件传入 `PageHeader.filters`，项目选择器加局部宽度 class。
- Dashboard、Approvals 使用无 `filters` 的 `PageHeader`。
- Finance、Admin 先只统一一级页面头；其余业务 section 维持原结构。

## 测试策略

新增 `PageHeader` DOM 测试，验证：

- 标题通过视觉隐藏 `h1` 保留。
- `filters` 和 `actions` 分别进入正确区域。
- 只传 actions 时不产生空 filters 容器。
- 只传 filters 时不产生空 actions 容器。
- 自定义 class 能连接到最外层头部。

增加源码或 DOM 契约检查，验证迁移页面不再同时渲染 `PageActions` 与独立的页面级 `TableToolbar` / `toolbar-card`。

Reports 增加样式契约检查，锁定项目选择器的桌面 `min-width`、`max-width` 和窄屏换行规则。

运行：

- `cd web && npx vitest run lib/pageHeader.dom.vitest.test.tsx`
- `cd web && npm test`
- `cd web && npm run build`
- 启动开发服务器后，验收桌面宽屏、窄桌面和移动端的一级页面头部；Reports 额外检查长项目名称和操作区不互相挤压。

## 验收标准

1. 所有目标一级页面最多只有一个页面级头部视觉容器。
2. 有筛选的页面中筛选在左、主操作在最右侧；无筛选页面不出现空的筛选区。
3. Projects 顶部不再出现多层嵌套的标题/操作/筛选外观，现有蓝色新建按钮保持不变。
4. Partners、Progress、Reports 等页面的主操作与筛选处于同一个头部容器内。
5. Reports 在桌面端能显示项目名称，同时项目选择器不会无限扩张或挤掉其他控件。
6. 移动端头部可以自然换行，按钮和筛选控件可操作，页面不出现横向溢出。
7. 页面业务行为、权限、数据、URL 筛选、分页和弹窗交互不回归。
