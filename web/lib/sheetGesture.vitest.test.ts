import { describe, expect, it } from "vitest";
import {
  DRAG_KEEP_VISIBLE,
  DRAG_SLOP,
  SWIPE_DOWN,
  SWIPE_UP,
  clampDragOffset,
  resolveDragOutcome,
} from "./sheetGesture";

/**
 * 抽屉手势的契约测试（BLF-1127 §4 + 决策 D2）。
 *
 * 阈值（96 / 56）是设计文档里的数字，手感调优不该悄悄改掉它们；
 * 用纯函数钉住后，改阈值就会红在这条测试上，而不是等人在真机上「感觉不对」。
 *
 * 同一对数字在真机走查里再钉一次（`scripts/acceptance_blf1127_mobile.py` 的
 * `SWIPE_DOWN` / `SWIPE_UP`）：这里管「判定」，那里管「手势真的接上了没」。
 */

describe("手势阈值（§4）", () => {
  it("下甩 96px / 上拖 56px，与契约同值", () => {
    expect(SWIPE_DOWN).toBe(96);
    expect(SWIPE_UP).toBe(56);
  });
});

describe("松手落档（§4 / D2）", () => {
  it("下甩超过 96px：peek 关闭（不降档，直接收）", () => {
    expect(resolveDragOutcome("peek", SWIPE_DOWN + 1)).toEqual({
      kind: "close",
    });
  });

  it("下甩超过 96px：half / full 各降一档（逐档降，不跳档）", () => {
    expect(resolveDragOutcome("half", 120)).toEqual({
      kind: "stop",
      stop: "peek",
    });
    expect(resolveDragOutcome("full", 120)).toEqual({
      kind: "stop",
      stop: "half",
    });
  });

  it("上拖超过 56px：peek → half → full", () => {
    expect(resolveDragOutcome("peek", -(SWIPE_UP + 1))).toEqual({
      kind: "stop",
      stop: "half",
    });
    expect(resolveDragOutcome("half", -120)).toEqual({
      kind: "stop",
      stop: "full",
    });
  });

  it("已经到 full：继续上拖不动档（不越界、不回到 peek）", () => {
    expect(resolveDragOutcome("full", -400)).toEqual({ kind: "none" });
  });

  it("阈值刚好命中不算：96 / -56 是边界外", () => {
    expect(resolveDragOutcome("peek", SWIPE_DOWN)).toEqual({ kind: "none" });
    expect(resolveDragOutcome("peek", -SWIPE_UP)).toEqual({ kind: "none" });
  });

  it("位移在阈值内（含手抖）：保持原档，不关闭", () => {
    expect(resolveDragOutcome("half", 0)).toEqual({ kind: "none" });
    expect(resolveDragOutcome("half", 40)).toEqual({ kind: "none" });
    expect(resolveDragOutcome("half", -30)).toEqual({ kind: "none" });
    expect(resolveDragOutcome("half", DRAG_SLOP)).toEqual({ kind: "none" });
  });
});

describe("拖拽位移上限", () => {
  it("下拖原样透传（关闭时本来就要滑出屏）", () => {
    expect(clampDragOffset(320, 500)).toBe(320);
  });

  it("上拖封顶：面板至少留 80px 可抓", () => {
    expect(clampDragOffset(-100, 500)).toBe(-100);
    expect(clampDragOffset(-9999, 500)).toBe(-(500 - DRAG_KEEP_VISIBLE));
  });
});
