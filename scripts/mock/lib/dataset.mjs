// 数据集读取与时间换算（校验脚本共用）
// 生产环境的前端读取器在 web/lib/av/，这里是 Node 侧的无依赖实现。
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(__dirname, "..", "..", "..");
/** 数据落位：web/public/stream-monitor-data（Next 静态服务） */
export const DATA_DIR = join(REPO_ROOT, "web", "public", "stream-monitor-data");

export function readJson(name, dir = DATA_DIR) {
  const path = join(dir, name);
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`读不到数据文件 ${name}（${path}）：${err.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`数据文件 ${name} 不是合法 JSON：${err.message}`);
  }
}

/** 读取告警索引 + 全部分片，拼回完整列表（顺序 = 新 → 旧） */
export function readAllAlarms(dir = DATA_DIR) {
  const index = readJson("alarms-index.json", dir);
  const alarms = [];
  for (const shard of index.shards) {
    const body = readJson(shard.file, dir);
    alarms.push(...body.alarms);
  }
  return { index, alarms };
}

/** 一次性读取整套数据（校验脚本用；首屏不要这么干） */
export function readDataset(dir = DATA_DIR) {
  const index = readJson("index.json", dir);
  const alarmsBundle = readAllAlarms(dir);
  return {
    index,
    alarmsIndex: alarmsBundle.index,
    alarms: alarmsBundle.alarms,
    org: readJson("org.json", dir),
    sites: readJson("sites.json", dir),
    points: readJson("points.json", dir),
    devices: readJson("devices.json", dir),
    deviceStats: readJson("device-stats.json", dir),
    users: readJson("users.json", dir),
    incidents: readJson("incidents.json", dir),
    kpi: readJson("kpi.json", dir),
    trends: readJson("trends.json", dir),
    rankings: readJson("rankings.json", dir),
    scenes: readJson("scenes.json", dir),
    algorithms: readJson("algorithms.json", dir),
    rules: readJson("rules.json", dir),
    auditLogs: readJson("audit-logs.json", dir),
    spectra: readJson("spectra.json", dir),
    transcripts: readJson("transcripts.json", dir),
  };
}

// ============================================================
// 时间口径：显式 UTC+8，与跑脚本的机器时区无关
// ============================================================
export const TZ_OFFSET_MIN = 8 * 60;
export const DAY_MINUTES = 24 * 60;
export const ANCHOR_CLOCK_MINUTES = 12 * 60;

export function makeTime(anchorIso) {
  const anchorMs = new Date(anchorIso).getTime();
  const localMs = (offset) => anchorMs - offset * 60000 + TZ_OFFSET_MIN * 60000;
  const clockMinutes = (offset) =>
    Math.floor((((localMs(offset) % (DAY_MINUTES * 60000)) + DAY_MINUTES * 60000) % (DAY_MINUTES * 60000)) / 60000);
  const dayNumber = (offset) => Math.floor(localMs(offset) / (DAY_MINUTES * 60000));
  const anchorDay = dayNumber(0);
  return {
    anchorMs,
    clockMinutes,
    clockHour: (offset) => Math.floor(clockMinutes(offset) / 60),
    clockLabel: (offset) => {
      const m = clockMinutes(offset);
      return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
    },
    dayDiff: (offset) => anchorDay - dayNumber(offset),
    dateLabel: (offset) => {
      const d = new Date(localMs(offset));
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
    },
  };
}
