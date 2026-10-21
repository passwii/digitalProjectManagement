// 数据加载器：把 web/public/stream-monitor-data 下的静态 JSON 组装成带类型的数据集。
//
// 用法（Next 页面 / 浏览器）：
//   import { loadCore, loadAlarmPage } from "@/lib/av/load";
//   const core = await loadCore();               // 首屏：约 890KB（不含告警明细与频谱）
//   const page = await loadAlarmPage(core.alarmsIndex); // 告警按 cursor 懒加载（条数由调用方传入；/alarm 用 ALARM_PAGE_SIZE = 12）
//
// 用法（Node 单测）：
//   const core = await loadCore(dir, fileFetcher)  // 注入读文件的 fetcher
//
// 设计原则：
//   · 首屏绝不拉全量告警（9 个分片 ≈ 10.1MB）
//   · 频谱单独加载（≈ 640KB），只有音频分析页需要
//   · 所有错误都带 URL 与 HTTP 状态，线上排查不用猜
import type {
  AlarmPage,
  AlarmsIndex,
  AlarmShardFile,
  AuditLog,
  Dataset,
  DatasetCore,
  DatasetIndex,
  Device,
  DeviceStats,
  Incident,
  Kpi,
  OverviewRanges,
  Point,
  Rankings,
  Rule,
  SceneDef,
  Site,
  Spectrum,
  Transcript,
  Trends,
} from "./types";
import { clampPageSize, parseCursor, takeFromShard } from "./pagination";

/** 默认静态路径：Next 把 web/public 映射到站点根路径 */
export const DEFAULT_BASE_URL = "/stream-monitor-data";

/** 取数函数：返回已解析的 JSON；测试里可以注入读文件的实现 */
export type Fetcher = (url: string) => Promise<unknown>;

interface FetchResponseLike {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

const defaultFetcher: Fetcher = async (url) => {
  const g = globalThis as { fetch?: (input: string) => Promise<FetchResponseLike> };
  if (typeof g.fetch !== "function") {
    throw new Error(`当前运行环境没有 fetch，加载 ${url} 失败。Node 环境请注入自定义 fetcher。`);
  }
  const res = await g.fetch(url);
  if (!res.ok) throw new Error(`加载失败 ${url}（HTTP ${res.status}）`);
  return res.json();
};

async function getJson<T>(baseUrl: string, file: string, fetcher: Fetcher = defaultFetcher): Promise<T> {
  const url = `${baseUrl.replace(/\/$/, "")}/${file}`;
  const raw = await fetcher(url);
  if (raw === null || typeof raw !== "object") {
    throw new Error(`数据文件 ${url} 不是合法 JSON 对象`);
  }
  return raw as T;
}

/** 数据集索引（含文件清单 / 规模 / 剧本摘要） */
export function loadIndex(baseUrl = DEFAULT_BASE_URL, fetcher?: Fetcher): Promise<DatasetIndex> {
  return getJson<DatasetIndex>(baseUrl, "index.json", fetcher);
}

/** 告警索引（分片清单 + 游标分页契约）；首屏只需要它，不含明细 */
export function loadAlarmsIndex(baseUrl = DEFAULT_BASE_URL, fetcher?: Fetcher): Promise<AlarmsIndex> {
  return getJson<AlarmsIndex>(baseUrl, "alarms-index.json", fetcher);
}

/** 读取单个告警分片（分片内已按「新 → 旧」排好） */
export function loadAlarmShard(
  baseUrl: string,
  index: AlarmsIndex,
  shardIndex: number,
  fetcher?: Fetcher,
): Promise<AlarmShardFile> {
  if (shardIndex < 0 || shardIndex >= index.shards.length) {
    throw new Error(`告警序号越界：${shardIndex}`);
  }
  return getJson<AlarmShardFile>(baseUrl, index.shards[shardIndex].file, fetcher);
}

/**
 * 首屏核心数据：不含告警明细、不含频谱矩阵。
 * 实测约 890KB（devices.json 506KB + incidents.json 187KB + points.json 69KB + audit-logs.json 77KB），
 * 可在服务端组件或客户端一次拉完；若首屏只要概览，建议按需加载 devices / audit-logs。
 */
export async function loadCore(baseUrl = DEFAULT_BASE_URL, fetcher?: Fetcher): Promise<DatasetCore> {
  const [
    index, alarmsIndex, org, sites, points, devices, deviceStats, users,
    incidents, kpi, trends, rankings, scenes, algorithms, rules, auditLogs, transcripts,
  ] = await Promise.all([
    getJson<DatasetIndex>(baseUrl, "index.json", fetcher),
    getJson<AlarmsIndex>(baseUrl, "alarms-index.json", fetcher),
    getJson<DatasetCore["org"]>(baseUrl, "org.json", fetcher),
    getJson<Site[]>(baseUrl, "sites.json", fetcher),
    getJson<Point[]>(baseUrl, "points.json", fetcher),
    getJson<Device[]>(baseUrl, "devices.json", fetcher),
    getJson<DeviceStats>(baseUrl, "device-stats.json", fetcher),
    getJson<DatasetCore["users"]>(baseUrl, "users.json", fetcher),
    getJson<Incident[]>(baseUrl, "incidents.json", fetcher),
    getJson<Kpi>(baseUrl, "kpi.json", fetcher),
    getJson<Trends>(baseUrl, "trends.json", fetcher),
    getJson<Rankings>(baseUrl, "rankings.json", fetcher),
    getJson<SceneDef[]>(baseUrl, "scenes.json", fetcher),
    getJson<DatasetCore["algorithms"]>(baseUrl, "algorithms.json", fetcher),
    getJson<Rule[]>(baseUrl, "rules.json", fetcher),
    getJson<AuditLog[]>(baseUrl, "audit-logs.json", fetcher),
    getJson<Transcript[]>(baseUrl, "transcripts.json", fetcher),
  ]);
  return {
    index, alarmsIndex, org, sites, points, devices, deviceStats, users,
    incidents, kpi, trends, rankings, scenes, algorithms, rules, auditLogs, transcripts,
  };
}

/**
 * 总览页三档时间范围（≈30KB）。单独加载：只有 `/overview` 需要，
 * 不必让其余页面为它付首屏预算（与 `loadCore` 的 890KB 分开放）。
 */
export function loadOverviewRanges(
  baseUrl = DEFAULT_BASE_URL,
  fetcher?: Fetcher,
): Promise<OverviewRanges> {
  return getJson<OverviewRanges>(baseUrl, "overview-ranges.json", fetcher);
}

/** 整套数据（含频谱矩阵）。演示 / 单测用；页面首屏请用 loadCore。 */
export async function loadDataset(baseUrl = DEFAULT_BASE_URL, fetcher?: Fetcher): Promise<Dataset> {
  const [core, spectra] = await Promise.all([
    loadCore(baseUrl, fetcher),
    getJson<Spectrum[]>(baseUrl, "spectra.json", fetcher),
  ]);
  return { ...core, spectra };
}

/** 单独加载某段频谱（先取一次 spectra.json，再按 id 找；页面可自行缓存） */
export async function loadSpectrum(
  id: string,
  baseUrl = DEFAULT_BASE_URL,
  fetcher?: Fetcher,
): Promise<Spectrum | null> {
  const spectra = await getJson<Spectrum[]>(baseUrl, "spectra.json", fetcher);
  return spectra.find((s) => s.id === id) ?? null;
}

/**
 * 游标分页读取告警。跨分片自动续接，返回本页数据与下一页游标。
 * - 首页 cursor 传 null
 * - next_cursor 为 null 表示已到最后一页
 */
export async function loadAlarmPage(
  index: AlarmsIndex,
  cursor: string | null = null,
  pageSize?: number,
  baseUrl = DEFAULT_BASE_URL,
  fetcher?: Fetcher,
): Promise<AlarmPage> {
  const size = clampPageSize(pageSize, index);
  let position = parseCursor(cursor, index);
  const alarms: AlarmPage["alarms"] = [];
  let nextCursor: string | null = null;

  while (alarms.length < size) {
    const shard = await loadAlarmShard(baseUrl, index, position.shard, fetcher);
    const take = takeFromShard(shard, position, size - alarms.length, index);
    alarms.push(...take.alarms);
    nextCursor = take.next_cursor;
    if (take.done || alarms.length >= size || !take.next_cursor) break;
    position = parseCursor(take.next_cursor, index);
  }

  return { alarms, next_cursor: nextCursor, total: index._meta.total };
}

/**
 * 一次性读取全部告警（≈11MB，仅用于离线分析 / 单测）。
 * 页面里请用 loadAlarmPage；需要「最近 N 条」时按分片顺序逐步读。
 */
export async function loadAllAlarms(
  index: AlarmsIndex,
  baseUrl = DEFAULT_BASE_URL,
  fetcher?: Fetcher,
): Promise<AlarmPage["alarms"]> {
  const out: AlarmPage["alarms"] = [];
  for (let i = 0; i < index.shards.length; i++) {
    const shard = await loadAlarmShard(baseUrl, index, i, fetcher);
    out.push(...shard.alarms);
  }
  return out;
}
