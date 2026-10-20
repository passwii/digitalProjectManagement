"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import type { Incident } from "@/lib/av/types";
import {
  ALARM_STATUS_LABEL,
  ALARM_STATUS_TONE,
  formatCount,
  formatMinutes,
  levelMeta,
  sceneMeta,
  TIMELINE_LABEL,
  type AvTone,
} from "@/lib/av/labels";
import { toAbsolute, toClock, toRelative } from "@/lib/av/time";
import { AvEmpty, AvKV, AvLevelBadge, AvPageHeader, AvPanel, AvStatusBadge } from "@/components/av/AvUI";
import { useAvMotion } from "@/components/av/motion/AvMotionProvider";
import { AvPanelReveal } from "@/components/av/motion/AvMotion";
import AvTabs from "@/components/av/AvTabs";
import s from "./AvPages.module.css";
import type { EventDetail, EventRow, EventViewProps } from "@/lib/av/contracts";

type StatusFilter = "all" | "open" | "closed";
type SceneFilter = "all" | "campus" | "hospital" | "justice";

export default function EventView({ rows, detail, initialId, counts, userNames }: EventViewProps) {
  const [status, setStatus] = useState<StatusFilter>("all");
  const [scene, setScene] = useState<SceneFilter>("all");
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const { enabled: motionEnabled } = useAvMotion();

  // 选中事件由路由决定（/av/event/:id 是深链接），不在本地复制一份状态
  const selectedId = initialId ?? rows[0]?.id ?? null;
  const selected = detail && detail.incident.id === selectedId ? detail : null;

  const visible = useMemo(
    () =>
      rows.filter((row) => {
        if (status === "open" && row.status === "closed") return false;
        if (status === "closed" && row.status !== "closed") return false;
        if (scene !== "all" && row.scene !== scene) return false;
        return true;
      }),
    [rows, status, scene],
  );

  /**
   * 切换事件 = 服务端换一条详情。
   * 之所以不把所有事件的时间线一次性塞给客户端：那会把 HTML 从 ~140KB 撑到 700KB+。
   * 过渡期间用 pendingId 先把选中态点亮，避免点下去没反馈。
   */
  const select = (id: string) => {
    if (id === selectedId) return;
    setPendingId(id);
    startTransition(() => {
      router.push(`/stream-monitor/event/${id}`);
      setPendingId(null);
    });
  };


  return (
    <div className={s.page} data-av-page="event">
      <AvPageHeader
        route="/stream-monitor/event"
        title="事件中心"
        subtitle="多起告警按点位与时间窗融合成一起事件，全程可追溯"
        aside={
          <AvTabs
            items={[
              { value: "all", label: "全部", count: counts.total },
              { value: "open", label: "在办", count: counts.open },
              { value: "closed", label: "已闭环", count: counts.closed },
            ]}
            value={status}
            onChange={setStatus}
            ariaLabel="事件状态筛选"
          />
        }
      />

      <div className={s.splitWide}>
        <AvPanel
          title="事件列表"
          subtitle={`共 ${formatCount(counts.total)} 起 · 显示 ${formatCount(visible.length)} 起（按发生时间新 → 旧）`}
          icon="event"
          motionKey="event-list"
        >
          <div className={s.alarmToolbar} style={{ marginBottom: 8 }}>
            <AvTabs
              items={[
                { value: "all" as const, label: "全部场景" },
                ...(["campus", "hospital", "justice"] as const).map((value) => ({
                  value,
                  label: sceneMeta(value).fallbackName,
                })),
              ]}
              value={scene}
              onChange={setScene}
              ariaLabel="事件场景筛选"
            />
          </div>

          {visible.length === 0 ? (
            <AvEmpty title="没有匹配的事件" hint="切换状态或场景筛选。" />
          ) : (
            <>
              {/* 窄屏用卡片流：事件表在 390px 上没有任何一列还能读 */}
              <ul className={s.eventCards}>
                {visible.map((row) => (
                  <li key={`card-${row.id}`}>
                    <button
                      type="button"
                      className={s.eventCard}
                      data-active={row.id === (pendingId ?? selectedId)}
                      onClick={() => select(row.id)}
                    >
                      <span className={s.eventCardTop}>
                        <AvLevelBadge level={row.level} label={row.levelLabel} />
                        <strong>{row.title}</strong>
                        <AvStatusBadge tone={row.statusTone}>{row.statusLabel}</AvStatusBadge>
                      </span>
                      <span className={s.eventCardMeta}>
                        <span className={s.mono}>{row.id}</span>
                        <span>{row.sceneName}</span>
                        <span title={row.room}>{row.room}</span>
                        <span className={s.mono}>{formatMinutes(row.durationMinutes, 0)}</span>
                        <span>证据 {row.evidenceCount}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>

              <div className={`${s.tableWrapper} ${s.eventTable}`}>
              <table className={s.table}>
                <thead>
                  <tr>
                    <th>事件编号</th>
                    <th>标题</th>
                    <th>级别</th>
                    <th className={s.colScene}>场景</th>
                    <th className={s.colPoint}>点位</th>
                    <th className={`${s.num} ${s.colDuration}`}>时长</th>
                    <th>状态</th>
                    <th className={`${s.num} ${s.colEvidence}`}>证据</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((row) => (
                    <tr
                      key={row.id}
                      className={s.eventTableRow}
                      data-active={row.id === (pendingId ?? selectedId)}
                      onClick={() => select(row.id)}
                    >
                      <td className={s.mono}>
                        <button type="button" className={s.tableButton} onClick={() => select(row.id)}>
                          {row.id}
                        </button>
                      </td>
                      <td>
                        <strong>{row.title}</strong>
                      </td>
                      <td>
                        <AvLevelBadge level={row.level} label={row.levelLabel} />
                      </td>
                      <td className={`${s.nowrap} ${s.colScene}`}>{row.sceneName}</td>
                      <td className={s.colPoint} title={row.room}>{row.room}</td>
                      <td className={`${s.num} ${s.colDuration}`}>{formatMinutes(row.durationMinutes, 0)}</td>
                      <td>
                        <AvStatusBadge tone={row.statusTone}>{row.statusLabel}</AvStatusBadge>
                      </td>
                      <td className={`${s.num} ${s.colEvidence}`}>{row.evidenceCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            </>
          )}
        </AvPanel>

        <div className={s.railStack} aria-busy={pending}>
          {selected ? (
            <AvPanelReveal>
              <AvPanel
                title="事件追溯 · 时间线"
                subtitle={`${selected.incident.id} · ${selected.siteName}`}
                icon="event"
                meta={`${selected.incident.timeline.length} 个节点`}
                motionKey="event-timeline"
              >
                <AvKV
                  rows={[
                    { label: "标题", value: selected.incident.title },
                    {
                      label: "级别",
                      value: <AvLevelBadge level={selected.incident.level} label={selected.incident.level_label} />,
                    },
                    { label: "场景", value: selected.sceneName },
                    { label: "点位", value: selected.incident.point_room },
                    { label: "起止", value: `${toAbsolute(selected.incident.started_offset_minutes)} → ${toAbsolute(selected.incident.ended_offset_minutes)}` },
                    { label: "时长", value: formatMinutes(selected.incident.duration_minutes) },
                    { label: "责任人", value: selected.ownerName },
                    {
                      label: "状态",
                      value: <AvStatusBadge tone={ALARM_STATUS_TONE[selected.incident.status] as AvTone}>{ALARM_STATUS_LABEL[selected.incident.status]}</AvStatusBadge>,
                    },
                  ]}
                />
                <ol className={s.timeline} style={{ marginTop: 14 }}>
                  {selected.incident.timeline.map((node, index) => (
                    <li
                      key={`${selected.incident.id}-${node.at_offset_minutes}-${node.type}`}
                      className={s.timelineItem}
                      data-motion="timeline-node"
                      data-motion-index={index}
                      /*
                        逐个点亮：节点序号即错峰序号（--av-i），延迟 = 60ms × i，
                        由 CSS 变量算；动效关闭时不写 data-motion-node，
                        keyframes 根本不参与（不是把时长改 0）。
                      */
                      data-motion-node={motionEnabled ? "on" : undefined}
                      style={{ "--av-i": Math.min(index, 10) } as React.CSSProperties}
                    >
                      <span className={s.timelineTime}>{toClock(node.at_offset_minutes)}</span>
                      <span className={s.timelineMark} aria-hidden="true">
                        <i />
                      </span>
                      <span className={s.timelineBody}>
                        <strong>{TIMELINE_LABEL[node.type] ?? node.type}</strong>
                        <p>{node.text}</p>
                        <span className={s.timelineActor}>
                          {node.actor ? userNames[node.actor] ?? node.actor : "系统"} · {toRelative(node.at_offset_minutes)}
                        </span>
                      </span>
                    </li>
                  ))}
                </ol>
              </AvPanel>

              <AvPanel
                title="证据链"
                subtitle="事件关联的告警与音视频证据"
                icon="alarm"
                meta={`${selected.alarms.length} 条告警`}
                motionKey="event-evidence"
              >
                {selected.alarms.length === 0 ? (
                  <AvEmpty title="该事件暂无关联告警" hint="事件仍保留时间线，便于人工补录。" />
                ) : (
                  <ul className={s.evidenceList}>
                    {selected.alarms.map((alarm) => (
                      <li key={alarm.id}>
                        <Link className={s.evidenceItem} href={`/stream-monitor/alarm/${alarm.id}`}>
                          <AvLevelBadge level={alarm.level} label={alarm.levelLabel} />
                          <span className={s.evidenceTitle} title={alarm.title}>{alarm.title}</span>
                          <span className={s.evidenceId}>{alarm.id}</span>
                          <span className={s.evidenceId}>
                            {alarm.spectrumId ? "频谱" : alarm.videoClips > 0 ? `${alarm.videoClips} 段视频` : "无证据"}
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </AvPanel>
            </AvPanelReveal>
          ) : (
            <AvPanel title="事件追溯" subtitle="选择任意一起事件" icon="event" motionKey="event-empty">
              <AvEmpty title="未选择事件" hint="点击事件列表中的任意一行，右侧显示时间线与证据链。" />
            </AvPanel>
          )}
        </div>
      </div>
    </div>
  );
}
