/**
 * 智能音视频平台的 tone / series → CSS 变量映射。
 *
 * 单独一个模块（而不是放在 AvUI.tsx 里）的原因：AvUI 是客户端组件（动效要 hooks），
 * 而服务端页面（capability / __stress / audio 空态）也要调 `toneVar()` 生成 style。
 * 从 "use client" 模块里 import 函数到服务端组件会在渲染期报错，
 * 所以这个纯函数留在 lib 里，服务端与客户端都能直接 import。
 *
 * 两套色：
 *   · **语义 tone**（signal / action / danger / warning / violet / neutral / success）
 *     → `--av-tone-*`。状态徽标、告警级别、KPI 色条走这一套，语义固定。
 *   · **数据系列 series**（1..8：青 / 蓝 / 紫 / 品红 / 珊瑚 / 琥珀 / 柠檬 / 水绿）
 *     → `--av-series-*`（BLF-1423）。多系列图表按系列取色，不再把 8 条线挤进
 *     7 个语义色里循环 —— 那样「珊瑚 = 一级告警 = series-5」会两套语义打架。
 *   两者都属于「引用令牌」，组件里仍然不出现任何色值；深浅主题由 globals.css 里的
 *   别名层各自映射。
 */
import type { AvTone } from "./labels";

export function toneVar(tone: AvTone): string {
  return `var(--av-tone-${tone})`;
}

/** 数据系列序号（1..8），与 globals.css 的 `--av-series-1..8` 一一对应。 */
export const AV_SERIES_INDEXES = [1, 2, 3, 4, 5, 6, 7, 8] as const;

export type AvSeriesIndex = (typeof AV_SERIES_INDEXES)[number];

/** 系列色的 tone 写法：`"series-1"` … `"series-8"`。 */
export type AvSeriesTone = `series-${AvSeriesIndex}`;

/** `AvTone | AvSeriesTone`：图表 / 图例凡是要「一个颜色」的地方都用这个类型。 */
export type AvColorTone = AvTone | AvSeriesTone;

/** 系列色的 CSS 变量引用（组件里写 `style={{ "--s": seriesVar(3) }}`）。 */
export function seriesVar(index: AvSeriesIndex): string {
  return `var(--av-series-${index})`;
}

/** 全部系列色，按 1..8 顺序；图表需要「循环取色」时直接用这个数组。 */
export const AV_SERIES_TONES: readonly AvSeriesTone[] = AV_SERIES_INDEXES.map(
  (index) => `series-${index}` as AvSeriesTone,
);

export function isSeriesTone(tone: AvColorTone): tone is AvSeriesTone {
  return tone.startsWith("series-");
}

/** `"series-3"` → 3；非系列色抛错（调用方都先过了 `isSeriesTone`）。 */
export function seriesIndexOf(tone: AvSeriesTone): AvSeriesIndex {
  const index = Number(tone.slice("series-".length));
  if (!AV_SERIES_INDEXES.includes(index as AvSeriesIndex)) {
    throw new Error(`未知的数据系列色：${tone}`);
  }
  return index as AvSeriesIndex;
}

/** 任意颜色 tone → CSS 变量引用。语义色与系列色走同一个入口，调用方不必分支。 */
export function colorVar(tone: AvColorTone): string {
  return isSeriesTone(tone) ? seriesVar(seriesIndexOf(tone)) : toneVar(tone);
}

/** 按序号循环取系列色：第 n 条数据用 `AV_SERIES_TONES[n % 8]`。 */
export function seriesToneFor(index: number): AvSeriesTone {
  const length = AV_SERIES_TONES.length;
  const normalized = Number.isFinite(index) ? Math.abs(Math.trunc(index)) : 0;
  return AV_SERIES_TONES[normalized % length];
}
