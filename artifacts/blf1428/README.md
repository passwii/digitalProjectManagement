# BLF-1428 验收留档：/device 图表组 + 动态数据流

数慧智科 · 智能音视频平台 `/stream-monitor/device`（父 issue 的 Stage 6）。
所有截图由 `scripts/` 下的脚本在真实 Chrome（CDP）里拍，非手工剪裁。

## before/ · 改动前（main `684944c`）

`node scripts/av-layout-shoot.mjs <baseUrl> artifacts/blf1428/before device`

- `device-1440-dark.png` / `device-1440-light.png` / `device-900-light.png`
- 现状：「站点在线情况」是 `AvBar` 横向进度条（不是图表）；「设备总览」只有一张环形图；
  「型号构成」也是进度条；OTA 只是四行纯数字。

## after/ · 改动后

同一条命令，同样的宽度 / 主题。

- `device-1440-dark.png` / `device-1440-light.png` / `device-900-light.png`
- `results.json`：脚本量到的排版事实 —— `cardBottomSpread: 0`（同行卡片底边齐）、
  `panelPadDelta: 0`（面板头/体左右内边距一致）、`scrollX: 0`（无横向滚动）。
- 首屏（1440×1400）可见 4 张真图表：站点堆叠柱 + 在线率折线 / 状态环形 / 24h 在线率折线 / 型号横向柱。
- 整页截图走 `scripts/lib/avFullPageShot.mjs`：先把视口撑到内容高度再拍。
  直接用 `captureBeyondViewport` 会在截图瞬间撑高视口，recharts 重排 + 重播入场，
  拍出来图表区是空的（旧版 after/ 三张图就是这样：只有面板头和图例）。

## charts/ · 图表与动态数据流

`node scripts/av-device-charts.mjs <baseUrl> artifacts/blf1428/charts`

`report.json` 是脚本量到的原始读数，关键几条：

| 项 | 读数 |
| --- | --- |
| 首屏可见图表 | 4 张（`top` 379 / 379 / 823 / 823，均 < 1400） |
| 图表高度 | 248 / 176 / 248 / 248 / 128（只取 `AV_CHART_HEIGHT` 三档） |
| 站点柱系列色 | 3 种填充 + 1 种折线色，图例 4 种颜色互不相同 |
| 悬停卡片 | `在线 129/142 · 90.8%`（tooltip 业务口径） |
| `?static=1` 冻结 | 站点读数 6.5 秒前后逐字相同 |
| 动效开启 | 帧号 0 → 1，读数 `129/142 → 130/142`、`51/53 → 50/53` |
| 抽屉信号曲线 | 打开后高度 128px（`AV_CHART_HEIGHT.sm`），aria-label 为「AV-MIC-S6-1001 信号强度曲线」 |
| 24h 趋势横轴 | `12:00 … 10:00` + `现在`（12 个历史点，24 小时前 → 2 小时前） |

- `device-hover.png`：站点柱状图的悬停卡片（含「在线 x/y」）。
- `device-drawer.png`：抽屉里的「信号强度（近 24 小时）」曲线（Stage 1 的 0 高 bug 回归点）。

## static/ · 静态可复现

`node scripts/av-static-shoot.mjs "<baseUrl>/stream-monitor/device?static=1" artifacts/blf1428/static`

- 三次连拍 MD5 全部为 `dbb47f21431d4db96b69223da15342f1`（`identical: true`，
  `data-av-motion="off"`，顶栏时钟停在 `12:00:00`）。`shot-1.png` 是其中一张。
- 评审回合 1 之后趋势图从 11 点（22 小时）改成 12 点（24 小时 → 2 小时）+ 末行「现在」，
  哈希随之变化；同一版本内三次连拍仍然逐字节相同。

## 其它已跑的检查

- `cd web && npm test` → `node:test` + `vitest` 共 617 条全绿（新增 15 + 13 条）。
- `cd web && npm run build` → 通过。
- `node scripts/av-layout-overflow.mjs <baseUrl>` → 8 页 × 7 个宽度全绿（无溢出 / 无裁切 / 无横向滚动）。

## 评审回合 1 的修订（2026-10-21）

按 Tia 的 REQUEST_CHANGES 修了 4 条，另外修了留档截图的一个采集坑：

1. `DeviceView` 的演示帧定时器：`motionEnabled` 变 false 时 `setTick(0)`。
   冻结是**运行期**事件（系统切减少动效 / 站内跳 `?static=1` 经 popstate 同步），
   只清定时器会把画面冰在某一合成帧上。用例：推进 2 帧 → `?static=1` →
   `data-device-frame` 回 0、站点读数回基准。
2. `deviceStream` 的历史点：`1440/120 - 1 = 11` 只覆盖 22 小时（22h → 2h），
   改成 12 点覆盖 24h → 2h，末行「现在」补齐最后 2 小时。标签「近 24 小时」与数据一致。
3. `scripts/av-device-charts.mjs`：抽屉没打开时不再静默通过 ——
   `{ open: false }` 直接进 `failures`，脚本以非 0 退出。
4. 筛选 Tab 的计数改读 `summary`（服务端快照），与台账行同一口径；
   用例：推进 2 帧（聚合层在线 3，快照 4）后，每个 Tab 的计数仍等于筛出来的行数。

留档截图：新增 `scripts/lib/avFullPageShot.mjs`，`av-layout-shoot.mjs` 与本目录的
`av-device-charts.mjs` 都改用它拍整页 —— 之前的整页图里图表区是空白的（原因见上）。
