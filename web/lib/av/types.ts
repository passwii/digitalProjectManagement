// 智能音视频平台数据契约（与 web/public/stream-monitor-data/*.json 一一对应）
//
// 时间约定（最重要的一条）：
//   所有时间字段都是 **相对锚点的分钟偏移**，后缀统一为 `*_offset_minutes`。
//   偏移越小 → 越新。绝对时间 = anchor - offset（锚点见 index.json）。
//   所有时间数组统一按「新 → 旧」排序（偏移升序），前端直接 map 即可。
//
// 时区约定：
//   「钟点 / 自然日」一律按 UTC+8 计算（见 time.ts），不要用 Date 本地时区，
//   否则换一台机器热力图就会整体错位。
//
// 分片约定：
//   告警不在单个 alarms.json 里，而是 alarms-index.json + alarms/shard-*.json。
//   首屏只加载索引；列表按 cursor 懒加载分片（见 load.ts / AlarmsIndex.pagination）。

export type Scene = "campus" | "hospital" | "justice";
export type AlarmLevel = 1 | 2 | 3 | 4;
export type AlarmStatus = "new" | "acknowledged" | "dispatched" | "closed" | "false_positive";
export type DeviceStatus = "online" | "offline" | "maintenance";
export type NarrativeTier = "script" | "related" | "noise";
export type ScriptId = "A" | "B" | "C" | "D" | "E" | "F" | "G" | "H";

/** 平台主体信息（品牌层，换客户只改这一个文件） */
export interface Org {
  id: string;
  name: string;
  shortName: string;
  brandLine: string;
  version: string;
  copyright: string;
}

/** 站点概览。points / devices / structures 都是从明细聚合出来的，禁止手写 */
export interface Site {
  id: string;
  code: string;
  name: string;
  type: "school" | "hospital" | "police";
  scene: Scene;
  area: string;
  capacity: number;
  scene_token: string;
  buildings: number;
  floors: number;
  points: number;
  devices: number;
  /** 展示用概要，如「7 栋 / 21 个楼层 / 158 个点位」 */
  rooms: string;
}

export type RoomType =
  | "restroom" | "corridor" | "classroom" | "stairs" | "playground"
  | "dorm" | "canteen" | "rooftop" | "lobby" | "triage" | "window"
  | "pharmacy" | "surgical" | "icu" | "duty" | "ward" | "storage"
  | "interrogation" | "waiting" | "archive" | "command" | "office"
  | "meeting" | "machine" | "morgue" | "utility";

export interface Point {
  id: string;
  site_id: string;
  building: string;
  building_name: string;
  floor: number;
  /** 展示用全名，如「教学楼 A3楼301教室」 */
  room: string;
  room_type: RoomType;
  /** 1–3，越高越容易发生事件（用于热力 / 排序权重） */
  risk_weight: number;
  has_device: boolean;
  note: string | null;
}

export interface SelfCheck {
  result: "pass" | "warn" | "skip";
  at_offset_minutes: number;
  items: string[];
}

export interface OtaRecord {
  id: string;
  from_version: string;
  to_version: string;
  at_offset_minutes: number;
  status: "success" | "failed";
  trigger: string;
}

export interface SignalSample {
  at_offset_minutes: number;
  /** RSSI，负 dBm（如 -78）；设备离线时统一为 0 哨兵，前端画图需特判 */
  rssi_dbm: number;
}

export interface Device {
  id: string;
  site_id: string;
  point_id: string;
  point_room: string;
  /** 型号编号，如 AV-MIC-S6 */
  model: string;
  /** 中文品类，如「拾音终端」 */
  type_name: string;
  kind: "audio" | "video" | "gateway";
  firmware: string;
  status: DeviceStatus;
  /** 在线设备是「最近一次心跳距今多久」；离线设备是「离线了多久」 */
  last_heartbeat_offset_minutes: number;
  uptime_days: number;
  /** 信号质量分 0–100（不是 dBm）；离线设备为 0 哨兵 */
  signal: number;
  cpu_percent: number;
  storage_percent: number;
  mic_sensitivity_dbm: number | null;
  self_check: SelfCheck;
  /** 最近若干次自检（新 → 旧） */
  self_check_history: SelfCheck[];
  /** OTA 升级记录（新 → 旧） */
  ota_records: OtaRecord[];
  /** 最近 24 小时信号强度，整点采样（新 → 旧）；非离线设备恒为负 dBm，离线设备全 0 */
  signal_series: SignalSample[];
  /** 至少包含所属站点的场景 */
  scenes: Scene[];
  /** 所属网关；网关自身为 null */
  gateway_id: string | null;
}

export interface User {
  id: string;
  /** 已脱敏：姓 + * */
  name: string;
  role: "platform_admin" | "site_admin" | "duty_officer" | "head_teacher" | "auditor" | "ops";
  role_name: string;
  dept: string;
  site_id: string | null;
}

export interface Evidence {
  audio_seconds: number;
  video_clips: number;
  /** 对应 spectra.json 的频谱 id；null 表示这段音频没有落盘频谱 */
  spectrum_id: string | null;
  /** 与 spectrum_id 指向的频谱 bins 相等；无频谱时为 0 */
  spectrum_bins: number;
}

export interface Disposition {
  by: string;
  at_offset_minutes: number;
  action: "close" | "mark_false_positive" | "dispatch" | "escalate";
  note: string;
}

export interface Alarm {
  id: string;
  site_id: string;
  scene: Scene;
  point_id: string;
  point_room: string;
  device_id: string | null;
  /** 机器码，前端用它查字典拿图标 / 文案，不要用中文名做逻辑 */
  type_code: string;
  type_name: string;
  category: string;
  level: AlarmLevel;
  level_label: string;
  title: string;
  detail: string;
  /** 0.6–1.0 */
  confidence: number;
  /** 距锚点分钟数，越小越新 */
  ts_offset_minutes: number;
  duration_seconds: number;
  decibel: number | null;
  keywords: string[];
  status: AlarmStatus;
  disposition: Disposition | null;
  /** script = 可演示剧本；related = 属于某个事件；noise = 背景量 */
  narrative_tier: NarrativeTier;
  evidence: Evidence;
  false_positive: boolean;
  false_positive_reason?: string;
  /** 属于哪个演示剧本，仅剧本告警有 */
  script_id: ScriptId | null;
  /** 命中的检测规则，如 ["rule-006"] */
  rule_hits?: string[];
  /** 是否处于「误报观察静默期」（rule-006 生效后的记录态） */
  downgraded?: boolean;
}

export type TimelineNodeType =
  | "alarm_triggered" | "fusion" | "action" | "notify" | "acknowledge"
  | "dispatch" | "arrive" | "handle" | "review" | "archive"
  | "diagnose" | "pending"
  // 普通事件（巡检 / 设备上下线 / OTA / 配置变更 / 人工补录）专用节点：
  // 告警融合事件不出现这几种，反过来普通事件也不出现 fusion / action。
  | "inspect" | "device_online" | "device_offline" | "ota" | "config" | "manual";

export interface TimelineNode {
  at_offset_minutes: number;
  type: TimelineNodeType;
  /** 操作人 user.id；系统动作为 null */
  actor: string | null;
  text: string;
}

/**
 * 事件性质（BLF-1427）：
 *   · alarm   —— 告警融合事件：多起告警按点位与时间窗融合，全程可追溯（本平台的核心叙事）
 *   · routine —— 普通事件：巡检发现、设备上下线、OTA 批量升级、策略配置变更、
 *                误报归档、人工补录。没有告警可追溯，靠自身的运营动作成链。
 *
 * 为什么是可选字段：既有 207 条事件产出于「只有告警融合」的时期，
 * 缺省即 `alarm`（读取方用 `incidentKind()` 归一）。新增普通事件显式带 `kind`，
 * mock 数据因此保持纯追加 —— 老记录一个字节都不用改。
 */
export type IncidentKind = "alarm" | "routine";

/** 普通事件的分类码（告警融合事件没有这个字段） */
export type RoutineEventType =
  | "inspection"
  | "device_online"
  | "device_offline"
  | "ota"
  | "config"
  | "false_positive_archive"
  | "manual";

export interface Incident {
  id: string;
  /** 缺省 = "alarm"（历史数据没有这个字段） */
  kind?: IncidentKind;
  /** 仅普通事件有值 */
  event_type?: RoutineEventType;
  site_id: string;
  scene: Scene;
  title: string;
  level: AlarmLevel;
  level_label: string;
  point_id: string;
  point_room: string;
  alarm_ids: string[];
  alarm_count: number;
  /** 最早发生（偏移最大） */
  started_offset_minutes: number;
  /** 最后结束（偏移最小） */
  ended_offset_minutes: number;
  duration_minutes: number;
  status: AlarmStatus;
  owner_id: string;
  evidence_count: number;
  script_id: ScriptId | null;
  /**
   * 按时间从旧 → 新排列（`at_offset_minutes` 单调不增），且生命周期顺序与时间顺序一致：
   * alarm_triggered → fusion → action → notify → acknowledge → dispatch → arrive
   * → handle → review → pending → archive。
   * 已结案（closed）事件必以 archive 收尾；在办（dispatched）事件不含 archive。
   */
  timeline: TimelineNode[];
}

export interface LevelCount {
  level: AlarmLevel;
  label: string;
  count: number;
}

export interface Kpi {
  _meta: {
    generated_at: string;
    calc_note: string;
  };
  device_total: number;
  device_online: number;
  device_offline: number;
  device_maintenance: number;
  /** 百分数（0–100），不是小数 */
  online_rate: number;
  /** 滚动 24 小时（偏移 [0,1440)） */
  alarm_last_24h: number;
  /** 今天自然日（00:00 起），KPI 卡文案「今日告警」应使用它 */
  alarm_natural_day: number;
  /** 兼容别名，恒等于 alarm_natural_day */
  alarm_today: number;
  /** 上周同一星期几（避免周一比周日出现 +200% 的假环比） */
  alarm_last_week_same_day: number;
  alarm_natural_day_delta_pct: number;
  alarm_today_delta_pct: number;
  delta_basis: string;
  alarm_unhandled: number;
  /** 未处置的分级拆分（new + dispatched），KPI 卡副标题直接用 */
  alarm_unhandled_breakdown: LevelCount[];
  alarm_unhandled_by_scene: { scene: Scene; name: string; count: number }[];
  incident_open: number;
  level_breakdown_today: LevelCount[];
  scene_breakdown_today: { scene: Scene; name: string; count: number }[];
  level_breakdown_last_24h: LevelCount[];
  alarm_total: number;
  incident_total: number;
  /** 百分数（0–100） */
  false_positive_rate: number;
  avg_response_minutes: number;
  response_p50_minutes: number;
  response_p90_minutes: number;
  gpu: {
    model: string;
    vram_total_gb: number;
    utilization_percent: number;
    /** vram_used_gb 之和 = vram_total_gb × utilization_percent / 100 */
    cards: { index: number; utilization: number; vram_used_gb: number; mode: string; temperature: number }[];
  };
  storage: { hot_total_tb: number; hot_used_tb: number; cold_used_tb: number; unit: string };
  firmware_distribution: { model: string; version: string; count: number }[];
}

export interface HourlyBucket {
  /** 桶起点偏移（更近的一侧），越小越新 */
  window_start_offset_minutes: number;
  window_end_offset_minutes: number;
  /** 时钟小时 0..23（UTC+8） */
  clock_hour: number;
  label: string;
  alarms: number;
  handled: number;
}

export interface DailyBucket {
  day_offset_minutes: number;
  date_offset_days: number;
  date: string;
  label: string;
  weekday: string;
  alarms: number;
  incidents: number;
}

export interface HeatmapCell {
  /** 距今天几个自然日，0 = 今天 */
  day: number;
  /** 时钟小时 0..23（UTC+8） */
  hour: number;
  count: number;
}

export interface Trends {
  /** 最近 24 小时，按钟点聚合；新 → 旧 */
  hourly: HourlyBucket[];
  /** 最近 7 个自然日（含今天）；新 → 旧 */
  daily: DailyBucket[];
  /** 7 × 24 网格，按 (day asc, hour asc) 排列 */
  heatmap: HeatmapCell[];
}

export interface Rankings {
  points: {
    point_id: string;
    point_room: string;
    total: number;
    level1: number;
    false_positive: number;
    fp_rate: number;
  }[];
  types: { type_code: string; type_name: string; category: string; count: number }[];
}

// ---------------------------------------------------------------------------
// 总览页三档时间范围（overview-ranges.json / BLF-1424）
// ---------------------------------------------------------------------------

/** 总览页右上角的三个时间范围。 */
export type OverviewRangeKey = "live" | "today" | "week";

/** 一级的「总数 + 其中未处置」：档位级与桶级共用同一形状。 */
export interface OverviewLevelCount {
  level: AlarmLevel;
  total: number;
  unhandled: number;
}

/**
 * 一档范围的趋势桶。
 *
 * 小时档（live / today）与日档（week）字段相同，只是 `label` 不同：
 * 「12:00」或「10/19」。**数组统一「新 → 旧」**，页面渲染前反向。
 * `unhandled` / `open_incidents` / `levels` 是给演示态推进逐桶相加用的
 * （与 kpi.json 的 new + dispatched 同口径），图表不画它们。
 */
export interface OverviewTrendPoint {
  label: string;
  alarms: number;
  handled: number;
  unhandled: number;
  incidents: number;
  /** 该桶内仍未关闭的事件数（「在办 N 起」按窗口过滤，不再是全站一个数） */
  open_incidents: number;
  false_positive: number;
  /** 该桶的分级构成：窗口滚动后分级图与 KPI 仍然对得上 */
  levels: OverviewLevelCount[];
}

export interface OverviewHeatCell {
  /** 时钟小时 0..23（live 档是「该格对应的真实钟点」） */
  hour: number;
  count: number;
}

export interface OverviewHeatRow {
  key: string;
  label: string;
  cells: OverviewHeatCell[];
}

/**
 * 热力窗口：三档形状不同（live / today 是 1 行 × 24 格，week 是 7 行 × 24 格），
 * `axis` 是 24 个刻度文案（未命中的位置是空串），由数据层直接给，页面不自己算。
 */
export interface OverviewHeatmap {
  axis: string[];
  rows: OverviewHeatRow[];
  max: number;
}

/** KPI 卡的「槽位」定义：标签 / 单位 / 小数位来自数据，颜色与文案由 view.ts 拼。 */
export interface OverviewKpiDef {
  key: "alarms" | "handled" | "incidents" | "false-positive";
  label: string;
  unit: string;
  decimals: 0 | 1;
}

/** 一档窗口的汇总数：KPI 四值全部从这里取，演示帧也给出滚动后的同一结构。 */
export interface OverviewTotals {
  alarms: number;
  handled: number;
  unhandled: number;
  false_positive: number;
  incidents: number;
  open_incidents: number;
  /** 已处置率 / 误报率：百分数（0–100），生成器算好，前端只格式化 */
  handled_rate: number;
  false_positive_rate: number;
}

/**
 * 数据流推进的一帧：趋势图右端新增的一格 + 滚动后的 totals + 热力图脉冲位置。
 *
 * 键名用 `stream` 而不是 `demo`：公开数据集里的 demo 会被 siteCopyGuard 判成
 * 「把自己写小」的措辞（这份 JSON 访客可以直接下载）。
 */
export interface OverviewStreamFrame {
  trend_label: string;
  alarms: number;
  handled: number;
  unhandled: number;
  incidents: number;
  /** 新增格里的在办事件数（刚到达的事件一律未关闭，所以等于 `incidents`） */
  open_incidents: number;
  false_positive: number;
  /** 新增那一格自己的分级构成（页面不读；给数据校验「逐桶相加」用） */
  added_levels: OverviewLevelCount[];
  /** 滚动后的分级构成：与 `totals.alarms` 逐项对得上，分级图读它 */
  levels: OverviewLevelCount[];
  /** 滚动后的场景构成：场景环形图中心的「合计」也要与 KPI 同窗口 */
  scenes: { scene: Scene; name: string; count: number; unhandled: number }[];
  heat: { row: number; hour: number };
  totals: OverviewTotals;
}

export interface OverviewStream {
  tick_seconds: number;
  frames: OverviewStreamFrame[];
}

export interface OverviewRange {
  key: OverviewRangeKey;
  label: string;
  window_label: string;
  granularity: "hour" | "day";
  kpi_defs: OverviewKpiDef[];
  totals: OverviewTotals;
  /** 趋势曲线的峰值（图上要标一个点） */
  peak: { label: string; value: number };
  levels: OverviewLevelCount[];
  scenes: { scene: Scene; name: string; count: number; unhandled: number }[];
  trend: OverviewTrendPoint[];
  heatmap: OverviewHeatmap;
  points: Rankings["points"];
  types: Rankings["types"];
  stream: OverviewStream;
}

/** `overview-ranges.json` 的根结构。 */
export interface OverviewRanges {
  _meta: {
    generated_at: string;
    calc_note: string;
    range_order: OverviewRangeKey[];
  };
  ranges: Record<OverviewRangeKey, OverviewRange>;
}

export interface SceneDef {
  id: Scene;
  name: string;
  code: string;
  slogan: string;
  desc: string;
  /** 语义 token，颜色由前端 theme 映射（数据层不存色值） */
  theme_token: string;
  apps: string[];
  /** 全部由明细现算 */
  kpi: { points: number; devices: number; today_alarms: number; total_alarms: number };
}

export interface Algorithm {
  id: string;
  name: string;
  category: "audio" | "vision" | "speech" | "llm";
  version: string;
  status: "running" | "paused" | "error";
  calls_today: number;
  avg_latency_ms: number;
  vram_gb: number;
}

export interface Algorithms {
  categories: { code: string; name: string; count: number; theme_token: string }[];
  algorithms: Algorithm[];
}

export interface Rule {
  id: string;
  name: string;
  scene: Scene | "all";
  threshold: string;
  action: string;
  enabled: boolean;
}

export interface AuditLog {
  id: string;
  ts_offset_minutes: number;
  user_id: string;
  user_name: string;
  action: string;
  action_code: "export" | "create" | "update" | "delete" | "ota" | "permission" | "read";
  target_type: string;
  target_id: string;
  site_id: string;
  result: "pass" | "pending";
  risk_level: "low" | "medium" | "high";
  ip: string;
}

export interface Waveform {
  buckets: number;
  samples_per_bucket: number;
  encoding: "uint8-base64";
  mid: number;
  /** base64 → Uint8Array，长度 = buckets */
  min: string;
  max: string;
}

export interface SpectrumPeak {
  at_ms: number;
  amplitude: number;
}

/** 频谱：base64 解码为 Uint8Array，索引 = col * bins + bin */
export interface Spectrum {
  id: string;
  alarm_id: string;
  title: string;
  profile: "bullying" | "quarrel" | "scream" | "glass" | "speech" | "noise";
  bins: number;
  cols: number;
  seconds: number;
  binHz: number;
  colMs: number;
  encoding: "uint8-base64";
  note: string;
  data: string;
  /** 2,000 桶 min/max 峰值，供波形条直接绘制 */
  waveform: Waveform;
  peaks: SpectrumPeak[];
}

export interface Speaker {
  id: string;
  /** 说话人序号，颜色 / 头像由前端按 index 映射 */
  index: number;
  label: string;
  role: string;
}

export interface TranscriptSegment {
  start: number;
  end: number;
  speaker: string | null;
  text: string;
  highlight: { word: string; level: 1 | 2 }[];
}

export interface Transcript {
  id: string;
  alarm_id: string;
  site_id: string;
  scene: Scene;
  audio_seconds: number;
  language: string;
  speakers: Speaker[];
  segments: TranscriptSegment[];
  keyword_hits: string[];
}

export interface DeviceStats {
  by_status: { status: DeviceStatus; count: number }[];
  by_site: { site_id: string; total: number; online: number }[];
  by_model: { model: string; type_name: string; count: number }[];
  ota_summary: { total: number; success: number; failed: number };
  signal_health: { avg: number; p10: number; p50: number; p90: number };
}

export interface ScriptSummary {
  id: ScriptId;
  scene: Scene;
  title: string;
  alarm_count: number;
}

export interface DatasetIndex {
  generated_by: string;
  seed: number;
  anchor: string;
  timezone: string;
  counts: {
    sites: number;
    points: number;
    devices: number;
    users: number;
    alarms: number;
    alarm_shards: number;
    incidents: number;
    spectra: number;
    transcripts: number;
    audit_logs: number;
    scripts: number;
  };
  scripts: ScriptSummary[];
  files: string[];
}

// ============================================================
// 告警分片与游标分页
// ============================================================
export interface AlarmShard {
  index: number;
  file: string;
  count: number;
  bytes: number;
  from_offset_minutes: number;
  to_offset_minutes: number;
  tier_counts: Record<NarrativeTier, number>;
}

export interface AlarmsPagination {
  page_size: number;
  max_page_size: number;
  /** "<shardIndex>:<offsetInShard>" */
  cursor_format: string;
  cursor_example: string;
  next_cursor_field: string;
  empty_cursor: null;
  total: number;
}

export interface AlarmsIndex {
  _meta: {
    total: number;
    shard_count: number;
    sorted_by: string;
    note: string;
  };
  pagination: AlarmsPagination;
  shards: AlarmShard[];
}

export interface AlarmShardFile {
  shard: number;
  count: number;
  from_offset_minutes: number;
  to_offset_minutes: number;
  alarms: Alarm[];
}

/**
 * 首屏核心数据（不含告警明细与频谱大文件）。
 * 告警走 loadAlarmPage / loadAlarms；频谱走 loadSpectra。
 */
export interface DatasetCore {
  index: DatasetIndex;
  alarmsIndex: AlarmsIndex;
  org: Org;
  sites: Site[];
  points: Point[];
  devices: Device[];
  deviceStats: DeviceStats;
  users: User[];
  incidents: Incident[];
  kpi: Kpi;
  trends: Trends;
  rankings: Rankings;
  scenes: SceneDef[];
  algorithms: Algorithms;
  rules: Rule[];
  auditLogs: AuditLog[];
  transcripts: Transcript[];
}

/** 整套数据（含频谱矩阵；演示 / 单测用，首屏不要这么拉） */
export interface Dataset extends DatasetCore {
  spectra: Spectrum[];
}

/** 游标分页的返回值 */
export interface AlarmPage {
  alarms: Alarm[];
  next_cursor: string | null;
  total: number;
}
