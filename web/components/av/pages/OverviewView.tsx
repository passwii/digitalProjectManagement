"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { OverviewProps } from "@/lib/av/contracts";
import type { OverviewRangeKey } from "@/lib/av/types";
import { OVERVIEW_TREND_SERIES, overviewRangeAtTick, type OverviewRangeModel } from "@/lib/av/view";
import { AvBar, AvLegend, AvMetric, AvPageHeader, AvPanel, AvLevelBadge } from "@/components/av/AvUI";
import { toneVar } from "@/lib/av/tone";
import { AV_CHART_HEIGHT } from "@/lib/av/chartHeights";
import {
  AvDonut,
  AvMultiBarChart,
  AvMultiTrendChart,
  type DonutDatum,
} from "@/components/av/AvCharts";
import { formatCount, formatGb, formatPercent, formatStorage } from "@/lib/av/labels";
import { toRelative } from "@/lib/av/time";
import { useAvMotion } from "@/components/av/motion/AvMotionProvider";
import { AvPanelReveal, useStaggerIndex } from "@/components/av/motion/AvMotion";
import AvCounter from "@/components/av/motion/AvCounter";
import ui from "@/components/av/AvUI.module.css";
import AvTabs from "@/components/av/AvTabs";
import s from "./AvPages.module.css";

/** 首屏一次性揭示的告警流条数（与 useState 的初值同一个数）。 */
const INITIAL_STREAM_COUNT = 4;

/**
 * KPI 数字的样式类（来自 AvUI.module.css）。
 *
 * 必须显式传给 `AvCounter`：`.metricValue span` 那条规则是给**单位**用的
 * （11px + 弱色），计数器渲染的 span 若不带这个类会被它命中，数字变成小号灰字。
 */
const metricNumberClass = ui.metricNumber;

export default function OverviewView(props: OverviewProps) {
  const rangeKeys = Object.keys(props.ranges) as OverviewRangeKey[];
  const [range, setRange] = useState<OverviewRangeKey>(props.initialRange);
  const [paused, setPaused] = useState(false);
  /** 数据流进度：0 = 静态首帧，1..N = 每 5 秒推进一帧（数据全部来自 JSON） */
  const [tick, setTick] = useState(0);
  const { enabled } = useAvMotion();

  const tabs = rangeKeys.map((key) => ({ value: key, label: props.ranges[key].label }));
  const view: OverviewRangeModel = props.ranges[range];

  // 切范围回到静态首帧：三档的演示帧是各自独立的，不能把进度带过去
  useEffect(() => {
    setTick(0);
  }, [range]);

  /*
   * 数据流：每 `stream.tick_seconds`（数据层给 5 秒）推进一帧。
   * `enabled` 同时挡掉 `?static=1` 与 prefers-reduced-motion —— 两者都要求
   * 「完全静止」，否则连拍三张截图的 DOM 值会不一样。
   */
  useEffect(() => {
    if (!enabled || paused) return;
    const total = view.stream.frames.length;
    if (total === 0) return;
    const timer = window.setInterval(() => {
      setTick((value) => (value + 1) % (total + 1));
    }, view.stream.tickSeconds * 1000);
    return () => window.clearInterval(timer);
  }, [enabled, paused, view]);

  const atTick = useMemo(() => overviewRangeAtTick(view, tick), [view, tick]);
  const pulse = enabled ? atTick.pulse : null;

  /*
   * 分级 / 场景两块环形图与 KPI 必须读**同一帧**的数据：`atTick.levels` / `atTick.scenes`
   * 是滚动后窗口的构成，两者的合计都等于 `atTick.totals.alarms`。用静态 `view.*` 的话，
   * 推进几帧后同一屏会同时出现两个总数（如 KPI 483、场景 532）。
   */
  const sceneTotal = atTick.scenes.reduce((sum, scene) => sum + scene.value, 0);
  const sceneDonut: DonutDatum[] = atTick.scenes.map((scene) => ({
    label: scene.label,
    value: scene.value,
    tone: scene.tone,
  }));
  const levelDonut: DonutDatum[] = atTick.levels.map((row) => ({
    label: row.label,
    value: row.total,
    tone: row.tone,
  }));
  const topTypeMax = Math.max(1, ...view.types.map((row) => row.count));
  const revealed = Math.min(props.recent.length, INITIAL_STREAM_COUNT + tick);
  const visibleAlarms = props.recent.slice(0, revealed);
  const peak = atTick.peak;
  const series = OVERVIEW_TREND_SERIES;

  return (
    <div className={s.page} data-av-page="overview">
      {/*
        BLF-1398：页头右侧不再放「数据锚点」芯片。
        顶栏状态栏已经有一颗锚点徽标，同一屏里重复两次是纯噪音；
        页头右侧留给「时间范围」Tab 一个控件即可。
      */}
      <AvPageHeader
        route="/stream-monitor/overview"
        title="总览驾驶舱"
        actions={<AvTabs items={tabs} value={range} onChange={setRange} ariaLabel="时间范围" />}
      />

      {/*
        `key={range}`：换范围时整块内容重挂载，于是
          ① 四张 KPI 卡的 `AvCounter` 重新从 0 滚到新值；
          ② 图表重新走一遍 skeleton → 真图的交叉淡入与描边动画；
          ③ `.rangeBody` 播一次 160ms 的「12px 上浮 + 淡入」。
        三档数据本身在服务端就都投影好了，切换不产生任何请求。
      */}
      <div className={s.rangeBody} key={range} data-av-range={range}>
        <div className={s.metricGrid}>
          {atTick.kpis.map((kpi) => (
            <AvMetric
              key={kpi.key}
              label={kpi.label}
              value={<AvCounter value={kpi.value} className={metricNumberClass} />}
              unit={kpi.unit}
              detail={kpi.detail}
              note={kpi.note}
              tone={kpi.tone}
            />
          ))}
        </div>

        <div className={s.splitWide}>
          <AvPanel
            title="告警趋势"
            subtitle={view.windowLabel}
            icon="overview"
            meta={view.granularity === "day" ? "按自然日" : "按小时"}
            motionKey="overview-trend"
          >
            <div className={s.rangeChart}>
              {view.granularity === "day" ? (
                <AvMultiBarChart
                  data={atTick.trend}
                  series={series}
                  height={AV_CHART_HEIGHT.lg}
                  label={`${view.windowLabel}告警、处置、事件与误报堆叠柱状图`}
                />
              ) : (
                <AvMultiTrendChart
                  data={atTick.trend}
                  series={series}
                  height={AV_CHART_HEIGHT.lg}
                  label={`${view.windowLabel}告警、处置、事件与误报趋势图`}
                  peak={{ key: "alarms", label: peak.label, value: peak.value, caption: `峰值 ${peak.label} · ${formatCount(peak.value)} 条` }}
                />
              )}
            </div>
            <div className={s.chartFoot}>
              <AvLegend
                items={series.map((item) => ({
                  label: item.label,
                  tone: item.tone,
                }))}
              />
              <span className={s.softNote}>
                区间合计 {formatCount(atTick.totals.alarms)} 条 · 峰值 {peak.label} · {formatCount(peak.value)} 条
              </span>
            </div>
          </AvPanel>

          <AvPanel
            title="告警分级"
            icon="alarm"
            meta={`未处置 ${formatCount(atTick.totals.unhandled)}`}
            motionKey="overview-levels"
          >
            <AvDonut
              data={levelDonut}
              centerValue={formatCount(atTick.totals.alarms)}
              centerLabel="告警合计"
              label={`${view.windowLabel}告警分级环形图`}
            />
            <ul className={s.levelList}>
              {atTick.levels.map((row) => (
                <li key={row.level} className={s.levelRow}>
                  <AvLevelBadge level={row.level} label={row.label} />
                  <span className={s.levelSpacer} />
                  <span className={s.levelTotal}>合计 {formatCount(row.total)}</span>
                  <span className={s.levelSub}>未处置 {formatCount(row.unhandled)}</span>
                </li>
              ))}
            </ul>
          </AvPanel>
        </div>

        {/* 这三块要滚动才看到，所以走「进入视口一次」入场（once，不重播） */}
        <AvPanelReveal index={0} className={s.gridThree}>
          <AvPanel
            title="场景分布"
            icon="capability"
            meta={`${atTick.scenes.length} 个场景`}
            motionKey="overview-scenes"
          >
            <AvDonut
              data={sceneDonut}
              centerValue={formatCount(sceneTotal)}
              centerLabel="合计"
              label={`${view.windowLabel}场景分布环形图`}
            />
            <AvLegend
              items={atTick.scenes.map((scene) => ({
                label: `${scene.label}（${scene.site}）`,
                value: formatCount(scene.value),
                tone: scene.tone,
              }))}
            />
          </AvPanel>

          <AvPanel
            title={`告警热力 · ${view.label}`}
            icon="event"
            meta={`峰值 ${formatCount(view.heatmap.max)} 条/小时`}
            motionKey="overview-heatmap"
            className={s.spanTwo}
          >
            <div
              className={s.heatmap}
              data-rows={view.heatmap.rows.length > 1 ? "multi" : "single"}
              role="img"
              aria-label={`${view.windowLabel}每小时告警热力图`}
            >
              <div className={s.heatAxis} aria-hidden="true">
                <span />
                <div className={s.heatTicks}>
                  {view.heatmap.axis.map((label, hour) => (
                    <span key={hour}>{label}</span>
                  ))}
                </div>
              </div>
              {view.heatmap.rows.map((row, rowIndex) => (
                <div key={row.key} className={s.heatRow}>
                  <span className={s.heatDay}>{row.label}</span>
                  <div className={s.heatCells}>
                    {row.cells.map((cell) => {
                      const hot = pulse != null && pulse.row === rowIndex && pulse.hour === cell.hour;
                      return (
                        <span
                          key={`${row.key}-${cell.hour}`}
                          className={`${s.heatCell} ${hot ? s.heatCellPulse : ""}`}
                          style={{ opacity: cell.count === 0 ? 0.12 : 0.25 + 0.75 * (cell.count / view.heatmap.max) }}
                          title={`${row.label} ${String(cell.hour).padStart(2, "0")}:00 · ${cell.count} 条`}
                          data-hot={hot ? "true" : undefined}
                        />
                      );
                    })}
                  </div>
                </div>
              ))}
              <div className={s.heatLegend} aria-hidden="true">
                <span>少</span>
                {[0.12, 0.35, 0.55, 0.75, 1].map((level) => (
                  <i key={level} style={{ opacity: level }} />
                ))}
                <span>多</span>
              </div>
            </div>
          </AvPanel>
        </AvPanelReveal>

        <div className={s.gridTwo}>
          <AvPanel
            title="重点点位"
            icon="device"
            meta={`前 ${view.points.length}`}
            motionKey="overview-points"
          >
            <ul className={s.rankList}>
              {view.points.map((point, index) => (
                <li key={point.id} className={s.rankRow}>
                  <span className={s.rankIndex}>{String(index + 1).padStart(2, "0")}</span>
                  <span className={s.rankName} title={point.room}>
                    {point.room}
                  </span>
                  <span className={s.rankBars}>
                    <i
                      style={{
                        width: `${Math.round((point.total / Math.max(1, view.points[0]?.total ?? 1)) * 100)}%`,
                      }}
                    />
                  </span>
                  <span className={s.rankNum}>{formatCount(point.total)}</span>
                  <span className={s.rankSub}>
                    一级 {point.level1} · 误报 {formatPercent(point.fpRate)}
                  </span>
                </li>
              ))}
            </ul>
          </AvPanel>

          <AvPanel
            title="高频告警类型"
            icon="capability"
            meta={`${view.types.length} 类`}
            motionKey="overview-types"
          >
            <div className={s.typeList}>
              {view.types.map((type) => (
                <AvBar
                  key={type.code}
                  label={`${type.name} · ${type.category}`}
                  value={type.count}
                  max={topTypeMax}
                  tone="signal"
                  detail={formatCount(type.count)}
                />
              ))}
            </div>
            <div className={s.firmwareRow}>
              <span className={s.softNote}>固件分布</span>
              {props.firmware.slice(0, 4).map((item) => (
                <span key={`${item.model}-${item.version}`} className={s.tagChip}>
                  {item.model} · {item.version} × {item.count}
                </span>
              ))}
            </div>
          </AvPanel>
        </div>
      </div>

      <div className={s.splitWide}>
        <AvPanel
          title="显卡算力资源池"
          subtitle={`${props.gpu.meta.model} · 显存 ${formatGb(props.gpu.meta.vramTotalGb)} · 利用率 ${formatPercent(props.gpu.meta.utilization)}`}
          icon="chip"
          meta={`${props.gpu.cards.length} 张卡`}
          motionKey="overview-gpu"
        >
          <div className={s.gpuList}>
            {props.gpu.cards.map((card) => (
              <div key={card.index} className={s.gpuRow} style={{ "--tone": toneVar(card.tone) } as React.CSSProperties}>
                <span className={s.gpuName}>显卡 {card.index}</span>
                <div
                  className={s.gpuTrack}
                  role="progressbar"
                  aria-valuenow={card.utilization}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label={`显卡 ${card.index} 利用率`}
                >
                  <span className={s.gpuFill} style={{ width: `${Math.min(100, Math.max(0, card.utilization))}%` }} />
                </div>
                <strong className={s.gpuValue}>{card.utilization}%</strong>
                <span className={s.gpuMode}>{card.mode}</span>
                <span className={s.gpuMeta}>
                  {formatGb(card.vram)} · {card.temperature}°C
                </span>
              </div>
            ))}
          </div>
          <div className={s.storageRow}>
            <AvBar
              label="热数据"
              value={props.storage.hotUsedTb}
              max={props.storage.hotTotalTb}
              tone="signal"
              detail={`${formatStorage(props.storage.hotUsedTb)} / ${formatStorage(props.storage.hotTotalTb)}`}
            />
            <AvBar
              label="冷数据"
              value={props.storage.coldUsedTb}
              max={props.storage.hotTotalTb}
              tone="violet"
              detail={formatStorage(props.storage.coldUsedTb)}
            />
          </div>
        </AvPanel>

        <AvPanel
          title="实时告警流"
          icon="alarm"
          meta={paused ? "已暂停轮播" : `已展示 ${visibleAlarms.length} / ${props.recent.length}`}
          action={
            <button type="button" className={s.ghostButton} onClick={() => setPaused((value) => !value)}>
              {paused ? "继续" : "暂停"}
            </button>
          }
          motionKey="overview-stream"
        >
          <ul className={s.stream} aria-live="polite">
            {visibleAlarms.map((alarm, index) => (
              <StreamItem key={alarm.id} alarm={alarm} index={index} total={visibleAlarms.length} />
            ))}
          </ul>
          <div className={s.panelLinkRow}>
            <Link href="/stream-monitor/alarm" className={s.textLink}>
              进入告警中心 →
            </Link>
            <span className={s.softNote}>
              {enabled ? `自动轮播：每 ${view.stream.tickSeconds} 秒展示下一条` : "静态模式：告警流不推进"}
            </span>
          </div>
        </AvPanel>
      </div>
    </div>
  );
}

/**
 * 实时告警流的一条。
 *
 * 每推进一帧多揭示一条时，**只有新出现的那条**从上方滑入（`data-fresh`），
 * 之前的条目重播一遍会让整个流看起来在刷新。错峰只作用于首屏同时出现的那几条
 * （前 10 条按 45ms 递增），第 11 条起不再延迟。
 */
function StreamItem({
  alarm,
  index,
  total,
}: {
  alarm: OverviewProps["recent"][number];
  index: number;
  total: number;
}) {
  const stagger = useStaggerIndex(index, total);
  // 首屏一起出现的是「历史」，之后逐条揭示的才是「新插入」
  const fresh = index >= INITIAL_STREAM_COUNT;
  return (
    <li
      className={`${s.streamItem} ${stagger.className}`}
      style={stagger.style}
      data-motion="stream-item"
      data-motion-key={alarm.id}
      data-fresh={fresh ? "true" : undefined}
    >
      <div className={s.streamTop}>
        <AvLevelBadge level={alarm.level} label={alarm.levelLabel} />
        <strong className={s.streamTitle}>{alarm.title}</strong>
        <span className={s.streamAge}>{toRelative(alarm.offsetMinutes)}</span>
      </div>
      <div className={s.streamBottom}>
        <span>{alarm.room}</span>
        <span className={s.streamDot} aria-hidden="true" />
        <span>{alarm.siteName}</span>
        <span className={s.streamDot} aria-hidden="true" />
        <span className={s.mono}>{alarm.deviceId ?? "无设备"}</span>
        <span className={s.streamType}>{alarm.typeName}</span>
      </div>
    </li>
  );
}
