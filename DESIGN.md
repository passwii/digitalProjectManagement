---
name: 数科云办公
description: 企业项目运营工作台的深浅双主题视觉规范
colors:
  dark-canvas: "#07131f"
  dark-surface: "#0d1d2c"
  dark-rail: "#081622"
  dark-ink: "#eaf9fb"
  dark-ink-secondary: "rgba(201, 227, 235, 0.72)"
  dark-ink-muted: "rgba(201, 227, 235, 0.48)"
  dark-divider: "rgba(146, 189, 210, 0.22)"
  dark-signal: "#6cf3ff"
  dark-action: "#c6ff72"
  dark-warning: "#ffc46b"
  dark-danger: "#ff9a6a"
  dark-success: "#c6ff72"
  dark-neutral-state: "#9cb4c4"
  dark-data-violet: "#bda6ff"
  light-canvas: "#f1f5f7"
  light-surface: "#ffffff"
  light-raised: "#e8eef2"
  light-rail: "#142f40"
  light-ink: "#1c2c38"
  light-ink-secondary: "#526575"
  light-ink-muted: "#5e707d"
  light-divider: "#d8e1e7"
  light-signal: "#17617d"
  light-action: "#c6df7b"
  light-warning: "#805518"
  light-danger: "#a23e39"
  light-success: "#356b4b"
  light-neutral-state: "#5e707d"
  light-data-violet: "#6d4cc2"
  light-control-border: "#82939e"
  light-action-border: "#adc95d"
  light-data-green: "#587839"
typography:
  body:
    fontFamily: '"Noto Sans SC", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif'
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  page-title:
    fontFamily: '"Noto Sans SC", "Source Han Sans SC", "PingFang SC", "HarmonyOS Sans SC", "Microsoft YaHei", system-ui, sans-serif'
    fontSize: "22px"
    fontWeight: 700
    lineHeight: 1.3
    letterSpacing: "0.01em"
  section-title:
    fontFamily: '"Noto Sans SC", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif'
    fontSize: "15px"
    fontWeight: 700
  brand:
    fontFamily: '"Noto Sans SC", "Source Han Sans SC", "PingFang SC", "HarmonyOS Sans SC", "Microsoft YaHei", "Hiragino Sans GB", system-ui, sans-serif'
  label:
    fontFamily: '"Noto Sans SC", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif'
    fontSize: "13px"
    fontWeight: 400
  data:
    fontFamily: '"JetBrains Mono", "IBM Plex Mono", Menlo, Consolas, monospace'
rounded:
  square: "0px"
  badge: "11px"
  pill: "999px"
  mobile-sheet: "18px"
components:
  button-primary-dark:
    backgroundColor: "{colors.dark-action}"
    textColor: "{colors.dark-canvas}"
    rounded: "{rounded.square}"
    padding: "0 16px"
    height: "38px"
  button-primary-light:
    backgroundColor: "{colors.light-action}"
    textColor: "{colors.light-ink}"
    rounded: "{rounded.square}"
    padding: "0 16px"
    height: "38px"
  button-ghost-dark:
    backgroundColor: "{colors.dark-surface}"
    textColor: "{colors.dark-ink}"
    rounded: "{rounded.square}"
    padding: "0 13px"
    height: "38px"
  button-ghost-light:
    backgroundColor: "{colors.light-surface}"
    textColor: "{colors.light-ink}"
    rounded: "{rounded.square}"
    padding: "0 13px"
    height: "38px"
  input-dark:
    backgroundColor: "{colors.dark-surface}"
    textColor: "{colors.dark-ink}"
    rounded: "{rounded.square}"
    padding: "0 11px"
    height: "38px"
  input-light:
    backgroundColor: "{colors.light-surface}"
    textColor: "{colors.light-ink}"
    rounded: "{rounded.square}"
    padding: "0 11px"
    height: "38px"
  card-dark:
    backgroundColor: "{colors.dark-surface}"
    textColor: "{colors.dark-ink}"
    rounded: "{rounded.square}"
    padding: "20px"
  card-light:
    backgroundColor: "{colors.light-surface}"
    textColor: "{colors.light-ink}"
    rounded: "{rounded.square}"
    padding: "20px"
  badge-dark:
    textColor: "{colors.dark-ink}"
    rounded: "{rounded.badge}"
    padding: "0 8px"
    height: "22px"
  badge-light:
    textColor: "{colors.light-ink}"
    rounded: "{rounded.badge}"
    padding: "0 8px"
    height: "22px"
---

# Design System: 数科云办公

## Review and Polish Direction

当前前端进入「系统化 Review 与设计基线固化」阶段，为后续可能进行的一轮较大打磨做准备。本轮以评审为先：先盘点既有界面与共享模式，记录有证据的不一致与质量缺口，再固化可复用的设计基线，最后才考虑改动全站视觉。后续打磨可以演进界面，但必须保留产品事实、工作流程、权限边界，以及既有的移动端与无障碍约定。`/login` 与 `/spark` 等独立视觉区域按本规范记录的例外处理，不把它们的专属样式静默并入已登录工作台。


## Overview

**Creative North Star: “雾白与深海蓝（Mist & Deep-Sea Console）”**

数科云办公是一套供团队治理项目、推进执行并核对交付事实的工作台。视觉语言以清晰的工作面和可读的数据为先：深海军蓝承载暗色工作环境，冷白与蓝灰构成浅色工作面；青色标记信息路径和当前焦点，酸橙色只标记可执行动作与完成状态。深浅主题共享同一组语义职责与版式，不是两套互不相干的皮肤。

界面以黑体中文、紧凑的操作型信息层级、直角边界和克制的阴影建立控制台感。浅色以冷调雾白画布和白色内容面建立清晰工作区，深海蓝侧栏与白色顶栏保持明确的导航 / 工作区分层；信号青承载信息路径，柔和青柠只强调主要行动。项目列表、表格、审批和浮层必须清楚地区分画布、内容表面、导航和状态。主题由根节点的 `data-theme` 驱动；新工作台界面应消费语义颜色，而不是复制某个主题下的硬编码颜色。

**Key Characteristics:**
- 深浅双主题共用语义色职责，切换不改变信息层级或布局。
- 冷调深蓝 / 冷白基底，青色链路信号与酸橙执行色各司其职。
- 中文无衬线为主，等宽字只用于编号、时间及测量数据。
- 以直角、细边界和留白分组，不靠圆角卡片堆叠层级。

本规范描述主工作台（`/dashboard` 及其已登录工作区）的共用视觉系统。`/login` 保留独立的科幻深色身份视觉；`/spark` 是隔离的演示产品界面，保留自己的暗色颜色体系。两者的专属样式不应被当作主工作台的新主题 token。

## Colors

调色板以状态明确、主题等价为原则。前置 YAML 中的颜色 token 对应 `web/app/globals.css` 的 `:root` 深色默认值和 `:root[data-theme="light"]` 覆盖值；切换主题时按语义角色换色，不改变控件含义。

### Primary
- **信号青**：深色使用 `dark-signal`，浅色使用 `light-signal`。用于链接、焦点、选择边界和内容区信息路径；深海蓝导航使用柔和青柠作为当前入口信号，以满足深色表面上的可读性。
- **执行酸橙**：深色使用 `dark-action`，浅色使用 `light-action`。浅色只用于主要行动按钮背景；完成状态使用 `light-success`，绿色数据系列使用 `light-data-green`，不可将行动底色作为前景文字。

### Secondary
- **警告琥珀**：使用 `dark-warning` / `light-warning` 表示需注意但尚未阻断的事项。
- **错误珊瑚**：使用 `dark-danger` / `light-danger` 表示失败、危险或需纠正的事项。
- **完成绿**：使用 `dark-success` / `light-success` 表示已完成状态；浅色绿数据系列使用 `light-data-green`，与行动按钮底色分开。

### Tertiary
- **数据紫**：使用 `dark-data-violet` / `light-data-violet` 作为图表或多系列数据的辅助区分色；不替代主交互信号。

### Neutral
- **工作区画布**：`dark-canvas` / `light-canvas` 是页面底层。
- **内容表面**：`dark-surface` / `light-surface` 用于表单、卡片、表格和弹窗主体。
- **抬高表面**：浅色用 `light-raised` 表示表头、工具区和次级面；深色对应 `--th-bg` 的半透明内容表面。
- **导航表面**：使用 `dark-rail` / `light-rail`，浅色主工作区沿用深海蓝导航框架，深色使用深海军蓝；文字和状态另用 `--nav-ink`、`--nav-muted`、`--nav-active-ink`、`--nav-active-accent` 语义 token。
- **文字与分隔线**：主文字、次级文字、弱文字和分隔分别映射到对应主题的 ink 与 divider token；浅色内容区使用 `light-divider`，需要更明确边界的控件使用 `light-control-border`。浅色按钮边缘使用 `light-action-border`；弱文字不承担唯一状态或操作信息。
- **中性状态**：使用 `dark-neutral-state` / `light-neutral-state` 表示待处理、暂停等非活动状态。

**The Two-Theme Parity Rule.** 主题切换只替换语义颜色，不反转组件职责；同一控件在两种主题下都必须保有相同的重点、可读性和状态表达。

**The Signal / Action Rule.** 内容区信号青负责“看哪里”，导航当前入口使用高对比文字与青柠色标记，酸橙行动色负责“现在可以做什么”；完成状态使用独立成功绿。不要把这些职责混为装饰色。

## Typography

**Display Font:** 工作台不使用独立展示字体；页面标题沿用正文黑体栈。

**Body Font:** Noto Sans SC，回退至 PingFang SC、Hiragino Sans GB、Microsoft YaHei 与 system-ui。

**Label/Mono Font:** JetBrains Mono，回退至 IBM Plex Mono、Menlo、Consolas。

**Character:** 中文界面采用清晰、稳定的无衬线层级。等宽字体用于确实需要对齐或测量的数据，不用来伪装科技感。

### Hierarchy
- **页面标题**（700，22px，1.3 行高）：当前页面主标题，左对齐并与页面主体信息保持紧密关联。
- **区段标题**（700，15px）：卡片、列表区和内容区域的标题；依靠字重和间距建立层次。
- **正文**（400，14px，1.5 行高）：表单、表格与大部分工作台文字的基准样式。
- **字段标签**（13px）：表单字段说明使用稳定的正文黑体，不以 placeholder 代替标签。
- **数据**（等宽字体）：项目编号、时间戳及确需逐位比较的数值；普通中文标签不使用等宽字体。

**The One Sans Rule.** 工作台标题、正文、字段和按钮保持同一中文无衬线家族；品牌字标可沿用独立的 `--font-brand` 黑体栈，不要为单个页面插入衬线展示字或新的品牌字体。

## Layout

工作台采用固定侧栏加可伸缩内容区的控制台布局。桌面侧栏宽 252px，收起时 76px；901–1180px 使用 220px 紧凑侧栏。顶栏桌面基准高度 75px，侧栏品牌区与之共用高度令牌。内容最大宽度 1760px，桌面使用约 28px 起始内边距并随宽度调整。

信息密度以任务扫描和表格可读性为目标：常规数据行高 44px，表头行高 40px；列表保留真实列关系，过窄时优先横向滚动，不把关键字段挤成难读的多行内容。

在 900px 及以下，导航进入窄屏横向排列，主内容改用更紧凑的边距；在 767px 及以下，侧栏退出、底部 Dock 接管主要导航。移动顶栏高度 52px，Dock 内容高度 58px，最小触控目标 44px，并预留设备安全区。断点属于结构变化，不以缩小数据文字来取代布局适配。

## Elevation & Depth

系统采用“边界为主、阴影为辅”的深度表达。浅色主工作区用矿物灰白画布、白色内容面、灰绿 raised surface 和细分隔线区分层级；固定卡片保持平实（`--shadow-card: none`），避免高密度列表出现无必要的漂浮感。浮动菜单、Dialog、Drawer 使用柔和中性色阴影（`--shadow-float` / `--shadow-drawer`），遮罩降低背景干扰。深色保留各自的卡片与浮层阴影。不要给每个数据面板都加浮起效果。

**The Surface-First Rule.** 默认保持工作区内容平实；只在真实浮层或需要区分的容器边缘使用阴影，普通分组优先使用间距和细边界。

## Shapes

主工作区采用方正、精密的直角几何：主要按钮、表格、输入框、卡片、菜单及多数导航容器使用 0px 圆角。状态 Badge 使用轻微圆角（11px）；头像和状态圆点为圆形，底部移动抽屉顶部保留专用 18px 圆角。药丸形只用于既有胶囊型状态或圆点，不推广到普通控件。

边界通常为 1px，并由 `--line`、`--line-soft`、`--line-blue` 及状态边界变量提供。不要把所有轮廓都加粗；当前选中态主要通过青色、浅色底和位置表达。

## Components

### Buttons
按钮采用方正、紧凑的工作台形态，标签单行显示。
- **Primary:** 深色用酸橙填充；浅色用柔和青柠 `light-action`，以 `light-action-border` 收边并搭配深色前景。行动底色不用于正文或小图标；hover 使用稍深的行动底色。高度 38px，水平内边距 16px。
- **Secondary / Ghost:** 使用内容表面、细边框和主文字；高度 38px，水平内边距 13px。悬停时以信号青强化边界与文字，不增加发光装饰。
- **Hover / Focus:** 鼠标 hover 显示边界或背景状态；键盘焦点使用全局可见焦点环。按下反馈轻微，不改变周边布局。
- **Disabled:** 降低对比并明确禁止态，不只靠颜色暗示。

### Chips
状态标签为紧凑的等宽短标签，使用浅色状态底、文字与边界共同表达待处理、进行中、警告、危险和完成状态。状态名称或图标必须与颜色并存；不要仅靠色相传达业务状态。

### Status Badge
小圆角状态徽标（22px 高）以主题对应的低饱和状态底、文字和细边界表达待处理、进行中、警告、危险和完成状态。深色与浅色使用不同的前景、背景和边界映射，状态角色保持不变。

### Cards / Containers
- **Corner Style:** 主工作区使用直角边界。
- **Background:** 内容容器使用当前主题的 surface token；工具条或表头可用次级 surface。
- **Shadow Strategy:** 普通卡片遵循 Elevation & Depth，只有需与内容层区分的层才使用阴影。
- **Border:** 以 1px 语义边界分组；信息区域避免卡片内再套卡片。
- **Internal Padding:** 通用卡片的观察值为 20px；按既有组件的任务密度保留更紧凑的局部内边距。

### Inputs / Fields
输入框使用当前主题内容表面、主文字、细边界、方角和 38px 基准高度，水平内边距 11px。焦点时切换到信号青边界并显示清楚的焦点环；placeholder 使用次级文字且不可代替字段标签。禁用态改用次级表面与弱文字，错误态使用错误色并提供可读错误说明。

### Navigation
桌面侧栏与顶栏共享导航语义色；默认入口低对比，当前入口用信号青、当前底色和图标共同识别。移动端由底部 Dock 承接导航，当前项仍以同一信号色标示。菜单与导航保持方角、细边界和键盘可见焦点。

### Tables
表格按任务数据密度排布，使用固定基准行高、简洁表头、细分隔线和横向滚动容器。hover 行可用主题化的轻底色反馈；通知定位或命中行需保留可见且持久的选择信号，不可只依赖 hover。

### Overlays
菜单、Dialog、Drawer、Toast 和移动 BottomSheet 使用全局语义颜色，因此 Portal 渲染时也跟随根节点主题。遮罩、焦点、标题边界和危险操作在两种模式下都应清楚可辨。减少动效偏好下禁用非必要过渡。

## Do's and Don'ts

### Do:
- **Do** 让主工作台的新颜色来自根级语义 token，并同时确认深色和浅色映射。
- **Do** 让酸橙只承担主操作或完成语义，让青色承担链接、导航和焦点信号。
- **Do** 为警告、危险、完成和中性状态同时提供文字或形状提示。
- **Do** 延续中文黑体、表格密度、直角控件和现有移动导航结构。
- **Do** 在深浅主题中检查表格、输入、浮层、焦点环、禁用态和状态徽标的对比度。
- **Do** 把独立演示和登录界面视为有边界的视觉例外，并在扩展其体验时保持自己的局部系统。

### Don't:
- **Don't** 把深色背景或白色文本硬编码进需要跟随工作台主题的组件。
- **Don't** 将青色与酸橙互换职责，或用高饱和色大面积填充工作区。
- **Don't** 用颜色单独传达状态、错误、选中或可操作性。
- **Don't** 将整套工作台改成统一圆角卡片，或在卡片内部再堆叠无层级意义的卡片。
- **Don't** 把 `/login` 或 `/spark` 的专属配色未经转换就复制到主工作台。
- **Don't** 让动效、阴影或装饰性发光削弱表格扫描、表单操作和键盘导航。
