import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { AV_CHART_HEIGHT } from "./chartHeights";

/**
 * 智能音视频平台 排版标定契约（Stage 6 / BLF-1399）。
 *
 * 背景：改之前，8 个页面共用两份 CSS，但各页的卡片是自己写的 ——
 * 页面级 gap 有 12 / 10 / 8 / 7 / 6 / 5 / 3 / 2px，卡片内边距有
 * 16 / 14 / 12 / 11 / 9px，同一栅格内的卡片还各写各的 `align-items: start`。
 * 结果就是 Yawei 反馈的「页面的卡片排版，高度不一，各种问题都有」。
 *
 * 这里守四件事：
 *   1. **间距刻度**：站点 CSS 里的间距字面量只允许落在刻度集合内
 *      （4 / 8 / 12 / 16 / 24），不在集合内的会失败并打印位置；
 *   2. **卡片圆角**：卡片类选择器不得出现非零圆角（站点规范是直角）；
 *   3. **同类型卡片等高**：同类卡片的 min-height 必须一致，且消费同一个令牌；
 *   4. **栅格对齐**：栅格容器的 align-items 落在允许的取值集合内。
 *
 * ⚠️ 「允许集合」写成**集合**而不是「某个具体值」：以后想把 12px 调到 16px
 * 只要两边都在集合里就不会红 —— 守卫要防的是「参差」，不是「不许调尺寸」。
 *
 * 放在 vitest（`npm run test:motion`）而不是 node:test：这一套是「读 CSS 源码 +
 * 正则扫描」的守卫，vitest 的 expect 报错能直接把违规文件名与片段打出来
 * （与 avSourceGuard 同源思路）。
 */

/** 站点 CSS 文件（两份共用的卡片/面板/栅格样式 + 图表容器）。 */
const CSS_FILES = [
  "components/av/AvUI.module.css",
  "components/av/pages/AvPages.module.css",
  "components/av/AvCharts.module.css",
] as const;

/**
 * 间距刻度：4px 基准，全站只允许这五档。
 *
 * 与 globals.css 的 `--av-space-1..5` 一一对应（这里断言的是「CSS 里只允许
 * 出现这些字面量」，而实际取值由 CSS 里的 var() 引用提供）。
 */
const SPACE_SCALE = [4, 8, 12, 16, 24] as const;

/**
 * 允许出现的**非刻度**间距值及其理由。
 *
 * 这些不是「忘了归并」，而是**结构偏移**：1px 补偿、2px 发丝缝、3px 文本高亮
 * 的内边距。把它们列出来而不是放到允许集合里，是为了让守卫在报错时
 * 指出「这个值是刻度外的，需要重新归并」而不是默默放过。
 */
const STRUCTURAL_OFFSETS = new Set([0, 1, 2, 3]);

/** 卡片类选择器：站点规范是直角（DESIGN.md 的 rounded.square = 0）。 */
const CARD_SELECTORS = [
  ".panel",
  ".metric",
  ".channel",
  ".sceneCard",
  ".statusCell",
  ".algoCard",
  ".chainStep",
  ".evidenceItem",
  ".dialog",
  ".ghostButton",
  ".primaryAction",
  ".secondaryAction",
  ".dialogClose",
  ".tab",
] as const;

/** 徽标 / 芯片类：胶囊圆角是允许的（且是识别信号的一部分）。 */
const PILL_SELECTORS = [
  ".levelBadge",
  ".tag",
  ".tagChip",
  ".headerChip",
  ".streamType",
  ".alarmType",
  ".keywordChip",
  ".channelLive",
] as const;

/**
 * 同类卡片：选择器 → 必须一致的最小高度令牌。
 *
 * 「同类卡片必须一致」是这次标定的核心 —— 之前 `.metric` 有 min-height、
 * `.channelStage` 是固定 height、`.statusCell` 干脆没有，于是同一行里
 * 三个高度各写各的。
 */
const CARD_MIN_HEIGHT_TOKENS: Record<string, string> = {
  metric: "--av-card-min-metric",
  statusCell: "--av-card-min-status",
  sceneCard: "--av-card-min-scene",
  channel: "--av-card-min-channel",
};

/**
 * 栅格容器：允许的 align-items 取值。
 *
 * 写「集合」而不是「某个具体值」：以后把 stretch 改成 center 也得先在
 * 集合里加一项并说明理由，而不是直接被拦下。
 */
const GRID_ALIGN_VALUES = new Set([
  "stretch",
  "start",
  "center",
  "end",
  "baseline",
  "normal",
  // flex 专有：面板头 / 页面头是 flex 容器，标题与右侧动作要顶部对齐
  "flex-start",
  "flex-end",
]);

function read(relative: string): string {
  return readFileSync(resolve(process.cwd(), relative), "utf8");
}

const cssFiles = CSS_FILES.map((file) => ({ file, source: read(file) }));
const globals = read("app/globals.css");

/**
 * 去掉 CSS 注释后再扫描。
 *
 * 注释里写「改之前是 13px / 15px」是在**解释**归并的原因，不是在使用它；
 * 不过滤注释的话，说明文字本身会触发守卫，最后只能靠删注释来过 ——
 * 那就把知识删掉了。
 */
function maskComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "));
}

/**
 * 取出某个选择器的声明体。
 *
 * 按「选择器 + `{`」定位，再按花括号配平取到对应的 `}` ——
 * 直接用 `\.name\s*\{([^}]*)\}` 在遇到 `}` 出现在选择器里时会截错。
 */
function ruleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`${escaped}\\s*\\{`, "g");
  const match = pattern.exec(css);
  if (!match) return "";
  const start = match.index + match[0].length;
  let depth = 1;
  for (let index = start; index < css.length; index += 1) {
    const char = css[index];
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(start, index);
    }
  }
  return "";
}

/** 取出 `@media (max-width: Npx)` 断点块的正文。 */
function mediaBlock(css: string, maxWidth: number): string {
  const pattern = new RegExp(`@media\\s*\\(max-width:\\s*${maxWidth}px\\)\\s*\\{`, "g");
  const match = pattern.exec(css);
  if (!match) return "";
  const start = match.index + match[0].length;
  let depth = 1;
  for (let index = start; index < css.length; index += 1) {
    const char = css[index];
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(start, index);
    }
  }
  return "";
}

/** 声明体里的间距属性（gap / padding / margin）及其值。 */
const SPACING_DECLARATION =
  /(?<![\w-])(?:gap|row-gap|column-gap|padding(?:-(?:top|right|bottom|left))?|margin(?:-(?:top|right|bottom|left))?)\s*:\s*([^;{}]+);/g;

/** 一条间距字面量违规。 */
interface SpacingOffender {
  file: string;
  value: string;
  context: string;
}

/**
 * 扫一份 CSS 里的间距字面量。
 *
 * 只看**间距属性**（gap / padding / margin）—— 字号、行高、边框宽度、
 * 图表高度、图标尺寸是别的量纲，不受这套刻度约束。
 *
 * 令牌引用（`var(--av-space-3)`）不参与判定：刻度本身由 globals.css 声明，
 * 守卫只确保「CSS 里不再出现裸的刻度外数值」。
 */
function spacingOffenders(file: string, source: string): SpacingOffender[] {
  const offenders: SpacingOffender[] = [];
  const masked = maskComments(source);
  for (const match of Array.from(masked.matchAll(SPACING_DECLARATION))) {
    const value = match[1].trim();
    // var() / calc() / % / auto 都不是字面量，不参与判定
    const literals = value.match(/-?\d+(?:\.\d+)?px/g);
    if (!literals) continue;
    for (const literal of literals) {
      const pixels = Number(literal.replace("px", ""));
      if (SPACE_SCALE.includes(pixels as (typeof SPACE_SCALE)[number])) continue;
      if (STRUCTURAL_OFFSETS.has(pixels)) continue;
      offenders.push({ file, value: literal, context: value });
    }
  }
  return offenders;
}

describe("智能音视频平台 排版标定：间距刻度（BLF-1399）", () => {
  it("globals.css 声明了完整的间距刻度", () => {
    const declared = SPACE_SCALE.map((pixels, index) => {
      const name = `--av-space-${index + 1}`;
      const match = new RegExp(`${name}:\\s*(\\d+)px;`).exec(globals);
      expect(match, `globals.css 缺少 ${name}`).not.toBeNull();
      expect(match![1], `${name} 必须等于刻度值 ${pixels}px`).toBe(String(pixels));
      return name;
    });
    expect(declared).toHaveLength(SPACE_SCALE.length);
  });

  it("站点 CSS 里没有刻度外的间距字面量", () => {
    const offenders: string[] = [];
    for (const { file, source } of cssFiles) {
      for (const offender of spacingOffenders(file, source)) {
        offenders.push(
          `${offender.file}: ${offender.value}（声明值「${offender.context}」）不在间距刻度 ` +
            `${SPACE_SCALE.join(" / ")} 内 —— 请改用 var(--av-space-*) 或归并到刻度上`,
        );
      }
    }
    expect(offenders).toEqual([]);
  });

  it("页面级与卡内 gap 是两档，不夹着中间值", () => {
    // 页面级 12px（--av-gap-section）与卡内 8px（--av-gap-card）之间
    // 不允许出现 10px 这样的中间值 —— 那正是「层级差消失」的表现。
    const expectations: Array<[string, string]> = [
      ["--av-gap-section", "var(--av-space-3)"],
      ["--av-gap-card", "var(--av-space-2)"],
    ];
    for (const pair of expectations) {
      const name = pair[0];
      const expected = pair[1];
      const match = new RegExp(`${name}:\\s*([^;]+);`).exec(globals);
      expect(match, `globals.css 缺少 ${name}`).not.toBeNull();
      expect(match![1].trim(), `${name} 必须是 ${expected}`).toBe(expected);
    }
  });
});

describe("智能音视频平台 排版标定：卡片圆角与边界（BLF-1399）", () => {
  it("卡片类选择器没有非零圆角（站点规范是直角）", () => {
    const offenders: string[] = [];
    for (const { file, source } of cssFiles) {
      for (const selector of CARD_SELECTORS) {
        const body = ruleBody(source, selector);
        if (!body) continue;
        const match = /border-radius:\s*([^;]+);/.exec(body);
        if (!match) continue; // 没写 = 0 = 直角，合法
        const value = match[1].trim();
        // var(--av-radius-card) 解析后是 0px；calc(var(--av-radius-pill)) 是胶囊，不该出现在卡片上
        if (value === "var(--av-radius-card)" || value === "0" || value === "0px") continue;
        offenders.push(`${file}: ${selector} 的 border-radius = ${value}，卡片必须是直角`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("徽标类选择器走胶囊令牌（识别信号不能丢）", () => {
    const offenders: string[] = [];
    for (const { file, source } of cssFiles) {
      for (const selector of PILL_SELECTORS) {
        const body = ruleBody(source, selector);
        if (!body) continue;
        if (!/border-radius:\s*var\(--av-radius-pill\);/.test(body)) {
          offenders.push(`${file}: ${selector} 必须消费 var(--av-radius-pill)`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("圆角令牌本身是直角 0 与胶囊两档", () => {
    expect(globals).toMatch(/--av-radius-card:\s*0px;/);
    expect(globals).toMatch(/--av-radius-pill:\s*calc\(var\(--av-ctl-badge\) \/ 2\);/);
  });
});

describe("智能音视频平台 排版标定：同类卡片等高（BLF-1399）", () => {
  it("同类卡片的 min-height 消费同一个令牌", () => {
    const offenders: string[] = [];
    for (const { file, source } of cssFiles) {
      for (const [selector, token] of Object.entries(CARD_MIN_HEIGHT_TOKENS)) {
        const body = ruleBody(source, `.${selector}`);
        if (!body) continue;
        if (!new RegExp(`min-height:\\s*var\\(${token}\\)`).test(body)) {
          offenders.push(`${file}: .${selector} 必须消费 var(${token}) 作为最小高度`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("度量卡与状态格的最小高度令牌已经声明", () => {
    for (const token of Object.values(CARD_MIN_HEIGHT_TOKENS)) {
      expect(globals, `globals.css 缺少 ${token}`).toMatch(new RegExp(`${token}:\\s*\\d+px;`));
    }
  });

  it("度量卡的脚注区预留两行（有 note 与没 note 的卡一样高）", () => {
    // 这是「四张度量卡底边对齐」的具体机制：脚注区固定两行，
    // 于是带 note 的卡不会比不带的高一截。
    const ui = cssFiles.find((entry) => entry.file.endsWith("AvUI.module.css"))!;
    const body = ruleBody(ui.source, ".metricFoot");
    expect(body).not.toBe("");
    const minHeight = /min-height:\s*(\d+)px;/.exec(body);
    expect(minHeight, ".metricFoot 必须有 min-height（预留两行脚注）").not.toBeNull();
    expect(Number(minHeight![1]), "脚注区至少要装下两行（11px + 10px）").toBeGreaterThanOrEqual(30);
  });
});

describe("智能音视频平台 排版标定：栅格对齐（BLF-1399）", () => {
  it("同行等高的栅格容器走 stretch（不是 start）", () => {
    // 之前是 align-items: start —— 卡片按内容高度自由伸缩，
    // 同一行里左边的卡 300px、右边的卡 180px，底边参差不齐。
    const offenders: string[] = [];
    const equalHeightGrids = [
      { file: "components/av/pages/AvPages.module.css", selector: ".gridTwo" },
      { file: "components/av/pages/AvPages.module.css", selector: ".gridThree" },
      { file: "components/av/pages/AvPages.module.css", selector: ".splitWide" },
      { file: "components/av/pages/AvPages.module.css", selector: ".metricGrid" },
      { file: "components/av/pages/AvPages.module.css", selector: ".statusGrid" },
      { file: "components/av/pages/AvPages.module.css", selector: ".channelGrid" },
      { file: "components/av/pages/AvPages.module.css", selector: ".sceneGrid" },
      { file: "components/av/pages/AvPages.module.css", selector: ".stressGrid" },
      { file: "components/av/AvUI.module.css", selector: ".grid2" },
      { file: "components/av/AvUI.module.css", selector: ".grid3" },
      { file: "components/av/AvUI.module.css", selector: ".split" },
      { file: "components/av/AvUI.module.css", selector: ".splitWide" },
    ];
    for (const contract of equalHeightGrids) {
      const entry = cssFiles.find((item) => item.file === contract.file)!;
      const body = ruleBody(entry.source, contract.selector);
      if (!body) continue;
      const match = /align-items:\s*([^;]+);/.exec(body);
      if (!match) {
        offenders.push(`${contract.file}: ${contract.selector} 必须显式声明 align-items: stretch`);
        continue;
      }
      if (match[1].trim() !== "stretch") {
        offenders.push(
          `${contract.file}: ${contract.selector} 的 align-items = ${match[1].trim()}，` +
            `同行等高的栅格必须是 stretch`,
        );
      }
    }
    expect(offenders).toEqual([]);
  });

  it("栅格容器的 align-items 落在允许取值集合内", () => {
    const offenders: string[] = [];
    for (const { file, source } of cssFiles) {
      const masked = maskComments(source);
      // 只看「display: grid / flex」的容器里的 align-items
      for (const match of Array.from(masked.matchAll(/([^{}]+)\{([^{}]*)\}/g))) {
        const body = match[2];
        if (!/display:\s*(?:grid|inline-grid|flex|inline-flex)\s*;/.test(body)) continue;
        const align = /align-items:\s*([^;]+);/.exec(body);
        if (!align) continue;
        const value = align[1].trim();
        if (!GRID_ALIGN_VALUES.has(value)) {
          offenders.push(`${file}: ${match[1].trim().split("\n").pop()?.trim()} 的 align-items = ${value}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("竖向侧栏 .railStack 走 align-content: start（独立面板不强行等高）", () => {
    // 这是**显式**的第二种对齐策略：右栏是若干互相独立的面板，
    // 强行等高只会让内容少的面板空出一大片。写死在这里是为了让
    // 以后有人「顺手改成 stretch」时 CI 拦下来。
    const pages = cssFiles.find((entry) => entry.file.endsWith("AvPages.module.css"))!;
    const body = ruleBody(pages.source, ".railStack");
    expect(body).not.toBe("");
    expect(body).toMatch(/align-content:\s*start;/);
  });

  it("三个断点下降列后同行等高依然成立", () => {
    // 之前三个断点只改 grid-template-columns，卡片高度参差在窄屏下更明显。
    // 现在每个断点都要保证：降列之后仍然是 stretch，且留白同步收一档。
    //
    // 只看**页面级栅格容器**（.gridTwo / .gridThree / .splitWide / .metricGrid 等）——
    // 卡片内部的局部对齐（如 .alarmCard 的 align-items: start）是另一回事，
    // 不该被这条守卫管到。
    const pages = cssFiles.find((entry) => entry.file.endsWith("AvPages.module.css"))!;
    const pageGrids = [
      ".gridTwo",
      ".gridThree",
      ".splitWide",
      ".metricGrid",
      ".statusGrid",
      ".channelGrid",
      ".sceneGrid",
      ".stressGrid",
    ];
    for (const breakpoint of [1180, 900, 720]) {
      const block = mediaBlock(pages.source, breakpoint);
      expect(block, `AvPages.module.css 缺少 @media (max-width: ${breakpoint}px)`).not.toBe("");
      for (const grid of pageGrids) {
        const escaped = grid.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const rule = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(block);
        if (!rule) continue;
        const align = /align-items:\s*([^;]+);/.exec(rule[1]);
        if (!align) continue;
        expect(
          align[1].trim(),
          `≤${breakpoint}px 段的 ${grid} 不允许把 align-items 改回 ${align[1].trim()}（会打断同行等高）`,
        ).not.toBe("start");
      }
    }
  });

  it("窄屏同时收一档留白（gap 与面板内边距）", () => {
    // 720px 段：页面级 gap 收到 8px、面板内边距收到 12px。
    // 只改列数不收留白，窄屏上一张卡子的左右内边距会吃掉太多可视宽度。
    const pages = cssFiles.find((entry) => entry.file.endsWith("AvPages.module.css"))!;
    const block = mediaBlock(pages.source, 720);
    expect(block).toMatch(/\.page\s*\{[^}]*gap:\s*var\(--av-space-2\)/);

    const ui = cssFiles.find((entry) => entry.file.endsWith("AvUI.module.css"))!;
    const uiBlock = mediaBlock(ui.source, 720);
    expect(uiBlock).toMatch(/\.panelHeader\s*\{[^}]*var\(--av-space-3\)/);
    expect(uiBlock).toMatch(/\.panelBody\s*\{[^}]*var\(--av-space-3\)/);
  });
});

describe("智能音视频平台 排版标定：图表高度档位（BLF-1399）", () => {
  it("图表高度只有三档，且 globals.css 与 TS 一致", () => {
    expect(Object.values(AV_CHART_HEIGHT).sort((a, b) => a - b)).toEqual([128, 176, 248]);
  });

  it("页面里传给图表的 height 都取自档位令牌", () => {
    const offenders: string[] = [];
    const pagesDir = resolve(process.cwd(), "components/av/pages");
    const { readdirSync } = require("node:fs") as typeof import("node:fs");
    const allowed = new Set<number>(Object.values(AV_CHART_HEIGHT));
    for (const entry of readdirSync(pagesDir, { withFileTypes: true })) {
      if (!entry.name.endsWith(".tsx")) continue;
      const path = `components/av/pages/${entry.name}`;
      const source = read(path);
      for (const match of Array.from(source.matchAll(/height=\{(\d+)\}/g))) {
        const value = Number(match[1]);
        if (!allowed.has(value)) {
          offenders.push(`${path}: height={${value}} 不在图表高度档位 [${Array.from(allowed).join(" / ")}] 内`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("智能音视频平台 排版标定：面板头体对齐（BLF-1399）", () => {
  it("面板头与面板体共用同一组左右内边距", () => {
    // 标题的左边缘与面板体里第一列内容的左边缘必须落在同一条竖线上。
    const ui = cssFiles.find((entry) => entry.file.endsWith("AvUI.module.css"))!;
    const header = ruleBody(ui.source, ".panelHeader");
    const body = ruleBody(ui.source, ".panelBody");
    expect(header).not.toBe("");
    expect(body).not.toBe("");
    expect(header).toMatch(/padding:[^;]*var\(--av-pad-panel-x\)/);
    expect(body).toMatch(/padding:[^;]*var\(--av-pad-panel-x\)/);
  });

  it("面板的上下内边距对称（头部与底边一致）", () => {
    const ui = cssFiles.find((entry) => entry.file.endsWith("AvUI.module.css"))!;
    const header = ruleBody(ui.source, ".panelHeader");
    const body = ruleBody(ui.source, ".panelBody");
    // 头部上边距与面板体下边距都走 --av-pad-panel-y
    expect(header).toMatch(/padding:\s*var\(--av-pad-panel-y\)/);
    expect(body).toMatch(/padding:[^;]*var\(--av-pad-panel-y\)[^;]*var\(--av-pad-panel-y\)/);
  });
});
