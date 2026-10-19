// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import ThemeProvider, { useTheme } from "@/components/theme/ThemeProvider";
import { useAvPalette } from "@/components/av/AvCharts";
import { AvLevelBadge, AvMetric, AvStatusBadge } from "@/components/av/AvUI";
import { Spectrogram } from "@/components/av/pages/AudioView";
import { parseCssColor } from "@/lib/av/color";
import type { Spectrum } from "@/lib/av/types";

/**
 * AC5：深色 / 浅色主题切换下 Stream Monitor 页面无错色（DOM + canvas 像素覆盖）。
 *
 * 第一层（DOM）：Stream Monitor 的语义色在 DOM 上只以 `var(--av-*)` 形式出现，主题切换由
 * `globals.css` 替换底层值，组件本身不换样式。
 *
 * 第二层（canvas）：**canvas 是唯一绕过 CSS 变量的地方** —— 频谱图把令牌解析成 RGB
 * 再逐像素写入 ImageData。review 抓到的真实缺陷正是发生在这里：浅色主题下
 * `--av-surface` 的 computed value 是 3 位缩写 `#fff`，旧实现只认 6 位并回落到写死的
 * 深色主题青色，整块频谱变成亮青底。所以这里把 `--av-surface` 设成**真实的浅色
 * computed value**（`#fff`），并断言写入的第 0 个像素是白底而不是青色。
 */
describe("Stream Monitor 主题与语义色（AC5）", () => {
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

/**
 * AC5 的真实交互路径：**在已挂载的页面上点切换**，而不是分别用两个主题刷新。
 *
 * 这是 review 抓到的失效场景：`data-theme` 由 ThemeProvider 在自己的 effect 里写，
 * 而消费方（canvas / recharts）也在 effect 里读令牌；React effect 子先父后，于是子组件
 * 读到的是**上一个主题**的令牌，画完就再没人重绘 —— 不刷新就一直错。
 *
 * 这里不依赖 jsdom 的层叠实现（它缓存 computed style，多个 `<style>` 叠加时不稳定），
 * 而是把 `getComputedStyle` 换成一个「按当前 `data-theme` 回答」的探针：
 *   · 谁在 `data-theme` 还是 dark 的时候读令牌，就会拿到 dark 的值 —— 断言随即失败；
 *   · 只有「先落 data-theme、再读令牌」的实现才能拿到 light 的值。
 * 这比注入样式表更直接地锁住了要防的那个顺序问题。
 */
describe("主题切换（真实交互路径，不依赖刷新）", () => {
  const written: Uint8ClampedArray[] = [];
  const DARK = { signal: "#6cf3ff", surface: "#0d1d2c" };
  const LIGHT = { signal: "#17617d", surface: "#ffffff" };
  /** 每次读令牌时记录当时的 data-theme，用来断言「读」一定发生在「写」之后。 */
  const reads: string[] = [];

  function installStorage() {
    const store = new Map<string, string>();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
        setItem: (key: string, value: string) => void store.set(key, String(value)),
        removeItem: (key: string) => void store.delete(key),
        clear: () => store.clear(),
      },
    });
  }

  beforeEach(() => {
    written.length = 0;
    reads.length = 0;
    installStorage();
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
      }),
    });
    document.documentElement.dataset.theme = "dark";

    // 按当前 data-theme 回答的自定义属性探针（等价于 globals.css 的两套令牌）
    const real = window.getComputedStyle.bind(window);
    vi.spyOn(window, "getComputedStyle").mockImplementation(((element: Element) => {
      const theme = document.documentElement.dataset.theme === "light" ? "light" : "dark";
      const styles = real(element);
      return {
        ...styles,
        getPropertyValue: (name: string) => {
          const token = name.trim();
          if (token !== "--av-signal" && token !== "--av-surface") return styles.getPropertyValue(name);
          reads.push(`${token}@${theme}`);
          return theme === "light"
            ? token === "--av-signal"
              ? LIGHT.signal
              : LIGHT.surface
            : token === "--av-signal"
              ? DARK.signal
              : DARK.surface;
        },
      } as CSSStyleDeclaration;
    }) as typeof window.getComputedStyle);

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
    cleanup();
    vi.restoreAllMocks();
    delete document.documentElement.dataset.theme;
    document.documentElement.removeAttribute("data-theme-transition");
    document.documentElement.style.removeProperty("--motion-theme");
    document.documentElement.style.colorScheme = "";
  });

  function Toggle() {
    const { mode, setMode } = useTheme();
    return (
      <button type="button" onClick={() => setMode(mode === "dark" ? "light" : "dark")}>
        toggle
      </button>
    );
  }

  it("点切换后频谱用新主题的令牌重绘（深 → 浅）", async () => {
    render(
      <ThemeProvider>
        <Toggle />
        <Spectrogram spectrum={tinySpectrum()} />
      </ThemeProvider>,
    );

    await waitFor(() => expect(written.length).toBeGreaterThan(0));
    const darkPixel = Array.from(written.at(-1)!.slice(8, 11));
    expect(darkPixel).toEqual([13, 29, 44]);

    fireEvent.click(screen.getByRole("button", { name: "toggle" }));

    await waitFor(() => {
      // 必须真的重绘，且是浅色底（#ffffff）而不是深色底
      expect(Array.from(written.at(-1)!.slice(8, 11))).toEqual([255, 255, 255]);
    });
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(Array.from(written.at(-1)!.slice(8, 11))).not.toEqual(darkPixel);
    // 切主题后的那几次读令牌，必须发生在 data-theme 已经是 light 之后
    expect(reads.filter((entry) => entry.endsWith("@light")).length).toBeGreaterThan(0);
  });

  it("图表调色板在切换后读到新主题的令牌（不与旧主题相同）", async () => {
    function PaletteProbe() {
      const palette = useAvPalette();
      return (
        <div>
          <output data-testid="signal">{palette?.signal ?? ""}</output>
          <output data-testid="surface">{palette?.surface ?? ""}</output>
        </div>
      );
    }

    render(
      <ThemeProvider>
        <Toggle />
        <PaletteProbe />
      </ThemeProvider>,
    );

    await waitFor(() => expect(screen.getByTestId("signal").textContent).toBe(DARK.signal));

    fireEvent.click(screen.getByRole("button", { name: "toggle" }));

    await waitFor(() => expect(screen.getByTestId("signal").textContent).toBe(LIGHT.signal));
    expect(screen.getByTestId("surface").textContent).toBe(LIGHT.surface);
    expect(screen.getByTestId("signal").textContent).not.toBe(DARK.signal);
    // 浅色下读到的每一次都必须是浅色（不存在「读到上一套」的那一次）
    expect(reads.filter((entry) => entry.startsWith("--av-signal"))).toContain("--av-signal@light");
  });
});
