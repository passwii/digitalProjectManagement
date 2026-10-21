/**
 * 页面 props 契约（服务端投影 ↔ 客户端视图共用的唯一真源）。
 *
 * 为什么放在 lib/ 而不是组件文件里：
 *   · `tsconfig.test.json` 只编译 lib 目录下的测试，且不解析 `@/` 路径别名；
 *     页面 props 类型若写在 components 目录里，node:test 侧就没法 type-check
 *     `getOverviewData()` 这类投影函数；
 *   · lib 不应该反过来依赖 components（依赖方向是 components → lib），
 *     把契约提出来后，`lib/av/pageData.ts` 不再 import 任何组件文件。
 *
 * 这里只放**类型**，没有任何运行时导出。
 */
import type {
  Algorithm,
  Alarm,
  AlarmsIndex,
  DeviceStatus,
  Incident,
  OverviewRangeKey,
  Rule,
  Scene,
  Spectrum,
  Transcript,
} from "./types";
import type { AvTone } from "./labels";
import type { OverviewRangeModel } from "./view";

// ---------------------------------------------------------------------------
// 总览
// ---------------------------------------------------------------------------

/**
 * 总览页 props。
 *
 * 三档时间范围（近 24 小时 / 今日 / 近 7 日）**一次性全部直出**：
 * 切换范围时页面不再请求、也不出现 loading —— 数据在服务端就已经按档投影好了。
 * 每档自带 KPI / 分级 / 场景 / 趋势 / 热力 / 点位 / 类型 + 演示帧，
 * 所以「右上角切一下，大半个页面都换数」不需要任何客户端取数。
 */
export interface OverviewProps {
  initialRange: OverviewRangeKey;
  ranges: Record<OverviewRangeKey, OverviewRangeModel>;
  gpu: {
    meta: { model: string; vramTotalGb: number; utilization: number };
    cards: { index: number; utilization: number; vram: number; mode: string; temperature: number; tone: AvTone }[];
  };
  storage: { hotTotalTb: number; hotUsedTb: number; coldUsedTb: number; unit: string };
  firmware: { model: string; version: string; count: number }[];
  recent: {
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
  }[];
}

// ---------------------------------------------------------------------------
// 实时监控
// ---------------------------------------------------------------------------

export interface MonitorChannel {
  id: string;
  room: string;
  siteName: string;
  sceneName: string;
  kind: "audio" | "video" | "gateway";
  typeName: string;
  model: string;
  firmware: string;
  status: DeviceStatus;
  signal: number;
  cpu: number;
  storage: number;
  heartbeatOffsetMinutes: number;
  waveform: number[];
}

export interface MonitorProps {
  channels: MonitorChannel[];
  counts: { all: number; audio: number; video: number; offline: number };
  deviceTotal: number;
  signalHealth: { avg: number; p10: number; p50: number; p90: number };
  models: { model: string; typeName: string; count: number }[];
  gateways: { id: string; room: string; status: DeviceStatus; heartbeatOffsetMinutes: number }[];
}

// ---------------------------------------------------------------------------
// 告警中心
// ---------------------------------------------------------------------------

export interface AlarmSite {
  id: string;
  name: string;
  scene: Scene;
  sceneName: string;
}

export interface AlarmViewProps {
  initialAlarms: Alarm[];
  /** 第一页的下一页游标（服务端算好，客户端不要自己拼） */
  initialCursor: string | null;
  index: AlarmsIndex;
  total: number;
  sites: AlarmSite[];
  initialAlarm: Alarm | null;
  unhandled: number;
  unhandledBreakdown: { level: number; label: string; count: number; tone: AvTone }[];
  metrics: { avgResponse: number; p50: number; p90: number; fpRate: number; total: number };
  scripts: { id: string; title: string; alarmCount: number }[];
  incidentOf: Record<string, string>;
  /** user.id → 展示名（处置人 / 时间线操作人） */
  userNames: Record<string, string>;
}

// ---------------------------------------------------------------------------
// 事件中心
// ---------------------------------------------------------------------------

export interface EventRow {
  id: string;
  title: string;
  level: number;
  levelLabel: string;
  tone: AvTone;
  scene: string;
  sceneName: string;
  siteName: string;
  room: string;
  durationMinutes: number;
  status: Incident["status"];
  statusLabel: string;
  statusTone: AvTone;
  evidenceCount: number;
  alarmCount: number;
  startedOffsetMinutes: number;
  endedOffsetMinutes: number;
}

export interface EventDetail {
  incident: Incident;
  siteName: string;
  sceneName: string;
  ownerName: string;
  alarms: {
    id: string;
    title: string;
    level: number;
    levelLabel: string;
    offsetMinutes: number;
    typeName: string;
    audioSeconds: number;
    videoClips: number;
    spectrumId: string | null;
  }[];
}

export interface EventViewProps {
  rows: EventRow[];
  /**
   * **只包含当前选中事件**的详情：207 个事件的完整时间线一起序列化会把 HTML 撑到
   * 700KB+。切换事件走 `/stream-monitor/event/:id` 的服务端渲染（深链接本来就要支持），
   * 首屏只带一条详情。
   */
  detail: EventDetail | null;
  initialId: string | null;
  counts: { total: number; open: number; closed: number };
  /** user.id → 展示名（时间线节点里的 actor 是 id，不转换会直接暴露 u-003） */
  userNames: Record<string, string>;
}

// ---------------------------------------------------------------------------
// 设备管理
// ---------------------------------------------------------------------------

export interface DeviceRow {
  id: string;
  siteId: string;
  siteName: string;
  room: string;
  model: string;
  typeName: string;
  kind: "audio" | "video" | "gateway";
  firmware: string;
  status: DeviceStatus;
  heartbeatOffsetMinutes: number;
  uptimeDays: number;
  signal: number;
  cpu: number;
  storage: number;
  micSensitivityDbm: number | null;
  selfCheck: { result: "pass" | "warn" | "skip"; atOffsetMinutes: number; items: string[] };
  selfCheckHistory: { atOffsetMinutes: number; result: string; items: string[] }[];
  otaRecords: {
    id: string;
    fromVersion: string;
    toVersion: string;
    atOffsetMinutes: number;
    status: "success" | "failed";
    trigger: string;
  }[];
  signalSeries: { label: string; value: number }[];
}

export interface DeviceViewProps {
  devices: DeviceRow[];
  summary: {
    total: number;
    online: number;
    offline: number;
    maintenance: number;
    byStatus: { status: DeviceStatus; count: number }[];
    bySite: { id: string; name: string; total: number; online: number; offline: number; rate: number }[];
    byModel: { model: string; typeName: string; count: number }[];
    ota: { total: number; success: number; failed: number };
    signalHealth: { avg: number; p10: number; p50: number; p90: number };
  };
}

// ---------------------------------------------------------------------------
// 能力与场景
// ---------------------------------------------------------------------------

export interface CapabilityScene {
  scene: Scene;
  name: string;
  code: string;
  slogan: string;
  desc: string;
  apps: string[];
  points: number;
  devices: number;
  todayAlarms: number;
  totalAlarms: number;
  tone: AvTone;
}

export interface CapabilityGroup {
  code: string;
  name: string;
  count: number;
  totalCalls: number;
  totalVram: number;
  algorithms: (Algorithm & { statusLabel: string; statusTone: AvTone })[];
}

export interface CapabilityProps {
  scenes: CapabilityScene[];
  groups: CapabilityGroup[];
  rules: Rule[];
  chain: { code: string; title: string; detail: string; count: number; unit: string }[];
  totals: { algorithms: number; callsToday: number; avgLatency: number; vram: number };
}

// ---------------------------------------------------------------------------
// 音频分析
// ---------------------------------------------------------------------------

export interface AudioSampleOption {
  alarmId: string;
  title: string;
  spectrumId: string | null;
  seconds: number;
}

export interface AudioViewProps {
  alarm: { id: string; title: string; room: string; typeName: string; level: number; levelLabel: string };
  spectrum: Spectrum;
  transcript: Transcript | null;
  samples: AudioSampleOption[];
}
