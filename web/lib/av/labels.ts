/**
 * 智能音视频平台语义映射层：业务编码 → 中文文案 / 语义色 token。
 *
 * 两条硬规则（Stage 2 验收 §3、§6）：
 *   1. 组件里不出现颜色字面量。这里只产出 **token 名**（`level-1`、`scene-hospital`…），
 *      由 CSS 模块里的 `var(--av-*)` 落到真实色值，深色 / 浅色各自映射。
 *   2. 组件里不出现业务数字。数量、占比、时长全部来自 `/stream-monitor-data/*.json`。
 *
 * 告警四级色只在这里定义一次，别在页面里重复映射：
 *   一级 → danger（珊瑚） 二级 → warning（琥珀） 三级 → signal（信号青） 四级 → muted（弱文字）
 * 并且**任何级别都必须同时输出色块 + 「N 级」文字**（只靠颜色对色弱不可辨）。
 *
 * 场景色属于「数据系列色」，不是状态语义：campus 用信号青、hospital 用数据紫、
 * justice 用中性钢灰。警告 / 危险 / 完成三色保留给状态，不借给场景。
 */
import type {
  AlarmLevel,
  AlarmStatus,
  DeviceStatus,
  IncidentKind,
  RoomType,
  RoutineEventType,
  Scene,
  TimelineNodeType,
} from "./types";

export type AvTone =
  | "signal"
  | "action"
  | "danger"
  | "warning"
  | "violet"
  | "neutral"
  | "success";

export interface AvLevelMeta {
  level: AlarmLevel;
  /** 紧凑文字：一级 / 二级 / 三级 / 四级 */
  short: string;
  /** 兜底完整文案；数据自带 `level_label` 时优先用数据 */
  label: string;
  tone: AvTone;
}

export const AV_LEVELS: Record<AlarmLevel, AvLevelMeta> = {
  1: { level: 1, short: "一级", label: "一级·严重", tone: "danger" },
  2: { level: 2, short: "二级", label: "二级·紧急", tone: "warning" },
  3: { level: 3, short: "三级", label: "三级·一般", tone: "signal" },
  4: { level: 4, short: "四级", label: "四级·提示", tone: "neutral" },
};

export const AV_LEVEL_ORDER: AlarmLevel[] = [1, 2, 3, 4];

export function levelMeta(level: AlarmLevel): AvLevelMeta {
  return AV_LEVELS[level] ?? AV_LEVELS[4];
}

/** 级别徽标的可读文本：优先数据里的 `level_label`，缺省回落到本地表。 */
export function levelText(level: AlarmLevel, levelLabel?: string | null): string {
  return levelLabel?.trim() || levelMeta(level).label;
}

export interface AvSceneMeta {
  scene: Scene;
  fallbackName: string;
  tone: AvTone;
}

export const AV_SCENES: Record<Scene, AvSceneMeta> = {
  campus: { scene: "campus", fallbackName: "校园防欺凌", tone: "signal" },
  hospital: { scene: "hospital", fallbackName: "医院安全防控", tone: "violet" },
  justice: { scene: "justice", fallbackName: "公安执法监督", tone: "neutral" },
};

export function sceneMeta(scene: Scene): AvSceneMeta {
  return AV_SCENES[scene] ?? AV_SCENES.campus;
}

export const AV_SCENE_ORDER: Scene[] = ["campus", "hospital", "justice"];

export const ALARM_STATUS_LABEL: Record<AlarmStatus, string> = {
  new: "待确认",
  acknowledged: "已确认",
  dispatched: "处置中",
  closed: "已闭环",
  false_positive: "误报",
};

export const DEVICE_STATUS_LABEL: Record<DeviceStatus, string> = {
  online: "在线",
  offline: "离线",
  maintenance: "维护中",
};

export const DEVICE_STATUS_TONE: Record<DeviceStatus, AvTone> = {
  online: "success",
  offline: "danger",
  maintenance: "warning",
};

export const ALARM_STATUS_TONE: Record<AlarmStatus, AvTone> = {
  new: "danger",
  acknowledged: "warning",
  dispatched: "signal",
  closed: "success",
  false_positive: "neutral",
};

export const TIMELINE_LABEL: Record<TimelineNodeType, string> = {
  alarm_triggered: "告警触发",
  fusion: "多模态融合",
  action: "策略动作",
  notify: "通知触达",
  acknowledge: "接警确认",
  dispatch: "派发处置",
  arrive: "现场到位",
  handle: "现场处置",
  review: "主管复核",
  archive: "归档结案",
  diagnose: "运维诊断",
  pending: "待处理",
  inspect: "例行巡检",
  device_online: "设备上线",
  device_offline: "设备下线",
  ota: "固件升级",
  config: "配置变更",
  manual: "人工补录",
};

// ---------------------------------------------------------------------------
// 事件性质（BLF-1427）：事件中心 = 告警融合事件 + 普通事件
// ---------------------------------------------------------------------------

/** 紧凑标签，用在分段控件 / 表格类型列 */
export const EVENT_KIND_LABEL: Record<IncidentKind, string> = {
  alarm: "告警融合",
  routine: "普通事件",
};

/** 完整文案，用在详情 / 空态 */
export const EVENT_KIND_FULL_LABEL: Record<IncidentKind, string> = {
  alarm: "告警融合事件",
  routine: "普通事件",
};

export const ROUTINE_EVENT_TYPE_LABEL: Record<RoutineEventType, string> = {
  inspection: "巡检发现",
  device_online: "设备上线",
  device_offline: "设备离线",
  ota: "固件升级",
  config: "配置变更",
  false_positive_archive: "误报归档",
  manual: "人工补录",
};

/**
 * 术语固定写法：固件升级（原「OTA」）。
 *
 * 数据集里 `ota` 字段名与 `OTA-####-#` 记录编号不动（编号是抽屉对账的主键），
 * 只有上屏的中文措辞集中在这里 —— 页面里不再写第二遍（同一个术语在五页里漂成
 * 五种说法正是本 Stage 要消灭的东西）。
 */
export const FIRMWARE_UPGRADE_LABEL = "固件升级";

/** 历史数据没有 `kind` 字段：缺省即告警融合事件 */
export function incidentKind(incident: { kind?: IncidentKind }): IncidentKind {
  return incident.kind === "routine" ? "routine" : "alarm";
}

/** 表格「事件类型」列 */
export function eventTypeText(incident: { kind?: IncidentKind; event_type?: RoutineEventType }): string {
  if (incidentKind(incident) === "alarm") return EVENT_KIND_LABEL.alarm;
  return (incident.event_type && ROUTINE_EVENT_TYPE_LABEL[incident.event_type]) || EVENT_KIND_LABEL.routine;
}

export const DISPOSITION_ACTION_LABEL = {
  close: "闭环",
  mark_false_positive: "标记误报",
  dispatch: "派发",
  escalate: "升级",
} as const;

export const AUDIT_ACTION_LABEL: Record<string, string> = {
  export: "导出",
  create: "新建",
  update: "修改",
  delete: "删除",
  ota: "固件升级",
  permission: "权限变更",
  read: "读取",
};

export const RISK_LEVEL_LABEL = {
  low: "低风险",
  medium: "中风险",
  high: "高风险",
} as const;

export const ALGORITHM_STATUS_LABEL = {
  running: "运行中",
  paused: "已暂停",
  error: "异常",
} as const;

export const ALGORITHM_STATUS_TONE = {
  running: "success",
  paused: "neutral",
  error: "danger",
} as const;

export const ALGORITHM_CATEGORY_LABEL: Record<string, string> = {
  audio: "音频算法",
  vision: "视觉 AI",
  speech: "语音语义",
  llm: "大模型融合",
};

/** 房间类型：只用于详情里的可读标签，避免把 `restroom` 直接暴露给用户。 */
export const ROOM_TYPE_LABEL: Record<RoomType, string> = {
  restroom: "卫生间",
  corridor: "走廊",
  classroom: "教室",
  stairs: "楼梯间",
  playground: "操场",
  dorm: "宿舍",
  canteen: "食堂",
  rooftop: "天台",
  lobby: "大厅",
  triage: "分诊台",
  window: "窗口",
  pharmacy: "药房",
  surgical: "手术区",
  icu: "ICU",
  duty: "值班室",
  ward: "病房",
  storage: "库房",
  interrogation: "询问室",
  waiting: "等候区",
  archive: "档案室",
  command: "指挥室",
  office: "办公室",
  meeting: "会议室",
  machine: "机房",
  morgue: "太平间",
  utility: "设备间",
};

export function roomTypeLabel(type: string): string {
  return ROOM_TYPE_LABEL[type as RoomType] ?? type;
}

// ---------------------------------------------------------------------------
// 界面文案映射（BLF-1431 / Stage 7）：机器可读值 → 中文
//
// 两条硬规则：
//   1. **数据集原值不动**：`transcripts.json` 的 `language`、`scenes.json` 的 `code`
//      这类值是数据（可下载、可对账），中文只发生在展示层；
//   2. **映射表只放这一个文件**：页面 / 组件里不写第二张表，否则同一个编码
//      在五页里会漂成五种说法。`englishResidue.test.ts` 扫用户可见英文残留，
//      新增英文必须显式进它的白名单。
//
// 保留英文的只有：`H.265`（编码标准）、`4K`、`GB` / `TB` / `dBm` / `dBA` / `Hz` / `ms` / `%`
// （单位）、`MIC-*` / `CAM-*` / `GW-*` 型号、固件版本号、告警 / 事件 / 设备 / 点位编号。
// `AV` 是敏感词，型号前缀已整体去掉（曾经的 `AV-MIC-S6` 现为 `MIC-S6`）。
// ---------------------------------------------------------------------------

/** 通道录制状态：`LIVE` / `OFFLINE` → 实时 / 离线。 */
export const LIVE_STATE_LABEL = { online: "实时", offline: "离线" } as const;

/** 通道类型：`VIDEO` / `AUDIO` → 视频 / 音频。 */
export const CHANNEL_KIND_LABEL = { video: "视频", audio: "音频" } as const;

/**
 * 信号强度分位：`P90` / `P50` / `P10` → 较高分位 / 中位 / 较低分位。
 *
 * 具体数值仍在读数与 tooltip 里 —— 这里只换措辞，不隐藏数据。
 */
export const SIGNAL_PERCENTILE_LABEL = {
  average: "平均值",
  high: "较高分位",
  median: "中位",
  low: "较低分位",
} as const;

/** 画面检测框类别（`PERSON` / `VEHICLE` → 人员 / 车辆）。 */
export const VIDEO_DETECTION_LABEL = { person: "人员", vehicle: "车辆" } as const;

export type AvDetectionClass = keyof typeof VIDEO_DETECTION_LABEL;

/** 画面上的固定标签：分析区域（ROI）、无信号（离线态）。 */
export const VIDEO_REGION_LABEL = "分析区域";
export const VIDEO_NO_SIGNAL_LABEL = "无信号";

/** 视频编码行：`H.265` 是编码标准（保留），帧率改中文单位。 */
export const VIDEO_CODEC_LINE = "H.265 · 25 帧/秒";

/**
 * 转写语言：locale code（`zh-CN`）不上屏。
 *
 * 数据集里 `transcript.language` 的原值照旧保存 —— 这里是唯一的翻译点。
 */
const TRANSCRIPT_LANGUAGE_LABEL: Record<string, string> = {
  "zh-CN": "普通话",
  "zh-TW": "台湾地区国语",
  "zh-HK": "粤语",
  yue: "粤语",
  en: "英语",
};

export function transcriptLanguageLabel(code: string | null | undefined): string {
  const key = (code ?? "").trim();
  return TRANSCRIPT_LANGUAGE_LABEL[key] ?? "其他语言";
}

/**
 * 场景代码：数据集里的 `code` 是 `CAMPUS` / `HOSPITAL` / `JUSTICE`（机器可读原值），
 * 能力页的场景卡上展示为「校园 / 医院 / 公安」。
 */
const SCENE_CODE_LABEL: Record<string, string> = {
  CAMPUS: "校园",
  HOSPITAL: "医院",
  JUSTICE: "公安",
};

export function sceneCodeLabel(code: string | null | undefined): string {
  const key = (code ?? "").trim();
  return SCENE_CODE_LABEL[key] ?? key;
}

// ---------------------------------------------------------------------------
// 数字与时间格式化（纯函数，单测覆盖）
// ---------------------------------------------------------------------------

const GROUP = new Intl.NumberFormat("zh-CN");

/** 千分位整数。所有 KPI / 表格数字都走这里，保证同一份数据全站显示一致。 */
export function formatCount(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return GROUP.format(Math.round(value));
}

/** 竖屏单位：保留一位小数，仅用于百分比（数据本身是 0–100 的百分数）。 */
export function formatPercent(value: number, digits = 1): string {
  if (!Number.isFinite(value)) return "—";
  return `${value.toFixed(digits).replace(/\.0$/, "")}%`;
}

/** 环比 / 同比：数据里已经是百分数（-52.8 表示 -52.8%）。 */
export function formatDelta(value: number, digits = 1): string {
  if (!Number.isFinite(value)) return "—";
  const rounded = Math.abs(value).toFixed(digits).replace(/\.0$/, "");
  if (value === 0) return "持平";
  return `${value > 0 ? "+" : "−"}${rounded}%`;
}

export function formatMinutes(minutes: number, digits = 1): string {
  if (!Number.isFinite(minutes)) return "—";
  if (minutes < 1) return `${Math.round(minutes * 60)} 秒`;
  return `${minutes.toFixed(digits).replace(/\.0$/, "")} 分钟`;
}

export function formatStorage(tb: number): string {
  if (!Number.isFinite(tb)) return "—";
  if (tb >= 1000) return `${(tb / 1000).toFixed(2)} PB`;
  return `${tb.toFixed(tb < 10 ? 1 : 0).replace(/\.0$/, "")} TB`;
}

export function formatGb(gb: number): string {
  if (!Number.isFinite(gb)) return "—";
  return `${gb.toFixed(1).replace(/\.0$/, "")} GB`;
}

/** 秒 → 「1 分 06 秒」/「42 秒」，频谱与转写时长用。 */
export function formatSeconds(seconds: number): string {
  if (!Number.isFinite(seconds)) return "—";
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total} 秒`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return s ? `${m} 分 ${String(s).padStart(2, "0")} 秒` : `${m} 分钟`;
}

/** 分钟偏移 → 任务表格里的「3 分钟 / 6 天」短文案（不是 toRelative 的完整句）。 */
export function compactAge(offsetMinutes: number): string {
  const m = Math.max(0, Math.round(offsetMinutes));
  if (m < 1) return "刚刚";
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时`;
  return `${Math.floor(h / 24)} 天`;
}
