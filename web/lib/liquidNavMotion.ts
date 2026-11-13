/**
 * 居中药丸高亮的位移物理（方案 B）。
 *
 * 一个液滴、一次很轻的回弹：位置是单体弹簧，固定 1/240 子步积分，
 * 60Hz 和 120Hz 上落位时间一致；横向拉伸只是位移速度的副产品，
 * 到位后回落到 1，不再生成拖尾 / 分裂小滴 / 落点涟漪。
 *
 * 参数来自草稿 tools 定稿（docs/prototypes/navbar-motion）：
 *   · 346px 位移约 325ms 落位、唯一一次约 6% 回弹；
 *   · 更硬的弹簧或更松的阻尼都会把回弹变成“弹两下”。
 */
export interface LiquidBody {
  x: number;
  v: number;
}

export interface LiquidStretch {
  s: number;
  v: number;
}

/** 固定积分步长：物理与帧率解耦（rAF 再快也只按这个步长推进）。 */
export const LIQUID_STEP = 1 / 240;

/** 单体弹簧：k=560、c=31（ζ≈0.66），对应约 325ms 落位、6% 回弹。 */
export const LIQUID_STIFFNESS = 560;
export const LIQUID_DAMPING = 31;

/** 视觉上“停住”的阈值（1.2px / 22px·s⁻¹），比真实静止早一点，避免尾段拖时间。 */
export const LIQUID_REST_DISTANCE = 1.2;
export const LIQUID_REST_SPEED = 22;

/** 位移速度快时的横向拉伸：最多 +8%，到位后回落到 1。 */
export const LIQUID_STRETCH_MAX = 0.08;
export const LIQUID_STRETCH_STIFFNESS = 340;
export const LIQUID_STRETCH_DAMPING = 30;
export const LIQUID_SPEED_REFERENCE = 1400;

/** 推进一个子步：半隐式欧拉，和引擎里的顺序一致。 */
export function stepLiquid(body: LiquidBody, target: number, step = LIQUID_STEP): void {
  body.v += (LIQUID_STIFFNESS * (target - body.x) - LIQUID_DAMPING * body.v) * step;
  body.x += body.v * step;
}

/** 位移是否已经肉眼停住（引擎据此停 rAF）。 */
export function liquidAtRest(body: LiquidBody, target: number): boolean {
  return Math.abs(target - body.x) <= LIQUID_REST_DISTANCE
    && Math.abs(body.v) <= LIQUID_REST_SPEED;
}

/** 推进一个子步的横向拉伸：目标是速度的函数，阻尼略大于临界，收得干净。 */
export function stepLiquidStretch(
  stretch: LiquidStretch,
  speed: number,
  step = LIQUID_STEP,
): void {
  const goal = 1 + Math.min(Math.abs(speed) / LIQUID_SPEED_REFERENCE, 1) * LIQUID_STRETCH_MAX;
  stretch.v +=
    (LIQUID_STRETCH_STIFFNESS * (goal - stretch.s) - LIQUID_STRETCH_DAMPING * stretch.v) * step;
  stretch.s += stretch.v * step;
}

/** 拉伸是否已经回到 1（引擎据此停 rAF）。 */
export function liquidStretchAtRest(stretch: LiquidStretch): boolean {
  return Math.abs(stretch.s - 1) < 0.004 && Math.abs(stretch.v) < 0.05;
}
