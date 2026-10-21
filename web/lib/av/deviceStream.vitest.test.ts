import { describe, expect, it } from "vitest";
import type { DeviceRow, DeviceViewProps } from "@/lib/av/contracts";
import {
  DEVICE_STREAM_FRAMES,
  DEVICE_STREAM_LIVE_LABEL,
  DEVICE_STREAM_TICK_SECONDS,
  deviceFrameAt,
  deviceStreamBase,
  rateAxisDomain,
} from "@/lib/av/deviceStream";
import { percentDomain, percentTicks } from "@/lib/av/chartAxis";

/**
 * /device 演示帧的数据契约（BLF-1428 · Stage 6）。
 *
 * 这个文件守的不是「图表长什么样」，而是**同一帧的数字必须自洽**：
 *   · 站点三分（在线 / 离线 / 维护中）永远加得回总数；
 *   · 状态格、环形图、站点柱状、折线末端读的是同一帧（不是各算各的）；
 *   · 每帧只抖 ±1，维护中不动；
 *   · 24 小时在线率是**从最近心跳反推**的，不是 `signal_series`（那条曲线是平的）；
 *   · 静态基准帧（tick 0）逐字等于服务端口径 —— 截图连拍三次 MD5 一致的前提。
 */

/** 最小可用的明细行：只填演示帧真正读的字段，其余给中性值。 */
function device(overrides: Partial<DeviceRow> & Pick<DeviceRow, "id" | "siteId" | "status">): DeviceRow {
  return {
    id: overrides.id,
    siteId: overrides.siteId,
    siteName: overrides.siteName ?? overrides.siteId,
    room: "测试点位",
    model: "AV-MIC-S8",
    typeName: "阵列拾音器",
    kind: "audio",
    firmware: "3.4.1",
    status: overrides.status,
    heartbeatOffsetMinutes: overrides.heartbeatOffsetMinutes ?? 1,
    uptimeDays: 30,
    signal: 80,
    cpu: 40,
    storage: 50,
    micSensitivityDbm: -46,
    selfCheck: { result: "pass", atOffsetMinutes: 120, items: ["麦克风"] },
    selfCheckHistory: [],
    otaRecords: [],
    signalSeries: [],
  };
}

/*
 * 三个站点的构成（刻意让「维护中」落在 site-01 / site-02 两个站点里）：
 *   site-01：3 在线 + 1 离线 + 1 维护中 = 5
 *   site-02：2 在线 + 1 离线 = 3
 *   site-03：1 在线 + 1 维护中 = 2
 * 合计 6 在线 / 2 离线 / 2 维护中 = 10
 */
const DEVICES: DeviceRow[] = [
  device({ id: "d-1", siteId: "site-01", siteName: "示范第一中学", status: "online", heartbeatOffsetMinutes: 1 }),
  device({ id: "d-2", siteId: "site-01", siteName: "示范第一中学", status: "online", heartbeatOffsetMinutes: 2 }),
  device({ id: "d-3", siteId: "site-01", siteName: "示范第一中学", status: "online", heartbeatOffsetMinutes: 3 }),
  // 6 小时前最后一次心跳：12 小时前的那个采样点它还算在线
  device({ id: "d-4", siteId: "site-01", siteName: "示范第一中学", status: "offline", heartbeatOffsetMinutes: 360 }),
  device({ id: "d-5", siteId: "site-01", siteName: "示范第一中学", status: "maintenance", heartbeatOffsetMinutes: 30 }),
  device({ id: "d-6", siteId: "site-02", siteName: "市人民医院", status: "online", heartbeatOffsetMinutes: 1 }),
  device({ id: "d-7", siteId: "site-02", siteName: "市人民医院", status: "online", heartbeatOffsetMinutes: 1 }),
  device({ id: "d-8", siteId: "site-02", siteName: "市人民医院", status: "offline", heartbeatOffsetMinutes: 1440 }),
  device({ id: "d-9", siteId: "site-03", siteName: "市执法办案管理中心", status: "online", heartbeatOffsetMinutes: 1 }),
  device({ id: "d-10", siteId: "site-03", siteName: "市执法办案管理中心", status: "maintenance", heartbeatOffsetMinutes: 20 }),
];

const SUMMARY: DeviceViewProps["summary"] = {
  total: 10,
  online: 6,
  offline: 2,
  maintenance: 2,
  byStatus: [
    { status: "online", count: 6 },
    { status: "offline", count: 2 },
    { status: "maintenance", count: 2 },
  ],
  /*
   * 注意 `offline` 这一列的口径：数据层给的是 `total - online`，把维护中一起算了进去。
   * site-01 是 5 - 3 = 2，而真实离线只有 1 台（另 1 台在维护）。
   */
  bySite: [
    { id: "site-01", name: "示范第一中学", total: 5, online: 3, offline: 2, rate: 60 },
    { id: "site-02", name: "市人民医院", total: 3, online: 2, offline: 1, rate: 66.7 },
    { id: "site-03", name: "市执法办案管理中心", total: 2, online: 1, offline: 1, rate: 50 },
  ],
  byModel: [
    { model: "AV-MIC-S8", typeName: "阵列拾音器", count: 7 },
    { model: "AV-GW-200", typeName: "网关", count: 3 },
  ],
  ota: { total: 40, success: 35, failed: 5 },
  signalHealth: { avg: 74.8, p10: 56, p50: 75, p90: 93 },
};

const BASE = deviceStreamBase(DEVICES, SUMMARY);

describe("/device 演示帧：基准帧 = 服务端口径", () => {
  it("站点三分按明细现算，维护中不会被算成离线", () => {
    const site = BASE.sites.find((item) => item.id === "site-01");
    expect(site).toMatchObject({ total: 5, online: 3, offline: 1, maintenance: 1 });
    // summary.bySite 说 site-01 离线 2 台（含维护中）；演示帧不能照抄
    expect(SUMMARY.bySite[0].offline).toBe(2);
    expect(site?.offline).not.toBe(SUMMARY.bySite[0].offline);
  });

  it("站点合计与 summary 的 online / offline / maintenance 逐项相等", () => {
    const sum = (key: "online" | "offline" | "maintenance") =>
      BASE.sites.reduce((total, site) => total + site[key], 0);
    expect(sum("online")).toBe(SUMMARY.online);
    expect(sum("offline")).toBe(SUMMARY.offline);
    expect(sum("maintenance")).toBe(SUMMARY.maintenance);
    expect(BASE.sites.reduce((total, site) => total + site.total, 0)).toBe(SUMMARY.total);
  });

  it("站点没有明细时退回服务端口径，并把维护中记 0（不凭空造维护中）", () => {
    const orphan = deviceStreamBase(DEVICES, {
      ...SUMMARY,
      bySite: [
        ...SUMMARY.bySite,
        { id: "site-09", name: "无明细站点", total: 4, online: 3, offline: 1, rate: 75 },
      ],
    });
    expect(orphan.sites.find((site) => site.id === "site-09")).toMatchObject({
      total: 4,
      online: 3,
      offline: 1,
      maintenance: 0,
    });
  });
});

describe("/device 演示帧：近 24 小时在线率从最近心跳反推", () => {
  it("11 个历史采样点，每 2 小时一个，旧 → 新", () => {
    expect(BASE.historyLabels).toHaveLength(11);
    expect(BASE.historyLabels[0]).toMatch(/^\d{2}:\d{2}$/);
    // 数据锚点 12:00：最早一格是 22 小时前（14:00），最后一格是 2 小时前（10:00）
    expect(BASE.historyLabels[0]).toBe("14:00");
    expect(BASE.historyLabels[BASE.historyLabels.length - 1]).toBe("10:00");
    for (const labels of Object.values(BASE.history)) expect(labels).toHaveLength(11);
  });

  it("越靠近现在在线率越低（离线设备在掉线那一刻让曲线掉一格）", () => {
    for (const [siteId, values] of Object.entries(BASE.history)) {
      for (let index = 1; index < values.length; index += 1) {
        expect(values[index], `${siteId} 第 ${index} 个点`).toBeLessThanOrEqual(values[index - 1]);
      }
    }
    // site-01 有 1 台 6 小时前掉线的设备：22 小时前它还在回传（5/5），
    // 从「4 小时前」那一格起就少了它（4/5）—— 曲线在那一格拉低一档，之后不再回升
    const site01 = BASE.history["site-01"];
    expect(site01[0]).toBe(100);
    expect(site01[8]).toBe(100);
    expect(site01[9]).toBe(80);
    expect(site01[site01.length - 1]).toBe(80);
    // site-02 的那台 24 小时前就没回传了：整段历史里它从不算在线
    expect(BASE.history["site-02"][0]).toBe(66.7);
  });

  it("signal_series 不参与：它是一台设备恒定的 RSSI，按它统计会得到一条平线", () => {
    // 明细里的 signalSeries 是空的，历史照样有值 —— 说明真的没读它
    expect(DEVICES.every((item) => item.signalSeries.length === 0)).toBe(true);
    expect(BASE.history["site-01"].some((value) => value !== BASE.history["site-01"][0])).toBe(true);
  });
});

describe("/device 演示帧：每帧自洽且只抖 ±1", () => {
  it("tick 0 就是基准帧：台数不变、趋势末行是当前值", () => {
    const frame = deviceFrameAt(BASE, 0);
    expect(frame.sites.map((site) => site.online)).toEqual(BASE.sites.map((site) => site.online));
    expect(frame.totals).toEqual({ total: 10, online: 6, offline: 2, maintenance: 2 });
    expect(frame.byStatus).toEqual([
      { status: "online", count: 6 },
      { status: "offline", count: 2 },
      { status: "maintenance", count: 2 },
    ]);
  });

  it("每一帧都满足 online + offline + maintenance = total", () => {
    for (let tick = 0; tick <= DEVICE_STREAM_FRAMES * 3; tick += 1) {
      const frame = deviceFrameAt(BASE, tick);
      for (const site of frame.sites) {
        expect(site.online + site.offline + site.maintenance, `tick ${tick} ${site.id}`).toBe(site.total);
      }
      expect(frame.totals.online + frame.totals.offline + frame.totals.maintenance).toBe(frame.totals.total);
      expect(frame.byStatus.reduce((sum, row) => sum + row.count, 0)).toBe(frame.totals.total);
    }
  });

  it("每帧每个站点最多动一台，维护中不动", () => {
    for (let tick = 1; tick <= DEVICE_STREAM_FRAMES * 3; tick += 1) {
      const frame = deviceFrameAt(BASE, tick);
      frame.sites.forEach((site, index) => {
        expect(Math.abs(site.online - BASE.sites[index].online), `tick ${tick} ${site.id}`).toBeLessThanOrEqual(1);
        expect(site.maintenance, `tick ${tick} ${site.id}`).toBe(BASE.sites[index].maintenance);
      });
    }
  });

  it("相邻帧不会三站同向跳（增量按站点错开），且四帧内必有变化", () => {
    const deltas = (tick: number) =>
      deviceFrameAt(BASE, tick).sites.map((site, index) => site.online - BASE.sites[index].online);
    const signatures = new Set<string>();
    for (let tick = 1; tick <= DEVICE_STREAM_FRAMES; tick += 1) {
      const delta = deltas(tick);
      expect(delta.some((value) => value !== 0), `tick ${tick}`).toBe(true);
      signatures.add(delta.join(","));
    }
    // 四个推进帧的增量组合互不相同：否则「每 5 秒变一次」会看起来在重复同一个动作
    expect(signatures.size).toBe(DEVICE_STREAM_FRAMES);
  });

  it("趋势图 11 个历史点 + 末行「现在」，末行就是当前帧的在线率", () => {
    const frame = deviceFrameAt(BASE, 2);
    expect(frame.trend).toHaveLength(BASE.historyLabels.length + 1);
    const live = frame.trend[frame.trend.length - 1];
    expect(live.label).toBe(DEVICE_STREAM_LIVE_LABEL);
    for (const site of frame.sites) expect(live[site.id]).toBe(site.rate);
    // 历史点不跟着帧变化（它们是已经发生过的事）
    frame.trend.slice(0, -1).forEach((row, index) => {
      for (const site of BASE.sites) expect(row[site.id]).toBe(BASE.history[site.id][index]);
    });
  });

  it("OTA 成功率与失败台数从同一份数字推出来", () => {
    const frame = deviceFrameAt(BASE, 3);
    expect(frame.ota).toEqual({ total: 40, success: 35, failed: 5, rate: 87.5 });
  });

  it("同一 tick 反复调用结果完全一致（截图可复现）", () => {
    expect(deviceFrameAt(BASE, 3)).toEqual(deviceFrameAt(BASE, 3));
    expect(deviceFrameAt(BASE, -5)).toEqual(deviceFrameAt(BASE, 0));
    expect(deviceFrameAt(BASE, Number.NaN)).toEqual(deviceFrameAt(BASE, 0));
  });
});

describe("/device 演示帧：验收口径", () => {
  it("帧周期落在 4–6 秒（验收要求），且帧数固定", () => {
    expect(DEVICE_STREAM_TICK_SECONDS).toBeGreaterThanOrEqual(4);
    expect(DEVICE_STREAM_TICK_SECONDS).toBeLessThanOrEqual(6);
    expect(DEVICE_STREAM_FRAMES).toBeGreaterThanOrEqual(3);
  });

  it("在线率 Y 轴：下界贴数据、上界 100，刻度好读且含 100", () => {
    const frame = deviceFrameAt(BASE, 0);
    const domain = rateAxisDomain(frame);
    expect(domain[1]).toBe(100);
    expect(domain[0]).toBeLessThanOrEqual(50);
    expect(percentTicks([85, 100])).toEqual([85, 90, 95, 100]);
    // 跨度大时自动换步长，刻度数不膨胀（60–100 用 10 的步长，而不是 9 个刻度）
    expect(percentTicks([60, 100])).toEqual([60, 70, 80, 90, 100]);
    // 下界永远夹在 0–100：数据全是 99.x 时也不能把轴顶到 100 之外
    expect(percentDomain([99.9, 100])).toEqual([95, 100]);
    expect(percentDomain([])).toEqual([0, 100]);
  });
});
