import { describe, expect, it } from "vitest";
import {
  PULL_MAX,
  PULL_THRESHOLD,
  clampPull,
  shouldTriggerRefresh,
} from "@/components/mobile/PullToRefresh";

/**
 * 下拉刷新的契约测试（BLF-1127/S6，契约 §6「overscroll」行 + 原型 ptr 段）。
 *
 * 手势状态机（touch/mouse 接管、到顶判定）活在组件里，走查脚本在真浏览器里验；
 * 这里只钉两条纯函数契约：越线阈值与跟手钳位 —— 改阈值必须先改这里
 *（与走查脚本里的 PULL_PX 成对）。
 *
 * 文件放在 lib/ 而不是组件旁边：vitest 的 include 只收 `lib/*.vitest.test.*`
 *（见 vitest.config.ts 的命名约定），放别处会被静默忽略。
 */

describe("下拉阈值（§6 / 原型 ptr 段）", () => {
  it("阈值 = 56px（与原型一致）", () => {
    expect(PULL_THRESHOLD).toBe(56);
  });

  it("不到线松手不刷新，到线才刷新", () => {
    expect(shouldTriggerRefresh(PULL_THRESHOLD - 1)).toBe(false);
    expect(shouldTriggerRefresh(PULL_THRESHOLD)).toBe(true);
    expect(shouldTriggerRefresh(PULL_THRESHOLD + 40)).toBe(true);
  });
});

describe("跟手钳位", () => {
  it("跟手上限 = 96px，内容不会被整块拽走", () => {
    expect(PULL_MAX).toBe(96);
    expect(clampPull(200)).toBe(96);
  });

  it("负值与零归零（中途改成上滑直接复位）", () => {
    expect(clampPull(0)).toBe(0);
    expect(clampPull(-30)).toBe(0);
  });

  it("线内如实跟手", () => {
    expect(clampPull(30)).toBe(30);
  });
});
