import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { loadCore, type Fetcher } from "./load";
import {
  AV_LEVELS,
  AV_LEVEL_ORDER,
  compactAge,
  formatCount,
  formatDelta,
  formatMinutes,
  formatPercent,
  formatSeconds,
  levelMeta,
  levelText,
  sceneMeta,
} from "./labels";
import {
  alarmCard,
  alarmPageCounts,
  dailySeries,
  gpuCards,
  heatmapDays,
  incidentRows,
  levelBreakdown,
  monitorChannels,
  overviewKpis,
  sceneCards,
  sceneDistribution,
  trendSeries,
  typeRanking,
  waveformOf,
} from "./view";
import type { DatasetCore } from "./types";

function resolveDataDir(): string {
  const candidates = [
    resolve(process.cwd(), "public/mock/av"),
    resolve(process.cwd(), "web/public/mock/av"),
    resolve(__dirname, "../../../public/mock/av"),
  ];
  const hit = candidates.find((dir) => existsSync(join(dir, "index.json")));
  assert.ok(hit, `找不到 mock 数据目录，试过：${candidates.join("，")}`);
  return hit;
}

const DATA_DIR = resolveDataDir();
const fetcher: Fetcher = async (url) => JSON.parse(readFileSync(url, "utf8")) as unknown;

let cache: Promise<DatasetCore> | null = null;
function core(): Promise<DatasetCore> {
  cache ??= loadCore(DATA_DIR, fetcher);
  return cache;
}

describe("语义映射（labels）", () => {
  it("告警四级各有独立 tone，且都能同时给出文字", () => {
    const tones = AV_LEVEL_ORDER.map((level) => levelMeta(level).tone);
    assert.deepEqual(tones, ["danger", "warning", "signal", "neutral"]);
    assert.equal(new Set(tones).size, 4, "四级必须四色，不能复用");

    for (const level of AV_LEVEL_ORDER) {
      assert.match(AV_LEVELS[level].short, /^[一二三四]级$/);
      assert.ok(AV_LEVELS[level].label.length >= AV_LEVELS[level].short.length);
      // 数据自带 level_label 时优先使用数据（如「二级·紧急」）
      assert.equal(levelText(level, "自定义·级别"), "自定义·级别");
      assert.equal(levelText(level, null), AV_LEVELS[level].label);
    }
  });

  it("三场景分色不借用告警三色", () => {
    assert.equal(sceneMeta("campus").tone, "signal");
    assert.equal(sceneMeta("hospital").tone, "violet");
    assert.equal(sceneMeta("justice").tone, "neutral");
  });

  it("数字格式化：千分位、百分数、环比、时长", () => {
    assert.equal(formatCount(14366), "14,366");
    assert.equal(formatPercent(93.34), "93.3%");
    assert.equal(formatPercent(100), "100%");
    assert.equal(formatDelta(-52.8), "−52.8%");
    assert.equal(formatDelta(0), "持平");
    assert.equal(formatMinutes(2.02), "2 分钟");
    assert.equal(formatMinutes(0.5), "30 秒");
    assert.equal(formatSeconds(66), "1 分 06 秒");
    assert.equal(compactAge(3), "3 分钟");
    assert.equal(compactAge(60 * 26), "1 天");
  });
});

describe("视图聚合（view）", () => {
  it("总览 KPI 用「今日自然日」，不是滚动 24 小时", async () => {
    const data = await core();
    const kpis = overviewKpis(data.kpi);
    const today = kpis.find((kpi) => kpi.key === "alarm-today");
    assert.ok(today);
    assert.equal(today.value, formatCount(data.kpi.alarm_natural_day));
    assert.notEqual(today.value, formatCount(data.kpi.alarm_last_24h));

    const device = kpis.find((kpi) => kpi.key === "device-online");
    assert.equal(device?.value, data.kpi.online_rate.toFixed(1));
    assert.match(device?.detail ?? "", new RegExp(formatCount(data.kpi.device_online)));
  });

  it("分级拆分取 alarm_unhandled_breakdown（不是今日全量）", async () => {
    const data = await core();
    const levels = levelBreakdown(data.kpi);
    assert.equal(levels.length, 4);
    for (const row of levels) {
      const expected = data.kpi.alarm_unhandled_breakdown.find((item) => item.level === row.level)?.count ?? 0;
      assert.equal(row.unhandled, expected);
      const today = data.kpi.level_breakdown_today.find((item) => item.level === row.level)?.count ?? 0;
      assert.equal(row.total, today);
    }
  });

  it("趋势数组翻成时间正序（左旧右新），热力图按自然日分组", async () => {
    const data = await core();
    const trend = trendSeries(data.trends);
    assert.equal(trend.length, data.trends.hourly.length);
    assert.equal(trend[0].label, [...data.trends.hourly].reverse()[0].label);
    assert.equal(trend.at(-1)?.label, data.trends.hourly[0].label);

    const daily = dailySeries(data.trends);
    assert.equal(daily[0].label, data.trends.daily.at(-1)?.label);

    const days = heatmapDays(data.trends);
    assert.equal(days.length, 7);
    assert.equal(days[0].cells.length, 24);
    assert.deepEqual(
      days[0].cells.map((cell) => cell.hour),
      Array.from({ length: 24 }, (_, hour) => hour),
    );
  });

  it("场景分布与场景卡都来自数据，颜色只由前端映射", async () => {
    const data = await core();
    const scenes = sceneDistribution(data.kpi);
    assert.equal(scenes.length, 3);
    for (const scene of scenes) {
      assert.ok(!("color" in scene), "场景不应带颜色字段（颜色由 tokens 提供）");
      assert.equal(scene.tone, sceneMeta(scene.scene).tone, "颜色由前端按 scene 映射");
      assert.ok(scene.site.length > 0, "站点名单独给，不能和场景名混用");
    }
    const cards = sceneCards(data);
    assert.equal(cards.length, 3);
    assert.equal(cards[0].points, data.scenes[0].kpi.points);
  });

  it("告警卡六要素齐全，级别文案来自数据", async () => {
    const data = await core();
    const { loadAlarmPage } = await import("./load");
    const page = await loadAlarmPage(data.alarmsIndex, null, 20, DATA_DIR, fetcher);
    for (const alarm of page.alarms) {
      const card = alarmCard(alarm, data);
      assert.ok(card.level >= 1 && card.level <= 4);
      assert.ok(card.levelLabel.length > 0, "级别必须有文字");
      assert.ok(card.levelShort.length > 0);
      assert.ok(card.title.length > 0);
      assert.ok(card.room.length > 0);
      assert.ok(card.siteName.length > 0);
      assert.ok(card.offsetMinutes >= 0);
      assert.ok(card.typeName.length > 0);
      assert.equal(card.deviceId, alarm.device_id);
    }
  });

  it("告警筛选计数只统计传进来的那一页", async () => {
    const data = await core();
    const { loadAlarmPage } = await import("./load");
    const page = await loadAlarmPage(data.alarmsIndex, null, 20, DATA_DIR, fetcher);
    const counts = alarmPageCounts(page.alarms);
    assert.equal(counts.all, page.alarms.length);
    assert.equal(
      counts.levels.reduce((sum, level) => sum + level.count, 0),
      page.alarms.length,
    );
    assert.equal(
      counts.scenes.reduce((sum, scene) => sum + scene.count, 0),
      page.alarms.length,
    );
  });

  it("监控通道取 6 路、优先在线，离线设备波形压到最低", async () => {
    const data = await core();
    const channels = monitorChannels(data.devices, 6);
    assert.equal(channels.length, 6);
    assert.ok(channels.some((device) => device.kind === "audio"));
    assert.ok(channels.some((device) => device.kind === "video"));
    assert.ok(channels.every((device) => device.status === "online"));

    const offline = data.devices.find((device) => device.status === "offline");
    assert.ok(offline);
    const bars = waveformOf(offline, 20);
    assert.equal(bars.length, 20);
    assert.ok(bars.every((value) => value <= 0.1), "离线设备是 0 哨兵，波形应为最低");
  });

  it("事件列表与 GPU 卡片的字段全部来自数据", async () => {
    const data = await core();
    const rows = incidentRows(data.incidents, data);
    assert.equal(rows.length, data.incidents.length);
    assert.ok(rows.every((row) => row.id && row.title && row.statusLabel));

    const cards = gpuCards(data.kpi);
    assert.equal(cards.length, data.kpi.gpu.cards.length);
    assert.equal(cards[0].vram, data.kpi.gpu.cards[0].vram_used_gb);

    assert.equal(typeRanking(data, 3).length, 3);
  });
});
