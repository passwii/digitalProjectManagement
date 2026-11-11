import { describe, expect, it } from "vitest";
import {
  DESKTOP_TUNNEL,
  DRAG_PROGRESS_PER_PIXEL,
  END_FADE_SPAN,
  END_THRESHOLD,
  MOBILE_TUNNEL,
  SCROLL_PROGRESS_PER_PIXEL,
  STATIC_FRAME_PROGRESS,
  TUNNEL_CARD_COUNT,
  TUNNEL_CARD_SPAN,
  WELCOME_CARDS,
  cardLayout,
  cardLocalProgress,
  cardOpacity,
  cardOpacityAt,
  cardWindow,
  clampProgress,
  endStateOffsetY,
  endStateOpacity,
  heroFrame,
  isEndStateActive,
  progressFromDrag,
  progressFromScroll,
  scrollCueOpacity,
  tunnelDepth,
} from "./welcomeTunnel";

describe("欢迎页能力卡片", () => {
  it("九张卡片的文案与已确认草稿一致", () => {
    expect(TUNNEL_CARD_COUNT).toBe(9);
    expect(WELCOME_CARDS).toHaveLength(9);
    expect(WELCOME_CARDS.map((card) => [card.title, card.description])).toEqual([
      ["统一台账", "项目与客户关系对齐"],
      ["进度留痕", "每个里程碑可追溯"],
      ["支出归集", "成本与预算同一条线"],
      ["审批协同", "决策不脱离业务现场"],
      ["交付复盘", "把经验留在项目里"],
      ["通讯录", "角色与职责清晰可见"],
      ["项目报表", "进度、成本、交付同屏"],
      ["云电竞平台", "独立站点 · 新窗口"],
      ["智能音视频", "独立站点 · 新窗口"],
    ]);
  });

  it("序号与分类标签连续且唯一", () => {
    expect(WELCOME_CARDS.map((card) => card.order)).toEqual([
      "01", "02", "03", "04", "05", "06", "07", "08", "09",
    ]);
    expect(WELCOME_CARDS.map((card) => card.tag)).toEqual([
      "台账", "进度", "成本", "审批", "复盘", "协同", "报表", "站点", "站点",
    ]);
    expect(new Set(WELCOME_CARDS.map((card) => card.id)).size).toBe(WELCOME_CARDS.length);
  });
});

describe("进度轴与分段", () => {
  it("把任意输入夹到 0..1，非有限值落回 0", () => {
    expect(clampProgress(-1)).toBe(0);
    expect(clampProgress(2)).toBe(1);
    expect(clampProgress(0.37)).toBe(0.37);
    expect(clampProgress(Number.NaN)).toBe(0);
    expect(clampProgress(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it("滚轮 / 拖动按固定系数累加进度，并在边界截断", () => {
    expect(progressFromScroll(0, 100)).toBeCloseTo(100 * SCROLL_PROGRESS_PER_PIXEL, 10);
    expect(progressFromScroll(0.99, 10_000)).toBe(1);
    expect(progressFromScroll(0.01, -10_000)).toBe(0);
    expect(progressFromDrag(0, 100)).toBeCloseTo(100 * DRAG_PROGRESS_PER_PIXEL, 10);
    expect(progressFromDrag(0.5, Number.NaN)).toBe(0.5);
  });

  it("九张卡片的窗口依次后移、等宽、且在进度轴内", () => {
    const windows = WELCOME_CARDS.map((_, index) => cardWindow(index));
    windows.forEach((window, index) => {
      expect(window.end - window.start).toBeCloseTo(TUNNEL_CARD_SPAN, 10);
      expect(window.start).toBeGreaterThanOrEqual(0);
      expect(window.end).toBeLessThanOrEqual(1);
      if (index > 0) expect(window.start).toBeGreaterThan(windows[index - 1].start);
    });
    // 最后一张卡片的窗口终点必须留在 1 以内，终点状态才不会被它挤掉
    expect(windows[windows.length - 1].end).toBeLessThanOrEqual(1);
  });

  it("局部进度在自己的窗口里从 0 走到 1", () => {
    const { start, end } = cardWindow(3);
    expect(cardLocalProgress(start, 3)).toBe(0);
    expect(cardLocalProgress(end, 3)).toBe(1);
    expect(cardLocalProgress(start - 0.2, 3)).toBe(0);
    expect(cardLocalProgress(end + 0.2, 3)).toBe(1);
    expect(cardLocalProgress((start + end) / 2, 3)).toBeCloseTo(0.5, 10);
  });

  it("越界索引被夹到首尾卡片，不会产生 NaN 窗口", () => {
    expect(cardWindow(-5)).toEqual(cardWindow(0));
    expect(cardWindow(99)).toEqual(cardWindow(WELCOME_CARDS.length - 1));
  });

  it("卡片透明度：淡入 → 满显 → 淡出", () => {
    expect(cardOpacity(0)).toBe(0);
    expect(cardOpacity(0.09)).toBeCloseTo(0.5, 10);
    expect(cardOpacity(0.5)).toBe(1);
    expect(cardOpacity(0.91)).toBeCloseTo(0.5, 10);
    expect(cardOpacity(1)).toBe(0);
  });
});

describe("终点阈值", () => {
  it("阈值是 0.86", () => {
    expect(END_THRESHOLD).toBe(0.86);
  });

  it("未到阈值不显示终点，刚过阈值开始淡入，之后完全显示", () => {
    expect(endStateOpacity(0)).toBe(0);
    expect(endStateOpacity(END_THRESHOLD - 0.001)).toBe(0);
    expect(endStateOpacity(END_THRESHOLD)).toBe(0);
    expect(endStateOpacity(END_THRESHOLD + END_FADE_SPAN / 2)).toBeCloseTo(0.5, 10);
    expect(endStateOpacity(END_THRESHOLD + END_FADE_SPAN)).toBe(1);
    expect(endStateOpacity(1)).toBe(1);
  });

  it("isEndStateActive 在阈值上切换，并能接住越界输入", () => {
    expect(isEndStateActive(END_THRESHOLD - 0.0001)).toBe(false);
    expect(isEndStateActive(END_THRESHOLD)).toBe(true);
    expect(isEndStateActive(1)).toBe(true);
    expect(isEndStateActive(-1)).toBe(false);
    expect(isEndStateActive(Number.NaN)).toBe(false);
  });

  it("终点出现后隧道卡片退场，避免文字压在高位卡片上", () => {
    const p = END_THRESHOLD + END_FADE_SPAN;
    for (let index = 0; index < WELCOME_CARDS.length; index += 1) {
      expect(cardOpacityAt(p, index)).toBe(0);
    }
    expect(cardOpacityAt(0.4, 0)).toBeGreaterThan(0);
  });

  it("终点从下往上落位，位移随淡入收敛到 0", () => {
    expect(endStateOffsetY(0)).toBe(12);
    expect(endStateOffsetY(1)).toBe(0);
  });
});

describe("首屏标题与滚动提示", () => {
  it("标题随进度放大并在中段淡出", () => {
    expect(heroFrame(0).scale).toBeCloseTo(0.82, 10);
    expect(heroFrame(0).opacity).toBe(1);
    // 标题在 0.3 之前完全不透明，之后在 0.52 处让位给隧道卡片
    expect(heroFrame(0.3).opacity).toBe(1);
    expect(heroFrame(0.5).scale).toBeCloseTo(1.1, 10);
    expect(heroFrame(0.5).opacity).toBeCloseTo((0.52 - 0.5) / 0.22, 10);
    expect(heroFrame(0.52).opacity).toBe(0);
    expect(heroFrame(1).opacity).toBe(0);
    expect(heroFrame(1).scale).toBeGreaterThan(heroFrame(0.5).scale);
  });

  it("滚动提示只在开头出现", () => {
    expect(scrollCueOpacity(0)).toBe(1);
    expect(scrollCueOpacity(0.11)).toBe(1);
    expect(scrollCueOpacity(0.12)).toBe(0);
    expect(scrollCueOpacity(1)).toBe(0);
  });
});

describe("空间布局", () => {
  it("卡片纵深从桌面 / 手机各自的远端走到近端", () => {
    expect(tunnelDepth(0, false)).toBe(DESKTOP_TUNNEL.farZ);
    expect(tunnelDepth(1, false)).toBe(DESKTOP_TUNNEL.nearZ);
    expect(tunnelDepth(0, true)).toBe(MOBILE_TUNNEL.farZ);
    expect(tunnelDepth(1, true)).toBe(MOBILE_TUNNEL.nearZ);
    expect(tunnelDepth(0.5, false)).toBeGreaterThan(DESKTOP_TUNNEL.farZ);
  });

  it("卡片基准位置沿用草稿的黄金角散开，且不飞出可视区", () => {
    const layouts = WELCOME_CARDS.map((_, index) => cardLayout(index));
    // 首张卡片在正右方：cos(0) * 0.28 * 100vw
    expect(layouts[0].baseXvw).toBeCloseTo(28, 10);
    expect(layouts[0].baseYvh).toBeCloseTo(0, 10);
    layouts.forEach((layout) => {
      // 卡片宽度最多 18vw：|x| + 9vw 仍需留在半屏 50vw 附近
      expect(Math.abs(layout.baseXvw)).toBeLessThanOrEqual(42);
      expect(Math.abs(layout.baseYvh)).toBeLessThanOrEqual(35);
      expect(Math.abs(layout.rotation)).toBeGreaterThanOrEqual(3);
      expect(Number.isFinite(layout.angle)).toBe(true);
    });
    // 散开而不是叠在一起：横向位置两两不同
    expect(new Set(layouts.map((layout) => layout.baseXvw.toFixed(3))).size).toBe(WELCOME_CARDS.length);
  });

  it("静态中间帧落在 0..1 内且不会直接触发终点", () => {
    expect(STATIC_FRAME_PROGRESS).toBeGreaterThan(0);
    expect(STATIC_FRAME_PROGRESS).toBeLessThan(END_THRESHOLD);
    expect(isEndStateActive(STATIC_FRAME_PROGRESS)).toBe(false);
  });
});
