/**
 * 服务端数据入口（只给 Server Component / node:test 用）。
 *
 * 为什么不让页面在浏览器里 `loadCore()`：
 *   · `/av/overview` 的首屏预算是 1MB，只把「这一页真正用到的聚合结果」序列化给
 *     客户端，比把 890KB 原始 JSON 全量塞进 RSC payload 小得多；
 *   · 数据是构建期就固定的静态 JSON，服务端读文件没有网络往返，也不需要 loading 态。
 *
 * 载入逻辑本身**复用 Stage 1 的 `load.ts`**：它接受注入的 `Fetcher`，这里注入一个
 * 读文件的实现，于是类型、分页契约、跨分片续接全部沿用同一份代码，没有第二套解析器。
 *
 * ⚠️ 不要把本文件 import 进客户端组件：它会拉进 `node:fs`。
 */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadAlarmPage, loadAlarmShard, loadCore, type Fetcher } from "./load";
import { toDateString } from "./time";
import type {
  Alarm,
  AlarmsIndex,
  AlarmPage,
  DatasetCore,
  DatasetIndex,
  Incident,
  Spectrum,
  Transcript,
} from "./types";

function resolveDataDir(): string {
  const candidates = [
    resolve(process.cwd(), "public/mock/av"),
    resolve(process.cwd(), "web/public/mock/av"),
    resolve(process.cwd(), "../web/public/mock/av"),
  ];
  const hit = candidates.find((dir) => existsSync(join(dir, "index.json")));
  if (!hit) {
    throw new Error(`找不到 AV mock 数据目录，试过：${candidates.join("，")}`);
  }
  return hit;
}

const DATA_DIR = resolveDataDir();

/**
 * `load.ts` 用 `baseUrl = ""` 时会拼出 `/index.json` 这样的站内路径；
 * 这里把它映射到 `public/mock/av/` 下的真实文件。
 */
const fileFetcher: Fetcher = async (url) => {
  const relative = url.replace(/^\/+/, "");
  if (relative.includes("..")) throw new Error(`拒绝读取数据目录之外的文件：${url}`);
  const file = join(DATA_DIR, relative);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    throw new Error(`读取 ${relative} 失败：${(err as Error).message}`);
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch (err) {
    throw new Error(`数据文件 ${relative} 不是合法 JSON：${(err as Error).message}`);
  }
};

/** 数据集目录（单测里直接用来断言）。 */
export function avDataDir(): string {
  return DATA_DIR;
}

let corePromise: Promise<DatasetCore> | null = null;

/** 首屏核心数据（约 890KB：不含告警明细与频谱）。进程内只解析一次。 */
export function getCore(): Promise<DatasetCore> {
  corePromise ??= loadCore("", fileFetcher);
  return corePromise;
}

/** 告警索引（3KB）；分页客户端也要用它，可以安全地作为 props 传给 Client Component。 */
export async function getAlarmsIndex(): Promise<AlarmsIndex> {
  return (await getCore()).alarmsIndex;
}

/** 服务端取一页告警（第一页给首屏用，`cursor = null`）。 */
export async function getAlarmPage(cursor: string | null = null, pageSize = 50): Promise<AlarmPage> {
  const core = await getCore();
  return loadAlarmPage(core.alarmsIndex, cursor, pageSize, "", fileFetcher);
}

// ---------------------------------------------------------------------------
// 全量索引：只在「按 id 深链接」与 `/av/__stress` 时按需构建一次
// ---------------------------------------------------------------------------

export interface AvExtremes {
  /** 标题最长的告警（Stage 1 埋的 58 字样本） */
  longestTitle: Alarm;
  /** 关键词最多的告警（6 个） */
  mostKeywords: Alarm;
  /** 房间名最长的告警（33 字） */
  longestRoom: Alarm;
  /** 全部告警数（= alarms-index 的 total，用来交叉校验） */
  total: number;
  levelCounts: Record<number, number>;
  statusCounts: Record<string, number>;
  scriptAlarms: Alarm[];
  downgraded: number;
  falsePositive: number;
  /**
   * 180 天里真正 0 告警的**自然日**（UTC+8 日历日）。
   *
   * 口径：只统计**完整覆盖**的日历日 —— 首尾两天是半天（数据从某个下午开始、
   * 锚点是正午），它们的「0 条」只代表窗口没覆盖到，必须排除。曾经按
   * `floor(offset / 1440)` 分桶（中午到中午）再贴自然日期标签，导致
   * 2026-04-22（实际 60 条）被显示成 0 条。
   */
  emptyDays: { dayOffset: number; date: string }[];
  /** 从没产生过告警的点位（空态素材） */
  zeroAlarmPoints: { id: string; room: string; siteId: string }[];
  /** 四级 + 近 1 小时 = 0 条：这一格是空态的固定断言 */
  level4LastHour: number;
}

interface AlarmIndex {
  byId: Map<string, Alarm>;
  extremes: AvExtremes;
}

/**
 * 在 [oldestDate, newestDate] 的日历日里找出没有告警的日期。
 *
 * 首尾两个边界日直接排除：它们只被数据窗口覆盖了一部分，「没有告警」不等于
 * 「这一天真的没有发生告警」。返回按时间新 → 旧（与全站时间数组一致）。
 */
export function emptyNaturalDays(
  touched: Set<string>,
  oldestDate: string,
  newestDate: string,
  limit = 3,
): { dayOffset: number; date: string }[] {
  const DAY = 24 * 60 * 60 * 1000;
  const start = Date.parse(`${oldestDate}T00:00:00Z`);
  const end = Date.parse(`${newestDate}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end - start < 2 * DAY) return [];

  const result: { dayOffset: number; date: string }[] = [];
  for (let time = end - DAY; time > start && result.length < limit; time -= DAY) {
    const date = new Date(time).toISOString().slice(0, 10);
    if (touched.has(date)) continue;
    result.push({ dayOffset: Math.round((end - time) / DAY), date });
  }
  return result;
}

let alarmIndexPromise: Promise<AlarmIndex> | null = null;

async function buildAlarmIndex(): Promise<AlarmIndex> {
  const core = await getCore();
  const { alarmsIndex } = core;
  const byId = new Map<string, Alarm>();
  const levelCounts: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };
  const statusCounts: Record<string, number> = {};
  const touchedPoints = new Set<string>();
  const touchedDates = new Set<string>();
  let oldestOffset = 0;
  const scriptAlarms: Alarm[] = [];
  let downgraded = 0;
  let falsePositive = 0;
  let level4LastHour = 0;
  let longestTitle: Alarm | null = null;
  let mostKeywords: Alarm | null = null;
  let longestRoom: Alarm | null = null;

  for (let i = 0; i < alarmsIndex.shards.length; i += 1) {
    const shard = await loadAlarmShard("", alarmsIndex, i, fileFetcher);
    for (const alarm of shard.alarms) {
      byId.set(alarm.id, alarm);
      levelCounts[alarm.level] = (levelCounts[alarm.level] ?? 0) + 1;
      statusCounts[alarm.status] = (statusCounts[alarm.status] ?? 0) + 1;
      touchedPoints.add(alarm.point_id);
      touchedDates.add(toDateString(alarm.ts_offset_minutes));
      oldestOffset = Math.max(oldestOffset, alarm.ts_offset_minutes);
      if (alarm.script_id) scriptAlarms.push(alarm);
      if (alarm.downgraded) downgraded += 1;
      if (alarm.false_positive) falsePositive += 1;
      if (alarm.level === 4 && alarm.ts_offset_minutes < 60) level4LastHour += 1;
      if (!longestTitle || alarm.title.length > longestTitle.title.length) longestTitle = alarm;
      if (!mostKeywords || alarm.keywords.length > mostKeywords.keywords.length) mostKeywords = alarm;
      if (!longestRoom || alarm.point_room.length > longestRoom.point_room.length) longestRoom = alarm;
    }
  }

  // 首尾两天只被覆盖了半天（数据从某个下午开始、锚点是正午），不能算「0 告警自然日」
  const oldestDate = toDateString(oldestOffset);
  const newestDate = toDateString(0);
  const emptyDays: AvExtremes["emptyDays"] = emptyNaturalDays(touchedDates, oldestDate, newestDate, 3);

  const zeroAlarmPoints = core.points
    .filter((point) => !touchedPoints.has(point.id))
    .slice(0, 3)
    .map((point) => ({ id: point.id, room: point.room, siteId: point.site_id }));

  if (!longestTitle || !mostKeywords || !longestRoom) {
    throw new Error("告警分片为空，无法生成极端值样本");
  }

  return {
    byId,
    extremes: {
      longestTitle,
      mostKeywords,
      longestRoom,
      total: byId.size,
      levelCounts,
      statusCounts,
      scriptAlarms,
      downgraded,
      falsePositive,
      emptyDays,
      zeroAlarmPoints,
      level4LastHour,
    },
  };
}

function getAlarmIndex(): Promise<AlarmIndex> {
  alarmIndexPromise ??= buildAlarmIndex();
  return alarmIndexPromise;
}

/** 按 id 取单条告警（深链接 `/av/alarm/AL-00042` 用）。 */
export async function getAlarmById(id: string): Promise<Alarm | null> {
  const { byId } = await getAlarmIndex();
  return byId.get(id) ?? null;
}

/** 按 id 批量取告警，保持传入顺序；找不到的 id 直接忽略。 */
export async function getAlarmsByIds(ids: string[]): Promise<Alarm[]> {
  const { byId } = await getAlarmIndex();
  return ids.map((id) => byId.get(id)).filter((alarm): alarm is Alarm => Boolean(alarm));
}

/** `/av/__stress` 的极端值样本集合。 */
export async function getExtremes(): Promise<AvExtremes> {
  return (await getAlarmIndex()).extremes;
}

/** 数据集索引（页面页脚/版本号用）。 */
export async function getDatasetIndex(): Promise<DatasetIndex> {
  return (await getCore()).index;
}

export async function getIncidentById(id: string): Promise<Incident | null> {
  const core = await getCore();
  return core.incidents.find((incident) => incident.id === id) ?? null;
}

let spectraPromise: Promise<Spectrum[]> | null = null;

/** 频谱整包（638KB，12 段）。只有音频分析页需要，单独缓存，不进核心数据。 */
export function getSpectra(): Promise<Spectrum[]> {
  spectraPromise ??= fileFetcher("/spectra.json").then((data) => data as Spectrum[]);
  return spectraPromise;
}

export async function getSpectrumByAlarm(alarmId: string): Promise<Spectrum | null> {
  const spectra = await getSpectra();
  return spectra.find((spectrum) => spectrum.alarm_id === alarmId) ?? null;
}

export async function getSpectrumById(id: string): Promise<Spectrum | null> {
  const spectra = await getSpectra();
  return spectra.find((spectrum) => spectrum.id === id) ?? null;
}

export async function getTranscriptByAlarm(alarmId: string): Promise<Transcript | null> {
  const core = await getCore();
  return core.transcripts.find((transcript) => transcript.alarm_id === alarmId) ?? null;
}
