/**
 * `/device` 的演示帧：把 `getDeviceData()` 已经算好的字段投影成「每 5 秒推进一格」
 * 的图表数据（Stage 6 / BLF-1428）。
 *
 * 口径与 `/overview` 的演示帧一致：**只有聚合层推进**（状态格 / 环形图 / 站点柱状 /
 * 在线率折线），明细层（设备台账、离线与维护清单）保持服务端快照 —— 台账的每一行
 * 都是真数据，不会为了「看起来在动」去改它。
 *
 * 三条口径，改之前先读：
 *
 * 1. **站点三分拆现算，不用 `summary.bySite[].offline`**。数据层那个字段是
 *    `total - online`，把「维护中」一起算进离线了（142−129=13，而 site-01 实际是
 *    11 离线 + 2 维护中）；拿它画「在线 / 离线 / 维护中」堆叠柱会多出一段假离线。
 *    这里按 `devices[].status` 现算，`online + offline + maintenance === total`
 *    由构造保证。
 *
 * 2. **近 24 小时在线率只能从 `last_heartbeat_offset_minutes` 反推**。
 *    `signal_series` 不能用：它在数据里是一台设备 24 个恒定的 RSSI 采样，
 *    正负号不随时间变化，按“信号是否 > 0”统计出来是一条水平直线。
 *    反推规则：某台设备在「h 分钟之前」那一刻算在线 ⇔ 它的最近心跳不晚于那一刻
 *    （`heartbeatOffsetMinutes <= h`）。于是每台离线设备都会在它“掉线的那一刻”
 *    让曲线掉一格 —— 这正是这份数据里真实发生过的事。
 *
 * 3. **每帧只做 ±1 的在线台数抖动**，且同一帧内所有卡片读同一份数字。
 *    状态格、环形图、站点柱状、折线末端若各读各的（比如状态格读静态 summary、
 *    折线末端读抖动后的值），同一屏会同时出现两个在线台数 —— `/overview`
 *    Stage 4 踩过这个坑，这里用「一个 frame 对象喂满一屏」避免。
 */

import type { DeviceRow, DeviceViewProps } from "./contracts";
import type { DeviceStatus } from "./types";
import { toAbsolute } from "./time";
import { percentDomain } from "./chartAxis";

/** 演示帧周期（秒）。验收要求 4–6 秒；与 `/overview` 的 `stream.tick_seconds` 同档。 */
export const DEVICE_STREAM_TICK_SECONDS = 5;

/**
 * 每帧每个站点的在线台数增量。
 *
 * 下标是 `(tick + 站点序号) % 4`，所以相邻站点同一帧的增量不同（不会出现
 * 「三个站点一起 +1」那种整屏跳一下），而 tick 0 恒为基准帧（静态截图的定格）。
 */
const ONLINE_DELTA_STEPS = [0, 1, 0, -1] as const;

/** 帧数（含基准帧 tick 0 后的四个推进帧）。 */
export const DEVICE_STREAM_FRAMES = ONLINE_DELTA_STEPS.length;

/** 在线率历史的采样间隔（分钟）与覆盖时长（近 24 小时）。 */
const HISTORY_STEP_MINUTES = 120;
const HISTORY_SPAN_MINUTES = 24 * 60;

/**
 * 历史点个数（不含末尾的「现在」）：每 2 小时一个，铺满 24 小时。
 *
 * 12 个点 = 24 小时前 → 2 小时前；最早的左端就是 24 小时前（不是「22 小时前」），
 * 最右一段 2 小时 → 现在由趋势末行的「现在」补齐。之前写 `- 1` 正好把左端
 * 削掉了 2 小时：标签说「近 24 小时」，数据只有 22 小时。
 */
const HISTORY_POINT_COUNT = HISTORY_SPAN_MINUTES / HISTORY_STEP_MINUTES;

/** 折线末端那一格的 X 轴标签：它是当前帧的实时值，不是历史采样。 */
export const DEVICE_STREAM_LIVE_LABEL = "现在";


export interface DeviceSiteBase {
  id: string;
  name: string;
  total: number;
  online: number;
  offline: number;
  maintenance: number;
}

export interface DeviceSiteFrame extends DeviceSiteBase {
  /** 在线率（百分数，一位小数），与柱状图上那条第二视觉是同一条数据。 */
  rate: number;
}

export interface DeviceStreamBase {
  sites: DeviceSiteBase[];
  /** site.id → 近 24 小时在线率（旧 → 新，不含「现在」），与 `historyLabels` 一一对应。 */
  history: Record<string, number[]>;
  /** 历史点的 X 轴标签（旧 → 新），取自数据锚点的钟点。 */
  historyLabels: string[];
  models: DeviceViewProps["summary"]["byModel"];
  ota: DeviceViewProps["summary"]["ota"];
  signalHealth: DeviceViewProps["summary"]["signalHealth"];
}

export interface DeviceOtaFrame {
  total: number;
  success: number;
  failed: number;
  /** 成功率（百分数，一位小数）。 */
  rate: number;
}

/** recharts 直接吃的一行趋势数据：`{ label, [siteId]: rate }`。 */
export type DeviceTrendRow = Record<string, string | number>;

export interface DeviceFrame {
  tick: number;
  sites: DeviceSiteFrame[];
  /** 环形图 / 状态格 / 筛选 Tab 读的同一份状态构成。 */
  byStatus: { status: DeviceStatus; count: number }[];
  totals: { total: number; online: number; offline: number; maintenance: number };
  ota: DeviceOtaFrame;
  /** 趋势行：12 个历史点（24 小时前 → 2 小时前）+ 末尾一帧「现在」（= 当前帧的站点在线率）。 */
  trend: DeviceTrendRow[];
}

/** 百分数保留一位小数：与 `formatPercent` 的展示口径一致，避免 92.3000001 这种尾巴。 */
function rateOf(part: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((part / total) * 1000) / 10;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * 基准帧：一次性把 props 折成「站点三分 + 24 小时历史 + 型号 / OTA / 信号健康」。
 *
 * 只在 `devices` / `summary` 变化时算一次（页面里用 `useMemo` 兜住），
 * 之后的每帧抖动都是纯函数增量，不会重新扫一遍全量设备。
 */
export function deviceStreamBase(
  devices: DeviceRow[],
  summary: DeviceViewProps["summary"],
): DeviceStreamBase {
  const sites: DeviceSiteBase[] = summary.bySite.map((site) => {
    const rows = devices.filter((device) => device.siteId === site.id);
    /*
     * 明细缺失时退回服务端口径：`bySite.offline` 是 `total - online`（含维护中），
     * 这里没有明细就分不出维护中，把它记成 0 台 —— 宁可少一段颜色，
     * 也不要凭空造出「维护中」。
     */
    if (rows.length === 0) {
      const online = clamp(site.online, 0, site.total);
      return {
        id: site.id,
        name: site.name,
        total: site.total,
        online,
        offline: Math.max(0, site.total - online),
        maintenance: 0,
      };
    }
    const online = rows.filter((device) => device.status === "online").length;
    const maintenance = rows.filter((device) => device.status === "maintenance").length;
    const offline = rows.length - online - maintenance;
    return { id: site.id, name: site.name, total: rows.length, online, offline, maintenance };
  });

  const historyLabels: string[] = [];
  for (let index = 0; index < HISTORY_POINT_COUNT; index += 1) {
    // 最早的一格在前：index 0 = 24 小时前，最后一格 = 2 小时前
    const minutesAgo = HISTORY_SPAN_MINUTES - HISTORY_STEP_MINUTES * index;
    historyLabels.push(toAbsolute(minutesAgo).slice(11));
  }

  const history: Record<string, number[]> = {};
  for (const site of sites) {
    const rows = devices.filter((device) => device.siteId === site.id);
    history[site.id] = historyLabels.map((_, index) => {
      const minutesAgo = HISTORY_SPAN_MINUTES - HISTORY_STEP_MINUTES * index;
      if (rows.length === 0) return 0;
      const reporting = rows.filter((device) => device.heartbeatOffsetMinutes <= minutesAgo).length;
      return rateOf(reporting, rows.length);
    });
  }

  return {
    sites,
    history,
    historyLabels,
    models: summary.byModel,
    ota: summary.ota,
    signalHealth: summary.signalHealth,
  };
}

/**
 * 第 `tick` 帧。**纯函数**：同样的入参永远得到同样的帧 —— 静态截图连拍三次
 * 必须逐像素一致，所以这里不允许出现 `Math.random()` / `Date.now()`。
 */
export function deviceFrameAt(base: DeviceStreamBase, tick: number): DeviceFrame {
  const safeTick = Number.isFinite(tick) ? Math.max(0, Math.trunc(tick)) : 0;

  const sites: DeviceSiteFrame[] = base.sites.map((site, index) => {
    const step =
      safeTick === 0
        ? 0
        : ONLINE_DELTA_STEPS[(safeTick + index) % ONLINE_DELTA_STEPS.length];
    // 维护中的台数不动：它是计划内状态，不该跟着演示帧抖动
    const online = clamp(site.online + step, 0, Math.max(0, site.total - site.maintenance));
    return {
      ...site,
      online,
      offline: Math.max(0, site.total - online - site.maintenance),
      rate: rateOf(online, site.total),
    };
  });

  const sumOf = (key: "online" | "offline" | "maintenance") =>
    sites.reduce((sum, site) => sum + site[key], 0);

  const totals = {
    total: sites.reduce((sum, site) => sum + site.total, 0),
    online: sumOf("online"),
    offline: sumOf("offline"),
    maintenance: sumOf("maintenance"),
  };

  const trend: DeviceTrendRow[] = base.historyLabels.map((label, index) => {
    const row: DeviceTrendRow = { label };
    for (const site of sites) row[site.id] = base.history[site.id]?.[index] ?? 0;
    return row;
  });
  const live: DeviceTrendRow = { label: DEVICE_STREAM_LIVE_LABEL };
  for (const site of sites) live[site.id] = site.rate;
  trend.push(live);

  const ota: DeviceOtaFrame = {
    total: base.ota.total,
    success: base.ota.success,
    failed: Math.max(0, base.ota.total - base.ota.success),
    rate: rateOf(base.ota.success, base.ota.total),
  };

  return {
    tick: safeTick,
    sites,
    byStatus: [
      { status: "online", count: totals.online },
      { status: "offline", count: totals.offline },
      { status: "maintenance", count: totals.maintenance },
    ],
    totals,
    ota,
    trend,
  };
}

/**
 * 在线率折线的 Y 轴区间：取整条趋势（含历史点）里的最小值，交给 `percentDomain`
 * 统一取下界 —— 只看当前值会漏掉历史低点，折线会被裁在轴外。
 */
export function rateAxisDomain(frame: DeviceFrame): [number, number] {
  const values: number[] = [];
  for (const row of frame.trend) {
    for (const [key, value] of Object.entries(row)) {
      if (key === "label") continue;
      const numeric = Number(value);
      if (Number.isFinite(numeric)) values.push(numeric);
    }
  }
  return percentDomain(values);
}
