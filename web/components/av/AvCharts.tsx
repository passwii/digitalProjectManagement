"use client";

import { useEffect, useState } from "react";
import { AV_MOTION } from "@/lib/av/motion";
import { useAvMotion } from "./motion/AvMotionProvider";
import { useMotionNow } from "./motion/AvMotion";
import { AvSkeletonSwap } from "./motion/AvCounter";
import motionCss from "./motion/AvMotion.module.css";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ReferenceDot,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useTheme } from "@/components/theme/ThemeProvider";
import type { AvColorTone, AvSeriesIndex } from "@/lib/av/tone";
import { AV_SERIES_INDEXES, isSeriesTone, seriesIndexOf } from "@/lib/av/tone";
import { AV_CHART_HEIGHT } from "@/lib/av/chartHeights";
import s from "./AvCharts.module.css";

/**
 * 图表层：只封装 recharts，不发明第二种图表库（项目已钉 recharts@3）。
 *
 * 颜色从 CSS 令牌在运行时读取：
 *   recharts 需要真实的色值（SVG 的 `stroke` / `fill` 属性不吃 `var()`），
 *   所以这里用 getComputedStyle 读 `--av-*` 的计算值，并在主题切换时重读。
 *   于是「组件里不写颜色字面量」这条约束对图表同样成立，深浅主题也不会画错色。
 *
 * 动效（Stage 3）：统一在这一层接管，页面不需要改。
 *   · 折线用描边动画、柱状从底部生长、饼图从 0 扫过 —— 全部走 recharts 自带的
 *     `animationBegin` / `animationDuration` / `animationEasing`，不自己写补间；
 *   · 时长取 `AV_MOTION.slow`（`avDurationMs`），`?static=1` / 减少动效下
 *     `isAnimationActive` 直接为 false —— 截图必须稳定，同一页连拍 3 次 MD5 一致；
 *   · `animationBegin` 按系列错峰一点点（第二系列晚 80ms 起步），两条线不会
 *     像同一个动画复制的；饼图整体一次扫过。
 *
 * 多色（BLF-1423）：`tones` 接受 `AvTone | AvSeriesTone`（见 lib/av/tone.ts）——
 *   语义色用于「这条线就是某级告警 / 某个状态」，多系列对比用 `series-1..8`，
 *   于是图表不再把 8 条数据挤进 7 个语义色循环。
 */

interface Palette {
  signal: string;
  danger: string;
  warning: string;
  violet: string;
  neutral: string;
  success: string;
  action: string;
  grid: string;
  axis: string;
  surface: string;
  ink: string;
  inkSoft: string;
  /** `series[i]` 对应 `--av-series-${i + 1}`，运行时从令牌读到的真实色值。 */
  series: string[];
}

const TOKEN_MAP: Record<Exclude<keyof Palette, "series">, string> = {
  signal: "--av-signal",
  danger: "--av-danger",
  warning: "--av-warning",
  violet: "--av-violet",
  neutral: "--av-neutral",
  success: "--av-success",
  action: "--av-action",
  grid: "--av-divider-soft",
  axis: "--av-divider",
  surface: "--av-surface",
  ink: "--av-ink",
  inkSoft: "--av-ink-3",
};

export function useAvPalette(): Palette | null {
  /**
   * 依赖 `appliedTheme` 而不是 `resolvedTheme`。
   *
   * 原因：`data-theme` 是 Provider 在自己的 effect 里写的，而 React effect 子先父后 ——
   * 用 `resolvedTheme` 当依赖会在主题还没落盘时就读 `getComputedStyle`，拿到上一套令牌，
   * 图表于是停在旧配色直到刷新（review 抓到的 AC5 失败）。`appliedTheme` 只在
   * `applyTheme()` 之后才变，读到的一定是新主题。
   */
  const { appliedTheme } = useTheme();
  const [palette, setPalette] = useState<Palette | null>(null);

  useEffect(() => {
    const read = () => {
      const styles = getComputedStyle(document.documentElement);
      const next = {} as Palette;
      for (const key of Object.keys(TOKEN_MAP) as Exclude<keyof Palette, "series">[]) {
        next[key] = styles.getPropertyValue(TOKEN_MAP[key]).trim();
      }
      // 系列色单独读：8 条同构令牌没必要在 TOKEN_MAP 里手写 8 行
      next.series = AV_SERIES_INDEXES.map((index) =>
        styles.getPropertyValue(`--av-series-${index}`).trim(),
      );
      setPalette(next);
    };
    read();
    return () => setPalette(null);
  }, [appliedTheme]);

  return palette;
}

function toneColor(palette: Palette, tone: AvColorTone): string {
  if (isSeriesTone(tone)) {
    const index = seriesIndexOf(tone);
    // 令牌缺失时退回信号青，而不是给出空字符串（SVG 会变成黑色、深浅主题都看不清）
    return palette.series[index - 1] || palette.signal;
  }
  return palette[tone];
}

/** 图表系列色（供页面 / 测试引用）：`series-1` … `series-8`。 */
export function seriesTone(index: AvSeriesIndex): AvColorTone {
  return `series-${index}` as const;
}

/**
 * 图表面板：调色板（CSS 令牌）要等首帧 effect 才读得到，所以先渲染**同尺寸骨架**，
 * 读到令牌后再交叉淡入真图（base）—— 不是「先白一下、再突然出现」。
 */
function ChartFrame({
  children,
  height = AV_CHART_HEIGHT.lg,
  label,
}: {
  children?: React.ReactNode;
  height?: number;
  label: string;
}) {
  return (
    <div className={s.frame} style={{ height }} role="img" aria-label={label} data-motion="chart">
      {children ? (
        <AvSkeletonSwap>{children}</AvSkeletonSwap>
      ) : (
        <span className={`${s.framePending} ${motionCss.skeleton}`} aria-hidden="true" />
      )}
    </div>
  );
}

/**
 * recharts 的入场动画参数。
 *
 * `durationMs` 已经按 `?static=1` / reduced 归零，这里不再写第二套 if；
 * `isAnimationActive` 用同一个判定，避免「时长为 0 但仍在跑动画对象」。
 */
function useChartAnimation(begin = 0) {
  /*
   * 用 `useMotionNow`（同步读 `<html data-av-motion>`）而不是上下文里的 enabled：
   * 图表要等调色板 effect 之后才挂载，那时 `?static=1` 已经由内联脚本写在根节点上，
   * 但 Provider 的 state 可能还没跟上 —— 而 recharts 的入场动画**只在挂载瞬间**
   * 读一次 isAnimationActive，晚一帧就晚了（截图会截到画了一半的折线）。
   */
  const enabled = useMotionNow();
  const { durationMs } = useAvMotion();
  return {
    isAnimationActive: enabled,
    animationBegin: begin,
    animationDuration: durationMs("slow"),
    animationEasing: "ease-out" as const,
  };
}

/**
 * 第二条系列相对第一条晚这么多毫秒起步（不是时长，是相位差）。
 * 借用 instant 一档而不是另写一个 80 —— 图表相位差没必要独立成 token，
 * 但也不能出现裸数字（否则「全站无硬编码时长」的守卫会红）。
 */
const CHART_SERIES_OFFSET_MS = AV_MOTION.instant * 1000;

const tooltipStyle = (palette: Palette) => ({
  background: palette.surface,
  border: `1px solid ${palette.axis}`,
  borderRadius: 0,
  color: palette.ink,
  fontSize: 11,
  padding: "6px 8px",
});

/** 24 小时 / 7 日趋势：告警量 + 处置量两条线，同一张图对比。 */
export function AvTrendChart({
  data,
  dataKeys,
  labels,
  tones,
  height = AV_CHART_HEIGHT.lg,
  label,
}: {
  data: Record<string, string | number>[];
  dataKeys: [string, string];
  labels: [string, string];
  tones: [AvColorTone, AvColorTone];
  height?: number;
  label: string;
}) {
  const palette = useAvPalette();
  const first = useChartAnimation();
  const second = useChartAnimation(CHART_SERIES_OFFSET_MS);
  if (!palette) return <ChartFrame height={height} label={label} />;
  return (
    <ChartFrame height={height} label={label}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
          <defs>
            <linearGradient id={`av-fill-${dataKeys[0]}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={toneColor(palette, tones[0])} stopOpacity={0.22} />
              <stop offset="100%" stopColor={toneColor(palette, tones[0])} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke={palette.grid} vertical={false} />
          <XAxis
            dataKey="label"
            tick={{ fill: palette.inkSoft, fontSize: 10 }}
            axisLine={{ stroke: palette.axis }}
            tickLine={false}
            interval="preserveStartEnd"
            minTickGap={18}
          />
          <YAxis
            tick={{ fill: palette.inkSoft, fontSize: 10 }}
            axisLine={false}
            tickLine={false}
            width={44}
            allowDecimals={false}
          />
          <Tooltip contentStyle={tooltipStyle(palette)} cursor={{ stroke: palette.axis }} />
          <Area
            type="monotone"
            dataKey={dataKeys[0]}
            name={labels[0]}
            stroke={toneColor(palette, tones[0])}
            strokeWidth={1.6}
            fill={`url(#av-fill-${dataKeys[0]})`}
            {...first}
            dot={false}
          />
          <Area
            type="monotone"
            dataKey={dataKeys[1]}
            name={labels[1]}
            stroke={toneColor(palette, tones[1])}
            strokeWidth={1.4}
            strokeDasharray="4 4"
            fill="transparent"
            {...second}
            dot={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}

/** 柱状图：7 日告警 / 事件对比，或单系列分布。 */
export function AvBarChart({
  data,
  dataKeys,
  labels,
  tones,
  height = AV_CHART_HEIGHT.lg,
  label,
}: {
  data: Record<string, string | number>[];
  dataKeys: [string, string];
  labels: [string, string];
  tones: [AvColorTone, AvColorTone];
  height?: number;
  label: string;
}) {
  const palette = useAvPalette();
  const first = useChartAnimation();
  const second = useChartAnimation(CHART_SERIES_OFFSET_MS);
  if (!palette) return <ChartFrame height={height} label={label} />;
  return (
    <ChartFrame height={height} label={label}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -18 }} barGap={2}>
          <CartesianGrid stroke={palette.grid} vertical={false} />
          <XAxis
            dataKey="label"
            tick={{ fill: palette.inkSoft, fontSize: 10 }}
            axisLine={{ stroke: palette.axis }}
            tickLine={false}
          />
          <YAxis
            tick={{ fill: palette.inkSoft, fontSize: 10 }}
            axisLine={false}
            tickLine={false}
            width={44}
            allowDecimals={false}
          />
          <Tooltip contentStyle={tooltipStyle(palette)} cursor={{ fill: palette.grid }} />
          <Bar
            dataKey={dataKeys[0]}
            name={labels[0]}
            fill={toneColor(palette, tones[0])}
            {...first}
            maxBarSize={22}
          />
          <Bar
            dataKey={dataKeys[1]}
            name={labels[1]}
            fill={toneColor(palette, tones[1])}
            {...second}
            maxBarSize={22}
          />
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}

export interface DonutDatum {
  label: string;
  value: number;
  tone: AvColorTone;
}

/** 环形占比：场景分布 / 告警分级 / 设备状态。中心文案由调用方给。 */
export function AvDonut({
  data,
  centerValue,
  centerLabel,
  height = AV_CHART_HEIGHT.md,
  label,
}: {
  data: DonutDatum[];
  centerValue: string;
  centerLabel: string;
  height?: number;
  label: string;
}) {
  const palette = useAvPalette();
  const animation = useChartAnimation();
  if (!palette) return <ChartFrame height={height} label={label} />;
  return (
    <div className={s.donutWrap} data-motion="chart">
      <div className={s.donutChart} style={{ height }} role="img" aria-label={label}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              dataKey="value"
              nameKey="label"
              innerRadius="66%"
              outerRadius="92%"
              paddingAngle={1}
              stroke={palette.surface}
              strokeWidth={1}
              {...animation}
            >
              {data.map((item) => (
                <Cell key={item.label} fill={toneColor(palette, item.tone)} />
              ))}
            </Pie>
            <Tooltip contentStyle={tooltipStyle(palette)} />
          </PieChart>
        </ResponsiveContainer>
        <div className={s.donutCenter} aria-hidden="true">
          <strong>{centerValue}</strong>
          <span>{centerLabel}</span>
        </div>
      </div>
    </div>
  );
}

/** 信号强度序列（设备详情）：离线设备的 0 哨兵会被调用方过滤掉。 */
export function AvSignalChart({
  data,
  height = AV_CHART_HEIGHT.sm,
  label,
}: {
  data: { label: string; value: number }[];
  height?: number;
  label: string;
}) {
  const palette = useAvPalette();
  const animation = useChartAnimation();
  if (!palette) return <ChartFrame height={height} label={label} />;
  return (
    <ChartFrame height={height} label={label}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 6, right: 6, bottom: 0, left: -22 }}>
          <CartesianGrid stroke={palette.grid} vertical={false} />
          <XAxis
            dataKey="label"
            tick={{ fill: palette.inkSoft, fontSize: 9 }}
            axisLine={{ stroke: palette.axis }}
            tickLine={false}
            minTickGap={24}
          />
          <YAxis
            tick={{ fill: palette.inkSoft, fontSize: 9 }}
            axisLine={false}
            tickLine={false}
            width={40}
            domain={["dataMin", "dataMax"]}
          />
          <Tooltip contentStyle={tooltipStyle(palette)} />
          <Area
            type="monotone"
            dataKey="value"
            name="RSSI"
            stroke={palette.signal}
            strokeWidth={1.5}
            fill={palette.signal}
            fillOpacity={0.12}
            {...animation}
            dot={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}

/**
 * 一条数据系列：`key` 是 `data` 里的字段名，`tone` 走 `series-1..8` 或语义色。
 *
 * BLF-1424：总览的「告警趋势」要从 2 条线扩到 4 条（告警 / 已处置 / 事件 / 误报），
 * 所以把「多系列」抽成数据驱动的一份配置，而不是在 AvTrendChart 里再写两条 Area。
 */
export interface ChartSeriesSpec {
  key: string;
  label: string;
  tone: AvColorTone;
  /** 面积渐变强度：主系列给面积，对比系列只给描边，4 条都铺面积会糊成一片 */
  fill?: "gradient" | "none";
  dashed?: boolean;
}

interface ChartSeriesProps {
  data: Record<string, string | number>[];
  series: ChartSeriesSpec[];
  height?: number;
  label: string;
  /** 峰值标注：画在主系列的最高点上（`key` 指定对哪条系列取点） */
  peak?: { key: string; label: string; value: number; caption: string };
}

/**
 * 多系列折线 / 面积（总览「告警趋势」）。
 *
 * 每个系列一条独立的渐变 `linearGradient`（id 带系列 key，避免互相覆盖）；
 * 峰值用 `ReferenceDot` 标在最高点，配一条 `caption`（「峰值 11:00 · 11 条」）。
 */
export function AvMultiTrendChart({ data, series, height = AV_CHART_HEIGHT.lg, label, peak }: ChartSeriesProps) {
  const palette = useAvPalette();
  // 只调一次 hook：每个系列只是相位不同（begin 递增），不是各自一套动画参数。
  // 在 map 里调 hook 会违反规则（series 长度可随范围变化），这里显式拆开。
  const animation = useChartAnimation();
  if (!palette) return <ChartFrame height={height} label={label} />;
  const peakTone = peak ? series.find((item) => item.key === peak.key)?.tone ?? series[0].tone : series[0].tone;
  return (
    <ChartFrame height={height} label={label}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 12, right: 8, bottom: 0, left: -18 }}>
          <defs>
            {series.map((item) =>
              item.fill === "gradient" ? (
                <linearGradient key={item.key} id={`av-series-fill-${item.key}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={toneColor(palette, item.tone)} stopOpacity={0.28} />
                  <stop offset="100%" stopColor={toneColor(palette, item.tone)} stopOpacity={0.02} />
                </linearGradient>
              ) : null,
            )}
          </defs>
          <CartesianGrid stroke={palette.grid} vertical={false} />
          <XAxis
            dataKey="label"
            tick={{ fill: palette.inkSoft, fontSize: 10 }}
            axisLine={{ stroke: palette.axis }}
            tickLine={false}
            interval="preserveStartEnd"
            minTickGap={18}
          />
          <YAxis
            tick={{ fill: palette.inkSoft, fontSize: 10 }}
            axisLine={false}
            tickLine={false}
            width={44}
            allowDecimals={false}
          />
          <Tooltip contentStyle={tooltipStyle(palette)} cursor={{ stroke: palette.axis }} />
          {series.map((item, index) => (
            <Area
              key={item.key}
              type="monotone"
              dataKey={item.key}
              name={item.label}
              stroke={toneColor(palette, item.tone)}
              strokeWidth={index === 0 ? 1.8 : 1.4}
              strokeDasharray={item.dashed ? "4 4" : undefined}
              fill={item.fill === "gradient" ? `url(#av-series-fill-${item.key})` : "transparent"}
              {...animation}
              animationBegin={animation.animationBegin + index * CHART_SERIES_OFFSET_MS}
              dot={false}
            />
          ))}
          {peak ? (
            <ReferenceDot
              x={peak.label}
              y={peak.value}
              r={3.5}
              fill={toneColor(palette, peakTone)}
              stroke={palette.surface}
              strokeWidth={1.5}
              ifOverflow="extendDomain"
              label={{
                value: peak.caption,
                position: "top",
                fill: palette.inkSoft,
                fontSize: 10,
              }}
            />
          ) : null}
        </AreaChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}

/**
 * 多系列堆叠柱（总览 7 日档）。
 *
 * 4 条系列叠在一起看「每天各类处置/事件的构成」，比 4 根并排柱子更容易读出总量；
 * `stackId` 相同即堆叠，图例仍由页面给。
 */
export function AvMultiBarChart({ data, series, height = AV_CHART_HEIGHT.lg, label }: ChartSeriesProps) {
  const palette = useAvPalette();
  const animation = useChartAnimation();
  if (!palette) return <ChartFrame height={height} label={label} />;
  return (
    <ChartFrame height={height} label={label}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -18 }} barGap={1}>
          <CartesianGrid stroke={palette.grid} vertical={false} />
          <XAxis
            dataKey="label"
            tick={{ fill: palette.inkSoft, fontSize: 10 }}
            axisLine={{ stroke: palette.axis }}
            tickLine={false}
          />
          <YAxis
            tick={{ fill: palette.inkSoft, fontSize: 10 }}
            axisLine={false}
            tickLine={false}
            width={44}
            allowDecimals={false}
          />
          <Tooltip contentStyle={tooltipStyle(palette)} cursor={{ fill: palette.grid }} />
          {series.map((item, index) => (
            <Bar
              key={item.key}
              dataKey={item.key}
              name={item.label}
              stackId="av-overview"
              fill={toneColor(palette, item.tone)}
              {...animation}
              animationBegin={animation.animationBegin + index * CHART_SERIES_OFFSET_MS}
              maxBarSize={26}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}
