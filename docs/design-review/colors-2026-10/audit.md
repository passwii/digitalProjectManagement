# 前端配色审计报告（2026-10）

> 审计对象：web/（Next.js 14 App Router 前端）。源码基于 HEAD 0d8088b（2026-10-24），审计时工作树源码无改动。
> 审计范围：web/app/globals.css 的深浅两套令牌；web/app 与 web/components 下的 *.module.css、*.tsx。
> 只读约束：未修改任何源码 / 样式，未运行 npm test、npm run build，未启动 dev server（本机无后端与数据库）。
> 本报告只给事实与数字，不含任何替换色值的方案。

## 0. 关键数字

- 颜色类令牌 73 个：深色定义 68 个；浅色显式覆盖 67 个、继承深色 6 个头像色；另有 5 个令牌只在浅色块定义（深色缺失）。
- 硬编码色值：去注释后 17 个文件 581 处（原始 rg 口径 20 个文件 593 处，差额 12 处为注释与 issue 编号误报）。其中 components/spark 456 处、app/login 100 处，合计 556 / 581 = 95.7%。
- --brand：117 处直接引用（110 行 / 30 个文件），再经 9 个别名被消费 116 处，合计 233 个引用点。
- WCAG 未达标 3 类 / 7 个测量点：深色 ink-3 4.00:1、深色 ink-3 叠 card 3.92:1（文本 4.5 阈值）；浅色 todo 叠 todo-bg 4.39:1（文本阈值）；line 分隔线 深 1.55:1 / 浅 1.21:1（非文本 3 阈值）。
- 主题等价性：8 组同名令牌，8/8 浅色 OKLCH 明度更低（平均 ΔL -30.4pp），8/8 深色 HSL 饱和度为 100%、浅色 34%–69%，2 组色相翻转超过 80°。
- 隔离入口：/spark 0 个 data-theme 选择器（主题切换对它无效）；/stream-monitor 的 Av 层 0 处 hex/rgba、846 处 var(--av-*) 消费（完全复用主令牌）。

## 1. 令牌对账

两组定义位置：深色 <code>web/app/globals.css:1-144</code>（:root），浅色 <code>web/app/globals.css:146-221</code>（:root[data-theme="light"]）。下表 73 个颜色令牌按语义组排列；阴影令牌（--shadow-card / --shadow-float / --shadow-drawer / --nav-shadow / --dock-shadow）不含纯色值，不在此表。rgba 的“等效”列按表下口径折算到假设底色；浅色未覆盖的令牌沿用深色值（表内已写出等效值）。


| 语义组 | 角色（令牌） | 深色值 | 深色等效 | 浅色值 | 浅色等效 | 值类型 |
| --- | --- | --- | --- | --- | --- | --- |
| 表面 | 页面底色 (bg) | #07131f | #07131f | #f1f5f7 | #f1f5f7 | hex |
| 表面 | 卡片 / 面板面 (card) | #0d1d2c | #0d1d2c | #ffffff | #ffffff | hex |
| 表面 | 抬升表面（表头、面板头） (card-lift) | #13293c | #13293c | #f3f7f9 | #f3f7f9 | hex |
| 表面 | 表头底（半透明） (th-bg) | rgba(13, 29, 44, 0.72) | #0d1d2c | #e8eef2 | #e8eef2 | rgba / hex |
| 表面 | 品牌深蓝基准（侧栏 / 登录深色区） (navy) | #081622 | #081622 | #142f40 | #142f40 | hex |
| 表面 | 遮罩 (overlay) | rgba(7, 19, 31, 0.56) | #07131f | rgba(28, 44, 56, .28) | #b5bdc2 | rgba |
| 文字 | 主文字 (ink) | #eaf9fb | #eaf9fb | #1c2c38 | #1c2c38 | hex |
| 文字 | 次级文字 (ink-2) | rgba(201, 227, 235, 0.72) | #93a9b2 | #526575 | #526575 | rgba / hex |
| 文字 | 三级 / 辅助文字 (ink-3) | rgba(201, 227, 235, 0.48) | #647781 | #5e707d | #5e707d | rgba / hex |
| 文字 | 品牌色上的文字 (on-brand) | #07131f | #07131f | #f4f8fa | #f4f8fa | hex |
| 文字 | 主按钮上的文字 (on-action) | #07131f | #07131f | #26351a | #26351a | hex |
| 文字 | 危险按钮上的文字 (on-danger) | #07131f | #07131f | #ffffff | #ffffff | hex |
| 描边 / 分隔 | 主分隔线 (line) | rgba(146, 189, 210, 0.22) | #263846 | #d8e1e7 | #d8e1e7 | rgba / 别名 |
| 描边 / 分隔 | 弱分隔线 (line-soft) | rgba(146, 189, 210, 0.12) | #182734 | #e7edf1 | #e7edf1 | rgba / hex |
| 描边 / 分隔 | 分隔线（仅浅色定义） (separator) | — | — | #d8e1e7 | #d8e1e7 | 未定义 / hex |
| 描边 / 分隔 | 表单控件描边（仅浅色定义） (control-border) | — | — | #82939e | #82939e | 未定义 / hex |
| 描边 / 分隔 | 主按钮描边（仅浅色定义） (action-border) | — | — | #adc95d | #adc95d | 未定义 / hex |
| 描边 / 分隔 | 导航边框 (nav-border) | rgba(255, 255, 255, .08) | #1c2934 | #314b5a | #314b5a | rgba / hex |
| 描边 / 分隔 | 品牌色描边 (line-blue) | rgba(108, 243, 255, 0.34) | #295f6b | rgba(23, 97, 125, .34) | #a7c3ce | rgba |
| 描边 / 分隔 | 警告描边 (line-warn) | rgba(255, 196, 107, 0.42) | #6f5d3f | rgba(128, 85, 24, .42) | #c2b299 | rgba |
| 描边 / 分隔 | 危险描边 (line-danger) | rgba(255, 154, 106, 0.42) | #6f4c3f | rgba(162, 62, 57, .42) | #d0a8a7 | rgba |
| 描边 / 分隔 | 完成描边 (line-done) | rgba(198, 255, 114, 0.42) | #577642 | rgba(53, 107, 75, .42) | #a2bbaf | rgba |
| 品牌 | 品牌信号色 (brand) | #6cf3ff | #6cf3ff | #17617d | #17617d | hex |
| 品牌 | 品牌色悬停 (brand-hover) | #c6ff72 | #c6ff72 | #124d64 | #124d64 | hex |
| 品牌 | 品牌淡底 (brand-soft) | rgba(108, 243, 255, 0.08) | #0f2531 | #e6f0f4 | #e6f0f4 | rgba / hex |
| 品牌 | 品牌 / 焦点光晕 (signal-glow) | rgba(108, 243, 255, .18) | #193b47 | rgba(23, 97, 125, .12) | #d7e3e8 | rgba |
| 动作 | 主按钮底色 (action) | #c6ff72 | #c6ff72 | #c6df7b | #c6df7b | hex |
| 动作 | 主按钮悬停底 (action-hover) | #d9ff9b | #d9ff9b | #bdd76e | #bdd76e | hex |
| 状态 | 待办状态文字 (todo) | #9cb4c4 | #9cb4c4 | #5e707d | #5e707d | hex |
| 状态 | 待办状态底 (todo-bg) | rgba(146, 189, 210, 0.08) | #12212d | #e8eef2 | #e8eef2 | rgba / hex |
| 状态 | 进行中状态 (doing) | #6cf3ff | #6cf3ff | #17617d | #17617d | hex |
| 状态 | 进行中状态底 (doing-bg) | rgba(108, 243, 255, 0.08) | #0f2531 | #e6f0f4 | #e6f0f4 | rgba / hex |
| 状态 | 完成状态 (done) | #c6ff72 | #c6ff72 | #356b4b | #356b4b | hex / 别名 |
| 状态 | 完成状态底 (done-bg) | rgba(198, 255, 114, 0.09) | #182826 | #e9f2eb | #e9f2eb | rgba / hex |
| 状态 | 成功文字（仅浅色定义） (success-ink) | — | — | #356b4b | #356b4b | 未定义 / hex |
| 状态 | 警告状态 (warn) | #ffc46b | #ffc46b | #805518 | #805518 | hex |
| 状态 | 警告状态底 (warn-bg) | rgba(255, 196, 107, 0.09) | #1d2326 | #f7f0df | #f7f0df | rgba / hex |
| 状态 | 危险状态 (danger) | #ff9a6a | #ff9a6a | #a23e39 | #a23e39 | hex |
| 状态 | 危险状态底 (danger-bg) | rgba(255, 154, 106, 0.09) | #1d1f26 | #f7eae8 | #f7eae8 | rgba / hex |
| 状态 | 暂停状态 (paused) | #9cb4c4 | #9cb4c4 | #5e707d | #5e707d | hex |
| 状态 | 暂停状态底 (paused-bg) | rgba(146, 189, 210, 0.08) | #12212d | #e8eef2 | #e8eef2 | rgba / hex |
| 状态 | 数据紫淡底 (violet-soft) | rgba(189, 166, 255, 0.10) | #192235 | #efeafb | #efeafb | rgba / hex |
| 数据系列 | 数据系列：紫 (data-violet) | #bda6ff | #bda6ff | #6d4cc2 | #6d4cc2 | hex |
| 数据系列 | 数据系列：蓝 (data-blue) | #7db4ff | #7db4ff | #2f5fbf | #2f5fbf | hex |
| 数据系列 | 数据系列：品红 (data-magenta) | #ff8fc7 | #ff8fc7 | #a03b73 | #a03b73 | hex |
| 数据系列 | 数据系列：水绿 (data-aqua) | #5ef0c8 | #5ef0c8 | #17795f | #17795f | hex |
| 数据系列 | 数据系列：柠檬 (data-lemon) | #c6ff72 | #c6ff72 | #5f7a1f | #5f7a1f | hex |
| 数据系列 | 数据系列：绿（仅浅色定义） (data-green) | — | — | #587839 | #587839 | 未定义 / hex |
| 导航 | 导航 / 侧栏底色 (nav-bg) | #081622 | #081622 | #142f40 | #142f40 | hex |
| 导航 | 导航主文字 (nav-ink) | #eaf2ff | #eaf2ff | #f4f8fa | #f4f8fa | hex |
| 导航 | 导航次级文字 (nav-muted) | rgba(231, 239, 252, .72) | #a9b2bf | #bdcbd3 | #bdcbd3 | rgba / hex |
| 导航 | 导航悬停底 (nav-hover-bg) | rgba(255, 255, 255, .07) | #192631 | rgba(244, 248, 250, .08) | #263f4f | rgba |
| 导航 | 导航激活底 (nav-active-bg) | rgba(108, 243, 255, .06) | #0e232f | #244657 | #244657 | rgba / hex |
| 导航 | 导航激活文字 (nav-active-ink) | #eaf2ff | #eaf2ff | #f4f8fa | #f4f8fa | 别名 / hex |
| 导航 | 导航激活强调色 (nav-active-accent) | #6cf3ff | #6cf3ff | #c6df7b | #c6df7b | 别名 / hex |
| 导航 | 导航徽标描边 (nav-badge-border) | #081622 | #081622 | #f4f8fa | #f4f8fa | 别名 |
| Dock（别名） | 移动 Dock 底 (dock-bg) | #081622 | #081622 | #ffffff | #ffffff | 别名 |
| Dock（别名） | 移动 Dock 文字 (dock-ink) | #eaf2ff | #eaf2ff | #1c2c38 | #1c2c38 | 别名 |
| Dock（别名） | 移动 Dock 次级文字 (dock-muted) | rgba(231, 239, 252, .72) | #a8b1be | #526575 | #526575 | 别名 |
| Dock（别名） | 移动 Dock 悬停底 (dock-hover-bg) | rgba(255, 255, 255, .07) | #18242f | #edf2f5 | #edf2f5 | 别名 |
| Dock（别名） | 移动 Dock 激活底 (dock-active-bg) | rgba(108, 243, 255, .06) | #0d202c | #e6f0f4 | #e6f0f4 | 别名 |
| Dock（别名） | 移动 Dock 激活强调 (dock-active-accent) | #6cf3ff | #6cf3ff | #17617d | #17617d | 别名 |
| Dock（别名） | 移动 Dock 焦点 (dock-focus) | #6cf3ff | #6cf3ff | #17617d | #17617d | 别名 |
| Dock（别名） | 移动 Dock 徽标描边 (dock-badge-border) | #081622 | #081622 | #ffffff | #ffffff | 别名 |
| 头像 | 头像底色 1 (avatar-1) | #1677ff | #1677ff | #1677ff | #1677ff | hex |
| 头像 | 头像底色 2 (avatar-2) | #6e56cf | #6e56cf | #6e56cf | #6e56cf | hex |
| 头像 | 头像底色 3 (avatar-3) | #2c9c69 | #2c9c69 | #2c9c69 | #2c9c69 | hex |
| 头像 | 头像底色 4 (avatar-4) | #d48806 | #d48806 | #d48806 | #d48806 | hex |
| 头像 | 头像底色 5 (avatar-5) | #b24d86 | #b24d86 | #b24d86 | #b24d86 | hex |
| 头像 | 头像底色 6 (avatar-6) | #d14343 | #d14343 | #d14343 | #d14343 | hex |
| 交互 / 骨架 | 表格行悬停 (row-hover) | rgba(108, 243, 255, 0.05) | #122837 | #edf2f5 | #edf2f5 | rgba / hex |
| 交互 / 骨架 | 骨架基色 (skeleton-base) | rgba(146, 189, 210, .08) | #182a39 | #e7edf1 | #e7edf1 | rgba / hex |
| 交互 / 骨架 | 骨架高光 (skeleton-shine) | rgba(108, 243, 255, .16) | #1c3f4e | #eff3f6 | #eff3f6 | rgba / hex |

合成底色假设：ink-2/ink-3/line*/ *-bg /brand-soft/violet-soft/overlay/signal-glow → --bg；th-bg/row-hover/skeleton-* → --card；nav-muted/nav-border/nav-hover-bg/nav-active-bg → --nav-bg。

补充事实：

- 深色缺失的 5 个令牌里，<code>--separator</code>、<code>--action-border</code>、<code>--success-ink</code> 的引用点全部落在浅色覆盖块内；<code>--control-border</code> 在 <code>web/app/globals.css:333</code> 有 <code>var(--control-border, var(--line))</code> 的深色回退；<code>--data-green</code> 0 处引用。
- 值复用：<code>--brand</code> = <code>--doing</code> = #6cf3ff；<code>--action</code> = <code>--done</code> = <code>--data-lemon</code> = <code>--brand-hover</code>（深色）= #c6ff72；<code>--todo</code> = <code>--paused</code> = #9cb4c4；<code>--nav-bg</code> = <code>--navy</code> = #081622；<code>--todo-bg</code> = <code>--paused-bg</code>。这些“同一字面值挂多个语义名”的关系见 <code>web/app/globals.css:9-11, 23-26, 43-47, 93</code>。
- 浅色 Dock 跟随卡片面（<code>web/app/globals.css:203-210</code>：dock-bg = card、dock-ink = ink），而侧栏仍是深海蓝（nav-bg = #142f40）；深色下 Dock 与侧栏同面（<code>web/app/globals.css:102-109</code>）。

## 2. 对比度实测

口径：WCAG 2.1 sRGB 相对亮度；半透明前景先合成到背景再计算；文本阈值 4.5:1、非文本 / 焦点指示 3:1（按任务要求；3:1 对应 WCAG 1.4.11 对 UI 组件与图形对象的要求，分隔线是否属于“图形对象”需按用途判断，这里只报数值）。背景为半透明时先叠到其实际承载面（*-bg 叠 --bg；nav-active-bg 叠 --nav-bg；done-bg / todo-bg 叠 --bg）。

### 2.1 深色

| 组合 | 前景等效 | 背景等效 | 对比度 | 阈值 | 结果 |
| --- | --- | --- | --- | --- | --- |
| ink / bg | #eaf9fb | #07131f | **17.33:1** | 4.5:1 | 通过 |
| ink-2 / bg | #93a9b2 | #07131f | **7.61:1** | 4.5:1 | 通过 |
| ink-3 / bg | #647781 | #07131f | **4.00:1** | 4.5:1 | **未达标** |
| ink / card | #eaf9fb | #0d1d2c | **15.82:1** | 4.5:1 | 通过 |
| ink-2 / card | #94acb6 | #0d1d2c | **7.16:1** | 4.5:1 | 通过 |
| ink-3 / card | #677c88 | #0d1d2c | **3.92:1** | 4.5:1 | **未达标** |
| brand / bg | #6cf3ff | #07131f | **14.17:1** | 4.5:1 | 通过 |
| brand / card | #6cf3ff | #0d1d2c | **12.94:1** | 4.5:1 | 通过 |
| on-action / action | #07131f | #c6ff72 | **16.00:1** | 4.5:1 | 通过 |
| on-brand / brand | #07131f | #6cf3ff | **14.17:1** | 4.5:1 | 通过 |
| warn / bg | #ffc46b | #07131f | **11.91:1** | 4.5:1 | 通过 |
| danger / bg | #ff9a6a | #07131f | **8.99:1** | 4.5:1 | 通过 |
| done / done-bg | #c6ff72 | #182826 | **13.06:1** | 4.5:1 | 通过 |
| todo / todo-bg | #9cb4c4 | #12212d | **7.62:1** | 4.5:1 | 通过 |
| nav-ink / nav-bg | #eaf2ff | #081622 | **16.24:1** | 4.5:1 | 通过 |
| nav-muted / nav-bg | #a9b2bf | #081622 | **8.55:1** | 4.5:1 | 通过 |
| nav-active-accent / nav-active-bg | #6cf3ff | #0e232f | **12.20:1** | 4.5:1 | 通过 |
| line / bg（非文本） | #263846 | #07131f | **1.55:1** | 3:1 | **未达标** |
| line / card（非文本） | #2a4051 | #0d1d2c | **1.59:1** | 3:1 | **未达标** |
| brand 焦点环 / bg（非文本） | #6cf3ff | #07131f | **14.17:1** | 3:1 | 通过 |
| brand 焦点环 / card（非文本） | #6cf3ff | #0d1d2c | **12.94:1** | 3:1 | 通过 |

### 2.2 浅色

| 组合 | 前景等效 | 背景等效 | 对比度 | 阈值 | 结果 |
| --- | --- | --- | --- | --- | --- |
| ink / bg | #1c2c38 | #f1f5f7 | **13.05:1** | 4.5:1 | 通过 |
| ink-2 / bg | #526575 | #f1f5f7 | **5.51:1** | 4.5:1 | 通过 |
| ink-3 / bg | #5e707d | #f1f5f7 | **4.68:1** | 4.5:1 | 通过 |
| ink / card | #1c2c38 | #ffffff | **14.32:1** | 4.5:1 | 通过 |
| ink-2 / card | #526575 | #ffffff | **6.04:1** | 4.5:1 | 通过 |
| ink-3 / card | #5e707d | #ffffff | **5.13:1** | 4.5:1 | 通过 |
| brand / bg | #17617d | #f1f5f7 | **6.29:1** | 4.5:1 | 通过 |
| brand / card | #17617d | #ffffff | **6.90:1** | 4.5:1 | 通过 |
| on-action / action | #26351a | #c6df7b | **8.86:1** | 4.5:1 | 通过 |
| on-brand / brand | #f4f8fa | #17617d | **6.46:1** | 4.5:1 | 通过 |
| warn / bg | #805518 | #f1f5f7 | **5.93:1** | 4.5:1 | 通过 |
| danger / bg | #a23e39 | #f1f5f7 | **5.83:1** | 4.5:1 | 通过 |
| done / done-bg | #356b4b | #e9f2eb | **5.47:1** | 4.5:1 | 通过 |
| todo / todo-bg | #5e707d | #e8eef2 | **4.39:1** | 4.5:1 | **未达标** |
| nav-ink / nav-bg | #f4f8fa | #142f40 | **13.01:1** | 4.5:1 | 通过 |
| nav-muted / nav-bg | #bdcbd3 | #142f40 | **8.37:1** | 4.5:1 | 通过 |
| nav-active-accent / nav-active-bg | #c6df7b | #244657 | **6.82:1** | 4.5:1 | 通过 |
| line / bg（非文本） | #d8e1e7 | #f1f5f7 | **1.21:1** | 3:1 | **未达标** |
| line / card（非文本） | #d8e1e7 | #ffffff | **1.33:1** | 3:1 | **未达标** |
| brand 焦点环 / bg（非文本） | #17617d | #f1f5f7 | **6.29:1** | 3:1 | 通过 |
| brand 焦点环 / card（非文本） | #17617d | #ffffff | **6.90:1** | 3:1 | 通过 |

### 2.3 未达标汇总

| 主题 | 组合 | 实测 | 阈值 | 用途 |
| --- | --- | --- | --- | --- |
| 深色 | ink-3 / bg | 4.00:1 | 4.5:1 | 三级 / 辅助文字 |
| 深色 | ink-3 / card | 3.92:1 | 4.5:1 | 卡片上的三级 / 辅助文字 |
| 浅色 | todo / todo-bg | 4.39:1 | 4.5:1 | 待办状态文字 |
| 深色 | line / bg | 1.55:1 | 3:1 | 主分隔线 / 边框 |
| 深色 | line / card | 1.59:1 | 3:1 | 卡片内分隔线 / 边框 |
| 浅色 | line / bg | 1.21:1 | 3:1 | 主分隔线 / 边框 |
| 浅色 | line / card | 1.33:1 | 3:1 | 卡片内分隔线 / 边框 |

说明：line 在深浅两套主题、两种承载面上都低于 3:1；但它是 1px 分隔线，是否构成 WCAG 1.4.11 的“非文本内容”取决于它是否承担控件边界语义（部分边框用于输入框 / 按钮边界，此时适用）。本表只提供测量值，不做合规判定。

## 3. 硬编码色值清点

扫描口径：web/app 与 web/components 下 *.module.css 与 *.tsx；正则 <code>#[0-9a-fA-F]{3,8}\b|\brgba?\([^)]*\)|\bhsla?\([^)]*\)</code>。粗口径（含注释与 issue 编号）20 个文件 593 处；脚本去注释后的有效值 17 个文件 581 处。差额 12 处：CSS 注释 4 处（login 1、PasswordInput 3），TSX 注释与 issue 编号 8 处（app/layout.tsx 1、app/spark/layout.tsx 2、app/stream-monitor/layout.tsx 3（其中 #425 是 issue 编号）、components/av/pages/AlarmView.tsx 1、components/av/pages/AudioView.tsx 1）。

### 3.1 按文件分布（去注释口径，581 处）

| 文件 | 处数 | 其中在浅色覆盖块 |
| --- | --- | --- |
| components/spark/SparkPages.module.css | 102 | 0 |
| app/login/login.module.css | 100 | 30 |
| components/spark/pages/BillingContent.module.css | 85 | 0 |
| components/spark/pages/SecurityOpsPermission.module.css | 85 | 0 |
| components/spark/SparkShell.module.css | 71 | 0 |
| components/spark/pages/DashboardStoreCompute.module.css | 71 | 0 |
| components/spark/pages/DashboardPage.tsx | 18 | 0 |
| components/spark/pages/BillingPage.tsx | 12 | 0 |
| components/spark/pages/ComputePage.tsx | 11 | 0 |
| components/ui/Select.module.css | 10 | 0 |
| components/motion/StorySteps.module.css | 6 | 0 |
| components/ui/PasswordInput.module.css | 5 | 0 |
| app/(dashboard)/finance/finance.module.css | 1 | 0 |
| app/layout.tsx | 1 | 0 |
| app/spark/layout.tsx | 1 | 0 |
| components/spark/pages/PermissionPage.tsx | 1 | 0 |
| components/ui/DatePicker.module.css | 1 | 0 |

分布结论：components/spark 456 处（78.5%）、app/login 100 处（17.2%），两者合计 95.7%；剩余 25 处散在 Select（10）、StorySteps（6）、PasswordInput（5）、finance（1）、两个 layout（各 1）、DatePicker（1）。581 处字面量共 386 种不同字面写法，重复最多的为 rgba(194,211,239,.1) 13 次、#22d3ee 12 次、#a855f7 9 次、#34d399 7 次、#8290a4 6 次。

### 3.2 最严重的 20 处

排序口径：优先“整站私有色板根定义”>“浅色覆盖块内手写令牌分量”>“共享组件的第三套皮肤”>“内联 TSX 图表色”；同一类内按文件处数取代表行。表中“浅色块”指该行是否位于 :root[data-theme="light"] 选择器块内。

| # | file:line | 值 | 浅色块 | 性质 |
| --- | --- | --- | --- | --- |
| 1 | web/app/login/login.module.css:2 | #07131f | 否 | 私有 --login-bg，等于主 --bg |
| 2 | web/app/login/login.module.css:3 | #0d1d2c | 否 | 私有 --login-surface，等于主 --card |
| 3 | web/app/login/login.module.css:4 | rgba(146, 189, 210, 0.2) | 否 | 与主 --line 同 RGB，α 从 .22 改为 .20 |
| 4 | web/app/login/login.module.css:5 | #eaf9fb | 否 | 私有 --login-ink，等于主 --ink |
| 5 | web/app/login/login.module.css:6 | rgba(201, 227, 235, 0.64) | 否 | 与主 --ink-2 同 RGB，α 从 .72 改为 .64 |
| 6 | web/app/login/login.module.css:7 | rgba(201, 227, 235, 0.38) | 否 | 与主 --ink-3 同 RGB，α 从 .48 改为 .38 |
| 7 | web/app/login/login.module.css:769 | rgba(23, 97, 125, 0.09) | 是 | 浅色 --brand #17617d 的 RGB 分量手写 |
| 8 | web/app/login/login.module.css:885 | rgba(23, 97, 125, 0.42) | 是 | 同上（token RGB 手写） |
| 9 | web/components/spark/SparkShell.module.css:2 | #070a12 | 否 | 私有 --spark-bg |
| 10 | web/components/spark/SparkShell.module.css:3 | #0a0f1c | 否 | 私有 --spark-sidebar |
| 11 | web/components/spark/SparkShell.module.css:4 | #111722 | 否 | 私有 --spark-panel |
| 12 | web/components/spark/SparkShell.module.css:5 | #151c29 | 否 | 私有 --spark-panel-raised |
| 13 | web/components/spark/SparkShell.module.css:6 | rgba(194, 211, 239, .1) | 否 | 私有 --spark-line |
| 14 | web/components/spark/SparkShell.module.css:7 | rgba(194, 211, 239, .16) | 否 | 私有 --spark-line-strong |
| 15 | web/components/spark/SparkShell.module.css:8 | #e6edf7 | 否 | 私有 --spark-ink |
| 16 | web/components/spark/SparkShell.module.css:9 | #8490a4 | 否 | 私有 --spark-muted |
| 17 | web/components/ui/Select.module.css:114 | #151d2d | 否 | Select.spark 皮肤底色 |
| 18 | web/components/ui/Select.module.css:118 | #70dfed | 否 | Select.spark 强调色（第三种青） |
| 19 | web/components/spark/pages/BillingPage.tsx:32 | #22d3ee | 否 | 图表渐变内联 SVG stopColor |
| 20 | web/components/spark/pages/DashboardPage.tsx:54 | #101724 | 否 | 图表 tooltip 背景内联 style |

同类延续（未单列）：web/components/spark/SparkShell.module.css:10-15 还有 #5e6a7e / #22d3ee / #a855f7 / #34d399 / #fbbf24 / #fb7185；web/components/ui/Select.module.css:115-123 还有 9 个 spark 皮肤值；web/components/motion/StorySteps.module.css:34,49 使用 #68AFFF（登录页步骤条强调蓝）；web/components/ui/PasswordInput.module.css:23-33 在深色基准里硬编码 #86a4b3 与品牌青 / 酸橙的 rgba。

### 3.3 浅色覆盖块内的字面量（login）

<code>sed -n '751,1021p' web/app/login/login.module.css</code> 内共 30 处颜色字面量，按 RGB 三元组归类：

| RGB 分量 | 处数 | 对应令牌（浅色） |
| --- | --- | --- |
| 23, 97, 125 | 16 | --brand #17617d |
| 244, 248, 250 | 10 | --nav-ink / --on-brand #f4f8fa |
| 198, 223, 123 | 3 | --action #c6df7b |
| 7, 19, 31 | 1 | 深色 --bg #07131f（浅色品牌栏的阴影 / 渐变用） |

即：浅色覆盖块的 30 处字面量全部是现有令牌颜色分量的手写副本；<code>web/lib/loginLightMode.vitest.test.ts:123-137</code> 的“浅色段不留深色硬编码”只检查 9 个深色字面值，不要求使用 var()，因此这 30 处不会被守卫拦下。

### 3.4 复现命令

        cd web
        rg -l --glob '*.module.css' --glob '*.tsx' '#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(' app components | wc -l    # 20（粗口径文件数）
        rg -o --glob '*.module.css' --glob '*.tsx' '#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(' app components | wc -l    # 593（粗口径处数）
        sed -n '751,1021p' app/login/login.module.css | rg -o '#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)' | wc -l    # 30
        cd ..
        node docs/design-review/colors-2026-10/contrast.mjs --scan    # 17 个文件 / 581 处（去注释）

## 4. --brand 一词多职责

口径：直接引用 = 全部 *.css / *.tsx 中文本 <code>var(--brand)</code> 的出现次数，共 117 处 / 110 行 / 30 个文件。按行内属性优先级（别名 > outline > box-shadow > caret/accent > stroke/fill > background > border > color）归入一个语义组；同一行含多个属性的按首个命中的组计数，故合计仍为 117。

| 语义分组（按行内属性优先级归类） | 引用处数 | 示例 |
| --- | --- | --- |
| 令牌别名定义（把 --brand 转成其他语义） | 9 | app/globals.css:100 --nav-active-accent；app/globals.css:2663 --av-signal |
| 焦点外框（outline / outline-color） | 12 | app/globals.css:405 outline: 2px solid；components/ui/CardList.module.css:98 |
| 高亮环 / 内阴影（box-shadow） | 6 | app/globals.css:372 box-shadow ring；app/(dashboard)/changelog/changelog.module.css:207 |
| 原生控件（光标 / checkbox accent） | 2 | app/globals.css:288 caret-color；app/globals.css:358 accent-color |
| 图表系列（stroke / fill） | 2 | app/(dashboard)/dashboard/page.tsx:301 stroke=var(--brand) |
| 背景填充（选中块 / 进度条 / 徽标 / 图表点） | 16 | components/ui/ProgressBar.module.css:4；components/motion/ActivityBar.module.css:17 |
| 控件描边与悬停边框 | 33 | app/globals.css:366 input focus border；components/ui/DatePicker.module.css:217 |
| 文字 / 链接 / 图标颜色 | 36 | app/globals.css:292 a 链接；components/ui/Shell.module.css:206 导航激活图标 |
| 其他（列表左侧指示条等） | 1 | app/globals.css:696 inset 3px 0 0 |
| **合计** | **117** | 110 行 / 30 个文件 |

| 别名 | 语义 | 定义位置 | 消费处数 |
| --- | --- | --- | --- |
| --nav-active-accent | 导航激活强调色 | app/globals.css:100 | 17 |
| --dock-active-accent | 移动 Dock 激活 | app/globals.css:208 | 2 |
| --dock-focus | 移动 Dock 焦点 | app/globals.css:209 | 1 |
| --av-signal | 音视频站点信号色 | app/globals.css:2663 | 56 |
| --av-series-1 | 音视频图表系列 1 | app/globals.css:2706 | 4 |
| --av-level-3 | 三级告警色（0 消费，死别名） | app/globals.css:2677 | 0 |
| --dash-cyan | 仪表盘信号色 | app/(dashboard)/dashboard/dashboard.module.css:10 | 19 |
| --login-signal | 登录页信号色 | app/login/login.module.css:759（浅色）/ :8（深色字面） | 12 |
| --select-accent | Select 组件强调色 | components/ui/Select.module.css:104 | 5 |
| **合计** | | | **116** |

口径：直接引用 = 文本中 var(--brand) 的出现次数；别名消费 = 9 个间接令牌被 var(--…) 引用的次数（不含令牌定义行）。--doing（#6cf3ff）是字面重复而非别名，未计入。

读法：

- 117 处里有 9 处是“别名定义”（把 --brand 转成另一个语义变量），真正直接消费 108 处；再叠加 9 个别名带来的 116 处消费，--brand 全局共有 233 个引用点。
- 同一变量同时承担：链接文字（<code>web/app/globals.css:292</code>）、焦点环（<code>web/app/globals.css:405</code>）、输入框边框（<code>web/app/globals.css:366</code>）、选中日期底（<code>web/components/ui/DatePicker.module.css:216</code>）、进度条（<code>web/components/ui/ProgressBar.module.css:4</code>）、图表系列（<code>web/app/(dashboard)/dashboard/page.tsx:301</code>）、导航激活强调（<code>web/app/globals.css:100</code> 及 17 处消费）、三级告警（<code>web/app/globals.css:2677</code>，别名 0 消费）、登录信号色（<code>web/app/login/login.module.css:759</code> 及 12 处消费）、Select 强调（<code>web/components/ui/Select.module.css:104</code> 及 5 处消费）、音视频站点信号色（<code>web/app/globals.css:2663</code> 及 56 处消费）。
- 另有两个“造出来的同义色”：<code>--doing</code> 以字面值 #6cf3ff 复制 --brand（<code>web/app/globals.css:26</code>，2 处消费），且 <code>--brand-hover</code> 在深色下不是 --brand 的明度档，而是酸橙 #c6ff72（<code>web/app/globals.css:10</code>，10 处消费），见 §5。

## 5. 主题等价性（同一令牌深浅两套的性格差）

下表的“深 / 浅”是同一令牌在两套主题里的解析值；OKLCH 与 HSL 由 contrast.mjs 计算。ΔL 单位 pp 指 OKLCH L ×100 的差（浅 − 深），Δh 为最短色相距离。

| 令牌 | 深色 | 浅色 | 深 OKLCH (L / C / h) | 浅 OKLCH (L / C / h) | ΔL | ΔC | Δh | 深 HSL (H / S / L) | 浅 HSL (H / S / L) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| brand | #6cf3ff | #17617d | 0.894 / 0.118 / 203.3° | 0.462 / 0.082 / 228.7° | -43.1pp | -0.036 | 25.4° | 185° / 100% / 71% | 196° / 69% / 29% |
| brand-hover | #c6ff72 | #124d64 | 0.933 / 0.180 / 127.9° | 0.395 / 0.069 / 229.1° | -53.8pp | -0.111 | 101.2° | 84° / 100% / 72% | 197° / 69% / 23% |
| action | #c6ff72 | #c6df7b | 0.933 / 0.180 / 127.9° | 0.863 / 0.129 / 120.7° | -6.9pp | -0.051 | 7.2° | 84° / 100% / 72% | 75° / 61% / 68% |
| done | #c6ff72 | #356b4b | 0.933 / 0.180 / 127.9° | 0.481 / 0.078 / 155.9° | -45.2pp | -0.102 | 28.0° | 84° / 100% / 72% | 144° / 34% / 31% |
| danger | #ff9a6a | #a23e39 | 0.781 / 0.137 / 45.6° | 0.501 / 0.134 / 25.9° | -28.0pp | -0.003 | 19.7° | 19° / 100% / 71% | 3° / 48% / 43% |
| warn | #ffc46b | #805518 | 0.856 / 0.126 / 76.0° | 0.486 / 0.093 / 70.9° | -37.0pp | -0.033 | 5.1° | 36° / 100% / 71% | 35° / 68% / 30% |
| data-violet | #bda6ff | #6d4cc2 | 0.779 / 0.126 / 295.2° | 0.515 / 0.176 / 291.9° | -26.3pp | 0.050 | 3.3° | 256° / 100% / 83% | 257° / 49% / 53% |
| nav-active-accent | #6cf3ff | #c6df7b | 0.894 / 0.118 / 203.3° | 0.863 / 0.129 / 120.7° | -3.0pp | 0.011 | 82.6° | 185° / 100% / 71% | 75° / 61% / 68% |

量化事实：

- 明度：8/8 浅色 OKLCH L 更低，平均 ΔL -30.4pp；其中 6 组低于 -26pp（brand -43.1、brand-hover -53.8、done -45.2、warn -37.0、danger -28.0、data-violet -26.3），action -6.9pp、nav-active-accent -3.0pp 基本同明度。深色 L 区间 0.779–0.933，浅色 0.395–0.863。
- 彩度：8/8 深色 HSL 饱和度 = 100%，浅色 34%–69%；OKLCH 彩度 6/8 浅色更低（例外 data-violet +0.050、nav-active-accent +0.011）。
- 色相：2 组翻转超过 80°——brand-hover 101.2°（深色酸橙 127.9° → 浅色深青 229.1°）、nav-active-accent 82.6°（深色 203.3° → 浅色 120.7°）。其余 brand 25.4°、done 28.0°、danger 19.7°、warn 5.1°、action 7.2°、data-violet 3.3°。
- 令牌内部不自洽：深色 <code>--brand</code> 是青（HSL 185°），<code>--brand-hover</code> 是酸橙（HSL 84°），二者在深色主题内就跨了色相家族（<code>web/app/globals.css:9-10</code>）；浅色下二者同为深青（HSL 196° / 197°，<code>web/app/globals.css:155-156</code>）。导航激活强调色同样如此：深色 = 品牌青 #6cf3ff，浅色 = 酸橙 #c6df7b（<code>web/app/globals.css:100 / :201</code>）。

## 6. 隔离视觉区结论

| 入口 | 令牌来源 | 字面量证据 | 深浅响应 | 结论 |
| --- | --- | --- | --- | --- |
| /login | 私有 --login-* 8 个（<code>web/app/login/login.module.css:2-9</code>）；浅色块把 10 个私有变量重绑到主令牌（<code>:751-763</code>） | 100 处（70 深色基准 + 30 浅色块） | 有 light 覆盖；由 <code>web/lib/loginLightMode.vitest.test.ts</code> 守 | 半复用：浅色交回主令牌，深色是主令牌的手写副本（α 不同），浅色块内又写 30 处令牌 RGB 副本，两套皮肤各维护一半 |
| /spark | 私有 --spark-* 14 个（<code>web/components/spark/SparkShell.module.css:2-15</code>）；共享 Select 的 spark 皮肤 10 处（<code>web/components/ui/Select.module.css:113-125</code>） | 456 处 / 284 种不同字面写法 | 0 个 data-theme 选择器；主题切换对站点无视觉作用 | 完全隔离：自带一整套深色单皮肤，主主题管不到 |
| /stream-monitor | 主令牌，经 <code>web/app/globals.css:2653-2733</code> 的 --av-* 别名映射（--av-canvas = --bg、--av-signal = --brand 等） | Av 层 CSS 0 处 hex/rgba；846 处 var(--av-*) 消费 | 深浅两套自动生效；viewport 按 prefers-color-scheme 给两份 themeColor（<code>web/app/stream-monitor/layout.tsx:45-53</code>） | 完全复用：三者中唯一与主主题同步的入口 |

补充证据：

- /login 除了私有青 #6cf3ff 与酸橙 #c6ff72，还通过 <code>web/app/login/page.tsx:7,109</code> 引入 StorySteps，而 <code>web/components/motion/StorySteps.module.css:34,49</code> 写死 #68AFFF（第四种强调蓝，无浅色覆盖）。
- /spark 的私有青 #22d3ee、玫瑰 #fb7185、紫 #a855f7 与主令牌 #6cf3ff、#ff9a6a、#bda6ff 并不同值；<code>web/app/spark/layout.tsx:39</code> 的 themeColor 也写死 #070a12。
- 主主题的 <code>data-theme</code> 仍会写到 html 上（<code>web/components/theme/ThemeProvider.tsx:53-60</code>），但 /spark 子树没有任何选择器读取它；<code>rg -n 'data-theme' web/components/spark web/app/spark | wc -l</code> 输出 0。
- /stream-monitor 的 Av 层文件确为 0 处颜色字面量：<code>rg -n '#[0-9a-fA-F]{3,8}\b|rgba?\(' web/components/av --glob '*.css' | wc -l</code> 输出 0；<code>var(--av-*)</code> 引用数为 AvShell 96 + AvUI 160 + AvPages 590 = 846。

## 7. 三大结构性问题

1. **主令牌之外存在三套私有色板，95.7% 的颜色字面量落在主令牌体系之外**（证据：components/spark 456 处 + app/login 100 处 = 581 处中的 95.7%，§3.1；/spark 0 个 data-theme 选择器，§6；<code>web/components/ui/Select.module.css:99-125</code> 的 console / spark 双皮肤）。
2. **--brand 一个令牌承担 9 类语义、233 个引用点，且同一“品牌色家族”在深浅主题间换色相**（证据：117 直接 + 116 别名消费，§4；深色 --brand 与 --brand-hover 的 HSL 色相差 101°、导航激活强调色深浅 OKLCH 色相差 82.6°，§5 / <code>web/app/globals.css:9-10, 100, 201</code>）。
3. **深浅两套主题不是同一性格的两档，对比度与令牌纪律也各自为政**（证据：8/8 浅色明度更低、平均 ΔL -30.4pp，8/8 深色 HSL 饱和度 100% vs 浅色 34%–69%，2 组色相翻转 >80°，§5；深色 ink-3 4.00:1、浅色 todo 4.39:1、line 1.55 / 1.21，§2.3；浅色块 30 处令牌 RGB 手写副本，§3.3）。

## 附录 A：方法与口径

- 数据来源：静态解析 <code>web/app/globals.css</code>，不依赖浏览器渲染或 computed style；未启动 dev server。
- WCAG 2.1：sRGB 通道线性化后按 L = 0.2126R + 0.7152G + 0.0722B 求相对亮度，对比度 = (L1+0.05)/(L2+0.05)。半透明颜色按 alpha 合成到承载面。
- rgba 等效 hex 的承载面：ink-2 / ink-3 / line* / *-bg / brand-soft / violet-soft / overlay / signal-glow → --bg；th-bg / row-hover / skeleton-* → --card；nav-muted / nav-border / nav-hover-bg / nav-active-bg → --nav-bg。承载面变化时等效值与对比度会变，§2 已补 ink-2、ink-3、line 在 card 上的取值。
- 令牌类型：hex / rgba / 别名（值为 var()）/ 未定义（仅另一主题定义）。浅色未覆盖的令牌继承深色 :root。
- 硬编码口径：rg 粗口径 593 处（20 文件）包含注释与 issue 编号；脚本去注释后 581 处（17 文件）。17 个文件是实际含声明的文件；另有 3 个文件仅注释 / issue 编号命中（stream-monitor/layout.tsx、av/pages/AlarmView.tsx、av/pages/AudioView.tsx）。
- --brand 口径：直接 var(--brand) 117 处；别名消费统计 9 个别名令牌被 var(--…) 引用的次数（含带 fallback 的写法），不含定义行；--doing 是字面重复，未计入别名。
- 主题等价性口径：直接取同名令牌两套解析值计算 OKLCH（Björn Ottosson 系数，D65）与 HSL；ΔL 为 OKLCH L 差 ×100，Δh 为最短色相距离。

## 附录 B：复现命令

脚本（可复现本报告全部表格）：

        node docs/design-review/colors-2026-10/contrast.mjs
        node docs/design-review/colors-2026-10/contrast.mjs --scan

直接核对：

        cd web
        rg -o 'var\(--brand\)' app components --glob '*.css' --glob '*.tsx' | wc -l      # 117
        rg -l 'var\(--brand\)' app components --glob '*.css' --glob '*.tsx' | wc -l      # 30
        rg -o --glob '*.module.css' --glob '*.tsx' '#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(' app components | wc -l   # 593
        sed -n '751,1021p' app/login/login.module.css | rg -o '#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)' | wc -l   # 30
        rg -n 'data-theme' components/spark app/spark | wc -l                            # 0
        rg -n '#[0-9a-fA-F]{3,8}\b|rgba?\(' components/av --glob '*.css' | wc -l        # 0
        rg -o 'var\(--av-' components/av/AvShell.module.css components/av/AvUI.module.css components/av/pages/AvPages.module.css | wc -l   # 846

## 附录 C：限制

- 只做源码静态审计，未在浏览器里取 computed color / 截图；渐变、混合模式、backdrop-filter、图片或 canvas 上的实际呈现不在测量范围。
- 对比度按纯色前景与纯色背景计算；半透明叠加的承载面若与假设不同（如彩色卡片、遮罩、图片），数值会变化。
- 未评估字号 / 字重 / 字距对可读性的影响，也未评估色盲（CVD）区分度。
- HEAD 0d8088b 之外若有人改动样式，本报告数字需要重跑脚本更新。
