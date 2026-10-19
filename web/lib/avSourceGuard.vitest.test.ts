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

/**
 * 去掉注释后再扫描。
 *
 * 注释里写「浅色主题下 --av-surface 可能是 #fff」是在**解释**缺陷，不是在使用颜色；
 * 不过滤注释的话，说明文字本身会触发守卫，最后只能靠删注释来过 —— 那就把知识删掉了。
 */
/**
 * 遮蔽注释，但**保留字符串内容**（颜色字面量经常就写在字符串或数组里）。
 *
 * 不能用「行首斜杠斜杠」这种正则：它会把字符串里的两个斜杠当成注释开头，
 * 从那儿截断整行，紧跟着的三通道数组就漏扫了。这里按词法状态机走：只有处于
 * 代码态的行注释 / 块注释起始符才进入注释态，字符串与模板字符串里的斜杠原样保留。
 */
function maskComments(source: string): string {
  type State = "code" | "line" | "block" | "single" | "double" | "template";
  let state: State = "code";
  let out = "";
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (state === "code") {
      if (char === "/" && next === "/") {
        state = "line";
        out += "  ";
        index += 1;
        continue;
      }
      if (char === "/" && next === "*") {
        state = "block";
        out += "  ";
        index += 1;
        continue;
      }
      if (char === "'") state = "single";
      else if (char === '"') state = "double";
      else if (char === "`") state = "template";
      out += char;
      continue;
    }
    if (state === "line") {
      if (char === "\n") {
        state = "code";
        out += "\n";
      } else {
        out += " ";
      }
      continue;
    }
    if (state === "block") {
      if (char === "*" && next === "/") {
        state = "code";
        out += "  ";
        index += 1;
      } else {
        out += char === "\n" ? "\n" : " ";
      }
      continue;
    }
    // 字符串 / 模板字符串：保留字符（要扫里面的字面量），只处理转义与结束引号
    const quote = state === "single" ? "'" : state === "double" ? '"' : "`";
    if (char === "\\") {
      out += char + (next ?? "");
      index += 1;
      continue;
    }
    if (char === quote) state = "code";
    out += char;
  }
  return out;
}

const LIB_FILES = filesUnder("lib/av", /\.ts$/).filter((file) => !/\.test\.ts$/.test(file));

describe("AV 视觉基座：颜色只来自令牌", () => {
  it("组件源码里没有十六进制颜色字面量", () => {
    const offenders: string[] = [];
    for (const file of TSX_FILES) {
      const source = maskComments(readFileSync(file, "utf8"));
      const matches = source.match(/#[0-9a-fA-F]{3,8}\b/g);
      if (matches) offenders.push(`${file}: ${matches.join(", ")}`);
    }
    expect(offenders).toEqual([]);
  });

  it("组件源码里没有 [r, g, b] 形式的颜色数组（canvas 专用，易绕过 hex 守卫）", () => {
    // review 缺陷 2 就是靠这个形态躲过了上面的 #hex 扫描：
    //   `if (clean.length !== 6) return [108, 243, 255];`
    // 三元组本身在普通布局里没有用途，凡是三通道整数数组都按颜色处理。
    const offenders: string[] = [];
    for (const file of TSX_FILES) {
      const source = maskComments(readFileSync(file, "utf8"));
      const matches = source.match(/\[\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\]/g);
      if (matches) offenders.push(`${file}: ${matches.join(", ")}`);
    }
    expect(offenders).toEqual([]);
  });

  it("lib/av 里除 color.ts 外不出现颜色字面量（取色逻辑只允许一个入口）", () => {
    // 取色代码搬进 lib/av 之后，守卫的扫描根必须一起扩进来：否则将来有人在
    // lib/av 里写死一个色值，components 侧的扫描完全看不见。
    const offenders: string[] = [];
    for (const file of LIB_FILES) {
      if (file.endsWith("/color.ts")) continue;
      const source = maskComments(readFileSync(file, "utf8"));
      const hex = source.match(/#[0-9a-fA-F]{3,8}\b/g);
      const triple = source.match(/\[\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\]/g);
      const fn = source.match(/rgba?\([^)]*\)|hsla?\([^)]*\)/g);
      const found = [...(hex ?? []), ...(triple ?? []), ...(fn ?? [])];
      if (found.length) offenders.push(`${file}: ${found.join(", ")}`);
    }
    expect(offenders).toEqual([]);
  });

  it("注释遮蔽器不会把字符串里的 // 当注释（假阴性回归）", () => {
    // review 指出的盲区：正则版会把 `"x // y"` 截断，紧随其后的三通道数组漏扫。
    // 这条用例直接对遮蔽器的行为下断言（通过一个临时文件不便，故复刻同一逻辑调用）。
    const sample = 'const a = "x // y"; const bad = [108, 243, 255];';
    expect(maskComments(sample)).toContain("[108, 243, 255]");
    expect(maskComments('const a = "x"; // [108, 243, 255]')).not.toContain("[108, 243, 255]");
    expect(maskComments('/* [108, 243, 255] */ const ok = 1;')).not.toContain("[108, 243, 255]");
    expect(maskComments("const t = `/* not a comment */ [108, 243, 255]`;")).toContain("[108, 243, 255]");
  });

  it("canvas 取色统一走 lib/av/color，不在组件里自己解析", () => {
    const offenders: string[] = [];
    for (const file of TSX_FILES) {
      const source = maskComments(readFileSync(file, "utf8"));
      if (/parseInt\([^)]*16\)/.test(source)) offenders.push(file);
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
