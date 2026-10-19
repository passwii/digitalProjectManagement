# 智能音视频平台（`/av`）骨架实施记录

> Stage 2 的实现记录与决策说明。任务原文见 BLF-1374；数据层见 BLF-1373（Stage 1）。

**Goal:** 在现有 Next.js 项目里新增一个独立于 NebulaCloud 演示站的「智能音视频平台」演示入口（左侧 Spark 分组第二条），复刻参考骨架页面的信息结构，视觉基线按 `DESIGN.md` 的双主题令牌重新校准。

**Architecture:** `/av` 在 middleware 中作为公共路由（与 `/spark` 同级），拥有独立 App Router layout 与 `AvShell`。6 个导航页由 `app/av/[section]/page.tsx` 统一分发，2 个辅助页（`/av/audio`、`/av/__stress`）是独立静态段；两个深链接（`/av/alarm/:id`、`/av/event/:id`）走 `[section]/[id]`。数据由 Server Component 直接读 `web/public/mock/av/*.json`（复用 Stage 1 的 `load.ts`，注入读文件的 `Fetcher`），只把页面用到的聚合序列化给客户端。

**Tech Stack:** Next.js 14 App Router、React 18、TypeScript、CSS Modules、Recharts 3（已安装）。无新增依赖。

## 全局约束（与 BLF-1374 对齐）

- `/av` 免登录；`/spark` 的鉴权与重定向行为一字未动。
- 不修改 `web/public/mock/av/` 下任何数据文件；需要补数据回 BLF-1373。
- 颜色只来自 CSS 变量（`--av-*` 别名层 → 主工作台语义令牌），组件里没有颜色字面量。
- 告警四级同时有色块 + 文字（色弱可辨）；级别色单独定义，不复用 sample 的三档。
- 图表统一走 Recharts；频谱是二维矩阵（bins × cols），用 canvas 渲染，不作为「图表」替代品。
- 首屏预算：`/av/overview` 只带聚合（实测 RSC payload ≈ 19KB / HTML ≈ 77KB），核心数据文件总量 911KB ≤ 1MB。
- 本 Stage 不做动效，但所有后续要动的元素都带稳定 `data-motion-key` / `data-motion-index`，列表 key 用业务 id。

## 文件职责

| 文件 | 职责 |
| --- | --- |
| `web/lib/av/navigation.ts` | `AV_PAGES`（6 页）、窗口 target、隐藏路由、深链接构造 |
| `web/lib/av/labels.ts` | 业务编码 → 中文文案 / 语义 tone；数字与时间格式化 |
| `web/lib/av/view.ts` | 纯聚合（KPI 卡、趋势、分级、场景、通道、波形、排行） |
| `web/lib/av/contracts.ts` | 页面 props 契约（服务端投影与客户端视图共用） |
| `web/lib/av/server.ts` | 服务端数据入口（fs fetcher、告警 id 索引、频谱、极端值、空态素材） |
| `web/lib/av/pageData.ts` | 每页的 props 投影（只投页面用到的字段） |
| `web/app/av/layout.tsx` | AV 根布局 + metadata，套 `AvShell` |
| `web/app/av/[section]/page.tsx` | 6 个导航页的 Server Component 分发（`generateStaticParams`） |
| `web/app/av/[section]/[id]/page.tsx` | `/av/alarm/:id`、`/av/event/:id` 深链接（刷新可直接定位） |
| `web/app/av/audio/page.tsx` | 音频分析（频谱 + 转写，`?alarm=` 选择样本） |
| `web/app/av/%5F%5Fstress/page.tsx` | `/av/__stress` 布局压力测试（目录名用 `%5F` 绕开 Next 的私有目录规则） |
| `web/components/av/AvShell.tsx` | 三段式壳：可折叠侧栏 + 顶栏（搜索 / 在线率 / 时钟 / 主题 / 返回主系统）+ 内容区 |
| `web/components/av/AvGate.tsx` | `/av?gate=1` 可选门禁：6 格口令自动跳格、退格回退、满 6 位解锁 |
| `web/components/av/AvUI.tsx` | 页面头、面板、度量卡、级别徽标、状态徽标、Tab、进度条、空态、KV |
| `web/components/av/AvCharts.tsx` | Recharts 封装（趋势 / 柱状 / 环形 / 信号），主题切换时从令牌重读颜色 |
| `web/components/av/pages/*` | 6 个导航页 + 音频页 + 压力测试页的视图 |

## 关键决策

1. **首屏不拉全量告警**：列表首屏 50 条由服务端从分片直接切；「加载更多」在浏览器用 `loadAlarmPage(index, cursor)` 按游标取下一个分片。筛选只作用于已加载页，工具条明确写「已加载 N / 共 M」。
2. **id 深链接需要全量索引**：告警 id 与时间顺序无关（`AL-00037` 在最新分片），无法二分。首次访问 `/av/{alarm|event}/:id` 或 `/av/__stress` 时扫一遍 9 个分片建 `id → alarm` 索引，进程内缓存。
3. **`scenes[].name` 是站点名**（示范第一中学 / 市人民医院 / 市执法办案管理中心）。「场景分布」用场景名做主标签、站点名做副标签，避免读成三个站点。
4. **波形是展示变换**：设备 `signal_series` 是逐点抖动，先按自身 min/max 归一、再做 3 点滑动平均；离线设备的 0 哨兵统一压到最低一根。数据本身未改。
5. **门禁不是路由**：middleware 的 `/av → /av/overview` 保留查询串，`/av?gate=1` 落到总览后由壳层盖一层 `role="dialog"` 的验证面板；直接访问 `/av/overview` 不出现。
6. **`/dashboard` 链接 `prefetch={false}`**：受保护路由预取会拿到 `/login` 的 RSC 响应并在控制台留下 CORS 噪音；AV 是免登录演示站，不需要预取。

## 测试与验证

- `npm run build`：通过（`/av/[section]` 为 SSG 6 条路径；`/av/__stress`、`/av/audio`、深链接为按需渲染）。
- `npm run test:unit`：339 pass（新增 `lib/av/navigation.test.ts`、`view.test.ts`、`server.test.ts`）。
- `npm run test:motion`：373 pass（新增 `avSourceGuard`、`avTheme.dom`）。
- 8 个页面 + 2 个深链接：headless Chrome 逐页检查 console，0 error / 0 warning。
- 移动端 390px：总览 / 告警 / 事件三页无横向溢出；事件表在窄屏换成卡片流。
- 深浅主题：`avTheme.dom` 断言两级主题下颜色都只以 `var(--av-*)` 形式出现；token 层全部映射到既有语义 token，不会出现「切浅色后某块没跟着变」。

## review 修复（Tia，PR #157 第一轮）

| # | 缺陷 | 修复 |
| --- | --- | --- |
| 1 | P1 匿名翻页 100% 失败 | `PUBLIC_PATHS` 增 `/mock/av`（只放行 AV 自己的数据目录）。告警「加载下一页」在浏览器直接 fetch 分片，之前被 307 到 `/login` 拿到 HTML |
| 2 | P1 浅色主题频谱整块亮青 | 新增 `lib/av/color.ts`：`parseCssColor` 支持 `#rgb/#rgba/#rrggbb/#rrggbbaa/rgb()/rgba()`，解析失败返回 `null` **不回落到任何主题的具体色值**；`spectrumPixels` 抽成纯函数 |
| 3 | P2 无频谱告警静默显示别人的频谱 | `getAudioData` 只在 `alarmId == null` 时兜底；显式传 id 查不到就返回 `null`，页面渲染专属空态（文案带上传入的 id） |
| 建议 | 源码守卫有盲区 | 扫描新增 `[r, g, b]` 三通道数组与 `parseInt(..., 16)`，并先剥注释再扫（注释里解释色值不该触发守卫） |
| 建议 | 顶部搜索是装饰 | 改成真 `form[role=search]`：回车跳 `/av/alarm?q=`，`AlarmView` 用 `useSearchParams` 读（同路由二次搜索也生效） |
| 建议 | 三级与数据紫底色串色 | 新增 `--violet-soft`（深浅各一条），`--av-tone-violet-soft` 不再复用 `--doing-bg` |

**回归**（登出状态 + headless Chrome 实测）：

- 匿名 `/av/alarm` 点「加载下一页」：50 → **100 条**，页脚「共加载 100 / 14,366」，无报错。
- `/av/audio?alarm=AL-11429`（无频谱）→ 空态「AL-11429 没有可分析的音频」；`?alarm=NOPE` 同样空态并显示该 id；`?alarm=AL-14398` 仍正确。
- 浅色主题频谱左上角像素 `[244,248,249]`（浅底）而非 `[103,234,247]`（整块亮青）；深色 `[17,39,54]`。
- 顶部搜索：`AL-00039` → 1 条且 URL 为 `/av/alarm?q=AL-00039`；同路由改搜 `AL-00040` 也生效；深链接 `?q=AL-00046` 直接生效。

## review 第二轮（Tia，PR #157 head 6183667）

| # | 缺陷 | 修复 |
| --- | --- | --- |
| 1 | P1 本轮自己引入：整棵 `AlarmView` 被包进 Suspense，`/av/alarm` 退化成纯客户端渲染 | 把读 `?q=` 拆成极小客户端组件 `QuerySync`（只在它外面加 Suspense）；页面恢复直接渲染 `AlarmView`。服务端产物回到 **129KB HTML / 关 JS 4,515 字 / 50 个 AL- 编号** |
| 2 | P2 清空搜索后筛选不复位 | `QuerySync` **无条件**写回（空串也覆盖）；壳层加 `KeywordSync` 同步 `?q=`，点导航/清空提交都会复位 |
| 建议 | `stripComments` 把字符串里的 `//` 当注释 | 改为词法状态机 `maskComments`（代码态才进注释态，字符串/模板字符串原样保留），并加假阴性用例 |
| 建议 | 守卫只扫 `app/av` + `components/av` | 新增 `lib/av` 扫描（`color.ts` 除外，它是取色的唯一入口） |

**回归**：`test:unit` 347 → **349**；`test:motion` 384 → **390**（新增 `avSsrGuard` 4 例把「页面不得包 Suspense」钉死）。慢网（4x CPU）首屏出现内容：4G 622ms / 3G 2,439ms，rows=50。

## review 第三轮（Tia，PR #157 head d269ed3）

| 缺陷 | 修复 |
| --- | --- |
| P2（AC5 直接失败）页内点切换后图表 / 频谱仍停在上一个主题 | `ThemeProvider` 的 context 新增 `appliedTheme`（**只在 `applyTheme()` 之后才变**）；`useAvPalette` 与 `Spectrogram` 的依赖从 `resolvedTheme` 换成 `appliedTheme`。根因是 React effect 子先父后：子组件在 `[resolvedTheme]` 的 effect 里读令牌时，Provider 还没写 `data-theme` |

实测（headless Chrome 155，`next start`，点顶栏切换按钮，不刷新）：

```text
/av/audio?alarm=AL-14398  深 → 浅 : canvas 左上 17,39,54 → 244,248,249   ✓
                          浅 → 深 : 244,248,249 → 17,39,54              ✓
/av/overview              深 → 浅 : stroke #6cf3ff → #17617d             ✓
/av/alarm                 浅 → 深 : pie fill #a23e39 → #ff9a6a           ✓
```

新增回归（`avTheme.dom.vitest.test.tsx` 的两条「真实交互路径」用例）：挂真 `ThemeProvider`，
用 `setMode` 点切换，断言重绘像素 / 调色板等于新主题且不等于旧主题，并断言读令牌发生在
`data-theme` 落盘之后。**变异验证**：把两处依赖改回 `resolvedTheme`，两条用例都红。

## 不在本 Stage 范围

- 动效与 transition（BLF-1375 / Stage 3）
- 真实后端接口
- 修改 `/spark` 与 `web/public/mock/av/` 数据文件
