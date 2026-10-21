"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import type { IncidentKind, Scene } from "@/lib/av/types";
import {
  ALARM_STATUS_LABEL,
  ALARM_STATUS_TONE,
  EVENT_KIND_FULL_LABEL,
  EVENT_KIND_LABEL,
  eventTypeText,
  formatCount,
  formatMinutes,
  incidentKind,
  sceneMeta,
  TIMELINE_LABEL,
  type AvTone,
} from "@/lib/av/labels";
import { toAbsolute, toClock, toRelative } from "@/lib/av/time";
import { AvEmpty, AvKV, AvLevelBadge, AvPageHeader, AvPanel, AvStatusBadge } from "@/components/av/AvUI";
import { useAvMotion } from "@/components/av/motion/AvMotionProvider";
import { AvPanelReveal, staggerProps } from "@/components/av/motion/AvMotion";
import AvTabs from "@/components/av/AvTabs";
import { EVENT_PAGE_SIZE, paginate, pagerItems } from "@/lib/av/eventPaging";
import s from "./AvPages.module.css";
import type { EventDetail, EventViewProps } from "@/lib/av/contracts";

type KindFilter = "all" | IncidentKind;
type StatusFilter = "all" | "open" | "closed";
type SceneFilter = "all" | Scene;

const SCENE_OPTIONS: Scene[] = ["campus", "hospital", "justice"];

/**
 * 窄屏卡片流开关（≤720px）。
 *
 * 为什么要用 hook 而不是纯 CSS：桌面态**不许存在**卡片流 DOM（BLF-1427 验收）。
 * SSR 一律按桌面渲染（false），水合后对齐真实断点；手机上首帧看到的是被 CSS
 * 隐藏的表格，紧接着（同一个宏任务里）换成卡片流。
 */
function useNarrowLayout(query = "(max-width: 720px)"): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(query);
    const sync = () => setNarrow(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, [query]);
  return narrow;
}

export default function EventView({ rows, detail, initialId, counts, userNames }: EventViewProps) {
  // 一层筛选：性质（分段控件） + 状态 / 场景（下拉）。页头之外不再有第二层 tab。
  const [kind, setKind] = useState<KindFilter>("all");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [scene, setScene] = useState<SceneFilter>("all");
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const { enabled: motionEnabled } = useAvMotion();
  const narrow = useNarrowLayout();

  // 选中事件由路由决定（/stream-monitor/event/:id 是深链接），不在本地复制一份状态
  const selectedId = initialId ?? rows[0]?.id ?? null;
  const selected = detail && detail.incident.id === selectedId ? detail : null;

  // 深链接落到第 5 页的事件时，列表要直接翻到那一页，而不是把选中行藏在别的页里
  const [page, setPage] = useState(() => {
    const index = rows.findIndex((row) => row.id === selectedId);
    return index < 0 ? 1 : Math.floor(index / EVENT_PAGE_SIZE) + 1;
  });

  const visible = useMemo(
    () =>
      rows.filter((row) => {
        if (kind !== "all" && row.kind !== kind) return false;
        if (status === "open" && row.status === "closed") return false;
        if (status === "closed" && row.status !== "closed") return false;
        if (scene !== "all" && row.scene !== scene) return false;
        return true;
      }),
    [rows, kind, status, scene],
  );

  const pageData = useMemo(() => paginate(visible, page), [visible, page]);

  // 筛选把行数筛少 / 翻页越界时，把页码拉回合法区间（不是在渲染里直接改 state）
  useEffect(() => {
    if (pageData.page !== page) setPage(pageData.page);
  }, [pageData.page, page]);

  // 任何一个筛选变化都回到第一页：否则「普通事件 + 第 8 页」会停在空页
  const changeKind = (value: KindFilter) => {
    setKind(value);
    setPage(1);
  };
  const changeStatus = (value: StatusFilter) => {
    setStatus(value);
    setPage(1);
  };
  const changeScene = (value: SceneFilter) => {
    setScene(value);
    setPage(1);
  };

  const gotoPage = (target: number) => setPage(Math.min(Math.max(1, target), pageData.pageCount));

  /**
   * 切换事件 = 服务端换一条详情。
   * 之所以不把所有事件的时间线一次性塞给客户端：那会把 HTML 从 ~140KB 撑到 1MB+。
   * 过渡期间用 pendingId 先把选中态点亮，避免点下去没反馈。
   *
   * ⚠️ `/event` 与 `/event/:id` 是两个路由，跳转会重挂载本组件（筛选 / 页码因此
   * 不会跟过去）。所以这里不能靠 effect 「筛选后自动选中下一行」—— 那会在刚选完
   * 筛选时立刻跳一次并重挂载，把筛选条件冲掉，看起来像筛选失效。
   */
  const select = useCallback(
    (id: string) => {
      if (id === selectedId) return;
      setPendingId(id);
      startTransition(() => {
        router.push(`/stream-monitor/event/${id}`);
      });
    },
    [router, selectedId, startTransition],
  );

  /*
    过渡态只在过渡**结束之后**才摘掉。

    之前把 setPendingId(null) 写在 startTransition 回调里：那个回调是同步执行的，
    于是 `setPendingId(id)` / `setPendingId(null)` 在同一次批处理里被合并成 null，
    行高亮与右侧 rail 的 aria-busy 从头到尾拿不到这个状态 —— 注释里承诺的
    「点下去立刻有反馈」实际上不存在。现在按 pending 落地时刻清，或者路由已经
    切到目标事件（selectedId 追上 pendingId）时清，两种情况都不会提前清。
  */
  useEffect(() => {
    if (pendingId === null) return;
    if (!pending || selectedId === pendingId) setPendingId(null);
  }, [pending, pendingId, selectedId]);

  /**
   * 选中事件不在**当前这一页**的列表里时，rail 与列表会互相矛盾，在 rail 上说明一句。
   *
   * 判定必须拿 `pageData.items`（这一页真正渲染的行）而不是 `visible`（筛选后的全集）：
   * 选中事件落在第 5 页、用户翻到第 1 页时，它仍在 `visible` 里，用 `visible` 判定的话
   * 这句说明永远不会出现 —— rail 显示了页面上根本没有的事件，还把用户晾在那里。
   */
  const selectedFilteredOut = Boolean(selected) && !pageData.items.some((row) => row.id === selectedId);

  const kindTabs = [
    { value: "all" as const, label: "全部", count: counts.total },
    { value: "alarm" as const, label: EVENT_KIND_LABEL.alarm, count: counts.alarm },
    { value: "routine" as const, label: EVENT_KIND_LABEL.routine, count: counts.routine },
  ];

  return (
    <div className={s.page} data-av-page="event">
      <AvPageHeader
        route="/stream-monitor/event"
        title="事件中心"
        /*
          标题下的这一句是本 Stage 的事实说明，不是文案清理（中文化 / 删冗余描述是 Stage 7 的事）：
          页面里已经同时有告警融合事件与巡检 / 上下线 / OTA 等普通事件，只写「多起告警融合成一起事件」
          就在选择「普通事件」筛选时与列表自相矛盾（Codex review 第 4 轮）。按 Stage 7 的约定写成数据型，
          两类计数直接来自 props，不写死。
        */
        subtitle={`告警融合 ${formatCount(counts.alarm)} 起 · 普通事件 ${formatCount(counts.routine)} 起，两类都可全程追溯`}
        aside={
          <div className={s.eventFilters}>
            <AvTabs items={kindTabs} value={kind} onChange={changeKind} ariaLabel="事件性质筛选" />
            <label className={s.eventSelect}>
              <span className={s.eventSelectLabel}>状态</span>
              <select
                value={status}
                onChange={(event) => changeStatus(event.target.value as StatusFilter)}
                aria-label="事件状态筛选"
              >
                <option value="all">全部（{formatCount(counts.total)}）</option>
                <option value="open">在办（{formatCount(counts.open)}）</option>
                <option value="closed">已闭环（{formatCount(counts.closed)}）</option>
              </select>
            </label>
            <label className={s.eventSelect}>
              <span className={s.eventSelectLabel}>场景</span>
              <select
                value={scene}
                onChange={(event) => changeScene(event.target.value as SceneFilter)}
                aria-label="事件场景筛选"
              >
                <option value="all">全部场景</option>
                {SCENE_OPTIONS.map((value) => (
                  <option key={value} value={value}>
                    {sceneMeta(value).fallbackName}
                  </option>
                ))}
              </select>
            </label>
          </div>
        }
      />

      <div className={s.splitWide}>
        <AvPanel
          title="事件列表"
          subtitle={`共 ${formatCount(counts.total)} 起 · 告警融合 ${formatCount(counts.alarm)} / 普通事件 ${formatCount(
            counts.routine,
          )} · 本页 ${pageData.items.length} 条`}
          icon="event"
          motionKey="event-list"
        >
          {visible.length === 0 ? (
            <AvEmpty title="没有匹配的事件" hint="切换事件性质、状态或场景筛选。" />
          ) : (
            <>
              {narrow && (
                <ul className={s.eventCards}>
                  {pageData.items.map((row, index) => (
                    <li key={`card-${row.id}`}>
                      <button
                        type="button"
                        className={`${s.eventCard} ${staggerProps(index, pageData.items.length, motionEnabled).className}`}
                        style={staggerProps(index, pageData.items.length, motionEnabled).style}
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
                          <span>{row.eventType}</span>
                          <span>{row.sceneName}</span>
                          <span title={row.room}>{row.room}</span>
                          <span className={s.mono}>{formatMinutes(row.durationMinutes, 0)}</span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              {/* 桌面只有表格这一套 DOM；卡片流只在 ≤720px 水合后渲染 */}
              {!narrow && (
                <div className={`${s.tableWrapper} ${s.eventTable}`}>
                  <table className={s.table}>
                    <thead>
                      <tr>
                        <th>事件编号</th>
                        <th>事件类型</th>
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
                      {pageData.items.map((row, index) => {
                        const stagger = staggerProps(index, pageData.items.length, motionEnabled);
                        return (
                          <tr
                            key={row.id}
                            className={`${s.eventTableRow} ${stagger.className}`}
                            style={stagger.style}
                            data-active={row.id === (pendingId ?? selectedId)}
                            onClick={() => select(row.id)}
                          >
                            <td className={s.mono}>
                              <button
                                type="button"
                                className={s.tableButton}
                                /*
                                  行本身也绑了 onClick。按钮不复用那次冒泡：点编号会触发
                                  两次 select() → 两次 router.push()。这里 stopPropagation
                                  由按钮自己走一遍，键盘/读屏路径与鼠标一致。
                                */
                                onClick={(event) => {
                                  event.stopPropagation();
                                  select(row.id);
                                }}
                              >
                                {row.id}
                              </button>
                            </td>
                            <td className={s.nowrap}>{row.eventType}</td>
                            <td>
                              <strong>{row.title}</strong>
                            </td>
                            <td>
                              <AvLevelBadge level={row.level} label={row.levelLabel} />
                            </td>
                            <td className={`${s.nowrap} ${s.colScene}`}>{row.sceneName}</td>
                            <td className={s.colPoint} title={row.room}>
                              {row.room}
                            </td>
                            <td className={`${s.num} ${s.colDuration}`}>{formatMinutes(row.durationMinutes, 0)}</td>
                            <td>
                              <AvStatusBadge tone={row.statusTone}>{row.statusLabel}</AvStatusBadge>
                            </td>
                            <td className={`${s.num} ${s.colEvidence}`}>{row.evidenceCount}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              <div className={s.alarmFoot}>
                <span className={s.softNote}>
                  {pageData.range
                    ? `第 ${formatCount(pageData.range.from)}–${formatCount(pageData.range.to)} 条 / 共 ${formatCount(
                        pageData.total,
                      )} 条 · 每页 ${EVENT_PAGE_SIZE} 条`
                    : "共 0 条"}
                </span>
                {pageData.pageCount > 1 && (
                  <nav className={s.pager} aria-label="事件列表分页">
                    <button
                      type="button"
                      className={s.pagerButton}
                      disabled={pageData.page <= 1}
                      onClick={() => gotoPage(pageData.page - 1)}
                    >
                      上一页
                    </button>
                    {pagerItems(pageData.page, pageData.pageCount).map((item, index) =>
                      item === "gap" ? (
                        <span key={`gap-${index}`} className={s.pagerGap} aria-hidden="true">
                          …
                        </span>
                      ) : (
                        <button
                          key={item}
                          type="button"
                          className={s.pagerButton}
                          data-active={item === pageData.page}
                          aria-current={item === pageData.page ? "page" : undefined}
                          aria-label={`第 ${item} 页`}
                          onClick={() => gotoPage(item)}
                        >
                          {item}
                        </button>
                      ),
                    )}
                    <button
                      type="button"
                      className={s.pagerButton}
                      disabled={pageData.page >= pageData.pageCount}
                      onClick={() => gotoPage(pageData.page + 1)}
                    >
                      下一页
                    </button>
                  </nav>
                )}
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
                      label: "性质",
                      value:
                        incidentKind(selected.incident) === "alarm"
                          ? EVENT_KIND_FULL_LABEL.alarm
                          : `${EVENT_KIND_FULL_LABEL.routine} · ${eventTypeText(selected.incident)}`,
                    },
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
                {selectedFilteredOut && (
                  <p className={s.softNote} style={{ marginTop: 10 }}>
                    当前选中事件不在本页列表里 —— 翻页或筛选都可能把它挪出本页，点列表中任意一行即可切到该事件。
                  </p>
                )}
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
                subtitle={
                  incidentKind(selected.incident) === "alarm"
                    ? "事件关联的告警与音视频证据"
                    : `普通事件 · 关联告警 0 条 / 时间线 ${selected.incident.timeline.length} 个运营节点`
                }
                icon="alarm"
                meta={`${selected.alarms.length} 条告警`}
                motionKey="event-evidence"
              >
                {selected.alarms.length === 0 ? (
                  <AvEmpty title="该事件暂无关联告警" hint="普通事件没有告警可追溯，证据只保留时间线与人工记录。" />
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
