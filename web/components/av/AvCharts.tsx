"use client";

import { useEffect, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useTheme } from "@/components/theme/ThemeProvider";
import type { AvTone } from "@/lib/av/labels";
import s from "./AvCharts.module.css";

/**
 * 图表层：只封装 recharts，不发明第二种图表库（项目已钉 recharts@3）。
 *
 * 颜色从 CSS 令牌在运行时读取：
 *   recharts 需要真实的色值（SVG 的 `stroke` / `fill` 属性不吃 `var()`），
 *   所以这里用 getComputedStyle 读 `--av-*` 的计算值，并在主题切换时重读。
 *   于是「组件里不写颜色字面量」这条约束对图表同样成立，深浅主题也不会画错色。
 *
 * Stage 2 统一 `isAnimationActive={false}`：本 Stage 不做动效，截图必须稳定；
 * Stage 3 会在这一层统一接管入场动画，页面不需要改。
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
}

const TOKEN_MAP: Record<keyof Palette, string> = {
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
      for (const key of Object.keys(TOKEN_MAP) as (keyof Palette)[]) {
        next[key] = styles.getPropertyValue(TOKEN_MAP[key]).trim();
      }
      setPalette(next);
    };
    read();
    return () => setPalette(null);
  }, [appliedTheme]);

  return palette;
}

function toneColor(palette: Palette, tone: AvTone): string {
  return {
    signal: palette.signal,
    danger: palette.danger,
    warning: palette.warning,
    violet: palette.violet,
    neutral: palette.neutral,
    success: palette.success,
    action: palette.action,
  }[tone];
}

function ChartFrame({
  children,
  height = 230,
  label,
}: {
  children?: React.ReactNode;
  height?: number;
  label: string;
}) {
  return (
    <div className={s.frame} style={{ height }} role="img" aria-label={label} data-motion="chart">
      {children ?? <span className={s.framePending} aria-hidden="true" />}
    </div>
  );
}

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
  height = 230,
  label,
}: {
  data: Record<string, string | number>[];
  dataKeys: [string, string];
  labels: [string, string];
  tones: [AvTone, AvTone];
  height?: number;
  label: string;
}) {
  const palette = useAvPalette();
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
            isAnimationActive={false}
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
            isAnimationActive={false}
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
  height = 210,
  label,
}: {
  data: Record<string, string | number>[];
  dataKeys: [string, string];
  labels: [string, string];
  tones: [AvTone, AvTone];
  height?: number;
  label: string;
}) {
  const palette = useAvPalette();
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
            isAnimationActive={false}
            maxBarSize={22}
          />
          <Bar
            dataKey={dataKeys[1]}
            name={labels[1]}
            fill={toneColor(palette, tones[1])}
            isAnimationActive={false}
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
  tone: AvTone;
}

/** 环形占比：场景分布 / 告警分级 / 设备状态。中心文案由调用方给。 */
export function AvDonut({
  data,
  centerValue,
  centerLabel,
  height = 190,
  label,
}: {
  data: DonutDatum[];
  centerValue: string;
  centerLabel: string;
  height?: number;
  label: string;
}) {
  const palette = useAvPalette();
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
              isAnimationActive={false}
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
  height = 150,
  label,
}: {
  data: { label: string; value: number }[];
  height?: number;
  label: string;
}) {
  const palette = useAvPalette();
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
            isAnimationActive={false}
            dot={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}
