/**
 * 百分数坐标轴的口径（在线率 / 成功率 / 占比）。
 *
 * 为什么单独一个模块：`/device` 的「站点在线率」第二轴与「近 24 小时在线率趋势」
 * 是同一类轴，但一个在 `AvCharts.tsx` 里算、一个在 `lib/av/deviceStream.ts` 里算 ——
 * 两份各写一遍就会漂移（一边 85/90/95/100，另一边被 recharts 凑成 89/93/97）。
 * 这里只做两件事：**贴着数据取下界**、**按固定步长给刻度**。
 *
 * 两条约定：
 *   · 下界不取 0（90.8–100 这段从 0 起会把三条线挤成一条直线），也不取数据最小值
 *     （最小值贴边会被裁掉一半的圆点），而是 `floor((min - 2) / 5) * 5`；
 *   · 上界固定 100 —— 这几张图都是「比率」，100% 是读者的参照线。
 */

/** 下界留白（百分点）：够放下末端圆点，又不至于把曲线压平。 */
const FLOOR_PADDING = 2;

/** 刻度步长的候选：保证刻度落在 5 个位置以内，同时步长都是好读的整数。 */
const TICK_STEPS = [5, 10, 20, 25] as const;
/** 一个轴上最多容忍的正整数分隔（= 最多 5 个刻度位置）。 */
const MAX_INTERVALS = 4;

export function percentDomain(values: number[]): [number, number] {
  const finite = values.filter((value) => Number.isFinite(value));
  const min = finite.length > 0 ? Math.min(...finite) : 0;
  const floor = Math.floor((min - FLOOR_PADDING) / 5) * 5;
  return [Math.min(Math.max(floor, 0), 100), 100];
}

export function percentTicks(domain: [number, number]): number[] {
  const [min, max] = domain;
  const span = Math.max(0, max - min);
  const step = TICK_STEPS.find((candidate) => span / candidate <= MAX_INTERVALS) ?? 25;
  const ticks: number[] = [];
  for (let value = min; value <= max; value += step) ticks.push(value);
  if (ticks[ticks.length - 1] !== max) ticks.push(max);
  return ticks;
}
