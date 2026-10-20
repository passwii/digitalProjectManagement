import type { Alarm, DatasetCore } from "@/lib/av/types";
import { ALARM_STATUS_LABEL, DEVICE_STATUS_LABEL, formatCount, formatPercent, levelMeta, sceneMeta } from "@/lib/av/labels";
import { toAbsolute, toRelative } from "@/lib/av/time";
import { AvEmpty, AvKV, AvLevelBadge, AvPageHeader, AvPanel } from "@/components/av/AvUI";
import type { AvExtremes } from "@/lib/av/server";
import s from "./AvPages.module.css";

/**
 * `/stream-monitor/__stress`：布局压力测试页（不进导航）。
 *
 * 目的不是演示，而是把 Stage 1 埋好的**最坏情况**一次性摊开，用来肉眼 + 截图确认
 * 布局不会在极端值下溢出：
 *   · 58 字标题（单行省略 / 多行折行都不能撑破卡片）
 *   · 33 字房间名（表格单元格、卡片标题）
 *   · 6 个关键词（关键词列表换行）
 *   · 0 告警点位、0 告警自然日、四级 + 近 1 小时 = 0（空态）
 *   · 五位数总量（告警总数）在 KPI / 数字列里的宽度
 */
export default function StressView({ core, extremes }: { core: DatasetCore; extremes: AvExtremes }) {
  const longestTitleSite = core.sites.find((site) => site.id === extremes.longestTitle.site_id);
  const roomSite = core.sites.find((site) => site.id === extremes.longestRoom.site_id);
  const sample: Alarm[] = [extremes.longestTitle, extremes.mostKeywords, extremes.longestRoom];

  return (
    <div className={s.page} data-av-page="stress">
      <AvPageHeader
        route="/stream-monitor/__stress"
        title="极端值校验"
        subtitle="极端值样本的渲染校验"
        aside={<span className={s.headerChip}>{formatCount(extremes.total)} 条告警全量索引</span>}
      />

      <div className={s.stressGrid}>
        <AvPanel title="极端值样本" subtitle="标题 / 房间名 / 关键词三处最坏情况" icon="alarm" motionKey="stress-extremes">
          <div className={s.stressRow}>
            <span className={s.stressLabel}>最长标题（{extremes.longestTitle.title.length} 字）</span>
            <span className={s.stressValue}>{extremes.longestTitle.title}</span>
            <span className={s.softNote}>
              {extremes.longestTitle.id} · {extremes.longestTitle.point_room} · {longestTitleSite?.name}
            </span>
          </div>
          <div className={s.stressRow}>
            <span className={s.stressLabel}>最长房间名（{extremes.longestRoom.point_room.length} 字）</span>
            <span className={s.stressValue}>{extremes.longestRoom.point_room}</span>
            <span className={s.softNote}>
              {extremes.longestRoom.id} · {roomSite?.name} · {extremes.longestRoom.point_id}
            </span>
          </div>
          <div className={s.stressRow}>
            <span className={s.stressLabel}>最多关键词（{extremes.mostKeywords.keywords.length} 个）</span>
            <ul className={s.keywordList}>
              {extremes.mostKeywords.keywords.map((keyword) => (
                <li key={keyword} className={s.keywordChip}>{keyword}</li>
              ))}
            </ul>
            <span className={s.softNote}>{extremes.mostKeywords.id} · {extremes.mostKeywords.title}</span>
          </div>
        </AvPanel>

        <AvPanel title="数字宽度" subtitle="五位数、百分比、分钟、天数" icon="overview" motionKey="stress-numbers">
          <AvKV
            rows={[
              { label: "告警总数", value: formatCount(extremes.total) },
              { label: "今日告警", value: formatCount(core.kpi.alarm_natural_day) },
              { label: "在办事件", value: formatCount(core.kpi.incident_open) },
              { label: "设备总数", value: formatCount(core.kpi.device_total) },
              { label: "在线率", value: formatPercent(core.kpi.online_rate) },
              { label: "误报率", value: formatPercent(core.kpi.false_positive_rate) },
              { label: "平均响应", value: `${core.kpi.avg_response_minutes.toFixed(1)} 分钟` },
              { label: "最长偏移", value: `${formatCount(core.alarmsIndex.shards.at(-1)?.to_offset_minutes ?? 0)} 分钟` },
            ]}
          />
        </AvPanel>
      </div>

      <AvPanel
        title="告警卡：极端样本"
        subtitle="六要素一行读全的极限情况"
        icon="alarm"
        meta="3 条样本"
        motionKey="stress-cards"
      >
        <ul className={s.alarmList}>
          {sample.map((alarm) => (
            <li key={alarm.id} className={s.alarmCard} data-motion="stress-card" data-motion-key={alarm.id}>
              <AvLevelBadge level={alarm.level} label={alarm.level_label} downgraded={alarm.downgraded} />
              <span className={s.alarmCardMain}>
                <span className={s.alarmTitle} title={alarm.title}>{alarm.title}</span>
                <span className={s.alarmFacts}>
                  <span>{alarm.point_room}</span>
                  <span className={s.mono}>{alarm.device_id ?? "无关联设备"}</span>
                  <span>{core.sites.find((site) => site.id === alarm.site_id)?.name}</span>
                  <span className={s.mono}>{alarm.id}</span>
                  <span className={s.mono}>{toAbsolute(alarm.ts_offset_minutes)}</span>
                </span>
              </span>
              <span className={s.alarmAside}>
                <span className={s.alarmAge}>{toRelative(alarm.ts_offset_minutes)}</span>
                <span className={s.alarmType}>{alarm.type_name}</span>
                <span className={s.alarmType}>{ALARM_STATUS_LABEL[alarm.status]}</span>
              </span>
            </li>
          ))}
        </ul>
      </AvPanel>

      <div className={s.gridTwo}>
        <AvPanel title="空态：0 告警点位" subtitle="180 天里从未产生告警的点位" icon="device" meta={`${extremes.zeroAlarmPoints.length} 个`} motionKey="stress-zero-points">
          {extremes.zeroAlarmPoints.length === 0 ? (
            <AvEmpty title="没有 0 告警点位" hint="当前每个点位都至少产生过一条告警。" />
          ) : (
            <ul className={s.attentionList}>
              {extremes.zeroAlarmPoints.map((point) => (
                <li key={point.id} className={s.attentionItem}>
                  <div className={s.attentionTop}>
                    <strong title={point.room}>{point.room}</strong>
                    <span className={s.tagChip}>0 条</span>
                  </div>
                  <span className={s.attentionMeta}>
                    <span>{point.id}</span>
                    <span>{core.sites.find((site) => site.id === point.siteId)?.name ?? point.siteId}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </AvPanel>

        <AvPanel title="空态：0 告警自然日" subtitle="180 天里没有任何告警的日期" icon="event" meta={`${extremes.emptyDays.length} 天`} motionKey="stress-empty-days">
          {extremes.emptyDays.length === 0 ? (
            <AvEmpty title="每天都有告警" hint="当前覆盖的日期里没有 0 告警的自然日。" />
          ) : (
            <ul className={s.attentionList}>
              {extremes.emptyDays.map((day) => (
                <li key={day.date} className={s.attentionItem}>
                  <div className={s.attentionTop}>
                    <strong>{day.date}</strong>
                    <span className={s.tagChip}>0 条</span>
                  </div>
                  <span className={s.attentionMeta}>
                    <span>距锚点 {day.dayOffset} 天</span>
                    <span>空态组件：AvEmpty</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </AvPanel>
      </div>

      <AvPanel
        title="空态：四级 + 近 1 小时"
        subtitle="已知为 0 的组合，用来钉住筛选后的空列表渲染"
        icon="capability"
        meta={`${extremes.level4LastHour} 条`}
        motionKey="stress-level4"
      >
        {extremes.level4LastHour === 0 ? (
          <AvEmpty title="四级告警 · 近 1 小时：0 条" hint="筛选结果为空时，列表区必须显示明确空态，而不是一片空白。" />
        ) : (
          <p className={s.softNote}>该组合当前有 {extremes.level4LastHour} 条，比预期多。</p>
        )}
        <div className={s.firmwareRow}>
          <span className={s.softNote}>分级合计</span>
          {[1, 2, 3, 4].map((level) => (
            <span key={level} className={s.tagChip}>
              {levelMeta(level as 1 | 2 | 3 | 4).short} {formatCount(extremes.levelCounts[level] ?? 0)}
            </span>
          ))}
        </div>
      </AvPanel>

      <AvPanel title="状态与剧本分布" subtitle="全量扫描的交叉校验" icon="event" motionKey="stress-distribution">
        <div className={s.gridTwo}>
          <AvKV
            rows={Object.entries(extremes.statusCounts).map(([status, count]) => ({
              label: ALARM_STATUS_LABEL[status as keyof typeof ALARM_STATUS_LABEL] ?? status,
              value: formatCount(count),
            }))}
          />
          <AvKV
            rows={[
              { label: "误报标记", value: formatCount(extremes.falsePositive) },
              { label: "误报观察降级", value: formatCount(extremes.downgraded) },
              { label: "剧本告警", value: formatCount(extremes.scriptAlarms.length) },
              {
                label: "剧本分布",
                value: Array.from(new Set(extremes.scriptAlarms.map((alarm) => alarm.script_id)))
                  .map((id) => `${id}：${extremes.scriptAlarms.filter((alarm) => alarm.script_id === id).length}`)
                  .join(" · "),
              },
              {
                label: "设备状态",
                value: core.deviceStats.by_status
                  .map((row) => `${DEVICE_STATUS_LABEL[row.status]} ${row.count}`)
                  .join(" · "),
              },
              {
                label: "场景",
                value: core.scenes.map((scene) => `${sceneMeta(scene.id).fallbackName} ${formatCount(scene.kpi.total_alarms)}`).join(" · "),
              },
            ]}
          />
        </div>
      </AvPanel>
    </div>
  );
}
