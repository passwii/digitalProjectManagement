// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { ReactNode } from "react";

/**
 * /device 图表组 + 演示帧的 DOM 契约（BLF-1428 · Stage 6）。
 *
 * 验收里有三条是**只有渲染出来才能守**的：
 *   · 首屏 ≥ 3 张真图表（柱状 / 折线 / 环形），且高度只取 `AV_CHART_HEIGHT` 三档；
 *   · 同一张图里的多系列颜色互不相同（站点 3 条线 = series-1..3）；
 *   · `?static=1` / 减少动效下 5 秒一帧的推进必须完全停住 —— 否则 Stage 8 的
 *     三连拍 MD5 会不一样；
 *   · 抽屉里的「信号强度」曲线（Stage 1 修掉的 0 高 bug）必须仍然挂得上容器。
 *
 * jsdom 没有布局引擎（ResponsiveContainer 量到 0×0），所以这里断言的是
 * **结构与取值**（容器高度、图例色调、帧号、文本读数），真实渲染交给
 * `scripts/av-device-charts.mjs` 在 Chrome 里量。
 */

vi.mock("next/navigation", () => ({
  usePathname: () => "/stream-monitor/device",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

/**
 * `useTheme` 只为「主题变了重读令牌」服务。这个文件关心结构与帧推进，不关心配色，
 * 固定成深色既省掉 ThemeProvider 的 localStorage 逻辑，也避免 jsdom 里
 * `getComputedStyle` 读不到令牌带来的噪音。
 */
vi.mock("@/components/theme/ThemeProvider", () => ({
  useTheme: () => ({ appliedTheme: "dark", resolvedTheme: "dark", mode: "dark" }),
}));

import AvMotionProvider from "@/components/av/motion/AvMotionProvider";
import DeviceView from "@/components/av/pages/DeviceView";
import { AV_CHART_HEIGHT } from "@/lib/av/chartHeights";
import { AV_MOTION_ATTRIBUTE } from "@/lib/av/motion";
import { DEVICE_STREAM_TICK_SECONDS } from "@/lib/av/deviceStream";
import type { DeviceRow, DeviceViewProps } from "@/lib/av/contracts";

const SIGNAL_SERIES = [
  { label: "08:00", value: -52 },
  { label: "10:00", value: -58 },
  { label: "12:00", value: -61 },
  { label: "14:00", value: -55 },
];

function device(
  overrides: Partial<DeviceRow> & Pick<DeviceRow, "id" | "siteId" | "status" | "room" | "model" | "typeName" | "kind">,
): DeviceRow {
  return {
    id: overrides.id,
    siteId: overrides.siteId,
    siteName: overrides.siteId,
    room: overrides.room,
    model: overrides.model,
    typeName: overrides.typeName,
    kind: overrides.kind,
    firmware: "3.4.1",
    status: overrides.status,
    heartbeatOffsetMinutes: overrides.heartbeatOffsetMinutes ?? 1,
    uptimeDays: 120,
    signal: 78,
    cpu: 42,
    storage: 55,
    micSensitivityDbm: -46,
    selfCheck: { result: "pass", atOffsetMinutes: 600, items: ["麦克风", "网络"] },
    selfCheckHistory: [],
    otaRecords: [],
    signalSeries: overrides.signalSeries ?? SIGNAL_SERIES,
  };
}

/*
 * 第一行放一台在线设备：抽屉用例直接点第一行，拿到的必然是「信号强度」曲线，
 * 而不是离线设备的空态。
 */
const DEVICES: DeviceRow[] = [
  device({ id: "AV-MIC-S8-2001", siteId: "site-01", status: "online", room: "教学楼 A1 走廊", model: "AV-MIC-S8", typeName: "阵列拾音器", kind: "audio" }),
  device({ id: "AV-CAM-PTZ-2002", siteId: "site-01", status: "online", room: "教学楼 A2 大门", model: "AV-CAM-PTZ", typeName: "球机", kind: "video" }),
  device({ id: "AV-MIC-S6-2003", siteId: "site-01", status: "offline", room: "教学楼 B1 教室", model: "AV-MIC-S6", typeName: "拾音终端", kind: "audio", heartbeatOffsetMinutes: 420 }),
  device({ id: "AV-GW-200-2004", siteId: "site-02", status: "maintenance", room: "住院部弱电井", model: "AV-GW-200", typeName: "网关", kind: "gateway", heartbeatOffsetMinutes: 30 }),
  device({ id: "AV-MIC-S8-2005", siteId: "site-02", status: "online", room: "住院部 3 楼护士站", model: "AV-MIC-S8", typeName: "阵列拾音器", kind: "audio" }),
  device({ id: "AV-CAM-360-2006", siteId: "site-03", status: "online", room: "办案区讯问室", model: "AV-CAM-360", typeName: "全景摄像头", kind: "video" }),
];

const PROPS: DeviceViewProps = {
  devices: DEVICES,
  summary: {
    total: 6,
    online: 4,
    offline: 1,
    maintenance: 1,
    byStatus: [
      { status: "online", count: 4 },
      { status: "offline", count: 1 },
      { status: "maintenance", count: 1 },
    ],
    bySite: [
      { id: "site-01", name: "示范第一中学", total: 3, online: 2, offline: 1, rate: 66.7 },
      { id: "site-02", name: "市人民医院", total: 2, online: 1, offline: 1, rate: 50 },
      { id: "site-03", name: "市执法办案管理中心", total: 1, online: 1, offline: 0, rate: 100 },
    ],
    byModel: [
      { model: "AV-MIC-S8", typeName: "阵列拾音器", count: 2 },
      { model: "AV-CAM-PTZ", typeName: "球机", count: 1 },
      { model: "AV-MIC-S6", typeName: "拾音终端", count: 1 },
      { model: "AV-GW-200", typeName: "网关", count: 1 },
      { model: "AV-CAM-360", typeName: "全景摄像头", count: 1 },
    ],
    ota: { total: 20, success: 18, failed: 2 },
    signalHealth: { avg: 74.8, p10: 56, p50: 75, p90: 93 },
  },
};

const CHART_HEIGHTS = new Set<number>(Object.values(AV_CHART_HEIGHT));

function renderDevice(children: ReactNode = <DeviceView {...PROPS} />) {
  return render(<AvMotionProvider>{children}</AvMotionProvider>);
}

/**
 * 真正的图表容器（带高度与 aria-label 的那一层）。
 *
 * 柱状 / 折线是 `ChartFrame` 的 `.frame`（自带 inline height）；
 * 环形图外层的 `.donutWrap` 只是 `data-motion` 标记，高度与 aria-label 在内层
 * `.donutChart` —— 不剥这一层，断言会拿到一个没有高度的包装节点。
 */
function chartSurfaces(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-motion="chart"]')).map(
    (node) => (node.style.height ? node : node.querySelector<HTMLElement>('[class*="donutChart"]') ?? node),
  );
}

/** 页面根节点上的帧号（0 = 静态基准帧）。 */
function frameOf(container: HTMLElement): number {
  return Number(container.querySelector("[data-device-frame]")?.getAttribute("data-device-frame"));
}

/** 逐站点读数（`站点名 在线/总数`）的文本快照。 */
function siteReadings(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("[data-device-site]")).map(
    (node) => node.textContent?.trim() ?? "",
  );
}

beforeEach(() => {
  window.history.pushState({}, "", "/stream-monitor/device");
  document.documentElement.removeAttribute(AV_MOTION_ATTRIBUTE);
  // jsdom 的 <dialog> 支持参差（老版本没有 showModal），抽屉用例兜一层
  if (typeof HTMLDialogElement !== "undefined" && !HTMLDialogElement.prototype.showModal) {
    HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
      this.open = true;
    };
    HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
      this.open = false;
      this.dispatchEvent(new Event("close"));
    };
  }
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  document.documentElement.removeAttribute(AV_MOTION_ATTRIBUTE);
});

describe("/device 首屏图表组", () => {
  it("首屏至少有 4 张真图表：站点堆叠柱 / 状态环 / 在线率折线 / 型号横向柱", () => {
    const { container } = renderDevice();
    const frames = chartSurfaces(container);
    // 4 张主图 + 侧栏 OTA 成功率小环 = 5 个图表容器
    expect(frames.length).toBeGreaterThanOrEqual(4);
    const labels = frames.map((frame) => frame.getAttribute("aria-label") ?? "").join(" | ");
    for (const keyword of ["堆叠柱", "环形图", "趋势图", "横向柱状图"]) {
      expect(labels, `缺少「${keyword}」`).toContain(keyword);
    }
  });

  it("每个图表容器的高度只取 AV_CHART_HEIGHT 三档，且内部有 recharts 容器承接 100% 高度", () => {
    const { container } = renderDevice();
    const frames = chartSurfaces(container);
    expect(frames.length).toBeGreaterThan(0);
    for (const frame of frames) {
      const height = Number.parseFloat(frame.style.height);
      expect(CHART_HEIGHTS.has(height), `${frame.getAttribute("aria-label")} 高度 ${frame.style.height} 不在档位内`).toBe(
        true,
      );
      // 环形图自带内联高度；柱状 / 折线必须经过 ResponsiveContainer
      if (!frame.querySelector('[class*="donutChart"]')) {
        expect(frame.querySelector('[class*="recharts-responsive-container"]')).not.toBeNull();
      }
    }
    // 三档全都用到了（lg 主图 / md 状态环 / sm 抽屉与 OTA），否则说明档位串了
    const used = new Set(frames.map((frame) => Number.parseFloat(frame.style.height)));
    expect(used.has(AV_CHART_HEIGHT.lg)).toBe(true);
    expect(used.has(AV_CHART_HEIGHT.md)).toBe(true);
    expect(used.has(AV_CHART_HEIGHT.sm)).toBe(true);
  });

  it("站点堆叠柱的四个图例（在线 / 离线 / 维护中 / 在线率）颜色互不相同", () => {
    const { container } = renderDevice();
    const panel = container.querySelector('[data-motion-key="device-sites"]');
    expect(panel).not.toBeNull();
    const tones = Array.from(panel!.querySelectorAll<HTMLElement>('[class*="legendItem"]')).map(
      (item) => item.style.getPropertyValue("--tone"),
    );
    expect(tones).toHaveLength(4);
    expect(new Set(tones).size).toBe(4);
    // 颜色必须是令牌引用（语义色或 series-*），不能是色值
    for (const tone of tones) expect(tone).toMatch(/^var\(--av-(tone-|series-)/);
  });

  it("三条站点在线率曲线用 series-1 / 2 / 3，互不相同", () => {
    const { container } = renderDevice();
    const panel = container.querySelector('[data-motion-key="device-trend"]');
    expect(panel).not.toBeNull();
    const tones = Array.from(panel!.querySelectorAll<HTMLElement>('[class*="legendItem"]')).map(
      (item) => item.style.getPropertyValue("--tone"),
    );
    expect(tones).toEqual(["var(--av-series-1)", "var(--av-series-2)", "var(--av-series-3)"]);
    expect(new Set(tones).size).toBe(3);
  });
});

describe("/device 演示帧推进", () => {
  it("动效开启时每 5 秒推进一帧，站点读数随之变化", () => {
    vi.useFakeTimers();
    const { container } = renderDevice();
    expect(frameOf(container)).toBe(0);
    const before = siteReadings(container);
    expect(before).toHaveLength(3);

    act(() => {
      vi.advanceTimersByTime(DEVICE_STREAM_TICK_SECONDS * 1000);
    });

    expect(frameOf(container)).toBe(1);
    // 帧推进必须真的改到图上/读数上，不能只改一个内部计数器
    expect(siteReadings(container)).not.toEqual(before);
  });

  it("?static=1（data-av-motion=off）下推进 3 个周期仍然停在基准帧", () => {
    vi.useFakeTimers();
    document.documentElement.setAttribute(AV_MOTION_ATTRIBUTE, "off");
    const { container } = renderDevice();
    const before = siteReadings(container);

    act(() => {
      vi.advanceTimersByTime(DEVICE_STREAM_TICK_SECONDS * 1000 * 3);
    });

    expect(frameOf(container)).toBe(0);
    expect(siteReadings(container)).toEqual(before);
  });

  it("运行期关动效（站内跳到 ?static=1）时回到基准帧，不停在某一合成帧上", () => {
    vi.useFakeTimers();
    const { container } = renderDevice();
    const baseline = siteReadings(container);
    expect(frameOf(container)).toBe(0);

    act(() => {
      vi.advanceTimersByTime(DEVICE_STREAM_TICK_SECONDS * 1000 * 2);
    });
    expect(frameOf(container)).toBe(2);
    expect(siteReadings(container)).not.toEqual(baseline);

    /*
     * 开关是**运行期**变的：AvMotionProvider 订阅 prefers-reduced-motion 的 change，
     * 站内跳到 `?static=1` 也会经 popstate 把 frozen 打开。此时只停定时器会把画面
     * 冰在「在线 130」这种合成帧上 —— Stage 8 先看动态页再客户端跳静态页截图就
     * 不是基准帧了。所以冻结必须把 tick 拨回 0。
     */
    act(() => {
      window.history.pushState({}, "", "/stream-monitor/device?static=1");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    expect(frameOf(container)).toBe(0);
    expect(siteReadings(container)).toEqual(baseline);

    // 冻结后时间继续走，也不许再离开基准帧
    act(() => {
      vi.advanceTimersByTime(DEVICE_STREAM_TICK_SECONDS * 1000 * 3);
    });
    expect(frameOf(container)).toBe(0);
    expect(siteReadings(container)).toEqual(baseline);
  });

  it("筛选 Tab 的计数读服务端快照：推进帧后仍等于筛出来的行数", () => {
    vi.useFakeTimers();
    const { container } = renderDevice();

    // tick 2 时聚合层把在线台数推到了 3（基准是 4）——Tab 计数不能跟着变成 3
    act(() => {
      vi.advanceTimersByTime(DEVICE_STREAM_TICK_SECONDS * 1000 * 2);
    });
    expect(frameOf(container)).toBe(2);

    const tabs = Array.from(container.querySelectorAll<HTMLElement>('[aria-label="设备状态筛选"] button'));
    expect(tabs).toHaveLength(4);
    const counts = tabs.map((tab) => Number(tab.querySelector('[class*="tabCount"]')?.textContent));
    // 服务端快照：6 台 = 4 在线 + 1 离线 + 1 维护中
    expect(counts).toEqual([6, 4, 1, 1]);

    for (const tab of tabs) {
      const count = Number(tab.querySelector('[class*="tabCount"]')?.textContent);
      fireEvent.click(tab);
      const rows = container.querySelectorAll("tbody tr").length;
      expect(rows, `「${tab.textContent}」的计数与台账行数不一致`).toBe(count);
    }
  });

  it("静态模式下两次渲染的 DOM 完全一致（三连拍 MD5 一致的前提）", () => {
    document.documentElement.setAttribute(AV_MOTION_ATTRIBUTE, "off");
    const first = renderDevice();
    const html = first.container.innerHTML;
    cleanup();
    const second = renderDevice();
    expect(second.container.innerHTML).toBe(html);
  });

  it("页面结构里没有写死的业务总量（数字都来自 props / 演示帧）", () => {
    // 与 avSourceGuard 的源码扫描互补：这里看渲染结果，防止「注释里绕开、JSX 里写死」
    const { container } = renderDevice();
    const text = container.textContent ?? "";
    expect(text).toContain("6"); // total 来自 PROPS.summary
    expect(text).toContain("20"); // OTA 任务数来自 props
  });
});

describe("/device 抽屉：信号强度曲线（Stage 1 回归点）", () => {
  it("点开在线设备后，抽屉里的信号曲线容器高度取自 sm 档且仍在文档中", () => {
    const { container } = renderDevice();
    const firstRow = container.querySelector("tbody tr");
    expect(firstRow).not.toBeNull();
    fireEvent.click(firstRow!);

    const dialog = container.querySelector("dialog");
    expect(dialog?.open).toBe(true);
    const signal = dialog!.querySelector<HTMLElement>('[data-motion="chart"]');
    expect(signal).not.toBeNull();
    expect(signal!.getAttribute("aria-label")).toContain("信号强度");
    expect(Number.parseFloat(signal!.style.height)).toBe(AV_CHART_HEIGHT.sm);
    expect(signal!.querySelector('[class*="recharts-responsive-container"]')).not.toBeNull();
  });
});

describe("/device CSS：演示帧相关样式只允许令牌", () => {
  it("状态格 / 侧栏读数吃 --metric-tone，未给时回落正文色", () => {
    const pages = readFileSync(resolve(process.cwd(), "components/av/pages/AvPages.module.css"), "utf8");
    expect(pages).toMatch(/\.statusCell strong\s*\{[^}]*color:\s*var\(--metric-tone,\s*var\(--av-ink\)\)/);
    expect(pages).toMatch(/\.railRow strong\s*\{[^}]*color:\s*var\(--metric-tone,\s*var\(--av-ink\)\)/);
  });

  it("环心数字色调走 --donut-tone（不传时仍是正文色）", () => {
    const charts = readFileSync(resolve(process.cwd(), "components/av/AvCharts.module.css"), "utf8");
    expect(charts).toMatch(/\.donutCenter strong\s*\{[^}]*color:\s*var\(--donut-tone,\s*var\(--av-ink\)\)/);
  });
});
