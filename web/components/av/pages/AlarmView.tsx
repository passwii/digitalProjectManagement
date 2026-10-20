"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Alarm, AlarmStatus, AlarmsIndex, Scene } from "@/lib/av/types";
import { loadAlarmPage } from "@/lib/av/load";
import {
  ALARM_STATUS_LABEL,
  ALARM_STATUS_TONE,
  DEVICE_STATUS_LABEL,
  formatCount,
  formatMinutes,
  formatPercent,
  formatSeconds,
  levelMeta,
  sceneMeta,
  type AvTone,
} from "@/lib/av/labels";
import { toAbsolute, toRelative } from "@/lib/av/time";
import {
  AvDonut,
  type DonutDatum,
} from "@/components/av/AvCharts";
import {
  AvEmpty,
  AvKV,
  AvLevelBadge,
  AvPageHeader,
  AvPanel,
  AvStatusBadge,
} from "@/components/av/AvUI";
import AvGlyph from "@/components/av/AvGlyph";
import AvTabs from "@/components/av/AvTabs";
import { m } from "framer-motion";
import { closeDialogWithMotion, openDialogWithMotion } from "@/components/av/motion/AvDialog";
import { useStaggerIndex } from "@/components/av/motion/AvMotion";
import { AvInsertedItem, AvSkeleton } from "@/components/av/motion/AvCounter";
import s from "./AvPages.module.css";
import type { AlarmSite, AlarmViewProps } from "@/lib/av/contracts";

type LevelFilter = "all" | 1 | 2 | 3 | 4;
type SceneFilter = "all" | Scene;

const PAGE_SIZE = 50;

/**
 * 「加载下一页」时占位的行数。
 *
 * 写成字符串数组而不是 `[0, 1, 2]`：源码守卫把任何「三通道整数数组」当成颜色
 * （lib/avSourceGuard 的 canvas 兜底规则），`[0, 1, 2]` 会被误判成 `rgb(0,1,2)`。
 */
const SKELETON_ROWS = ["a", "b", "c"] as const;

function statusTone(status: AlarmStatus): AvTone {
  return ALARM_STATUS_TONE[status] as AvTone;
}

/**
 * 只读 `?q=` 的极小客户端组件。
 *
 * 它必须单独待在 Suspense 里：`useSearchParams` 会让它所在的子树跳过静态渲染，
 * 如果把整页包进去，`/stream-monitor/alarm` 的 50 条首屏就只剩 RSC payload，HTML 里是空的
 * —— 慢网下核心页要等整包 JS 才出现内容。
 */
function QuerySync({ onQuery }: { onQuery: (value: string) => void }) {
  const searchParams = useSearchParams();
  const urlQuery = searchParams.get("q") ?? "";
  useEffect(() => {
    onQuery(urlQuery);
  }, [urlQuery, onQuery]);
  return null;
}

/**
 * 告警中心。
 *
 * 分页：首屏 50 条由 Server Component 直接给（不占首屏独立请求），
 * 「加载更多」走 Stage 1 的 `loadAlarmPage(index, cursor)`，浏览器按 cursor 取分片。
 * 筛选只作用于**已加载**的告警，并在工具条上明说「已加载 N / 共 M」——
 * 全量筛选要扫 9 个分片（≈10MB），与演示站的首屏预算冲突。
 *
 * 深链接：`/stream-monitor/alarm/AL-00042` 由服务端按 id 定位后传入 `initialAlarm`，
 * 打开时把 URL 用 replaceState 对齐到当前告警，关闭时退回列表页地址。
 */
export default function AlarmView(props: AlarmViewProps) {
  const [alarms, setAlarms] = useState<Alarm[]>(props.initialAlarms);
  const [cursor, setCursor] = useState<string | null>(props.initialCursor);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [level, setLevel] = useState<LevelFilter>("all");
  const [scene, setScene] = useState<SceneFilter>("all");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(props.initialAlarm?.id ?? null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  /**
   * 新插入的告警 id（「加载下一页」后新增的那一批）。
   * 只有它们播「从顶部滑入」，已有条目靠 `layout` 让位 —— 否则每次翻页 50 条
   * 一起重播入场，看起来像整页刷新。
   */
  const freshIds = useRef<Set<string>>(new Set());

  /**
   * 顶部全局搜索回车会带 `?q=` 过来。
   *
   * `useSearchParams` 是 client bailout：谁在它上面，谁就不进静态 HTML。所以这里
   * **只把读取 ?q= 的一小块**放进了 Suspense，列表本身与首屏 50 条仍然随服务端
   * HTML 一起下发（整棵 AlarmView 包 Suspense 会让核心页退化成纯客户端渲染）。
   *
   * 回调必须用 useCallback 固定引用：它进 QuerySync 的 effect 依赖，每次渲染换新
   * 引用会让 effect 反复触发。
   */
  const applyUrlQuery = useCallback((value: string) => {
    // 无条件覆盖：清空搜索（?q= 消失或为空串）时列表必须复位，否则会出现
    // 「地址栏无 ?q=、屏幕还停在上一轮结果」的自相矛盾状态。
    setQuery(value);
  }, []);

  const selected = useMemo(() => {
    if (!selectedId) return null;
    return alarms.find((alarm) => alarm.id === selectedId) ?? (props.initialAlarm?.id === selectedId ? props.initialAlarm : null);
  }, [alarms, selectedId, props.initialAlarm]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (selected && !dialog.open) {
      openDialogWithMotion(dialog);
      document.documentElement.dataset.avDialog = "open";
    }
    // 关闭走 closeAlarm()（先播退场再 close），这里只兜底「外部把 selected 清空」的路径
    if (!selected && dialog.open && !dialog.dataset.closing) {
      closeDialogWithMotion(dialog, () => {
        delete document.documentElement.dataset.avDialog;
      });
    }
  }, [selected]);

  useEffect(() => () => {
    delete document.documentElement.dataset.avDialog;
  }, []);

  const siteById = useMemo(() => new Map(props.sites.map((site) => [site.id, site])), [props.sites]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return alarms.filter((alarm) => {
      if (level !== "all" && alarm.level !== level) return false;
      if (scene !== "all" && alarm.scene !== scene) return false;
      if (!needle) return true;
      return (
        alarm.title.toLowerCase().includes(needle) ||
        alarm.point_room.toLowerCase().includes(needle) ||
        alarm.id.toLowerCase().includes(needle) ||
        alarm.type_name.toLowerCase().includes(needle) ||
        (alarm.device_id ?? "").toLowerCase().includes(needle)
      );
    });
  }, [alarms, level, scene, query]);

  const levelCounts = useMemo(
    () =>
      ([1, 2, 3, 4] as const).map((value) => ({
        value: String(value) as "1" | "2" | "3" | "4",
        label: levelMeta(value).short,
        count: alarms.filter((alarm) => alarm.level === value).length,
      })),
    [alarms],
  );

  const loadMore = useCallback(async () => {
    if (!cursor || loading) return;
    setLoading(true);
    setError("");
    try {
      const page = await loadAlarmPage(props.index, cursor, PAGE_SIZE);
      setAlarms((previous) => {
        const seen = new Set(previous.map((alarm) => alarm.id));
        const added = page.alarms.filter((alarm) => !seen.has(alarm.id));
        for (const alarm of added) freshIds.current.add(alarm.id);
        return [...previous, ...added];
      });
      setCursor(page.next_cursor);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [cursor, loading, props.index]);

  const openAlarm = useCallback((alarm: Alarm) => {
    setSelectedId(alarm.id);
    window.history.replaceState(null, "", `/stream-monitor/alarm/${alarm.id}`);
  }, []);

  /**
   * 关闭抽屉：先播 160ms 的退场，再真的 close()。
   *
   * URL 与 state 在动画结束时才清 —— 与视觉同步，避免「地址栏已经回到列表、
   * 抽屉还在滑出」的割裂感（原生 dialog.close() 是同步的，直接调会把退场吃掉）。
   */
  const closeDialog = useCallback(() => {
    const dialog = dialogRef.current;
    closeDialogWithMotion(dialog, () => {
      delete document.documentElement.dataset.avDialog;
      setSelectedId(null);
      window.history.replaceState(null, "", "/stream-monitor/alarm");
    });
  }, []);

  const unhandledDonut: DonutDatum[] = props.unhandledBreakdown.map((row) => ({
    label: row.label,
    value: row.count,
    tone: row.tone,
  }));

  return (
    <div className={s.page} data-av-page="alarm">
      <Suspense fallback={null}>
        <QuerySync onQuery={applyUrlQuery} />
      </Suspense>

      <AvPageHeader
        route="/stream-monitor/alarm"
        title="告警中心"
        subtitle="实时检测 · 自动分级 · 闭环处置。级别与状态同时用颜色和文字表达，筛选只作用于已加载分页。"
        aside={
          <AvTabs
            items={[{ value: "all", label: "全部级别", count: alarms.length }, ...levelCounts]}
            value={level === "all" ? "all" : (String(level) as "1" | "2" | "3" | "4")}
            onChange={(value) => setLevel(value === "all" ? "all" : (Number(value) as 1 | 2 | 3 | 4))}
            ariaLabel="告警级别筛选"
          />
        }
      />

      <div className={s.splitWide}>
        <AvPanel
          title="实时告警列表"
          subtitle={`已加载 ${formatCount(alarms.length)} / 共 ${formatCount(props.total)} 条 · 每页 ${PAGE_SIZE} 条`}
          icon="alarm"
          meta={error ? "加载失败" : loading ? "加载中…" : "按需加载"}
          motionKey="alarm-list"
        >
          <div className={s.alarmToolbar}>
            <label className={s.alarmSearch}>
              <AvGlyph name="search" size={14} />
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索标题、点位、设备或告警编号"
                aria-label="搜索告警"
              />
            </label>
            <AvTabs
              items={[{ value: "all" as const, label: "全部场景" }, ...(["campus", "hospital", "justice"] as const).map((value) => ({
                value,
                label: sceneMeta(value).fallbackName,
              }))]}
              value={scene}
              onChange={setScene}
              ariaLabel="告警场景筛选"
            />
          </div>

          {filtered.length === 0 ? (
            <div style={{ marginTop: 12 }}>
              <AvEmpty title="没有匹配的告警" hint="清空搜索或切换级别 / 场景筛选；也可以继续加载下一页。" />
            </div>
          ) : (
            <m.ul className={s.alarmList} style={{ marginTop: 6 }}>
              {filtered.map((alarm, index) => (
                <AlarmRow
                  key={alarm.id}
                  alarm={alarm}
                  index={index}
                  total={filtered.length}
                  fresh={freshIds.current.has(alarm.id)}
                  onOpen={openAlarm}
                  siteName={siteById.get(alarm.site_id)?.name ?? alarm.site_id}
                />
              ))}
            </m.ul>
          )}

          {/* 加载下一页时占位：与真实告警卡同高，数据到达后交叉淡入（不跳高度） */}
          {loading && (
            <div className={s.alarmSkeleton} aria-hidden="true">
              {SKELETON_ROWS.map((row) => (
                <AvSkeleton key={row} className={s.alarmSkeletonRow} />
              ))}
            </div>
          )}

          <div className={s.alarmFoot}>
            <span className={s.softNote}>
              本页 {formatCount(filtered.length)} 条 · 共加载 {formatCount(alarms.length)} / {formatCount(props.total)}
            </span>
            {cursor ? (
              <button type="button" className={s.ghostButton} onClick={loadMore} disabled={loading}>
                {loading ? "加载中…" : "加载下一页"}
              </button>
            ) : (
              <span className={s.softNote}>已加载全部告警</span>
            )}
          </div>
          {error && <p className={s.softNote} role="alert">加载失败：{error}</p>}
        </AvPanel>

        <div className={s.railStack}>
          <AvPanel
            title="未处置分级"
            subtitle="口径：new + dispatched"
            icon="alarm"
            meta={`${formatCount(props.unhandled)} 条`}
            motionKey="alarm-unhandled"
          >
            <AvDonut
              data={unhandledDonut}
              centerValue={formatCount(props.unhandled)}
              centerLabel="未处置"
              height={168}
              label="未处置告警分级环形图"
            />
            <ul className={s.levelList}>
              {props.unhandledBreakdown.map((row) => (
                <li key={row.level} className={s.levelRow}>
                  <AvLevelBadge level={row.level} label={row.label} />
                  <span className={s.levelSpacer} />
                  <span className={s.levelTotal}>{formatCount(row.count)}</span>
                </li>
              ))}
            </ul>
          </AvPanel>

          <AvPanel title="处置指标" subtitle="近 180 天口径" icon="event" motionKey="alarm-metrics">
            <div className={s.railRow}>
              <span>平均响应</span>
              <strong>{formatMinutes(props.metrics.avgResponse)}</strong>
            </div>
            <div className={s.railRow}>
              <span>P50 / P90</span>
              <strong>{formatMinutes(props.metrics.p50, 0)} / {formatMinutes(props.metrics.p90, 0)}</strong>
            </div>
            <div className={s.railRow}>
              <span>误报率</span>
              <strong>{formatPercent(props.metrics.fpRate)}</strong>
            </div>
            <div className={s.railRow}>
              <span>已处置率</span>
              <strong>{formatPercent(((props.metrics.total - props.unhandled) / Math.max(1, props.metrics.total)) * 100)}</strong>
            </div>
          </AvPanel>

          <AvPanel
            title="告警剧本"
            subtitle="每个剧本都有完整时间线，可回看整段事件的完整处置过程"
            icon="capability"
            meta={`${props.scripts.length} 个`}
            motionKey="alarm-scripts"
          >
            <ul className={s.scriptList}>
              {props.scripts.map((script) => (
                <li key={script.id} className={s.scriptItem}>
                  <span className={s.scriptId}>{script.id}</span>
                  <span className={s.scriptTitle} title={script.title}>{script.title}</span>
                  <span className={s.scriptCount}>{script.alarmCount} 条</span>
                </li>
              ))}
            </ul>
          </AvPanel>
        </div>
      </div>

      <dialog
        ref={dialogRef}
        className={s.dialog}
        aria-label={selected ? `告警详情 ${selected.id}` : "告警详情"}
        onCancel={(event) => {
          event.preventDefault();
          closeDialog();
        }}
        onClose={() => {
          if (selectedId) closeDialog();
        }}
        onClick={(event) => {
          // 点遮罩关闭：原生 dialog 的点击目标是 dialog 自身时才算遮罩
          if (event.target === dialogRef.current) closeDialog();
        }}
      >
        {selected && (
          <AlarmDetail
            alarm={selected}
            site={siteById.get(selected.site_id)}
            incidentId={props.incidentOf[selected.id] ?? null}
            userNames={props.userNames}
            onClose={closeDialog}
          />
        )}
      </dialog>
    </div>
  );
}

/**
 * 一条告警卡（列表项）。
 *
 * 三种入场行为，合起来才是「告警中心该有的动效」：
 *   · 历史条目：首次渲染按 index 错峰淡入（前 10 条，`--av-stagger-list`）；
 *   · 新插入的条目（翻页进来的）：从上方 8px 滑入（`AvInsertedItem`，base）；
 *   · 筛选切换：整列表用 `layout` FLIP 重排 —— 卡片互相让位，**不是**整列先淡出再淡入
 *     （那会让"筛掉一半"看起来像页面重新加载）。
 *
 * 只有一级告警的色条呼吸（`AvLevelBadge` 内部按 level 判定）。
 */
function AlarmRow({
  alarm,
  index,
  total,
  fresh,
  onOpen,
  siteName,
}: {
  alarm: Alarm;
  index: number;
  total: number;
  fresh: boolean;
  onOpen: (alarm: Alarm) => void;
  siteName: string;
}) {
  const stagger = useStaggerIndex(index, total);
  /*
   * 入场形态在**首次挂载时**定下来，之后不再变。
   *
   * `fresh` 来自一个会累积的 ref：如果每帧都按它切组件类型（AvInsertedItem ↔ m.li），
   * 一次筛选把行移出再移回就会重播「从顶部插入」，看起来像又来了一条新告警。
   * 用 ref 记住首次的值，行的形态就稳定了。
   */
  const wasFresh = useRef(fresh).current;
  const card = (
    <button
      type="button"
      className={s.alarmCard}
      onClick={() => onOpen(alarm)}
      aria-label={`查看告警 ${alarm.id}：${alarm.title}`}
    >
      <AvLevelBadge level={alarm.level} label={alarm.level_label} downgraded={alarm.downgraded} />
      <span className={s.alarmCardMain}>
        <span className={s.alarmTitle}>{alarm.title}</span>
        <span className={s.alarmFacts}>
          <span>{alarm.point_room}</span>
          <span className={s.mono}>{alarm.device_id ?? "无关联设备"}</span>
          <span>{siteName}</span>
          <span className={s.mono}>{alarm.id}</span>
        </span>
      </span>
      <span className={s.alarmAside}>
        <span className={s.alarmAge}>{toRelative(alarm.ts_offset_minutes)}</span>
        <span className={s.alarmType}>{alarm.type_name}</span>
        <AvStatusBadge tone={statusTone(alarm.status)} swap={fresh}>
          {ALARM_STATUS_LABEL[alarm.status]}
        </AvStatusBadge>
      </span>
    </button>
  );

  if (wasFresh) {
    return <AvInsertedItem className={s.alarmItem}>{card}</AvInsertedItem>;
  }
  return (
    /*
     * `layout="position"` 而不是裸 `layout`：
     * 裸 layout 会连**尺寸**一起动画，行高固定的列表在重排时会先被压成
     * `scale(1, 0.27)` 再弹回来（实测帧里就是这个值），看起来像整列被挤扁了一下。
     * 我们只想让「卡片换位置」，所以只投影位置。
     */
    <m.li layout="position" className={`${s.alarmItem} ${stagger.className}`} style={stagger.style}>
      {card}
    </m.li>
  );
}

function AlarmDetail({
  alarm,
  site,
  incidentId,
  userNames,
  onClose,
}: {
  alarm: Alarm;
  site?: AlarmSite;
  incidentId: string | null;
  userNames: Record<string, string>;
  onClose: () => void;
}) {
  const meta = levelMeta(alarm.level);
  return (
    <>
      <div className={s.dialogHead}>
        <div className={s.dialogHeadMain}>
          <div className={s.dialogTitle}>
            <AvLevelBadge level={alarm.level} label={alarm.level_label} downgraded={alarm.downgraded} />
            <AvStatusBadge tone={statusTone(alarm.status)}>{ALARM_STATUS_LABEL[alarm.status]}</AvStatusBadge>
            <span className={s.softNote}>{alarm.id}</span>
          </div>
          <h2>{alarm.title}</h2>
        </div>
        <button type="button" className={s.dialogClose} onClick={onClose} aria-label="关闭告警详情">
          ✕
        </button>
      </div>

      <div className={s.dialogBody}>
        <p className={s.detailText}>{alarm.detail}</p>

        <div className={s.dialogSection}>
          <h3 className={s.dialogSectionTitle}>定位与设备</h3>
          <AvKV
            rows={[
              { label: "站点", value: `${site?.name ?? alarm.site_id} · ${site?.sceneName ?? sceneMeta(alarm.scene).fallbackName}` },
              { label: "点位", value: alarm.point_room },
              { label: "设备", value: alarm.device_id ?? "无关联设备" },
              { label: "类型", value: `${alarm.type_name}（${alarm.category}）` },
              { label: "发生时间", value: `${toAbsolute(alarm.ts_offset_minutes)}（${toRelative(alarm.ts_offset_minutes)}）` },
              { label: "置信度", value: formatPercent(alarm.confidence * 100, 0) },
              { label: "持续时长", value: formatSeconds(alarm.duration_seconds) },
              { label: "分贝", value: alarm.decibel == null ? "—" : `${alarm.decibel} dBA` },
            ]}
          />
        </div>

        {alarm.keywords.length > 0 && (
          <div className={s.dialogSection}>
            <h3 className={s.dialogSectionTitle}>命中关键词</h3>
            <ul className={s.keywordList}>
              {alarm.keywords.map((keyword) => (
                <li key={keyword} className={s.keywordChip}>{keyword}</li>
              ))}
            </ul>
          </div>
        )}

        <div className={s.dialogSection}>
          <h3 className={s.dialogSectionTitle}>证据链</h3>
          <AvKV
            rows={[
              { label: "音频时长", value: formatSeconds(alarm.evidence.audio_seconds) },
              { label: "视频片段", value: `${alarm.evidence.video_clips} 段` },
              { label: "频谱", value: alarm.evidence.spectrum_id ?? "无频谱落盘" },
              { label: "剧本", value: alarm.script_id ? `剧本 ${alarm.script_id}` : alarm.narrative_tier === "related" ? "事件关联" : "背景量" },
              { label: "命中规则", value: alarm.rule_hits?.length ? alarm.rule_hits.join(" · ") : "—" },
              { label: "关联事件", value: incidentId ? incidentId : "未融合为事件" },
            ]}
          />
        </div>

        <div className={s.dialogSection}>
          <h3 className={s.dialogSectionTitle}>处置</h3>
          {alarm.disposition ? (
            <AvKV
              rows={[
                { label: "动作", value: { close: "闭环", mark_false_positive: "标记误报", dispatch: "派发", escalate: "升级" }[alarm.disposition.action] },
                { label: "处置人", value: userNames[alarm.disposition.by] ?? alarm.disposition.by },
                { label: "处置时间", value: toAbsolute(alarm.disposition.at_offset_minutes) },
                { label: "备注", value: alarm.disposition.note },
              ]}
            />
          ) : (
            <p className={s.softNote}>尚未产生处置动作（状态：{ALARM_STATUS_LABEL[alarm.status]}）。</p>
          )}
          {alarm.false_positive_reason && (
            <p className={s.softNote}>误报原因：{alarm.false_positive_reason}</p>
          )}
        </div>

        <div className={s.dialogActions}>
          {/* 只有真的落了频谱才给入口：音频时长 > 0 但没有频谱时进去会看到别人的图 */}
          {alarm.evidence.spectrum_id ? (
            <Link className={s.primaryAction} href={`/stream-monitor/audio?alarm=${alarm.id}`}>
              音频分析（频谱 + 转写）
            </Link>
          ) : (
            <span className={s.secondaryAction} aria-disabled="true" title="该告警没有落盘频谱">
              无频谱证据
            </span>
          )}
          {incidentId && (
            <Link className={s.secondaryAction} href={`/stream-monitor/event/${incidentId}`}>
              查看关联事件
            </Link>
          )}
          <Link className={s.secondaryAction} href="/stream-monitor/alarm">
            返回告警列表
          </Link>
        </div>
      </div>
    </>
  );
}
