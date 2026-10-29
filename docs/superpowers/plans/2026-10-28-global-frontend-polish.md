# 全局前端视觉与动效打磨实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在保留既有品牌、业务结构和行为的前提下，改善工作台暗色正文与共享 UI 层次，并为工作台及登录页建立统一、有存在感且尊重减少动态偏好的动效反馈。

**Architecture:** 先完善 `web/app/globals.css` 中的主题语义色与共享组件基线，再把 `web/lib/av/motion.ts` 现有令牌/静态模式契约扩展到实际工作台运行路径，最后按工作台代表页与登录页接入并验收。主题仍由根级 `ThemeProvider` 应用；工作台 motion runtime 保持路由组边界，登录页使用独立布局和视觉，但可复用已验证的令牌与轻量反馈。

**Tech Stack:** Next.js 14 App Router、React 18、TypeScript、CSS Modules、Framer Motion、Vitest/jsdom、node:test、项目现有 Chrome CDP 验收脚本。

## Global Constraints

- “以全局设计 token、共享样式和通用动效组件为主，业务页面沿用当前结构与交互。”
- “不改后端接口、数据模型、权限逻辑、审计行为或业务文案。”
- “登录、Spark 和 stream-monitor 是独立视觉区域；本次只纳入登录页，不把工作台主题强行覆盖到演示站。”
- “颜色、动效时长、缓动遵循仓库现有设计令牌和源码守卫。”
- `prefers-reduced-motion` 与 `?static=1` 下移除非必要运动并直接呈现稳定终态，保留状态变化本身。
- 按 `TESTING.md`：DOM/Vitest 测试放 `web/lib/` 且首行使用 `// @vitest-environment jsdom`；`npm test` 是本地前端测试门槛；浏览器验收按需手动执行。

---

## 文件结构与职责

- `web/app/globals.css`：工作台深浅主题语义 token、全局正文/表格/表单/按钮/减少动态样式，以及已有 AV 令牌的共享声明。保留现有流媒体演示专属区段，不把工作台选择器扩散到该站。
- `web/components/ui/Shell.module.css`：Dashboard shell 的主内容画布、顶栏/导航和共享正文容器主题层级。
- `web/lib/lightThemeTokens.vitest.test.ts`：增补深浅主题中工作台正文、表面和关键状态的色彩契约与对比度断言。
- `web/lib/themeProvider.dom.vitest.test.tsx`、`web/lib/themeTransition.test.ts`：保护主题应用、首屏和切换行为；若 token 调整影响既有断言，在同一任务中更新语义明确的测试。
- `web/lib/av/motion.ts`：沿用 `AV_MOTION`、`AV_EASE`、`AV_STAGGER`、`parseStaticMode`、`isMotionEnabled` 等既有纯逻辑真源；仅在确认其适用于工作台、且不破坏演示站语义时扩展。
- `web/components/motion/MotionProvider.tsx`、`MotionReveal.tsx`、`MotionStagger.tsx`、`MotionTabs.tsx`、`CountUp.tsx`：共享运行时开关和页面/列表/数据动效。若需共享 hook，新增 `web/components/motion/useMotionState.ts`（只封装浏览器主题：reduced-motion + static URL，不复制动画常量）。
- `web/app/(dashboard)/layout.tsx`：只在确有必要时调整页面级路由切换编排；既有导航活动提示和移动导航结构保持。
- `web/app/(dashboard)/dashboard/page.tsx` 与 `web/components/dashboard/DashboardReadout.tsx`：首页共享视觉与数据反馈样板；尽可能通过现有 primitives 实现，不在页面另造 CSS/token。
- `web/app/(dashboard)/projects/page.tsx`、`web/app/(dashboard)/projects/ProjectsListContent.tsx`、`web/app/(dashboard)/projects/ProjectFormDialog.tsx`：项目列表、过滤/表格/移动卡片与表单/弹层样板；若这一路线不能覆盖真实高频交互，可用 `approvals/page.tsx` 作为列表反馈样板，但避免两者同时做无关局部改版。
- `web/app/login/page.tsx`、`web/app/login/login.module.css`：登录表单视觉与表单状态反馈；保持独立登录构图和认证行为。
- 测试按行为扩展 `web/lib/dashboardPage.dom.vitest.test.tsx`、`web/lib/projectsListKeyboard.dom.vitest.test.tsx`、`web/lib/loginPage.dom.vitest.test.tsx`、`web/lib/loginLightMode.vitest.test.ts`；静态/减少动态契约可新增 `web/lib/workbenchMotion.vitest.test.ts` 与 `web/lib/workbenchMotion.dom.vitest.test.tsx`。源码守卫优先复用，不放宽既有 AV 守卫。

## 实施任务

### Task 1：建立工作台主题与正文层级契约

**Files:**
- Modify: `web/lib/lightThemeTokens.vitest.test.ts`
- Modify: `web/app/globals.css`

- [ ] 扩展测试，断言深浅主题均定义正文三档、画布/表面/抬升面、分隔线、交互/状态色；保护 DESIGN.md 明确的正文对比、焦点可见和非文本交互辨识要求。颜色解析测试需能解析现有 rgba token 与引用其他 token 的 `var()`；只有在颜色解析准确时才计算 WCAG 对比，不把弱层级文字错误地一概提高到正文阈值。
- [ ] 先运行定向 Vitest，确认新契约因真实缺口失败。仅当测试或实际样式追踪证明现有映射有问题时再改 token；未证明缺口时保留现有色值，只补牢靠的语义契约。
- [ ] 任何 CSS 修改必须由已失败测试驱动；调整根级暗色映射和必要浅色对应映射，统一 `body`、`.content`、`.grid`、`.field`、共享按钮/控件消费语义职责；保持品牌主色/行动色职责以及登录现有专属 palette。
- [ ] 运行 `npx vitest run lib/lightThemeTokens.vitest.test.ts lib/loginLightMode.vitest.test.ts lib/themeProvider.dom.vitest.test.tsx`，全部通过且新断言确实被执行。
- [ ] 提交本任务，建议中文 Conventional Commit：`fix(web): 校准工作台深色正文层级`。

### Task 2：统一共享容器与列表/浮层暗色消费

**Files:**
- Modify: `web/components/ui/Shell.module.css`
- Modify: `web/app/globals.css`
- Tests: `web/lib/lightThemeTokens.vitest.test.ts`、`web/lib/listPageLayout.dom.vitest.test.tsx`、相关 modal/table DOM tests

- [ ] 先为共享容器视觉契约补测试：shell 主内容、列表表头/行/hover、表单正常/禁用/错误、Modal/Select/DatePicker 等 portal 浮层使用语义 token，主题切换时仍可读。测试验证 token 消费与必需元素存在，不锁定无意义的完整 CSS 字符串快照。
- [ ] 定向运行受影响测试并确认预期失败或确认已有行为被回归保护。
- [ ] 更新共享 shell、全局表格/字段/按钮样式；跨模块组件只修正确属公共基础样式的规则，不逐页改业务布局。检查 portal 是否消费 root token，避免重复写浅/深色特例。
- [ ] 运行定向测试：`npx vitest run lib/lightThemeTokens.vitest.test.ts lib/listPageLayout.dom.vitest.test.tsx lib/modalFocus.dom.vitest.test.ts lib/datePickerInDialog.dom.vitest.test.tsx lib/selectA11y.dom.vitest.test.tsx`。
- [ ] 提交：`fix(web): 统一共享正文与控件主题层级`。

### Task 3：让工作台动效运行时遵守统一静态/减少动态契约

**Files:**
- Modify: `web/lib/av/motion.ts`（仅在复用契约可行时）
- Modify: `web/components/motion/MotionProvider.tsx`
- Modify: `web/components/motion/MotionReveal.tsx`
- Modify: `web/components/motion/MotionStagger.tsx`
- Modify: `web/components/motion/MotionTabs.tsx`
- Modify: `web/components/motion/CountUp.tsx`
- Modify: `web/app/(dashboard)/layout.tsx`（必要时）
- Test: `web/lib/workbenchMotion.vitest.test.ts`、`web/lib/workbenchMotion.dom.vitest.test.tsx` 或扩展现有 motion DOM tests

**接口约定：** 共享 motion state 只暴露 `enabled: boolean` 或现有 `AvMotionState` 的窄化适配；static query 由纯函数 `parseStaticMode(search: string): boolean` 解析，动画终态仍由各 primitive 自己定义。不得新增第二套 duration/ease 数值真源。

- [ ] 为静态 URL 与 reduced-motion 两条路径编写测试：首次渲染不从透明/位移首态开始；static URL 下 React/Framer Motion 组件不播放入场或计数动画；reduced-motion 下内容直接显示；普通模式仍有预期动画状态。
- [ ] 运行新测试确认对应路径缺失时失败；同时读取 `?static=1` bootstrap 在 `/stream-monitor` 的作用域，确保扩展逻辑不会改变其现有行为。
- [ ] 实现可复用 hook/runtime 状态。初始化必须避免静态 URL 首帧先播放再冻结；遵从 SSR hydration 一致性，清理 `matchMedia` listener；只让业务工作台及登录消费相应行为，不把演示站改成工作台动效。
- [ ] 调整 Reveal/Stagger/Tabs/CountUp：非动画模式直接呈现完整终态；长列表不制造长时间逐行等待；筛选结果变化反馈在状态已提交后发生，不阻塞键盘/鼠标操作。
- [ ] 运行 `npx vitest run lib/workbenchMotion.vitest.test.ts lib/workbenchMotion.dom.vitest.test.tsx lib/motionTabs.dom.vitest.test.tsx lib/av/motion.vitest.test.ts lib/avMotion.dom.vitest.test.tsx`。
- [ ] 提交：`feat(web): 统一工作台动效静态与无障碍状态`。

### Task 4：工作台代表页面接入并保护行为

**Files:**
- Modify only if necessary: `web/app/(dashboard)/layout.tsx`、`web/app/(dashboard)/dashboard/page.tsx`、`web/components/dashboard/DashboardReadout.tsx`、`web/app/(dashboard)/projects/page.tsx`、`web/app/(dashboard)/projects/ProjectsListContent.tsx`、`web/app/(dashboard)/projects/ProjectFormDialog.tsx`
- Test: `web/lib/dashboardPage.dom.vitest.test.tsx`、`web/lib/dashboardReadout.dom.vitest.test.tsx`、`web/lib/projectsListKeyboard.dom.vitest.test.tsx`、`web/lib/projectsDeleteFlow.dom.vitest.test.tsx`

- [ ] 写/扩展 DOM 测试验证 dashboard 页面标题、KPI、主要正文在首次动画期间始终有可访问终态；项目页筛选、分页、键盘选行、表单提交和删除确认行为不变，静态/减少动态模式不隐藏列表内容。
- [ ] 运行定向 DOM 测试确认需要的保护先就位。
- [ ] 用已统一的 primitives 为首页数据层次与项目列表/过滤/表格反馈接入动画；只使用 `transform`、`opacity` 与 token 支持的颜色/边界过渡，动画量受现有 stagger 上限约束。不得添加影响行高、焦点、滚动位置或筛选响应的动画。
- [ ] 运行 `npx vitest run lib/dashboardPage.dom.vitest.test.tsx lib/dashboardReadout.dom.vitest.test.tsx lib/projectsListKeyboard.dom.vitest.test.tsx lib/projectsDeleteFlow.dom.vitest.test.tsx lib/listPageLayout.dom.vitest.test.tsx`。
- [ ] 提交：`feat(web): 为首页和项目列表接入共享反馈动效`。

### Task 5：登录页独立精修

**Files:**
- Modify: `web/app/login/page.tsx`
- Modify: `web/app/login/login.module.css`
- Test: `web/lib/loginPage.dom.vitest.test.tsx`
- Test: `web/lib/loginLightMode.vitest.test.ts`

- [ ] 增补/明确测试：空值和手机号校验、请求中、认证失败/请求错误、成功跳转，以及密码显示切换保持既有语义；检查暗/亮主题颜色映射、移动安全区与 reduced/static 下表单内容终态。
- [ ] 运行 `npx vitest run lib/loginPage.dom.vitest.test.tsx lib/loginLightMode.vitest.test.ts`，确认测试可靠捕捉页面流程。
- [ ] 在不改变接口、错误文案、会话保存或跳转条件的前提下，整理 login palette 与全局色彩职责的关系；改善表单焦点、加载与结果反馈，并在 reduced/static 下关闭装饰/入场运动。登录独有持续装饰须有明确的边界和静止降级。
- [ ] 运行 `npx vitest run lib/loginPage.dom.vitest.test.tsx lib/loginLightMode.vitest.test.ts lib/themeProvider.dom.vitest.test.tsx`。
- [ ] 提交：`fix(web): 打磨登录页主题与状态反馈`。

### Task 6：跨页面视觉验收与整体验证

**Files:**
- 修改：仅对前述实现发现的必要问题；不新增独立视觉方案。
- 参考：`scripts/acceptance_tablet_landscape.py`、`scripts/test_tablet_layout_browser.py`（确认其只读及适用范围后再用）；新增/复用工作台浏览器验收脚本仅在现有脚本无法覆盖时规划实现。

- [ ] 启动应用并分别验收 dashboard、projects、login：深色/浅色主题、桌面/390px 手机；检查表面层级、正文/弱文字、表格/表单/浮层对比、首屏和高频操作反馈、移动布局。
- [ ] 对代表路由分别检查普通模式、`?static=1`、系统 reduced-motion。断言冻结后无残留入场动画且不透明/位移/图表都在最终态，页面不缺内容。
- [ ] 如果一轮截图显示实体问题，合并修复后再做一次确认；截图不是把“动画时长为零”当成视觉成功的唯一证据。
- [ ] 按仓库要求运行 `cd web && npm test` 和 `npm run build`；若在 `web/` 工作目录运行则直接 `npm test`、`npm run build`。确认 Vitest 输出包含新增文件；记录命令与真实通过数，失败/跳过如实报告。
- [ ] 检查 `git diff --check` 和变更范围，确认无 `console.log`/`debugger`/临时 TODO、无非 token 颜色/时长/缓动字面量，未更改业务文案与独立演示站。
- [ ] 汇总浏览器检查路由/主题/视口/动效模式及结果；测试是本地证据，CI 门禁仍以当前 HEAD 上 `web · 测试` 成功为准。

## 计划自检

- 设计覆盖：暗色正文和表面层级由 Task 1–2 覆盖；共享动效、筛选/数据/导航反馈及静态/reduced 终态由 Task 3–4 覆盖；登录独立精修由 Task 5 覆盖；代表页深浅主题、桌面移动与最终验证由 Task 6 覆盖。
- 范围边界：保留业务结构、认证与权限语义、登录独立身份；不包含 Spark、stream-monitor 的视觉重设计或后端改动。
- 测试结构：组件 DOM 测试置于 `web/lib/` 并显式 jsdom；不放宽既有源码守卫，不以源码字符串断言替代用户可见行为。
- 顺序一致性：主题 token → 消费共享样式 → motion state → 代表页 → 登录页 → 浏览器与套件验证。后续任务消费的 motion state 明确为 `enabled` 或兼容 `AvMotionState`，不并行发展两套 token。
