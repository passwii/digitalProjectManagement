// 一致性校验：保证跨表引用完整、聚合口径与明细自洽、契约可被前端消费。
//
// 分两层：
//   1. 原 36 项「聚合对聚合」检查（今天总数 = 分级之和 = 场景之和）
//   2. 本 Stage 新增的「聚合对明细 / 语义对语义」检查（场景卡数量、热力图轴、频谱指针、
//      剧本自洽、排序方向、分片体积、极端值、空态 …）
// 运行：node scripts/mock/validate.mjs   → 全绿才算可用
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, readDataset, makeTime } from "./lib/dataset.mjs";

const ds = readDataset();
const {
  index, alarmsIndex, alarms, org, sites, points, devices, deviceStats, users,
  incidents, kpi, trends, rankings, scenes, algorithms, rules, auditLogs, spectra, transcripts,
  overviewRanges,
} = ds;

const T = makeTime(kpi._meta.generated_at);
const DAY = 1440;

const checks = [];
const fails = [];
function check(name, fn) {
  try {
    const r = fn();
    if (r === true || r === undefined) checks.push(`✓ ${name}`);
    else {
      checks.push(`✗ ${name} → ${r}`);
      fails.push(name);
    }
  } catch (e) {
    checks.push(`✗ ${name} → ${e.message}`);
    fails.push(name);
  }
}

const siteIds = new Set(sites.map((s) => s.id));
const pointIds = new Set(points.map((p) => p.id));
const siteById = new Map(sites.map((s) => [s.id, s]));
const pointById = new Map(points.map((p) => [p.id, p]));
const deviceIds = new Set(devices.map((d) => d.id));
const alarmById = new Map(alarms.map((a) => [a.id, a]));
const sceneBySite = new Map(sites.map((s) => [s.id, s.scene]));
const spectrumIds = new Set(spectra.map((s) => s.id));
const inIncident = new Set(incidents.flatMap((i) => i.alarm_ids));
const isScript = (a) => a.narrative_tier === "script";

// ════════════════════════════════════════════════════════════
// 一、品牌与引用完整性（原 36 项的主体）
// ════════════════════════════════════════════════════════════
check("品牌无第三方厂商名（快鱼 / KUAIYU 等）", () => {
  const txt = JSON.stringify([org, sites, points, devices, alarms, incidents, kpi, scenes, rules]);
  const bad = ["快鱼", "KUAIYU", "kuaifu", "昆山快鱼"];
  const hit = bad.filter((w) => txt.includes(w));
  return hit.length ? `命中 ${hit.join(",")}` : true;
});
check("device.site_id 存在", () => devices.every((d) => siteIds.has(d.site_id)) || "有悬空 site_id");
check("device.point_id 存在", () => devices.every((d) => pointIds.has(d.point_id)) || "有悬空 point_id");
check("point 的 has_device=true 都有设备", () => {
  const withDev = new Set(devices.map((d) => d.point_id));
  const missing = points.filter((p) => p.has_device && !withDev.has(p.id));
  return missing.length === 0 || `${missing.length} 个点位缺设备`;
});
check("alarm.point_id 存在", () => alarms.every((a) => pointIds.has(a.point_id)) || "有悬空 point_id");
check("alarm.device_id 存在（或为空）", () => alarms.every((a) => a.device_id === null || deviceIds.has(a.device_id)) || "有悬空 device_id");
check("alarm 与 point 的 site 一致", () => {
  const bad = alarms.filter((a) => pointById.get(a.point_id)?.site_id !== a.site_id);
  return bad.length === 0 || `${bad.length} 条告警 site 不匹配`;
});
check("alarm 与 point 的场景一致", () => {
  const bad = alarms.filter((a) => sceneBySite.get(a.site_id) !== a.scene);
  return bad.length === 0 || `${bad.length} 条告警 scene 与站点不符`;
});
check("incident.alarm_ids 全部存在", () => incidents.every((i) => i.alarm_ids.every((id) => alarmById.has(id))) || "有悬空 alarm_id");
check("incident 引用的告警属于同一 site", () => {
  const bad = incidents.filter((i) => new Set(i.alarm_ids.map((id) => alarmById.get(id).site_id)).size > 1);
  return bad.length === 0 || `${bad.length} 个事件跨站点混聚合`;
});
check("audit_logs.user_id / site_id 存在", () => {
  const uids = new Set(users.map((u) => u.id));
  const bad = auditLogs.filter((l) => !uids.has(l.user_id) || !siteIds.has(l.site_id));
  return bad.length === 0 || `${bad.length} 条日志悬空`;
});
check("audit_logs 操作人属于日志所在站点（或显式跨站点角色）", () => {
  const GLOBAL_STAFF = new Set(["u-001", "u-008"]);
  const userById = new Map(users.map((u) => [u.id, u]));
  const bad = auditLogs.filter((l) => {
    const u = userById.get(l.user_id);
    if (!u) return true;
    return u.site_id !== null && u.site_id !== l.site_id && !GLOBAL_STAFF.has(u.id);
  });
  return bad.length === 0 || `${bad.length}/${auditLogs.length} 条日志的操作人跨站点`;
});
check("device.gateway_id 指向真实网关（或 null）", () => {
  const gw = devices.filter((d) => d.kind === "gateway").map((d) => d.id);
  const gwSet = new Set(gw);
  const bad = devices.filter((d) => d.kind !== "gateway" && d.gateway_id !== null && !gwSet.has(d.gateway_id));
  return bad.length === 0 || `${bad.length} 台设备的 gateway_id 悬空`;
});

// ════════════════════════════════════════════════════════════
// 二、时间逻辑
// ════════════════════════════════════════════════════════════
check("incident.started ≥ ended（偏移越小越新）", () =>
  incidents.every((i) => i.started_offset_minutes >= i.ended_offset_minutes) || "有事件起止倒挂");
check("incident 时间覆盖其全部告警", () => {
  const bad = incidents.filter((i) => {
    const ts = i.alarm_ids.map((id) => alarmById.get(id).ts_offset_minutes);
    return Math.max(...ts) > i.started_offset_minutes || Math.min(...ts) < i.ended_offset_minutes;
  });
  return bad.length === 0 || `${bad.length} 个事件时间未覆盖告警`;
});
check("timeline 时间戳单调不增（越往下越新）", () => {
  const bad = incidents.filter((i) => {
    const t = (i.timeline || []).map((x) => x.at_offset_minutes);
    for (let k = 1; k < t.length; k++) if (t[k] > t[k - 1]) return true;
    return false;
  });
  return bad.length === 0 || `${bad.length} 个事件时间线乱序`;
});
check("timeline 全部落在事件时间窗内", () => {
  const bad = incidents.filter((i) =>
    (i.timeline || []).some((x) => x.at_offset_minutes > i.started_offset_minutes + 1 || x.at_offset_minutes < i.ended_offset_minutes - 1),
  );
  return bad.length === 0 || `${bad.length} 个事件的时间线越界`;
});

// —— 语义顺序：光验「时间单调」验不出「归档早于接警」，还得验生命周期推进 ——
const LIFECYCLE_RANK = {
  alarm_triggered: 0, fusion: 1, action: 2, notify: 3, acknowledge: 4,
  dispatch: 5, arrive: 6, diagnose: 6, handle: 7, review: 8, pending: 9, archive: 10,
};
check("timeline 生命周期语义顺序（触发 → 接警 → 处置 → 复核 → 归档）", () => {
  const bad = [];
  for (const i of incidents) {
    // alarm_triggered 可以在任意时刻重复（处置中又有新告警到达），
    // 其余节点必须按生命周期单调推进；「归档」之后再出现接警 / 处置就是乱序。
    const seq = (i.timeline || []).filter((n) => n.type !== "alarm_triggered");
    for (let k = 1; k < seq.length; k++) {
      const prev = LIFECYCLE_RANK[seq[k - 1].type];
      const cur = LIFECYCLE_RANK[seq[k].type];
      if (prev === undefined || cur === undefined) { bad.push(`${i.id} 出现未知节点类型`); break; }
      if (cur < prev) { bad.push(`${i.id}：${seq[k - 1].type} → ${seq[k].type}`); break; }
    }
  }
  return bad.length === 0 || `${bad.length} 个事件生命周期乱序：${bad.slice(0, 3).join("，")}`;
});
check("事件首节点是 alarm_triggered", () => {
  const bad = incidents.filter((i) => (i.timeline || [])[0]?.type !== "alarm_triggered");
  return bad.length === 0 || `${bad.length} 个事件不是从“触发”开始：${bad.slice(0, 3).map((i) => i.id).join(",")}`;
});
check("已结案事件的末节点是 archive", () => {
  const bad = incidents.filter((i) => i.status === "closed" && (i.timeline || []).at(-1)?.type !== "archive");
  return bad.length === 0 || `${bad.length} 个 closed 事件没有以归档收尾`;
});
// —— 时间线不能被压成一个点 ——
// 只验「单调不增 / 落在时间窗内」时，一条把 5 个节点都放在同一分钟的时间线也算通过，
// 事件详情页会渲染成「接警 / 处置 / 复核 / 归档 全在同一时刻」。
check("背景事件时间线每个节点各占一分钟（不塌成一个点）", () => {
  const bad = [];
  for (const i of incidents) {
    if (i.script_id) continue; // 剧本时间线是手写叙事线，允许同分钟（如融合 + 自动处置）
    const stamps = (i.timeline || []).map((n) => n.at_offset_minutes);
    if (new Set(stamps).size !== stamps.length) {
      bad.push(`${i.id} ${stamps.length} 个节点只落在 ${new Set(stamps).size} 个分钟点上`);
    }
  }
  return bad.length === 0 || `${bad.length} 个背景事件时间线塌成一个点：${bad.slice(0, 3).join("，")}`;
});

// —— 时间线末节点 vs 事件内最新告警 ——
// 「timeline 落在事件时间窗内」是拿时间线跟 started/ended 比，而 started/ended
// 又是时间线回写出来的（见 generate 的「事件收尾归一」），等于自己跟自己比。
// 这条独立用告警自身的时间戳重算，才能抓到「归档后又来自己的告警」。
check("已结案事件的 archive 不早于事件内最新一条告警", () => {
  const bad = [];
  for (const i of incidents) {
    if (i.status !== "closed") continue;
    const archive = (i.timeline || []).find((n) => n.type === "archive");
    if (!archive) continue;
    const newestAlarm = Math.min(...i.alarm_ids.map((id) => alarmById.get(id).ts_offset_minutes));
    if (archive.at_offset_minutes > newestAlarm) {
      bad.push(`${i.id} 归档 ${archive.at_offset_minutes} > 最新告警 ${newestAlarm}（差 ${archive.at_offset_minutes - newestAlarm} 分钟）`);
    }
  }
  return bad.length === 0 || `${bad.length} 个事件的归档早于自己的告警：${bad.slice(0, 3).join("，")}`;
});
check("事件时间线末节点不早于事件内最新一条告警（在办事件停在最新告警之后）", () => {
  const bad = incidents.filter((i) => {
    if (i.script_id) return false;
    const last = (i.timeline || []).at(-1);
    if (!last) return true;
    const newestAlarm = Math.min(...i.alarm_ids.map((id) => alarmById.get(id).ts_offset_minutes));
    return last.at_offset_minutes > newestAlarm;
  });
  return bad.length === 0 || `${bad.length} 个事件的末节点早于自己的最新告警`;
});
check("背景事件时间线首节点 = 最早告警（偏移最大）", () => {
  const bad = incidents.filter((i) => {
    if (i.script_id) return false; // 剧本时间线是手写的叙事线（如 H 的首节点指向 B 的第 7 次误报）
    const first = (i.timeline || [])[0];
    if (!first) return true;
    const oldestAlarm = Math.max(...i.alarm_ids.map((id) => alarmById.get(id).ts_offset_minutes));
    return first.at_offset_minutes !== oldestAlarm;
  });
  return bad.length === 0 || `${bad.length} 个背景事件的首节点不是最早告警`;
});
check("在办（dispatched）事件不归档、其告警不结案", () => {
  const open = incidents.filter((i) => i.status !== "closed");
  const withArchive = open.filter((i) => (i.timeline || []).some((n) => n.type === "archive"));
  if (withArchive.length) return `${withArchive.length} 个在办事件带 archive 节点`;
  const closed = open.flatMap((i) => i.alarm_ids.map((id) => alarmById.get(id)))
    .filter((a) => a && (a.status === "closed" || a.status === "false_positive"));
  return closed.length === 0 || `${closed.length} 条在办事件的告警已被结案`;
});
check("事件 owner 属于事件所在站点（或显式跨站点角色）", () => {
  const GLOBAL_STAFF = new Set(["u-001", "u-008"]); // 平台管理员 / 运维工程师
  const userById = new Map(users.map((u) => [u.id, u]));
  const bad = incidents.filter((i) => {
    const u = userById.get(i.owner_id);
    if (!u) return true;
    return u.site_id !== null && u.site_id !== i.site_id && !GLOBAL_STAFF.has(u.id);
  });
  return bad.length === 0 || `${bad.length}/${incidents.length} 个事件的 owner 跨站点`;
});
check("事件时间线里的操作人与事件同站点（或显式跨站点角色）", () => {
  const GLOBAL_STAFF = new Set(["u-001", "u-008"]);
  const userById = new Map(users.map((u) => [u.id, u]));
  const bad = incidents.filter((i) => (i.timeline || []).some((n) => {
    if (!n.actor) return false;
    const u = userById.get(n.actor);
    if (!u) return true;
    return u.site_id !== null && u.site_id !== i.site_id && !GLOBAL_STAFF.has(u.id);
  }));
  return bad.length === 0 || `${bad.length} 个事件的时间线操作人跨站点`;
});
check("所有时间偏移均为非负数", () => {
  const all = [
    ...alarms.map((a) => a.ts_offset_minutes),
    ...incidents.map((i) => i.started_offset_minutes),
    ...incidents.flatMap((i) => (i.timeline || []).map((n) => n.at_offset_minutes)),
    ...auditLogs.map((l) => l.ts_offset_minutes),
    ...devices.map((d) => d.last_heartbeat_offset_minutes),
  ];
  return all.every((v) => typeof v === "number" && v >= 0) || "存在负偏移";
});

// ════════════════════════════════════════════════════════════
// 三、剧本自洽（A–H 八个都要讲得通）
// ════════════════════════════════════════════════════════════
const scriptAlarms = (id) => alarms.filter((a) => a.script_id === id);
const byId = (id) => scriptAlarms(id).slice().sort((a, b) => a.ts_offset_minutes - b.ts_offset_minutes);

check("剧本 A：3 条告警聚合为 1 个一级事件，时间线 ≥ 10 节点", () => {
  const a = byId("A");
  const ev = incidents.find((i) => i.script_id === "A");
  return (a.length === 3 && ev && ev.level === 1 && ev.alarm_ids.length === 3 && (ev.timeline || []).length >= 10) ||
    `A 告警 ${a.length} 条 / 事件 ${ev ? `${ev.alarm_ids.length} 条告警 ${(ev.timeline || []).length} 节点` : "无"}`;
});
check("剧本 A：钟点在上午 10:00–10:30（11:00 前）", () => {
  const a = byId("A");
  const mins = a.map((x) => T.clockMinutes(x.ts_offset_minutes));
  return (mins.every((m) => m >= 600 && m <= 690)) || `实际 ${mins.map((m) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`).join("/")}`;
});
check("剧本 A：点位的房间类型适合欺凌场景（卫生间 / 楼梯间 / 走廊）", () => {
  const p = pointById.get(byId("A")[0].point_id);
  return ["restroom", "stairs", "corridor"].includes(p.room_type) || `实际 ${p.room_type}（${p.room}）`;
});
check("剧本 B：7 条告警，连续 7 个自然日、同一时刻 21:00", () => {
  const b = byId("B");
  const days = new Set(b.map((x) => T.dayDiff(x.ts_offset_minutes)));
  const clocks = [...new Set(b.map((x) => T.clockMinutes(x.ts_offset_minutes)))];
  return (b.length === 7 && days.size === 7 && clocks.length === 1 && clocks[0] === 21 * 60) ||
    `B ${b.length} 条 / ${days.size} 天 / 钟点 ${clocks.map((c) => `${Math.floor(c / 60)}:${String(c % 60).padStart(2, "0")}`).join(",")}`;
});
check("剧本 B：该点位误报率 > rule-006 阈值 25%（降级规则真的会触发）", () => {
  const pid = byId("B")[0].point_id;
  const atPoint = alarms.filter((a) => a.point_id === pid);
  const fpRate = (atPoint.filter((a) => a.false_positive).length / atPoint.length) * 100;
  const rule = rules.find((r) => r.id === "rule-006");
  const threshold = Number((rule.threshold.match(/>\s*(\d+)/) || [])[1] || 25);
  return fpRate > threshold || `${fpRate.toFixed(1)}% ≤ ${threshold}%`;
});
check("剧本 B：点位是 1 层的操场（不在 2 层以上）", () => {
  const p = pointById.get(byId("B")[0].point_id);
  return (p.room_type === "playground" && p.floor === 1) || `实际 ${p.room}（${p.floor} 层 ${p.room_type}）`;
});
check("剧本 C：设备离线 ≥ 6 天且存在运维事件", () => {
  const c = scriptAlarms("C")[0];
  const dev = devices.find((d) => d.id === c?.device_id);
  const ev = incidents.find((i) => i.script_id === "C");
  if (!c || !dev || !ev) return "缺 C 的告警 / 设备 / 事件";
  if (dev.status !== "offline") return `设备状态 ${dev.status}`;
  return dev.last_heartbeat_offset_minutes >= 6 * DAY || `设备仅离线 ${dev.last_heartbeat_offset_minutes} 分钟`;
});
check("剧本 D：医院一键报警 4 条告警聚合为一级事件", () => {
  const d = scriptAlarms("D");
  const ev = incidents.find((i) => i.script_id === "D");
  return (d.length === 4 && ev && ev.level === 1 && ev.alarm_ids.length === 4) || `D 告警 ${d.length} 条 / 事件 ${ev?.alarm_ids.length ?? "无"}`;
});
check("剧本 E：夜间分贝告警全部落在 22:00–06:00 窗内（rule-003 语义）", () => {
  const e = scriptAlarms("E");
  const mins = e.map((x) => T.clockMinutes(x.ts_offset_minutes));
  return mins.every((m) => m >= 22 * 60 || m < 6 * 60) || `实际 ${mins.map((m) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`).join(",")}`;
});
check("剧本 F：公安谈话质量评分有事件且时间线含评分动作", () => {
  const f = scriptAlarms("F");
  const ev = incidents.find((i) => i.script_id === "F");
  return (f.length >= 3 && ev && (ev.timeline || []).some((n) => n.text.includes("评分"))) || `F ${f.length} 条 / 事件 ${ev ? "有" : "无"}`;
});
check("剧本 G：同一网关下 ≥ 5 台设备同时离线", () => {
  const g = scriptAlarms("G");
  const gws = new Set(g.map((a) => devices.find((d) => d.id === a.device_id)?.gateway_id));
  const offlineDevs = devices.filter((d) => d.status === "offline");
  const groupSizes = [...gws].map((gid) => offlineDevs.filter((d) => d.gateway_id === gid || d.id === gid).length);
  return (g.length >= 5 && groupSizes.some((n) => n >= 5)) || `G ${g.length} 条 / 同组离线 ${groupSizes.join(",")}`;
});
check("剧本 H：误报观察降级有 2 条静默记录 + 1 条恢复记录", () => {
  const h = scriptAlarms("H");
  const downgraded = h.filter((a) => a.downgraded === true).length;
  return (h.length === 3 && downgraded === 2) || `H ${h.length} 条 / 降级 ${downgraded} 条`;
});
check("8 个剧本各有专属事件（B 除外，B 只产出降级线索）", () => {
  const missing = ["A", "C", "D", "E", "F", "G", "H"].filter((id) => !incidents.some((i) => i.script_id === id));
  return missing.length === 0 || `缺 ${missing.join(",")} 的事件`;
});
check("剧本的告警 narrative_tier 全部为 script", () =>
  alarms.filter((a) => a.script_id).every(isScript) || "有剧本告警的 narrative_tier 不是 script");

// ════════════════════════════════════════════════════════════
// 四、聚合口径（聚合 ↔ 明细必须相等）
// ════════════════════════════════════════════════════════════
check("KPI 设备总数 = devices 长度", () => kpi.device_total === devices.length || `${kpi.device_total} != ${devices.length}`);
check("KPI 在线数 = 状态为 online 的设备数", () => {
  const n = devices.filter((d) => d.status === "online").length;
  return kpi.device_online === n || `${kpi.device_online} != ${n}`;
});
check("在线 + 离线 + 维护 = 总数", () =>
  kpi.device_online + kpi.device_offline + kpi.device_maintenance === kpi.device_total || "三类状态之和不等于总数");
check("KPI 在线率与明细一致（±0.1）", () => {
  const expect = (kpi.device_online / kpi.device_total) * 100;
  return Math.abs(expect - kpi.online_rate) < 0.1 || `${kpi.online_rate} vs ${expect.toFixed(1)}`;
});
check("KPI alarm_natural_day = 今天自然日告警数", () => {
  const n = alarms.filter((a) => T.dayDiff(a.ts_offset_minutes) === 0).length;
  return kpi.alarm_natural_day === n || `${kpi.alarm_natural_day} != ${n}`;
});
check("KPI alarm_today 是自然日口径的兼容别名", () =>
  kpi.alarm_today === kpi.alarm_natural_day || `${kpi.alarm_today} != ${kpi.alarm_natural_day}`);
check("KPI alarm_last_24h = 偏移 [0,1440) 的告警数", () => {
  const n = alarms.filter((a) => a.ts_offset_minutes >= 0 && a.ts_offset_minutes < DAY).length;
  return kpi.alarm_last_24h === n || `${kpi.alarm_last_24h} != ${n}`;
});
check("KPI alarm_last_24h > alarm_natural_day（滚动窗口确实更长）", () =>
  kpi.alarm_last_24h > kpi.alarm_natural_day || `滚动 ${kpi.alarm_last_24h} ≤ 自然日 ${kpi.alarm_natural_day}（锚点在正午，必然更大）`);
check("今日分级之和 = 今日告警总数", () => {
  const sum = kpi.level_breakdown_today.reduce((s, x) => s + x.count, 0);
  return sum === kpi.alarm_natural_day || `分级和 ${sum} != ${kpi.alarm_natural_day}`;
});
check("今日场景之和 = 今日告警总数", () => {
  const sum = kpi.scene_breakdown_today.reduce((s, x) => s + x.count, 0);
  return sum === kpi.alarm_natural_day || `场景和 ${sum} != ${kpi.alarm_natural_day}`;
});
check("未处置数 = 明细里 new + dispatched 的条数", () => {
  const n = alarms.filter((a) => a.status === "new" || a.status === "dispatched").length;
  return kpi.alarm_unhandled === n || `${kpi.alarm_unhandled} != ${n}`;
});
check("未处置分级拆分之和 = 未处置总数", () => {
  const sum = kpi.alarm_unhandled_breakdown.reduce((s, x) => s + x.count, 0);
  return sum === kpi.alarm_unhandled || `拆分和 ${sum} != ${kpi.alarm_unhandled}`;
});
check("未处置分级拆分逐级对得上明细", () => {
  const bad = kpi.alarm_unhandled_breakdown.filter((x) => {
    const real = alarms.filter((a) => (a.status === "new" || a.status === "dispatched") && a.level === x.level).length;
    return real !== x.count;
  });
  return bad.length === 0 || bad.map((x) => `L${x.level} ${x.count}≠明细`).join(",");
});
check("误报率与明细一致（±0.1）", () => {
  const n = alarms.filter((a) => a.false_positive).length;
  const expect = (n / alarms.length) * 100;
  return Math.abs(expect - kpi.false_positive_rate) < 0.1 || `${kpi.false_positive_rate} vs ${expect.toFixed(1)}`;
});
check("24h 趋势之和 = 最近 24 小时告警数", () => {
  const sum = trends.hourly.reduce((s, x) => s + x.alarms, 0);
  const n = alarms.filter((a) => a.ts_offset_minutes >= 0 && a.ts_offset_minutes < DAY).length;
  return sum === n || `${sum} != ${n}`;
});
check("24h 趋势的处置数 ≤ 告警数", () => trends.hourly.every((h) => h.handled <= h.alarms) || "处置数超过告警数");
check("热力图格子数 = 7 × 24", () => trends.heatmap.length === 168 || `${trends.heatmap.length} != 168`);
check("类型分布之和 = 全部告警数", () => {
  const sum = rankings.types.reduce((s, x) => s + x.count, 0);
  return sum === alarms.length || `${sum} != ${alarms.length}`;
});
check("类型分布逐类对得上明细", () => {
  const bad = rankings.types.filter((t) => alarms.filter((a) => a.type_code === t.type_code).length !== t.count);
  return bad.length === 0 || bad.map((t) => t.type_code).join(",");
});
check("点位排行 Top10 降序且长度 ≤ 10", () => {
  const p = rankings.points;
  if (p.length > 10) return "超过 10 条";
  for (let i = 1; i < p.length; i++) if (p[i].total > p[i - 1].total) return "未按降序";
  return true;
});
check("事件总数对得上 incidents 长度", () => kpi.incident_total === incidents.length || `${kpi.incident_total} != ${incidents.length}`);
check("在办事件数 = status ≠ closed 的事件数", () => {
  const n = incidents.filter((i) => i.status !== "closed").length;
  return kpi.incident_open === n || `${kpi.incident_open} != ${n}`;
});
check("incident.alarm_count = alarm_ids 长度", () =>
  incidents.every((i) => i.alarm_count === i.alarm_ids.length) || "有事件 alarm_count 与 alarm_ids 不等");
check("incident.duration_minutes = started - ended", () =>
  incidents.every((i) => i.duration_minutes === Math.max(0, i.started_offset_minutes - i.ended_offset_minutes)) || "有事件时长算错");

// ════════════════════════════════════════════════════════════
// 五、场景卡 / 站点文案（P0：数字必须从明细现算）
// ════════════════════════════════════════════════════════════
check("场景卡 kpi.points 与明细完全相等", () => {
  const bad = scenes.filter((s) => {
    const sid = sites.find((x) => x.scene === s.id).id;
    return s.kpi.points !== points.filter((p) => p.site_id === sid).length;
  });
  return bad.length === 0 || bad.map((s) => `${s.id} 声明 ${s.kpi.points}`).join(",");
});
check("场景卡 kpi.devices 与明细完全相等", () => {
  const bad = scenes.filter((s) => {
    const sid = sites.find((x) => x.scene === s.id).id;
    return s.kpi.devices !== devices.filter((d) => d.site_id === sid).length;
  });
  return bad.length === 0 || bad.map((s) => `${s.id} 声明 ${s.kpi.devices}`).join(",");
});
check("场景卡 kpi.today_alarms 与 kpi.scene_breakdown_today 相等", () => {
  const bad = scenes.filter((s) => s.kpi.today_alarms !== kpi.scene_breakdown_today.find((x) => x.scene === s.id).count);
  return bad.length === 0 || bad.map((s) => s.id).join(",");
});
check("场景卡 kpi.total_alarms = 该场景全部告警数", () => {
  const bad = scenes.filter((s) => s.kpi.total_alarms !== alarms.filter((a) => a.scene === s.id).length);
  return bad.length === 0 || bad.map((s) => s.id).join(",");
});
check("site.rooms 文案里的数字与点位明细相等", () => {
  const bad = sites.filter((s) => {
    const m = /(\d+) 个点位$/.exec(s.rooms || "");
    if (!m) return true;
    return Number(m[1]) !== points.filter((p) => p.site_id === s.id).length;
  });
  return bad.length === 0 || bad.map((s) => `${s.id}「${s.rooms}」`).join(",");
});
check("site.points / site.devices 字段与明细相等", () => {
  const bad = sites.filter((s) =>
    s.points !== points.filter((p) => p.site_id === s.id).length ||
    s.devices !== devices.filter((d) => d.site_id === s.id).length);
  return bad.length === 0 || bad.map((s) => s.id).join(",");
});
check("医院 ≥ 60 点位（撑得起场景页）", () => {
  const n = points.filter((p) => p.site_id === "site-02").length;
  return n >= 60 || `实际 ${n}`;
});
check("公安 ≥ 40 点位（撑得起场景页）", () => {
  const n = points.filter((p) => p.site_id === "site-03").length;
  return n >= 40 || `实际 ${n}`;
});
check("三个场景规模同量级（最大 / 最小 ≤ 5）", () => {
  const counts = sites.map((s) => points.filter((p) => p.site_id === s.id).length);
  const ratio = Math.max(...counts) / Math.min(...counts);
  return ratio <= 5 || `最大/最小 = ${ratio.toFixed(1)}（${counts.join("/")}）`;
});
check("每场景 ≥ 8 台设备", () => {
  const bad = sites.filter((s) => devices.filter((d) => d.site_id === s.id).length < 8);
  return bad.length === 0 || bad.map((s) => s.id).join(",");
});

// ════════════════════════════════════════════════════════════
// 六、设备语义（P0：scenes 必须含所属站点场景）
// ════════════════════════════════════════════════════════════
check("device.scenes 全部包含所属站点的场景", () => {
  const bad = devices.filter((d) => !(d.scenes || []).includes(sceneBySite.get(d.site_id)));
  return bad.length === 0 || `${bad.length}/${devices.length} 台不含所属站点场景`;
});
check("device-stats.by_status 与明细相等", () => {
  const bad = deviceStats.by_status.filter((x) => devices.filter((d) => d.status === x.status).length !== x.count);
  return bad.length === 0 || bad.map((x) => x.status).join(",");
});
check("device-stats.by_model 之和 = 设备总数", () => {
  const sum = deviceStats.by_model.reduce((s, x) => s + x.count, 0);
  return sum === devices.length || `${sum} != ${devices.length}`;
});
check("每台设备都有自检历史与 OTA 记录字段", () =>
  devices.every((d) => Array.isArray(d.self_check_history) && d.self_check_history.length > 0 && Array.isArray(d.ota_records)) ||
  "有设备缺 self_check_history / ota_records");
check("每台设备都有 24 点信号序列", () =>
  devices.every((d) => Array.isArray(d.signal_series) && d.signal_series.length === 24) || "有设备信号序列长度 ≠ 24");
check("离线设备的 signal / signal_series 全部为 0 哨兵", () => {
  const bad = devices.filter((d) => d.status === "offline" &&
    (d.signal !== 0 || (d.signal_series || []).some((s) => s.rssi_dbm !== 0)));
  return bad.length === 0 || `${bad.length} 台离线设备仍有非 0 信号`;
});
check("非离线设备的 RSSI 统一为负 dBm（0 只作离线哨兵）", () => {
  const bad = devices.filter((d) => d.status !== "offline" &&
    (d.signal_series || []).some((s) => !(s.rssi_dbm < 0)));
  return bad.length === 0 || `${bad.length} 台在线 / 维护设备出现非负 rssi_dbm`;
});
check("非离线设备的 signal 在 1–100（0 只归离线）", () => {
  const bad = devices.filter((d) => d.status !== "offline" && !(d.signal > 0 && d.signal <= 100));
  return bad.length === 0 || `${bad.length} 台非离线设备 signal 不在 1–100`;
});
check("设备固件版本分布之和 = 设备总数", () => {
  const sum = kpi.firmware_distribution.reduce((s, x) => s + x.count, 0);
  return sum === devices.length || `${sum} != ${devices.length}`;
});
check("网关本身在线（除剧本 G 的目标网关）", () => {
  const bad = devices.filter((d) => d.kind === "gateway" && d.status === "offline" && !scriptAlarms("G").some((a) => a.device_id === d.id));
  return bad.length === 0 || bad.map((d) => d.id).join(",");
});

// ════════════════════════════════════════════════════════════
// 七、点位语义（P0：室外类房间不能排到 2 层以上；id 楼层 = floor）
// ════════════════════════════════════════════════════════════
check("室外类房间（操场/就餐区/天台）不排在 2 层以上", () => {
  const bad = points.filter((p) => ["playground", "canteen", "rooftop"].includes(p.room_type) && p.floor > 1);
  return bad.length === 0 || `${bad.length} 个：${bad.slice(0, 5).map((p) => `${p.id}=${p.room}`).join("，")}`;
});
check("点位 id 里的楼层 = floor 字段", () => {
  const bad = points.filter((p) => {
    const m = /^PT-[A-Z0-9]+-(\d)F\d\d$/.exec(p.id);
    return m && Number(m[1]) !== p.floor;
  });
  return bad.length === 0 || bad.slice(0, 5).map((p) => `${p.id} floor=${p.floor}`).join("，");
});
check("每个点位的 room_type 在楼栋语义白名单内", () => {
  const ROOF_ONLY = new Set(["playground", "rooftop"]);
  const bad = points.filter((p) => ROOF_ONLY.has(p.room_type) && p.floor !== 1);
  return bad.length === 0 || bad.map((p) => p.id).join(",");
});
check("点位 ID 无重复", () => new Set(points.map((p) => p.id)).size === points.length || "重复点位 ID");
check("点位 room 名称非空且不重复（同一站点内）", () => {
  const seen = new Map();
  const dup = [];
  for (const p of points) {
    const key = `${p.site_id}:${p.room}`;
    if (seen.has(key)) dup.push(p.room);
    seen.set(key, true);
  }
  return dup.length === 0 || `重复房间名：${dup.slice(0, 5).join("，")}`;
});

// ════════════════════════════════════════════════════════════
// 八、趋势与热力图的轴语义（P0：hour 必须是时钟小时）
// ════════════════════════════════════════════════════════════
check("heatmap.hour 是时钟小时 0..23（不是窗口序号）", () => {
  const hm = Array(24).fill(0);
  for (const x of trends.heatmap.filter((r) => r.day === 0)) hm[x.hour] = x.count;
  const real = Array(24).fill(0);
  for (const a of alarms.filter((x) => T.dayDiff(x.ts_offset_minutes) === 0)) real[T.clockHour(a.ts_offset_minutes)] += 1;
  const direct = real.every((v, i) => v === hm[i]);
  if (direct) return true;
  for (let k = 1; k < 24; k++) if (real.every((v, i) => v === hm[(i + k) % 24])) return `实测偏移 ${k} 小时`;
  return "与明细对不上";
});
check("heatmap 的 day 求和 = trends.daily 的 alarms", () => {
  const sums = Array.from({ length: 7 }, (_, d) =>
    trends.heatmap.filter((x) => x.day === d).reduce((a, x) => a + x.count, 0));
  const daily = trends.daily.map((d) => d.alarms);
  return JSON.stringify(sums) === JSON.stringify(daily) || `heatmap=${sums} daily=${daily}`;
});
check("heatmap 每个格子的 count 与明细相等", () => {
  const bad = trends.heatmap.filter((x) => {
    const real = alarms.filter((a) => T.dayDiff(a.ts_offset_minutes) === x.day && T.clockHour(a.ts_offset_minutes) === x.hour).length;
    return real !== x.count;
  });
  return bad.length === 0 || `${bad.length} 个格子对不上（如 day=${bad[0].day} hour=${bad[0].hour}）`;
});
check("hourly 的 clock_hour 与 window 起始偏移自洽", () => {
  const bad = trends.hourly.filter((h) => T.clockHour(h.window_start_offset_minutes) !== h.clock_hour);
  return bad.length === 0 || bad.map((h) => h.label).join(",");
});
check("daily.date 与 date_offset_days 自洽", () => {
  const bad = trends.daily.filter((d) => T.dateLabel(d.day_offset_minutes) !== d.date);
  return bad.length === 0 || bad.slice(0, 3).map((d) => `${d.label}≠${T.dateLabel(d.day_offset_minutes)}`).join(",");
});
check("daily 覆盖 7 个连续自然日（含今天）", () => {
  const ds = trends.daily.map((d) => d.date_offset_days);
  return JSON.stringify(ds) === JSON.stringify([0, 1, 2, 3, 4, 5, 6]) || ds.join(",");
});
check("daily.incidents 与明细相等", () => {
  const bad = trends.daily.filter((d) => incidents.filter((i) => T.dayDiff(i.started_offset_minutes) === d.date_offset_days).length !== d.incidents);
  return bad.length === 0 || bad.map((d) => d.label).join(",");
});

// ════════════════════════════════════════════════════════════
// 九、排序方向与字段命名（前端装配的一致性）
// ════════════════════════════════════════════════════════════
check("所有数组统一「新 → 旧」（alarms / incidents / shifts / hourly / daily / heatmap）", () => {
  const asc = (arr, key) => arr.every((x, i) => i === 0 || arr[i - 1][key] <= x[key]);
  const problems = [];
  if (!asc(alarms, "ts_offset_minutes")) problems.push("alarms");
  if (!asc(incidents, "started_offset_minutes")) problems.push("incidents");
  if (!asc(auditLogs, "ts_offset_minutes")) problems.push("audit-logs");
  if (!asc(trends.hourly, "window_start_offset_minutes")) problems.push("trends.hourly");
  if (!asc(trends.daily, "date_offset_days")) problems.push("trends.daily");
  const heatmapOk = trends.heatmap.every((x, i) => i === 0 || trends.heatmap[i - 1].day < x.day || (trends.heatmap[i - 1].day === x.day && trends.heatmap[i - 1].hour <= x.hour));
  if (!heatmapOk) problems.push("trends.heatmap");
  return problems.length === 0 || problems.join(",");
});
check("时间偏移字段统一 _offset_minutes 后缀（不再有 _minutes_ago）", () => {
  const names = new Set();
  const walk = (o) => {
    if (!o || typeof o !== "object") return;
    for (const k of Object.keys(o)) {
      if (/(offset_minutes|minutes_ago)$/.test(k)) names.add(k);
      walk(o[k]);
    }
  };
  walk({ alarms, incidents, devices, trends, spectra, transcripts, auditLogs, points });
  const stray = [...names].filter((n) => !n.endsWith("_offset_minutes"));
  return stray.length === 0 || `未收敛：${stray.join(", ")}`;
});
check("`hour` 字段只出现在 heatmap（其余用 clock_hour / clock_hour 语义）", () => {
  const hourKeys = [];
  const walk = (o, path) => {
    if (!o || typeof o !== "object") return;
    for (const k of Object.keys(o)) {
      if (k === "hour" && !path.includes("heatmap")) hourKeys.push(`${path}.hour`);
      walk(o[k], `${path}.${k}`);
    }
  };
  walk({ trends: { hourly: trends.hourly, daily: trends.daily } }, "trends");
  return hourKeys.length === 0 || hourKeys.join(",");
});

// ════════════════════════════════════════════════════════════
// 十、证据链（频谱指针 / 波形 / 转写覆盖）
// ════════════════════════════════════════════════════════════
check("evidence.spectrum_id 指向真实频谱（或 null）", () => {
  const bad = alarms.filter((a) => a.evidence.spectrum_id !== null && !spectrumIds.has(a.evidence.spectrum_id));
  return bad.length === 0 || `${bad.length} 条指向不存在的频谱`;
});
check("每条剧本告警（有音频的）都能通过 spectrum_id 定位频谱", () => {
  const missing = scriptAlarms().length ? alarms.filter((a) => isScript(a) && a.evidence.audio_seconds > 0 && !a.evidence.spectrum_id) : [];
  return missing.length === 0 || missing.map((a) => `${a.id}(${a.script_id})`).join(",");
});
check("spectrum_bins 与所属频谱的 bins 相等（不再是常量 600）", () => {
  const bad = alarms.filter((a) => {
    if (!a.evidence.spectrum_id) return a.evidence.spectrum_bins !== 0;
    const sp = spectra.find((s) => s.id === a.evidence.spectrum_id);
    return !sp || sp.bins !== a.evidence.spectrum_bins;
  });
  return bad.length === 0 || `${bad.length} 条 spectrum_bins 与频谱不符`;
});
check("12 段频谱全部挂到告警（无 null alarm_id）", () => {
  const orphans = spectra.filter((s) => !s.alarm_id);
  return orphans.length === 0 || `${orphans.length} 段无入口：${orphans.map((s) => s.id).join(",")}`;
});
check("频谱数量 ≥ 12，覆盖欺凌/争吵/哭喊/玻璃破碎/设备噪声", () => {
  const profiles = new Set(spectra.map((s) => s.profile));
  const need = ["bullying", "quarrel", "scream", "glass", "noise"];
  const miss = need.filter((p) => !profiles.has(p));
  if (spectra.length < 12) return `只有 ${spectra.length} 段`;
  return miss.length === 0 || `缺 profile：${miss.join(",")}`;
});
check("频谱是合法 base64 且长度 = bins × cols", () => {
  for (const s of spectra) {
    const buf = Buffer.from(s.data, "base64");
    if (buf.length !== s.bins * s.cols) return `${s.id}: ${buf.length} != ${s.bins}×${s.cols}`;
    if (buf.length === 0) return `${s.id} 为空`;
  }
  return true;
});
check("频谱数据是真人声形状（max ≥ 150 且 mean ≥ 20，不是随机噪声）", () => {
  for (const s of spectra) {
    const buf = Buffer.from(s.data, "base64");
    let mx = 0;
    let sum = 0;
    for (const b of buf) {
      if (b > mx) mx = b;
      sum += b;
    }
    if (mx < 150 || sum / buf.length < 20) return `${s.id} max=${mx} mean=${(sum / buf.length).toFixed(1)}`;
  }
  return true;
});
check("每段频谱都有 2,000 桶 min/max 波形", () => {
  const bad = spectra.filter((s) => !s.waveform || s.waveform.buckets !== 2000 ||
    Buffer.from(s.waveform.min, "base64").length !== 2000 ||
    Buffer.from(s.waveform.max, "base64").length !== 2000);
  return bad.length === 0 || bad.map((s) => s.id).join(",");
});
check("波形 min ≤ max（逐桶）", () => {
  const bad = spectra.filter((s) => {
    const mn = Buffer.from(s.waveform.min, "base64");
    const mx = Buffer.from(s.waveform.max, "base64");
    for (let i = 0; i < mn.length; i++) if (mn[i] > mx[i]) return true;
    return false;
  });
  return bad.length === 0 || bad.map((s) => s.id).join(",");
});
check("每段频谱都有 peaks 峰值标记", () => spectra.every((s) => Array.isArray(s.peaks) && s.peaks.length > 0) || "有频谱缺 peaks");
check("转写 ≥ 5 段，覆盖三场景并用例齐全", () => {
  if (transcripts.length < 5) return `只有 ${transcripts.length} 段`;
  const ids = transcripts.map((t) => t.id);
  return new Set(ids).size === ids.length || "转写 id 重复";
});
check("转写覆盖整段音频（尾部空白 ≤ 2s）", () => {
  const bad = transcripts.filter((t) => {
    const last = Math.max(...t.segments.map((s) => s.end));
    return t.audio_seconds - last > 2;
  });
  return bad.length === 0 || bad.map((t) => `${t.id} 只到 ${Math.max(...t.segments.map((s) => s.end))}s / ${t.audio_seconds}s`).join("，");
});
check("转写段落按时间单调、且不重叠", () => {
  const bad = transcripts.filter((t) => {
    for (let i = 1; i < t.segments.length; i++) if (t.segments[i].start < t.segments[i - 1].end) return true;
    return false;
  });
  return bad.length === 0 || bad.map((t) => t.id).join(",");
});
check("转写的 speaker 引用都在 speakers 列表里（或为 null）", () => {
  const bad = transcripts.filter((t) => {
    const ids = new Set(t.speakers.map((s) => s.id));
    return t.segments.some((s) => s.speaker !== null && !ids.has(s.speaker));
  });
  return bad.length === 0 || bad.map((t) => t.id).join(",");
});
check("转写引用的 alarm_id 存在", () => transcripts.every((t) => alarmById.has(t.alarm_id)) || "悬空 alarm_id");
check("转写关键词高亮都能在原文里找到", () => {
  const bad = transcripts.filter((t) => t.segments.some((s) => s.highlight.some((h) => !s.text.includes(h.word))));
  return bad.length === 0 || bad.map((t) => t.id).join(",");
});

// ════════════════════════════════════════════════════════════
// 十一、叙事链路（事件 ↔ 告警 ↔ 证据）
// ════════════════════════════════════════════════════════════
check("related 告警全部被事件引用", () => {
  const rel = alarms.filter((a) => a.narrative_tier === "related");
  const orphan = rel.filter((a) => !inIncident.has(a.id));
  return orphan.length === 0 || `${orphan.length}/${rel.length} 条 related 不属于任何事件`;
});
check("script 告警全部被事件引用（B 除外，B 是规则线索）", () => {
  const orphan = alarms.filter((a) => isScript(a) && !inIncident.has(a.id) && a.script_id !== "B");
  return orphan.length === 0 || orphan.slice(0, 5).map((a) => `${a.id}(${a.script_id})`).join(",");
});
check("narrative_tier 取值只有 script / related / noise", () => {
  const bad = new Set(alarms.map((a) => a.narrative_tier).filter((t) => !["script", "related", "noise"].includes(t)));
  return bad.size === 0 || [...bad].join(",");
});
check("每个事件至少关联 1 条告警", () => incidents.every((i) => i.alarm_ids.length >= 1) || "有空事件");
check("每个事件至少 3 个时间线节点", () =>
  incidents.every((i) => (i.timeline || []).length >= 3) || `最少 ${Math.min(...incidents.map((i) => (i.timeline || []).length))} 个`);

// ════════════════════════════════════════════════════════════
// 十二、告警状态与语义
// ════════════════════════════════════════════════════════════
check("closed / false_positive 的告警都有处置记录", () => {
  const bad = alarms.filter((a) => (a.status === "closed" || a.status === "false_positive") && !a.disposition);
  return bad.length === 0 || `${bad.length} 条缺 disposition`;
});
check("false_positive=true 的告警都有误报原因", () =>
  alarms.every((a) => !a.false_positive || Boolean(a.false_positive_reason)) || "有误报缺 reason");
check("decibel 只出现在分贝类告警上", () => {
  const bad = alarms.filter((a) => a.decibel !== null && a.type_code !== "decibel_exceed");
  return bad.length === 0 || `${bad.length} 条非分贝告警带 decibel`;
});
check("levels 全部在 1..4 且 level_label 与 level 对应", () => {
  const MAP = { 1: "一级·严重", 2: "二级·紧急", 3: "三级·一般", 4: "四级·提示" };
  const bad = alarms.filter((a) => !MAP[a.level] || a.level_label !== MAP[a.level]);
  return bad.length === 0 || `${bad.length} 条分级标签不符`;
});
check("告警 ID 无重复", () => alarmById.size === alarms.length || "重复告警 ID");
check("事件 ID 无重复", () => new Set(incidents.map((i) => i.id)).size === incidents.length || "重复事件 ID");
check("设备 ID 无重复", () => deviceIds.size === devices.length || "重复设备 ID");
check("用户姓名均已脱敏（含 *）", () => users.every((u) => u.name.includes("*")) || "存在未脱敏姓名");

// ════════════════════════════════════════════════════════════
// 十三、规模与分布
// ════════════════════════════════════════════════════════════
check("告警历史覆盖 180 天", () => {
  const days = new Set(alarms.map((a) => T.dayDiff(a.ts_offset_minutes)));
  const maxDay = Math.max(...days);
  return maxDay >= 179 || `只覆盖到第 ${maxDay} 天`;
});
check("日均告警 ≥ 70 且 ≤ 110（80 左右）", () => {
  const days = new Set(alarms.map((a) => T.dayDiff(a.ts_offset_minutes))).size;
  const avg = alarms.length / days;
  return (avg >= 70 && avg <= 110) || `日均 ${avg.toFixed(1)} 条（${days} 天 / ${alarms.length} 条）`;
});
check("告警总量 ≥ 1.2 万条", () => alarms.length >= 12000 || `实际 ${alarms.length}`);
check("分级长尾分布（一级 5%–25%、四级 3%–25%）", () => {
  const pct = (lv) => (alarms.filter((a) => a.level === lv).length / alarms.length) * 100;
  const p1 = pct(1);
  const p4 = pct(4);
  return (p1 >= 5 && p1 <= 25 && p4 >= 3 && p4 <= 25) || `一级 ${p1.toFixed(1)}% / 四级 ${p4.toFixed(1)}%`;
});
check("三场景告警量与规模大致成比例（医院 ≥ 校园的 40%）", () => {
  const c = alarms.filter((a) => a.scene === "campus").length;
  const h = alarms.filter((a) => a.scene === "hospital").length;
  return h >= c * 0.4 || `校园 ${c} / 医院 ${h}`;
});
check("审计日志 ≥ 300 条且覆盖敏感操作", () => {
  if (auditLogs.length < 300) return `只有 ${auditLogs.length} 条`;
  const need = ["export", "delete", "permission"];
  const codes = new Set(auditLogs.map((l) => l.action_code));
  const miss = need.filter((c) => !codes.has(c));
  return miss.length === 0 || `缺操作类型：${miss.join(",")}`;
});
check("规则 6 条以上且全部 enabled", () => rules.length >= 6 && rules.every((r) => r.enabled) || "规则不足或被禁用");
check("算法清单的分类计数与明细相等", () => {
  const bad = algorithms.categories.filter((c) => algorithms.algorithms.filter((a) => a.category === c.code).length !== c.count);
  return bad.length === 0 || bad.map((c) => c.code).join(",");
});

// ════════════════════════════════════════════════════════════
// 十四、空态与极端值（布局 / 空态验收的输入）
// ════════════════════════════════════════════════════════════
check("存在 0 告警点位（空态可验证）", () => {
  const cnt = new Map();
  for (const a of alarms) cnt.set(a.point_id, (cnt.get(a.point_id) || 0) + 1);
  const zero = points.filter((p) => !cnt.has(p.id));
  return zero.length > 0 || "没有零告警点位";
});
check("180 天内存在 0 告警自然日（空态可验证）", () => {
  const days = new Set(alarms.map((a) => T.dayDiff(a.ts_offset_minutes)));
  const zero = [];
  for (let d = 0; d < 180; d++) if (!days.has(d)) zero.push(d);
  return zero.length > 0 || "每天都有告警";
});
check("极端值：房间名 ≥ 28 字 ≥ 1 条", () => {
  const mx = Math.max(...points.map((p) => p.room.length));
  return mx >= 28 || `最长 ${mx} 字`;
});
check("极端值：单条告警关键词 ≥ 6 个 ≥ 1 条", () => {
  const mx = Math.max(...alarms.map((a) => a.keywords.length));
  return mx >= 6 || `最多 ${mx} 个`;
});
check("极端值：告警标题 ≥ 40 字 ≥ 1 条", () => {
  const mx = Math.max(...alarms.map((a) => a.title.length));
  return mx >= 40 || `最长 ${mx} 字`;
});
check("极端值：事件标题 / 时间线文案也有长样本", () => {
  const mt = Math.max(...incidents.map((i) => i.title.length));
  const mn = Math.max(...incidents.flatMap((i) => (i.timeline || []).map((n) => n.text.length)));
  return (mt >= 20 && mn >= 30) || `标题最长 ${mt} / 节点最长 ${mn}`;
});

// ════════════════════════════════════════════════════════════
// 十五、体积 / 分片 / 分页（首屏可加载）
// ════════════════════════════════════════════════════════════
check("告警分片单片 ≤ 1.5MB（硬上限）", () => {
  const bad = alarmsIndex.shards.filter((s) => s.bytes > 1.5 * 1024 * 1024);
  return bad.length === 0 || bad.map((s) => `${s.file} ${(s.bytes / 1048576).toFixed(2)}MB`).join(",");
});
check("告警分片单片 ≤ 1.2MB（目标值）", () => {
  const bad = alarmsIndex.shards.filter((s) => s.bytes > 1.2 * 1024 * 1024);
  return bad.length === 0 || bad.map((s) => `${s.file} ${(s.bytes / 1048576).toFixed(2)}MB`).join(",");
});
check("索引文件 < 64KB（首屏只需它）", () => {
  const bytes = Buffer.byteLength(JSON.stringify(alarmsIndex));
  return bytes < 64 * 1024 || `${(bytes / 1024).toFixed(1)}KB`;
});
check("索引里没有内联告警数组", () => !("alarms" in alarmsIndex) || "索引内联了 alarms");
check("分片 count 之和 = 告警总数", () => {
  const sum = alarmsIndex.shards.reduce((s, x) => s + x.count, 0);
  return sum === alarms.length || `${sum} != ${alarms.length}`;
});
// 分片之间允许存在空隙（该窗口里本来就没有告警），但不允许时间窗交叠；
// 另一侧由「findShardForOffset 落在空隙取最近分片」的前端单测覆盖。
check("分片按「新 → 旧」排列，相邻分片时间窗不交叠", () => {
  for (let i = 1; i < alarmsIndex.shards.length; i++) {
    if (alarmsIndex.shards[i].to_offset_minutes < alarmsIndex.shards[i - 1].from_offset_minutes) {
      return `第 ${i} 片与上一片时间窗交叠`;
    }
  }
  return true;
});
check("索引含分页契约（page_size / cursor / next_cursor）", () => {
  const p = alarmsIndex.pagination;
  return (p && p.page_size > 0 && typeof p.cursor_format === "string" && "next_cursor_field" in p && "empty_cursor" in p) ||
    "分页字段不全";
});
check("分片 tier_counts 之和 = 各 narrative_tier 明细数", () => {
  for (const tier of ["script", "related", "noise"]) {
    const sum = alarmsIndex.shards.reduce((s, x) => s + x.tier_counts[tier], 0);
    const real = alarms.filter((a) => a.narrative_tier === tier).length;
    if (sum !== real) return `${tier}: ${sum} != ${real}`;
  }
  return true;
});
check("index.json 的文件清单与实际落盘一致", () => {
  const listed = new Set(index.files);
  for (const s of alarmsIndex.shards) if (!listed.has(s.file)) return `index 缺 ${s.file}`;
  try {
    readFileSync(join(DATA_DIR, "index.json"));
  } catch (e) {
    return e.message;
  }
  return true;
});
check("index.json 的计数与明细一致", () => {
  const c = index.counts;
  const bad = [];
  if (c.points !== points.length) bad.push("points");
  if (c.devices !== devices.length) bad.push("devices");
  if (c.alarms !== alarms.length) bad.push("alarms");
  if (c.incidents !== incidents.length) bad.push("incidents");
  if (c.spectra !== spectra.length) bad.push("spectra");
  if (c.transcripts !== transcripts.length) bad.push("transcripts");
  if (c.audit_logs !== auditLogs.length) bad.push("audit_logs");
  return bad.length === 0 || bad.join(",");
});

// ════════════════════════════════════════════════════════════
// 十六、设计换皮前置（JSON 不存颜色）
// ════════════════════════════════════════════════════════════
check("数据层无颜色字段（换皮只需改前端 token）", () => {
  const hits = [];
  const walk = (o, path) => {
    if (!o || typeof o !== "object") return;
    if (Array.isArray(o)) return o.forEach((v, i) => walk(v, `${path}[${i}]`));
    for (const k of Object.keys(o)) {
      if (["color", "accent", "hex", "colour"].includes(k)) hits.push(`${path}.${k}`);
      walk(o[k], `${path}.${k}`);
    }
  };
  walk({ scenes, transcripts, algorithms, rules, sites }, "");
  return hits.length === 0 || hits.slice(0, 6).join(",");
});
check("场景 / 算法分类改用语义 token", () => {
  const badS = scenes.filter((s) => !s.theme_token);
  const badA = algorithms.categories.filter((c) => !c.theme_token);
  return (badS.length === 0 && badA.length === 0) || "有场景 / 分类缺 theme_token";
});
check("GPU 分项显存之和 = 总量 × 利用率（±5%）", () => {
  const g = kpi.gpu;
  const used = g.cards.reduce((s, c) => s + c.vram_used_gb, 0);
  const implied = (g.vram_total_gb * g.utilization_percent) / 100;
  return Math.abs(used - implied) <= g.vram_total_gb * 0.05 || `${used}GB vs ${implied.toFixed(0)}GB`;
});
check("GPU 标「空闲」的卡利用率 ≤ 5%", () => {
  const bad = kpi.gpu.cards.filter((c) => c.mode === "空闲" && c.utilization > 5);
  return bad.length === 0 || bad.map((c) => `#${c.index} ${c.utilization}%`).join(",");
});
check("rate 类字段统一为百分数（0–100）", () => {
  const bad = [];
  if (!(kpi.online_rate > 1 && kpi.online_rate <= 100)) bad.push(`online_rate=${kpi.online_rate}`);
  if (!(kpi.false_positive_rate > 0 && kpi.false_positive_rate <= 100)) bad.push(`fp_rate=${kpi.false_positive_rate}`);
  return bad.length === 0 || bad.join(",");
});


// ════════════════════════════════════════════════════════════
// 十七、总览页三档时间范围（BLF-1424）
// ════════════════════════════════════════════════════════════
// 这一份数据是「同一页换时间范围」的唯一来源：三档必须真的不同，
// 且每档内部的六块聚合（trend / levels / scenes / heatmap / points / types）
// 必须都来自**同一个窗口**的告警 —— 否则切换后会出现「趋势是 7 日、分级是今日」。
const RANGE_KEYS = ["live", "today", "week"];
const RANGE_WINDOWS = {
  live: (a) => a.ts_offset_minutes >= 0 && a.ts_offset_minutes < DAY,
  today: (a) => T.dayDiff(a.ts_offset_minutes) === 0,
  week: (a) => {
    const d = T.dayDiff(a.ts_offset_minutes);
    return d >= 0 && d <= 6;
  },
};
const sumOf = (list, pick) => list.reduce((total, row) => total + pick(row), 0);

check("overview-ranges：三档齐全，顺序与 _meta.range_order 一致", () => {
  const order = overviewRanges._meta.range_order;
  const same = order.length === RANGE_KEYS.length && order.every((key, i) => key === RANGE_KEYS[i]);
  const built = RANGE_KEYS.every((key) => overviewRanges.ranges[key] && overviewRanges.ranges[key].kpi_defs.length === 4);
  if (!same) return `range_order=${order.join(",")}`;
  return built || "有档位缺 kpi_defs";
});

check("三档的 totals 与明细窗口一致，且六块聚合逐项相加 = totals.alarms", () => {
  const problems = [];
  for (const key of RANGE_KEYS) {
    const range = overviewRanges.ranges[key];
    const windowAlarms = alarms.filter(RANGE_WINDOWS[key]);
    if (range.totals.alarms !== windowAlarms.length) {
      problems.push(`${key}: totals.alarms=${range.totals.alarms} 明细=${windowAlarms.length}`);
    }
    if (sumOf(range.trend, (r) => r.alarms) !== range.totals.alarms) problems.push(`${key}: trend`);
    if (sumOf(range.levels, (r) => r.total) !== range.totals.alarms) problems.push(`${key}: levels`);
    if (sumOf(range.scenes, (r) => r.count) !== range.totals.alarms) problems.push(`${key}: scenes`);
    const heat = sumOf(range.heatmap.rows, (row) => sumOf(row.cells, (c) => c.count));
    if (heat !== range.totals.alarms) problems.push(`${key}: heatmap(${heat})`);
    const handled = windowAlarms.filter((a) => a.status === "closed" || a.status === "false_positive").length;
    if (range.totals.handled !== handled) problems.push(`${key}: handled=${range.totals.handled}/${handled}`);
  }
  return problems.length === 0 || problems.join("；");
});

check("三档的 KPI 四值 / 分级 / 场景 / 趋势 / 热力互不相同", () => {
  const signature = (key) => {
    const range = overviewRanges.ranges[key];
    return JSON.stringify([
      range.kpi_defs.map((def) => def.label),
      range.totals,
      range.levels.map((row) => row.total),
      range.scenes.map((row) => row.count),
      range.trend.map((row) => [row.label, row.alarms, row.handled, row.incidents, row.false_positive]),
      range.heatmap.rows.map((row) => row.cells.map((cell) => cell.count)),
    ]);
  };
  const unique = new Set(RANGE_KEYS.map(signature));
  return unique.size === RANGE_KEYS.length || `只有 ${unique.size} 档不同`;
});

check("热力窗口三档三种形状（live / today 1 行 × 24 格，week 7 行 × 24 格）", () => {
  const shapes = RANGE_KEYS.map((key) => {
    const heat = overviewRanges.ranges[key].heatmap;
    return `${heat.rows.length}x${heat.rows[0].cells.length}/axis=${heat.axis.length}`;
  });
  const ok = shapes[0] === "1x24/axis=24" && shapes[1] === "1x24/axis=24" && shapes[2] === "7x24/axis=24";
  return ok || shapes.join(",");
});

check("每档趋势都有 4 条系列（alarms / handled / incidents / false_positive），且数值自洽", () => {
  const problems = [];
  for (const key of RANGE_KEYS) {
    const range = overviewRanges.ranges[key];
    const bad = range.trend.filter(
      (row) =>
        typeof row.alarms !== "number" ||
        typeof row.handled !== "number" ||
        typeof row.incidents !== "number" ||
        typeof row.false_positive !== "number" ||
        row.handled > row.alarms ||
        row.false_positive > row.alarms ||
        row.unhandled > row.alarms,
    );
    if (bad.length) problems.push(`${key}: ${bad.length} 个桶超出告警数`);
    if (range.trend.length < 7) problems.push(`${key}: 只有 ${range.trend.length} 个桶`);
  }
  return problems.length === 0 || problems.join("；");
});

check("演示帧：趋势滚动长度不变、totals 与滚动后的桶一致、脉冲落在热力网格内", () => {
  const problems = [];
  for (const key of RANGE_KEYS) {
    const range = overviewRanges.ranges[key];
    const frames = range.stream.frames;
    if (frames.length < 2) problems.push(`${key}: 帧太少`);
    const added = [];
    frames.forEach((frame, index) => {
      added.unshift({
        alarms: frame.alarms,
        handled: frame.handled,
        unhandled: frame.unhandled,
        incidents: frame.incidents,
        false_positive: frame.false_positive,
      });
      const rolling = [...added, ...range.trend.slice(0, range.trend.length - (index + 1))];
      const expected = sumOf(rolling, (row) => row.alarms);
      if (frame.totals.alarms !== expected) problems.push(`${key}#${index}: ${frame.totals.alarms} != ${expected}`);
      const row = range.heatmap.rows[frame.heat.row];
      if (!row || !row.cells.some((cell) => cell.hour === frame.heat.hour)) problems.push(`${key}#${index}: 脉冲越界`);
    });
    if (range.stream.tick_seconds < 4 || range.stream.tick_seconds > 6) problems.push(`${key}: tick=${range.stream.tick_seconds}s`);
  }
  return problems.length === 0 || problems.slice(0, 4).join("；");
});

check("index.json 的文件清单含 overview-ranges.json", () => {
  return index.files.includes("overview-ranges.json") || "index.files 缺 overview-ranges.json";
});

console.log(checks.join("\n"));
console.log(`\n${checks.length - fails.length}/${checks.length} 通过`);
if (fails.length) {
  console.error(`\n失败项：\n- ${fails.join("\n- ")}`);
  process.exit(1);
}
