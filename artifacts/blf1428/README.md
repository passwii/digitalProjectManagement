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

- `device-hover.png`：站点柱状图的悬停卡片（含「在线 x/y」）。
- `device-drawer.png`：抽屉里的「信号强度（近 24 小时）」曲线（Stage 1 的 0 高 bug 回归点）。

## static/ · 静态可复现

`node scripts/av-static-shoot.mjs "<baseUrl>/stream-monitor/device?static=1" artifacts/blf1428/static`

- 三次连拍 MD5 全部为 `c52e1334fad89730b1e9f4bf688340e1`（`identical: true`，
  `data-av-motion="off"`，顶栏时钟停在 `12:00:00`）。`shot-1.png` 是其中一张。

## 其它已跑的检查

- `cd web && npm test` → `node:test` + `vitest` 共 615 条全绿（新增 15 + 11 条）。
- `cd web && npm run build` → 通过。
- `node scripts/av-layout-overflow.mjs <baseUrl>` → 8 页 × 7 个宽度全绿（无溢出 / 无裁切 / 无横向滚动）。
