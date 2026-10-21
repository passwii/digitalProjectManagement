"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import Link from "next/link";
import { m } from "framer-motion";
import { AvBar, AvEmpty, AvLegend, AvPageHeader, AvPanel, AvStatusBadge } from "@/components/av/AvUI";
import type { AvTone } from "@/lib/av/labels";
import { compactAge, DEVICE_STATUS_LABEL, DEVICE_STATUS_TONE, formatCount } from "@/lib/av/labels";
import { toRelative } from "@/lib/av/time";
import AvTabs from "@/components/av/AvTabs";
import AvCounter from "@/components/av/motion/AvCounter";
import AvLiveBadge, { useChannelClock, type AvLiveState } from "@/components/av/motion/AvLiveBadge";
import AvVideoScene from "@/components/av/motion/AvVideoScene";
import AvWaveform, { waveformSeed } from "@/components/av/motion/AvWaveform";
import { AV_STAGGER, avStaggerSeconds } from "@/lib/av/motion";
import { useAvMotion } from "@/components/av/motion/AvMotionProvider";
import s from "./AvPages.module.css";
import motionStyles from "@/components/av/motion/AvMotion.module.css";
import type { MonitorChannel, MonitorProps } from "@/lib/av/contracts";

type KindFilter = "all" | "audio" | "video";
type FilterPhase = "idle" | "exit" | "enter";

/** 每张卡的「录制时长」起点：由 id 的稳定哈希派生，同屏互不相同且 SSR 一致。 */
function channelStartSeconds(id: string): number {
  const seed = waveformSeed(id);
  return 8 * 60 + (seed % 2400); // 00:08:00 – 00:48:00
}

function liveStateOf(channel: MonitorChannel): AvLiveState {
  if (channel.status === "online") return "online";
  if (channel.status === "maintenance") return "maintenance";
  return "offline";
}

function matchesFilter(channel: MonitorChannel, filter: KindFilter): boolean {
  return filter === "all" || channel.kind === filter;
}

/**
 * 单张通道卡。
 *
 * 拆成独立组件是为了让「时间码每秒递增」只重渲染这一张卡：9 张卡各有一个 1s
 * 定时器，但每个定时器只 setState 自己的 frame，不会把栅格、右侧面板、网关表
 * 一起重渲染（那是 1s 一次的整页 diff）。
 */
function ChannelCard({
  channel,
  index,
  total,
  enabled,
  entering,
  duration,
  ease,
}: {
  channel: MonitorChannel;
  index: number;
  total: number;
  enabled: boolean;
  entering: boolean;
  duration: (token: "instant" | "quick" | "base" | "slow") => number;
  ease: (token: "standard" | "enter" | "exit") => [number, number, number, number];
}) {
  const liveState = liveStateOf(channel);
  const frame = useChannelClock(channelStartSeconds(channel.id));
  const seed = waveformSeed(channel.id);
  const statusTone: AvTone = DEVICE_STATUS_TONE[channel.status];
  const isVideo = channel.kind === "video";
  const animateEnter = entering && enabled;
  // --av-i 只用于入场错峰：45ms × 序号，与其它列表共用 AV_STAGGER.list
  const staggerIndex = Math.round(avStaggerSeconds(index, total) / AV_STAGGER.list);
  const enterStyle = animateEnter ? ({ "--av-i": staggerIndex } as CSSProperties) : undefined;

  return (
    <m.article
      layout={enabled ? "position" : undefined}
      initial={false}
      transition={enabled ? { duration: duration("base"), ease: ease("standard") } : undefined}
      className={`${s.channel} ${animateEnter ? motionStyles.channelEnter : ""}`}
      style={enterStyle}
      data-motion="channel"
      data-motion-key={channel.id}
      data-kind={channel.kind}
      data-status={channel.status}
    >
      <div className={s.channelStage} data-channel-state={liveState}>
        {/* LIVE / 离线徽标 + 递增时间码（动效关闭时时间码停在起点） */}
        <AvLiveBadge className={s.channelLive} state={liveState} frame={frame} />
        <span className={s.channelKind}>{isVideo ? "VIDEO" : "AUDIO"}</span>
        {/* 缓慢的横向扫描线：只给在线通道（离线卡是静态灰态，连扫描线都不要） */}
        {liveState === "online" && (
          <span
            className={motionStyles.stageScan}
            style={{ "--av-scan-phase": ((seed % 100) / 100).toFixed(3) } as CSSProperties}
          />
        )}
        {isVideo ? (
          <AvVideoScene seed={seed} frame={frame} state={liveState} />
        ) : (
          <AvWaveform
            seed={seed}
            /*
             * 相位 / 周期按卡片序号显式错开（而不是让组件从 seed 里再派生一次）：
             * 9 张卡要保证「任何两张都不同」，序号是唯一的；seed 仍然决定每根柱子
             * 的高度抖动与柱级延迟，所以同相位下也不会长得一样。
             */
            phase={(index * 0.137) % 1}
            speed={0.78 + index * 0.062}
            values={channel.waveform}
            bars={26}
            state={channel.status === "offline" ? "offline" : "online"}
          />
        )}
      </div>
      <div className={s.channelMeta}>
        <div className={s.channelTitle}>
          <strong title={channel.room}>{channel.room}</strong>
          <AvStatusBadge tone={statusTone}>{DEVICE_STATUS_LABEL[channel.status]}</AvStatusBadge>
        </div>
        <div className={s.channelFacts}>
          <span>{channel.sceneName} · {channel.siteName}</span>
          <span>{channel.typeName} <b>{channel.model}</b></span>
          <span>固件 <b>{channel.firmware}</b></span>
          <span>信号 <b>{channel.signal}/100</b></span>
          <span>CPU <b>{channel.cpu}%</b></span>
          <span>心跳 <b>{compactAge(channel.heartbeatOffsetMinutes)}前</b></span>
        </div>
      </div>
    </m.article>
  );
}

export default function MonitorView({ channels, counts, signalHealth, models, gateways }: MonitorProps) {
  const [filter, setFilter] = useState<KindFilter>("all");
  const [shown, setShown] = useState<KindFilter>("all");
  const [phase, setPhase] = useState<FilterPhase>("idle");
  // 首次加载：所有卡片走一次错峰入场（与筛选切换共用 .channelEnter）
  const [entering, setEntering] = useState<ReadonlySet<string>>(
    () => new Set(channels.map((channel) => channel.id)),
  );
  const timers = useRef<number[]>([]);
  const { enabled, duration, ease } = useAvMotion();

  const clearTimers = useCallback(() => {
    for (const timer of timers.current) window.clearTimeout(timer);
    timers.current = [];
  }, []);

  useEffect(() => clearTimers, [clearTimers]);

  const idsFor = useCallback(
    (kind: KindFilter) => channels.filter((channel) => matchesFilter(channel, kind)).map((channel) => channel.id),
    [channels],
  );

  /**
   * 三段式筛选切换：**退场 → 替换列表（framer layout 做 FLIP 重排）→ 入场**。
   *
   * 为什么不用 `AnimatePresence`：它的退场与「剩下的卡片重排」是同一帧开始的，
   * 观感是「新列表已经就位、旧卡片还在淡出」，三段挤成一段。这里用状态机把退场
   * 跑完（quick + exit）再替换 `shown`，替换那一帧剩下的卡片由 `layout` 平滑
   * 让位（FLIP），随后新出现的卡片挂 `.channelEnter` 按 45ms 错峰入场。
   *
   * 动效关闭（`?static=1` / reduced）时直接换列表：没有定时器、没有中间态，
   * 连拍三张必须是同一份 DOM。
   */
  const changeFilter = (next: KindFilter) => {
    if (next === filter) return;
    setFilter(next);
    clearTimers();

    const previousIds = new Set(idsFor(shown));
    const nextIds = idsFor(next);

    if (!enabled) {
      setShown(next);
      setPhase("idle");
      setEntering(new Set());
      return;
    }

    // 退场途中又点回当前列表：没有真正要换的内容，收回中间态即可
    if (next === shown) {
      setPhase("idle");
      return;
    }

    setPhase("exit");
    const exitTimer = window.setTimeout(() => {
      setShown(next);
      setEntering(new Set(nextIds.filter((id) => !previousIds.has(id))));
      setPhase("enter");
      // 入场动画跑完（最后的错峰 + base）再回到 idle，避免状态永远停在 enter
      const settle =
        duration("base") * 1000 +
        Math.min(Math.max(0, nextIds.length - 1), AV_STAGGER.max) * AV_STAGGER.list * 1000;
      timers.current.push(window.setTimeout(() => setPhase("idle"), settle));
    }, duration("quick") * 1000);
    timers.current.push(exitTimer);
  };

  const visible = useMemo(
    () => (shown === "all" ? channels : channels.filter((channel) => channel.kind === shown)),
    [channels, shown],
  );

  const modelTotal = Math.max(1, ...models.map((model) => model.count));

  return (
    <div className={s.page} data-av-page="monitor">
      <AvPageHeader
        route="/stream-monitor/monitor"
        title="实时音视频监控"
        subtitle="多模态感知通道：音频拾取与视频画面按场景聚合"
        aside={
          <AvTabs
            items={[
              { value: "all", label: "全部通道", count: counts.all },
              { value: "audio", label: "音频", count: counts.audio },
              { value: "video", label: "视频", count: counts.video },
            ]}
            value={filter}
            onChange={changeFilter}
            ariaLabel="通道类型筛选"
          />
        }
      />

      {visible.length === 0 ? (
        <AvEmpty title="当前筛选下没有通道" hint="切换到「全部通道」查看音频与视频通道。" />
      ) : (
        <div
          className={`${s.channelGrid} ${phase === "exit" ? motionStyles.channelGridExit : ""}`}
          data-filter-phase={phase}
          data-audio-cards={visible.filter((channel) => channel.kind === "audio").length}
          aria-busy={phase === "exit" || undefined}
        >
          {visible.map((channel, index) => (
            <ChannelCard
              key={channel.id}
              channel={channel}
              index={index}
              total={visible.length}
              enabled={enabled}
              entering={entering.has(channel.id)}
              duration={duration}
              ease={ease}
            />
          ))}
        </div>
      )}

      <div className={s.gridTwo}>
        <AvPanel
          title="通道信号质量"
          subtitle="全量设备的 RSSI 健康分位"
          icon="monitor"
          meta={`离线 ${formatCount(counts.offline)} 台`}
          motionKey="monitor-signal"
        >
          <div className={s.typeList}>
            <AvBar
              label="平均值"
              value={signalHealth.avg}
              max={100}
              tone="signal"
              index={0}
              detail={<AvCounter value={signalHealth.avg.toFixed(1)} />}
            />
            <AvBar
              label="P90"
              value={signalHealth.p90}
              max={100}
              tone="success"
              index={1}
              detail={<AvCounter value={String(signalHealth.p90)} />}
            />
            <AvBar
              label="P50"
              value={signalHealth.p50}
              max={100}
              tone="violet"
              index={2}
              detail={<AvCounter value={String(signalHealth.p50)} />}
            />
            <AvBar
              label="P10（弱信号尾部）"
              value={signalHealth.p10}
              max={100}
              tone="warning"
              index={3}
              detail={<AvCounter value={String(signalHealth.p10)} />}
            />
          </div>
          <div className={s.firmwareRow}>
            <AvLegend
              items={[
                { label: "平均", tone: "signal" },
                { label: "P90", tone: "success" },
                { label: "P50", tone: "violet" },
                { label: "P10", tone: "warning" },
              ]}
            />
          </div>
        </AvPanel>

        <AvPanel
          title="终端型号构成"
          subtitle="网关 / 拾音 / 视觉终端"
          icon="device"
          meta={`${models.length} 种型号`}
          motionKey="monitor-models"
        >
          <div className={s.typeList}>
            {models.map((model, index) => (
              <AvBar
                key={model.model}
                label={`${model.typeName} · ${model.model}`}
                value={model.count}
                max={modelTotal}
                tone="signal"
                index={index}
                detail={<AvCounter value={`${formatCount(model.count)} 台`} />}
              />
            ))}
          </div>
        </AvPanel>
      </div>

      <AvPanel
        title="网关与链路"
        subtitle="网关与链路状态"
        icon="device"
        meta={`${gateways.length} 台网关`}
        motionKey="monitor-gateways"
      >
        <div className={s.tableWrapper}>
          <table className={s.table}>
            <thead>
              <tr>
                <th>网关</th>
                <th>安装位置</th>
                <th>状态</th>
                <th className={s.num}>最近心跳</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {gateways.map((gateway) => (
                <tr key={gateway.id}>
                  <td className={s.mono}>{gateway.id}</td>
                  <td title={gateway.room}>{gateway.room}</td>
                  <td>
                    <AvStatusBadge tone={DEVICE_STATUS_TONE[gateway.status]}>
                      {DEVICE_STATUS_LABEL[gateway.status]}
                    </AvStatusBadge>
                  </td>
                  <td className={s.num}>{toRelative(gateway.heartbeatOffsetMinutes)}</td>
                  <td className={s.num}>
                    <Link href="/stream-monitor/device" className={s.textLink}>设备台账 →</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </AvPanel>
    </div>
  );
}
