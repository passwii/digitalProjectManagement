import { describe, expect, it } from "vitest";
import {
  LIQUID_DAMPING,
  LIQUID_STEP,
  LIQUID_STIFFNESS,
  LIQUID_STRETCH_MAX,
  liquidAtRest,
  liquidStretchAtRest,
  stepLiquid,
  stepLiquidStretch,
} from "./liquidNavMotion";

/**
 * 方案 B 的位移物理契约。
 *
 * 草稿里定的是「一个液滴、一次很轻的回弹、约 325ms 收住」，这三条是
 * 用户能感知的全部差异：再长就回到“拖尾巴”，再多一次就变成“弹两下”。
 */
const TARGET = 346;
const STEP_MS = LIQUID_STEP * 1000;

function sign(value: number): -1 | 0 | 1 {
  if (value - TARGET > 0.4) return 1;
  if (value - TARGET < -0.4) return -1;
  return 0;
}

function runMove() {
  const body = { x: 0, v: 0 };
  const stretch = { s: 1, v: 0 };
  let ms = 0;
  let peak = 0;
  let peakStretch = 1;
  let side: -1 | 0 | 1 = 0;
  let arrived = false;
  let flips = 0;

  while (ms < 1000) {
    stepLiquid(body, TARGET);
    stepLiquidStretch(stretch, body.v);
    ms += STEP_MS;
    peak = Math.max(peak, body.x);
    peakStretch = Math.max(peakStretch, stretch.s);

    const next = sign(body.x);
    if (next !== 0) {
      if (!arrived) {
        // 第一次越过目标才算“到位”，回弹次数从这之后数。
        arrived = next > 0;
        side = next;
      } else if (next !== side) {
        flips += 1;
        side = next;
      }
    }

    if (liquidAtRest(body, TARGET)) break;
  }

  return { body, stretch, ms, peak, peakStretch, flips };
}

describe("liquidNavMotion：一个液滴的位移", () => {
  it("346px 位移在 325ms 附近落位", () => {
    const { ms } = runMove();

    expect(ms).toBeGreaterThanOrEqual(310);
    expect(ms).toBeLessThanOrEqual(340);
  });

  it("只回弹一次，幅度落在 5%–7%", () => {
    const { peak, flips } = runMove();
    const pct = ((peak - TARGET) / TARGET) * 100;

    expect(flips).toBe(1);
    expect(pct).toBeGreaterThanOrEqual(5);
    expect(pct).toBeLessThanOrEqual(7);
  });

  it("位移过程中横向拉伸不超过 +8%，收尾后回落到 1", () => {
    const { stretch, peakStretch } = runMove();

    expect(peakStretch).toBeGreaterThan(1.05);
    expect(peakStretch).toBeLessThanOrEqual(1 + LIQUID_STRETCH_MAX + 0.02);

    // 拉伸比位移慢半拍：落位后再给它 300ms 收尾（引擎用 busy 继续跑这段）。
    let extra = 0;
    while (!liquidStretchAtRest(stretch) && extra < 300) {
      stepLiquidStretch(stretch, 0);
      extra += STEP_MS;
    }

    expect(extra).toBeLessThan(300);
    expect(liquidStretchAtRest(stretch)).toBe(true);
  });

  it("落位后继续推进不会漂移，也不会越界", () => {
    const { body } = runMove();

    for (let i = 0; i < 480; i += 1) stepLiquid(body, TARGET);

    expect(Math.abs(body.x - TARGET)).toBeLessThanOrEqual(1.3);
    expect(liquidAtRest(body, TARGET)).toBe(true);
  });

  it("弹簧处于欠阻尼区间（否则回弹会消失）", () => {
    const zeta = LIQUID_DAMPING / (2 * Math.sqrt(LIQUID_STIFFNESS));

    expect(zeta).toBeGreaterThan(0.6);
    expect(zeta).toBeLessThan(0.72);
  });
});
