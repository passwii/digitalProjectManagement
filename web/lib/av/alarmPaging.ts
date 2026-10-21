/**
 * 告警中心的分页条数（唯一真源）。
 *
 * 为什么单独一个文件：这个值被**三个地方**消费 ——
 *   1. `lib/av/pageData.ts` 的服务端首屏（Server Component 直接塞进 RSC payload）；
 *   2. `components/av/pages/AlarmView.tsx` 的「加载下一页」与计数文案；
 *   3. `lib/av/server.ts` 的 `getAlarmPage` 默认值。
 *
 * BLF-1426 之前 1 和 2 各写了一个 `50`，改一处就会出现「文案说每页 12 条、
 * 实际渲染 50 条」的自相矛盾。所以只留这一份常量，两套运行时（node / browser）
 * 都 import 它 —— 本文件必须保持**零依赖**，不能引 node:fs 或 React。
 *
 * 12 这个数字不是拍脑袋：`/alarm` 左栏首屏要跟右侧三卡栈（未处置分级 /
 * 处置指标 / 告警剧本）等高。实测（1440×1200 dark，本地 dev）：
 *   面板 chrome 160px + 12 × 67px 行高 = 964px；
 *   右侧三卡栈内容高 956px（1440）/ 972.5px（1280、1180）→ 差 8 / 8.5px。
 * 行高令牌 `--av-alarm-row-h` 与这个条数是一对，改动请一起量
 * `scripts/av-alarm-row-calibration.mjs`。
 */
export const ALARM_PAGE_SIZE = 12;
