// 智能音视频平台 · Mock 数据生成器（Stage 1 重构版）
//
// 设计目标有三个，缺一不可：
//   1. 可复现    —— 固定随机种子，同一份代码每次产出逐字节一致（截图可复现）
//   2. 可对账    —— 所有聚合都由明细现算，任何「声明值 vs 明细值」都必须相等
//   3. 可按需加载 —— 告警按月分片 + 索引，首屏只取索引，不吞 5MB
//
// 时间模型（整套数据最关键的一条约定）：
//   数据里没有绝对时间，只有「距锚点多少分钟」（ts_offset_minutes）。
//   · 偏移越小 → 越新。所有数组统一按「新 → 旧」排序（偏移升序）。
//   · 绝对时间 = anchor - offset。
//   · 锚点固定为 2026-10-19T12:00:00+08:00，且所有「钟点 / 自然日」计算都按
//     UTC+8 显式换算，不依赖跑脚本的机器时区（否则换台机器热力图就错位）。
//
// 运行：node scripts/mock/generate.mjs  （零依赖，纯 Node 内置模块）

import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
/** 数据集落位：Next 静态服务目录，前端 fetch("/stream-monitor-data/...") */
const OUT = join(REPO_ROOT, "web", "public", "stream-monitor-data");

// ============================================================
// 0. 确定性随机（mulberry32）
// ============================================================
const SEED = 20260701;
function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = makeRng(SEED);
const rint = (min, max) => Math.floor(rng() * (max - min + 1)) + min;
const pick = (arr) => arr[Math.floor(rng() * arr.length)];
const pickMany = (arr, n) => {
  const copy = [...arr];
  const out = [];
  while (out.length < n && copy.length) out.push(copy.splice(Math.floor(rng() * copy.length), 1)[0]);
  return out;
};
const chance = (p) => rng() < p;
function weightedPick(list) {
  const total = list.reduce((s, x) => s + x.weight, 0);
  let r = rng() * total;
  for (const item of list) {
    r -= item.weight;
    if (r <= 0) return item;
  }
  return list[list.length - 1];
}

// ============================================================
// 1. 时间锚点与「钟点 / 自然日」换算（显式 UTC+8，机器时区无关）
// ============================================================
const DEMO_ANCHOR = "2026-10-19T12:00:00+08:00"; // 演示当天正午
const ANCHOR_MS = new Date(DEMO_ANCHOR).getTime();
const MIN = 60 * 1000;
const HOUR = 60; // 分钟
const DAY = 24 * 60; // 分钟
const TZ_OFFSET_MIN = 8 * 60; // 展示时区 UTC+8
const ANCHOR_CLOCK = 12 * 60; // 锚点的钟点 12:00

const localMs = (offset) => ANCHOR_MS - offset * MIN + TZ_OFFSET_MIN * MIN;
/** 偏移 → 钟点分钟数（0..1439，UTC+8） */
const clockMinutes = (offset) => Math.floor(((localMs(offset) % (DAY * MIN)) + DAY * MIN) % (DAY * MIN) / MIN);
/** 偏移 → 时钟小时 0..23（UTC+8） */
const clockHour = (offset) => Math.floor(clockMinutes(offset) / 60);
/** 偏移 → 自然日序号（UTC+8 的绝对天号） */
const dayNumber = (offset) => Math.floor(localMs(offset) / (DAY * MIN));
const ANCHOR_DAY = dayNumber(0);
/** 偏移 → 「距今天几个自然日」，0 = 今天 */
const dayDiff = (offset) => ANCHOR_DAY - dayNumber(offset);
/** 某自然日 d、某钟点 c 对应的偏移（c > 12:00 时自动落到前一天，仍是最新可能的时刻） */
const offsetFor = (d, clockMinute, minute = 0) =>
  d * DAY + (((ANCHOR_CLOCK - (clockMinute + minute)) % DAY) + DAY) % DAY;

/** 「几天前」的某钟点：参数 daysAgo 就是真实的 dayDiff（1 = 昨天，0 = 今天）。
 *  offsetFor 的 d 是「第 d 个时间槽」，钟点晚于锚点 12:00 时会落到第 d+1 天前；
 *  凡是叙事里讲「N 天前」的地方一律用这个函数，别再自己减一。
 */
const offsetDaysAgo = (daysAgo, clockMinute, minute = 0) => {
  if (!Number.isInteger(daysAgo) || daysAgo < 1) {
    throw new Error(`offsetDaysAgo: daysAgo 必须是 ≥ 1 的整数（收到 ${daysAgo}）`);
  }
  return Math.max(0, offsetFor(daysAgo, clockMinute, minute) - DAY);
};

// ============================================================
// 2. 组织 / 站点
// ============================================================
const ORG = {
  id: "org-001",
  name: "智能音视频平台",
  shortName: "智能音视频平台",
  brandLine: "多模态融合感知 · 全场景智能安防",
  version: "v3.9.0",
  copyright: "2026 智能音视频平台",
};

const SITES = [
  {
    id: "site-01", code: "SY", name: "示范第一中学", type: "school", scene: "campus",
    area: "华东", capacity: 3200, scene_token: "scene.campus",
  },
  {
    id: "site-02", code: "HM", name: "市人民医院", type: "hospital", scene: "hospital",
    area: "华东", capacity: 1800, scene_token: "scene.hospital",
  },
  {
    id: "site-03", code: "GA", name: "市执法办案管理中心", type: "police", scene: "justice",
    area: "华东", capacity: 260, scene_token: "scene.justice",
  },
];

// ============================================================
// 3. 点位
//    房间类型必须与楼栋/楼层语义相容（否则楼层平面图无法落点）：
//      · 教学楼：教室 / 走廊 / 卫生间 / 楼梯间
//      · 宿舍楼：宿舍 / 走廊 / 卫生间 / 楼梯间
//      · 食堂：就餐区 / 走廊
//      · 操场、天台：只有 1 层，房型就是 playground / rooftop
// ============================================================
const points = [];
const EXCLUDED_POINT_IDS = new Set(); // 不参与基础告警抽样：空态点位 + 剧本专用点位

const CAMPUS_BUILDINGS = [
  { code: "B1", name: "教学楼 A", floors: 4, perFloor: 8, types: ["classroom", "classroom", "corridor", "restroom", "stairs"] },
  { code: "B2", name: "教学楼 B", floors: 4, perFloor: 8, types: ["classroom", "classroom", "corridor", "restroom", "stairs"] },
  { code: "B3", name: "教学楼 C", floors: 4, perFloor: 8, types: ["classroom", "corridor", "restroom", "stairs"] },
  { code: "SS", name: "宿舍楼", floors: 5, perFloor: 8, types: ["dorm", "dorm", "corridor", "restroom", "stairs"] },
  { code: "ST", name: "食堂", floors: 2, perFloor: 6, types: ["canteen", "storage", "corridor"] },
  { code: "GY", name: "操场", floors: 1, perFloor: 6, types: ["playground"] },
  { code: "TT", name: "天台", floors: 1, perFloor: 4, types: ["rooftop"] },
];

const ROOM_TYPE_NAME = {
  classroom: "教室", corridor: "走廊", restroom: "卫生间", stairs: "楼梯间",
  dorm: "宿舍", canteen: "就餐区", playground: "操场", rooftop: "天台",
  lobby: "大厅", triage: "分诊台", window: "窗口", pharmacy: "药房",
  surgical: "手术区", icu: "ICU", duty: "值班室", ward: "病房",
  storage: "库房", interrogation: "讯问室", waiting: "等候区",
  archive: "档案室", command: "指挥室", office: "办公室", meeting: "会议室",
  machine: "机房", morgue: "太平间", utility: "后勤区",
};
const RISK_BY_TYPE = {
  restroom: 3, corridor: 2, classroom: 1, stairs: 2, dorm: 2, canteen: 1,
  playground: 2, rooftop: 3, lobby: 2, triage: 3, window: 1, pharmacy: 3,
  surgical: 3, icu: 2, duty: 2, ward: 1, storage: 3, interrogation: 3,
  waiting: 2, archive: 2, command: 2, office: 1, meeting: 1, machine: 3,
  morgue: 3, utility: 2,
};

const GY_ZONES = ["东侧跑道", "西侧篮球场", "南侧看台", "北侧器械区", "中央草坪", "入口通道"];
const TT_ZONES = ["东区设备平台", "西区排风机组", "中央检修通道", "南侧女儿墙"];

let pointSeq = 0;
function pushPoint({ siteId, building, buildingName, floor, room, roomType, index, hasDevice, note = null, id }) {
  pointSeq += 1;
  const pid = id || `PT-${building}-${floor}F${String(index).padStart(2, "0")}`;
  points.push({
    id: pid,
    site_id: siteId,
    building,
    building_name: buildingName,
    floor,
    room,
    room_type: roomType,
    risk_weight: RISK_BY_TYPE[roomType] ?? 1,
    has_device: Boolean(hasDevice),
    note,
  });
  return pid;
}

// —— 校园：按楼栋约束生成 ——
for (const b of CAMPUS_BUILDINGS) {
  for (let f = 1; f <= b.floors; f++) {
    for (let i = 1; i <= b.perFloor; i++) {
      // 食堂只有 1 层是就餐区，2 层是后厨/库房；室外类房型只能落在 1 层
      const pool = b.code === "ST" && f > 1 ? ["storage", "corridor", "utility"] : b.types;
      const t = pick(pool);
      const roomNo = `${f}${String(i).padStart(2, "0")}`;
      let room;
      if (t === "playground") room = `操场${GY_ZONES[(i - 1) % GY_ZONES.length]}`;
      else if (t === "rooftop") room = `天台${TT_ZONES[(i - 1) % TT_ZONES.length]}`;
      else if (t === "canteen") room = `食堂${f}楼${roomNo}${ROOM_TYPE_NAME[t]}`;
      else room = `${b.name}${f}楼${roomNo}${ROOM_TYPE_NAME[t]}`;
      pushPoint({
        siteId: "site-01", building: b.code, buildingName: b.name, floor: f,
        room, roomType: t, index: i, hasDevice: chance(0.87),
      });
    }
  }
}

// —— 医院：66 个点位（分层显式声明，房间名贴近真实科室） ——
const HOSPITAL_SPEC = [
  // 1F 门诊 / 急诊
  [1, "门诊大厅", "lobby"], [1, "门诊大厅东侧闸机", "lobby"], [1, "门诊大厅西侧出口", "lobby"],
  [1, "急诊分诊台", "triage"], [1, "急诊抢救区", "triage"], [1, "输液室", "ward"],
  [1, "挂号收费窗口 A", "window"], [1, "挂号收费窗口 B", "window"],
  [1, "急诊走廊", "corridor"], [1, "门诊走廊", "corridor"], [1, "导医台", "lobby"],
  [1, "药房取药窗口", "pharmacy"],
  // 2F 检验 / 门诊
  [2, "药房", "pharmacy"], [2, "检验科走廊", "corridor"], [2, "检验科采血区", "window"],
  [2, "内科门诊走廊", "corridor"], [2, "超声检查室", "surgical"], [2, "候诊区 A", "waiting"],
  [2, "候诊区 B", "waiting"], [2, "收费处走廊", "corridor"], [2, "楼梯间东", "stairs"],
  [2, "楼梯间西", "stairs"], [2, "门诊办公室", "office"],
  // 3F 手术 / ICU
  [3, "手术室 B 区入口", "surgical"], [3, "手术室 C 区入口", "surgical"],
  [3, "手术室 B 区入口东侧二次缓冲区与医护人员更衣通道及器械暂存间", "surgical"],
  [3, "ICU 值班室", "duty"], [3, "ICU 走廊", "corridor"], [3, "外科门诊走廊", "corridor"],
  [3, "骨科候诊区", "waiting"], [3, "手术家属等候区", "waiting"], [3, "走廊东", "corridor"],
  [3, "走廊西", "corridor"], [3, "楼梯间", "stairs"],
  // 4F 住院 A 区
  [4, "住院部 A 区走廊", "corridor"], [4, "病房 401", "ward"], [4, "病房 402", "ward"],
  [4, "病房 403", "ward"], [4, "护士站 A", "duty"], [4, "配药室", "pharmacy"],
  [4, "医护通道", "corridor"], [4, "楼梯间", "stairs"], [4, "污物通道", "utility"],
  // 5F 产科
  [5, "产科病房走廊", "corridor"], [5, "病房 501", "ward"], [5, "病房 502", "ward"],
  [5, "病房 503", "ward"], [5, "婴儿室", "ward"], [5, "护士站 B", "duty"],
  [5, "探视等候区", "waiting"], [5, "楼梯间", "stairs"], [5, "医护更衣室", "utility"],
  // 6F 后勤
  [6, "设备库房", "storage"], [6, "后勤走廊", "corridor"], [6, "太平间入口", "morgue"],
  [6, "中心供氧站", "utility"], [6, "配电间", "machine"], [6, "楼梯间", "stairs"],
  [6, "污水站", "utility"], [6, "医疗废物暂存间", "storage"],
  // 7F 精神心理
  [7, "精神科门诊走廊", "corridor"], [7, "心理咨询室", "office"], [7, "团体治疗室", "meeting"],
  [7, "候诊区", "waiting"], [7, "楼梯间", "stairs"], [7, "走廊", "corridor"],
];
{
  const perFloor = new Map();
  for (const [floor, room, type] of HOSPITAL_SPEC) {
    const idx = (perFloor.get(floor) || 0) + 1;
    perFloor.set(floor, idx);
    pushPoint({
      siteId: "site-02", building: "HM", buildingName: "门诊住院综合楼", floor,
      room: `${floor}楼${room}`, roomType: type, index: idx, hasDevice: chance(0.95),
    });
  }
}

// —— 公安：44 个点位 ——
const POLICE_SPEC = [
  ...Array.from({ length: 12 }, (_, i) => [1, `讯问室 ${String(i + 1).padStart(2, "0")}`, "interrogation"]),
  [1, "等候区", "waiting"], [1, "案管中心", "archive"],
  [1, "人身安全检查室", "office"], [1, "候问室", "waiting"],
  [2, "指挥研判室", "command"], [2, "视频会商室", "meeting"], [2, "机房", "machine"],
  [2, "档案室 A", "archive"], [2, "档案室 B", "archive"], [2, "值班室", "duty"],
  [2, "走廊东", "corridor"], [2, "走廊西", "corridor"], [2, "楼梯间东", "stairs"], [2, "楼梯间西", "stairs"],
  [3, "民警办公室 01", "office"], [3, "民警办公室 02", "office"],
  [3, "民警办公室 03", "office"], [3, "民警办公室 04", "office"],
  [3, "会议室", "meeting"], [3, "接待室", "waiting"],
  [3, "走廊东", "corridor"], [3, "走廊西", "corridor"], [3, "楼梯间东", "stairs"], [3, "楼梯间西", "stairs"],
  [4, "案件研究室 01", "office"], [4, "案件研究室 02", "office"], [4, "案件研究室 03", "office"],
  [4, "培训室", "meeting"], [4, "走廊", "corridor"], [4, "楼梯间", "stairs"],
  [4, "物证保管室", "storage"], [4, "心理疏导室", "office"],
];
{
  const perFloor = new Map();
  for (const [floor, room, type] of POLICE_SPEC) {
    const idx = (perFloor.get(floor) || 0) + 1;
    perFloor.set(floor, idx);
    pushPoint({
      siteId: "site-03", building: "GA", buildingName: "执法办案楼", floor,
      room: `${floor}楼${room}`, roomType: type, index: idx, hasDevice: chance(0.96),
    });
  }
}

// —— 空态点位（永远 0 告警，用于「暂无数据」界面） ——
const EMPTY_POINTS = [
  ["site-01", "T1"], // 天台南侧女儿墙
  ["site-02", "T7"], // 医疗废物暂存间
  ["site-03", "T1"], // 物证保管室
];
{
  const picks = [
    points.find((p) => p.room === "天台南侧女儿墙"),
    points.find((p) => p.room.endsWith("医疗废物暂存间")),
    points.find((p) => p.room.endsWith("物证保管室")),
  ].filter(Boolean);
  for (const p of picks) {
    p.note = "点位新装，暂无告警数据";
    p.has_device = true;
    EXCLUDED_POINT_IDS.add(p.id);
  }
  void EMPTY_POINTS;
}

// ============================================================
// 4. 设备（含设备画像：固件、自检、OTA、信号序列）
// ============================================================
const DEVICE_MODELS = [
  { model: "AV-MIC-S6", type: "拾音终端", kind: "audio", fw: ["3.4.0", "3.4.1", "3.4.2"] },
  { model: "AV-MIC-S8", type: "阵列拾音器", kind: "audio", fw: ["2.8.4", "2.8.6", "2.9.0"] },
  { model: "AV-CAM-360", type: "全景摄像头", kind: "video", fw: ["5.2.1", "5.2.3", "5.3.0"] },
  { model: "AV-CAM-PTZ", type: "球机", kind: "video", fw: ["4.6.2", "4.7.0"] },
  { model: "AV-GW-200", type: "网关", kind: "gateway", fw: ["1.9.3", "2.0.0"] },
];
const AUDIO_MODELS = DEVICE_MODELS.filter((m) => m.kind === "audio");
const VIDEO_MODELS = DEVICE_MODELS.filter((m) => m.kind === "video");

const devices = [];
let devSeq = 0;
const devicePoints = points.filter((p) => p.has_device);
const devicesByPoint = new Map();

function deviceProfile({ status, offlineOffset, seedIdx }) {
  const selfCheckCount = rint(2, 4);
  const checks = Array.from({ length: selfCheckCount }, (_, i) => ({
    at_offset_minutes:
      status === "online" ? rint(60, 4000) + i * rint(1440, 2880) : (offlineOffset ?? 600) + i * 1440,
    result: status === "maintenance" && i === 0 ? "warn" : status === "offline" ? "skip" : "pass",
    items: ["麦克风", "扬声器", "存储", "网络"].slice(0, rint(2, 4)),
  })).sort((a, b) => a.at_offset_minutes - b.at_offset_minutes);
  const otaCount = rint(0, 2);
  const ota = Array.from({ length: otaCount }, (_, i) => ({
    id: `OTA-${String(seedIdx).padStart(4, "0")}-${i + 1}`,
    from_version: `${rint(2, 5)}.${rint(0, 9)}.${rint(0, 4)}`,
    to_version: `${rint(3, 5)}.${rint(0, 9)}.${rint(0, 4)}`,
    at_offset_minutes: rint(2 * 1440, 90 * 1440),
    status: chance(0.88) ? "success" : "failed",
    trigger: pick(["手动", "批量计划任务", "安全补丁"]),
  })).sort((a, b) => a.at_offset_minutes - b.at_offset_minutes);
  // RSSI 统一是「负 dBm」（在线 / 维护），只有离线设备用 0 当「无上报」哨兵。
  // 之前按设备类型决定正负号，audio / gateway 会落出 +52~+98 这种物理上不存在的 dBm 值。
  const seriesLen = 24;
  const signalSeries = Array.from({ length: seriesLen }, (_, i) => {
    const base = status === "online" ? rint(52, 98) : status === "maintenance" ? rint(30, 60) : 0;
    return { at_offset_minutes: i * HOUR, rssi_dbm: status === "offline" ? 0 : -base };
  });
  return { self_check_history: checks, ota_records: ota, signal_series: signalSeries };
}

for (const p of devicePoints) {
  devSeq += 1;
  const site = SITES.find((s) => s.id === p.site_id);
  const isKeyPoint = ["lobby", "triage", "surgical", "interrogation", "command", "waiting"].includes(p.room_type);
  const m = pick(AUDIO_MODELS);
  // 3 台离线 + 若干维护 + 1 台长时间离线（剧本 C） + 剧本 G 的批量离线组
  let status = "online";
  let offlineOffset = null;
  const isScriptCDevice = devSeq === 7;
  const isBatchGateway = devSeq === 41; // 剧本 G 的网关
  if (isScriptCDevice) {
    status = "offline";
    offlineOffset = 6 * DAY + 5 * HOUR; // 6 天 5 小时
  } else if (isBatchGateway) {
    status = "online"; // 网关本身在线，剧本 G 里再置为离线
  } else if (devSeq % 47 === 0) {
    status = "offline";
    offlineOffset = rint(30, 8 * HOUR);
  } else if (devSeq % 59 === 0) {
    status = "maintenance";
  }
  const id = `${m.model}-${String(1000 + devSeq)}`;
  const dev = {
    id,
    site_id: p.site_id,
    point_id: p.id,
    point_room: p.room,
    model: m.model,
    type_name: m.type,
    kind: m.kind,
    firmware: pick(m.fw),
    status,
    last_heartbeat_offset_minutes:
      status === "online" ? rint(0, 2) : status === "maintenance" ? rint(60, 600) : offlineOffset,
    uptime_days: status === "online" ? rint(3, 420) : rint(0, 30),
    // signal 是 0–100 的信号质量分（不是 dBm）：0 只作离线哨兵
    // 维护中设备也给一个质量分（不额外消耗随机流，避免后续数据整体漂移）
    signal: status === "online" ? rint(52, 98) : status === "maintenance" ? 20 + (devSeq % 35) : 0,
    cpu_percent: status === "online" ? rint(18, 88) : 0,
    storage_percent: rint(12, 91),
    mic_sensitivity_dbm: m.kind === "audio" ? -rint(32, 46) : null,
    self_check: status === "online"
      ? { result: "pass", at_offset_minutes: rint(60, 4000), items: ["麦克风", "扬声器", "存储", "网络"] }
      : { result: status === "offline" ? "skip" : "warn", at_offset_minutes: offlineOffset ?? rint(60, 900), items: ["麦克风", "网络"] },
    // 场景：至少包含所属站点的场景（多场景能力在平台层表达，不下放到单机）
    scenes: [site.scene],
    gateway_id: null,
    ...deviceProfile({ status, offlineOffset, seedIdx: 1000 + devSeq }),
    _building: p.building,
  };
  devices.push(dev);
  if (!devicesByPoint.has(p.id)) devicesByPoint.set(p.id, []);
  devicesByPoint.get(p.id).push(dev);
  if (isKeyPoint && chance(0.6)) {
    // 关键点位补一台摄像头（音频 + 视频双通道）
    devSeq += 1;
    const vm = pick(VIDEO_MODELS);
    const cam = {
      id: `${vm.model}-${String(1000 + devSeq)}`,
      site_id: p.site_id,
      point_id: p.id,
      point_room: p.room,
      model: vm.model,
      type_name: vm.type,
      kind: vm.kind,
      firmware: pick(vm.fw),
      status: "online",
      last_heartbeat_offset_minutes: rint(0, 2),
      uptime_days: rint(10, 380),
      signal: rint(60, 98),
      cpu_percent: rint(20, 70),
      storage_percent: rint(20, 90),
      mic_sensitivity_dbm: null,
      self_check: { result: "pass", at_offset_minutes: rint(120, 3000), items: ["镜头", "红外", "存储", "网络"] },
      scenes: [site.scene],
      gateway_id: null,
      ...deviceProfile({ status: "online", offlineOffset: null, seedIdx: 1000 + devSeq }),
      _building: p.building,
    };
    devices.push(cam);
    devicesByPoint.get(p.id).push(cam);
  }
}

// —— 网关：每个楼栋一台，挂到该楼栋的「天台/机房」点位 ——
const GATEWAYS_BY_BUILDING = new Map();
for (const b of CAMPUS_BUILDINGS.concat([{ code: "HM" }, { code: "GA" }])) {
  const siteId = b.code === "HM" ? "site-02" : b.code === "GA" ? "site-03" : "site-01";
  const anchorPoint =
    points.find((p) => p.site_id === siteId && p.building === b.code && ["rooftop", "machine", "storage"].includes(p.room_type)) ||
    points.find((p) => p.site_id === siteId && p.building === b.code);
  if (!anchorPoint) continue;
  devSeq += 1;
  const gm = DEVICE_MODELS.find((m) => m.kind === "gateway");
  const gw = {
    id: `${gm.model}-${String(1000 + devSeq)}`,
    site_id: siteId,
    point_id: anchorPoint.id,
    point_room: anchorPoint.room,
    model: gm.model,
    type_name: gm.type,
    kind: "gateway",
    firmware: pick(gm.fw),
    status: "online",
    last_heartbeat_offset_minutes: rint(0, 3),
    uptime_days: rint(60, 500),
    signal: rint(70, 98),
    cpu_percent: rint(10, 45),
    storage_percent: rint(10, 60),
    mic_sensitivity_dbm: null,
    self_check: { result: "pass", at_offset_minutes: rint(120, 2000), items: ["上行链路", "下行链路", "存储"] },
    scenes: [SITES.find((s) => s.id === siteId).scene],
    gateway_id: null,
    ...deviceProfile({ status: "online", offlineOffset: null, seedIdx: 1000 + devSeq }),
    _building: b.code,
  };
  devices.push(gw);
  GATEWAYS_BY_BUILDING.set(`${siteId}:${b.code}`, gw.id);
}
for (const d of devices) {
  if (d.kind === "gateway") continue;
  d.gateway_id = GATEWAYS_BY_BUILDING.get(`${d.site_id}:${d._building}`) || null;
}
for (const d of devices) delete d._building;

// —— 剧本 C 使用那台已离线 6 天 5 小时的设备 ——
const SCRIPT_C_OFFLINE = 6 * DAY + 5 * HOUR;
const scriptCDev = devices.find((d) => d.status === "offline" && d.last_heartbeat_offset_minutes === SCRIPT_C_OFFLINE);

// —— 场景汇总（从明细现算，写进 sites.json，站点概要卡直接用） ——
function siteSummary(siteId) {
  const ps = points.filter((p) => p.site_id === siteId);
  const ds = devices.filter((d) => d.site_id === siteId);
  const buildings = new Set(ps.map((p) => p.building));
  const floors = new Set(ps.map((p) => `${p.building}-${p.floor}`));
  return {
    buildings: buildings.size,
    floors: floors.size,
    points: ps.length,
    devices: ds.length,
    rooms: `${buildings.size} 栋 / ${floors.size} 个楼层 / ${ps.length} 个点位`,
  };
}
for (const s of SITES) Object.assign(s, siteSummary(s.id));

// ============================================================
// 5. 用户 / 角色（脱敏：姓 + *）
// ============================================================
const USERS = [
  { id: "u-001", name: "张*", role: "platform_admin", role_name: "平台管理员", dept: "综合安防运营中心", site_id: null },
  { id: "u-002", name: "王*", role: "site_admin", role_name: "校区安全主管", dept: "德育处", site_id: "site-01" },
  { id: "u-003", name: "李*", role: "duty_officer", role_name: "值班安保", dept: "安保处", site_id: "site-01" },
  { id: "u-004", name: "赵*", role: "head_teacher", role_name: "班主任", dept: "初二年级组", site_id: "site-01" },
  { id: "u-005", name: "陈*", role: "site_admin", role_name: "院区安全主管", dept: "保卫科", site_id: "site-02" },
  { id: "u-006", name: "刘*", role: "duty_officer", role_name: "值班安保", dept: "保卫科", site_id: "site-02" },
  { id: "u-007", name: "杨*", role: "auditor", role_name: "合规审计", dept: "警务督察", site_id: "site-03" },
  { id: "u-008", name: "黄*", role: "ops", role_name: "运维工程师", dept: "技术支持", site_id: null },
  { id: "u-009", name: "周*", role: "duty_officer", role_name: "值班安保", dept: "警务保障", site_id: "site-03" },
  { id: "u-010", name: "吴*", role: "site_admin", role_name: "办案区主管", dept: "执法办案管理中心", site_id: "site-03" },
];

// —— 归属人：事件 / 处置只能落在「本站点的人」或「显式跨站点职责」上 ——
// 之前一律 pick(USERS)，导致公安事件挂到校园管理员（55% 错配）。
const GLOBAL_STAFF_IDS = ["u-001", "u-008"]; // 平台管理员、运维工程师：跨站点职责
const OWNER_ROLES = ["site_admin", "duty_officer", "auditor"];
function pickSiteUser(siteId, roles = OWNER_ROLES) {
  const pool = USERS.filter((u) => u.site_id === siteId && roles.includes(u.role));
  if (pool.length) return pick(pool);
  const global = USERS.filter((u) => GLOBAL_STAFF_IDS.includes(u.id));
  return pick(global.length ? global : USERS);
}

// ============================================================
// 6. 告警
//    180 天基座，日均约 80 条。时间节律 + 周末衰减 + 考试周尖峰。
// ============================================================
const LEVEL_NAME = { 1: "一级·严重", 2: "二级·紧急", 3: "三级·一般", 4: "四级·提示" };
const TOTAL_DAYS = 180;
const BASE_COUNT = 102; // 折掉周末权重后日均 ≈ 80

const ALARM_TYPES = [
  { code: "bullying_keyword", name: "欺凌关键词", cat: "警情", scenes: ["campus"], weight: 9, baseLevel: 1 },
  { code: "abnormal_sound", name: "异常声音", cat: "声音检测", scenes: ["campus", "hospital"], weight: 12, baseLevel: 2 },
  { code: "decibel_exceed", name: "分贝超限", cat: "声音检测", scenes: ["campus", "hospital"], weight: 18, baseLevel: 3 },
  { code: "cry_scream", name: "哭声 / 呼救", cat: "声音检测", scenes: ["campus", "hospital"], weight: 7, baseLevel: 1 },
  { code: "fight_conflict", name: "冲突争吵", cat: "声音检测", scenes: ["hospital", "justice"], weight: 11, baseLevel: 2 },
  { code: "glass_break", name: "玻璃破碎", cat: "声音检测", scenes: ["campus", "hospital"], weight: 5, baseLevel: 2 },
  { code: "blacklist_match", name: "黑名单比对命中", cat: "警情", scenes: ["hospital"], weight: 4, baseLevel: 1 },
  { code: "panic_button", name: "一键报警", cat: "警情", scenes: ["hospital", "justice"], weight: 3, baseLevel: 1 },
  { code: "sleep_on_duty", name: "睡岗 / 离岗", cat: "行为检测", scenes: ["hospital", "justice"], weight: 8, baseLevel: 2 },
  { code: "people_gather", name: "局部聚集", cat: "行为检测", scenes: ["campus", "hospital"], weight: 6, baseLevel: 3 },
  { code: "intrusion", name: "区域入侵", cat: "行为检测", scenes: ["campus", "hospital", "justice"], weight: 5, baseLevel: 3 },
  { code: "device_offline", name: "设备离线", cat: "设备", scenes: ["campus", "hospital", "justice"], weight: 6, baseLevel: 3 },
  { code: "device_signal", name: "信号衰减", cat: "设备", scenes: ["campus", "hospital", "justice"], weight: 4, baseLevel: 3 },
  { code: "fire_smoke", name: "烟火检测", cat: "安全防控", scenes: ["campus", "hospital"], weight: 2, baseLevel: 1 },
  { code: "emotion_abnormal", name: "情绪异常波动", cat: "行为检测", scenes: ["justice"], weight: 5, baseLevel: 1 },
  { code: "compliance_risk", name: "合规风险提示", cat: "语义分析", scenes: ["justice"], weight: 4, baseLevel: 2 },
];

const KEYWORDS = {
  campus: ["救命", "打人", "别打了", "放手", "跪下", "你敢", "找死", "弄死你", "给钱", "交出来", "不想活了", "跳下去"],
  hospital: ["打人", "报警", "救命", "赔钱", "投诉", "曝光", "找记者", "来人", "砍", "捅"],
  justice: ["刑拘", "留置", "取保候审", "供述", "翻供", "矛盾", "不在场证明", "同案"],
};

function levelFor(base) {
  const r = rng();
  if (base === 1) return r < 0.42 ? 1 : r < 0.9 ? 2 : 3;
  if (base === 2) return r < 0.2 ? 1 : r < 0.8 ? 2 : r < 0.96 ? 3 : 4;
  return r < 0.1 ? 2 : r < 0.8 ? 3 : 4;
}

// 一天内的告警强度曲线（24 个钟点槽位，0 = 00:00）
const HOUR_WEIGHT = [
  0.34, 0.30, 0.27, 0.25, 0.27, 0.32, // 00-05 设备类为主，约白天的 1/3，但不断档
  0.05, 0.14, 0.42, 0.62, 0.68, 0.55, // 06-11
  0.38, 0.46, 0.72, 0.78, 0.70, 0.62, // 12-17
  0.28, 0.18, 0.12, 0.09, 0.06, 0.03, // 18-23
];
function dayFactor(d) {
  const dow = new Date(localMs(d * DAY)).getUTCDay();
  let f = 1;
  if (dow === 0 || dow === 6) f = 0.26;
  if (d === 47 || d === 48) f = 1.9; // 期中考试周
  if (d === 139 || d === 140) f = 1.7; // 期末考试周
  if (d === 152) f = 0; // 假期封校：0 告警自然日（空态样本）
  return f;
}

function buildTitle(scene, type, pt) {
  const kw = KEYWORDS[scene];
  switch (type.code) {
    case "bullying_keyword":
      return { title: `欺凌关键词命中 · ${pick(kw)}`, detail: `${pt.room} 检测到侮辱 / 威胁性语句` };
    case "abnormal_sound":
      return { title: `异常声音 · ${pick(["打砸玻璃声", "急促脚步声", "重物倒地", "桌椅翻倒", "持续撞击声"])}`, detail: `${pt.room} 连续检测到非环境噪声` };
    case "decibel_exceed":
      return { title: `分贝持续超标 · ${rint(72, 94)}dB`, detail: `${pt.room} 超过该时段阈值` };
    case "cry_scream":
      return { title: "哭声 / 呼救识别", detail: `${pt.room} 检测到人声哭喊` };
    case "fight_conflict":
      return { title: "高声争吵 · 冲突升级风险", detail: `${pt.room} 双人以上激烈争吵` };
    case "glass_break":
      return { title: `玻璃破碎声 · ${rint(2, 6)} 声连击`, detail: `${pt.room} 高频冲击特征明显` };
    case "blacklist_match":
      return { title: "黑名单人员比对命中", detail: `${pt.room} 人脸相似度高于阈值` };
    case "panic_button":
      return { title: "一键报警按钮触发", detail: `${pt.room} 现场人员手动触发` };
    case "sleep_on_duty":
      return { title: "值班人员离岗 / 睡岗", detail: `${pt.room} 在岗区域内未检测到活动` };
    case "people_gather":
      return { title: `局部聚集 · ${rint(11, 34)}人`, detail: `${pt.room} 聚集持续超过 30 秒` };
    case "intrusion":
      return { title: "非授权区域入侵", detail: `${pt.room} 电子围栏内检测到人员` };
    case "device_offline":
      return { title: "设备离线", detail: `${pt.room} 心跳中断` };
    case "device_signal":
      return { title: `拾音器信号衰减 · ${rint(-68, -52)}dB`, detail: `${pt.room} 信噪比低于基线` };
    case "fire_smoke":
      return { title: "疑似烟火", detail: `${pt.room} 视觉通道检出火焰 / 烟雾特征` };
    case "emotion_abnormal":
      return { title: "在押人员情绪异常波动", detail: `${pt.room} 语音情绪指标突增` };
    case "compliance_risk":
      return { title: "问话合规风险提示", detail: `${pt.room} 检出诱导性提问特征` };
    default:
      return { title: type.name, detail: pt.room };
  }
}

// 剧本 B 的「噪声点位」：必须在基础告警抽样之前排除，
// 否则几十条背景告警会把误报率稀释到 25% 以下，rule-006 永远不触发。
const B_POINT = points.find((p) => p.site_id === "site-01" && p.room_type === "playground" && p.floor === 1);
EXCLUDED_POINT_IDS.add(B_POINT.id);
B_POINT.note = "邻近施工场地，误报观察期内";

const alarms = [];
let alarmSeq = 0;
const SITES_BY_SCENE = new Map(SITES.map((s) => [s.scene, s]));
const SCENE_WEIGHT = { campus: 0.55, hospital: 0.33, justice: 0.12 };

function newAlarm(fields) {
  alarmSeq += 1;
  return {
    id: `AL-${String(alarmSeq).padStart(5, "0")}`,
    status: "new",
    disposition: null,
    narrative_tier: "noise",
    false_positive: false,
    keywords: [],
    decibel: null,
    script_id: null,
    evidence: { audio_seconds: 0, video_clips: 0, spectrum_bins: 0, spectrum_id: null },
    ...fields,
  };
}

for (let d = 0; d < TOTAL_DAYS; d++) {
  const f = dayFactor(d);
  const partial = d === 0 ? 0.55 : 1; // 今天只到正午
  const count = Math.max(0, Math.round(BASE_COUNT * f * partial * (0.78 + rng() * 0.46)));
  for (let k = 0; k < count; k++) {
    const hour = weightedPick(HOUR_WEIGHT.map((w, i) => ({ weight: w, i }))).i;
    const minute = rint(0, 59);
    let offset = offsetFor(d, hour * 60, minute);
    if (offset < 0) offset += DAY;

    // 场景：校园 55% / 医院 33% / 公安 12%
    const sr = rng();
    const scene = sr < SCENE_WEIGHT.campus ? "campus" : sr < SCENE_WEIGHT.campus + SCENE_WEIGHT.hospital ? "hospital" : "justice";
    const site = SITES_BY_SCENE.get(scene);
    const candidates = points.filter(
      (p) => p.site_id === site.id && p.has_device && !EXCLUDED_POINT_IDS.has(p.id),
    );
    const pt = pick(candidates);
    const devList = devicesByPoint.get(pt.id) || [];
    const typePool = ALARM_TYPES.filter((t) => t.scenes.includes(scene));
    const type = weightedPick(typePool.map((t) => ({ ...t, weight: t.weight })));
    const level = levelFor(type.baseLevel);
    const titles = buildTitle(scene, type, pt);
    const audioCapable = type.cat === "声音检测" || type.cat === "警情" || type.cat === "语义分析";
    alarms.push(newAlarm({
      site_id: site.id,
      scene,
      point_id: pt.id,
      point_room: pt.room,
      device_id: devList.length ? pick(devList).id : null,
      type_code: type.code,
      type_name: type.name,
      category: type.cat,
      level,
      level_label: LEVEL_NAME[level],
      title: titles.title,
      detail: titles.detail,
      confidence: Number((0.62 + rng() * 0.36).toFixed(2)),
      ts_offset_minutes: offset,
      duration_seconds: rint(3, 180),
      decibel: type.code === "decibel_exceed" ? rint(66, 96) : null,
      keywords:
        type.code === "bullying_keyword" || type.code === "fight_conflict"
          ? pickMany(KEYWORDS[scene], rint(1, 3))
          : [],
      evidence: {
        audio_seconds: audioCapable ? rint(30, 120) : 0,
        video_clips: rint(0, 4),
        spectrum_bins: 0,
        spectrum_id: null,
      },
    }));
  }
}

// —— 强制生成「0 告警自然日」：删掉目标日的全部基座告警 ——
{
  const target = 152;
  for (let i = alarms.length - 1; i >= 0; i--) if (dayDiff(alarms[i].ts_offset_minutes) === target) alarms.splice(i, 1);
}

// —— 极端值样本（布局压力测试必须有真实最坏情况） ——
{
  const longTitleAlarm = alarms.find((a) => a.scene === "hospital" && a.level <= 2 && a.type_code === "decibel_exceed")
    || alarms.find((a) => a.scene === "hospital" && a.level <= 2);
  if (longTitleAlarm) {
    longTitleAlarm.title = "分贝持续超标 · 门诊大厅东侧闸机入口二代身份证核验通道 92dB（夜间阈值 45dBA，已持续 7 分 20 秒）";
    longTitleAlarm.detail = "门诊住院综合楼1楼门诊大厅东侧闸机入口二代身份证核验通道 · 超过该时段阈值";
  }
  const kwAlarm = alarms.find((a) => a.type_code === "bullying_keyword");
  if (kwAlarm) {
    kwAlarm.keywords = ["救命", "打人", "别打了", "跪下", "弄死你", "不想活了"];
    kwAlarm.title = "欺凌关键词命中 · 「救命」「打人」「别打了」「跪下」「弄死你」「不想活了」";
  }
}

// ============================================================
// 7. 剧本（8 个：A/B/C 保留并修正，D–H 新增）
// ============================================================
const scriptAlarms = [];
function scriptAlarm(fields) {
  const a = newAlarm({
    status: "closed",
    narrative_tier: "script",
    ...fields,
  });
  scriptAlarms.push(a);
  return a;
}
const A_POINT =
  points.find((p) => p.site_id === "site-01" && p.building === "B1" && p.floor === 2 && p.room_type === "restroom");
const A_DEV = devicesByPoint.get(A_POINT.id).find((d) => d.kind === "audio") || devicesByPoint.get(A_POINT.id)[0];
const A_BASE_OFFSET = 97; // 今天约 10:23

// —— 剧本 A：校园欺凌完整闭环 ——
const expA = [
  { type: "bullying_keyword", level: 1, off: A_BASE_OFFSET + 2, title: "欺凌关键词命中 · 救命", kw: ["救命", "别打了"], conf: 0.94 },
  { type: "abnormal_sound", level: 1, off: A_BASE_OFFSET + 1, title: "异常声音 · 重物倒地", kw: [], conf: 0.89 },
  { type: "decibel_exceed", level: 2, off: A_BASE_OFFSET, title: "分贝持续超标 · 78dB", kw: [], conf: 0.92, db: 78 },
];
for (const s of expA) {
  const t = ALARM_TYPES.find((x) => x.code === s.type);
  scriptAlarm({
    site_id: "site-01", scene: "campus", point_id: A_POINT.id, point_room: A_POINT.room,
    device_id: A_DEV.id, type_code: s.type, type_name: t.name, category: t.cat,
    level: s.level, level_label: LEVEL_NAME[s.level], title: s.title,
    detail: `${A_POINT.room} · 多信号融合确认`, confidence: s.conf,
    ts_offset_minutes: s.off, duration_seconds: rint(18, 46), decibel: s.db ?? null,
    keywords: s.kw, evidence: { audio_seconds: 60, video_clips: 2, spectrum_bins: 0, spectrum_id: null },
    script_id: "A",
  });
}

// —— 剧本 B：噪声点位连续 7 天 21:00 误报（触发 rule-006） ——
// 落在 9–15 天前（连续 7 个自然日），给剧本 H 的「7 天误报观察期」
// （第 9 天触发 → 第 2 天恢复）留出时间轴。
// 注意用 offsetDaysAgo：参数是「几天前」这个真实 dayDiff，不是旧的 day-slot 心智模型。
const B_NEWEST_DAYS_AGO = 9;
const B_OLDEST_DAYS_AGO = 15;
const B_DEV = devicesByPoint.get(B_POINT.id)[0];
for (let d = B_NEWEST_DAYS_AGO; d <= B_OLDEST_DAYS_AGO; d++) {
  scriptAlarm({
    site_id: "site-01", scene: "campus", point_id: B_POINT.id, point_room: B_POINT.room,
    device_id: B_DEV?.id ?? null, type_code: "decibel_exceed", type_name: "分贝超限", category: "声音检测",
    level: 3, level_label: LEVEL_NAME[3],
    title: `分贝持续超标 · ${rint(71, 82)}dB`,
    detail: `${B_POINT.room} 邻近施工场地噪声（21:00 固定时段）`,
    confidence: Number((0.68 + rng() * 0.12).toFixed(2)),
    ts_offset_minutes: offsetDaysAgo(d, 21 * 60), duration_seconds: rint(40, 120),
    decibel: rint(71, 82),
    status: "false_positive", false_positive: true,
    false_positive_reason: "邻近施工场地，非校园内噪声源",
    evidence: { audio_seconds: 60, video_clips: 0, spectrum_bins: 0, spectrum_id: null },
    script_id: "B",
  });
}

// —— 剧本 C：设备离线 6 天 5 小时（运维闭环） ——
const C_POINT = points.find((p) => p.id === scriptCDev.point_id);
scriptAlarm({
  site_id: "site-01", scene: "campus", point_id: C_POINT.id, point_room: C_POINT.room,
  device_id: scriptCDev.id, type_code: "device_offline", type_name: "设备离线", category: "设备",
  level: 2, level_label: LEVEL_NAME[2], title: "设备长时间离线 · 已持续 6 天",
  detail: `${C_POINT.room} 心跳中断超过 150 分钟，升级为长时间离线`,
  confidence: 1, ts_offset_minutes: SCRIPT_C_OFFLINE, duration_seconds: 0,
  status: "dispatched", evidence: { audio_seconds: 0, video_clips: 0, spectrum_bins: 0, spectrum_id: null },
  script_id: "C",
});

// —— 剧本 D：医院一键报警闭环 ——
const D_POINT = points.find((p) => p.site_id === "site-02" && p.room.endsWith("急诊分诊台"));
const D_DEV = devicesByPoint.get(D_POINT.id).find((d) => d.kind === "audio") || devicesByPoint.get(D_POINT.id)[0];
const D_BASE = 150; // 今天约 09:30
const scriptD = [
  { type: "panic_button", level: 1, off: D_BASE + 1, title: "一键报警按钮触发", detail: `${D_POINT.room} 分诊台呼叫器被按下`, kw: ["报警", "打人"], conf: 0.99 },
  { type: "fight_conflict", level: 2, off: D_BASE, title: "高声争吵 · 冲突升级风险", detail: `${D_POINT.room} 家属与分诊护士争执`, kw: ["打人", "报警"], conf: 0.91 },
  { type: "people_gather", level: 3, off: D_BASE - 1, title: "局部聚集 · 23人", detail: `${D_POINT.room} 聚集持续超过 30 秒`, kw: [], conf: 0.86 },
  { type: "blacklist_match", level: 1, off: D_BASE - 2, title: "黑名单人员比对命中", detail: `${D_POINT.room} 人脸相似度 0.82`, kw: [], conf: 0.79 },
];
const dAlarms = scriptD.map((s) => {
  const t = ALARM_TYPES.find((x) => x.code === s.type);
  return scriptAlarm({
    site_id: "site-02", scene: "hospital", point_id: D_POINT.id, point_room: D_POINT.room,
    device_id: D_DEV.id, type_code: s.type, type_name: t.name, category: t.cat,
    level: s.level, level_label: LEVEL_NAME[s.level], title: s.title, detail: s.detail,
    confidence: s.conf, ts_offset_minutes: s.off, duration_seconds: rint(30, 120),
    keywords: s.kw, decibel: null,
    evidence: { audio_seconds: 45, video_clips: 2, spectrum_bins: 0, spectrum_id: null },
    script_id: "D",
  });
});

// —— 剧本 E：医院夜间分贝超标（rule-003：22:00-06:00 > 45 dBA 持续 5 分钟） ——
const E_POINT = points.find((p) => p.site_id === "site-02" && p.room.endsWith("住院部 A 区走廊"));
const E_DEV = devicesByPoint.get(E_POINT.id).find((d) => d.kind === "audio") || devicesByPoint.get(E_POINT.id)[0];
const eAlarms = [0, 10, 20, 30, 45].map((m, i) => scriptAlarm({
  site_id: "site-02", scene: "hospital", point_id: E_POINT.id, point_room: E_POINT.room,
  device_id: E_DEV.id, type_code: "decibel_exceed", type_name: "分贝超限", category: "声音检测",
  level: i === 4 ? 2 : 3, level_label: LEVEL_NAME[i === 4 ? 2 : 3],
  title: `分贝持续超标 · ${48 + i}dB`, detail: `${E_POINT.room} 夜间阈值 45dBA，持续 5 分钟以上`,
  confidence: 0.9, ts_offset_minutes: offsetFor(1, 23 * 60, 10 + m), duration_seconds: rint(60, 300),
  decibel: 48 + i, keywords: [], status: "closed",
  evidence: { audio_seconds: 60, video_clips: 1, spectrum_bins: 0, spectrum_id: null },
  script_id: "E",
  rule_hits: ["rule-003"],
}));

// —— 剧本 F：公安谈话质量评分 ——
const F_POINT = points.find((p) => p.site_id === "site-03" && p.room.endsWith("讯问室 03"));
const F_DEV = devicesByPoint.get(F_POINT.id).find((d) => d.kind === "audio") || devicesByPoint.get(F_POINT.id)[0];
const fAlarms = [
  { type: "compliance_risk", level: 2, off: 113, title: "问话合规风险提示 · 检出 3 处诱导性提问", detail: `${F_POINT.room} 第 12 / 27 / 41 分钟出现封闭式引导`, kw: ["供述", "翻供"], conf: 0.88 },
  { type: "emotion_abnormal", level: 1, off: 111, title: "在押人员情绪异常波动", detail: `${F_POINT.room} 语音基频与语速突增`, kw: [], conf: 0.9 },
  { type: "sleep_on_duty", level: 2, off: 109, title: "值班人员离岗 / 睡岗", detail: `${F_POINT.room} 在岗区域内未检测到活动`, kw: [], conf: 0.85 },
].map((s) => {
  const t = ALARM_TYPES.find((x) => x.code === s.type);
  return scriptAlarm({
    site_id: "site-03", scene: "justice", point_id: F_POINT.id, point_room: F_POINT.room,
    device_id: F_DEV.id, type_code: s.type, type_name: t.name, category: t.cat,
    level: s.level, level_label: LEVEL_NAME[s.level], title: s.title, detail: s.detail,
    confidence: s.conf, ts_offset_minutes: s.off, duration_seconds: rint(60, 300),
    keywords: s.kw, evidence: { audio_seconds: 90, video_clips: 1, spectrum_bins: 0, spectrum_id: null },
    // F 是「在办」剧本：事件还停在复核中，告警状态也必须是未结案
    status: "dispatched",
    script_id: "F",
  });
});

// —— 剧本 G：设备批量离线（一个网关掉线带走一层楼） ——
const G_GATEWAY_ID = GATEWAYS_BY_BUILDING.get("site-01:B2");
const G_GATEWAY = devices.find((d) => d.id === G_GATEWAY_ID);
const G_CHILDREN = devices.filter((d) => d.gateway_id === G_GATEWAY_ID).slice(0, 7);
const G_BASE = 260; // 今天约 07:40
for (const d of [G_GATEWAY, ...G_CHILDREN]) {
  d.status = "offline";
  d.last_heartbeat_offset_minutes = G_BASE;
  d.signal = 0;
  d.cpu_percent = 0;
  d.self_check = { result: "skip", at_offset_minutes: G_BASE, items: ["上行链路", "网络"] };
}
// —— 离线设备统一哨兵：signal / cpu / 24 点信号序列全部归 0 ——
// （8 台被剧本 G 临场置为离线的设备，信号序列还是「在线时」的历史值）
for (const d of devices) {
  if (d.status !== "offline") continue;
  d.signal = 0;
  d.cpu_percent = 0;
  d.signal_series = d.signal_series.map((s) => ({ ...s, rssi_dbm: 0 }));
}
const gAlarms = [G_GATEWAY, ...G_CHILDREN].map((d) => {
  const pt = points.find((p) => p.id === d.point_id);
  return scriptAlarm({
    site_id: "site-01", scene: "campus", point_id: pt.id, point_room: pt.room,
    device_id: d.id, type_code: "device_offline", type_name: "设备离线", category: "设备",
    level: 2, level_label: LEVEL_NAME[2],
    title: `设备离线 · ${d.kind === "gateway" ? "网关" : "终端"}批量掉线`,
    detail: `${pt.room} 心跳中断，同一网关下 8 台设备同时离线`,
    confidence: 1, ts_offset_minutes: G_BASE + rint(0, 3), duration_seconds: 0,
    status: "dispatched", evidence: { audio_seconds: 0, video_clips: 0, spectrum_bins: 0, spectrum_id: null },
    script_id: "G",
  });
});

// —— 剧本 H：误报观察降级生效（rule-006 在 B 之后真正跑起来） ——
// 第 9 天命中 rule-006 → 观察期覆盖第 9 天→第 2 天（7 天）→ 第 2 天恢复，
// 静默记录落在第 8 / 5 天。天数口径一律「几天前」（offsetDaysAgo）。
const H_SILENT_DAYS_AGO = [8, 5];
const H_RECOVER_DAYS_AGO = 2;
const hAlarms = [...H_SILENT_DAYS_AGO, H_RECOVER_DAYS_AGO].map((daysAgo, i) => scriptAlarm({
  site_id: "site-01", scene: "campus", point_id: B_POINT.id, point_room: B_POINT.room,
  device_id: B_DEV?.id ?? null, type_code: "decibel_exceed", type_name: "分贝超限", category: "声音检测",
  level: i === 2 ? 3 : 4, level_label: LEVEL_NAME[i === 2 ? 3 : 4],
  title: i === 2 ? `分贝持续超标 · ${rint(73, 80)}dB` : `分贝记录（静默期）· ${rint(70, 78)}dB`,
  detail:
    i === 2
      ? `${B_POINT.room} 误报观察期结束，恢复常规阈值与推送`
      : `${B_POINT.room} 处于误报观察期，仅记录不推送（rule-006）`,
  confidence: 0.72, ts_offset_minutes: offsetDaysAgo(daysAgo, 21 * 60), duration_seconds: rint(40, 90),
  decibel: rint(70, 80), keywords: [],
  status: i === 2 ? "closed" : "closed",
  evidence: { audio_seconds: 60, video_clips: 0, spectrum_bins: 0, spectrum_id: null },
  script_id: "H",
  rule_hits: ["rule-006"],
  downgraded: i < 2,
}));

const allAlarms = [...alarms, ...scriptAlarms];

// ============================================================
// 8. 状态分布（随「距今多久」收敛，不堆成 1,000+ 未处置）
// ============================================================
for (const a of allAlarms) {
  if (a.narrative_tier === "script") continue;
  const ageH = a.ts_offset_minutes / 60;
  const r = rng();
  if (ageH < 2) {
    if (r < 0.55) a.status = "new";
    else if (r < 0.85) a.status = "acknowledged";
    else a.status = "dispatched";
  } else if (ageH < 12) {
    if (r < 0.18) a.status = "new";
    else if (r < 0.52) a.status = "acknowledged";
    else if (r < 0.8) a.status = "dispatched";
    else a.status = "closed";
  } else {
    if (r < 0.06) a.status = "acknowledged";
    else if (r < 0.92) a.status = "closed";
    else {
      a.status = "false_positive";
      a.false_positive = true;
      a.false_positive_reason = pick(["环境噪声误触发", "正常活动被误判", "设备安装角度偏移", "邻近声源干扰"]);
    }
  }
  if (a.status === "closed" || a.status === "false_positive") {
    a.disposition = {
      by: pickSiteUser(a.site_id, ["duty_officer", "site_admin"]).id,
      at_offset_minutes: Math.max(0, a.ts_offset_minutes - rint(2, 60)),
      action: a.status === "false_positive" ? "mark_false_positive" : "close",
      note: a.status === "false_positive" ? a.false_positive_reason : "已现场核实并处置",
    };
  }
}

// 剧本告警的处置记录（剧情里动作由事件时间线承载，但列表页仍要能直接显示）
for (const a of allAlarms) {
  if (a.disposition || (a.status !== "closed" && a.status !== "false_positive")) continue;
  a.disposition = {
    by: pickSiteUser(a.site_id, ["duty_officer", "site_admin"]).id,
    at_offset_minutes: Math.max(0, a.ts_offset_minutes - rint(2, 60)),
    action: a.status === "false_positive" ? "mark_false_positive" : "close",
    note: a.status === "false_positive" ? a.false_positive_reason : "已现场核实并处置",
  };
}

// ============================================================
// 9. 事件（由告警聚合；剧本事件单独构造，时间线更完整）
// ============================================================
let incidentSeq = 0;
const incidents = [];

function makeIncident({ group, title, level, scriptId = null, status = "closed", scene }) {
  incidentSeq += 1;
  const first = group[0];
  const started = Math.max(...group.map((a) => a.ts_offset_minutes));
  const ended = Math.min(...group.map((a) => a.ts_offset_minutes));
  return {
    id: `EV-${String(20260000 + incidentSeq)}`,
    site_id: first.site_id,
    scene: scene || first.scene,
    title,
    level,
    level_label: LEVEL_NAME[level],
    point_id: first.point_id,
    point_room: first.point_room,
    alarm_ids: group.map((a) => a.id),
    alarm_count: group.length,
    started_offset_minutes: started,
    ended_offset_minutes: ended,
    duration_minutes: Math.max(1, started - ended),
    status,
    owner_id: pickSiteUser(first.site_id).id,
    evidence_count: group.reduce((s, a) => s + a.evidence.video_clips + (a.evidence.audio_seconds > 0 ? 1 : 0), 0),
    script_id: scriptId,
    timeline: [],
  };
}

const evA = makeIncident({ group: scriptAlarms.filter((a) => a.script_id === "A"), title: "疑似校园欺凌事件（言语 + 肢体）", level: 1, scriptId: "A", status: "closed" });
evA.timeline = [
  { at_offset_minutes: A_BASE_OFFSET + 2, type: "alarm_triggered", actor: null, text: "分贝检测触发（78dB，超过午休时段阈值 65dB）" },
  { at_offset_minutes: A_BASE_OFFSET + 1, type: "alarm_triggered", actor: null, text: "异常声音检测触发（重物倒地）" },
  { at_offset_minutes: A_BASE_OFFSET, type: "alarm_triggered", actor: null, text: "关键词命中「救命」「别打了」，置信度 0.94" },
  { at_offset_minutes: A_BASE_OFFSET - 1, type: "fusion", actor: null, text: "三路信号融合 → 判定「高度疑似欺凌」，自动升级一级" },
  { at_offset_minutes: A_BASE_OFFSET - 1, type: "action", actor: null, text: "自动触发声光驱离（红色快闪 + 震慑语音，持续 15 秒）" },
  { at_offset_minutes: A_BASE_OFFSET - 2, type: "notify", actor: null, text: "推送值班安保 APP + 班主任企业微信" },
  { at_offset_minutes: A_BASE_OFFSET - 3, type: "acknowledge", actor: "u-003", text: "值班安保李* 接警确认" },
  { at_offset_minutes: A_BASE_OFFSET - 4, type: "dispatch", actor: "u-002", text: "派发至德育处，责任班主任：赵*" },
  { at_offset_minutes: A_BASE_OFFSET - 6, type: "arrive", actor: "u-003", text: "安保人员到达现场，驱离 2 名涉事学生" },
  { at_offset_minutes: A_BASE_OFFSET - 22, type: "handle", actor: "u-004", text: "班主任完成初步问询与家长沟通，写入处置记录" },
  { at_offset_minutes: A_BASE_OFFSET - 47, type: "review", actor: "u-002", text: "德育处审核通过，事件定级「严重」" },
  { at_offset_minutes: A_BASE_OFFSET - 52, type: "archive", actor: "u-002", text: "事件归档，录音加密封存为证据链核心材料" },
];
incidents.push(evA);

const evC = makeIncident({ group: scriptAlarms.filter((a) => a.script_id === "C"), title: "设备长时间离线需现场处理", level: 2, scriptId: "C", status: "dispatched" });
evC.timeline = [
  { at_offset_minutes: SCRIPT_C_OFFLINE, type: "alarm_triggered", actor: null, text: "心跳中断 150 分钟，升级为「确认离线」" },
  { at_offset_minutes: SCRIPT_C_OFFLINE - HOUR, type: "notify", actor: null, text: "推送平台大屏 + APP + 运维短信" },
  { at_offset_minutes: SCRIPT_C_OFFLINE - 2 * HOUR, type: "dispatch", actor: "u-008", text: "运维工程师黄* 受理，派发工单 WO-20261013-004" },
  { at_offset_minutes: SCRIPT_C_OFFLINE - 3 * HOUR, type: "diagnose", actor: "u-008", text: "远程诊断：最后上报显示 PoE 供电异常" },
  { at_offset_minutes: 5 * DAY + 6 * HOUR, type: "pending", actor: "u-008", text: "等待现场处理（校园封闭，进入许可审批中）" },
];
incidents.push(evC);

const evD = makeIncident({ group: dAlarms, title: "急诊分诊台医患冲突（一键报警闭环）", level: 1, scriptId: "D", status: "closed" });
evD.timeline = [
  { at_offset_minutes: D_BASE + 1, type: "alarm_triggered", actor: null, text: "分诊台一键报警按钮被按下，进入最高优先级通道" },
  { at_offset_minutes: D_BASE, type: "fusion", actor: null, text: "冲突争吵 + 局部聚集 + 黑名单命中三路信号融合，判定一级" },
  { at_offset_minutes: D_BASE - 1, type: "action", actor: null, text: "现场声光震慑启动，广播提示「安保已到场」" },
  { at_offset_minutes: D_BASE - 1, type: "notify", actor: null, text: "推送院区安保、值班院长、属地派出所联络人" },
  { at_offset_minutes: D_BASE - 2, type: "acknowledge", actor: "u-006", text: "值班安保刘* 接警确认（用时 45 秒）" },
  { at_offset_minutes: D_BASE - 4, type: "arrive", actor: "u-006", text: "安保 2 分 10 秒到达分诊台，隔离冲突双方" },
  { at_offset_minutes: D_BASE - 9, type: "handle", actor: "u-005", text: "院区安全主管陈* 介入调解，家属情绪平复" },
  { at_offset_minutes: D_BASE - 35, type: "review", actor: "u-005", text: "医务处复盘：分诊排队时长 48 分钟为冲突诱因" },
  { at_offset_minutes: D_BASE - 52, type: "archive", actor: "u-005", text: "事件归档，同步整改工单至门诊部" },
];
incidents.push(evD);

const evE = makeIncident({ group: eAlarms, title: "住院部夜间噪声超标（分贝规则触发）", level: 2, scriptId: "E", status: "closed" });
evE.timeline = [
  { at_offset_minutes: Math.max(...eAlarms.map((a) => a.ts_offset_minutes)), type: "alarm_triggered", actor: null, text: "夜间阈值 45dBA 连续 5 分钟超限，触发 rule-003" },
  { at_offset_minutes: Math.min(...eAlarms.map((a) => a.ts_offset_minutes)) - 2, type: "notify", actor: null, text: "推送护士站与院区安保" },
  { at_offset_minutes: Math.min(...eAlarms.map((a) => a.ts_offset_minutes)) - 8, type: "handle", actor: "u-006", text: "现场核实为陪护家属夜间聚谈，已劝离" },
  { at_offset_minutes: Math.min(...eAlarms.map((a) => a.ts_offset_minutes)) - 25, type: "archive", actor: "u-005", text: "记录并纳入病区夜间噪声月度统计" },
];
incidents.push(evE);

const evF = makeIncident({ group: fAlarms, title: "谈话质量评分偏低 · 需督察复核", level: 2, scriptId: "F", status: "dispatched" });
evF.timeline = [
  { at_offset_minutes: 113, type: "alarm_triggered", actor: null, text: "合规风险提示：检出 3 处诱导性提问" },
  { at_offset_minutes: 112, type: "action", actor: null, text: "自动生成谈话质量评分 62 分（规范度 55 / 完整性 70 / 情绪控制 61）" },
  { at_offset_minutes: 111, type: "alarm_triggered", actor: null, text: "在押人员情绪异常波动，语速提升 38%" },
  { at_offset_minutes: 109, type: "notify", actor: null, text: "推送办案区主管与警务督察" },
  { at_offset_minutes: 104, type: "acknowledge", actor: "u-010", text: "办案区主管吴* 接警确认" },
  { at_offset_minutes: 96, type: "dispatch", actor: "u-010", text: "指派督察杨* 调阅第 12 / 27 / 41 分钟录音复核" },
  { at_offset_minutes: 62, type: "pending", actor: "u-007", text: "复核中：拟对办案民警开展谈话规范专项提醒" },
];
incidents.push(evF);

const evG = makeIncident({ group: gAlarms, title: "B2 教学楼网关批量掉线（8 台设备）", level: 2, scriptId: "G", status: "dispatched" });
evG.timeline = [
  { at_offset_minutes: G_BASE, type: "alarm_triggered", actor: null, text: "B2 教学楼网关心跳中断，同网关下 7 台终端一并离线" },
  { at_offset_minutes: G_BASE - 2, type: "notify", actor: null, text: "合并为 1 条批量离线告警，避免 8 条重复工单" },
  { at_offset_minutes: G_BASE - 5, type: "dispatch", actor: "u-008", text: "运维工程师黄* 受理，工单 WO-20261019-011" },
  { at_offset_minutes: G_BASE - 12, type: "diagnose", actor: "u-008", text: "远程诊断：楼层弱电井交换机 PoE 供电异常" },
  { at_offset_minutes: G_BASE - 40, type: "pending", actor: "u-008", text: "现场处理中：更换交换机电源模块" },
];
incidents.push(evG);

const evH = makeIncident({ group: hAlarms, title: "误报观察降级生效（rule-006 闭环）", level: 3, scriptId: "H", status: "closed" });
evH.timeline = [
  { at_offset_minutes: offsetDaysAgo(B_NEWEST_DAYS_AGO, 21 * 60), type: "alarm_triggered", actor: null, text: "第 7 次误报入库（7 天误报率 100%，rule-006 计数 7/7）" },
  { at_offset_minutes: offsetDaysAgo(B_NEWEST_DAYS_AGO, 21 * 60) - 10, type: "fusion", actor: null, text: "点位 7 天误报率 100%（7/7）> 25%，命中 rule-006" },
  { at_offset_minutes: offsetDaysAgo(B_NEWEST_DAYS_AGO, 21 * 60) - 20, type: "action", actor: null, text: "该点位进入 7 天误报观察期：仅记录、不推送、不生成工单" },
  { at_offset_minutes: offsetDaysAgo(H_SILENT_DAYS_AGO[0], 21 * 60), type: "alarm_triggered", actor: null, text: "静默期告警按四级记录（原始三级），前端可见历史" },
  { at_offset_minutes: offsetDaysAgo(H_SILENT_DAYS_AGO[1], 21 * 60), type: "alarm_triggered", actor: null, text: "静默期告警继续按四级记录" },
  { at_offset_minutes: offsetDaysAgo(H_RECOVER_DAYS_AGO, 21 * 60) - 15, type: "review", actor: "u-002", text: "观察期结束，误报未再增加，确认降级策略有效" },
  { at_offset_minutes: offsetDaysAgo(H_RECOVER_DAYS_AGO, 21 * 60) - 25, type: "archive", actor: "u-002", text: "恢复常规阈值与推送，规则记录归档" },
];
incidents.push(evH);

// —— 时间线串行构造：按工作流顺序推进，每一步严格比上一步晚（偏移更小） ——
// 早先版本把 4 个节点各自随机取偏移再排序，结果生命周期会落成
// trigger → handle → archive → acknowledge。现在从「最早一条告警」往后推时间。
function buildSerialTimeline(ev, status) {
  const siteUser = (roles) => pickSiteUser(ev.site_id, roles).id;
  const steps = [{ type: "alarm_triggered", actor: null, text: "系统自动检测并创建告警" }];
  const ackActor = siteUser(["duty_officer", "site_admin"]);
  steps.push({ type: "acknowledge", actor: ackActor, text: "值班人员接警确认", gap: rint(1, 4) });
  if (status === "closed") {
    steps.push({ type: "handle", actor: siteUser(["duty_officer", "site_admin"]), gap: rint(4, 20), text: pick([
      "现场核实，未发现安全问题",
      "已与当事人沟通并记录",
      "已联动安保现场处置",
      "确认为环境噪声，标记误报",
    ]) });
    steps.push({ type: "review", actor: siteUser(["site_admin"]), text: "值班主管复核处置记录，确认闭环", gap: rint(3, 10) });
    steps.push({ type: "archive", actor: siteUser(["site_admin"]), text: "审核通过并归档", gap: rint(2, 8) });
  } else {
    // 在办事件：停在「已派单、等待现场回单」，不生成 archive，也不把告警置为 closed
    steps.push({ type: "dispatch", actor: siteUser(["site_admin"]), text: "已派发至现场处置，等待回单", gap: rint(3, 10) });
    steps.push({ type: "pending", actor: siteUser(["duty_officer", "site_admin"]), text: "现场处置中，尚未回单", gap: rint(2, 6) });
  }

  // 时间线必须落在事件自己的告警时间窗内：started = 最早一条告警（偏移最大），
  // ended = 最新一条告警（偏移最小，即最晚的时刻）。旧写法把预算取成 started（绝对偏移），
  // 只保证节点不为负，保证不了末节点不早于最新告警，会生成「归档 5–60 分钟后
  // 又来自己的告警」这种自相矛盾。现在把整段生命周期按间隔权重铺满
  // [started - span, started]：首节点 = started，末节点（closed 的 archive）= started - span。
  //
  // span 取 min(max(告警窗口, 各步间隔之和), started)：
  //   - ≥ 告警窗口：末节点不早于事件内最新一条告警（偏移更小 = 更晚），
  //     否则 archive 会落在自己的告警之前；
  //   - ≥ 间隔之和：每一步至少推进 1 分钟，不会因为「告警全在同一分钟」
  //     把整条生命周期压成一个时间点（旧版 190/207 个事件塌成同一分钟）；
  //   - ≤ started：节点不会落到数据基准点之前（负偏移）。告警窗口天然 ≤ started，
  //     所以三者可以同时满足；真正撞到上界的只有「几分钟前刚发生」的事件，
  //     这种事件的生命周期本来就应该压紧到「此刻归档」。
  const gaps = steps.slice(1);
  const alarmSpan = Math.max(0, ev.started_offset_minutes - ev.ended_offset_minutes);
  const total = gaps.reduce((sum, s) => sum + s.gap, 0) || 1;
  const span = Math.min(Math.max(alarmSpan, total), ev.started_offset_minutes);
  const nodes = [];
  let travelled = 0;
  steps.forEach((s, i) => {
    if (i > 0) travelled += s.gap;
    // 累积取整：用 ceil 保证每个节点至少比上一步晚 1 分钟（时间单调递增），
    // 末段正好落在 started - span 上
    const reached = i === 0 ? 0 : Math.ceil((span * travelled) / total);
    nodes.push({
      at_offset_minutes: ev.started_offset_minutes - reached,
      type: s.type,
      actor: s.actor,
      text: s.text,
    });
  });
  return nodes;
}

// —— 基座告警 → 事件（1–4 条一组，同点位 120 分钟内） ——
{
  const byPoint = new Map();
  for (const a of allAlarms) {
    if (a.narrative_tier === "script") continue;
    if (a.level > 2) continue;
    if (a.status === "false_positive") continue;
    if (EXCLUDED_POINT_IDS.has(a.point_id)) continue;
    if (!byPoint.has(a.point_id)) byPoint.set(a.point_id, []);
    byPoint.get(a.point_id).push(a);
  }
  let groupCount = 0;
  const TARGET_INCIDENTS = 200;
  for (const [, list] of byPoint) {
    list.sort((a, b) => a.ts_offset_minutes - b.ts_offset_minutes);
    let i = 0;
    while (i < list.length && groupCount < TARGET_INCIDENTS) {
      const group = [list[i]];
      let j = i + 1;
      while (j < list.length && group.length < 4 && list[j].ts_offset_minutes - list[i].ts_offset_minutes < 120) {
        group.push(list[j]);
        j += 1;
      }
      if (group.length > 1 || chance(0.35)) {
        const status = pick(["closed", "closed", "closed", "dispatched"]);
        const ev = makeIncident({
          group,
          title: pick(["言语冲突升级事件", "异常声响核查事件", "区域聚集核查事件", "设备与告警联动核查", "噪声投诉处理事件"]),
          level: Math.min(...group.map((a) => a.level)),
          status,
        });
        // 时间线串行生成：从最早一条告警开始，每一步严格比上一步晚（偏移变小）
        ev.timeline = buildSerialTimeline(ev, status);
        for (const a of group) {
          if (status === "closed") {
            a.status = "closed";
            if (!a.disposition) {
              a.disposition = {
                by: pickSiteUser(a.site_id, ["duty_officer", "site_admin"]).id,
                at_offset_minutes: Math.max(0, a.ts_offset_minutes - rint(2, 60)),
                action: "close",
                note: "已现场核实并处置",
              };
            }
          } else {
            // 在办（dispatched）事件不归档，也不把告警结案
            a.status = "dispatched";
            a.disposition = null;
          }
        }
        incidents.push(ev);
        groupCount += 1;
      }
      i = j;
    }
  }
}

// —— narrative_tier：script = 剧本；related = 已被事件引用；noise = 背景量 ——
{
  const inIncident = new Set(incidents.flatMap((i) => i.alarm_ids));
  for (const a of allAlarms) {
    if (a.narrative_tier === "script") continue;
    a.narrative_tier = inIncident.has(a.id) ? "related" : "noise";
  }
}

// —— 事件收尾归一：started/ended 覆盖告警与时间线，时间线严格「旧 → 新」 ——
{
  const alarmTs = new Map(allAlarms.map((a) => [a.id, a.ts_offset_minutes]));
  for (const ev of incidents) {
    const stamps = [
      ...ev.alarm_ids.map((id) => alarmTs.get(id)).filter((v) => typeof v === "number"),
      ...(ev.timeline || []).map((x) => x.at_offset_minutes),
    ];
    if (stamps.length) {
      ev.started_offset_minutes = Math.max(...stamps);
      ev.ended_offset_minutes = Math.min(...stamps);
      ev.duration_minutes = Math.max(0, ev.started_offset_minutes - ev.ended_offset_minutes);
    }
    ev.timeline.sort((x, y) => y.at_offset_minutes - x.at_offset_minutes);
  }
}

// 统一排序：所有数组「新 → 旧」（偏移升序）
allAlarms.sort((a, b) => a.ts_offset_minutes - b.ts_offset_minutes || a.id.localeCompare(b.id));
incidents.sort((a, b) => a.started_offset_minutes - b.started_offset_minutes || a.id.localeCompare(b.id));

// ============================================================
// 9b. 普通事件（BLF-1427）
//    此前 207 个事件全部是「告警融合」的产物，/event 与 /alarm 语义重叠：
//    事件中心只是换了个分组的告警列表。这里补一档**平庸事件** ——
//    巡检发现、设备上下线、OTA 批量升级、策略配置变更、误报归档、人工补录，
//    它们没有告警可追溯，靠自身的运营动作成链。
//
//    两条硬约束：
//      · 只追加：既有 207 条事件的 id / 字段一个不碰，新事件走 EV-R 号段；
//      · 独立种子：不消耗全局 rng，其余 JSON 逐字节不变（生成器可复现）。
// ============================================================
const ROUTINE_TOTAL = 120;
const ROUTINE_START_OFFSET = 20; // 最近 20 分钟起
const ROUTINE_SPAN = 21 * DAY; // 摊在最近 21 个自然日
const rrng = makeRng(SEED ^ 0x52544e31); // "RTN1"
const rintR = (min, max) => Math.floor(rrng() * (max - min + 1)) + min;
const pickR = (arr) => arr[Math.floor(rrng() * arr.length)];
const chanceR = (p) => rrng() < p;
const ROUTINE_OWNER_ROLES = ["site_admin", "duty_officer", "auditor"];
const routineUser = (siteId, roles = ROUTINE_OWNER_ROLES) => {
  const pool = USERS.filter((u) => u.site_id === siteId && roles.includes(u.role));
  return pool.length ? pickR(pool) : pickR(USERS);
};

/** 普通事件模板：每类一个「运营动作链」，节点类型刻意与告警生命周期不同 */
const ROUTINE_TEMPLATES = [
  {
    eventType: "inspection",
    weight: 26,
    level: 4,
    openRate: 0,
    title: (pt, n) => `日常巡检 #IP-${n}：${pt.room} 声学基线复测通过`,
    steps: (pt, me, n) => [
      { type: "inspect", actor: null, text: `巡检计划 IP-2026${n} 生成：${pt.room} 拾音与视频通道逐项复测` },
      { type: "inspect", actor: me.id, text: `现场复测通过：本底噪声 ${rintR(38, 52)}dBA，镜头清晰度与遮挡检测正常`, gap: rintR(8, 26) },
      { type: "archive", actor: me.id, text: "巡检结论归档，纳入本月设备健康报表", gap: rintR(5, 14) },
    ],
  },
  {
    eventType: "device_online",
    weight: 20,
    level: 4,
    openRate: 0,
    title: (pt, n) => `设备上线：${pt.room} 终端恢复心跳（#DO-${n}）`,
    steps: (pt, me, n) => [
      { type: "device_offline", actor: null, text: `${pt.room} 终端心跳中断，自动登记离线台账 #DO-${n}` },
      { type: "device_online", actor: null, text: "网关心跳恢复，终端自动重新注册并回补 15 分钟缓存数据", gap: rintR(6, 40) },
      { type: "archive", actor: me.id, text: "离线工单自动关闭，离线时长计入本月可用率", gap: rintR(2, 9) },
    ],
  },
  {
    eventType: "device_offline",
    weight: 16,
    level: 3,
    openRate: 0.45,
    title: (pt, n) => `设备离线：${pt.room} 心跳中断待现场处理（#DO-${n}）`,
    steps: (pt, me, n) => [
      { type: "device_offline", actor: null, text: `${pt.room} 心跳中断超过 ${rintR(10, 25)} 分钟，升级为确认离线 #DO-${n}` },
      { type: "diagnose", actor: "u-008", text: `远程诊断：最后上报 PoE 供电 ${rintR(41, 48)}V，低于阈值`, gap: rintR(5, 22) },
    ],
    tailClosed: (pt, me) => ({
      type: "archive",
      actor: me.id,
      text: "现场更换电源模块后恢复，离线工单归档",
      gap: rintR(30, 90),
    }),
    tailOpen: (pt, me) => ({
      type: "pending",
      actor: me.id,
      text: "等待现场处理：已申请进入受限区域，尚未回单",
      gap: rintR(20, 70),
    }),
  },
  {
    eventType: "ota",
    weight: 18,
    level: 4,
    openRate: 0.12,
    title: (pt, n) => `OTA 批量升级：${pt.room} 等 ${rintR(6, 24)} 台终端升至 ${pickR(["v3.9.1", "v3.9.2", "v3.10.0"])}`,
    steps: (pt, _me, n) => [
      { type: "ota", actor: null, text: `升级任务 OT-${n} 下发：${pt.room} 所在分组静默升级，避开上下课时段` },
      { type: "ota", actor: null, text: `升级完成，成功 ${rintR(6, 23)} 台 / 失败 0 台，版本校验通过`, gap: rintR(12, 48) },
    ],
    // 收尾节点分开写：在办的 OTA 不能带 archive（闭环与在办是互斥的两种状态）
    tailClosed: (pt, me) => ({
      type: "archive",
      actor: me.id,
      text: "固件台账已回写，升级窗口内无告警抖动",
      gap: rintR(3, 12),
    }),
    tailOpen: (_pt, me) => ({
      type: "pending",
      actor: me.id,
      text: "灰度批次仍在升级（已下发改写，等待回执）",
      gap: rintR(10, 40),
    }),
  },
  {
    eventType: "config",
    weight: 16,
    level: 4,
    openRate: 0,
    title: (pt, n) => `策略配置变更：${pt.room} 分贝阈值 65 → ${rintR(68, 74)}dB（#CF-${n}）`,
    steps: (pt, me, n) => [
      { type: "config", actor: me.id, text: `变更申请 CF-${n}：午休时段阈值上调，附前 7 天误报工单` },
      { type: "config", actor: null, text: `配置生效，作用于 ${pt.room} 等 ${rintR(2, 12)} 个点位，回滚窗口 24 小时`, gap: rintR(8, 30) },
      { type: "archive", actor: me.id, text: "变更记录归档，纳入规则变更审计日志", gap: rintR(2, 8) },
    ],
  },
  {
    eventType: "false_positive_archive",
    weight: 14,
    level: 4,
    openRate: 0,
    title: (pt, n) => `误报归档：${pt.room} ${pickR(["操场风噪", "走廊回声", "空调外机", "施工噪声"])}触发（#FP-${n}）`,
    steps: (pt, me, n) => [
      { type: "inspect", actor: null, text: `回溯核实 FP-${n}：${pt.room} 告警波形与历史误报样本相似度 ${rintR(88, 96)}%` },
      { type: "inspect", actor: me.id, text: "现场确认非安全事件，已标记误报并回填误报原因", gap: rintR(10, 40) },
      { type: "archive", actor: me.id, text: "误报样本入库，供规则迭代与阈值调优", gap: rintR(3, 10) },
    ],
  },
  {
    eventType: "manual",
    weight: 10,
    level: 4,
    openRate: 0,
    title: (pt, n) => `人工补录：${pt.room} ${pickR(["家长来访登记", "临时施工报备", "设备借用登记", "夜间加班报备"])}（#MR-${n}）`,
    steps: (pt, me, n) => [
      { type: "manual", actor: null, text: `人工补录 MR-${n}：${pt.room} 现场事项无系统告警，事后补录台账` },
      { type: "review", actor: me.id, text: "值班主管核对现场记录与监控回放，确认无误", gap: rintR(10, 45) },
      { type: "archive", actor: me.id, text: "补录完成，事件进入常规归档流", gap: rintR(2, 8) },
    ],
  },
];

/** 按权重挑模板（本地 rng，不动全局序列） */
function pickRoutineTemplate() {
  const total = ROUTINE_TEMPLATES.reduce((sum, t) => sum + t.weight, 0);
  let r = rrng() * total;
  for (const tpl of ROUTINE_TEMPLATES) {
    r -= tpl.weight;
    if (r <= 0) return tpl;
  }
  return ROUTINE_TEMPLATES[ROUTINE_TEMPLATES.length - 1];
}

{
  const pointsBySite = new Map(SITES.map((s) => [s.id, points.filter((p) => p.site_id === s.id && p.has_device)]));
  const routineSites = SITES.filter((s) => (pointsBySite.get(s.id) || []).length > 0);
  for (let n = 1; n <= ROUTINE_TOTAL; n++) {
    const site = pickR(routineSites);
    const pt = pickR(pointsBySite.get(site.id));
    const tpl = pickRoutineTemplate();
    const me = routineUser(site.id);
    const open = chanceR(tpl.openRate);
    const started = ROUTINE_START_OFFSET + rintR(0, ROUTINE_SPAN);

    const steps = tpl.steps(pt, me, String(n).padStart(4, "0"));
    if (open && tpl.tailOpen) steps.push(tpl.tailOpen(pt, me));
    else if (!open && tpl.tailClosed) steps.push(tpl.tailClosed(pt, me));

    // 节点从 started 往后推（偏移递减 = 时间递增），首节点即事件开始
    let cursor = started;
    const timeline = steps.map((step, index) => {
      if (index > 0) cursor -= Math.max(1, step.gap ?? 1);
      return {
        at_offset_minutes: Math.max(0, cursor),
        type: step.type,
        actor: step.actor ?? null,
        text: step.text,
      };
    });
    const ended = Math.min(...timeline.map((node) => node.at_offset_minutes));

    incidents.push({
      id: `EV-R${String(n).padStart(4, "0")}`,
      kind: "routine",
      event_type: tpl.eventType,
      site_id: site.id,
      scene: site.scene,
      title: tpl.title(pt, String(n).padStart(4, "0")),
      level: tpl.level,
      level_label: LEVEL_NAME[tpl.level],
      point_id: pt.id,
      point_room: pt.room,
      alarm_ids: [],
      alarm_count: 0,
      started_offset_minutes: started,
      ended_offset_minutes: ended,
      duration_minutes: Math.max(1, started - ended),
      status: open ? "dispatched" : "closed",
      owner_id: me.id,
      evidence_count: 0,
      script_id: null,
      timeline,
    });
  }

  // 重新排序：新事件按发生时间插进既有序列（既有 207 条相对顺序不变，稳定排序）
  incidents.sort((a, b) => a.started_offset_minutes - b.started_offset_minutes || a.id.localeCompare(b.id));
}

// ============================================================
// 10. 频谱（12 段）+ 波形桶（每段 2,000 桶 min/max）
// ============================================================
function synthSpectrum({ seconds, bins, cols, seedNum, profile }) {
  const localRng = makeRng(SEED + seedNum * 7919);
  const mat = new Uint8Array(bins * cols);
  for (let i = 0; i < mat.length; i++) mat[i] = 12 + Math.floor(localRng() * 18);
  const bursts = {
    bullying: [[0.06, 0.16, 1.0], [0.24, 0.36, 0.9], [0.5, 0.62, 0.75], [0.78, 0.9, 0.6]],
    quarrel: [[0.04, 0.14, 0.9], [0.18, 0.3, 1.0], [0.34, 0.46, 0.85], [0.52, 0.66, 0.95], [0.72, 0.86, 0.8]],
    scream: [[0.1, 0.2, 0.95], [0.55, 0.68, 1.0]],
    glass: [[0.3, 0.34, 1.0], [0.36, 0.4, 0.8], [0.62, 0.66, 0.7]],
    speech: [[0.08, 0.2, 0.85], [0.3, 0.44, 0.7], [0.58, 0.7, 0.6]],
    noise: [[0.05, 0.95, 1.0]],
  }[profile] || [[0.1, 0.9, 0.6]];
  for (const [s0, s1, strength] of bursts) {
    const c0 = Math.floor(s0 * cols);
    const c1 = Math.min(cols, Math.floor(s1 * cols));
    for (let c = c0; c < c1; c++) {
      const env = Math.sin(((c - c0) / Math.max(1, c1 - c0)) * Math.PI);
      for (let b = 0; b < bins; b++) {
        let amp = 0;
        amp += Math.exp(-(((b - bins * 0.12) / (bins * 0.05)) ** 2)) * 150;
        amp += Math.exp(-(((b - bins * 0.27) / (bins * 0.07)) ** 2)) * 105;
        amp += Math.exp(-(((b - bins * 0.45) / (bins * 0.09)) ** 2)) * 70;
        amp += Math.exp(-(((b - bins * 0.68) / (bins * 0.12)) ** 2)) * 42;
        if (profile === "glass") amp *= 1.35;
        if (profile === "noise") amp *= 0.9;
        const jitter = 0.75 + localRng() * 0.5;
        const v = mat[c * bins + b] + amp * env * strength * jitter;
        mat[c * bins + b] = Math.min(255, Math.max(0, Math.round(v)));
      }
    }
  }
  // 波形桶：从同一组 burst 包络 + 底噪生成 2000 桶 min/max（供音频页画波形）
  const BUCKETS = 2000;
  const wMin = new Uint8Array(BUCKETS);
  const wMax = new Uint8Array(BUCKETS);
  for (let i = 0; i < BUCKETS; i++) {
    const t = i / BUCKETS;
    let env = 0.12;
    for (const [s0, s1, strength] of bursts) {
      if (t >= s0 && t <= s1) env = Math.max(env, strength * Math.sin(((t - s0) / (s1 - s0)) * Math.PI));
    }
    const center = Math.min(1, env * (0.85 + localRng() * 0.3));
    const mid = 128;
    wMax[i] = Math.min(255, Math.round(mid + center * 120));
    wMin[i] = Math.max(0, Math.round(mid - center * 120));
  }
  return {
    bins,
    cols,
    seconds,
    binHz: 78,
    colMs: Math.round((seconds * 1000) / cols),
    encoding: "uint8-base64",
    note: "行 = 频点（0 ~ bins × binHz Hz），列 = 时间（colMs 一列）。解码：base64 → Uint8Array，索引 = col * bins + bin。",
    data: Buffer.from(mat).toString("base64"),
    waveform: {
      buckets: BUCKETS,
      samples_per_bucket: Math.round((seconds * 1000) / BUCKETS),
      encoding: "uint8-base64",
      mid: 128,
      min: Buffer.from(wMin).toString("base64"),
      max: Buffer.from(wMax).toString("base64"),
    },
    peaks: bursts.map(([s0, s1, strength]) => ({
      at_ms: Math.round(((s0 + s1) / 2) * seconds * 1000),
      amplitude: Number(strength.toFixed(2)),
    })),
  };
}

const pickBaseByType = (typeCode, pred = () => true) =>
  allAlarms.find((a) => a.type_code === typeCode && a.script_id === null && pred(a));

const SPECTRA_SPEC = [
  { id: "sp-001", alarm: scriptAlarms.find((a) => a.script_id === "A" && a.type_code === "bullying_keyword"), title: "剧本 A · 卫生间欺凌录音", profile: "bullying", seconds: 60 },
  { id: "sp-002", alarm: scriptAlarms.find((a) => a.script_id === "B"), title: "剧本 B · 操场夜间施工噪声", profile: "noise", seconds: 60 },
  { id: "sp-003", alarm: scriptAlarms.find((a) => a.script_id === "D" && a.type_code === "fight_conflict"), title: "剧本 D · 分诊台医患争吵", profile: "quarrel", seconds: 45 },
  { id: "sp-004", alarm: scriptAlarms.find((a) => a.script_id === "D" && a.type_code === "panic_button"), title: "剧本 D · 一键报警现场人声", profile: "speech", seconds: 45 },
  { id: "sp-005", alarm: scriptAlarms.find((a) => a.script_id === "E"), title: "剧本 E · 住院部夜间走廊噪声", profile: "noise", seconds: 60 },
  { id: "sp-006", alarm: scriptAlarms.find((a) => a.script_id === "F"), title: "剧本 F · 讯问室谈话录音", profile: "speech", seconds: 90 },
  { id: "sp-007", alarm: scriptAlarms.find((a) => a.script_id === "A" && a.type_code === "cry_scream") || pickBaseByType("cry_scream"), title: "哭声 / 呼救样本", profile: "scream", seconds: 30 },
  { id: "sp-008", alarm: pickBaseByType("glass_break"), title: "玻璃破碎冲击样本", profile: "glass", seconds: 20 },
  { id: "sp-009", alarm: pickBaseByType("bullying_keyword", (a) => a.keywords.length >= 6), title: "欺凌关键词多词命中样本", profile: "bullying", seconds: 60 },
  { id: "sp-010", alarm: pickBaseByType("fight_conflict"), title: "走廊冲突争吵样本", profile: "quarrel", seconds: 45 },
  { id: "sp-011", alarm: pickBaseByType("decibel_exceed"), title: "门诊大厅人声嘈杂样本", profile: "noise", seconds: 60 },
  { id: "sp-012", alarm: pickBaseByType("abnormal_sound"), title: "异常声响（重物倒地）样本", profile: "glass", seconds: 30 },
];

const spectra = SPECTRA_SPEC.filter((s) => s.alarm).map((spec, i) => {
  const bins = spec.seconds >= 60 ? 96 : 80;
  const cols = Math.round((spec.seconds * 1000) / 125); // 125ms 一列
  const mat = synthSpectrum({ seconds: spec.seconds, bins, cols, seedNum: i + 1, profile: spec.profile });
  spec.alarm.evidence.spectrum_id = spec.id;
  spec.alarm.evidence.spectrum_bins = mat.bins;
  spec.alarm.evidence.audio_seconds = spec.seconds;
  return { id: spec.id, alarm_id: spec.alarm.id, title: spec.title, profile: spec.profile, ...mat };
});

// ============================================================
// 11. 转写（5 段，全部覆盖整段音频）
// ============================================================
function makeTranscript({ id, alarm, audioSeconds, language = "zh-CN", speakers, segments }) {
  const last = Math.max(...segments.map((s) => s.end));
  return {
    id,
    alarm_id: alarm.id,
    site_id: alarm.site_id,
    scene: alarm.scene,
    audio_seconds: Math.max(audioSeconds, last),
    language,
    speakers,
    segments,
    keyword_hits: segments.flatMap((s) => s.highlight.map((h) => h.word)),
  };
}

const transcripts = [];
{
  const aAlarm = scriptAlarms.find((a) => a.script_id === "A" && a.type_code === "bullying_keyword");
  transcripts.push(makeTranscript({
    id: "tr-001", alarm: aAlarm, audioSeconds: 60,
    speakers: [
      { id: "spk-1", index: 0, label: "学生 A", role: "student" },
      { id: "spk-2", index: 1, label: "学生 B", role: "student" },
      { id: "spk-3", index: 2, label: "学生 C", role: "student" },
    ],
    segments: [
      { start: 0.0, end: 3.2, speaker: "spk-1", text: "你昨天是不是把我的东西扔了？", highlight: [] },
      { start: 3.4, end: 5.8, speaker: "spk-2", text: "关你什么事。", highlight: [] },
      { start: 6.0, end: 9.1, speaker: "spk-1", text: "我警告你，别以为我不敢动你。", highlight: [{ word: "不敢动你", level: 2 }] },
      { start: 9.3, end: 12.4, speaker: "spk-2", text: "你敢试试看？", highlight: [{ word: "你敢", level: 1 }] },
      { start: 12.6, end: 15.0, speaker: "spk-3", text: "别打了！", highlight: [{ word: "别打了", level: 1 }] },
      { start: 15.2, end: 18.0, speaker: "spk-1", text: "滚开，不关你的事。", highlight: [{ word: "滚开", level: 2 }] },
      { start: 18.2, end: 20.5, speaker: "spk-3", text: "救命！有人吗！", highlight: [{ word: "救命", level: 1 }] },
      { start: 21.0, end: 23.2, speaker: null, text: "[重物倒地声]", highlight: [] },
      { start: 23.6, end: 26.0, speaker: "spk-2", text: "你别打了……", highlight: [] },
      { start: 26.5, end: 29.0, speaker: null, text: "[声光驱离启动 · 震慑语音]", highlight: [] },
      { start: 29.5, end: 33.0, speaker: "spk-1", text: "走了走了。", highlight: [] },
      { start: 33.5, end: 36.0, speaker: null, text: "[脚步声远去]", highlight: [] },
      { start: 36.4, end: 41.0, speaker: "spk-3", text: "我没事，别告诉老师……", highlight: [] },
      { start: 41.4, end: 47.5, speaker: "spk-2", text: "今天的事你要是说出去，明天还找你。", highlight: [{ word: "还找你", level: 2 }] },
      { start: 48.0, end: 54.0, speaker: null, text: "[安保人员到场询问]", highlight: [] },
      { start: 54.4, end: 59.6, speaker: "spk-1", text: "老师，我们就是闹着玩的。", highlight: [] },
    ],
  }));

  const dConflict = scriptAlarms.find((a) => a.script_id === "D" && a.type_code === "fight_conflict");
  transcripts.push(makeTranscript({
    id: "tr-002", alarm: dConflict, audioSeconds: 45,
    speakers: [
      { id: "spk-1", index: 0, label: "家属", role: "visitor" },
      { id: "spk-2", index: 1, label: "分诊护士", role: "nurse" },
      { id: "spk-3", index: 2, label: "安保", role: "guard" },
    ],
    segments: [
      { start: 0.0, end: 4.2, speaker: "spk-1", text: "我们都排了快一个小时了，你们到底管不管？", highlight: [{ word: "不管", level: 2 }] },
      { start: 4.6, end: 8.0, speaker: "spk-2", text: "前面还有两个危重患者，请您再等一下。", highlight: [] },
      { start: 8.4, end: 12.8, speaker: "spk-1", text: "我不管什么危重，我孩子发烧 39 度！", highlight: [{ word: "我不管", level: 2 }] },
      { start: 13.2, end: 16.0, speaker: "spk-2", text: "我马上帮您叫医生，请别拍台子。", highlight: [] },
      { start: 16.4, end: 21.0, speaker: "spk-1", text: "打人啦！医院打人啦！", highlight: [{ word: "打人", level: 1 }] },
      { start: 21.4, end: 24.5, speaker: null, text: "[一键报警按钮触发 · 提示音]", highlight: [] },
      { start: 25.0, end: 29.0, speaker: "spk-3", text: "安保，请大家后退一步，先让开通道。", highlight: [] },
      { start: 29.4, end: 33.0, speaker: "spk-2", text: "医生已经来了，孩子先跟我进抢救区。", highlight: [] },
      { start: 33.4, end: 38.2, speaker: "spk-1", text: "你们早这样不就好了……", highlight: [] },
      { start: 38.6, end: 44.4, speaker: "spk-3", text: "现场已控制，家属情绪平稳，请记录。", highlight: [] },
    ],
  }));

  const fCompliance = scriptAlarms.find((a) => a.script_id === "F" && a.type_code === "compliance_risk");
  transcripts.push(makeTranscript({
    id: "tr-003", alarm: fCompliance, audioSeconds: 90,
    speakers: [
      { id: "spk-1", index: 0, label: "办案民警", role: "officer" },
      { id: "spk-2", index: 1, label: "嫌疑人", role: "suspect" },
    ],
    segments: [
      { start: 0.0, end: 6.0, speaker: "spk-1", text: "我们是市执法办案管理中心，现在依法对你进行讯问。", highlight: [] },
      { start: 6.4, end: 10.2, speaker: "spk-2", text: "我知道，我会如实说。", highlight: [] },
      { start: 10.6, end: 18.0, speaker: "spk-1", text: "你是不是早就知道同案的人要去？", highlight: [{ word: "是不是早就知道", level: 2 }] },
      { start: 18.4, end: 23.0, speaker: "spk-2", text: "我……我只是听他们提过一嘴。", highlight: [] },
      { start: 23.4, end: 31.0, speaker: "spk-1", text: "你承认你参与了，对吧？承认了就能早点结束。", highlight: [{ word: "承认了就能早点结束", level: 1 }] },
      { start: 31.4, end: 36.0, speaker: "spk-2", text: "我不太明白你的意思。", highlight: [] },
      { start: 36.4, end: 44.0, speaker: "spk-1", text: "别人都说了，你不说也没用，你自己想清楚。", highlight: [{ word: "别人都说了", level: 2 }] },
      { start: 44.4, end: 49.0, speaker: "spk-2", text: "我想请律师在场。", highlight: [] },
      { start: 49.4, end: 56.0, speaker: "spk-1", text: "律师的事后面再说，先把今天的事讲清楚。", highlight: [{ word: "后面再说", level: 2 }] },
      { start: 56.4, end: 63.0, speaker: "spk-2", text: "那我先不说了。", highlight: [] },
      { start: 63.4, end: 71.0, speaker: "spk-1", text: "行，我们休息十分钟，你再考虑考虑。", highlight: [] },
      { start: 71.4, end: 79.0, speaker: "spk-2", text: "我要求看讯问笔录。", highlight: [] },
      { start: 79.4, end: 85.0, speaker: "spk-1", text: "笔录会给你确认签字，现在先核实身份信息。", highlight: [] },
      { start: 85.4, end: 89.6, speaker: "spk-2", text: "好。", highlight: [] },
    ],
  }));

  const dBroadcast = scriptAlarms.find((a) => a.script_id === "D" && a.type_code === "people_gather")
    || scriptAlarms.find((a) => a.script_id === "D");
  transcripts.push(makeTranscript({
    id: "tr-004", alarm: dBroadcast, audioSeconds: 30,
    speakers: [
      { id: "spk-1", index: 0, label: "院区广播", role: "broadcast" },
      { id: "spk-2", index: 1, label: "安保（现场喊话）", role: "guard" },
    ],
    segments: [
      { start: 0.0, end: 5.0, speaker: "spk-1", text: "请门诊大厅的家属与患者保持通道畅通，急诊优先。", highlight: [] },
      { start: 5.4, end: 10.0, speaker: "spk-2", text: "请大家后退，让开抢救通道。", highlight: [] },
      { start: 10.4, end: 15.0, speaker: "spk-1", text: "如有需要，请到导医台寻求帮助。", highlight: [] },
      { start: 15.4, end: 20.0, speaker: "spk-2", text: "冲突双方请到一侧等候，配合处理。", highlight: [] },
      { start: 20.4, end: 25.0, speaker: "spk-1", text: "本区域已启用音视频记录，请注意言行。", highlight: [] },
      { start: 25.4, end: 29.4, speaker: null, text: "[广播结束提示音]", highlight: [] },
    ],
  }));

  const gAlarm = gAlarms[0];
  transcripts.push(makeTranscript({
    id: "tr-005", alarm: gAlarm, audioSeconds: 25, language: "zh-CN",
    speakers: [
      { id: "spk-1", index: 0, label: "运维（对讲）", role: "ops" },
      { id: "spk-2", index: 1, label: "现场值班", role: "guard" },
    ],
    segments: [
      { start: 0.0, end: 3.6, speaker: "spk-1", text: "喂，B2 三楼弱电井那边交换机灯还亮吗？", highlight: [] },
      { start: 4.0, end: 8.0, speaker: "spk-2", text: "不亮，整排都没电，八台设备全掉线了。", highlight: [] },
      { start: 8.4, end: 12.4, speaker: "spk-1", text: "先别动，我远程看一下 PoE 供电。", highlight: [] },
      { start: 12.8, end: 17.0, speaker: "spk-2", text: "好，我在井道门口等你消息。", highlight: [] },
      { start: 17.4, end: 21.4, speaker: "spk-1", text: "确认是电源模块故障，我报个工单换件。", highlight: [] },
      { start: 21.8, end: 24.6, speaker: "spk-2", text: "收到。", highlight: [] },
    ],
  }));
}

// ============================================================
// 12. 聚合统计（口径写在 _meta.calc_note，前端直接用）
// ============================================================
const last24h = allAlarms.filter((a) => a.ts_offset_minutes >= 0 && a.ts_offset_minutes < DAY);
const naturalDay = allAlarms.filter((a) => dayDiff(a.ts_offset_minutes) === 0);
const lastWeekSameDay = allAlarms.filter((a) => dayDiff(a.ts_offset_minutes) === 7);
const onlineDevices = devices.filter((d) => d.status === "online").length;
const fpCount = allAlarms.filter((a) => a.false_positive).length;
const unhandled = allAlarms.filter((a) => a.status === "new" || a.status === "dispatched");

const kpi = {
  _meta: {
    generated_at: DEMO_ANCHOR,
    calc_note:
      "所有口径以 ts_offset_minutes（相对锚点偏移，越小越新）为基准。" +
      "alarm_last_24h = 偏移 [0,1440)；alarm_natural_day = 今天 00:00 起（锚点正午，即 [0,720]）；" +
      "alarm_today 是 alarm_natural_day 的兼容别名，二者必须相等。" +
      "online_rate / false_positive_rate 均为百分数（0–100），不是小数。" +
      "gpu 的 cards.vram_used_gb 之和 = vram_total_gb × utilization_percent / 100。",
  },
  device_total: devices.length,
  device_online: onlineDevices,
  device_offline: devices.filter((d) => d.status === "offline").length,
  device_maintenance: devices.filter((d) => d.status === "maintenance").length,
  online_rate: Number(((onlineDevices / devices.length) * 100).toFixed(1)),
  alarm_last_24h: last24h.length,
  alarm_natural_day: naturalDay.length,
  alarm_today: naturalDay.length, // 兼容别名，等于 alarm_natural_day
  alarm_last_week_same_day: lastWeekSameDay.length,
  alarm_natural_day_delta_pct: Number((((naturalDay.length - lastWeekSameDay.length) / Math.max(1, lastWeekSameDay.length)) * 100).toFixed(1)),
  alarm_today_delta_pct: Number((((naturalDay.length - lastWeekSameDay.length) / Math.max(1, lastWeekSameDay.length)) * 100).toFixed(1)),
  delta_basis: "较上周同一星期几",
  alarm_unhandled: unhandled.length,
  alarm_unhandled_breakdown: [1, 2, 3, 4].map((lv) => ({
    level: lv,
    label: LEVEL_NAME[lv],
    count: unhandled.filter((a) => a.level === lv).length,
  })),
  alarm_unhandled_by_scene: ["campus", "hospital", "justice"].map((s) => ({
    scene: s,
    name: SITES.find((x) => x.scene === s).name,
    count: unhandled.filter((a) => a.scene === s).length,
  })),
  incident_open: incidents.filter((i) => i.status !== "closed").length,
  level_breakdown_today: [1, 2, 3, 4].map((lv) => ({
    level: lv,
    label: LEVEL_NAME[lv],
    count: naturalDay.filter((a) => a.level === lv).length,
  })),
  scene_breakdown_today: ["campus", "hospital", "justice"].map((s) => ({
    scene: s,
    name: SITES.find((x) => x.scene === s).name,
    count: naturalDay.filter((a) => a.scene === s).length,
  })),
  level_breakdown_last_24h: [1, 2, 3, 4].map((lv) => ({
    level: lv,
    label: LEVEL_NAME[lv],
    count: last24h.filter((a) => a.level === lv).length,
  })),
  alarm_total: allAlarms.length,
  incident_total: incidents.length,
  false_positive_rate: Number(((fpCount / allAlarms.length) * 100).toFixed(1)),
  avg_response_minutes: 4.2,
  response_p50_minutes: 3.1,
  response_p90_minutes: 18.6,
  gpu: {
    model: "8 × 96GB HBM3",
    vram_total_gb: 768,
    utilization_percent: 68,
    cards: [
      { index: 0, utilization: 87, vram_used_gb: 87, mode: "训练", temperature: 71 },
      { index: 1, utilization: 76, vram_used_gb: 76, mode: "推理", temperature: 63 },
      { index: 2, utilization: 92, vram_used_gb: 92, mode: "训练", temperature: 74 },
      { index: 3, utilization: 64, vram_used_gb: 64, mode: "推理", temperature: 58 },
      { index: 4, utilization: 71, vram_used_gb: 71, mode: "推理", temperature: 61 },
      { index: 5, utilization: 80, vram_used_gb: 80, mode: "大模型", temperature: 68 },
      { index: 6, utilization: 47, vram_used_gb: 47, mode: "推理", temperature: 52 },
      { index: 7, utilization: 5, vram_used_gb: 5, mode: "空闲", temperature: 44 },
    ],
  },
  storage: { hot_total_tb: 10, hot_used_tb: 6.1, cold_used_tb: 2.4, unit: "TB" },
  firmware_distribution: (() => {
    const m = new Map();
    for (const d of devices) {
      const k = `${d.model} ${d.firmware}`;
      m.set(k, (m.get(k) || 0) + 1);
    }
    return [...m.entries()]
      .map(([k, count]) => {
        const [model, version] = k.split(" ");
        return { model, version, count };
      })
      .sort((a, b) => a.model.localeCompare(b.model) || a.version.localeCompare(b.version));
  })(),
};

// 24 小时趋势：最近 24 小时按「钟点」聚合，数组「新 → 旧」
const hourlyTrend = Array.from({ length: 24 }, (_, i) => {
  const lo = i * HOUR;
  const hi = (i + 1) * HOUR;
  const bucket = last24h.filter((a) => a.ts_offset_minutes >= lo && a.ts_offset_minutes < hi);
  const clock = clockHour(lo);
  return {
    window_start_offset_minutes: lo,
    window_end_offset_minutes: hi,
    clock_hour: clock,
    label: `${String(clock).padStart(2, "0")}:00`,
    alarms: bucket.length,
    handled: bucket.filter((a) => a.status === "closed" || a.status === "false_positive").length,
  };
});

// 自然日趋势（含今天，共 7 天），数组「新 → 旧」
const dailyTrend = Array.from({ length: 7 }, (_, d) => {
  const bucket = allAlarms.filter((a) => dayDiff(a.ts_offset_minutes) === d);
  const local = new Date(localMs(d * DAY));
  const month = local.getUTCMonth() + 1;
  const date = local.getUTCDate();
  const weekday = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][local.getUTCDay()];
  return {
    day_offset_minutes: d * DAY,
    date_offset_days: d,
    date: `${local.getUTCFullYear()}-${String(month).padStart(2, "0")}-${String(date).padStart(2, "0")}`,
    label: `${month}/${date}`,
    weekday,
    alarms: bucket.length,
    incidents: incidents.filter((i) => dayDiff(i.started_offset_minutes) === d).length,
  };
});

// 时段 × 星期热力（7 × 24）：hour 是「时钟小时」，day 是「距今天几个自然日」
const heatmap = [];
for (let d = 0; d < 7; d++) {
  for (let h = 0; h < 24; h++) {
    const n = allAlarms.filter((a) => dayDiff(a.ts_offset_minutes) === d && clockHour(a.ts_offset_minutes) === h).length;
    heatmap.push({ day: d, hour: h, count: n });
  }
}

// 点位排行（Top 10）
const pointRank = [...new Set(allAlarms.map((a) => a.point_id))]
  .map((pid) => {
    const list = allAlarms.filter((a) => a.point_id === pid);
    return {
      point_id: pid,
      point_room: list[0].point_room,
      total: list.length,
      level1: list.filter((a) => a.level === 1).length,
      false_positive: list.filter((a) => a.false_positive).length,
      fp_rate: Number(((list.filter((a) => a.false_positive).length / list.length) * 100).toFixed(1)),
    };
  })
  .sort((a, b) => b.total - a.total || a.point_id.localeCompare(b.point_id))
  .slice(0, 10);

// 类型分布
const typeDistribution = ALARM_TYPES.map((t) => ({
  type_code: t.code,
  type_name: t.name,
  category: t.cat,
  count: allAlarms.filter((a) => a.type_code === t.code).length,
})).sort((a, b) => b.count - a.count || a.type_code.localeCompare(b.type_code));

// ============================================================
// 12b. 总览页三档时间范围（BLF-1424 Stage 2）
// ============================================================
//
// 为什么单独追加一份 overview-ranges.json：
//   · `kpi.json` / `trends.json` 是「当日口径」的既有契约（Stage 1 落位，多个页面在吃），
//     总览页要在 近 24 小时 / 今日 / 近 7 日 之间**真的换数**，就需要三套口径同时到位；
//   · 只追加新文件、不改既有文件 —— 重跑生成器后其它 JSON 的字节一个都不动，
//     PR 里不会出现十几 MB 的「重排噪声」；
//   · 每档的 trend / heatmap / levels / scenes / points / types 都是**同一窗口内的告警**
//     聚合出来的，所以「逐项相加 = 总量」可以被 validate.mjs 逐条钉住。
const isHandled = (a) => a.status === "closed" || a.status === "false_positive";
const isUnhandled = (a) => a.status === "new" || a.status === "dispatched";

/** 三档窗口定义：live = 滚动 24h；today = 今天自然日；week = 最近 7 个自然日。 */
const OVERVIEW_RANGE_DEFS = [
  {
    key: "live",
    label: "近 24 小时",
    window_label: "近 24 小时",
    granularity: "hour",
    bucket_count: 24,
    inWindow: (a) => a.ts_offset_minutes >= 0 && a.ts_offset_minutes < DAY,
    incidentInWindow: (i) => i.started_offset_minutes >= 0 && i.started_offset_minutes < DAY,
  },
  {
    key: "today",
    label: "今日",
    window_label: "今日",
    granularity: "hour",
    // 锚点在正午：自然日 = 偏移 [0,720]（00:00 → 12:00），所以是 12 个整点桶
    bucket_count: ANCHOR_CLOCK / HOUR,
    inWindow: (a) => dayDiff(a.ts_offset_minutes) === 0,
    incidentInWindow: (i) => dayDiff(i.started_offset_minutes) === 0,
  },
  {
    key: "week",
    label: "近 7 日",
    window_label: "近 7 日",
    granularity: "day",
    bucket_count: 7,
    inWindow: (a) => {
      const d = dayDiff(a.ts_offset_minutes);
      return d >= 0 && d <= 6;
    },
    incidentInWindow: (i) => {
      const d = dayDiff(i.started_offset_minutes);
      return d >= 0 && d <= 6;
    },
  },
];

/**
 * 一个桶的完整内容（小时桶 / 日桶 / 历史上同期的桶共用同一形状）。
 *
 * 为什么桶里要带 `levels` 与 `open_incidents`：数据流推进时前端只做「切片 + 拼接」，
 * 分级环形图与「在办事件」两个数字也必须跟着滚动窗口走。桶把这两项拆好，
 * 滚动后的合计就是**逐桶相加**，不会出现「图里的总数对不上 KPI」。
 */
function bucketOf({ label, list, incidentInBucket }) {
  const windowIncidents = incidents.filter(incidentInBucket);
  return {
    label,
    alarms: list.length,
    handled: list.filter(isHandled).length,
    // 未处置口径与 kpi.json 一致（new + dispatched）；帧里的 totals 直接由逐桶相加得到
    unhandled: list.filter(isUnhandled).length,
    incidents: windowIncidents.length,
    /** 其中仍在办（未 closed）的事件数：事件卡片的「在办 N 起」按窗口过滤，不再全站一个数 */
    open_incidents: windowIncidents.filter((it) => it.status !== "closed").length,
    false_positive: list.filter((a) => a.false_positive).length,
    levels: windowLevels(list),
    // 场景构成也按桶存：场景环形图中心的「合计」必须与 KPI 同窗口，
    // 否则推进一帧后同一屏会同时出现 483 与 532 两个总数。
    scenes: windowScenes(list),
  };
}

/** 小时桶（偏移 [lo,hi)），新 → 旧；今天的桶只覆盖自然日内的部分。 */
function hourBuckets(def) {
  return Array.from({ length: def.bucket_count }, (_, i) => {
    const lo = i * HOUR;
    const hi = lo + HOUR;
    const list = allAlarms.filter((a) => def.inWindow(a) && a.ts_offset_minutes >= lo && a.ts_offset_minutes < hi);
    const clock = clockHour(lo);
    return bucketOf({
      label: `${String(clock).padStart(2, "0")}:00`,
      list,
      incidentInBucket: (it) => it.started_offset_minutes >= lo && it.started_offset_minutes < hi,
    });
  });
}

/** 自然日桶（新 → 旧，0 = 今天）。 */
function dayBuckets(def) {
  return Array.from({ length: def.bucket_count }, (_, d) => {
    const list = allAlarms.filter((a) => def.inWindow(a) && dayDiff(a.ts_offset_minutes) === d);
    const local = new Date(localMs(d * DAY));
    return bucketOf({
      label: `${local.getUTCMonth() + 1}/${local.getUTCDate()}`,
      list,
      incidentInBucket: (it) => dayDiff(it.started_offset_minutes) === d,
    });
  });
}

/** 窗口内的分级构成：总数 + 其中未处置。 */
function windowLevels(list) {
  return [1, 2, 3, 4].map((level) => ({
    level,
    total: list.filter((a) => a.level === level).length,
    unhandled: list.filter((a) => a.level === level && isUnhandled(a)).length,
  }));
}

/** 窗口内的场景构成（`name` 是站点名，图例里做主标签的副注）。 */
function windowScenes(list) {
  return ["campus", "hospital", "justice"].map((scene) => ({
    scene,
    name: SITES.find((x) => x.scene === scene).name,
    count: list.filter((a) => a.scene === scene).length,
    unhandled: list.filter((a) => a.scene === scene && isUnhandled(a)).length,
  }));
}

/** 窗口内的点位 Top（口径与 rankings.json 的 points 一致）。 */
function windowPoints(list, limit = 6) {
  const byPoint = new Map();
  for (const a of list) {
    const row = byPoint.get(a.point_id) ?? {
      point_id: a.point_id,
      point_room: a.point_room,
      total: 0,
      level1: 0,
      false_positive: 0,
    };
    row.total += 1;
    if (a.level === 1) row.level1 += 1;
    if (a.false_positive) row.false_positive += 1;
    byPoint.set(a.point_id, row);
  }
  return [...byPoint.values()]
    .map((row) => ({ ...row, fp_rate: Number(((row.false_positive / row.total) * 100).toFixed(1)) }))
    .sort((a, b) => b.total - a.total || a.point_id.localeCompare(b.point_id))
    .slice(0, limit);
}

/** 窗口内的告警类型 Top。 */
function windowTypes(list, limit = 6) {
  return ALARM_TYPES.map((t) => ({
    type_code: t.code,
    type_name: t.name,
    category: t.cat,
    count: list.filter((a) => a.type_code === t.code).length,
  }))
    .filter((row) => row.count > 0)
    .sort((a, b) => b.count - a.count || a.type_code.localeCompare(b.type_code))
    .slice(0, limit);
}

/** 热力图的横轴刻度：与既有总览一致，每 6 格标一个钟点，其余留空。 */
function heatAxis(clockOfIndex) {
  return Array.from({ length: 24 }, (_, i) =>
    i % 6 === 0 ? String(clockOfIndex(i)).padStart(2, "0") : "",
  );
}

/**
 * 热力窗口：三档必须是**三种形状**，一眼能看出不同。
 *   · live ：1 行 × 24 格（滚动 24 小时，从左到右由旧到新，轴上是真实钟点）
 *   · today：1 行 × 24 格（今天的钟点网格，尚未到来的小时为空）
 *   · week ：7 行 × 24 格（7 个自然日 × 24 小时）
 */
function windowHeatmap(def, list) {
  if (def.key === "live") {
    // j = 0 最旧（23 小时前）… j = 23 最新（当前小时）
    const cells = Array.from({ length: 24 }, (_, j) => {
      const offsetHour = 23 - j;
      const lo = offsetHour * HOUR;
      const hi = lo + HOUR;
      return {
        hour: clockHour(lo),
        count: list.filter((a) => a.ts_offset_minutes >= lo && a.ts_offset_minutes < hi).length,
      };
    });
    return {
      axis: heatAxis((j) => clockHour((23 - j) * HOUR)),
      rows: [{ key: "rolling", label: "近 24 小时", cells }],
    };
  }
  if (def.key === "today") {
    const cells = Array.from({ length: 24 }, (_, hour) => ({
      hour,
      count: list.filter((a) => clockHour(a.ts_offset_minutes) === hour).length,
    }));
    return {
      axis: heatAxis((i) => i),
      rows: [{ key: "today", label: "今天", cells }],
    };
  }
  const dayLabels = ["今天", "昨天"];
  const rows = Array.from({ length: 7 }, (_, d) => ({
    key: `day-${d}`,
    label: dayLabels[d] ?? `${d} 天前`,
    cells: Array.from({ length: 24 }, (_, hour) => ({
      hour,
      count: allAlarms.filter((a) => def.inWindow(a) && dayDiff(a.ts_offset_minutes) === d && clockHour(a.ts_offset_minutes) === hour).length,
    })),
  }));
  return { axis: heatAxis((i) => i), rows };
}

/**
 * 数据流推进的帧数：小时档 8 帧（8 × 5s ≈ 40s 一轮），日档 4 帧。
 * 日档必须显著小于桶数（7）：否则一轮下来整段窗口都被换掉，KPI 会出现一次
 * 从 532 → 996 的跳变，看起来像数据错乱而不是「数据在流」。
 */
const DEMO_FRAMES_HOURLY = 8;
const DEMO_FRAMES_DAILY = 4;
const DEMO_TICK_SECONDS = 5;

/** 数据流推进帧里「新增桶」的取值来源：一周前同一时段（数据里真实存在，不是拍脑袋）。 */
function historicalHourBucket(daysAgo, clock) {
  const list = allAlarms.filter(
    (a) => dayDiff(a.ts_offset_minutes) === daysAgo && clockHour(a.ts_offset_minutes) === clock,
  );
  return bucketOf({
    label: `${String(clock).padStart(2, "0")}:00`,
    list,
    incidentInBucket: (it) =>
      dayDiff(it.started_offset_minutes) === daysAgo && clockHour(it.started_offset_minutes) === clock,
  });
}

function historicalDayBucket(daysAgo) {
  const list = allAlarms.filter((a) => dayDiff(a.ts_offset_minutes) === daysAgo);
  const local = new Date(localMs(daysAgo * DAY));
  return bucketOf({
    label: `${local.getUTCMonth() + 1}/${local.getUTCDate()}`,
    list,
    incidentInBucket: (it) => dayDiff(it.started_offset_minutes) === daysAgo,
  });
}

/**
 * 推进帧里新增那一格的日期文案：窗口是向「未来」滚的，标签也必须向前走。
 *
 * 值取自历史上 8 天前的同一天（数据真实存在），但标签不能跟着用那一天 ——
 * 否则周档会看着时间轴从 10/19 倒退到 10/11。所以这里给「今天 + N 天」的模拟日期。
 */
function futureDayLabel(daysAhead) {
  const local = new Date(localMs(-daysAhead * DAY));
  return `${local.getUTCMonth() + 1}/${local.getUTCDate()}`;
}

/**
 * 演示帧：窗口每 tick 向「现在」滚动一格 —— 最旧的一格掉出、最新的一格补进来。
 * 因此帧里给出的是**滚动后**的 totals / levels（KPI 与分级图直接读它），而不是让前端做加法：
 * 前端（尤其 TSX）不参与任何业务数字的运算。
 */
function buildStreamFrames(def, trend) {
  // trend 是「新 → 旧」：滚动一格 = 去掉数组末尾（最旧）并在开头补一格（最新）
  let totals = totalsFrom(trend);
  const isDaily = def.granularity === "day";
  const addedBuckets = [];
  const frames = [];
  const frameCount = isDaily ? DEMO_FRAMES_DAILY : DEMO_FRAMES_HOURLY;
  for (let i = 0; i < frameCount; i += 1) {
    // 来源按天错开（7..14 天前），并跳过「和被挤掉的旧桶完全一样」的候选：
    // 固定用「7 天前同一钟点」时，有些桶的历史值恰好等于旧桶（实测 13:00 是 5 条 → 5 条），
    // 那一帧推进后曲线与 KPI 完全不动，演示时看起来像卡住。
    const clock = isDaily ? 0 : (ANCHOR_CLOCK / HOUR + 1 + i) % 24;
    const dropped = trend[trend.length - 1 - i];
    const sameBucket = (a, b) =>
      a.alarms === b.alarms && a.handled === b.handled && a.incidents === b.incidents && a.false_positive === b.false_positive;
    let daysAgo = isDaily ? 8 + i : 7 + (i % 8);
    let added = isDaily ? historicalDayBucket(daysAgo) : historicalHourBucket(daysAgo, clock);
    for (let attempt = 0; attempt < 5 && sameBucket(added, dropped); attempt += 1) {
      daysAgo += 1;
      added = isDaily ? historicalDayBucket(daysAgo) : historicalHourBucket(daysAgo, clock);
    }
    // 新补进来的那一格代表「刚刚到达」：时间轴向前走（周档要换成今天的 N 天后），
    // 而且这一格里的事件全部是刚入库的 —— 一个也还没关闭，所以在办 = 事件数。
    added = {
      ...added,
      label: isDaily ? futureDayLabel(i + 1) : added.label,
      open_incidents: added.incidents,
    };
    // 逐桶重算（不做「加减近似」）：未处置 = new + dispatched，与 kpi.json 同口径，
    // 用减法会在「已确认（acknowledged）」上漂出负数 —— 帧里的数字必须能对得上明细。
    addedBuckets.unshift(added);
    const rolling = [...addedBuckets, ...trend.slice(0, trend.length - (i + 1))];
    totals = totalsFrom(rolling);
    frames.push({
      trend_label: added.label,
      alarms: added.alarms,
      handled: added.handled,
      unhandled: added.unhandled,
      incidents: added.incidents,
      open_incidents: added.open_incidents,
      false_positive: added.false_positive,
      // `added_levels` 是**新增那一格自己**的分级构成（与上面的 alarms / handled 同一格），
      // `levels` 是滚动后整个窗口的合计（页面读它画分级图）。两个分开存，
      // 才能让「逐桶相加 = 滚动后合计」在数据文件里被直接验算。
      added_levels: added.levels,
      levels: levelsFrom(rolling),
      scenes: scenesFrom(rolling),
      heat: { row: 0, hour: isDaily ? ANCHOR_CLOCK / HOUR : clock },
      totals,
    });
  }
  return { tick_seconds: DEMO_TICK_SECONDS, frames };
}

/** 桶列表 → totals。比率也在这里算好，前端只负责格式化，不做业务除法。 */
function totalsFrom(buckets) {
  const sum = (key) => buckets.reduce((total, b) => total + b[key], 0);
  const alarms = sum("alarms");
  const handled = sum("handled");
  const falsePositive = sum("false_positive");
  return {
    alarms,
    handled,
    unhandled: sum("unhandled"),
    false_positive: falsePositive,
    incidents: sum("incidents"),
    // 在办事件 **按窗口过滤**：全站一个数的话，今日只有 10 起事件却显示「在办 36 起」
    open_incidents: sum("open_incidents"),
    handled_rate: alarms ? Number(((handled / alarms) * 100).toFixed(1)) : 0,
    false_positive_rate: alarms ? Number(((falsePositive / alarms) * 100).toFixed(1)) : 0,
  };
}

/** 桶列表 → 分级构成（总数 + 其中未处置），与 `totalsFrom` 同一套逐桶相加。 */
function levelsFrom(buckets) {
  return [1, 2, 3, 4].map((level) => ({
    level,
    total: buckets.reduce((total, b) => total + b.levels.find((row) => row.level === level).total, 0),
    unhandled: buckets.reduce((total, b) => total + b.levels.find((row) => row.level === level).unhandled, 0),
  }));
}

/** 桶列表 → 场景构成（同样逐桶相加，保证环形图合计 = KPI 总数）。 */
function scenesFrom(buckets) {
  return ["campus", "hospital", "justice"].map((scene) => ({
    scene,
    name: SITES.find((x) => x.scene === scene).name,
    count: buckets.reduce((total, b) => total + b.scenes.find((row) => row.scene === scene).count, 0),
    unhandled: buckets.reduce((total, b) => total + b.scenes.find((row) => row.scene === scene).unhandled, 0),
  }));
}

const overviewRanges = {};
for (const def of OVERVIEW_RANGE_DEFS) {
  const windowAlarms = allAlarms.filter(def.inWindow);
  const trend = def.granularity === "day" ? dayBuckets(def) : hourBuckets(def);
  const heatmap = windowHeatmap(def, windowAlarms);
  const peak = trend.reduce((best, row) => (row.alarms > best.alarms ? row : best), trend[0]);
  // totals 由 trend 的桶相加得到（不用另一套过滤），这样「逐桶相加 = 总量」天然成立
  const totals = totalsFrom(trend);
  overviewRanges[def.key] = {
    key: def.key,
    label: def.label,
    window_label: def.window_label,
    granularity: def.granularity,
    kpi_defs: [
      { key: "alarms", label: `${def.window_label}告警`, unit: "条", decimals: 0 },
      { key: "handled", label: "已处置", unit: "条", decimals: 0 },
      { key: "incidents", label: `${def.window_label}事件`, unit: "起", decimals: 0 },
      { key: "false-positive", label: "误报率", unit: "%", decimals: 1 },
    ],
    totals,
    peak: { label: peak.label, value: peak.alarms },
    levels: levelsFrom(trend),
    scenes: scenesFrom(trend),
    trend,
    heatmap: { ...heatmap, max: Math.max(1, ...heatmap.rows.flatMap((row) => row.cells.map((cell) => cell.count))) },
    points: windowPoints(windowAlarms),
    types: windowTypes(windowAlarms),
    // 键名刻意不叫 demo：`public/stream-monitor-data/*.json` 是访客可下载的公开数据，
    // siteCopyGuard 会把任何 demo / 「演示」判成「把自己写小」的措辞。
    stream: buildStreamFrames(def, trend),
  };
}

const overviewRangeFile = {
  _meta: {
    generated_at: DEMO_ANCHOR,
    calc_note:
      "总览页三档口径（BLF-1424）：live = 偏移 [0,1440) 的滚动 24 小时；" +
      "today = 今天自然日（锚点正午，00:00 → 12:00）；week = 最近 7 个自然日（dayDiff 0..6）。" +
      "每档的 totals / levels / scenes / trend / heatmap / points / types 都只统计该窗口内的告警（totals.open_incidents 也只数窗口内未关闭的事件），" +
      "所以逐项相加必须等于 totals.alarms。趋势桶自带 levels / open_incidents，帧的滚动合计就是逐桶相加，" +
      "分级环形图与「在办 N 起」会跟着数据流一起变。stream.frames 是页面数据流推进用的固定帧：窗口每 tick 向现在滚动一格" +
      "（最旧一格掉出、最新一格补进来），新增格的取值来自历史上同期的桶，但标签向前走（周档是今天 + N 天），" +
      "帧里直接给出滚动后的 totals / levels，前端不做业务运算。" +
      "?static=1 与 prefers-reduced-motion 下只展示第 0 帧（不推进）。",
    range_order: OVERVIEW_RANGE_DEFS.map((d) => d.key),
  },
  ranges: overviewRanges,
};

// ============================================================
// 13. 场景 / 算法 / 规则 / 审计日志
// ============================================================
const SCENES = [
  {
    id: "campus", name: "校园防欺凌", code: "CAMPUS",
    slogan: "隐蔽区域无死角感知 · 欺凌自动分级响应",
    desc: "覆盖卫生间、走廊、操场等监控盲区，通过音频实现无死角欺凌感知，事件自动分级并联动处置。",
    theme_token: "scene.campus",
    apps: ["言语欺凌识别", "哭声 / 呼救检测", "关键词告警", "声光驱离", "一键报警", "班主任 APP 提醒", "家长端协同", "设备远程运维", "110 联动"],
  },
  {
    id: "hospital", name: "医院安全防控", code: "HOSPITAL",
    slogan: "医患冲突预警 · 分贝管理 · 行为合规",
    desc: "面向门诊、急诊、病房、手术室的一体化音频 + 视觉安全防控，冲突升级前快速介入。",
    theme_token: "scene.hospital",
    apps: ["一键报警联动", "声光震慑", "分贝异常预警", "医患冲突识别", "睡岗脱岗检测", "黑名单识别", "手术服穿戴合规", "贵重药品防盗", "人流疏导"],
  },
  {
    id: "justice", name: "公安司法 · 智慧审讯", code: "JUSTICE",
    slogan: "实时转写 · 质量评判 · 在押画像",
    desc: "为审讯、在押管理提供实时转写、谈话质量智能评判与人员画像构建的深度办案辅助。",
    theme_token: "scene.justice",
    apps: ["实时语音转写", "多方言 / 混读", "谈话质量评判", "在押人员画像", "审讯知识库", "证据链沉淀", "风险分级", "关系图谱", "合规分析"],
  },
];
for (const s of SCENES) {
  const site = SITES.find((x) => x.scene === s.id);
  s.kpi = {
    points: points.filter((p) => p.site_id === site.id).length,
    devices: devices.filter((d) => d.site_id === site.id).length,
    today_alarms: naturalDay.filter((a) => a.scene === s.id).length,
    total_alarms: allAlarms.filter((a) => a.scene === s.id).length,
  };
}

const ALGORITHMS = [
  { id: "alg-asd", name: "异常声音检测", category: "audio", version: "2.4.1", status: "running", calls_today: 18420, avg_latency_ms: 42, vram_gb: 3.2 },
  { id: "alg-kws", name: "关键词检测", category: "audio", version: "3.1.0", status: "running", calls_today: 26180, avg_latency_ms: 28, vram_gb: 2.1 },
  { id: "alg-denoise", name: "环境降噪", category: "audio", version: "1.9.4", status: "running", calls_today: 41260, avg_latency_ms: 8, vram_gb: 1.4 },
  { id: "alg-reverb", name: "抗混响", category: "audio", version: "1.4.2", status: "running", calls_today: 31200, avg_latency_ms: 12, vram_gb: 1.2 },
  { id: "alg-db", name: "分贝异常检测", category: "audio", version: "2.0.6", status: "running", calls_today: 38940, avg_latency_ms: 5, vram_gb: 0.4 },
  { id: "alg-doa", name: "3D 空间定位", category: "audio", version: "1.2.0", status: "running", calls_today: 9640, avg_latency_ms: 36, vram_gb: 1.8 },
  { id: "alg-diar", name: "角色分离", category: "audio", version: "2.2.3", status: "running", calls_today: 4820, avg_latency_ms: 120, vram_gb: 4.6 },
  { id: "alg-bully", name: "言语欺凌识别", category: "audio", version: "3.0.2", status: "running", calls_today: 12860, avg_latency_ms: 68, vram_gb: 3.8 },
  { id: "alg-sleep", name: "睡岗检测", category: "vision", version: "2.1.0", status: "running", calls_today: 8420, avg_latency_ms: 74, vram_gb: 3.1 },
  { id: "alg-fall", name: "人员跌倒检测", category: "vision", version: "2.3.1", status: "running", calls_today: 6240, avg_latency_ms: 92, vram_gb: 3.4 },
  { id: "alg-intrude", name: "入侵检测", category: "vision", version: "1.8.5", status: "running", calls_today: 14260, avg_latency_ms: 58, vram_gb: 2.6 },
  { id: "alg-face", name: "人脸识别流水线", category: "vision", version: "4.0.1", status: "running", calls_today: 22140, avg_latency_ms: 46, vram_gb: 5.2 },
  { id: "alg-ppe", name: "着装合规检测", category: "vision", version: "1.6.0", status: "running", calls_today: 3860, avg_latency_ms: 66, vram_gb: 2.8 },
  { id: "alg-asr", name: "实时语音转写", category: "speech", version: "5.2.0", status: "running", calls_today: 18420, avg_latency_ms: 260, vram_gb: 9.4 },
  { id: "alg-quality", name: "谈话质量评估", category: "speech", version: "2.0.0", status: "running", calls_today: 1260, avg_latency_ms: 480, vram_gb: 6.2 },
  { id: "alg-summary", name: "谈话摘要生成", category: "llm", version: "1.4.0", status: "running", calls_today: 386, avg_latency_ms: 6200, vram_gb: 42.0 },
  { id: "alg-profile", name: "人员画像构建", category: "llm", version: "1.2.0", status: "running", calls_today: 142, avg_latency_ms: 8400, vram_gb: 42.0 },
  { id: "alg-compliance", name: "合规性分析", category: "llm", version: "1.1.3", status: "paused", calls_today: 68, avg_latency_ms: 7200, vram_gb: 42.0 },
];
const ALGO_CATEGORIES = [
  { code: "audio", name: "音频算法", count: 8, theme_token: "algo.audio" },
  { code: "vision", name: "视觉 AI", count: 5, theme_token: "algo.vision" },
  { code: "speech", name: "语音语义", count: 2, theme_token: "algo.speech" },
  { code: "llm", name: "大模型融合", count: 3, theme_token: "algo.llm" },
];

const RULES = [
  { id: "rule-001", name: "欺凌关键词", scene: "campus", threshold: "后验概率 ≥ 0.80", action: "三级告警", enabled: true },
  { id: "rule-002", name: "三路融合升级", scene: "campus", threshold: "关键词 + 异常声音 + 分贝 同时命中", action: "升级一级 + 声光驱离", enabled: true },
  { id: "rule-003", name: "分贝夜间阈值", scene: "hospital", threshold: "22:00-06:00 > 45 dBA 持续 5 分钟", action: "三级告警", enabled: true },
  { id: "rule-004", name: "黑名单比对", scene: "hospital", threshold: "余弦相似度 ≥ 0.75 且与次高差 > 0.15", action: "一级告警", enabled: true },
  { id: "rule-005", name: "设备离线升级", scene: "all", threshold: "心跳中断 > 150 分钟", action: "二级告警 + 运维工单", enabled: true },
  { id: "rule-006", name: "误报观察降级", scene: "all", threshold: "点位 7 天内误报率 > 25%", action: "该点位告警静默 7 天（仅记录）", enabled: true },
  { id: "rule-007", name: "一键报警直通", scene: "hospital", threshold: "一键报警按钮触发", action: "跳过分级直通一级 + 声光震慑", enabled: true },
  { id: "rule-008", name: "批量离线合并", scene: "all", threshold: "同一网关 10 分钟内 ≥ 5 台离线", action: "合并为 1 条批量告警 + 单张工单", enabled: true },
];

const AUDIT_ACTIONS = [
  ["导出夜间事件证据包", "export", "high"], ["新增黑名单人脸", "create", "medium"],
  ["修改告警联动策略", "update", "high"], ["远程升级设备固件", "ota", "medium"],
  ["导出审讯转写记录", "export", "high"], ["调整分贝阈值", "update", "medium"],
  ["删除误报告警", "delete", "high"], ["新增检测规则", "create", "medium"],
  ["下载录音文件", "export", "medium"], ["调整用户权限", "permission", "high"],
  ["停用值班账号", "permission", "high"], ["批量删除历史告警", "delete", "high"],
  ["导出点位清单", "export", "low"], ["重命名站点", "update", "low"],
  ["查看实时视频", "read", "low"], ["回放历史录像", "read", "low"],
  ["提交误报申诉", "create", "low"], ["恢复默认阈值", "update", "medium"],
  ["启用人脸比对", "update", "high"], ["导出月度报表", "export", "low"],
];
const AUDIT_LOGS = Array.from({ length: 300 }, (_, i) => {
  const site = pick(SITES);
  // 操作人必须落在日志所属站点（或显式跨站点职责），否则 Stage 2 的操作日志页
  // 会出现「公安主管操作校园告警」。和事件的 owner 归属同一套规则。
  const u = pickSiteUser(site.id);
  const [action, actionCode, risk] = pick(AUDIT_ACTIONS);
  const pending = chance(0.12);
  return {
    id: `log-${String(1000 + i)}`,
    ts_offset_minutes: rint(0, 30 * DAY),
    user_id: u.id,
    user_name: u.name,
    action,
    action_code: actionCode,
    target_type: actionCode === "permission" ? "user" : actionCode === "ota" ? "device" : "alarm",
    target_id: actionCode === "permission" ? u.id : `${site.id}/batch-${100 + i}`,
    site_id: site.id,
    result: pending ? "pending" : "pass",
    risk_level: risk,
    ip: `10.20.${rint(1, 30)}.${rint(2, 250)}`,
  };
}).sort((a, b) => a.ts_offset_minutes - b.ts_offset_minutes);

// ============================================================
// 14. 输出（告警分片 + 索引；所有聚合文件写盘）
// ============================================================
rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, "alarms"), { recursive: true });

const written = [];
function write(name, data, { pretty = false } = {}) {
  const text = pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data);
  writeFileSync(join(OUT, name), text, "utf8");
  written.push({ name, bytes: Buffer.byteLength(text) });
  return text;
}

// —— 告警分片：按「新 → 旧」顺序切，单片 ≤ 1.2MB（硬上限 1.5MB） ——
const SHARD_BUDGET_BYTES = 1_200_000;
const shards = [];
let current = [];
let currentBytes = 0;
for (const a of allAlarms) {
  const bytes = Buffer.byteLength(JSON.stringify(a)) + 1;
  if (current.length && currentBytes + bytes > SHARD_BUDGET_BYTES) {
    shards.push(current);
    current = [];
    currentBytes = 0;
  }
  current.push(a);
  currentBytes += bytes;
}
if (current.length) shards.push(current);

const shardMeta = [];
shards.forEach((list, i) => {
  const file = `alarms/shard-${String(i).padStart(3, "0")}.json`;
  const body = {
    shard: i,
    count: list.length,
    from_offset_minutes: list[0].ts_offset_minutes,
    to_offset_minutes: list[list.length - 1].ts_offset_minutes,
    alarms: list,
  };
  const text = JSON.stringify(body);
  writeFileSync(join(OUT, file), text, "utf8");
  const bytes = Buffer.byteLength(text);
  written.push({ name: file, bytes });
  shardMeta.push({
    index: i,
    file,
    count: list.length,
    bytes,
    from_offset_minutes: body.from_offset_minutes,
    to_offset_minutes: body.to_offset_minutes,
    tier_counts: {
      script: list.filter((a) => a.narrative_tier === "script").length,
      related: list.filter((a) => a.narrative_tier === "related").length,
      noise: list.filter((a) => a.narrative_tier === "noise").length,
    },
  });
});

const alarmsIndex = {
  _meta: {
    total: allAlarms.length,
    shard_count: shardMeta.length,
    sorted_by: "ts_offset_minutes asc（新 → 旧）",
    note: "首页只加载本文件；列表按 cursor 逐段加载，不要一次拉全部。",
  },
  pagination: {
    page_size: 50,
    max_page_size: 200,
    cursor_format: "<shardIndex>:<offsetInShard>",
    cursor_example: "0:50",
    next_cursor_field: "next_cursor",
    empty_cursor: null,
    total: allAlarms.length,
  },
  shards: shardMeta,
};
write("alarms-index.json", alarmsIndex, { pretty: true });

write("org.json", ORG, { pretty: true });
write("sites.json", SITES, { pretty: true });
write("points.json", points, { pretty: true });
write("devices.json", devices);
write("users.json", USERS, { pretty: true });
write("incidents.json", incidents);
write("kpi.json", kpi, { pretty: true });
write("trends.json", { hourly: hourlyTrend, daily: dailyTrend, heatmap }, { pretty: true });
// 总览页三档口径（BLF-1424）：只追加新文件，上面所有既有 JSON 的字节不变
write("overview-ranges.json", overviewRangeFile, { pretty: true });
write("rankings.json", { points: pointRank, types: typeDistribution }, { pretty: true });
write("scenes.json", SCENES, { pretty: true });
write("algorithms.json", { categories: ALGO_CATEGORIES, algorithms: ALGORITHMS }, { pretty: true });
write("rules.json", RULES, { pretty: true });
write("audit-logs.json", AUDIT_LOGS);
write("spectra.json", spectra);
write("transcripts.json", transcripts);

// 设备画像汇总（前端设备页/运维页直接用，不必自己遍历 250 台设备）
const deviceStats = {
  by_status: ["online", "offline", "maintenance"].map((s) => ({
    status: s,
    count: devices.filter((d) => d.status === s).length,
  })),
  by_site: SITES.map((s) => ({
    site_id: s.id,
    total: devices.filter((d) => d.site_id === s.id).length,
    online: devices.filter((d) => d.site_id === s.id && d.status === "online").length,
  })),
  by_model: DEVICE_MODELS.map((m) => ({
    model: m.model,
    type_name: m.type,
    count: devices.filter((d) => d.model === m.model).length,
  })),
  ota_summary: {
    total: devices.reduce((s, d) => s + d.ota_records.length, 0),
    success: devices.reduce((s, d) => s + d.ota_records.filter((o) => o.status === "success").length, 0),
    failed: devices.reduce((s, d) => s + d.ota_records.filter((o) => o.status === "failed").length, 0),
  },
  signal_health: (() => {
    const online = devices.filter((d) => d.status === "online");
    const vals = online.map((d) => d.signal).sort((a, b) => a - b);
    const at = (p) => vals[Math.min(vals.length - 1, Math.floor(vals.length * p))];
    return { avg: Number((vals.reduce((s, v) => s + v, 0) / vals.length).toFixed(1)), p10: at(0.1), p50: at(0.5), p90: at(0.9) };
  })(),
};
write("device-stats.json", deviceStats, { pretty: true });

const allFiles = [...written.map((w) => w.name)].sort();
write("index.json", {
  generated_by: "stream-monitor data generator",
  seed: SEED,
  anchor: DEMO_ANCHOR,
  timezone: "UTC+8",
  counts: {
    sites: SITES.length,
    points: points.length,
    devices: devices.length,
    users: USERS.length,
    alarms: allAlarms.length,
    alarm_shards: shardMeta.length,
    incidents: incidents.length,
    spectra: spectra.length,
    transcripts: transcripts.length,
    audit_logs: AUDIT_LOGS.length,
    scripts: 8,
  },
  scripts: [
    { id: "A", scene: "campus", title: "校园欺凌完整闭环", alarm_count: scriptAlarms.filter((a) => a.script_id === "A").length },
    { id: "B", scene: "campus", title: "噪声点位连续 7 天误报", alarm_count: scriptAlarms.filter((a) => a.script_id === "B").length },
    { id: "C", scene: "campus", title: "设备离线 6 天 5 小时（运维闭环）", alarm_count: scriptAlarms.filter((a) => a.script_id === "C").length },
    { id: "D", scene: "hospital", title: "医院一键报警闭环", alarm_count: scriptAlarms.filter((a) => a.script_id === "D").length },
    { id: "E", scene: "hospital", title: "医院夜间分贝超标", alarm_count: scriptAlarms.filter((a) => a.script_id === "E").length },
    { id: "F", scene: "justice", title: "公安谈话质量评分", alarm_count: scriptAlarms.filter((a) => a.script_id === "F").length },
    { id: "G", scene: "campus", title: "设备批量离线（网关故障）", alarm_count: scriptAlarms.filter((a) => a.script_id === "G").length },
    { id: "H", scene: "campus", title: "误报观察降级生效", alarm_count: scriptAlarms.filter((a) => a.script_id === "H").length },
  ],
  files: [...allFiles, "index.json"],
}, { pretty: true });

console.log("generated →", OUT);
for (const w of written.sort((a, b) => b.bytes - a.bytes)) {
  console.log(`  ${w.name.padEnd(24)} ${(w.bytes / 1024).toFixed(1)} KB`);
}
console.log(
  `\nalarms ${allAlarms.length} / incidents ${incidents.length} / devices ${devices.length} / points ${points.length}` +
  ` / spectra ${spectra.length} / transcripts ${transcripts.length} / shards ${shardMeta.length}`,
);
console.log(
  `script alarms: A=${scriptAlarms.filter((a) => a.script_id === "A").length}` +
  ` B=${scriptAlarms.filter((a) => a.script_id === "B").length}` +
  ` C=${scriptAlarms.filter((a) => a.script_id === "C").length}` +
  ` D=${scriptAlarms.filter((a) => a.script_id === "D").length}` +
  ` E=${scriptAlarms.filter((a) => a.script_id === "E").length}` +
  ` F=${scriptAlarms.filter((a) => a.script_id === "F").length}` +
  ` G=${scriptAlarms.filter((a) => a.script_id === "G").length}` +
  ` H=${scriptAlarms.filter((a) => a.script_id === "H").length}`,
);
console.log(`alarm_last_24h=${kpi.alarm_last_24h} natural_day=${kpi.alarm_natural_day} unhandled=${kpi.alarm_unhandled}`);
console.log(`max shard ${(Math.max(...shardMeta.map((s) => s.bytes)) / 1024).toFixed(0)} KB (budget 1200 KB, hard limit 1536 KB)`);
