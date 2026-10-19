// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { AvLevelBadge, AvMetric, AvStatusBadge } from "@/components/av/AvUI";
import { Spectrogram } from "@/components/av/pages/AudioView";
import { parseCssColor } from "@/lib/av/color";
import type { Spectrum } from "@/lib/av/types";

/**
 * AC5：深色 / 浅色主题切换下 AV 页面无错色（DOM + canvas 像素覆盖）。
 *
 * 第一层（DOM）：AV 的语义色在 DOM 上只以 `var(--av-*)` 形式出现，主题切换由
 * `globals.css` 替换底层值，组件本身不换样式。
 *
 * 第二层（canvas）：**canvas 是唯一绕过 CSS 变量的地方** —— 频谱图把令牌解析成 RGB
 * 再逐像素写入 ImageData。review 抓到的真实缺陷正是发生在这里：浅色主题下
 * `--av-surface` 的 computed value 是 3 位缩写 `#fff`，旧实现只认 6 位并回落到写死的
 * 深色主题青色，整块频谱变成亮青底。所以这里把 `--av-surface` 设成**真实的浅色
 * computed value**（`#fff`），并断言写入的第 0 个像素是白底而不是青色。
 */
describe("AV 主题与语义色（AC5）", () => {
  afterEach(() => {
    cleanup();
    delete document.documentElement.dataset.theme;
    document.documentElement.removeAttribute("style");
  });

  function badgeIn(theme: "dark" | "light") {
    document.documentElement.dataset.theme = theme;
    return render(
      <div>
        <AvLevelBadge level={1} label="一级·严重" />
        <AvLevelBadge level={3} label="三级·一般" />
        <AvStatusBadge tone="success">已闭环</AvStatusBadge>
        <AvMetric label="今日告警" value="50" unit="条" detail="未处置 59 条" tone="danger" />
      </div>,
    );
  }

  it("深色主题：色块 + 文字双通道，颜色只引用令牌", () => {
    badgeIn("dark");

    const first = screen.getByTitle("告警级别：一级·严重");
    expect(first.getAttribute("data-level")).toBe("1");
    expect(first.textContent).toContain("一级·严重");
    expect(first.querySelector("i")).not.toBeNull();
    expect(first.getAttribute("style")).toContain("var(--av-level-1)");
    expect(first.getAttribute("style")).not.toMatch(/#[0-9a-f]{3,8}/i);

    const third = screen.getByTitle("告警级别：三级·一般");
    expect(third.getAttribute("style")).toContain("var(--av-level-3)");

    const metric = screen.getByText("今日告警").closest("article");
    expect(metric?.getAttribute("style")).toContain("var(--av-tone-danger)");
    expect(metric?.getAttribute("style")).not.toMatch(/#[0-9a-f]{3,8}/i);
  });

  it("浅色主题：同一结构、同一令牌，不换一套写死的颜色", () => {
    badgeIn("light");

    const first = screen.getByTitle("告警级别：一级·严重");
    expect(first.textContent).toContain("一级·严重");
    expect(first.querySelector("i")).not.toBeNull();
    expect(first.getAttribute("style")).toContain("var(--av-level-1)");
    expect(first.getAttribute("style")).not.toMatch(/#[0-9a-f]{3,8}/i);

    const status = screen.getByText("已闭环").closest("span");
    expect(status?.getAttribute("style")).toContain("var(--av-tone-success)");
    expect(document.documentElement.dataset.theme).toBe("light");
  });
});

/** 一份最小的 2×2 频谱：base64 编码的 4 个字节，能量分别是 0 / 255 / 128 / 64。 */
function tinySpectrum(): Spectrum {
  return {
    id: "sp-test",
    alarm_id: "AL-TEST",
    title: "测试频谱",
    profile: "noise",
    bins: 2,
    cols: 2,
    seconds: 1,
    binHz: 100,
    colMs: 500,
    encoding: "uint8-base64",
    note: "测试用",
    data: Buffer.from([0, 255, 128, 64]).toString("base64"),
    waveform: {
      buckets: 2,
      samples_per_bucket: 1,
      encoding: "uint8-base64",
      mid: 128,
      min: Buffer.from([120, 130]).toString("base64"),
      max: Buffer.from([140, 150]).toString("base64"),
    },
    peaks: [],
  };
}

describe("频谱 canvas 取色（AC5 像素级覆盖）", () => {
  const written: Uint8ClampedArray[] = [];

  beforeEach(() => {
    written.length = 0;
    // jsdom 不实现 canvas 2D；这里只截获组件写入的像素，等价于「画出来的颜色」
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => {
      const image = { data: new Uint8ClampedArray(2 * 2 * 4), width: 2, height: 2 } as ImageData;
      return {
        createImageData: () => image,
        putImageData: (data: ImageData) => {
          written.push(new Uint8ClampedArray(data.data));
        },
      } as unknown as CanvasRenderingContext2D;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function renderSpectrogram(signal: string, surface: string) {
    const root = document.documentElement;
    root.style.setProperty("--av-signal", signal);
    root.style.setProperty("--av-surface", surface);
    return render(<Spectrogram spectrum={tinySpectrum()} />);
  }

  it("浅色主题（--av-surface 是 3 位缩写 #fff）下，0 能量像素必须是浅底而不是写死的青色", async () => {
    document.documentElement.dataset.theme = "light";
    renderSpectrogram("#17617d", "#fff");

    await waitFor(() => expect(written.length).toBeGreaterThan(0));
    const pixels = written.at(-1)!;
    // 行序：bin 0 在底部（offset 8..15）。col 0 / bin 0 能量为 0 → 底色
    const lowEnergy = Array.from(pixels.slice(8, 11));
    expect(lowEnergy).toEqual([255, 255, 255]);
    // 关键回归：不能是 DESIGN.md 的 dark-signal #6cf3ff
    expect(lowEnergy).not.toEqual([108, 243, 255]);
  });

  it("深色主题（--av-surface 是 6 位 hex）下，0 能量是深色底、255 能量是信号色", async () => {
    document.documentElement.dataset.theme = "dark";
    renderSpectrogram("#6cf3ff", "#0d1d2c");

    await waitFor(() => expect(written.length).toBeGreaterThan(0));
    const pixels = written.at(-1)!;
    // 底部行 col 0（值 0 → 深色底）
    expect(Array.from(pixels.slice(8, 11))).toEqual([13, 29, 44]);
    // 顶部行 col 0（值 255 → 信号色）
    expect(Array.from(pixels.slice(0, 3))).toEqual([108, 243, 255]);
  });

  it("两级主题解析出的颜色必须不同，等价于「切换主题画面真的变了」", () => {
    expect(parseCssColor("#17617d")).toEqual([23, 97, 125]);
    expect(parseCssColor("#fff")).toEqual([255, 255, 255]);
    expect(parseCssColor("#0d1d2c")).toEqual([13, 29, 44]);
  });
});
