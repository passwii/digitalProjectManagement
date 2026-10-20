"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { AvBar, AvEmpty, AvLegend, AvPageHeader, AvPanel, AvStatusBadge } from "@/components/av/AvUI";
import type { AvTone } from "@/lib/av/labels";
import { compactAge, DEVICE_STATUS_LABEL, DEVICE_STATUS_TONE, formatCount } from "@/lib/av/labels";
import { toRelative } from "@/lib/av/time";
import AvGlyph from "@/components/av/AvGlyph";
import AvTabs from "@/components/av/AvTabs";
import { staggerProps } from "@/components/av/motion/AvMotion";
import { useAvMotion } from "@/components/av/motion/AvMotionProvider";
import s from "./AvPages.module.css";
import type { MonitorChannel, MonitorProps } from "@/lib/av/contracts";

type KindFilter = "all" | "audio" | "video";

export default function MonitorView({ channels, counts, deviceTotal, signalHealth, models, gateways }: MonitorProps) {
  const [filter, setFilter] = useState<KindFilter>("all");
  const { enabled: motionEnabled } = useAvMotion();

  const visible = useMemo(
    () => (filter === "all" ? channels : channels.filter((channel) => channel.kind === filter)),
    [channels, filter],
  );

  const modelTotal = Math.max(1, ...models.map((model) => model.count));

  return (
    <div className={s.page} data-av-page="monitor">
      <AvPageHeader
        route="/stream-monitor/monitor"
        title="实时音视频监控"
        subtitle={`多模态感知通道：音频拾取与视频画面按场景聚合（本页展示 ${channels.length} 路，全量设备 ${deviceTotal} 台）。通道状态与信号强度来自设备心跳。`}
        aside={
          <AvTabs
            items={[
              { value: "all", label: "全部通道", count: counts.all },
              { value: "audio", label: "音频", count: counts.audio },
              { value: "video", label: "视频", count: counts.video },
            ]}
            value={filter}
            onChange={setFilter}
            ariaLabel="通道类型筛选"
          />
        }
      />

      {visible.length === 0 ? (
        <AvEmpty title="当前筛选下没有通道" hint="切换到「全部通道」查看音频与视频通道。" />
      ) : (
        <div className={s.channelGrid}>
          {visible.map((channel, index) => {
            const statusTone: AvTone = DEVICE_STATUS_TONE[channel.status];
            // 前 10 路按 index * 30ms 错峰入场（12 路全错峰只会让最后一张晚半秒）
            const stagger = staggerProps(index, visible.length, motionEnabled);
            return (
              <article
                key={channel.id}
                className={`${s.channel} ${stagger.className}`}
                style={stagger.style}
                data-motion="channel"
                data-motion-key={channel.id}
                data-kind={channel.kind}
                data-status={channel.status}
              >
                <div className={s.channelStage}>
                  <span className={s.channelLive}>
                    <i aria-hidden="true" />LIVE
                  </span>
                  <span className={s.channelKind}>{channel.kind === "video" ? "VIDEO" : "AUDIO"}</span>
                  {channel.kind === "video" ? (
                    <AvGlyph name="monitor" size={40} className={s.cameraIcon} />
                  ) : (
                    <div className={s.wave} aria-hidden="true">
                      {channel.waveform.map((value, index) => (
                        <span
                          key={`${channel.id}-${index}`}
                          className={s.waveBar}
                          data-idle={channel.status === "offline" ? "true" : undefined}
                          style={{ height: `${Math.round(value * 100)}%` }}
                        />
                      ))}
                    </div>
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
              </article>
            );
          })}
        </div>
      )}

      <div className={s.gridTwo}>
        <AvPanel
          title="通道信号质量"
          subtitle="全量设备的 RSSI 健康分位（0–100 质量分，非 dBm）"
          icon="monitor"
          meta={`离线 ${formatCount(counts.offline)} 台`}
          motionKey="monitor-signal"
        >
          <div className={s.typeList}>
            <AvBar label="平均值" value={signalHealth.avg} max={100} tone="signal" detail={signalHealth.avg.toFixed(1)} />
            <AvBar label="P90" value={signalHealth.p90} max={100} tone="success" detail={String(signalHealth.p90)} />
            <AvBar label="P50" value={signalHealth.p50} max={100} tone="violet" detail={String(signalHealth.p50)} />
            <AvBar label="P10（弱信号尾部）" value={signalHealth.p10} max={100} tone="warning" detail={String(signalHealth.p10)} />
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
            {models.map((model) => (
              <AvBar
                key={model.model}
                label={`${model.typeName} · ${model.model}`}
                value={model.count}
                max={modelTotal}
                tone="signal"
                detail={`${formatCount(model.count)} 台`}
              />
            ))}
          </div>
        </AvPanel>
      </div>

      <AvPanel
        title="网关与链路"
        subtitle="网关自身状态；终端离线上报前会先在网关侧留下心跳断点"
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
