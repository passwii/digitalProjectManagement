import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AV_SERIES_INDEXES,
  AV_SERIES_TONES,
  colorVar,
  isSeriesTone,
  seriesIndexOf,
  seriesToneFor,
  seriesVar,
  toneVar,
} from "@/lib/av/tone";

/**
 * 多色令牌体系的契约（BLF-1423 · Stage 1）。
 *
 * 这一层要守住的是「颜色丰富起来，但仍然只有一个真源」：
 *   · 数据系列色 `--av-series-1..8` 全部是主工作台令牌的**别名**，AV 分层里不出现色值 ——
 *     否则浅色主题就要再抄一份，迟早有两套对不上的色；
 *   · 每个别名指向的基础令牌必须在 `:root` 与 `:root[data-theme="light"]` 里**都存在**，
 *     这就是「浅色主题同步给一套」的可执行版本；
 *   · 系列色在浅色主题的白底上对比度 ≥ 3:1（图表线不是文字，3:1 是可见性下限），
 *     避免「柠檬色按钮底」那种只在深色下成立的取值混进图表；
 *   · 分层表面 `--av-surface-1/2/3` 与每页一档的 `--av-tint-*` 都已声明；
 *   · `lib/av/tone.ts` 的三个入口（toneVar / seriesVar / colorVar）行为固定。
 */

const globals = readFileSync(resolve(process.cwd(), "app/globals.css"), "utf8");

/** 从标记处切到该块结束的 `}`（globals.css 的令牌块都是扁平声明，足够用）。 */
function block(startMarker: string): string {
  const start = globals.indexOf(startMarker);
  expect(start, `globals.css 里找不到 ${startMarker}`).toBeGreaterThanOrEqual(0);
  const end = globals.indexOf("\n}", start);
  expect(end).toBeGreaterThan(start);
  return globals.slice(start, end);
}

function declarations(source: string): Record<string, string> {
  return Object.fromEntries(
    Array.from(source.matchAll(/--([\w-]+):\s*([^;]+);/g), ([, name, value]) => [name, value.trim()]),
  );
}

const avTokens = declarations(block("--av-canvas:"));
/* globals.css 的第一个 `:root {` 就是暗色主题的令牌块（文件第 1 行开始）。 */
const darkTokens = declarations(block(":root {"));
const lightTokens = declarations(block(':root[data-theme="light"] {'));

/** 解一层 var()（系列色 → 基础令牌 → 色值），够本文件的所有链路使用。 */
function resolveColor(value: string, table: Record<string, string>): string {
  const match = value.match(/^var\(--([\w-]+)\)$/);
  return match ? resolveColor(table[match[1]] ?? "", table) : value;
}

function luminance(color: string): number {
  const channels = color
    .match(/#([a-f\d]{6})/i)?.[1]
    ?.match(/[a-f\d]{2}/gi)
    ?.map((channel) => {
      const value = parseInt(channel, 16) / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
  if (!channels || channels.length !== 3) throw new Error(`需要不透明 hex 色值，拿到 ${color}`);
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function contrast(foreground: string, background: string): number {
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

describe("数据系列色：8 档，全部是别名", () => {
  it("--av-series-1..8 都已声明，且都是 var() 引用（AV 分层里没有色值）", () => {
    for (const index of AV_SERIES_INDEXES) {
      const value = avTokens[`av-series-${index}`];
      expect(value, `globals.css 缺少 --av-series-${index}`).toBeDefined();
      expect(value, `--av-series-${index} 必须引用主令牌`).toMatch(/^var\(--[\w-]+\)$/);
    }
  });

  it("8 个系列指向 8 个**不同**的基础令牌（不是同一个色换名字）", () => {
    const targets = AV_SERIES_INDEXES.map((index) => avTokens[`av-series-${index}`]);
    expect(new Set(targets).size, `重复的系列色：${targets.join(" / ")}`).toBe(8);
  });

  it("AV 层每个别名链最终指向的基础令牌在深浅两套主题里都存在", () => {
    /**
     * AV 层内部还有一跳：`--av-tone-signal → --av-signal → --brand`。
     * 所以要顺着 avTokens 往下走，直到离开 AV 层（拿到一个不在 avTokens 里的令牌名），
     * 那才是主工作台令牌层该提供的东西。
     */
    const rootToken = (name: string): string => {
      const next = avTokens[name]?.match(/^var\(--([\w-]+)\)$/)?.[1];
      if (!next) return name;
      return next in avTokens ? rootToken(next) : next;
    };

    const missing: string[] = [];
    for (const [name, value] of Object.entries(avTokens)) {
      if (!/^var\(--[\w-]+\)$/.test(value)) {
        missing.push(`--${name} 不是别名（${value}）`);
        continue;
      }
      const base = rootToken(name);
      if (!(base in darkTokens)) missing.push(`:root 缺少 --${base}（--${name}）`);
      if (!(base in lightTokens)) missing.push(`浅色主题缺少 --${base}（--${name}）`);
    }
    expect(missing).toEqual([]);
  });

  it("浅色主题下 8 个系列色对卡片底对比度 ≥ 3:1（折线在白底上必须看得见）", () => {
    const offenders: string[] = [];
    for (const index of AV_SERIES_INDEXES) {
      const color = resolveColor(avTokens[`av-series-${index}`], lightTokens);
      const ratio = contrast(color, lightTokens.card);
      if (ratio < 3) offenders.push(`--av-series-${index} = ${color}，对比度 ${ratio.toFixed(2)}`);
    }
    expect(offenders).toEqual([]);
  });

  it("深色主题下 8 个系列色对卡片底对比度 ≥ 3:1", () => {
    const offenders: string[] = [];
    for (const index of AV_SERIES_INDEXES) {
      const color = resolveColor(avTokens[`av-series-${index}`], darkTokens);
      const ratio = contrast(color, darkTokens.card);
      if (ratio < 3) offenders.push(`--av-series-${index} = ${color}，对比度 ${ratio.toFixed(2)}`);
    }
    expect(offenders).toEqual([]);
  });
});

describe("分层表面与每页光晕", () => {
  it("--av-surface-1/2/3 三档已声明且互不相同（暗色不再只有一个深蓝）", () => {
    const values = [1, 2, 3].map((tier) => avTokens[`av-surface-${tier}`]);
    values.forEach((value, index) => {
      expect(value, `缺少 --av-surface-${index + 1}`).toBeDefined();
      expect(value).toMatch(/^var\(--[\w-]+\)$/);
    });
    expect(new Set(values).size).toBe(3);
  });

  it("五个页面的光晕令牌都已声明（每页一档色相）", () => {
    for (const page of ["overview", "monitor", "alarm", "event", "device"]) {
      expect(avTokens[`av-tint-${page}`], `缺少 --av-tint-${page}`).toMatch(/^var\(--[\w-]+\)$/);
    }
    const tints = ["overview", "monitor", "alarm", "event", "device"].map((page) => avTokens[`av-tint-${page}`]);
    expect(new Set(tints).size, "光晕色不应互相重复").toBe(5);
  });
});

describe("tone.ts：语义色与系列色共用同一个入口", () => {
  it("seriesVar / toneVar 产出对应令牌引用", () => {
    expect(seriesVar(1)).toBe("var(--av-series-1)");
    expect(seriesVar(8)).toBe("var(--av-series-8)");
    expect(toneVar("danger")).toBe("var(--av-tone-danger)");
  });

  it("colorVar 按前缀分流：series-* 走 --av-series-*，其余走 --av-tone-*", () => {
    expect(colorVar("series-4")).toBe("var(--av-series-4)");
    expect(colorVar("signal")).toBe("var(--av-tone-signal)");
    expect(isSeriesTone("series-2")).toBe(true);
    expect(isSeriesTone("success")).toBe(false);
    expect(seriesIndexOf("series-7")).toBe(7);
  });

  it("seriesToneFor 按序号循环取色，越界回绕", () => {
    expect(seriesToneFor(0)).toBe("series-1");
    expect(seriesToneFor(7)).toBe("series-8");
    expect(seriesToneFor(8)).toBe("series-1");
    expect(seriesToneFor(-3)).toBe("series-4");
    expect(AV_SERIES_TONES).toHaveLength(8);
  });

  it("图表层从令牌读系列色（不是把 8 个色写死在组件里）", () => {
    const charts = readFileSync(resolve(process.cwd(), "components/av/AvCharts.tsx"), "utf8");
    expect(charts).toContain("--av-series-${index}");
    expect(charts).toContain("isSeriesTone(tone)");
    expect(charts).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});
