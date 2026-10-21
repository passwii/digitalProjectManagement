// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";

/**
 * /monitor 通道卡动效契约（BLF-1425 · Stage 3）。
 *
 * 这个文件守的是「演示站看起来在动，且每一张卡动得不一样」这件事 ——
 * 单看 JSX 只能证明「有动画 class」，证明不了：
 *   · 9 张卡里 7 张音频卡的波形参数（seed / 周期 / 相位）互不相同；
 *   · 离线通道是真的静态灰态（没有动画变量、LIVE 不呼吸）；
 *   · `?static=1` 下时间码不再递增（连拍 MD5 一致的前提）；
 *   · 筛选切换真的是「退场 → 重排 → 入场」，而不是瞬间替换。
 *
 * jsdom 没有布局引擎与 CSS 动画时间轴，所以断言分两层：
 *   1. **DOM 层**：参数化出来的 `data-*` / CSS 自定义属性、阶段状态、时间码文本；
 *   2. **源码层**：`.channelLive i` 真的挂了 `--av-dur-breathe` 的动画、
 *      波形周期用 `calc(var(--av-dur-*))` 而不是写死毫秒（与 motion 守卫同源）。
 */

vi.mock("next/navigation", () => ({
  usePathname: () => "/stream-monitor/monitor",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));

import AvMotionProvider from "@/components/av/motion/AvMotionProvider";
import MonitorView from "@/components/av/pages/MonitorView";
import AvWaveform, { waveformSeed } from "@/components/av/motion/AvWaveform";
import { formatTimecode } from "@/lib/av/timecode";
import { AV_MOTION_ATTRIBUTE, AV_MOTION, AV_STAGGER } from "@/lib/av/motion";
import type { MonitorChannel, MonitorProps } from "@/lib/av/contracts";

const WAVE = Array.from({ length: 26 }, (_, index) => 0.25 + ((index * 37) % 60) / 100);

function channel(index: number, kind: "audio" | "video", status: "online" | "offline" = "online"): MonitorChannel {
  return {
    id: `${kind === "video" ? "AV-CAM-PTZ" : "AV-MIC-S8"}-${1000 + index}`,
    room: `${index + 1} 楼测试通道 ${index + 1}`,
    siteName: "数慧智科演示站点",
    sceneName: "校园安全",
    kind,
    typeName: kind === "video" ? "视觉终端" : "拾音终端",
    model: kind === "video" ? "PTZ-4K" : "MIC-S8",
    firmware: "2.4.1",
    status,
    signal: 92 - index,
    cpu: 24 + index,
    storage: 41,
    heartbeatOffsetMinutes: 1 + index,
    waveform: WAVE.map((value) => Math.min(1, value + index * 0.01)),
  };
}

// 2 路视频 + 7 路音频（最后一路离线）：与 pageData 的 9 格口径一致
const CHANNELS: MonitorChannel[] = [
  channel(0, "video"),
  channel(1, "video"),
  ...Array.from({ length: 7 }, (_, index) => channel(index + 2, "audio", index === 6 ? "offline" : "online")),
];

const PROPS: MonitorProps = {
  channels: CHANNELS,
  counts: { all: 9, audio: 7, video: 2, offline: 13 },
  deviceTotal: 268,
  signalHealth: { avg: 96.4, p10: 71, p50: 94, p90: 98 },
  models: [
    { model: "MIC-S8", typeName: "拾音终端", count: 241 },
    { model: "PTZ-4K", typeName: "视觉终端", count: 19 },
  ],
  gateways: [{ id: "GW-01", room: "教学楼弱电井", status: "online", heartbeatOffsetMinutes: 1 }],
};

function renderMonitor() {
  return render(
    <AvMotionProvider>
      <MonitorView {...PROPS} />
    </AvMotionProvider>,
  );
}

const css = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

/** 取一个选择器的声明块（注释里的同名写法不会命中：它后面不跟 `{`）。 */
function ruleBody(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(source)?.[1] ?? "";
}

beforeEach(() => {
  window.history.pushState({}, "", "/stream-monitor/monitor");
  document.documentElement.removeAttribute(AV_MOTION_ATTRIBUTE);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  document.documentElement.removeAttribute(AV_MOTION_ATTRIBUTE);
});

describe("参数化波形：同屏多张音频卡不能是同一段动画", () => {
  it("9 张卡渲染成 2 视频 + 7 音频，音频卡数量满足验收（≥6）", () => {
    const { container } = renderMonitor();
    expect(container.querySelectorAll('[data-motion="channel"]')).toHaveLength(9);
    expect(container.querySelector('[data-filter-phase]')?.getAttribute("data-audio-cards")).toBe("7");
    expect(container.querySelectorAll("[data-waveform]")).toHaveLength(7);
  });

  it("7 张音频卡的 seed / 周期倍率 / 相位互不相同", () => {
    const { container } = renderMonitor();
    const waves = Array.from(container.querySelectorAll("[data-waveform]"));
    expect(waves).toHaveLength(7);

    const seeds = waves.map((node) => node.getAttribute("data-wave-seed"));
    const speeds = waves.map((node) => node.getAttribute("data-wave-speed"));
    const phases = waves.map((node) => node.getAttribute("data-wave-phase"));
    expect(new Set(seeds).size).toBe(7);
    expect(new Set(speeds).size).toBe(7);
    expect(new Set(phases).size).toBe(7);

    // 每张卡的「柱高 + 延迟」签名也必须唯一：否则参数不同但看起来还是同一段动画
    const signatures = waves.map((node) =>
      Array.from(node.querySelectorAll("[data-wave-bar]"))
        .map((bar) => `${bar.getAttribute("style")}`)
        .join("|"),
    );
    expect(new Set(signatures).size).toBe(7);

    // 同一张卡内部：柱子的动画延迟也不能全部相同（那是「整块一起跳」）。
    // 离线卡不算 —— 它按设计就没有动画变量（上一组用例单独守）。
    for (const node of waves.filter((item) => item.getAttribute("data-state") === "online")) {
      const delays = Array.from(node.querySelectorAll<HTMLElement>("[data-wave-bar]")).map((bar) =>
        bar.style.getPropertyValue("--av-wave-delay"),
      );
      expect(new Set(delays).size).toBeGreaterThan(4);
    }
  });

  it("离线通道扁平、灰、不挂动画变量（单卡离线也静止）", () => {
    const { container } = renderMonitor();
    const idle = Array.from(container.querySelectorAll("[data-waveform]")).filter(
      (node) => node.getAttribute("data-state") === "offline",
    );
    expect(idle).toHaveLength(1);
    for (const bar of Array.from(idle[0].querySelectorAll("[data-wave-bar]"))) {
      expect(bar.getAttribute("style") ?? "").not.toContain("--av-wave-delay");
      expect(Number((bar.getAttribute("style") ?? "").match(/height:\s*(\d+)%/)?.[1] ?? 100)).toBeLessThanOrEqual(12);
    }
  });

  it("波形周期用令牌的 calc() 派生，不写死毫秒", () => {
    const body = ruleBody(css("components/av/motion/AvMotion.module.css"), ".waveBar");
    expect(body).toMatch(/animation:\s*var\(--av-kf-wave\)\s+calc\(var\(--av-dur-breathe\)/);
    expect(body).toMatch(/--av-dur-breathe\)\s*\*\s*var\(--av-wave-speed/);
    expect(body).not.toMatch(/\b\d+ms\b/);
    // keyframes 名必须走 --av-kf-* 转发：直接写 avWaveBar 会被 CSS Module 本地化，
    // 变成 AvMotion_avWaveBar__hash 而找不到 globals.css 里的 @keyframes（实测不执行）
    expect(body).not.toMatch(/animation:\s*avWaveBar\b/);
  });

  it("waveformSeed 对同一个 id 稳定，对不同 id 有区分度", () => {
    expect(waveformSeed("AV-MIC-S8-1001")).toBe(waveformSeed("AV-MIC-S8-1001"));
    expect(waveformSeed("AV-MIC-S8-1001")).not.toBe(waveformSeed("AV-MIC-S8-1002"));
    const seeds = new Set(Array.from({ length: 50 }, (_, index) => waveformSeed(`AV-MIC-${index}`)));
    expect(seeds.size).toBeGreaterThan(40);
  });
});

describe("LIVE 块：呼吸点 + 时间码 + 静态降级", () => {
  it("在线卡的 LIVE 点真的挂了呼吸动画；离线态显式关掉", () => {
    const pages = css("components/av/pages/AvPages.module.css");
    const live = ruleBody(pages, ".channelLive i");
    expect(live).toMatch(/animation:\s*var\(--av-kf-live-pulse\)\s+var\(--av-dur-breathe\)/);
    expect(live).toMatch(/var\(--av-ease-standard\)/);
    const idle = ruleBody(pages, '.channelLive[data-live="off"] i');
    expect(idle).toMatch(/animation:\s*none/);
  });

  it("动效开启时时间码每秒递增（只动自己那一张卡）", () => {
    vi.useFakeTimers();
    const { container } = renderMonitor();
    const clock = () => container.querySelector('[data-live="on"] [data-live-clock]')?.textContent ?? "";
    const first = clock();
    expect(first).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    act(() => vi.advanceTimersByTime(3000));
    expect(clock()).not.toBe(first);
  });

  it("?static=1：时间码停在起点不递增，筛选也直接换列表（无中间态）", () => {
    vi.useFakeTimers();
    window.history.pushState({}, "", "/stream-monitor/monitor?static=1");
    const { container } = renderMonitor();
    expect(document.documentElement.getAttribute(AV_MOTION_ATTRIBUTE)).toBe("off");

    const clock = () => container.querySelector('[data-live="on"] [data-live-clock]')?.textContent ?? "";
    const first = clock();
    expect(first).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    act(() => vi.advanceTimersByTime(5000));
    expect(clock()).toBe(first);

    // 静态档不做三段式：点一下立即只剩音频卡，没有 exit 中间态
    fireEvent.click(screen.getByRole("button", { name: /音频/ }));
    expect(container.querySelector("[data-filter-phase]")?.getAttribute("data-filter-phase")).toBe("idle");
    expect(container.querySelectorAll('[data-motion="channel"]')).toHaveLength(7);
    expect(container.querySelectorAll("[data-waveform]")).toHaveLength(7);
  });

  it("时间码格式与起始偏移稳定（不同通道从不同位置开始）", () => {
    expect(formatTimecode(0)).toBe("00:00:00");
    expect(formatTimecode(767)).toBe("00:12:47");
    expect(formatTimecode(37_000)).toBe("10:16:40");
    expect(formatTimecode(Number.NaN)).toBe("00:00:00");

    const { container } = renderMonitor();
    const clocks = Array.from(container.querySelectorAll('[data-live="on"] [data-live-clock]')).map(
      (node) => node.textContent,
    );
    expect(clocks.length).toBeGreaterThanOrEqual(8);
    expect(new Set(clocks).size).toBe(clocks.length);
  });
});

describe("筛选切换：退场 → FLIP 重排 → 错峰入场", () => {
  it("点「音频」先进入 exit（卡片还在），quick 后替换列表并进入 enter", () => {
    vi.useFakeTimers();
    const { container } = renderMonitor();
    const grid = container.querySelector("[data-filter-phase]")!;

    fireEvent.click(screen.getByRole("button", { name: /音频/ }));
    expect(grid.getAttribute("data-filter-phase")).toBe("exit");
    // 退场必须真的先让旧卡片留在画面上（否则就是瞬间替换）
    expect(container.querySelectorAll('[data-motion="channel"]')).toHaveLength(9);

    act(() => vi.advanceTimersByTime(AV_MOTION.quick * 1000 + 1));
    expect(grid.getAttribute("data-filter-phase")).toBe("enter");
    expect(container.querySelectorAll('[data-motion="channel"]')).toHaveLength(7);

    // base + 最后一个错峰之后回到 idle
    act(() => vi.advanceTimersByTime(AV_MOTION.base * 1000 + AV_STAGGER.list * 10 * 1000 + 1));
    expect(grid.getAttribute("data-filter-phase")).toBe("idle");
  });

  it("从「音频」切回「全部」：新出现的视频卡带错峰入场 class", () => {
    vi.useFakeTimers();
    const { container } = renderMonitor();

    fireEvent.click(screen.getByRole("button", { name: /音频/ }));
    act(() => vi.advanceTimersByTime(AV_MOTION.quick * 1000 + 1));
    expect(container.querySelectorAll('[data-motion="channel"]')).toHaveLength(7);

    fireEvent.click(screen.getByRole("button", { name: /全部通道/ }));
    expect(container.querySelector("[data-filter-phase]")?.getAttribute("data-filter-phase")).toBe("exit");
    act(() => vi.advanceTimersByTime(AV_MOTION.quick * 1000 + 1));

    expect(container.querySelectorAll('[data-motion="channel"]')).toHaveLength(9);
    const entering = Array.from(container.querySelectorAll('[data-motion="channel"]')).filter((node) =>
      (node.getAttribute("class") ?? "").includes("channelEnter"),
    );
    // 只有新出现的 2 路视频卡进场；原有音频卡只做 FLIP，不重播入场
    expect(entering).toHaveLength(2);
    for (const card of entering) {
      expect(card.getAttribute("data-kind")).toBe("video");
      // 错峰序号落在 AV_STAGGER.max 以内（45ms 步长）
      const index = Number(card.getAttribute("style")?.match(/--av-i:\s*(\d+)/)?.[1] ?? "-1");
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThanOrEqual(AV_STAGGER.max);
    }
  });

  it("相邻两帧之间状态真的变化（不是「点完就到终态」的假过渡）", () => {
    vi.useFakeTimers();
    const { container } = renderMonitor();
    const snapshot = () => ({
      phase: container.querySelector("[data-filter-phase]")?.getAttribute("data-filter-phase"),
      cards: container.querySelectorAll('[data-motion="channel"]').length,
    });
    const before = snapshot();
    fireEvent.click(screen.getByRole("button", { name: /视频/ }));
    const afterClick = snapshot();
    act(() => vi.advanceTimersByTime(AV_MOTION.quick * 1000 + 1));
    const afterExit = snapshot();

    expect(before).toEqual({ phase: "idle", cards: 9 });
    expect(afterClick).toEqual({ phase: "exit", cards: 9 });
    expect(afterExit).toEqual({ phase: "enter", cards: 2 });
  });
});

describe("AvWaveform 组件本身", () => {
  it("离线态不产生任何动画变量，在线态每根柱子都有延迟", () => {
    const online = render(<AvWaveform seed={1234} values={WAVE} bars={12} />);
    const onlineBars = online.container.querySelectorAll<HTMLElement>("[data-wave-bar]");
    expect(onlineBars).toHaveLength(12);
    for (const bar of Array.from(onlineBars)) {
      expect(bar.style.getPropertyValue("--av-wave-delay")).not.toBe("");
      expect(bar.style.height).toMatch(/%$/);
    }
    cleanup();

    const offline = render(<AvWaveform seed={1234} values={WAVE} bars={12} state="offline" />);
    expect(offline.container.querySelector("[data-waveform]")?.getAttribute("data-state")).toBe("offline");
    for (const bar of Array.from(offline.container.querySelectorAll<HTMLElement>("[data-wave-bar]"))) {
      expect(bar.getAttribute("style") ?? "").not.toContain("--av-wave-delay");
    }
  });
});
