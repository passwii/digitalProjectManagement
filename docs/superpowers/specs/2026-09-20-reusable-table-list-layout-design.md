# 可复用列表页与表格布局设计

## 背景

项目台账桌面端目前把分页组件直接放在表格后面，分页位置随当前页数据条数变化。当最后一页少于默认的 15 条时，分页会贴着最后一行向上收缩，造成页面底部位置跳动。

这次调整需要同时解决两个问题：

1. 项目台账的分页在正常桌面视口中稳定地靠近内容区底部。
2. 把这套布局行为抽象成未来列表页可以复用的组件，而不是继续在每个页面里重复拼接表格、移动端卡片、分页和空白空间。

## 目标与非目标

### 目标

- 桌面端项目台账在数据不足一页时，分页区域保持在内容区下方，视觉上接近视口底部。
- 数据较多时允许页面自然增长，不能遮挡表格内容，也不能把整个页面锁死在视口内。
- 矮视口下取消弹性占位，页面恢复自然文档流并允许滚动。
- 移动端继续使用现有卡片流，不应用桌面端分页底部对齐策略。
- 提供可复用的列表页布局组件和桌面表格外壳。
- 保留各页面自定义表格列、复杂单元格、行点击、权限按钮和移动端卡片内容的能力。
- 通过组件 API 和测试明确布局契约，方便后续通讯录、审批、支出等页面逐步迁移。

### 非目标

- 本次不改 Pagination 的分页数据契约、URL 行为、页码边界收敛或每页条数逻辑。
- 本次不一次性迁移通讯录、审批、进度、支出等其他页面。
- 本次不创建通用的 column-driven DataTable，不把所有表格单元格强制转换成配置对象。
- 本次不使用 `position: fixed` 或 `position: sticky` 固定分页。

## 设计原则

### 组件化边界

统一列表页的布局和行为，不统一所有页面的表格列配置。

组件分工如下：

- `TableToolbar`：筛选控件、主操作、导出状态，继续作为工具栏基础组件。
- `ListPageLayout`：列表页面的垂直组织，包括工具栏、提示区域和主体内容。
- `ListViewport`：表格主体与分页的共同弹性高度轨道，负责分页底部对齐。
- `DesktopTableFrame`：桌面表格的横向滚动、桌面断点退场和打印外壳。
- `CardList`：移动端卡片呈现，保留现有数据和交互能力。
- `Pagination`：分页控件本身，继续由业务页面提供数据和 `onChange`。

具体 `<table>` 仍由业务页面渲染，以保留复杂 JSX、`colgroup`、行操作、权限和定位状态。

### 桌面端高度策略

列表页在桌面端设置一个与 Shell 内容区相容的最小高度，而不是固定高度。`ListViewport` 使用列方向 flex 布局：表格在上方自然占高，分页 footer 使用 `margin-top: auto` 吸收剩余空间。

抽象后的结构如下：

```text
ListPageLayout（桌面端最小高度）
├── toolbar
├── notice（可选）
└── ListViewport（flex: 1）
    ├── list body（table/card content）
    └── pagination footer（margin-top: auto）
```

页面只拥有最小高度，不拥有固定高度。表格内容超过可用空间时，页面继续向下增长；表格内容不足时，空白由 viewport 内部吸收。

### 矮视口和移动端降级

- 桌面端正常视口：启用最小高度与 footer 底部对齐。
- 桌面端矮视口：在高度媒体查询下将最小高度恢复为 `0`，分页回到自然流。
- `max-width: 767px`：关闭桌面列表轨道的弹性高度，沿用现有卡片流和底部 Dock 留白。
- 任何模式都不覆盖内容、不隐藏分页、不创建独立滚动容器。

矮视口阈值以列表页需要的最小可读空间为依据，在 CSS 中集中定义，不由业务页面重复声明。第一版使用 `@media (max-height: 720px) and (min-width: 768px)` 作为降级条件。

### 视觉规范

- 表格使用现有 `table.grid` 作为基础视觉语言。
- 表头、行高、边框、hover、焦点态和数字列继续由全局表格规范控制。
- 表格与分页之间保留统一的 footer 上间距；分页内部间距继续由 `Pagination.module.css` 控制。
- 桌面表格外壳负责横向滚动，避免页面整体横向溢出。
- 交互按钮继续使用现有按钮类和可访问名称；不因布局抽象改变按钮文案或权限逻辑。
- 打印时隐藏移动卡片，保留桌面表格；弹性空白不应制造无意义的打印长页。

## 组件 API

### `ListPageLayout`

```tsx
interface ListPageLayoutProps {
  toolbar: ReactNode;
  notice?: ReactNode;
  children: ReactNode;
}
```

职责是提供页面级结构和桌面端最小高度，不判断加载、错误、空数据，也不拥有分页状态。

### `ListViewport`

```tsx
interface ListViewportProps {
  children: ReactNode;
  pagination?: ReactNode;
  className?: string;
}
```

职责是将列表主体和分页放进同一个弹性轨道。`children` 可以包含 `CardList` 与 `DesktopTableFrame` 两份响应式内容；`pagination` 在桌面端位于轨道底部，在移动端恢复自然流。

### `DesktopTableFrame`

```tsx
interface DesktopTableFrameProps {
  children: ReactNode;
  className?: string;
}
```

职责是复用当前 `DesktopTable` 的桌面断点退场和 `.table-scroll` 横向滚动语义，不改变传入表格 DOM。

## 项目台账迁移

项目台账保留现有：

- URL 筛选与分页状态。
- `CardList` / `DesktopTable` 双份响应式 DOM。
- 项目表格的固定列宽、行点击、负责人头像、状态徽标和编辑按钮。
- 加载、错误、空数据和演示数据提示逻辑。

迁移只调整 JSX 外层：工具栏进入 `ListPageLayout.toolbar`，演示提示进入 `notice`，表格与分页进入 `ListViewport`。空态和加载态继续由页面决定是否渲染，不为了抽象而引入复杂状态机。

## 测试策略

- 新增 DOM 测试验证 `ListPageLayout`、`ListViewport` 和 `DesktopTableFrame` 的结构契约、分页 footer 的存在及类名连接。
- 保留并扩展 `CardList` 现有测试，确认新的桌面表格外壳仍然原样渲染传入 table。
- 增加源码/CSS 契约测试或静态检查，锁定桌面最小高度、矮视口降级、移动端关闭弹性轨道和打印行为，避免未来改样式时误删核心规则。
- 运行前端 TypeScript 检查、Vitest 单测和 Next build。
- 启动开发服务器后，用桌面正常高度、桌面矮高度、第二页不足 15 条和移动端视口进行浏览器验收，确认分页不遮挡内容且位置稳定。

## 验收标准

1. 项目台账第一页和最后一页的分页 footer 在正常桌面视口中处于一致的内容区底部位置。
2. 最后一页少于 15 条时，分页不会紧贴最后一行向上跳动。
3. 视口高度低于阈值时，页面可以自然滚动，表格和分页完整可见。
4. 桌面表格横向滚动、行点击、行内编辑和打印行为不回归。
5. 767px 以下仍显示卡片流，不显示桌面表格，不出现桌面弹性空白。
6. 新组件不依赖项目台账数据类型，后续页面可以只传入自己的 table/card/pagination 内容复用。
