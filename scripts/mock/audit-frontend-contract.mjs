#!/usr/bin/env node
// ============================================================
// audit-frontend-contract.mjs
// 「前端可消费性」审计 —— validate.mjs 的补充，不是替代。
//
// validate.mjs 校验的是「聚合对聚合」（今天总数 = 分级之和）。
// 本脚本校验的是它没覆盖的两类问题：
//   A. 聚合对明细（声明的数量能不能被明细枚举出来）
//   B. 语义对语义（值域、单位、轴线含义、跨文件外键、加载体积）
//
// 用法：node scripts/mock/audit-frontend-contract.mjs
// 退出码：0 = 无 P0；1 = 有 P0（会直接做出错界面）
//
// 分级：
//   P0 阻塞   —— 数字对不上 / 故事断链 / 轴线错位，会做出「画出来就是错的」界面
//   P1 需修   —— 影响像素级设计，但不阻塞草稿
//   P2 建议   —— 打磨项，可下一轮
// ============================================================
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, readDataset, makeTime } from "./lib/dataset.mjs";

const ds = readDataset();
const {
  alarmsIndex, alarms, points: pts, devices: devs, incidents: inc, kpi, trends,
  scenes, sites, spectra, transcripts, deviceStats, rules, auditLogs, points,
} = ds;
const T = makeTime(kpi._meta.generated_at);
const DAY = 1440;

const P0 = [];
const P1 = [];
const P2 = [];
const OK = [];
const fail = (tier, id, msg, fix) => {
  if (tier === "P0") P0.push({ id, msg, fix });
  else if (tier === "P1") P1.push({ id, msg, fix });
  else P2.push({ id, msg, fix });
};
const pass = (id, msg) => OK.push({ id, msg });
const hhmm = (off) => T.clockLabel(off);
const sizeKb = (n) => `${(n / 1024).toFixed(0)}KB`;

// ─────────────────────────────────────────────────────────
// P0-1. scenes[].kpi 必须等于明细枚举（sample 站「3,412 台 vs 10 行」同款）
// ─────────────────────────────────────────────────────────
{
  const siteByScene = new Map(sites.map((s) => [s.scene, s.id]));
  const bad = [];
  for (const s of scenes) {
    const sid = siteByScene.get(s.id);
    const realP = pts.filter((p) => p.site_id === sid).length;
    const realD = devs.filter((d) => d.site_id === sid).length;
    if (s.kpi.points !== realP || s.kpi.devices !== realD) {
      bad.push(`${s.id}: 声明 ${s.kpi.points}点/${s.kpi.devices}设备，明细实为 ${realP}/${realD}`);
    }
  }
  if (bad.length) fail("P0", "scenes.kpi", "场景卡的点位/设备数与明细对不上", bad.join("；"));
  else pass("scenes.kpi", `场景卡数量与明细一致（${scenes.map((s) => `${s.id} ${s.kpi.points}点/${s.kpi.devices}台`).join("，")}）`);
}

// ─────────────────────────────────────────────────────────
// P0-2. devices.scenes 必须包含设备所属站点的场景
// ─────────────────────────────────────────────────────────
{
  const siteScene = new Map(sites.map((s) => [s.id, s.scene]));
  const bad = devs.filter((d) => !(d.scenes || []).includes(siteScene.get(d.site_id)));
  if (bad.length) {
    fail("P0", "devices.scenes", `${bad.length}/${devs.length} 台设备不含所属站点场景`, "改为 scenes 至少包含 site.scene");
  } else pass("devices.scenes", `设备场景覆盖所属站点（${devs.length} 台）`);
}

// ─────────────────────────────────────────────────────────
// P0-3. heatmap[].hour 的语义必须是「时钟小时 0..23」
// ─────────────────────────────────────────────────────────
{
  const real = Array(24).fill(0);
  alarms.filter((a) => T.dayDiff(a.ts_offset_minutes) === 0).forEach((a) => { real[T.clockHour(a.ts_offset_minutes)]++; });
  const hm = Array(24).fill(0);
  trends.heatmap.filter((x) => x.day === 0).forEach((x) => { hm[x.hour] = x.count; });
  const direct = real.every((v, i) => v === hm[i]);
  if (!direct) {
    let shift = -1;
    for (let k = 0; k < 24; k++) if (real.every((v, i) => v === hm[(i + k) % 24])) { shift = k; break; }
    fail("P0", "heatmap.hour", `heatmap.hour 不是时钟小时${shift >= 0 ? `，实测偏移 ${shift} 小时` : ""}`,
      "时段×星期热力图会整体错位。生成器必须用 UTC+8 的时钟小时，不用「近 24h 窗口序号」");
  } else pass("heatmap.hour", "热力图 hour = 时钟小时（UTC+8）");

  const daySums = [];
  for (let d = 0; d < 7; d++) daySums.push(trends.heatmap.filter((x) => x.day === d).reduce((a, x) => a + x.count, 0));
  const dAlarms = trends.daily.map((d) => d.alarms);
  if (JSON.stringify(daySums) !== JSON.stringify(dAlarms)) {
    fail("P1", "heatmap.day", "heatmap 按 day 求和与 trends.daily 不一致", `heatmap=${daySums} daily=${dAlarms}`);
  } else pass("heatmap.day", `热力图 day 求和 = daily 告警数（${daySums.join("/")}）`);
}

// ─────────────────────────────────────────────────────────
// P0-4. 证据链必须能被 spectra.json 兑现
// ─────────────────────────────────────────────────────────
{
  const withBins = alarms.filter((a) => a.evidence && a.evidence.spectrum_bins > 0);
  const reachable = new Set(spectra.map((s) => s.alarm_id).filter(Boolean));
  if (withBins.length !== reachable.size) {
    fail("P0", "evidence.spectrum",
      `${withBins.length} 条告警声明有频谱，但只有 ${reachable.size} 条能通过 alarm_id 定位`,
      "evidence.spectrum_id 必须是真指针：指向的频谱存在，且 spectrum_bins = 该频谱的 bins");
  } else pass("evidence.spectrum", `频谱证据可定位（${reachable.size} 段 / ${withBins.length} 条告警）`);
  const badPointer = alarms.filter((a) => a.evidence.spectrum_id !== null && !spectra.some((s) => s.id === a.evidence.spectrum_id));
  if (badPointer.length) fail("P0", "evidence.spectrum.pointer", `${badPointer.length} 条 evidence.spectrum_id 指向不存在的频谱`, "修正指针");
  if (spectra.some((s) => !s.alarm_id)) fail("P1", "spectra.orphan", `${spectra.filter((s) => !s.alarm_id).length} 段频谱的 alarm_id 为 null`, "全部挂到真实告警");
  else pass("spectra.orphan", "12 段频谱全部有告警入口");
}

// ─────────────────────────────────────────────────────────
// P0-5. 剧本的时间、点位、规则触发必须自洽
// ─────────────────────────────────────────────────────────
{
  const A = alarms.filter((a) => a.script_id === "A");
  if (A.length === 3) {
    const clocks = A.map((a) => hhmm(a.ts_offset_minutes));
    const Ainc = inc.find((i) => i.script_id === "A");
    const okA = Ainc && Ainc.level === 1 && (Ainc.timeline || []).length >= 10 &&
      (Ainc.timeline || []).every((n, i, arr) => i === 0 || arr[i - 1].at_offset_minutes >= n.at_offset_minutes);
    if (okA) pass("script.A", `剧本A 自洽：3 条告警 @ ${clocks.join("/")}，${Ainc.timeline.length} 节点单调`);
    else fail("P1", "script.A", "剧本A 事件级别/时间线不满足", "检查 level 与 timeline 单调性");
  }

  const B = alarms.filter((a) => a.script_id === "B");
  if (B.length) {
    const hours = [...new Set(B.map((a) => T.clockHour(a.ts_offset_minutes)))];
    const p = pts.find((x) => x.id === B[0].point_id);
    const atPoint = alarms.filter((a) => a.point_id === B[0].point_id);
    const fpRate = (atPoint.filter((a) => a.false_positive).length / atPoint.length) * 100;
    const rule = rules.find((r) => r.id === "rule-006");
    const threshold = Number((rule.threshold.match(/>\s*(\d+)/) || [])[1] || 25);
    const probs = [];
    if (hours.length !== 1) probs.push(`7 条告警不在同一时刻：${hours.map((h) => h + ":00").join(",")}`);
    if (hours.length === 1 && hours[0] !== 21) probs.push(`时刻是 ${hours[0]}:00，剧本写的是 21:00`);
    if (fpRate <= threshold) probs.push(`该点位误报率 ${fpRate.toFixed(1)}% ≤ rule-006 阈值 ${threshold}%，降级规则不触发`);
    if (p && ["playground", "canteen", "rooftop"].includes(p.room_type) && p.floor > 1)
      probs.push(`点位是「${p.room}」（${p.floor} 层的${p.room_type}）`);
    if (probs.length) fail("P0", "script.B", "剧本B 讲不通", probs.join("；"));
    else pass("script.B", `剧本B 自洽：7 天 21:00，点位误报率 ${fpRate.toFixed(1)}% > ${threshold}%，点位 ${p.room}`);
  }

  const C = alarms.find((a) => a.script_id === "C");
  if (C) {
    const d = devs.find((x) => x.id === C.device_id);
    const Cinc = inc.find((i) => i.script_id === "C");
    if (d && d.status === "offline" && Cinc) pass("script.C", `剧本C 自洽：设备离线 ${(d.last_heartbeat_offset_minutes / 1440).toFixed(1)} 天，事件存在`);
    else fail("P0", "script.C", "剧本C 设备未离线或事件缺失", "检查 device_id 与 status");
  }

  for (const [id, label] of [["D", "医院一键报警"], ["E", "医院夜间分贝"], ["F", "谈话质量评分"], ["G", "设备批量离线"], ["H", "误报观察降级"]]) {
    const list = alarms.filter((a) => a.script_id === id);
    const ev = inc.find((i) => i.script_id === id);
    if (!list.length || !ev) fail("P1", `script.${id}`, `剧本 ${id}（${label}）缺告警或事件`, "补齐剧本与事件");
    else pass(`script.${id}`, `剧本 ${id}（${label}）：${list.length} 条告警 / 事件 ${ev.id}`);
  }
}

// ─────────────────────────────────────────────────────────
// P0-6. 点位 room_type 必须与楼栋/楼层语义相容（要做楼层平面图）
// ─────────────────────────────────────────────────────────
{
  const outdoor = pts.filter((p) => ["playground", "canteen", "rooftop"].includes(p.room_type) && p.floor > 1);
  if (outdoor.length) {
    fail("P0", "points.room_type", `${outdoor.length} 个室外类房间排在 2 层以上`,
      `${outdoor.slice(0, 6).map((p) => `${p.id}=${p.room}`).join("，")} …。房间类型必须按楼栋/楼层收敛`);
  } else pass("points.room_type", "房间类型与楼层相容（操场/就餐区/天台只在 1 层）");

  const floorMis = pts.filter((p) => {
    const m = /^PT-[A-Z0-9]+-(\d)F\d\d$/.exec(p.id);
    return m && Number(m[1]) !== p.floor;
  });
  if (floorMis.length) fail("P1", "points.floor", `${floorMis.length} 个点位 id 里的楼层与 floor 字段不符`, floorMis.slice(0, 5).map((p) => `${p.id} floor=${p.floor}`).join("，"));
  else pass("points.floor", "点位 id 楼层 = floor 字段");

  const syl = sites.find((s) => s.id === "site-01");
  if (syl) {
    const m = /(\d+) 个点位/.exec(syl.rooms || "");
    const s1 = pts.filter((p) => p.site_id === "site-01");
    if (!m || Number(m[1]) !== s1.length) {
      fail("P1", "sites.rooms", `site-01 文案「${syl.rooms}」与 ${s1.length} 个点位不符`, "改成从 points 聚合生成");
    } else pass("sites.rooms", `站点概要从明细聚合（${syl.rooms}）`);
  }
}

// ─────────────────────────────────────────────────────────
// P1-a. 数值单位必须可判读（rate 是百分数还是小数）
// ─────────────────────────────────────────────────────────
{
  const fpRateKpi = kpi.false_positive_rate;
  const realFp = (alarms.filter((a) => a.false_positive).length / alarms.length) * 100;
  const unitPct = Math.abs(fpRateKpi - realFp) < 0.2;
  const unitFrac = Math.abs(fpRateKpi - realFp / 100) < 0.002;
  const onlineReal = (devs.filter((d) => d.status === "online").length / devs.length) * 100;
  const onlinePct = Math.abs(kpi.online_rate - onlineReal) < 0.2;
  if (unitPct && onlinePct) pass("kpi.unit", `rate 类字段统一为百分数（fp=${fpRateKpi}，online=${kpi.online_rate}）`);
  else if (unitFrac) fail("P1", "kpi.unit", "rate 是 0..1 小数而非百分数", "在 types.ts 标注量纲；前端统一 toPercent()");
  else fail("P1", "kpi.unit", `rate 量纲不明（fp=${fpRateKpi}，实测 ${realFp.toFixed(1)}%；online=${kpi.online_rate}，实测 ${onlineReal.toFixed(1)}%）`, "统一为百分数并在契约里写明");
}

// ─────────────────────────────────────────────────────────
// P1-b. GPU 分项必须加得回总量
// ─────────────────────────────────────────────────────────
{
  const g = kpi.gpu;
  const used = g.cards.reduce((s, c) => s + c.vram_used_gb, 0);
  const implied = (g.vram_total_gb * g.utilization_percent) / 100;
  if (Math.abs(used - implied) > g.vram_total_gb * 0.05) {
    fail("P1", "kpi.gpu", `分项显存合计 ${used}GB 与总量×利用率 ${implied.toFixed(0)}GB 不符`,
      `vram_total_gb=${g.vram_total_gb}, utilization_percent=${g.utilization_percent}，总览页 GPU 条会被一眼看出矛盾`);
  } else pass("kpi.gpu", `GPU 分项与总量一致（${used}GB ≈ ${g.vram_total_gb}×${g.utilization_percent}%）`);
  const idleBusy = g.cards.filter((c) => c.mode === "空闲" && c.utilization > 5);
  if (idleBusy.length) fail("P2", "kpi.gpu.mode", `${idleBusy.length} 张卡标「空闲」但利用率 > 5%`, idleBusy.map((c) => `#${c.index} util=${c.utilization}`).join("，"));
  else pass("kpi.gpu.mode", "「空闲」卡利用率 ≤ 5%");
}

// ─────────────────────────────────────────────────────────
// P1-c. 时间口径必须与 UI 文案一致（今日 = 自然日 vs 滚动 24h）
// ─────────────────────────────────────────────────────────
{
  const rolling = alarms.filter((a) => a.ts_offset_minutes >= 0 && a.ts_offset_minutes < DAY).length;
  const natural = alarms.filter((a) => T.dayDiff(a.ts_offset_minutes) === 0).length;
  if (kpi.alarm_last_24h !== rolling) fail("P1", "kpi.alarm_last_24h", `alarm_last_24h=${kpi.alarm_last_24h} 与滚动 24h 明细 ${rolling} 不符`, "按 [0,1440) 现算");
  else pass("kpi.alarm_last_24h", `滚动 24h = ${rolling}`);
  if (kpi.alarm_natural_day !== natural) fail("P1", "kpi.alarm_natural_day", `alarm_natural_day=${kpi.alarm_natural_day} 与自然日明细 ${natural} 不符`, "按今天 00:00 起现算");
  else pass("kpi.alarm_natural_day", `自然日 = ${natural}`);
  if (kpi.alarm_today !== kpi.alarm_natural_day) fail("P2", "kpi.alarm_today.alias", "alarm_today 与 alarm_natural_day 不一致", "保留兼容别名并锁死相等");
  else pass("kpi.alarm_today.alias", "alarm_today = alarm_natural_day（兼容别名）");

  const unhandled = alarms.filter((a) => a.status === "new" || a.status === "dispatched");
  const unhandledL1 = unhandled.filter((a) => a.level === 1).length;
  const bd = kpi.alarm_unhandled_breakdown || [];
  const bdL1 = bd.find((x) => x.level === 1)?.count;
  if (kpi.alarm_unhandled !== unhandled.length) fail("P1", "kpi.alarm_unhandled", `未处置 ${kpi.alarm_unhandled} 与明细 ${unhandled.length} 不符`, "现算");
  else if (bdL1 !== unhandledL1) fail("P1", "kpi.alarm_unhandled.breakdown", `未处置一级 ${bdL1} 与明细 ${unhandledL1} 不符`, "补 alarm_unhandled_breakdown 并按 level 现算");
  else pass("kpi.alarm_unhandled.breakdown", `未处置分级拆分开箱即用（一级 ${bdL1} / 共 ${unhandled.length}）`);
}

// ─────────────────────────────────────────────────────────
// P1-d. 数组排序方向必须一致（同一次装配里三种顺序会出错图）
// ─────────────────────────────────────────────────────────
{
  const asc = (arr, key) => arr.every((x, i) => i === 0 || arr[i - 1][key] <= x[key]);
  const problems = [];
  if (!asc(alarms, "ts_offset_minutes")) problems.push("alarms");
  if (!asc(inc, "started_offset_minutes")) problems.push("incidents");
  if (!asc(trends.hourly, "window_start_offset_minutes")) problems.push("trends.hourly");
  if (!asc(trends.daily, "date_offset_days")) problems.push("trends.daily");
  if (!asc(auditLogs, "ts_offset_minutes")) problems.push("audit-logs");
  if (problems.length) fail("P1", "order", `排序方向不统一：${problems.join(" / ")}`, "统一为「新 → 旧」（偏移升序），并在 types.ts 标注");
  else pass("order", "所有时间数组统一「新 → 旧」（偏移升序）");
}

// ─────────────────────────────────────────────────────────
// P1-e. 转写必须覆盖整个音频时长
// ─────────────────────────────────────────────────────────
{
  const bad = transcripts.filter((t) => {
    const last = Math.max(...t.segments.map((s) => s.end));
    return t.audio_seconds - last > 2;
  });
  if (bad.length) fail("P1", "transcript.coverage", `${bad.length} 段转写没覆盖完整音频`,
    bad.map((t) => `${t.id}: 0–${Math.max(...t.segments.map((s) => s.end))}s / ${t.audio_seconds}s`).join("；"));
  else pass("transcript.coverage", `${transcripts.length} 段转写全部覆盖完整音频`);
}

// ─────────────────────────────────────────────────────────
// P1-f. narrative_tier 必须能被事件兑现
// ─────────────────────────────────────────────────────────
{
  const inInc = new Set(inc.flatMap((i) => i.alarm_ids));
  const tally = {};
  for (const t of ["script", "related", "noise"]) {
    const list = alarms.filter((a) => a.narrative_tier === t);
    tally[t] = { total: list.length, linked: list.filter((a) => inInc.has(a.id)).length };
  }
  if (tally.related.linked === 0) {
    fail("P1", "narrative_tier", `related ${tally.related.total} 条全部不属于任何事件`, "related 必须落进事件，否则「事件→关联告警」点进去是空");
  } else pass("narrative_tier", `script ${tally.script.linked}/${tally.script.total}、related ${tally.related.linked}/${tally.related.total} 被事件引用`);
}

// ─────────────────────────────────────────────────────────
// P1/P2. 时间字段命名收敛
// ─────────────────────────────────────────────────────────
{
  const names = new Set();
  const walk = (o) => {
    if (!o || typeof o !== "object") return;
    if (Array.isArray(o)) return o.forEach(walk);
    for (const k of Object.keys(o)) {
      if (/(offset_minutes|minutes_ago)$/.test(k)) names.add(k);
      walk(o[k]);
    }
  };
  walk({ alarms, inc, devs, trends, spectra });
  const stray = [...names].filter((n) => !n.endsWith("_offset_minutes"));
  if (stray.length) fail("P1", "time.naming", `仍存在非 _offset_minutes 后缀：${stray.join(", ")}`, "统一为 *_offset_minutes，并在 types.ts 注明「越小越新」");
  else pass("time.naming", `时间字段统一 _offset_minutes 后缀（${names.size} 个字段，语义均为「越小越新」）`);
}

// ─────────────────────────────────────────────────────────
// P1-g. JSON 里不应存颜色（设计换皮的前置条件）
// ─────────────────────────────────────────────────────────
{
  const colorHits = [];
  if (scenes.some((s) => s.color || s.accent)) colorHits.push("scenes[].color/accent");
  if ((transcripts.some((t) => (t.speakers || []).some((s) => s.color)))) colorHits.push("transcript.speakers[].color");
  if (deviceStats && JSON.stringify(deviceStats).includes("#")) colorHits.push("device-stats 十六进制色");
  if (colorHits.length) fail("P1", "json.no-color", `JSON 里存了颜色：${colorHits.join("，")}`,
    "改为语义 token（scene id / speaker index），颜色由前端 tokens 映射");
  else pass("json.no-color", "数据层无颜色，换皮只改前端 token");
}

// ─────────────────────────────────────────────────────────
// P1-h. 空态必须真的存在（90/180 天窗口内）
// ─────────────────────────────────────────────────────────
{
  const cnt = {};
  alarms.forEach((a) => { cnt[a.point_id] = (cnt[a.point_id] || 0) + 1; });
  const zeroPts = pts.filter((p) => !cnt[p.id]);
  if (!zeroPts.length) fail("P1", "empty.points", "没有零告警点位，空态无法验证", "留 1 个点位 0 告警");
  else pass("empty.points", `${zeroPts.length} 个点位 0 告警（可用于空态）`);
  const days = new Set(alarms.map((a) => T.dayDiff(a.ts_offset_minutes)));
  const zeroDays = [];
  for (let d = 0; d < 180; d++) if (!days.has(d)) zeroDays.push(d);
  if (!zeroDays.length) fail("P1", "empty.days", "180 天内没有 0 告警的自然日", "留 1 天 0 告警，否则「当天无数据」空态只能靠筛选伪造");
  else pass("empty.days", `${zeroDays.length} 天 0 告警（最近的第 ${zeroDays[0]} 天）`);
  const comboZero = alarms.filter((a) => a.level === 4 && a.ts_offset_minutes <= 60).length;
  if (comboZero === 0) pass("empty.filter", "「四级 + 近 1 小时」= 0 条，筛选空态可验证");
}

// ─────────────────────────────────────────────────────────
// P1-i. 数据体积 / 分片（静态站首屏）
// ─────────────────────────────────────────────────────────
{
  const maxShard = Math.max(...alarmsIndex.shards.map((s) => s.bytes));
  if (maxShard > 1.5 * 1024 * 1024) fail("P1", "size.alarms", `最大告警分片 ${(maxShard / 1048576).toFixed(2)}MB > 1.5MB`, "继续切分");
  else pass("size.alarms", `${alarmsIndex.shards.length} 个告警分片，最大 ${sizeKb(maxShard)}（≤ 1.5MB）`);
  if (alarmsIndex._meta.total !== alarms.length) fail("P1", "shards.total", "索引 total 与分片明细之和不等", "重算");
  else pass("shards.total", `索引 total = 分片明细之和（${alarms.length} 条）`);
  const indexBytes = Buffer.byteLength(readFileSync(join(DATA_DIR, "alarms-index.json")));
  if (indexBytes > 64 * 1024) fail("P1", "size.index", `alarms-index.json ${sizeKb(indexBytes)}`, "索引只放元信息与分片表");
  else pass("size.index", `首屏索引 ${sizeKb(indexBytes)}（不含明细）`);
  if (!alarmsIndex.pagination || !alarmsIndex.pagination.cursor_format) fail("P1", "pagination", "告警索引缺分页/游标契约", "补 page_size + cursor + next_cursor");
  else pass("pagination", `游标分页契约就绪（page_size=${alarmsIndex.pagination.page_size}，cursor=${alarmsIndex.pagination.cursor_format}）`);
}

// ─────────────────────────────────────────────────────────
// P1-j. 频谱编码与波形桶
// ─────────────────────────────────────────────────────────
{
  let allOk = true;
  const info = [];
  for (const s of spectra) {
    const buf = Buffer.from(s.data, "base64");
    if (buf.length !== s.cols * s.bins) { allOk = false; info.push(`${s.id} 长度 ${buf.length} ≠ ${s.cols}×${s.bins}`); continue; }
    let mx = 0, sum = 0; for (const b of buf) { if (b > mx) mx = b; sum += b; }
    info.push(`${s.id} ${s.cols}×${s.bins} max=${mx} mean=${(sum / buf.length).toFixed(1)}`);
  }
  if (allOk) pass("spectra.decode", info.slice(0, 3).join("；") + ` …共 ${spectra.length} 段`);
  else fail("P0", "spectra.decode", "频谱长度与 bins×cols 不符", info.join("；"));

  const noWave = spectra.filter((s) => !s.waveform || s.waveform.buckets !== 2000 ||
    Buffer.from(s.waveform.min || "", "base64").length !== 2000 ||
    Buffer.from(s.waveform.max || "", "base64").length !== 2000);
  if (noWave.length) fail("P2", "spectra.waveform", `${noWave.length} 段频谱缺 2,000 桶波形`, "补 waveform.min / max");
  else pass("spectra.waveform", "每段频谱配 2,000 桶 min/max 波形 + peaks");
}

// ─────────────────────────────────────────────────────────
// P2-a. 极端值（布局压力测试的真实输入）
// ─────────────────────────────────────────────────────────
{
  const maxRoom = Math.max(...pts.map((p) => p.room.length));
  const maxKw = Math.max(...alarms.map((a) => (a.keywords || []).length));
  const maxTitle = Math.max(...alarms.map((a) => a.title.length));
  if (maxRoom < 28 || maxKw < 6 || maxTitle < 40) {
    fail("P2", "stress.values", `极端值不够：最长房间名 ${maxRoom} 字、最多关键词 ${maxKw} 个、最长标题 ${maxTitle} 字`,
      "各埋 1 条：房间名 ≥ 28 字、6 个关键词、标题 ≥ 40 字");
  } else pass("stress.values", `极端值齐备（房间名 ${maxRoom} 字 / 关键词 ${maxKw} 个 / 标题 ${maxTitle} 字）`);
}

// ─────────────────────────────────────────────────────────
// P2-b. 设备画像 / 操作日志 / 规模
// ─────────────────────────────────────────────────────────
{
  const noProfile = devs.filter((d) => !Array.isArray(d.self_check_history) || d.self_check_history.length === 0 ||
    !Array.isArray(d.ota_records) || !Array.isArray(d.signal_series) || d.signal_series.length !== 24);
  if (noProfile.length) fail("P1", "device.profile", `${noProfile.length} 台设备缺自检历史 / OTA / 信号序列`, "补 device 画像字段");
  else pass("device.profile", `全部 ${devs.length} 台设备都有固件、自检历史、OTA 与 24 点信号序列`);

  if (auditLogs.length < 300) fail("P2", "audit-logs.count", `操作日志只有 ${auditLogs.length} 条`, "补到 300 条并覆盖导出/删除/权限变更");
  else {
    const codes = new Set(auditLogs.map((l) => l.action_code));
    const need = ["export", "delete", "permission"].filter((c) => !codes.has(c));
    if (need.length) fail("P2", "audit-logs.sensitive", `敏感操作类型缺 ${need.join(",")}`, "补齐导出/删除/权限变更");
    else pass("audit-logs", `${auditLogs.length} 条操作日志，覆盖导出/删除/权限变更`);
  }

  const hospitalPts = pts.filter((p) => p.site_id === "site-02").length;
  const policePts = pts.filter((p) => p.site_id === "site-03").length;
  const hospitalDevs = devs.filter((d) => d.site_id === "site-02").length;
  const policeDevs = devs.filter((d) => d.site_id === "site-03").length;
  if (hospitalPts < 60 || policePts < 40 || hospitalDevs < 8 || policeDevs < 8) {
    fail("P1", "scale.scenes", `医院 ${hospitalPts} 点/${hospitalDevs} 台，公安 ${policePts} 点/${policeDevs} 台，撑不起场景页`, "补厚到 医院 ≥60 点、公安 ≥40 点、各 ≥8 台设备");
  } else pass("scale.scenes", `医院 ${hospitalPts} 点/${hospitalDevs} 台，公安 ${policePts} 点/${policeDevs} 台`);
  const days = new Set(alarms.map((a) => T.dayDiff(a.ts_offset_minutes)));
  const maxDay = Math.max(...days);
  if (maxDay < 179) fail("P1", "scale.history", `告警历史只覆盖 ${maxDay + 1} 天`, "扩到 180 天");
  else pass("scale.history", `告警历史覆盖 ${maxDay + 1} 天 / ${alarms.length} 条（日均 ${(alarms.length / days.size).toFixed(0)}）`);

  if (spectra.length < 12) fail("P2", "scale.spectra", `频谱只有 ${spectra.length} 段`, "补到 12 段");
  else pass("scale.spectra", `频谱 ${spectra.length} 段，覆盖欺凌/争吵/哭喊/玻璃破碎/设备噪声`);
  if (transcripts.length < 5) fail("P2", "scale.transcripts", `转写只有 ${transcripts.length} 段`, "补到 5 段");
  else pass("scale.transcripts", `转写 ${transcripts.length} 段（含校园欺凌 / 医院冲突 / 公安审讯 / 广播喊话 / 对讲记录）`);
  if (scenes.length !== 3) fail("P2", "scale.scenes.count", `场景卡 ${scenes.length} 个`, "校园 / 医院 / 公安三个");
}

// ─────────────────────────────────────────────────────────
// P2-c. 告警原文的 level / confidence / 长尾
// ─────────────────────────────────────────────────────────
{
  const badLevel = alarms.filter((a) => ![1, 2, 3, 4].includes(a.level));
  if (badLevel.length) fail("P1", "alarms.level", `${badLevel.length} 条 level 越界`, "限制在 1..4");
  const badConf = alarms.filter((a) => !(a.confidence >= 0.6 && a.confidence <= 1));
  if (badConf.length) fail("P1", "alarms.confidence", `${badConf.length} 条 confidence 越界`, "0.6–1.0");
  if (alarms[0].page || alarms[0].cursor) fail("P2", "pagination.per-alarm", "告警对象上挂了 page/cursor", "分页只在索引层表达，不要污染每条记录");
  else pass("pagination.per-alarm", "分页只在索引层表达，告警对象保持干净");
}

// ─────────────────────────────────────────────────────────
// 输出
// ─────────────────────────────────────────────────────────
const banner = (t) => ({ P0: "🔴 P0 阻塞（直接会做出错界面）", P1: "🟠 P1 需修（影响设计，不阻塞草稿）", P2: "🟡 P2 建议（可下一轮）" }[t]);
const dump = (label, list) => {
  if (!list.length) return;
  console.log(`\n${banner(label)}  ${list.length} 项`);
  for (const x of list) console.log(`  ✗ [${x.id}] ${x.msg}\n      → ${x.fix}`);
};

console.log("=== 前端可消费性审计（validate.mjs 的补充）===");
dump("P0", P0);
dump("P1", P1);
dump("P2", P2);

console.log(`\n✅ 已通过 ${OK.length} 项`);
for (const x of OK) console.log(`  ✓ [${x.id}] ${x.msg}`);

console.log(`\n结论：P0 ${P0.length} / P1 ${P1.length} / P2 ${P2.length} / PASS ${OK.length}`);
if (P0.length) {
  console.log("P0 未清零前，不适合进入像素级设计（数字会对不上、故事会断）。");
  process.exit(1);
}
console.log("P0 已清零，可以进入设计轮。");
