import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  OVERVIEW_TREND_SERIES,
  overviewPeak,
  overviewRangeAtTick,
  overviewRangeModel,
} from "./view";
import type { OverviewRangeKey, OverviewRanges } from "./types";

/**
 * 总览页三档时间范围的契约（BLF-1424）。
 *
 * 这一组用例守的是**验收标准本身**，而不是实现细节：
 *   · 三个 range 下 KPI 四值 / 分级 / 趋势 / 热力窗口 / 场景分布**必须不同**；
 *   · 每档内部的「逐项相加 = 总量」必须成立（生成器换算法或有人手改 JSON 都会红）；
 *   · 「告警趋势」至少 4 条系列、颜色互不相同；
 *   · 演示帧只做「窗口滚动」：曲线长度不变、tick 越界被夹住、KPI 真的会变。
 *
 * 读的是真实落盘数据（与页面同一份），所以 `node scripts/mock/generate.mjs`
 * 重跑之后这里立刻能发现口径漂移。
 */
function resolveDataDir(): string {
  const candidates = [
    resolve(process.cwd(), "public/stream-monitor-data"),
    resolve(process.cwd(), "web/public/stream-monitor-data"),
  ];
  const hit = candidates.find((dir) => existsSync(join(dir, "index.json")));
  if (!hit) throw new Error(`找不到智能音视频平台数据目录，试过：${candidates.join("，")}`);
  return hit;
}

const data = JSON.parse(
  readFileSync(join(resolveDataDir(), "overview-ranges.json"), "utf8"),
) as OverviewRanges;

const keys = data._meta.range_order;
const ranges = keys.map((key) => data.ranges[key]);
const models = ranges.map((range) => overviewRangeModel(range));

function expectKey(key: string): OverviewRangeKey {
  return key as OverviewRangeKey;
}

describe("总览 · 三档时间范围的数据", () => {
  it("三档齐全，且顺序来自数据（页面 tab 的顺序由 JSON 决定）", () => {
    expect(keys).toEqual(["live", "today", "week"]);
    for (const key of keys) {
      const range = data.ranges[expectKey(key)];
      expect(range.key, key).toBe(key);
      expect(range.label.length).toBeGreaterThan(0);
      expect(range.kpi_defs).toHaveLength(4);
    }
  });

  it("三档的 KPI 四值各不相同（切换范围后四张卡真的换数）", () => {
    const tuples = models.map((model) => model.kpis.map((kpi) => `${kpi.label}=${kpi.value}${kpi.unit ?? ""}`));
    expect(new Set(tuples.map((tuple) => tuple.join("|"))).size, tuples.map((t) => t.join(" / ")).join("   ‖   ")).toBe(3);
    // 每一档的四个值也要互不相同（否则「四张卡」里有两张在重复说一件事）
    tuples.forEach((tuple, index) => {
      expect(new Set(tuple).size, `第 ${index + 1} 档的四张卡有重复值：${tuple.join(" / ")}`).toBe(4);
    });
  });

  it("分级构成 / 场景分布 / 趋势 / 热力 / 点位 / 类型六块数据三档都不一样", () => {
    const signature = (index: number) => {
      const model = models[index];
      return JSON.stringify({
        levels: model.levels.map((row) => row.total),
        scenes: model.scenes.map((row) => row.value),
        trend: model.trend.map((row) => [row.label, row.alarms, row.handled, row.incidents, row.falsePositive]),
        heat: model.heatmap.rows.map((row) => row.cells.map((cell) => cell.count)),
        points: model.points.map((row) => [row.room, row.total]),
        types: model.types.map((row) => [row.name, row.count]),
      });
    };
    const signatures = [0, 1, 2].map(signature);
    expect(new Set(signatures).size).toBe(3);
  });

  it("每档内部：趋势 / 分级 / 场景 / 热力逐项相加都等于总量", () => {
    for (const range of ranges) {
      const sum = (list: number[]) => list.reduce((total, value) => total + value, 0);
      expect(sum(range.trend.map((row) => row.alarms)), `${range.key} 趋势合计`).toBe(range.totals.alarms);
      expect(sum(range.levels.map((row) => row.total)), `${range.key} 分级合计`).toBe(range.totals.alarms);
      expect(sum(range.scenes.map((row) => row.count)), `${range.key} 场景合计`).toBe(range.totals.alarms);
      expect(
        sum(range.heatmap.rows.flatMap((row) => row.cells.map((cell) => cell.count))),
        `${range.key} 热力合计`,
      ).toBe(range.totals.alarms);
      // 已处置率 / 误报率与计数自洽（比率由生成器算好，这里反向校验一次）
      const alarms = range.totals.alarms;
      expect(range.totals.handled).toBeLessThanOrEqual(alarms);
      expect(range.totals.unhandled).toBeLessThanOrEqual(alarms);
      expect(range.totals.false_positive).toBeLessThanOrEqual(alarms);
      if (alarms > 0) {
        expect(range.totals.handled_rate).toBeCloseTo((range.totals.handled / alarms) * 100, 1);
        expect(range.totals.false_positive_rate).toBeCloseTo((range.totals.false_positive / alarms) * 100, 1);
      }
    }
  });

  it("热力窗口三档是三种形状（不是换了个数字的同一张图）", () => {
    const shapes = models.map((model) => ({
      rows: model.heatmap.rows.length,
      cells: model.heatmap.rows[0].cells.length,
      axis: model.heatmap.axis.filter((label) => label.length > 0),
    }));
    expect(shapes[0].rows).toBe(1); // live：滚动 24 小时，一行
    expect(shapes[1].rows).toBe(1); // today：今天，一行
    expect(shapes[2].rows).toBe(7); // week：7 个自然日
    for (const shape of shapes) expect(shape.cells).toBe(24);
    expect(shapes[2].axis).toEqual(shapes[1].axis); // 都是钟点轴
    expect(shapes[0].axis, "live 的刻度是滚动的真实钟点，不是 00/06/12/18").not.toEqual(shapes[1].axis);
  });

  it("「告警趋势」有 4 条系列，颜色互不相同，且每个数据点都能取到值", () => {
    expect(OVERVIEW_TREND_SERIES).toHaveLength(4);
    expect(new Set(OVERVIEW_TREND_SERIES.map((series) => series.tone)).size).toBe(4);
    expect(OVERVIEW_TREND_SERIES.map((series) => series.label)).toEqual(["告警", "已处置", "事件", "误报"]);
    for (const model of models) {
      for (const series of OVERVIEW_TREND_SERIES) {
        expect(model.trend.every((row) => typeof row[series.key] === "number"), series.key).toBe(true);
      }
    }
  });

  it("峰值标注落在当前曲线的最高点上", () => {
    for (const model of models) {
      const peak = overviewPeak(model.trend);
      expect(peak.value).toBe(Math.max(...model.trend.map((row) => row.alarms)));
      const row = model.trend.find((item) => item.label === peak.label);
      expect(row?.alarms, `${model.key} 的峰值点必须能在曲线上找到`).toBe(peak.value);
    }
  });
});

describe("总览 · 演示态推进", () => {
  it("每推进一帧：曲线长度不变、KPI 会变、脉冲落在热力网格内", () => {
    for (const model of models) {
      const frames = model.stream.frames;
      expect(model.stream.tickSeconds).toBeGreaterThanOrEqual(4);
      expect(model.stream.tickSeconds).toBeLessThanOrEqual(6);
      expect(frames.length).toBeGreaterThanOrEqual(2);

      const base = overviewRangeAtTick(model, 0);
      expect(base.pulse).toBeNull();
      expect(base.trend).toHaveLength(model.trend.length);

      const seen = new Set(base.kpis.map((kpi) => `${kpi.label}=${kpi.value}`));
      for (let tick = 1; tick <= frames.length; tick += 1) {
        const frame = overviewRangeAtTick(model, tick);
        expect(frame.trend).toHaveLength(model.trend.length);
        expect(frame.trend[frame.trend.length - 1]?.label).toBe(frames[tick - 1].label);
        expect(frame.pulse).not.toBeNull();
        const row = model.heatmap.rows[frame.pulse!.row];
        expect(row, `${model.key} tick ${tick} 的脉冲行越界`).toBeTruthy();
        expect(row.cells.some((cell) => cell.hour === frame.pulse!.hour)).toBe(true);
        for (const kpi of frame.kpis) seen.add(`${kpi.label}=${kpi.value}`);
      }
      // 至少有一张卡在推进中真的变了（否则「KPI 微幅变化」只是文案）
      expect(seen.size, `${model.key} 的演示帧没有带来任何 KPI 变化`).toBeGreaterThan(4);
    }
  });

  it("tick 越界被夹住（不会读到不存在的帧）", () => {
    for (const model of models) {
      const last = overviewRangeAtTick(model, model.stream.frames.length);
      const beyond = overviewRangeAtTick(model, model.stream.frames.length + 99);
      expect(beyond).toEqual(last);
      expect(overviewRangeAtTick(model, -1)).toEqual({
        kpis: model.kpis,
        trend: model.trend,
        totals: model.totals,
        peak: model.peak,
        pulse: null,
      });
    }
  });
});
