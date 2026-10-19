import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * AV 视觉基座的源码契约（AC5 / AC6）。
 *
 * Stage 2 的两条硬约束，靠“看代码”无法保证，必须让 CI 来守：
 *   · 组件里不允许出现颜色字面量（颜色只能来自 CSS 变量 / 令牌）；
 *   · 页面组件里不允许出现业务数字（数量、总量、条数必须来自 /mock/av）。
 *
 * 纯源码扫描，不渲染，因此放在 node 环境的 vitest 里。
 */

const AV_SOURCES = [
  "app/av",
  "components/av",
];

function filesUnder(dir: string, extension: RegExp): string[] {
  const root = resolve(process.cwd(), dir);
  const out: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = `${current}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (extension.test(entry.name)) out.push(path);
    }
  };
  walk(root);
  return out;
}

const TSX_FILES = AV_SOURCES.flatMap((dir) => filesUnder(dir, /\.tsx?$/));
const CSS_FILES = AV_SOURCES.flatMap((dir) => filesUnder(dir, /\.css$/));

describe("AV 视觉基座：颜色只来自令牌", () => {
  it("组件源码里没有十六进制颜色字面量", () => {
    const offenders: string[] = [];
    for (const file of TSX_FILES) {
      const source = readFileSync(file, "utf8");
      const matches = source.match(/#[0-9a-fA-F]{3,8}\b/g);
      if (matches) offenders.push(`${file}: ${matches.join(", ")}`);
    }
    expect(offenders).toEqual([]);
  });

  it("CSS 模块里的颜色全部是 var(--...) 引用", () => {
    const offenders: string[] = [];
    for (const file of CSS_FILES) {
      const source = readFileSync(file, "utf8");
      const colorValues = source.match(/(?:^|[:\s])(#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\))/g);
      if (colorValues) offenders.push(`${file}: ${colorValues.join(", ")}`);
    }
    expect(offenders).toEqual([]);
  });

  it("AV 令牌层全部映射到主工作台既有语义 token（深浅主题自动跟随）", () => {
    const globals = readFileSync(resolve(process.cwd(), "app/globals.css"), "utf8");
    const start = globals.indexOf("--av-canvas:");
    const end = globals.indexOf("\n}", start);
    expect(start).toBeGreaterThan(0);
    const block = globals.slice(start, end);
    const declarations = Array.from(block.matchAll(/--av-([\w-]+):\s*([^;]+);/g));
    expect(declarations.length).toBeGreaterThan(20);
    for (const [, name, value] of declarations) {
      expect(value.trim(), `--av-${name} 必须引用既有令牌`).toMatch(/^var\(--[\w-]+\)$/);
    }
  });

  it("告警四级在令牌层各自独立，且第三级使用信号青", () => {
    const globals = readFileSync(resolve(process.cwd(), "app/globals.css"), "utf8");
    expect(globals).toContain("--av-level-1: var(--danger)");
    expect(globals).toContain("--av-level-2: var(--warn)");
    expect(globals).toContain("--av-level-3: var(--brand)");
    expect(globals).toContain("--av-level-4: var(--ink-3)");
  });
});

describe("AV 页面：业务数字不落进组件", () => {
  it("数据集总量不出现在页面源码里（只能来自 JSON）", () => {
    const forbidden = ["14366", "14,366", "268", "207", "259195"];
    const pageFiles = filesUnder("components/av/pages", /\.tsx$/).concat(filesUnder("app/av", /\.tsx?$/));
    const offenders: string[] = [];
    for (const file of pageFiles) {
      const source = readFileSync(file, "utf8");
      for (const token of forbidden) {
        if (source.includes(token)) offenders.push(`${file}: ${token}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("所有数字展示走 tabular-nums（表格 / KPI / 时间戳）", () => {
    const pagesCss = readFileSync(resolve(process.cwd(), "components/av/pages/AvPages.module.css"), "utf8");
    const uiCss = readFileSync(resolve(process.cwd(), "components/av/AvUI.module.css"), "utf8");
    expect(pagesCss).toMatch(/font-variant-numeric:\s*tabular-nums/);
    expect(uiCss).toMatch(/font-variant-numeric:\s*tabular-nums/);
    expect(uiCss).toMatch(/\.metricValue[\s\S]*?tabular-nums/);
  });
});
