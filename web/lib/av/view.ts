/**
 * 派生视图模型：把 `/stream-monitor-data/*.json` 的原始结构整理成页面直接可渲染的形状。
 *
 * 为什么单独一层：
 *   · 页面组件只负责排版，不做聚合；数字口径集中在纯函数里，能被 node:test 直接钉住；
 *   · 同一份聚合在多个页面复用（总览 / 场景卡 / 能力页），避免三处各算一遍然后慢慢漂移。
 *
 * 约定：本文件是**纯函数**，不读文件、不碰 DOM。数据从参数进来，测试可以传真实核心数据。
 */
import type {
  Alarm,
  Algorithm,
  DatasetCore,
  Device,
  Incident,
  Kpi,
  LevelCount,
  OverviewKpiDef,
  OverviewRange,
  OverviewRangeKey,
  OverviewTotals,
  Point,
  Scene,
  Trends,
} from "./types";
import {
  AV_LEVEL_ORDER,
  AV_SCENE_ORDER,
  compactAge,
  formatCount,
  formatPercent,
  levelMeta,
  sceneMeta,
  type AvTone,
} from "./labels";
import type { AvSeriesTone } from "./tone";

export interface KpiCard {
  key: string;
  label: string;
  value: string;
  unit?: string;
  detail: string;
  tone: AvTone;
  /** 章节标题下的口径说明，避免把「滚动 24 小时」读成「今日」 */
  note?: string;
}

export interface MetricDatum {
  label: string;
  value: number;
  tone: AvTone;
}

/** 总览首屏的四张主卡（口径见 Stage 1 字段表）。 */
export function overviewKpis(kpi: Kpi): KpiCard[] {
  const unhandled = kpi.alarm_unhandled_breakdown
    .filter((row) => row.count > 0)
    .map((row) => `${levelMeta(row.level).short} ${formatCount(row.count)}`)
    .join(" · ");

  return [
    {
      key: "device-online",
      label: "设备在线率",
      value: kpi.online_rate.toFixed(1),
      unit: "%",
      detail: `${formatCount(kpi.device_online)} / ${formatCount(kpi.device_total)} 台在线`,
      tone: "signal",
      note: `离线 ${formatCount(kpi.device_offline)} · 维护 ${formatCount(kpi.device_maintenance)}`,
    },
    {
      key: "alarm-today",
      label: "今日告警",
      value: formatCount(kpi.alarm_natural_day),
      unit: "条",
      detail: `未处置 ${formatCount(kpi.alarm_unhandled)} 条`,
      tone: "danger",
      note: unhandled ? `分级：${unhandled}` : "全部已处置",
    },
    {
      key: "incident-open",
      label: "在办事件",
      value: formatCount(kpi.incident_open),
      unit: "起",
      detail: `累计 ${formatCount(kpi.incident_total)} 起`,
      tone: "violet",
      note: "跨告警融合后的人工确认单元",
    },
    {
      key: "response",
      label: "平均响应",
      value: kpi.avg_response_minutes.toFixed(1),
      unit: "分钟",
      detail: `P90 ${kpi.response_p90_minutes.toFixed(1)} 分钟`,
      tone: "warning",
      note: `误报率 ${kpi.false_positive_rate.toFixed(1)}%`,
    },
  ];
}

/** 趋势图横轴：把「新 → 旧」的桶翻成时间正序，折线才从左到右读。 */
export function trendSeries(trends: Trends): { label: string; alarms: number; handled: number }[] {
  return [...trends.hourly]
    .reverse()
    .map((bucket) => ({
      label: bucket.label || `${String(bucket.clock_hour).padStart(2, "0")}:00`,
      alarms: bucket.alarms,
      handled: bucket.handled,
    }));
}

/** 7 天日趋势（同样翻成时间正序）。 */
export function dailySeries(trends: Trends): { label: string; alarms: number; incidents: number }[] {
  return [...trends.daily].reverse().map((bucket) => ({
    label: bucket.label,
    alarms: bucket.alarms,
    incidents: bucket.incidents,
  }));
}

/**
 * 热力图：`heatmap` 已按 (day asc, hour asc) 排好，是唯一「旧 → 新」的数组。
 * 这里按自然日分组给 CSS grid 用，避免页面里再写一次分组逻辑。
 */
export function heatmapDays(trends: Trends): { day: number; cells: { hour: number; count: number }[] }[] {
  const days = new Map<number, { hour: number; count: number }[]>();
  for (const cell of trends.heatmap) {
    const list = days.get(cell.day) ?? [];
    list.push({ hour: cell.hour, count: cell.count });
    days.set(cell.day, list);
  }
  return Array.from(days.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([day, cells]) => ({ day, cells: [...cells].sort((a, b) => a.hour - b.hour) }));
}

/** 告警分级：今日全量 + 未处置拆分两列一起给，页面不再自己算。 */
export function levelBreakdown(kpi: Kpi): { level: number; label: string; total: number; unhandled: number; tone: AvTone }[] {
  const unhandled = new Map<number, number>(
    kpi.alarm_unhandled_breakdown.map((row: LevelCount) => [row.level, row.count]),
  );
  const today = new Map<number, number>(kpi.level_breakdown_today.map((row) => [row.level, row.count]));
  return AV_LEVEL_ORDER.map((level) => ({
    level,
    label: levelMeta(level).label,
    total: today.get(level) ?? 0,
    unhandled: unhandled.get(level) ?? 0,
    tone: levelMeta(level).tone,
  }));
}

/**
 * 场景分布：数量来自 `kpi.scene_breakdown_today`，颜色由前端映射。
 *
 * 注意数据里的 `name` 是**站点名**（示范第一中学 / 市人民医院 / 市执法办案管理中心），
 * 直接放在「场景分布」图例里会读成三个站点而不是三个场景。这里用场景名做主标签，
 * 站点名作为副标签单独给，页面想显示哪个都拿得到。
 */
export function sceneDistribution(kpi: Kpi): (MetricDatum & { site: string; scene: Scene })[] {
  return kpi.scene_breakdown_today.map((row) => ({
    label: sceneMeta(row.scene).fallbackName,
    value: row.count,
    tone: sceneMeta(row.scene).tone,
    site: row.name,
    scene: row.scene,
  }));
}

/** 场景卡：三场景的 slogan / 覆盖应用 / 点位与设备规模。 */
export function sceneCards(core: DatasetCore) {
  return AV_SCENE_ORDER.map((scene) => {
    const def = core.scenes.find((item) => item.id === scene);
    const meta = sceneMeta(scene);
    const breakdown = core.kpi.scene_breakdown_today.find((row) => row.scene === scene);
    return {
      scene,
      name: def?.name ?? meta.fallbackName,
      code: def?.code ?? "",
      slogan: def?.slogan ?? "",
      desc: def?.desc ?? "",
      apps: def?.apps ?? [],
      points: def?.kpi.points ?? 0,
      devices: def?.kpi.devices ?? 0,
      todayAlarms: breakdown?.count ?? def?.kpi.today_alarms ?? 0,
      totalAlarms: def?.kpi.total_alarms ?? 0,
      tone: meta.tone,
    };
  });
}

/** GPU 资源池：每张卡的利用率 + 显存；mode 直接来自数据。 */
export function gpuCards(kpi: Kpi) {
  return kpi.gpu.cards.map((card) => ({
    index: card.index,
    utilization: card.utilization,
    vram: card.vram_used_gb,
    mode: card.mode,
    temperature: card.temperature,
    tone: (card.utilization >= 85 ? "warning" : "signal") as AvTone,
  }));
}

/** 告警类型排行（右侧「高频告警类型」）。 */
export function typeRanking(core: DatasetCore, limit = 6) {
  return core.rankings.types.slice(0, limit).map((row) => ({
    code: row.type_code,
    name: row.type_name,
    category: row.category,
    count: row.count,
  }));
}

/** 点位排行（高频点位 / 高风险点位）。 */
export function pointRanking(core: DatasetCore, limit = 6) {
  return core.rankings.points.slice(0, limit).map((row) => ({
    id: row.point_id,
    room: row.point_room,
    total: row.total,
    level1: row.level1,
    fpRate: row.fp_rate,
  }));
}

/**
 * 实时监控通道：优先挑「在线 + 高信号」的设备，音频视频都要有。
 * 排序键全部来自数据（signal、kind、status），没有写死的设备 id。
 */
export function monitorChannels(devices: Device[], limit = 6) {
  const score = (device: Device) =>
    (device.status === "online" ? 1000 : 0) + device.signal - (device.kind === "gateway" ? 400 : 0);
  const ordered = [...devices].sort((a, b) => score(b) - score(a));
  const video = ordered.filter((device) => device.kind === "video");
  const audio = ordered.filter((device) => device.kind === "audio");
  const picked: Device[] = [];
  // 2 路视频 + 4 路音频：先各取，凑不满再用剩余设备补，保证 6 格永远是满的
  picked.push(...video.slice(0, 2), ...audio.slice(0, 4));
  for (const device of ordered) {
    if (picked.length >= limit) break;
    if (!picked.includes(device)) picked.push(device);
  }
  return picked.slice(0, limit);
}

/**
 * 信号序列 → 波形柱高（0–1）。
 *
 * 两条显示口径：
 *   · 离线设备是 0 哨兵，统一压到最低一根（不能让「没信号」看起来像满格）；
 *   · 在线设备**按自身序列的 min/max 归一**，而不是按绝对 dBm 归一 —— 实测同一台
 *     设备的 24 个采样都落在 -52..-98 之间，若用绝对区间映射，柱子高度差不到 20%，
 *     看起来像一条平线。这一段是纯展示变换，不改数据。
 * 再做一次 3 点滑动平均：原始序列是逐点抖动，直接画会像噪点而不是「波形」。
 */
export function waveformOf(device: Device, bars = 28): number[] {
  const series = [...device.signal_series]
    .sort((a, b) => b.at_offset_minutes - a.at_offset_minutes)
    .slice(-bars);
  if (!series.length) return Array.from({ length: bars }, () => 0.12);
  if (device.status === "offline") return Array.from({ length: bars }, () => 0.08);

  const values = series.map((sample) => sample.rssi_dbm);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const normalized = values.map((value) => 0.18 + ((value - min) / span) * 0.82);
  return normalized.map((value, index) => {
    const prev = normalized[Math.max(0, index - 1)];
    const next = normalized[Math.min(normalized.length - 1, index + 1)];
    return Math.min(1, Math.max(0.12, (prev + value + next) / 3));
  });
}

/**
 * 设备页的离线 / 维护清单：按「最近心跳」倒序，最久没心跳的排最前。
 *
 * 注意排序键是**最近心跳年龄**（离线设备 ≈ 离线时长，维护设备只是最近一次心跳），
 * 不是「离线时长」。之前面板副标题写「按离线时长倒序」、行内又统一写「离线 N 小时」，
 * 维护中的设备会变成「维护中 + 离线 8 小时」这种自相矛盾的文案。
 */
export function attentionDevices(devices: Device[]): Device[] {
  return devices
    .filter((device) => device.status !== "online")
    .sort((a, b) => b.last_heartbeat_offset_minutes - a.last_heartbeat_offset_minutes);
}

/**
 * 关注清单里的时间文案：按状态分支。
 *   · 离线 → 「离线 8 小时」（心跳年龄等价于离线时长）
 *   · 维护中 → 「最近心跳 8 小时前」（不是离线，别写「离线」）
 */
export function attentionAgeText(device: Pick<Device, "status" | "last_heartbeat_offset_minutes">): string {
  const age = compactAge(device.last_heartbeat_offset_minutes);
  return device.status === "offline" ? `离线 ${age}` : `最近心跳 ${age}前`;
}

export interface AlarmFilterCounts {
  all: number;
  levels: { level: number; label: string; count: number; tone: AvTone }[];
  scenes: { scene: Scene; name: string; count: number }[];
}

/**
 * 告警筛选条的计数。
 * 口径说明：这里统计的是**当前页**（/alarm 首屏 ALARM_PAGE_SIZE = 12 条）的分布，不是全量 14,366 条 ——
 * 全量统计要扫 9 个分片，与「首屏 ≤ 1MB」的预算冲突。页面上会用「本页」标注。
 */
export function alarmPageCounts(alarms: Alarm[]): AlarmFilterCounts {
  return {
    all: alarms.length,
    levels: AV_LEVEL_ORDER.map((level) => ({
      level,
      label: levelMeta(level).label,
      count: alarms.filter((alarm) => alarm.level === level).length,
      tone: levelMeta(level).tone,
    })),
    scenes: AV_SCENE_ORDER.map((scene) => ({
      scene,
      name: sceneMeta(scene).fallbackName,
      count: alarms.filter((alarm) => alarm.scene === scene).length,
    })),
  };
}

/** 告警卡六要素：级别 / 标题 / 位置 / 设备 / 相对时间 / 类型。缺哪个都会让值班员多点一次。 */
export interface AlarmCardModel {
  id: string;
  level: number;
  levelLabel: string;
  levelShort: string;
  tone: AvTone;
  title: string;
  room: string;
  deviceId: string | null;
  siteName: string;
  sceneName: string;
  offsetMinutes: number;
  typeName: string;
  category: string;
  statusLabel: string;
  statusTone: AvTone;
  hasAudio: boolean;
  hasVideo: boolean;
}

export function alarmCard(alarm: Alarm, core: DatasetCore): AlarmCardModel {
  const site = core.sites.find((item) => item.id === alarm.site_id);
  const meta = levelMeta(alarm.level);
  return {
    id: alarm.id,
    level: alarm.level,
    levelLabel: alarm.level_label || meta.label,
    levelShort: meta.short,
    tone: meta.tone,
    title: alarm.title,
    room: alarm.point_room,
    deviceId: alarm.device_id,
    siteName: site?.name ?? alarm.site_id,
    sceneName: sceneMeta(alarm.scene).fallbackName,
    offsetMinutes: alarm.ts_offset_minutes,
    typeName: alarm.type_name,
    category: alarm.category,
    statusLabel: alarm.status === "false_positive" ? "误报" : statusLabelOf(alarm.status),
    statusTone: statusToneOf(alarm.status),
    hasAudio: alarm.evidence.audio_seconds > 0 || Boolean(alarm.evidence.spectrum_id),
    hasVideo: alarm.evidence.video_clips > 0,
  };
}

function statusLabelOf(status: Alarm["status"]): string {
  return (
    {
      new: "待确认",
      acknowledged: "已确认",
      dispatched: "处置中",
      closed: "已闭环",
      false_positive: "误报",
    } as Record<Alarm["status"], string>
  )[status];
}

function statusToneOf(status: Alarm["status"]): AvTone {
  return (
    {
      new: "danger",
      acknowledged: "warning",
      dispatched: "signal",
      closed: "success",
      false_positive: "neutral",
    } as Record<Alarm["status"], AvTone>
  )[status];
}

/** 事件列表行：编号 / 级别 / 场景 / 点位 / 时长 / 状态 / 证据数。 */
export function incidentRows(incidents: Incident[], core: DatasetCore) {
  return incidents.map((incident) => {
    const site = core.sites.find((item) => item.id === incident.site_id);
    return {
      id: incident.id,
      title: incident.title,
      level: incident.level,
      levelLabel: incident.level_label,
      levelShort: levelMeta(incident.level).short,
      tone: levelMeta(incident.level).tone,
      scene: incident.scene,
      sceneName: sceneMeta(incident.scene).fallbackName,
      siteName: site?.name ?? incident.site_id,
      room: incident.point_room,
      durationMinutes: incident.duration_minutes,
      status: incident.status,
      statusLabel: statusLabelOf(incident.status),
      statusTone: statusToneOf(incident.status),
      evidenceCount: incident.evidence_count,
      alarmCount: incident.alarm_count,
      startedOffsetMinutes: incident.started_offset_minutes,
      endedOffsetMinutes: incident.ended_offset_minutes,
    };
  });
}

/** 设备状态分布（环形图 + 图例）。 */
export function deviceStatusDistribution(core: DatasetCore) {
  return core.deviceStats.by_status.map((row) => ({
    status: row.status,
    count: row.count,
    label: { online: "在线", offline: "离线", maintenance: "维护中" }[row.status],
    tone: ({ online: "success", offline: "danger", maintenance: "warning" } as const)[row.status],
  }));
}

/** 站点在线情况：by_site 只有 total / online，离线 = 差值。 */
export function siteHealth(core: DatasetCore) {
  return core.deviceStats.by_site.map((row) => {
    const site = core.sites.find((item) => item.id === row.site_id);
    return {
      id: row.site_id,
      name: site?.name ?? row.site_id,
      scene: site?.scene ?? "campus",
      total: row.total,
      online: row.online,
      offline: row.total - row.online,
      rate: row.total ? (row.online / row.total) * 100 : 0,
    };
  });
}

/** 能力页：按算法类别分组（矩阵的行）。 */
export function algorithmMatrix(algorithms: { categories: { code: string; name: string; count: number }[]; algorithms: Algorithm[] }) {
  return algorithms.categories.map((category) => {
    const items = algorithms.algorithms.filter((algorithm) => algorithm.category === category.code);
    return {
      code: category.code,
      name: category.name,
      count: items.length,
      totalCalls: items.reduce((sum, algorithm) => sum + algorithm.calls_today, 0),
      totalVram: items.reduce((sum, algorithm) => sum + algorithm.vram_gb, 0),
      algorithms: items,
    };
  });
}

/** 点位索引：详情抽屉里点位置 / 风险权重显示。 */
export function pointLookup(points: Point[]): Map<string, Point> {
  return new Map(points.map((point) => [point.id, point]));
}

/** 首屏体积预算（AC10）：把实际加载的核心文件字节数算出来，页脚与单测都用它。 */
export const CORE_FILES = [
  "index.json",
  "alarms-index.json",
  "org.json",
  "sites.json",
  "points.json",
  "devices.json",
  "device-stats.json",
  "users.json",
  "incidents.json",
  "kpi.json",
  "trends.json",
  "rankings.json",
  "scenes.json",
  "algorithms.json",
  "rules.json",
  "audit-logs.json",
  "transcripts.json",
] as const;


// ---------------------------------------------------------------------------
// 总览 · 三档时间范围（BLF-1424）
// ---------------------------------------------------------------------------

/**
 * 趋势图上的一个点（recharts 的 dataKey 用驼峰，避免模板里出现下划线拼接）。
 *
 * 带索引签名是**故意的**：recharts 的 `data` 契约就是「按键取值的一行」，
 * 系列配置（`TREND_SERIES[].key`）是数据驱动的，编译器无法把两者静态关联起来。
 */
export interface OverviewTrendDatum {
  label: string;
  alarms: number;
  handled: number;
  incidents: number;
  falsePositive: number;
  [key: string]: string | number;
}

/** 数据流里的一帧：结构上就是「右端新增的一格 + 滚动后的四张 KPI 卡 + 滚动后的分级 / 场景」。 */
export interface OverviewStreamFrameModel {
  label: string;
  point: OverviewTrendDatum;
  kpis: KpiCard[];
  totals: OverviewTotals;
  /** 与 `totals` 同一帧、同一窗口的分级构成（分级图不能停在静态值上） */
  levels: OverviewRangeModel["levels"];
  /** 与 `totals` 同一窗口的场景构成（场景环形图的「合计」不能与 KPI 脱节） */
  scenes: OverviewRangeModel["scenes"];
  pulse: { row: number; hour: number };
}

/**
 * 一档时间范围在前端要用的全部东西。
 *
 * 这里只做**形状映射**：数字、比率、峰值全部来自 overview-ranges.json；
 * 颜色与文案（tone / 「已处置」这类标签）在这一层拼，页面不参与。
 */
export interface OverviewRangeModel {
  key: OverviewRangeKey;
  label: string;
  windowLabel: string;
  granularity: OverviewRange["granularity"];
  kpis: KpiCard[];
  totals: OverviewTotals;
  peak: { label: string; value: number };
  levels: { level: number; label: string; total: number; unhandled: number; tone: AvTone }[];
  scenes: (MetricDatum & { site: string; scene: Scene })[];
  /** 已翻转成「旧 → 新」，直接喂给 recharts */
  trend: OverviewTrendDatum[];
  heatmap: {
    axis: string[];
    rows: { key: string; label: string; cells: { hour: number; count: number }[] }[];
    max: number;
    rowHeight: string;
  };
  points: { id: string; room: string; total: number; level1: number; fpRate: number }[];
  types: { code: string; name: string; category: string; count: number }[];
  stream: { tickSeconds: number; frames: OverviewStreamFrameModel[] };
}

/**
 * 「告警趋势」的四条系列（BLF-1424）。
 *
 * 放在 view 层而不是页面里，是为了能被测试直接断言「至少 4 条、颜色互不相同」——
 * 页面里写死的话只能靠截图肉眼看。颜色走 Stage 1 的数据系列色
 * （`--av-series-1..4`：青 / 蓝 / 紫 / 品红），第四条用虚线表达「误报是噪声」。
 */
export interface OverviewTrendSeries {
  key: "alarms" | "handled" | "incidents" | "falsePositive";
  label: string;
  tone: AvSeriesTone;
  fill?: "gradient" | "none";
  dashed?: boolean;
}

export const OVERVIEW_TREND_SERIES: OverviewTrendSeries[] = [
  { key: "alarms", label: "告警", tone: "series-1", fill: "gradient" },
  { key: "handled", label: "已处置", tone: "series-2" },
  { key: "incidents", label: "事件", tone: "series-3" },
  { key: "falsePositive", label: "误报", tone: "series-4", dashed: true },
];

/** KPI 四个槽位的语义色：同一个槽位在三档里保持同一个颜色，换数时不会「变色误导」。 */
const OVERVIEW_KPI_TONE: Record<OverviewKpiDef["key"], AvTone> = {
  alarms: "danger",
  handled: "success",
  incidents: "violet",
  "false-positive": "warning",
};

/**
 * KPI 四张卡：值 / 副标题全部由 totals 拼出来。
 *
 * 之所以不把整卡文案写进 JSON：JSON 只该有口径与数字，文案属于视图层；
 * 而且演示帧要复用同一套文案，只换 totals（见 `overviewRangeAtTick`）。
 */
export function overviewKpisFrom(range: OverviewRange, totals: OverviewTotals): KpiCard[] {
  return range.kpi_defs.map((def) => {
    switch (def.key) {
      case "alarms":
        return {
          key: def.key,
          label: def.label,
          value: formatCount(totals.alarms),
          unit: def.unit,
          detail: `已处置 ${formatCount(totals.handled)} 条`,
          note: `未处置 ${formatCount(totals.unhandled)} 条`,
          tone: OVERVIEW_KPI_TONE[def.key],
        };
      case "handled":
        return {
          key: def.key,
          label: def.label,
          value: formatCount(totals.handled),
          unit: def.unit,
          detail: `处置率 ${formatPercent(totals.handled_rate)}`,
          note: `误报归档 ${formatCount(totals.false_positive)} 条`,
          tone: OVERVIEW_KPI_TONE[def.key],
        };
      case "incidents":
        return {
          key: def.key,
          label: def.label,
          value: formatCount(totals.incidents),
          unit: def.unit,
          detail: `在办 ${formatCount(totals.open_incidents)} 起`,
          note: "跨告警融合后的人工确认单元",
          tone: OVERVIEW_KPI_TONE[def.key],
        };
      default:
        return {
          key: def.key,
          label: def.label,
          value: totals.false_positive_rate.toFixed(def.decimals),
          unit: def.unit,
          detail: `误报 ${formatCount(totals.false_positive)} 条 / 告警 ${formatCount(totals.alarms)} 条`,
          note: "按该窗口内的告警口径计算",
          tone: OVERVIEW_KPI_TONE[def.key],
        };
    }
  });
}

/** `overview-ranges.json` 的一档 → 页面模型。 */
export function overviewRangeModel(range: OverviewRange): OverviewRangeModel {
  return {
    key: range.key,
    label: range.label,
    windowLabel: range.window_label,
    granularity: range.granularity,
    kpis: overviewKpisFrom(range, range.totals),
    totals: range.totals,
    peak: range.peak,
    levels: range.levels.map((row) => ({
      level: row.level,
      label: levelMeta(row.level).label,
      total: row.total,
      unhandled: row.unhandled,
      tone: levelMeta(row.level).tone,
    })),
    // 场景分布：场景名做主标签、站点名做副标签（与既有 sceneDistribution 同一约定）
    scenes: range.scenes.map((row) => ({
      label: sceneMeta(row.scene).fallbackName,
      value: row.count,
      tone: sceneMeta(row.scene).tone,
      site: row.name,
      scene: row.scene,
    })),
    trend: [...range.trend].reverse().map((row) => ({
      label: row.label,
      alarms: row.alarms,
      handled: row.handled,
      incidents: row.incidents,
      falsePositive: row.false_positive,
    })),
    heatmap: {
      axis: range.heatmap.axis,
      rows: range.heatmap.rows.map((row) => ({
        key: row.key,
        label: row.label,
        cells: row.cells.map((cell) => ({ hour: cell.hour, count: cell.count })),
      })),
      max: range.heatmap.max,
      // 行高跟着行数走：week 是 7 行，live / today 只有 1 行 —— 单行时把格子拉大，
      // 否则整块热力图会缩成一条发丝，演示时看不出「这里是热力窗口」
      rowHeight: range.heatmap.rows.length > 1 ? "narrow" : "wide",
    },
    points: range.points.map((row) => ({
      id: row.point_id,
      room: row.point_room,
      total: row.total,
      level1: row.level1,
      fpRate: row.fp_rate,
    })),
    types: range.types.map((row) => ({
      code: row.type_code,
      name: row.type_name,
      category: row.category,
      count: row.count,
    })),
    stream: {
      tickSeconds: range.stream.tick_seconds,
      frames: range.stream.frames.map((frame) => ({
        label: frame.trend_label,
        point: {
          label: frame.trend_label,
          alarms: frame.alarms,
          handled: frame.handled,
          incidents: frame.incidents,
          falsePositive: frame.false_positive,
        },
        kpis: overviewKpisFrom(range, frame.totals),
        totals: frame.totals,
        levels: frame.levels.map((row) => ({
          level: row.level,
          label: levelMeta(row.level).label,
          total: row.total,
          unhandled: row.unhandled,
          tone: levelMeta(row.level).tone,
        })),
        scenes: frame.scenes.map((row) => ({
          label: sceneMeta(row.scene).fallbackName,
          value: row.count,
          tone: sceneMeta(row.scene).tone,
          site: row.name,
          scene: row.scene,
        })),
        pulse: frame.heat,
      })),
    },
  };
}

/**
 * 数据流进度 → 当前要渲染的内容。
 *
 * 滚动语义与 generator 一致：`model.trend` 已经是「旧 → 新」，所以推进 tick 帧 = n
 * **从头（最旧）去掉 n 个桶、末尾接上 n 个新桶** —— 长度不变，横轴永远向前走。
 * （之前的实现从头保留、从尾砍，砍掉的恰好是最新那几个桶，导致「图里的切片」
 * 与帧里的 totals 对不上。）这里只做**切片与拼接**，不产生任何新数字。
 */
export function overviewRangeAtTick(
  model: OverviewRangeModel,
  tick: number,
): {
  kpis: KpiCard[];
  levels: OverviewRangeModel["levels"];
  scenes: OverviewRangeModel["scenes"];
  trend: OverviewTrendDatum[];
  totals: OverviewTotals;
  peak: { label: string; value: number };
  pulse: { row: number; hour: number } | null;
} {
  const frames = model.stream.frames;
  const applied = Math.max(0, Math.min(tick, frames.length));
  if (applied === 0) {
    return {
      kpis: model.kpis,
      levels: model.levels,
      scenes: model.scenes,
      trend: model.trend,
      totals: model.totals,
      peak: model.peak,
      pulse: null,
    };
  }
  const head = model.trend.slice(applied);
  const tail = frames.slice(0, applied).map((frame) => frame.point);
  const trend = [...head, ...tail];
  return {
    kpis: frames[applied - 1].kpis,
    // 分级图 / 场景图跟着同一帧走：环形图切片与中心的总数必须来自同一个窗口
    levels: frames[applied - 1].levels,
    scenes: frames[applied - 1].scenes,
    trend,
    totals: frames[applied - 1].totals,
    // 峰值跟着推进后的曲线重算：标注必须落在当前画出来的那条线上
    peak: overviewPeak(trend),
    pulse: frames[applied - 1].pulse,
  };
}

/** 曲线峰值（主系列 = 告警数）。数据点是现成的，这里只挑最大的一个。 */
export function overviewPeak(trend: OverviewTrendDatum[]): { label: string; value: number } {
  return trend.reduce(
    (best, row) => (row.alarms > best.value ? { label: row.label, value: row.alarms } : best),
    { label: trend[0]?.label ?? "", value: trend[0]?.alarms ?? 0 },
  );
}
