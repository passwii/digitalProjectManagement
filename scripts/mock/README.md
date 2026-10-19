# Mock 数据层（智能音视频平台）

Stage 1 的交付物：一套**能支撑像素级设计**的演示数据 + 生成器 + 两套校验脚本。
数据已经落位到 Next 静态目录，前端直接 `fetch("/mock/av/...")` 即可，不需要起任何服务。

```text
web/public/mock/av/        数据集（静态 JSON，Next 自动映射到 /mock/av）
web/lib/av/                类型 / 时间换算 / 加载器 / 游标分页（TS，进构建）
scripts/mock/              生成器 + 校验 + 契约审计（零依赖，Node 内置模块）
```

## 一、三条命令

```bash
# 重新生成（固定种子，产出逐字节一致）
node scripts/mock/generate.mjs

# 一致性校验：158 项（聚合对聚合 + 聚合对明细 + 语义对语义）
node scripts/mock/validate.mjs

# 前端可消费性审计：P0 必须为 0，否则退出码 1
node scripts/mock/audit-frontend-contract.mjs
```

也可以在 `web/` 下用 npm 别名（会切到 `web/` 的 cwd，但脚本用绝对路径定位仓库根）：

```bash
npm run mock:generate
npm run mock:validate
npm run mock:audit
```

> 生成器零依赖，**不需要 `npm install`**。校验脚本同样只用了 Node 内置模块。

## 二、数据规模

| 维度 | 数值 |
|---|---|
| 站点 / 场景 | 3（校园 / 医院 / 公安） |
| 点位 | 268（校园 158 / 医院 66 / 公安 44） |
| 设备 | 268（含音频、视频、网关；每台带固件、自检历史、OTA、24 点信号序列） |
| 告警 | 14,366 条 / 180 天（日均 80），切成 9 个分片，单片 ≤ 1.2MB |
| 事件 | 207 个（含 7 个剧本事件，时间线 3–12 节点） |
| 剧本 | 8 个（A 校园欺凌闭环 / B 噪声误报 / C 设备离线 / D 医院一键报警 / E 夜间分贝 / F 谈话质量 / G 批量离线 / H 误报降级生效） |
| 频谱 | 12 段（欺凌 / 争吵 / 哭喊 / 玻璃破碎 / 设备噪声），每段 2,000 桶 min/max 波形 |
| 转写 | 5 段（校园欺凌 / 医院冲突 / 公安审讯 / 广播喊话 / 对讲记录） |
| 操作日志 | 300 条（覆盖导出 / 删除 / 权限变更） |

## 三、时间模型（最关键的约定）

数据里**没有绝对时间**，只有「距锚点多少分钟」：

- 字段统一 `*_offset_minutes`，**越小越新**
- 绝对时间 = `anchor - offset`
- 锚点固定 `2026-10-19T12:00:00+08:00`（见 `index.json` / `kpi._meta.generated_at`）
- 「钟点 / 自然日」一律按 **UTC+8** 显式计算（`web/lib/av/time.ts`），不依赖机器时区

这样做的原因：如果把日期写死在 2026-07-01，演示当天首页最新告警就是「90 天前」，
趋势图的「今日」永远是空的。存相对偏移 + 可切换锚点，既保证截图可复现，又不会放旧。

前端可以直接用锚点（截图固定），也可以传 `live: true` 换成「现在」（演示更自然）：

```ts
import { toRelative, toAbsolute, resolveBase } from "@/lib/av/time";

toRelative(alarm.ts_offset_minutes);                    // 3 分钟前
toAbsolute(alarm.ts_offset_minutes);                    // 2026-10-19 10:23
toAbsolute(alarm.ts_offset_minutes, resolveBase(true)); // 以「现在」为锚点
```

## 四、怎么接（前端）

```ts
import { loadCore, loadAlarmPage } from "@/lib/av/load";

// 首屏：索引 + 站点 / 点位 / 设备 / KPI / 趋势 / 事件 / 转写（不含告警明细与频谱）
const core = await loadCore();
const page = await loadAlarmPage(core.alarmsIndex);        // 一页 50 条
const next = await loadAlarmPage(core.alarmsIndex, page.next_cursor);

// 频谱按需加载（640KB，只有音频分析页需要）
const spectra = await loadDataset(); // 或者 loadSpectrum("sp-001")
```

- **首屏只加载 `alarms-index.json`**（3KB）：分片清单 + 游标分页契约 + 各片 tier 统计。
- `loadCore()` 实测约 **890KB**（`devices.json` 506KB / `incidents.json` 187KB / `points.json` 69KB /
  `audit-logs.json` 77KB），首屏预算按这个数做懒加载；概览页可以只取 `kpi` + `trends` + `sites`。
- 事件 `timeline` 既按时间「旧 → 新」，也按**生命周期**推进
  （触发 → 融合 → 动作 → 通知 → 接警 → 派发 → 到场 → 处置 → 复核 → 归档）；
  `closed` 事件以 `archive` 收尾，`dispatched` 事件不含 `archive`、其告警也不置 `closed`。
- 设备 `signal` 是 0–100 的质量分，`signal_series[].rssi_dbm` 是负 dBm；
  两者都用 `0` 作离线哨兵，画图前先按 `status === "offline"` 特判。
- 列表用 `loadAlarmPage`，不要 `loadAllAlarms`（后者 ≈ 10.1MB，只适合离线分析）。
- 排序方向全站统一「新 → 旧」：`alarms` / `incidents` / `audit-logs` / `trends.hourly` / `trends.daily`
  的数组都按偏移升序，`heatmap` 按 `(day asc, hour asc)` 排列。
- `heatmap[].hour` 是**时钟小时 0..23**，不是「近 24 小时窗口序号」。

## 五、契约变更流程

数据字段就是接口契约，任何改动都要走这条链：

1. 改 `scripts/mock/generate.mjs`：先改数据结构 / 字段，再让聚合从明细现算
2. 同步改 `web/lib/av/types.ts`（字段注释里写清单位与方向）与 `scripts/mock/lib/dataset.mjs`（如涉及读法）
3. **加检查**：
   - 聚合 / 外键 / 排序 / 分片 → `scripts/mock/validate.mjs`
   - 「前端会不会画错」的语义问题（轴、单位、指针、体积、极端值）→ `scripts/mock/audit-frontend-contract.mjs`
4. `node scripts/mock/generate.mjs && node scripts/mock/validate.mjs && node scripts/mock/audit-frontend-contract.mjs`
5. `cd web && npm run test:unit && npm run build`

约定：

- **禁止手写聚合值**。场景卡的点位 / 设备数、站点概要文案、KPI、趋势、排行都必须从明细现算。
- **新增聚合字段必须同时加一条「聚合对明细」检查**，否则下一轮还会出现「场景卡写 208、明细 164」。
- **数据层不存颜色**。只存语义 token（`theme_token` / speaker `index`），颜色由前端 theme 映射，
  这样设计换皮不需要重跑数据。
- **告警必须分片**。单文件 > 1.5MB 直接判 P1；新增字段时注意分片体积上限。

## 六、目录

```text
scripts/mock/
├─ generate.mjs                  生成器（固定种子 20260701）
├─ validate.mjs                  158 项一致性校验
├─ audit-frontend-contract.mjs   前端可消费性审计（P0/P1/P2）
└─ lib/dataset.mjs               数据集读取 + 时间换算（校验脚本共用）

web/lib/av/
├─ types.ts                      全量 TypeScript 契约
├─ time.ts                       时间换算（UTC+8，机器时区无关）
├─ pagination.ts                 游标分页纯函数
├─ load.ts                       带类型的加载器（loadCore / loadAlarmPage / loadDataset）
├─ time.test.ts                  时间换算单测
├─ pagination.test.ts            游标分页单测
└─ dataset.test.ts               真实数据契约测试（读 web/public/mock/av）

web/public/mock/av/
├─ index.json                    数据集索引（文件清单 / 规模 / 剧本摘要）
├─ alarms-index.json             告警分片清单 + 游标分页契约（首屏只加载它）
├─ alarms/shard-000.json …       告警分片（新 → 旧，单片 ≤ 1.2MB）
├─ org / sites / points / devices / device-stats / users
├─ incidents / kpi / trends / rankings / scenes / algorithms / rules
├─ audit-logs / spectra / transcripts
```

## 七、已知取舍

1. **只落盘 12 段频谱**：14k 条告警里只有剧本与高频样本有频谱证据，其余 `evidence.spectrum_id = null`。
   这是刻意的：真实系统也不会把每段录音的频谱都常驻内存。
2. **事件只覆盖部分告警**：`related` 一定能点进事件，`noise` 是背景量。这是真实系统的常态。
3. **GPU / 存储是单机口径**：8 卡 768GB、10TB 热存储，仅用于看板，与真实硬件无关。
4. **没有视频文件**：只给时长 / 片段数元信息，缩略图由 UI 侧生成。
5. **仅中文**：文案全中文，未做 i18n。
