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
  dark-data-blue: "#7db4ff"
  dark-data-magenta: "#ff8fc7"
  dark-data-aqua: "#5ef0c8"
  dark-data-lemon: "#c6ff72"
  dark-surface-raised: "#13293c"
  dark-series-cyan: "#6cf3ff"
  dark-series-blue: "#7db4ff"
  dark-series-violet: "#bda6ff"
  dark-series-magenta: "#ff8fc7"
  dark-series-coral: "#ff9a6a"
  dark-series-amber: "#ffc46b"
  dark-series-lemon: "#c6ff72"
  dark-series-aqua: "#5ef0c8"
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
  light-data-blue: "#2f5fbf"
  light-data-magenta: "#a03b73"
  light-data-aqua: "#17795f"
  light-data-lemon: "#5f7a1f"
  light-surface-raised: "#f3f7f9"
  light-series-cyan: "#17617d"
  light-series-blue: "#2f5fbf"
  light-series-violet: "#6d4cc2"
  light-series-magenta: "#a03b73"
  light-series-coral: "#a23e39"
  light-series-amber: "#805518"
  light-series-lemon: "#5f7a1f"
  light-series-aqua: "#17795f"
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

`/stream-monitor`（智能音视频平台）同样是隔离的演示产品界面，保留自己的局部控件尺寸体系（见下文「演示站点的控件尺寸基线」）：它按数据密度定档，不并入主工作台的 38px 按钮基线，但沿用本规范的颜色语义、焦点环、直角与 1px 边界。

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

### 演示站点的控件尺寸基线
主工作台的按钮与输入框用 38px 基线（见上）。但 `/spark` 与 `/stream-monitor` 是隔离的演示产品界面，数据密度更高，控件更紧凑 —— 它们**不**并入 38px 基线，而是各自定档。规则相同：

- **同一层级内的交互控件高度必须一致**，不允许同一排里出现 30 / 34 / 36 三种高度；
- **图标按钮是正方形**（宽 = 高），文字按钮按内容宽度 —— 不用内边距把图标按钮撑成非正方形；
- **档位不超过三档**，每档有明确的用途边界（控件 / 徽标 / 分段控件）；
- 高度写成**令牌**（如 `--av-ctl-shell`），不写死像素，否则会重新长出第二套尺寸体系；
- 内容容器的高度（卡片、图表、抽屉）是**另一个量纲**，不与交互控件混为一谈。

`/stream-monitor` 的具体档位（定义在 `web/app/globals.css`）：

| 层级 | 令牌 | 高度 | 适用 |
| --- | --- | --- | --- |
| 壳层 | `--av-ctl-shell` | 34px | 搜索框 / 菜单按钮 / 图标按钮 / 返回链接 / 折叠按钮 |
| 壳层 | `--av-ctl-shell-chip` | 26px | 顶栏状态芯片 |
| 页内 | `--av-ctl-page` | 30px | 页内按钮与输入框 / 对话框行动按钮 |
| 页内 | `--av-ctl-page-tab` | 28px | 分段控件的单个 Tab |
| 页内 | `--av-ctl-badge` | 22px | 告警级别徽标 / 状态标签 / 页头芯片 |

页内比壳层矮一档：页内控件贴着数据行，密度优先；壳层控件是全局导航，目标更大。差值都落在 2–4px 内，肉眼仍是一套系统。窄屏的触控目标（≥ 44px）由各站点的移动端适配负责，不在桌面档位里解决。

窄屏把壳层档抬到 44px 触控档时，**顶栏第一行的宽度预算要一起算**：菜单键 + 状态簇必须装得进手机的内容盒，否则顶栏会多换一行（汉堡键被孤立成一行，顶栏吃掉近两成首屏）。`/stream-monitor` 的做法是：≤430px 隐藏只承载装饰的用户头像、状态簇 gap 收到 6px、「返回主系统」链接不参与弹性收缩。这条预算由 `web/lib/avControlSizes.vitest.test.ts` 守着，实际行数由 `scripts/av-shell-shoot.mjs` 实测。

### 演示站点的排版标定

控件高度（上一节的 `--av-ctl-*`）管的是「按钮 / 徽标 / Tab 有多高」；**排版标定**管的是另一件事：**卡片之间隔多远、卡片里留多少白、卡片最少多高、同行卡片的底边是否对齐**。两者是不同量纲，不能互相替代 —— 高度统一了，卡片照样可以参差不齐。

`/stream-monitor` 的 8 个页面共用一份 CSS，但改之前各页的卡片是各自写的：页面级 gap 有 12 / 10 / 8 / 7 / 6 / 5 / 3 / 2px，卡片内边距有 16 / 14 / 12 / 11 / 9px，同一栅格里的卡片还各写各的 `align-items: start` —— 卡片按内容高度自由伸缩，同一行里左边的卡 300px、右边的卡 180px，底边参差不齐。标定把它收敛成一套可查、可守的规格。

**间距刻度**（定义在 `web/app/globals.css`，4px 基准，只允许这五档）：

| 令牌 | 值 | 用途 |
| --- | --- | --- |
| `--av-space-1` | 4px | 元素级：图标与文字、同一行内的小间隔 |
| `--av-space-2` | 8px | 卡内元素级：行与行之间 |
| `--av-space-3` | 12px | 页面级：区块之间、同一栅格内卡片之间 |
| `--av-space-4` | 16px | 卡片内边距、面板左右内边距 |
| `--av-space-5` | 24px | 大留白：空态、抽屉外框 |

刻度之外的值（2 / 3 / 5 / 6 / 7 / 9 / 10 / 11 / 13 / 14 / 15 / 18 / 22 / 26…）全部归并进来。节奏只有两级：页面级 `--av-gap-section`（12px）与卡内 `--av-gap-card`（8px）—— 中间不得夹 10px 这类值，否则层级差就消失了。

**卡片内边距与高度**：

| 令牌 | 值 | 用途 |
| --- | --- | --- |
| `--av-pad-panel-x` | 16px | 面板头与面板体**共用**的左右内边距 |
| `--av-pad-panel-y` | 12px | 面板头与面板体共用的上下内边距 |
| `--av-pad-card` | 16px | 卡片（度量卡 / 场景卡 / 通道卡 / 状态格）内边距 |
| `--av-card-min-metric` | 120px | 度量卡最小高度 |
| `--av-card-min-status` | 96px | 状态格最小高度 |
| `--av-card-min-scene` | 240px | 场景卡最小高度 |
| `--av-card-min-channel` | 236px | 通道卡最小高度 |

**同类型卡片必须一致**：同类卡片的 `min-height` 消费同一个令牌；度量卡的脚注区固定预留两行，于是「带 note 的卡」与「不带 note 的卡」一样高。

**对齐策略只有两种，且都是显式的**：

- **同行等高**（peer row）—— 并排的卡片底边对齐。栅格走 `align-items: stretch` + 卡片 `height: 100%`，卡片边框被拉到该行最高的那张，整排底边落在同一条线上。
- **竖向侧栏顶对齐**（rail column）—— 右侧一列是若干**互相独立**的面板（离线清单 / 型号构成 / OTA），它们之间没有「同行」关系，强行等高只会让内容少的面板空出一大片，所以走 `align-content: start`。

**圆角**：卡片类一律直角（`--av-radius-card: 0px`）；徽标 / 芯片类才走胶囊（`--av-radius-pill`）—— 胶囊是识别信号的一部分，不能丢。

**字号层级**（只定档，不改视觉）：`--av-text-page`（页面标题）/ `--av-text-title`（卡片与抽屉标题）/ `--av-text-emphasis`（卡片内的等宽数字与计数，比正文重一档）/ `--av-text-panel`（面板标题与分级计数）/ `--av-text-body`（正文）/ `--av-text-note`（辅助说明）/ `--av-text-micro`（等宽微标注）/ `--av-text-tiny`（超小标注）/ `--av-text-figure`（状态格与环形图中心数字）/ `--av-text-kpi`（KPI 大数字）。

档位是**齐全**的：站点实际用到的每个字号（9 / 10 / 11 / 12 / 13 / 14 / 15 / 22px，外加两个 clamp 档）都有一档令牌。缺一档的后果很具体 —— 改之前是 14px 的数字若没有对应档位，令牌化时只能被就近归到 12px，数字的视觉权重就被抹平了，而版面上看不出来。所以「只定档、不改视觉」不是一句承诺，是有机器逐条比对的：令牌化前后的**渲染像素值**必须完全一致（由 `web/lib/av/avFontSizes.vitest.test.ts` 的渲染等价守卫守着）。

**图表高度**是内容容器的量纲，独立于控件基线，只三档：248px（主图：趋势 / 柱状）/ 176px（次图：环形占比、信号曲线）/ 128px（小图：抽屉里的迷你图）。档位定义在 `web/lib/av/chartHeights.ts`（页面里只引用 `AV_CHART_HEIGHT.lg / md / sm`，不写裸数字），同一行内的图表卡用同一档。

**顶栏 / 页面标题 / 卡片左边缘**必须落在同一条竖线上：顶栏与内容区共用一个 `--av-gutter`（桌面 20px / ≤900px 14px / ≤720px 12px），改一处就两处一起动。

这套规格由 `web/lib/av/avLayoutTokens.vitest.test.ts`（间距刻度、卡片圆角、同类卡片等高、栅格对齐、图表高度档位）与 `web/lib/av/avFontSizes.vitest.test.ts`（字号档位齐全、无裸字面量、渲染等价）守着，实测由 `scripts/av-layout-shoot.mjs`（走查五个断点 × 深浅两主题）与 `scripts/av-layout-overflow.mjs`（等高策略会不会让内容溢出）完成。

**卡片溢出的判定口径**（`scripts/av-layout-overflow.mjs` 用它，`web/lib/av/avOverflowRule.vitest.test.ts` 守它）：卡片的内容**超出自己的盒子**就算失败 —— 判据是任一轴的 `scrollHeight/Width` 与 `clientHeight/Width` 之差超过 1px 容差，**不看 `overflow` 计算值**。理由：那六个卡片族在受管 CSS 里一条 `overflow` 都没设（默认 `visible`），若把「是否溢出」挂在「`overflow` ∈ {hidden, clip, auto, scroll}」上，这一半判定**永远不会成立** —— 内容真的溢出盒子时工具反而报绿灯。内容是被裁、可滚动还是溢出到盒子外，只影响报告里的措辞，不影响「算不算失败」。判定逻辑放在 `scripts/lib/avOverflowRule.mjs`，脚本与守卫共用同一份，不会各自漂移。

### 演示站点的色彩体系与动效节奏

`/stream-monitor` 是对外演示用的产品界面，色彩要「丰富、可分」而不是「克制、少色」。但多色不等于多套色值：颜色仍然只有**一个真源** `web/app/globals.css`，组件里不出现任何 `#hex` / `rgb()`（由 `web/lib/avSourceGuard.vitest.test.ts` 守着）。这一节说明 AV 站点在既有语义色之外多出来的两组东西。

**数据系列色（8 档）**。语义色（危险 / 警告 / 完成 / 信号 / 执行 / 数据紫 / 中性）只回答「这是什么状态」，多系列图表要的是「这条线是第几条」，所以另起一组 `--av-series-1..8`：

| 令牌 | 色相 | 深色 | 浅色 | 典型用途 |
| --- | --- | --- | --- | --- |
| `--av-series-1` | 青 | `--brand` | `--brand` | 主系列（告警量 / 第一条线） |
| `--av-series-2` | 蓝 | `--data-blue` | `--data-blue` | 对比系列 |
| `--av-series-3` | 紫 | `--data-violet` | `--data-violet` | 事件 / 次维度 |
| `--av-series-4` | 品红 | `--data-magenta` | `--data-magenta` | 第三、第四条线 |
| `--av-series-5` | 珊瑚 | `--danger` | `--danger` | 下降 / 异常趋势 |
| `--av-series-6` | 琥珀 | `--warn` | `--warn` | 接近阈值的系列 |
| `--av-series-7` | 柠檬 | `--data-lemon` | `--data-lemon` | 增量 / 新系列 |
| `--av-series-8` | 水绿 | `--data-aqua` | `--data-aqua` | 已处置 / 健康度 |

两条规则：

- **语义色不借给数据系列，系列色不借给状态**。告警级别、设备状态、算法状态永远用语义色；图表里「第 N 条系列」用系列色。这样「珊瑚」在页面上只有一种含义。
- **系列色在两种主题下都必须对卡片底保持 ≥ 3:1 对比度**（图表线不是文字，3:1 是可见性下限）。所以柠檬没有复用 `--action`（浅色下它是按钮底色，`#c6df7b` 画在白底上几乎看不见），而是单独给了 `--data-lemon`。这条由 `web/lib/av/avColorTokens.vitest.test.ts` 逐档计算守着。

组件入口统一在 `web/lib/av/tone.ts`：`toneVar(tone)` 产出 `var(--av-tone-*)`，`seriesVar(n)` 产出 `var(--av-series-n)`，`colorVar(tone | "series-n")` 是两者共用的入口 —— 页面不需要知道某个颜色属于哪一组。

**KPI 数字与色条同色**。度量卡、状态格、图例里的数字跟随自己的颜色（`--metric-tone` / `--tone`），左边 2px 色条、图标、数字三者同色；**卡片底色保持中性**。这是「卡片克制、数字醒目」的具体做法：一屏四个 KPI，靠数字和色条区分类别，靠底色区分只会变成满屏色块。

**分层表面与每页光晕**。改之前暗色只有 `#07131f`（底）与 `#0d1d2c`（卡）两个值，整屏一个深蓝平板。现在表面分三档，并且每个页面有一档自己的极淡光晕：

| 令牌 | 深色 | 浅色 | 用途 |
| --- | --- | --- | --- |
| `--av-surface-1` | `#07131f` | `#f1f5f7` | 页面底（画布） |
| `--av-surface-2` | `#0d1d2c` | `#ffffff` | 卡片 / 面板 / 状态格 |
| `--av-surface-3` | `#13293c` | `#f3f7f9` | 抬升面：表头、面板头、hover |

光晕（页面底色上的 `radial-gradient`，暗色是 8% 左右的洗色，浅色是同色系浅底）：`--av-tint-overview` 青 / `--av-tint-monitor` 紫 / `--av-tint-alarm` 珊瑚 / `--av-tint-event` 琥珀 / `--av-tint-device` 柠檬绿。它们全部是既有 soft 底色的别名，因此深浅主题自动跟随，不需要在浅色块里再抄一份值。

**动效节奏（演示档）**。对外讲解时，观众要**看得见**动效在发生：240ms 的面板入场在投影上几乎一帧结束，看不出错峰与层次。所以主力档与慢档放慢，操作反馈档不动（变慢就是发黏）：

| 令牌 | 值 | 用途 |
| --- | --- | --- |
| `--av-dur-instant` | 90ms | 按下 / 开关 / 焦点环 |
| `--av-dur-quick` | 160ms | hover / 徽标变更 / 退场 |
| `--av-dur-base` | 300ms | 抽屉、面板入场、Tab 切换 |
| `--av-dur-slow` | 600ms | 页面级入场、图表入场、KPI 滚动 |
| `--av-stagger-list` | 45ms | 列表错峰步长（前 10 项） |
| `--av-stagger-timeline` | 90ms | 时间线节点错峰 |

0.65s 是慢档的硬上限：再慢就会被读成卡顿。`?static=1`（截图 / 录屏）与 `prefers-reduced-motion: reduce` 下所有时长归零、动画包装不渲染，同一 URL 连拍三次必须逐字节一致；数值契约由 `web/lib/av/motion.vitest.test.ts` 钉死。

**图表尺寸的隐藏契约**。recharts 的 `ResponsiveContainer` 以 `height: 100%` 向上找「有确定高度的父节点」，中间任何一层包裹节点只写 `animation` 而不写高度，整张图就会量到 0×0 后什么都不画（BLF-1423 的 P0：告警趋势、7 日柱状、设备抽屉的信号曲线全部空白，而自带 inline 高度的环形图仍然可见）。现在的口径是：**档位高度只由 `ChartFrame` 的 `.frame`（inline `height`）提供，包裹层 `.skeletonSwap` 负责传递 `100%`**，两处不重复打补丁。这条由 `web/lib/av/chartFrameHeight.vitest.test.tsx` 守着 —— 既有源码断言（`.skeletonSwap` 必须有 `height: 100%`），也有真实渲染后的祖先链断言（含 `?static=1` 那条不套包裹层的分支）。

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
