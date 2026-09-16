# UI 全局 Layout 与主题设计 PLAN（商务效率风 Jira/Teambition 向）

> **For agentic workers:** 按 frontend-design skill 执行，目标是高密度、好扫读、快操作的商务效率界面，不是营销风。先 tokens 再壳最后组件，不动后端。

**Goal:** 把 MVP 从通用灰底蓝钮升级为 Jira/Teambition 式效率控制台：导航快、表格密、状态一眼清、 инер操作短。

**Architecture:** 纯前端重构。`globals.css` 为 tokens 真相源，`app/layout.tsx` 管字体，`(dashboard)/layout.tsx` 为 App Shell（顶栏+侧栏+内容），`components/ui/*` 沉淀 Badge/Button/Card/Table/Avatar/ProgressBar。业务页只换 class，不改 fetch。

**Tech Stack:** Next.js 14 App Router + CSS 变量 + next/font，零 UI 框架依赖

## Global Constraints

- 禁止紫渐变、营销大留白、单屏只放一个卡；内容密度优先
- 中文商务排版：表格 13-14px、行高 40px、数字金额等宽右对齐
- 浅色全站（本期不做 dark mode）；颜色全走变量，业务页禁内联色
- 动效只 120ms ease-out + prefers-reduced-motion 关闭

---

## 设计方向（定稿）

**“效率商务 / Ops Console”** 参考 Jira + Teambition：
- 底 `#F3F4F7`，卡白 `#FFF` + 1px `#E3E6EB` 边 + 6px radius，无模糊大阴影
- 侧栏白 240px：顶部工作区名 + 新建项目主按钮（深蓝整宽），NAV 四项配线性图标，active 浅蓝底 `#EAF0FF` + 深蓝字 + 左 3px 蓝线；支持收起剩 64px 图标栏
- 顶栏白 48px：全局搜索（⌘K 占位）、右端日期 + 用户头像 + 登出
- 主色行动蓝 `#2B5CFF`（只用于主按钮/active/链接），状态色：待办灰 `#64748B`、进行中蓝、预警琥珀 `#B45309`、逾期朱红 `#DC2626`、完成翠绿 `#15803D`
- 字体：正文 `Inter` 禁用，改 `Noto Sans SC + system-ui`（400/500/600 三档），标题 15px semibold 不追求衬线，编号/金额/日期 `JetBrains Mono / IBM Plex Mono`
- 记忆点不在装饰，在效率：列表行 hover 出快捷操作、状态徽标 + 进度条同行、看板列头计数

## Tokens

```css
:root{
  --bg:#F3F4F7; --card:#fff; --ink:#172B4D; --ink-2:#5E6C84; --ink-3:#8993A4;
  --line:#E3E6EB; --brand:#2B5CFF; --brand-soft:#EAF0FF;
  --todo:#64748B; --warn:#B45309; --warn-bg:#FEF3C7; --danger:#DC2626; --danger-bg:#FEE2E2;
  --done:#15803D; --done-bg:#DCFCE7;
  --radius:6px; --row-h:40px;
  --font-body:"Noto Sans SC","PingFang SC","Microsoft YaHei",system-ui,sans-serif;
  --font-mono:"JetBrains Mono","IBM Plex Mono",Menlo,monospace;
}
```

## Stage U1：地基

文件：`globals.css` 重写 + `layout.tsx` 字体。
- [ ] 三字重正文 + mono，body 背 var(--bg)；input 32px 高 + focus 蓝 ring；table.grid 行高 var(--row-h)、th 12px 灰大写
- [ ] 验收：build 过，旧 `#1677ff/#001529` 残留 grep 为 0

## Stage U2：App Shell

文件：`(dashboard)/layout.tsx` + `components/ui/Shell.module.css`。
- [ ] 侧栏 240px 白：工作区头 + 新建按钮 + NAV（台账/进度/成本/报表，线性 SVG 图标）+ 底部用户行；可收起 64px
- [ ] 顶栏 48px：面包屑 + 搜索框 + 新建快捷 + 头像登出；内容 `max-width:1280px`，页头左标题右主按钮
- [ ] <900px 侧栏变顶栏横滚导航
- [ ] 验收：四导航 active 正确，收起/展开正常

## Stage U3：效率组件

新建 `components/ui/`：`Badge/ProgressBar/Avatar/TableToolbar/Empty`。
- [ ] Badge 五态（草稿/进行/暂停/逾期/完成）+ mono；ProgressBar 列表内联 4px；TableToolbar（筛选项+密度+导出占位）
- [ ] 业务页换装不改逻辑：projects 列表行 hover 快捷（查看/跟进）、progress 看板列计数、costs 执行率条三色
- [ ] 验收：业务页无内联颜色 style，金额右对齐 mono

## Stage U4：登录页（商务干净）

文件：`login/page.tsx + login.module.css`。
- [ ] 中居 360px 白卡 + 顶部品牌条（深蓝 3px 顶线），错误琥珀/红底提示；支持回车登录
- [ ] 验收：/login 200，空值/错密样式统一，成功跳 /projects

## Stage U5：质检

- [ ] 120ms 统一过渡；空数据 Empty 插画用 CSS 几何不引入图；长标题省略；打印报表黑白可读
- [ ] Chrome/Edge 走查 + 1280/900px 截图对

## 不做

- dark mode、主题切换、动画库、甘特拖拽、后端改动
