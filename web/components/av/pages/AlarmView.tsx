"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  AvTabs,
} from "@/components/av/AvUI";
import AvGlyph from "@/components/av/AvGlyph";
import s from "./AvPages.module.css";
import type { AlarmSite, AlarmViewProps } from "@/lib/av/contracts";

type LevelFilter = "all" | 1 | 2 | 3 | 4;
type SceneFilter = "all" | Scene;

const PAGE_SIZE = 50;

function statusTone(status: AlarmStatus): AvTone {
  return ALARM_STATUS_TONE[status] as AvTone;
}

/**
 * 告警中心。
 *
 * 分页：首屏 50 条由 Server Component 直接给（不占首屏独立请求），
 * 「加载更多」走 Stage 1 的 `loadAlarmPage(index, cursor)`，浏览器按 cursor 取分片。
 * 筛选只作用于**已加载**的告警，并在工具条上明说「已加载 N / 共 M」——
 * 全量筛选要扫 9 个分片（≈10MB），与演示站的首屏预算冲突。
 *
 * 深链接：`/av/alarm/AL-00042` 由服务端按 id 定位后传入 `initialAlarm`，
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
   * 顶部全局搜索回车会带 `?q=` 过来。
   *
   * 用 `useSearchParams` 而不是 mount 时读一次 `window.location.search`：从 /av/alarm
   * 再搜一次是同路由客户端跳转，组件不卸载，只读一次的话第二次搜索不会生效。
   * 页面侧用 Suspense 包住（静态路由要求）。
   */
  const searchParams = useSearchParams();
  const urlQuery = searchParams.get("q") ?? "";
  useEffect(() => {
    if (urlQuery) setQuery(urlQuery);
  }, [urlQuery]);

  const selected = useMemo(() => {
    if (!selectedId) return null;
    return alarms.find((alarm) => alarm.id === selectedId) ?? (props.initialAlarm?.id === selectedId ? props.initialAlarm : null);
  }, [alarms, selectedId, props.initialAlarm]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (selected && !dialog.open) {
      dialog.showModal();
      document.documentElement.dataset.avDialog = "open";
    }
    if (!selected && dialog.open) {
      dialog.close();
      delete document.documentElement.dataset.avDialog;
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
        return [...previous, ...page.alarms.filter((alarm) => !seen.has(alarm.id))];
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
    window.history.replaceState(null, "", `/av/alarm/${alarm.id}`);
  }, []);

  const closeDialog = useCallback(() => {
    setSelectedId(null);
    window.history.replaceState(null, "", "/av/alarm");
  }, []);

  const unhandledDonut: DonutDatum[] = props.unhandledBreakdown.map((row) => ({
    label: row.label,
    value: row.count,
    tone: row.tone,
  }));

  return (
    <div className={s.page} data-av-page="alarm">
      <AvPageHeader
        route="/av/alarm"
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
          meta={error ? "加载失败" : loading ? "加载中…" : "分片分页"}
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
            <ul className={s.alarmList} style={{ marginTop: 6 }}>
              {filtered.map((alarm) => (
                <li key={alarm.id}>
                  <button
                    type="button"
                    className={s.alarmCard}
                    onClick={() => openAlarm(alarm)}
                    aria-label={`查看告警 ${alarm.id}：${alarm.title}`}
                  >
                    <AvLevelBadge level={alarm.level} label={alarm.level_label} downgraded={alarm.downgraded} />
                    <span className={s.alarmCardMain}>
                      <span className={s.alarmTitle}>{alarm.title}</span>
                      <span className={s.alarmFacts}>
                        <span>{alarm.point_room}</span>
                        <span className={s.mono}>{alarm.device_id ?? "无关联设备"}</span>
                        <span>{siteById.get(alarm.site_id)?.name ?? alarm.site_id}</span>
                        <span className={s.mono}>{alarm.id}</span>
                      </span>
                    </span>
                    <span className={s.alarmAside}>
                      <span className={s.alarmAge}>{toRelative(alarm.ts_offset_minutes)}</span>
                      <span className={s.alarmType}>{alarm.type_name}</span>
                      <AvStatusBadge tone={statusTone(alarm.status)}>{ALARM_STATUS_LABEL[alarm.status]}</AvStatusBadge>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
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
              <span className={s.softNote}>已加载全部分片</span>
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
            title="演示剧本"
            subtitle="每个剧本都有完整时间线，供 Stage 3 演示路径使用"
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
            <Link className={s.primaryAction} href={`/av/audio?alarm=${alarm.id}`}>
              音频分析（频谱 + 转写）
            </Link>
          ) : (
            <span className={s.secondaryAction} aria-disabled="true" title="该告警没有落盘频谱">
              无频谱证据
            </span>
          )}
          {incidentId && (
            <Link className={s.secondaryAction} href={`/av/event/${incidentId}`}>
              查看关联事件
            </Link>
          )}
          <Link className={s.secondaryAction} href="/av/alarm">
            返回告警列表
          </Link>
        </div>
      </div>
    </>
  );
}
