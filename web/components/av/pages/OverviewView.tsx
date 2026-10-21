"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { OverviewProps } from "@/lib/av/contracts";
import { AvBar, AvLegend, AvMetric, AvPageHeader, AvPanel, AvLevelBadge } from "@/components/av/AvUI";
import { toneVar } from "@/lib/av/tone";
import { AV_CHART_HEIGHT } from "@/lib/av/chartHeights";
import { AvBarChart, AvDonut, AvTrendChart, type DonutDatum } from "@/components/av/AvCharts";
import { formatCount, formatGb, formatPercent, formatStorage } from "@/lib/av/labels";
import { toRelative } from "@/lib/av/time";
import { useAvMotion } from "@/components/av/motion/AvMotionProvider";
import { AvPanelReveal, useStaggerIndex } from "@/components/av/motion/AvMotion";
import AvCounter from "@/components/av/motion/AvCounter";
import ui from "@/components/av/AvUI.module.css";
import AvTabs from "@/components/av/AvTabs";
import s from "./AvPages.module.css";

type RangeKey = "live" | "today" | "week";

/** 首屏一次性揭示的告警流条数（与上面 useState 的初值同一个数）。 */
const INITIAL_STREAM_COUNT = 4;

/**
 * KPI 数字的样式类（来自 AvUI.module.css）。
 *
 * 必须显式传给 `AvCounter`：`.metricValue .metricNumber` 把字号 / 颜色 / 字重
 * 全部 `inherit` 自 `<strong>`（`--av-text-kpi` + `--av-weight-figure` 800），
 * 只保留等宽数字；计数器渲染的 span 若不带这个类，就没有显式继承链路可依。
 * 单位的样式是另一个类 `.metricUnit`，两者互不命中。
 */
const metricNumberClass = ui.metricNumber;

const RANGE_TABS: { value: RangeKey; label: string }[] = [
  { value: "live", label: "近 24 小时" },
  { value: "today", label: "今日" },
  { value: "week", label: "近 7 日" },
];

export default function OverviewView(props: OverviewProps) {
  const [range, setRange] = useState<RangeKey>("live");
  const [revealed, setRevealed] = useState(INITIAL_STREAM_COUNT);
  const [paused, setPaused] = useState(false);
  const { frozen } = useAvMotion();

  // 实时告警流的「增量插入」：数据是静态回放，每 8 秒揭示下一条，
  // 结构上给足稳定 key 与固定顺序，Stage 3 只需在这里挂入场动画。
  useEffect(() => {
    // `frozen`（?static=1）下停掉回放：截图 / 录屏要求同一页面连拍 3 次完全一致，
    // 每 8 秒多一条会让 MD5 对不上。减少动效（reduced）不在这里停 —— 那是动效，
    // 不是内容，停掉会让用户永远只看得到前 4 条。
    if (frozen || paused || revealed >= props.recent.length) return;
    const timer = window.setTimeout(() => setRevealed((value) => Math.min(props.recent.length, value + 1)), 8000);
    return () => window.clearTimeout(timer);
  }, [frozen, paused, revealed, props.recent.length]);

  const heatMax = useMemo(
    () => Math.max(1, ...props.heatmap.flatMap((day) => day.cells.map((cell) => cell.count))),
    [props.heatmap],
  );
  const sceneTotal = props.scenes.reduce((sum, scene) => sum + scene.value, 0);
  const sceneDonut: DonutDatum[] = props.scenes.map((scene) => ({
    label: scene.label,
    value: scene.value,
    tone: scene.tone,
  }));
  const levelDonut: DonutDatum[] = props.levels.map((row) => ({
    label: row.label,
    value: row.total,
    tone: row.tone,
  }));
  const topTypeMax = Math.max(1, ...props.types.map((row) => row.count));
  const visibleAlarms = props.recent.slice(0, revealed);

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
        subtitle="多模态融合感知 · 全场景智能安防"
        actions={<AvTabs items={RANGE_TABS} value={range} onChange={setRange} ariaLabel="时间范围" />}
      />

      <div className={s.metricGrid}>
        {props.kpis.map((kpi) => (
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
          subtitle={range === "week" ? "近 7 个自然日的告警与事件" : "每小时告警量与已处置量"}
          icon="overview"
          meta={range === "week" ? "按自然日" : "按小时"}
          motionKey="overview-trend"
        >
          {range === "week" ? (
            <AvBarChart
              data={props.daily}
              dataKeys={["alarms", "incidents"]}
              labels={["告警数", "事件数"]}
              /* 数据系列色（BLF-1423）：青 / 紫 —— 同一张图里两条系列不再借用语义色 */
              tones={["series-1", "series-3"]}
              height={AV_CHART_HEIGHT.lg}
              label="近 7 日告警与事件柱状图"
            />
          ) : (
            <AvTrendChart
              data={range === "today" ? props.todayTrend : props.trend}
              dataKeys={["alarms", "handled"]}
              labels={["告警数", "已处置"]}
              /* 青 / 水绿：两条线用系列色区分，而不是「signal / success」两套语义 */
              tones={["series-1", "series-8"]}
              height={AV_CHART_HEIGHT.lg}
              label="告警趋势折线图"
            />
          )}
          <div className={s.chartFoot}>
            <AvLegend
              items={[
                { label: "告警数", tone: "series-1" },
                { label: range === "week" ? "事件数" : "已处置", tone: range === "week" ? "series-3" : "series-8" },
              ]}
            />
            <span className={s.softNote}>
              {range === "week"
                ? `7 日合计 ${formatCount(props.daily.reduce((sum, day) => sum + day.alarms, 0))} 条`
                : `区间合计 ${formatCount((range === "today" ? props.todayTrend : props.trend).reduce((sum, bucket) => sum + bucket.alarms, 0))} 条`}
            </span>
          </div>
        </AvPanel>

        <AvPanel
          title="告警分级"
          subtitle="今日全量 vs 未处置拆分"
          icon="alarm"
          meta={`未处置 ${formatCount(props.alarmUnhandled)}`}
          motionKey="overview-levels"
        >
          <AvDonut
            data={levelDonut}
            centerValue={formatCount(props.todayAlarmsTotal)}
            centerLabel="今日告警"
            label="今日告警分级环形图"
          />
          <ul className={s.levelList}>
            {props.levels.map((row) => (
              <li key={row.level} className={s.levelRow}>
                <AvLevelBadge level={row.level} label={row.label} />
                <span className={s.levelSpacer} />
                <span className={s.levelTotal}>今日 {formatCount(row.total)}</span>
                <span className={s.levelSub}>未处置 {formatCount(row.unhandled)}</span>
              </li>
            ))}
          </ul>
        </AvPanel>
      </div>

      {/* 这三块要滚动才看到，所以走「进入视口一次」入场（once，不重播） */}
      <AvPanelReveal index={0} className={s.gridThree}>
        <AvPanel title="场景分布" subtitle="今日告警按业务场景" icon="capability" meta={`${props.scenes.length} 个场景`} motionKey="overview-scenes">
          <AvDonut
            data={sceneDonut}
            centerValue={formatCount(sceneTotal)}
            centerLabel="今日合计"
            label="场景分布环形图"
          />
          <AvLegend
            items={props.scenes.map((scene) => ({
              label: `${scene.label}（${scene.site}）`,
              value: formatCount(scene.value),
              tone: scene.tone,
            }))}
          />
        </AvPanel>

        <AvPanel
          title="告警热力 · 7 日 × 24 小时"
          subtitle="颜色越深代表该时段告警越多（UTC+8 时钟）"
          icon="event"
          meta={`峰值 ${formatCount(heatMax)} 条/小时`}
          motionKey="overview-heatmap"
          className={s.spanTwo}
        >
          <div className={s.heatmap} role="img" aria-label="近 7 日每小时告警热力图">
            <div className={s.heatAxis} aria-hidden="true">
              <span />
              <div className={s.heatTicks}>
                {Array.from({ length: 24 }, (_, hour) => (
                  <span key={hour}>{[0, 6, 12, 18].includes(hour) ? String(hour).padStart(2, "0") : ""}</span>
                ))}
              </div>
            </div>
            {props.heatmap.map((day) => (
              <div key={day.day} className={s.heatRow}>
                <span className={s.heatDay}>{day.day === 0 ? "今天" : `-${day.day} 天`}</span>
                <div className={s.heatCells}>
                  {day.cells.map((cell) => (
                    <span
                      key={`${day.day}-${cell.hour}`}
                      className={s.heatCell}
                      style={{ opacity: cell.count === 0 ? 0.12 : 0.25 + 0.75 * (cell.count / heatMax) }}
                      title={`${day.day === 0 ? "今天" : `${day.day} 天前`} ${String(cell.hour).padStart(2, "0")}:00 · ${cell.count} 条`}
                    />
                  ))}
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

      <div className={s.splitWide}>
        <AvPanel
          title="GPU 算力资源池"
          subtitle={`${props.gpu.meta.model} · 显存 ${formatGb(props.gpu.meta.vramTotalGb)} · 利用率 ${formatPercent(props.gpu.meta.utilization)}`}
          icon="chip"
          meta={`${props.gpu.cards.length} 张卡`}
          motionKey="overview-gpu"
        >
          <div className={s.gpuList}>
            {props.gpu.cards.map((card) => (
              <div key={card.index} className={s.gpuRow} style={{ "--tone": toneVar(card.tone) } as React.CSSProperties}>
                <span className={s.gpuName}>GPU{card.index}</span>
                <div
                  className={s.gpuTrack}
                  role="progressbar"
                  aria-valuenow={card.utilization}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label={`GPU${card.index} 利用率`}
                >
                  <span className={s.gpuFill} style={{ width: `${Math.min(100, Math.max(0, card.utilization))}%` }} />
                </div>
                <strong className={s.gpuValue}>{card.utilization}%</strong>
                <span className={s.gpuMode}>{card.mode}</span>
                <span className={s.gpuMeta}>{formatGb(card.vram)} · {card.temperature}°C</span>
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
          subtitle="最新告警按时间滚动"
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
            <span className={s.softNote}>自动轮播：每 8 秒展示下一条</span>
          </div>
        </AvPanel>
      </div>

      <div className={s.gridTwo}>
        <AvPanel title="重点点位" subtitle="按告警总量排序（近 180 天）" icon="device" meta="Top 6" motionKey="overview-points">
          <ul className={s.rankList}>
            {props.points.map((point, index) => (
              <li key={point.id} className={s.rankRow}>
                <span className={s.rankIndex}>{String(index + 1).padStart(2, "0")}</span>
                <span className={s.rankName} title={point.room}>{point.room}</span>
                <span className={s.rankBars}>
                  <i style={{ width: `${Math.round((point.total / Math.max(1, props.points[0]?.total ?? 1)) * 100)}%` }} />
                </span>
                <span className={s.rankNum}>{formatCount(point.total)}</span>
                <span className={s.rankSub}>一级 {point.level1} · 误报 {formatPercent(point.fpRate)}</span>
              </li>
            ))}
          </ul>
        </AvPanel>

        <AvPanel title="高频告警类型" subtitle="按告警条数排序" icon="capability" meta={`${props.types.length} 类`} motionKey="overview-types">
          <div className={s.typeList}>
            {props.types.map((type) => (
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
  );
}

/**
 * 实时告警流的一条。
 *
 * 每 8 秒多揭示一条时，**只有新出现的那条**从上方滑入（`data-fresh`），
 * 之前的条目重播一遍会让整个流看起来在刷新。错峰只作用于首屏同时出现的那几条
 * （前 10 条按 30ms 递增），第 11 条起不再延迟。
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
