// 契约测试：直接读 web/public/stream-monitor-data 的真实数据，验证「前端拿到的东西能用」。
//
// 这一层故意不复用生成器的断言：生成器可能和校验脚本一起写错，
// 这里从「消费者视角」重新算一遍（聚合对明细、轴线语义、分页、体积）。
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { clockHourOf, toClock } from "./time";
import { loadAlarmPage, loadAllAlarms, loadCore, loadDataset } from "./load";
import type { Fetcher } from "./load";

function resolveDataDir(): string {
  const candidates = [
    resolve(process.cwd(), "public/stream-monitor-data"),
    resolve(__dirname, "../../../public/stream-monitor-data"),
    resolve(__dirname, "../../public/stream-monitor-data"),
  ];
  const hit = candidates.find((p) => existsSync(join(p, "index.json")));
  assert.ok(hit, `找不到智能音视频平台数据目录，试过：${candidates.join("，")}`);
  return hit;
}

const DATA_DIR = resolveDataDir();
const fetcher: Fetcher = async (url) => {
  const raw = readFileSync(url, "utf8");
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`数据文件不是合法 JSON：${url}（${(err as Error).message}）`);
  }
};

describe("智能音视频平台 数据契约（web/public/stream-monitor-data）", () => {
  it("首屏核心数据可以一次加载完", async () => {
    const core = await loadCore(DATA_DIR, fetcher);
    assert.equal(core.sites.length, 3);
    assert.equal(core.index.timezone, "UTC+8");
    assert.ok(core.points.length >= 260, `点位只有 ${core.points.length} 个`);
    assert.ok(core.devices.length >= 200, `设备只有 ${core.devices.length} 台`);
    assert.ok(core.incidents.length >= 100);
    assert.equal(core.transcripts.length, 5);
    assert.equal(core.scenes.length, 3);
  });

  it("场景卡的数字与点位 / 设备明细完全相等", async () => {
    const core = await loadCore(DATA_DIR, fetcher);
    for (const scene of core.scenes) {
      const site = core.sites.find((s) => s.scene === scene.id);
      assert.ok(site, `场景 ${scene.id} 没有对应站点`);
      assert.equal(scene.kpi.points, core.points.filter((p) => p.site_id === site.id).length);
      assert.equal(scene.kpi.devices, core.devices.filter((d) => d.site_id === site.id).length);
      assert.equal(scene.kpi.today_alarms, core.kpi.scene_breakdown_today.find((x) => x.scene === scene.id)?.count);
    }
  });

  it("站点概要文案里的数字来自明细（不是手写）", async () => {
    const core = await loadCore(DATA_DIR, fetcher);
    for (const site of core.sites) {
      const real = core.points.filter((p) => p.site_id === site.id).length;
      assert.equal(site.points, real);
      assert.match(site.rooms, new RegExp(`${real} 个点位$`));
      assert.equal(site.devices, core.devices.filter((d) => d.site_id === site.id).length);
    }
  });

  it("每台设备的 scenes 都包含所属站点的场景", async () => {
    const core = await loadCore(DATA_DIR, fetcher);
    const sceneBySite = new Map(core.sites.map((s) => [s.id, s.scene]));
    for (const d of core.devices) {
      assert.ok(d.scenes.includes(sceneBySite.get(d.site_id)!), `${d.id} 缺所属站点场景`);
    }
  });

  it("KPI 口径自洽：自然日 ≤ 滚动 24h，别名相等", async () => {
    const core = await loadCore(DATA_DIR, fetcher);
    const kpi = core.kpi;
    assert.equal(kpi.alarm_today, kpi.alarm_natural_day);
    assert.ok(kpi.alarm_natural_day <= kpi.alarm_last_24h);
    assert.equal(kpi.level_breakdown_today.reduce((s, x) => s + x.count, 0), kpi.alarm_natural_day);
    assert.equal(kpi.scene_breakdown_today.reduce((s, x) => s + x.count, 0), kpi.alarm_natural_day);
    assert.equal(kpi.alarm_unhandled_breakdown.reduce((s, x) => s + x.count, 0), kpi.alarm_unhandled);
    assert.ok(kpi.online_rate > 1 && kpi.online_rate <= 100);
  });

  it("热力图的 hour 是时钟小时，day 求和与 daily 一致", async () => {
    const core = await loadCore(DATA_DIR, fetcher);
    for (const cell of core.trends.heatmap) {
      assert.ok(cell.hour >= 0 && cell.hour <= 23, `hour 越界：${cell.hour}`);
      assert.ok(cell.day >= 0 && cell.day <= 6);
    }
    const sums = [0, 1, 2, 3, 4, 5, 6].map((d) =>
      core.trends.heatmap.filter((x) => x.day === d).reduce((a, x) => a + x.count, 0));
    assert.deepEqual(sums, core.trends.daily.map((d) => d.alarms));
  });

  it("所有时间数组都是「新 → 旧」", async () => {
    const core = await loadCore(DATA_DIR, fetcher);
    const asc = (arr: number[]) => arr.every((v, i) => i === 0 || arr[i - 1] <= v);
    assert.ok(asc(core.incidents.map((i) => i.started_offset_minutes)));
    assert.ok(asc(core.trends.hourly.map((h) => h.window_start_offset_minutes)));
    assert.ok(asc(core.trends.daily.map((d) => d.date_offset_days)));
    assert.ok(asc(core.auditLogs.map((l) => l.ts_offset_minutes)));
  });

  it("剧本 B 讲得通：7 天 21:00、点位在 1 层、误报率超过阈值", async () => {
    const all = await loadAllAlarms(await loadCore(DATA_DIR, fetcher).then((c) => c.alarmsIndex), DATA_DIR, fetcher);
    const b = all.filter((a) => a.script_id === "B");
    assert.equal(b.length, 7);
    assert.deepEqual(Array.from(new Set(b.map((a) => toClock(a.ts_offset_minutes)))), ["21:00"]);
    const core = await loadCore(DATA_DIR, fetcher);
    const point = core.points.find((p) => p.id === b[0].point_id);
    assert.ok(point);
    assert.equal(point.room_type, "playground");
    assert.equal(point.floor, 1);
    const atPoint = all.filter((a) => a.point_id === point.id);
    const fpRate = (atPoint.filter((a) => a.false_positive).length / atPoint.length) * 100;
    const threshold = Number((core.rules.find((r) => r.id === "rule-006")!.threshold.match(/>\s*(\d+)/) || [])[1]);
    assert.ok(fpRate > threshold, `误报率 ${fpRate.toFixed(1)}% 不足以触发 ${threshold}%`);
  });

  it("频谱指针可定位，波形桶齐备，转写覆盖完整", async () => {
    const ds = await loadDataset(DATA_DIR, fetcher);
    assert.equal(ds.spectra.length, 12);
    for (const sp of ds.spectra) {
      assert.ok(sp.alarm_id, `${sp.id} 没有 alarm_id`);
      assert.equal(Buffer.from(sp.data, "base64").length, sp.bins * sp.cols);
      assert.equal(Buffer.from(sp.waveform.min, "base64").length, 2000);
      assert.equal(Buffer.from(sp.waveform.max, "base64").length, 2000);
    }
    for (const t of ds.transcripts) {
      const last = Math.max(...t.segments.map((s) => s.end));
      assert.ok(t.audio_seconds - last <= 2, `${t.id} 尾部空白 ${t.audio_seconds - last}s`);
    }
  });

  it("告警分片单片 ≤ 1.5MB，索引不含明细", async () => {
    const core = await loadCore(DATA_DIR, fetcher);
    const indexBytes = statSync(join(DATA_DIR, "alarms-index.json")).size;
    assert.ok(indexBytes < 64 * 1024, `索引 ${indexBytes} 字节`);
    let sum = 0;
    for (const shard of core.alarmsIndex.shards) {
      const bytes = statSync(join(DATA_DIR, shard.file)).size;
      assert.ok(bytes <= 1.5 * 1024 * 1024, `${shard.file} ${(bytes / 1048576).toFixed(2)}MB`);
      sum += shard.count;
    }
    assert.equal(sum, core.alarmsIndex._meta.total);
  });

  it("游标分页能跨分片连续读出全部告警", async () => {
    const core = await loadCore(DATA_DIR, fetcher);
    const index = core.alarmsIndex;
    const seen = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    let prevOffset = -1;
    do {
      const page = await loadAlarmPage(index, cursor, 200, DATA_DIR, fetcher);
      assert.ok(page.alarms.length > 0, "空页");
      for (const a of page.alarms) {
        assert.ok(!seen.has(a.id), `告警重复：${a.id}`);
        seen.add(a.id);
        assert.ok(a.ts_offset_minutes >= prevOffset, "分页顺序不是新→旧");
        prevOffset = a.ts_offset_minutes;
      }
      cursor = page.next_cursor;
      pages += 1;
      assert.ok(pages < 200, "分页没有收敛");
    } while (cursor !== null);
    assert.equal(seen.size, index._meta.total);
    assert.ok(pages > 1, "应至少跨多页");
  });

  it("极端值样本真实存在（布局压力测试输入）", async () => {
    const core = await loadCore(DATA_DIR, fetcher);
    const all = await loadAllAlarms(core.alarmsIndex, DATA_DIR, fetcher);
    assert.ok(Math.max(...core.points.map((p) => p.room.length)) >= 28);
    assert.ok(Math.max(...all.map((a) => a.keywords.length)) >= 6);
    assert.ok(Math.max(...all.map((a) => a.title.length)) >= 40);
  });

  it("每条记录都满足 types.ts 的字段契约（无缺字段、无未知字段）", async () => {
    const core = await loadCore(DATA_DIR, fetcher);
    const all = await loadAllAlarms(core.alarmsIndex, DATA_DIR, fetcher);
    const rows: { name: string; list: Record<string, unknown>[]; required: string[]; optional?: string[] }[] = [
      {
        name: "Alarm",
        list: all as unknown as Record<string, unknown>[],
        required: [
          "id", "site_id", "scene", "point_id", "point_room", "device_id", "type_code", "type_name",
          "category", "level", "level_label", "title", "detail", "confidence", "ts_offset_minutes",
          "duration_seconds", "decibel", "keywords", "status", "disposition", "narrative_tier",
          "evidence", "false_positive", "script_id",
        ],
        optional: ["false_positive_reason", "rule_hits", "downgraded"],
      },
      {
        name: "Device",
        list: core.devices as unknown as Record<string, unknown>[],
        required: [
          "id", "site_id", "point_id", "point_room", "model", "type_name", "kind", "firmware",
          "status", "last_heartbeat_offset_minutes", "uptime_days", "signal", "cpu_percent",
          "storage_percent", "mic_sensitivity_dbm", "self_check", "self_check_history",
          "ota_records", "signal_series", "scenes", "gateway_id",
        ],
      },
      {
        name: "Incident",
        list: core.incidents as unknown as Record<string, unknown>[],
        required: [
          "id", "site_id", "scene", "title", "level", "level_label", "point_id", "point_room",
          "alarm_ids", "alarm_count", "started_offset_minutes", "ended_offset_minutes",
          "duration_minutes", "status", "owner_id", "evidence_count", "script_id", "timeline",
        ],
      },
      {
        name: "Point",
        list: core.points as unknown as Record<string, unknown>[],
        required: ["id", "site_id", "building", "building_name", "floor", "room", "room_type", "risk_weight", "has_device", "note"],
      },
      {
        name: "Site",
        list: core.sites as unknown as Record<string, unknown>[],
        required: ["id", "code", "name", "type", "scene", "area", "capacity", "scene_token", "buildings", "floors", "points", "devices", "rooms"],
      },
      {
        name: "Transcript",
        list: core.transcripts as unknown as Record<string, unknown>[],
        required: ["id", "alarm_id", "site_id", "scene", "audio_seconds", "language", "speakers", "segments", "keyword_hits"],
      },
    ];
    for (const { name, list, required, optional = [] } of rows) {
      for (const row of list) {
        for (const key of required) assert.ok(key in row, `${name} 缺字段 ${key}`);
        for (const key of Object.keys(row)) {
          assert.ok(required.includes(key) || optional.includes(key), `${name} 出现未声明字段 ${key}`);
        }
      }
    }
    const full = await loadDataset(DATA_DIR, fetcher);
    for (const sp of full.spectra) {
      for (const key of ["id", "alarm_id", "title", "profile", "bins", "cols", "seconds", "binHz", "colMs", "encoding", "note", "data", "waveform", "peaks"]) {
        assert.ok(key in sp, `Spectrum 缺字段 ${key}`);
      }
    }
  });

  it("时钟小时换算不受机器时区影响（02:10 / 21:00 的锚点用例）", () => {
    assert.equal(clockHourOf(590), 2);
    assert.equal(toClock(590), "02:10");
    assert.equal(toClock(900), "21:00");
  });
});
