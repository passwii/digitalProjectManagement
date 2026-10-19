import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  avDataDir,
  getAlarmById,
  getAlarmPage,
  getAlarmsByIds,
  getCore,
  getDatasetIndex,
  getExtremes,
} from "./server";
import { getAudioData, getDeviceData, getEventData, getOverviewData, getStressData } from "./pageData";
import { loadAlarmShard, type Fetcher } from "./load";
import { readFileSync } from "node:fs";
import { CORE_FILES } from "./view";

/**
 * 服务端数据层契约。
 *
 * 这些用例读真实 mock 数据，锁住三件容易悄悄坏掉的事：
 *   1. id 深链接能定位到具体告警（全量 id 索引）；
 *   2. `/av/overview` 的首屏 payload 远低于 1MB（AC10）；
 *   3. 极端值样本仍然存在（Stage 1 埋的 58 字标题 / 6 关键词 / 33 字房间名）。
 */

const fetcher: Fetcher = async (url) => JSON.parse(readFileSync(url, "utf8")) as unknown;

describe("AV 服务端数据层", () => {
  it("核心数据规模与 Stage 1 交付一致", async () => {
    const [core, index] = await Promise.all([getCore(), getDatasetIndex()]);
    assert.equal(index.counts.sites, 3);
    assert.equal(core.sites.length, 3);
    assert.equal(core.devices.length, 268);
    assert.equal(core.incidents.length, 207);
    assert.equal(core.scenes.length, 3);
    assert.equal(core.transcripts.length, 5);
    assert.equal(core.alarmsIndex.shards.length, 9);
    assert.equal(core.alarmsIndex._meta.total, 14366);
  });

  it("核心文件总字节数 ≤ 1MB（首屏预算的物理上限）", () => {
    const total = CORE_FILES.reduce((sum, file) => sum + statSync(join(avDataDir(), file)).size, 0);
    assert.ok(total <= 1024 * 1024, `核心数据 ${total} 字节，超过 1MB`);
    assert.ok(total > 700 * 1024, "核心数据太小，可能漏了文件");
  });

  it("按 id 深链接能定位告警，未知 id 返回 null", async () => {
    const alarm = await getAlarmById("AL-00037");
    assert.ok(alarm, "AL-00037 应存在");
    assert.equal(alarm.id, "AL-00037");
    assert.equal(await getAlarmById("AL-NOT-EXIST"), null);

    const many = await getAlarmsByIds(["AL-00037", "AL-NOT-EXIST", "AL-14400"]);
    assert.deepEqual(many.map((item) => item.id), ["AL-00037", "AL-14400"]);
  });

  it("首屏告警分页按游标推进，且不重复", async () => {
    const first = await getAlarmPage(null, 20);
    assert.equal(first.alarms.length, 20);
    assert.ok(first.next_cursor);
    const second = await getAlarmPage(first.next_cursor, 20);
    const overlap = second.alarms.filter((alarm) => first.alarms.some((item) => item.id === alarm.id));
    assert.equal(overlap.length, 0);
  });

  it("总览 payload ≤ 1MB（AC10：用 loadCore 的聚合结果，而不是 13MB 全量）", async () => {
    const data = await getOverviewData();
    const bytes = Buffer.byteLength(JSON.stringify(data), "utf8");
    assert.ok(bytes <= 1024 * 1024, `总览 payload ${bytes} 字节，超过 1MB`);
    // 只带必要的聚合，不应把 devices / incidents 全量塞进首屏
    assert.ok(bytes < 300 * 1024, `总览 payload ${bytes} 字节，明显大于预期（是不是把明细带上了？）`);
    assert.ok(data.recent.length > 0);
    assert.ok(data.recent.length <= 10);
  });

  it("极端值样本仍然存在（Stage 1 素材）", async () => {
    const extremes = await getExtremes();
    assert.equal(extremes.longestTitle.title.length, 58);
    assert.equal(extremes.mostKeywords.keywords.length, 6);
    assert.equal(extremes.longestRoom.point_room.length, 33);
    assert.equal(extremes.total, 14366);
    assert.equal(extremes.level4LastHour, 0, "「四级 + 近 1 小时」应是空态素材");
    assert.ok(extremes.emptyDays.length > 0, "应存在 0 告警自然日");
    assert.ok(extremes.zeroAlarmPoints.length > 0, "应存在 0 告警点位");
  });

  it("「0 告警自然日」必须是真 0（不把部分覆盖的边界日算进来）", async () => {
    const extremes = await getExtremes();
    const core = await getCore();
    /** 从原始分片重算每个自然日的告警数，不依赖被测实现的分桶。 */
    const counts = new Map<string, number>();
    for (let i = 0; i < core.alarmsIndex.shards.length; i += 1) {
      const shard = await loadAlarmShard(avDataDir(), core.alarmsIndex, i, fetcher);
      for (const alarm of shard.alarms) {
        const date = new Date(
          Date.parse("2026-10-19T12:00:00+08:00") - alarm.ts_offset_minutes * 60_000 + 8 * 3_600_000,
        );
        const key = date.toISOString().slice(0, 10);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }

    // 每一条都必须真的是 0 条
    for (const day of extremes.emptyDays) {
      assert.equal(counts.get(day.date) ?? 0, 0, `${day.date} 被标成 0 告警，实际有 ${counts.get(day.date)} 条`);
    }
    // 回归：2026-04-22 有 60 条，曾经因为「中午到中午」分桶被显示成 0 条
    assert.equal(counts.get("2026-04-22"), 60);
    assert.ok(!extremes.emptyDays.some((day) => day.date === "2026-04-22"), "2026-04-22 有 60 条告警，不能列为空态");
    // 真·零告警自然日只有 2026-05-20
    assert.deepEqual(extremes.emptyDays.map((day) => day.date), ["2026-05-20"]);
  });

  it("事件页把证据链解析成告警摘要", async () => {
    const data = await getEventData("EV-20260145");
    assert.equal(data.rows.length, 207);
    assert.equal(data.initialId, "EV-20260145");
    // 只投当前选中一条详情：207 条时间线全量序列化会把 HTML 撑到 700KB+
    assert.ok(data.detail);
    assert.equal(data.detail.incident.id, "EV-20260145");
    assert.equal(data.detail.alarms.length, data.detail.incident.alarm_ids.length);
    assert.ok(data.detail.alarms.every((alarm) => alarm.id.startsWith("AL-")));
    assert.ok(data.userNames["u-003"], "时间线 actor 要能映射到人名");
  });

  it("设备页只投影表格需要的字段（不塞完整 signal_series 与 OTA 历史）", async () => {
    const data = await getDeviceData();
    assert.equal(data.devices.length, 268);
    const sample = data.devices[0];
    assert.ok(sample.signalSeries.length <= 12);
    assert.ok(sample.otaRecords.length <= 2);
    const bytes = Buffer.byteLength(JSON.stringify(data), "utf8");
    assert.ok(bytes < 400 * 1024, `设备页 payload ${bytes} 字节，投影没生效`);
  });

  it("音频页加载频谱与转写，默认落到有转写的那一段", async () => {
    const data = await getAudioData(null);
    assert.ok(data);
    assert.equal(data.spectrum.bins * data.spectrum.cols > 0, true);
    assert.ok(data.transcript, "默认样本应带转写");
    assert.equal(data.transcript?.alarm_id, data.alarm.id);
    assert.ok(data.samples.length >= 12);

    const explicit = await getAudioData("AL-14398");
    assert.equal(explicit?.spectrum.id, "sp-001");
  });

  it("显式请求没有频谱的告警时返回空态，绝不顶替成别人的频谱（缺陷 3 回归）", async () => {
    // 数据里绝大多数告警没有落盘频谱（spectrum_id 为 null）
    const withoutSpectrum = await getAudioData("AL-11429");
    assert.equal(withoutSpectrum, null, "不能把 AL-14398 的频谱挂到 AL-11429 上");

    const unknown = await getAudioData("NOT-AN-ALARM");
    assert.equal(unknown, null, "不存在的 id 不能静默回落到默认样本");

    // 只有「完全没指定」时才允许默认兜底
    const fallback = await getAudioData(null);
    assert.ok(fallback);
    assert.equal(fallback.alarm.id, fallback.spectrum.alarm_id);
  });

  it("压力测试页能一次取到核心数据与极端值", async () => {
    const { core, extremes } = await getStressData();
    assert.ok(core.devices.length > 0);
    assert.equal(extremes.total, core.alarmsIndex._meta.total);
  });
});
