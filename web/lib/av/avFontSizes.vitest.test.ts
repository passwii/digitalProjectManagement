import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 智能音视频平台 字号层级契约（Stage 6 / BLF-1399 复审补丁）。
 *
 * ## 为什么单独一份
 *
 * 排版标定（`avLayoutTokens.vitest.test.ts`）守的是**间距 / 圆角 / 等高 / 对齐**，
 * 字号是另一条正交的轴，它有自己的一条硬承诺 ——
 *
 * > **字号层级只定档、不改视觉。**
 *
 * 令牌化（`13px` → `var(--av-text-panel)`）本身是纯重命名，渲染像素不该动。
 * 但只要**档位没定全**，重命名就会退化成「就近挑一档」：
 * 改之前是 14px 的数字，如果 14px 根本没有对应档位，就只能被归到
 * `--av-text-body`（12px）—— 数字的视觉权重被悄悄抹掉。
 *
 * 首轮 PR（#167）就是这么翻车的：全 PR 114 处字号里只有两处渲染变了，
 * `.sceneKpis strong` 14px → 12px、`.levelTotal` 13px → 12px，
 * 而 PR 正文与 DESIGN.md 都写着「只定档、不改视觉」。
 *
 * ## 这里守三件事
 *
 *   1. **档位齐全**：站点实际用到的每个字号都有一档令牌
 *      （9 / 10 / 11 / 12 / 13 / 14 / 15 / 16 / 26px + 两个 clamp 档）；
 *   2. **不留裸字面量**：受管 CSS 里不许出现 `font-size: 15px` 这类字面量
 *      —— 绕开令牌就绕开了「只定档」的契约；
 *   3. **渲染等价**：每一处字号的**解析后像素值**必须与令牌化之前一致。
 *
 * 第 3 条是这份守卫真正的价值：它不是「断言某个选择器写对了」，
 * 而是**拿令牌化之前的基线逐条比对** —— 任何一处字号发生像素变化都会红。
 *
 * 基线（`FONT_SIZE_BASELINE`）是从 `origin/main` 的 CSS 里**逐条抽出来**的，
 * 不是手抄的：评审要求「字号层级只定档、不改视觉」，那就得让机器去证明
 * 「没改」，而不是让人去承诺。
 */

/** 受管 CSS 文件（与 avLayoutTokens 的 CSS_FILES 同源）。 */
const CSS_FILES = [
  { tag: "AvUI", file: "components/av/AvUI.module.css" },
  { tag: "AvPages", file: "components/av/pages/AvPages.module.css" },
  { tag: "AvCharts", file: "components/av/AvCharts.module.css" },
] as const;

/**
 * 站点实际用到的字号档位（像素）。
 *
 * 集合从 `origin/main` 的 CSS 里统计得出（改之前一共出现过这 8 个固定像素
 * 字号 + 2 个 clamp 档）。写成**集合**而不是「某个具体值」：
 * 以后站点真要加一档字号，往集合里加一项并说明理由就行，
 * 不用改守卫本身 —— 但**必须加**，否则那一档就是「没定出来的档」，
 * 也就无从保证「只定档不改视觉」。
 *
 * BLF-1423 跟进：新增 16px（中号数字档），并把原 22px 抬到 26px（状态格 /
 * 环形中心数字）—— 用户要求「数字的大小和粗细加粗几次」，22px 这档已无消费方，
 * 所以集合里换成 26px，而不是留一个没人用的空档。
 */
const FONT_SIZE_SCALE = [9, 10, 11, 12, 13, 14, 15, 16, 26] as const;

/**
 * 响应式档位（clamp）：不参与上表的像素集合，但同样必须存在。
 *
 * 页面标题随视口缩放、KPI 大数字随视口缩放 —— 这两档本来就是流式的，
 * 「改视觉」指的是固定像素档被改动，clamp 档不在此列。
 */
const FONT_SIZE_CLAMP_TOKENS = ["--av-text-page", "--av-text-kpi"] as const;

/**
 * 字号渲染基线（断点外）：文件 → 选择器 → 令牌化之前的像素值。
 *
 * 取自 `origin/main`（BLF-1398 合并后的基线），逐条抽出所有带
 * `font-size` 的规则。
 *
 * ⚠️ 这份基线是**改之前**的渲染事实，不是「期望值」。
 * 守卫拿它来证明「令牌化没有改动任何一处像素」。
 *
 * BLF-1423 跟进：带 `数字档` 注释的几条是**有意变更** —— 用户要求多色数字
 * 「大小和粗细加粗几次」，KPI / 状态格 / 环形中心 / 榜单 / 分级计数 / 图例数值
 * 整体抬了一档字号与字重。这些条目的新值就是现在的基线，旧值记在注释里；
 * 「数字醒目档」的用例单独守住它们不许回退到旧值。
 */
const FONT_SIZE_BASELINE: Record<string, Record<string, string>> = {
  AvUI: {
    ".routeLine": "10px",
    ".pageHeading h1": "clamp(20px, 2.1vw, 26px)",
    ".pageHeading p": "12px",
    ".panelTitle h2": "13px",
    ".panelHeader p": "11px",
    ".panelMeta": "10px",
    ".metricHead": "11px",
    ".metricValue strong": "clamp(26px, 2.4vw, 34px)", // 数字档：22→26 / 29→34（BLF-1423 跟进）
    ".metricValue .metricNumber": "inherit",
    ".metricValue .metricUnit": "14px", // 数字档：单位跟着放大（11→14，BLF-1423 跟进）
    ".metricFoot": "11px",
    ".metricFoot small": "10px",
    ".levelBadge": "11px",
    ".tab": "11px",
    ".tabCount": "11px", // 数字档：10→11（BLF-1423 跟进）
    ".barHead": "11px",
    ".barHead strong": "16px", // 数字档：12→16（BLF-1423 跟进）
    ".legend": "14px", // 数字档：11→14（BLF-1423 跟进）
    ".legendItem strong": "14px", // 数字档：11→14（BLF-1423 跟进）
    ".empty strong": "12px",
    ".empty span": "11px",
    ".kv": "12px",
    ".table": "12px",
    ".table caption": "11px",
    ".table th": "10px",
    ".softNote": "11px",
    ".tag": "10px",
  },
  AvPages: {
    ".softNote": "11px",
    ".headerChip": "10px",
    ".textLink": "12px",
    ".ghostButton": "11px",
    ".tagChip": "10px",
    ".levelTotal": "16px", // 数字档：13→16（BLF-1423 跟进）
    ".levelSub": "12px", // 数字档：10→12（BLF-1423 跟进）
    ".heatAxis": "9px",
    ".heatDay": "10px",
    ".heatLegend": "9px",
    ".gpuName": "10px",
    ".gpuValue": "14px", // 数字档：11→14（BLF-1423 跟进）
    ".gpuMode": "10px",
    ".gpuMeta": "10px",
    ".streamTitle": "12px",
    ".streamAge": "10px",
    ".streamBottom": "10px",
    ".streamType": "9px",
    ".rankIndex": "10px",
    ".rankName": "12px",
    ".rankNum": "16px", // 数字档：12→16（BLF-1423 跟进）
    ".rankSub": "10px",
    ".channelLive": "9px",
    ".channelKind": "9px",
    ".channelTitle strong": "13px",
    ".channelFacts": "10px",
    ".alarmSearch input": "12px",
    ".alarmTitle": "13px",
    ".alarmFacts": "10px",
    ".alarmAge": "10px",
    ".alarmType": "9px",
    ".railRow": "11px",
    ".railRow strong": "12px",
    ".scriptItem": "11px",
    ".scriptId": "10px",
    ".scriptCount": "10px",
    ".dialogTitle h2": "15px",
    ".dialogClose": "15px",
    ".dialogSectionTitle": "10px",
    ".detailText": "12px",
    ".keywordChip": "10px",
    ".primaryAction": "12px",
    ".secondaryAction": "12px",
    ".table": "12px",
    ".table th": "10px",
    ".tableButton": "12px",
    ".eventCardTop strong": "13px",
    ".eventCardMeta": "10px",
    ".timelineTime": "10px",
    ".timelineBody strong": "12px",
    ".timelineBody p": "11px",
    ".timelineActor": "10px",
    ".evidenceItem": "11px",
    ".evidenceId": "10px",
    ".statusCell span": "11px",
    ".statusCell strong": "26px", // 数字档：22→26（BLF-1423 跟进）
    ".statusCell small": "10px",
    ".tableMeta": "11px",
    ".attentionTop strong": "12px",
    ".attentionMeta": "10px",
    ".sceneCode": "10px",
    ".sceneCard h3": "15px",
    ".sceneSlogan": "11px",
    ".sceneApp": "10px",
    ".sceneKpis strong": "16px", // 数字档：14→16（BLF-1423 跟进）
    ".sceneKpis span": "9px",
    ".chainStep span": "9px",
    ".chainStep strong": "12px",
    ".chainStep small": "10px",
    ".algoGroupHead strong": "12px",
    ".algoGroupHead span": "10px",
    ".algoTop strong": "12px",
    ".algoMeta": "9px",
    ".ruleId": "10px",
    ".ruleName": "12px",
    ".ruleLine": "11px",
    ".ruleLine span": "10px",
    ".audioMeta": "11px",
    ".transcriptTime": "10px",
    ".speaker": "11px",
    ".transcriptText": "12px",
    ".audioPick": "11px",
    ".stressRow": "12px",
    ".stressLabel": "9px",
  },
  AvCharts: {
    ".donutCenter strong": "26px", // 数字档：22→26（BLF-1423 跟进）
    ".donutCenter span": "10px",
  },
};

/**
 * 字号渲染基线（断点内）：文件 → 媒体上下文 → 选择器 → 像素值。
 *
 * 断点里的规则和断点外是**两套**字号，只比断点外会漏掉窄屏的变化。
 * 键里的 `max-width:720px` 指的是「该断点块内**直接**声明的 font-size」。
 */
const FONT_SIZE_BASELINE_MEDIA: Record<
  string,
  Record<string, Record<string, string>>
> = {
  AvPages: {
    "max-width:720px": {
      ".heatDay": "9px",
    },
  },
};

function read(relative: string): string {
  return readFileSync(resolve(process.cwd(), relative), "utf8");
}

const globals = read("app/globals.css");
const cssFiles = CSS_FILES.map((entry) => ({ ...entry, source: read(entry.file) }));

/** 去掉 CSS 注释后再扫描（注释里写「改之前是 13px」是解释，不是使用）。 */
function maskComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "));
}

/** globals.css 里声明的 `--av-*` 令牌 → 值。 */
function tokenValues(source: string): Map<string, string> {
  const tokens = new Map<string, string>();
  for (const match of Array.from(source.matchAll(/(--av-[a-z0-9-]+):\s*([^;]+);/g))) {
    tokens.set(match[1], match[2].trim());
  }
  return tokens;
}

const tokens = tokenValues(globals);

/**
 * 把一个 font-size 的值解析成**实际像素**。
 *
 * `var(--av-text-panel)` → `13px`；`clamp(...)` 原样返回。
 * 令牌不存在时返回 `MISSING:<名>`，让守卫能报出「引用了不存在的档」。
 */
function resolveFontSize(value: string): string {
  const trimmed = value.trim();
  const direct = /^var\((--av-[a-z0-9-]+)\)$/.exec(trimmed);
  if (direct) {
    const resolved = tokens.get(direct[1]);
    return resolved === undefined ? `MISSING:${direct[1]}` : resolved;
  }
  return trimmed.replace(
    /var\((--av-[a-z0-9-]+)\)/g,
    (_, name) => tokens.get(name) ?? `MISSING:${name}`,
  );
}

/**
 * 取一条选择器的声明体（按花括号配平，容忍嵌套）。
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

/**
 * 取出 `@media (max-width: Npx)` 断点块的正文。
 *
 * 只取**该断点块直接包含**的规则（不递归进嵌套的 @media）——
 * 基线里的媒体上下文就是这么记的，两边口径一致。
 */
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

/**
 * 一个断点块里「直接」声明的 font-size（选择器 → 原始值）。
 */
function fontSizesInBlock(block: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const match of Array.from(block.matchAll(/([^{}]+)\{([^{}]*)\}/g))) {
    const fontSize = /font-size:\s*([^;]+);/.exec(match[2]);
    if (!fontSize) continue;
    const selector = match[1].trim().split("\n").pop()?.trim();
    if (!selector) continue;
    found.set(selector, fontSize[1]);
  }
  return found;
}

/**
 * 一份 CSS 里**断点外**（不在任何 @media 内）的 font-size。
 *
 * ⚠️ 不能用一条平铺的正则去扫 —— 那会把 @media 块里的规则也当成断点外的，
 * 于是「断点外 10px / 断点内 9px」这种**本来就该不同**的规则会被误判成
 * 「断点外变了」。所以这里必须知道每条规则落在不在媒体上下文里。
 *
 * 用一个只数花括号配平的小扫描器：遇到 `@media` 就整块跳过。
 */
function fontSizesOutsideMedia(source: string): Map<string, string> {
  const css = maskComments(source);
  const found = new Map<string, string>();
  let i = 0;
  while (i < css.length) {
    const brace = css.indexOf("{", i);
    if (brace < 0) break;
    const prelude = css.slice(i, brace).trim();
    // 找到配对的右花括号
    let depth = 1;
    let j = brace + 1;
    while (j < css.length && depth > 0) {
      if (css[j] === "{") depth += 1;
      else if (css[j] === "}") depth -= 1;
      j += 1;
    }
    const body = css.slice(brace + 1, j - 1);
    if (prelude.startsWith("@")) {
      // 条件组规则：整块跳过（它的内容由 media 基线单独比）
      i = j;
      continue;
    }
    const fontSize = /font-size:\s*([^;]+);/.exec(body);
    if (fontSize) {
      const selector = prelude.split("\n").pop()?.trim();
      if (selector) found.set(selector, fontSize[1]);
    }
    i = j;
  }
  return found;
}

describe("智能音视频平台 字号层级：档位齐全（BLF-1399）", () => {
  it("站点实际用到的每个字号都有一档令牌", () => {
    // 令牌值集合（只取固定像素档，clamp 档另算）
    const declared = new Set<number>();
    for (const value of Array.from(tokens.values())) {
      const match = /^(\d+)px$/.exec(value);
      if (match) declared.add(Number(match[1]));
    }
    const missing = FONT_SIZE_SCALE.filter((size) => !declared.has(size));
    expect(
      missing,
      `globals.css 缺少 ${missing.join(" / ")}px 的字号档位 —— ` +
        "没有档位的字号在令牌化时只能被归到邻近档，视觉就会变（只定档、不改视觉）",
    ).toEqual([]);
  });

  it("响应式档位（clamp）也都在", () => {
    for (const token of FONT_SIZE_CLAMP_TOKENS) {
      const value = tokens.get(token);
      expect(value, `globals.css 缺少 ${token}`).toBeDefined();
      expect(value, `${token} 必须是 clamp 档`).toMatch(/^clamp\(/);
    }
  });

  it("每个字号档位都有明确用途注释（档位是给人查的）", () => {
    for (const token of Array.from(tokens.keys())) {
      if (!token.startsWith("--av-text-")) continue;
      const match = new RegExp(`${token}:[^;]+;\\s*/\\*\\s*\\S`).exec(globals);
      expect(match, `${token} 后面必须有用途注释（/* 干什么用的 */）`).not.toBeNull();
    }
  });
});

describe("智能音视频平台 字号层级：受管 CSS 不留裸字面量（BLF-1399）", () => {
  it("受管 CSS 里没有 font-size 的裸像素字面量", () => {
    const offenders: string[] = [];
    for (const entry of cssFiles) {
      const masked = maskComments(entry.source);
      for (const match of Array.from(masked.matchAll(/font-size:\s*([^;{}]+);/g))) {
        const value = match[1].trim();
        // var(--av-text-*) 与 inherit 是合法的；其余（裸 px / clamp / em …）都要走令牌
        if (value.startsWith("var(--av-text-") || value === "inherit") continue;
        offenders.push(
          `${entry.file}: font-size: ${value} —— 字号必须消费 var(--av-text-*) 令牌，` +
            "绕开令牌就绕开了「只定档、不改视觉」的契约",
        );
      }
    }
    expect(offenders).toEqual([]);
  });

  it("受管 CSS 引用的字号令牌都在 globals.css 里声明过", () => {
    const offenders: string[] = [];
    for (const entry of cssFiles) {
      const masked = maskComments(entry.source);
      for (const match of Array.from(
        masked.matchAll(/font-size:\s*var\((--av-[a-z0-9-]+)\)/g),
      )) {
        if (!tokens.has(match[1])) {
          offenders.push(`${entry.file}: 引用了未声明的字号令牌 ${match[1]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("智能音视频平台 字号层级：渲染等价（BLF-1399）", () => {
  it("断点外的每一处字号，解析后像素值与令牌化之前一致", () => {
    // 这条是整份守卫的核心：拿 `origin/main` 的基线逐条比对，
    // 证明「令牌化只改了写法、没改视觉」。
    const offenders: string[] = [];
    let checked = 0;
    for (const entry of cssFiles) {
      const baseline = FONT_SIZE_BASELINE[entry.tag] ?? {};
      const actualSizes = fontSizesOutsideMedia(entry.source);
      for (const selector of Object.keys(baseline)) {
        const raw = actualSizes.get(selector);
        if (raw === undefined) continue;
        checked += 1;
        const actual = resolveFontSize(raw);
        const expected = baseline[selector];
        if (actual !== expected) {
          offenders.push(
            `${entry.file}: ${selector} 的字号解析后是 ${actual}，` +
              `令牌化之前是 ${expected} —— 违反「只定档、不改视觉」`,
          );
        }
      }
    }
    expect(offenders).toEqual([]);
    // 基线不能是一份「几乎没人用」的清单
    expect(checked).toBeGreaterThan(100);
  });

  it("断点内的每一处字号，解析后像素值与令牌化之前一致", () => {
    const offenders: string[] = [];
    let checked = 0;
    for (const entry of cssFiles) {
      const byContext = FONT_SIZE_BASELINE_MEDIA[entry.tag] ?? {};
      const masked = maskComments(entry.source);
      for (const context of Object.keys(byContext)) {
        // context 形如 "max-width:720px" —— 取里面的数字（要去掉 px 后缀，
        // 否则 Number("720px") 是 NaN，断点块会静默地一个都找不到）
        const width = Number(/(\d+)px/.exec(context)?.[1]);
        const block = mediaBlock(masked, width);
        if (!block) continue;
        const actualSizes = fontSizesInBlock(block);
        for (const selector of Object.keys(byContext[context])) {
          const raw = actualSizes.get(selector);
          if (raw === undefined) continue;
          checked += 1;
          const actual = resolveFontSize(raw);
          const expected = byContext[context][selector];
          if (actual !== expected) {
            offenders.push(
              `${entry.file}: ${context} 段的 ${selector} 字号解析后是 ${actual}，` +
                `令牌化之前是 ${expected}`,
            );
          }
        }
      }
    }
    expect(offenders).toEqual([]);
    expect(checked).toBeGreaterThan(0);
  });

  it("两个最容易翻车的数字元素，保住了各自的视觉权重", () => {
    // 这两处正是首轮 PR 掉进 12px 的地方（能力页场景 KPI / 告警页分级计数）。
    // 单独立一条，是为了让报错直接指向「视觉权重被抹平」这件事，
    // 而不是淹没在上面的逐条比对里。
    //
    // BLF-1423 跟进：两处都跟上数字档 —— 场景 KPI 14 → 16px（中号数字档），
    // 分级计数 13 → 16px，且都拿到 700 字重。它们只会被**拉大**，
    // 不允许再被归到更小的一档。
    const pages = cssFiles.find((entry) => entry.tag === "AvPages")!;
    const sceneKpis = ruleBody(pages.source, ".sceneKpis strong");
    expect(sceneKpis).toMatch(/font-size:\s*var\(--av-text-stat\);/);
    expect(resolveFontSize(/font-size:\s*([^;]+);/.exec(sceneKpis)![1])).toBe("16px");

    const levelTotal = ruleBody(pages.source, ".levelTotal");
    expect(levelTotal).toMatch(/font-size:\s*var\(--av-text-stat\);/);
    expect(resolveFontSize(/font-size:\s*([^;]+);/.exec(levelTotal)![1])).toBe("16px");
  });

  it("14px 档位存在且被消费（不许有「声明了没人用」的档）", () => {
    // 「档位没定全」是这次翻车的根因，所以反过来也要守：
    // 新增的档必须真的有人用，否则它只是纸面上的存在。
    expect(tokens.get("--av-text-emphasis")).toBe("14px");
    const consumers = cssFiles.filter((entry) =>
      entry.source.includes("var(--av-text-emphasis)"),
    );
    expect(consumers.length, "14px 档位必须有消费方").toBeGreaterThan(0);
  });
});

/**
 * 数字醒目档（BLF-1423 跟进）。
 *
 * 用户反馈：「多色数字令牌这一块，数字的大小和粗细需要改善，加粗几次才更好看」。
 * 上面「渲染等价」的用例守住的是「令牌化没改视觉」，而这一组恰恰相反 ——
 * 数字是被**有意**抬上去的，所以这里守两件事：
 *
 *   1. 字号 / 字重只走令牌（`--av-text-*` / `--av-weight-*`），组件里不写裸值；
 *   2. 两个数字令牌与各处消费方的解析值都不许回退到旧值 ——
 *     「加粗几次」不是一次口头调整，下次谁把它改回 600 会直接变红。
 */
describe("智能音视频平台 数字醒目档（BLF-1423 跟进）", () => {
  const NUMERIC_RULES: { tag: string; selector: string; weight: string }[] = [
    { tag: "AvUI", selector: ".metricValue strong", weight: "figure" },
    { tag: "AvUI", selector: ".legendItem strong", weight: "stat" },
    { tag: "AvUI", selector: ".barHead strong", weight: "stat" },
    { tag: "AvPages", selector: ".statusCell strong", weight: "figure" },
    { tag: "AvPages", selector: ".rankNum", weight: "stat" },
    { tag: "AvPages", selector: ".levelTotal", weight: "stat" },
    { tag: "AvPages", selector: ".sceneKpis strong", weight: "stat" },
    { tag: "AvPages", selector: ".gpuValue", weight: "stat" },
    { tag: "AvCharts", selector: ".donutCenter strong", weight: "figure" },
    // 数字旁的注解（KPI 单位 / 「未处置 N」）：轻一档，但同样只走令牌
    { tag: "AvUI", selector: ".metricValue .metricUnit", weight: "emphasis" },
    { tag: "AvPages", selector: ".levelSub", weight: "emphasis" },
  ];

  it("数字令牌本身不许被调小调细", () => {
    expect(tokens.get("--av-text-stat")).toBe("16px");
    expect(tokens.get("--av-text-figure")).toBe("26px");
    expect(tokens.get("--av-weight-figure")).toBe("800");
    expect(tokens.get("--av-weight-stat")).toBe("700");
    expect(tokens.get("--av-weight-emphasis")).toBe("600");

    // KPI 是 clamp 档：只比两端的下限，避免把「随视口微调」也锁死
    const kpi = tokens.get("--av-text-kpi") ?? "";
    const bounds = /clamp\((\d+)px,\s*([\d.]+)vw,\s*(\d+)px\)/.exec(kpi);
    expect(bounds, `--av-text-kpi 必须是 clamp 档，实际是 ${kpi}`).not.toBeNull();
    expect(Number(bounds![1])).toBeGreaterThanOrEqual(26);
    expect(Number(bounds![3])).toBeGreaterThanOrEqual(34);
  });

  it("每个数字元素都用数字字重令牌，不写裸 font-weight", () => {
    const offenders: string[] = [];
    for (const rule of NUMERIC_RULES) {
      const entry = cssFiles.find((item) => item.tag === rule.tag)!;
      const body = ruleBody(entry.source, rule.selector);
      if (!body) {
        offenders.push(`${entry.file}: 找不到 ${rule.selector}`);
        continue;
      }
      const expected = `var(--av-weight-${rule.weight})`;
      if (!new RegExp(`font-weight:\\s*${expected.replace(/[()]/g, "\\$&")};`).test(body)) {
        offenders.push(`${entry.file}: ${rule.selector} 的字重必须是 ${expected}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("中号数字档有真实消费方（不许声明完就放着）", () => {
    // 按「用到令牌的规则数」计数，而不是按文件数：中号数字目前集中在
    // 榜单 / 分级计数 / 场景 KPI 三处，但它们都在 AvPages 一个文件里。
    const uses = cssFiles.reduce(
      (total, entry) =>
        total + (entry.source.match(/var\(--av-text-stat\)/g)?.length ?? 0),
      0,
    );
    expect(uses, "16px 数字档至少要有三处消费方").toBeGreaterThanOrEqual(3);
  });
});

/**
 * 数字字重级联（BLF-1423 复审 P2）。
 *
 * 复审在 HEAD `43a0575` 上抓到一条 P2：`.metricValue span` 这条**裸后代选择器**
 * 本意是给「%」「条」这类单位用的，但它同样命中 `<strong>` 里 `AvCounter` 渲染的
 * `span.metricNumber`（两者都是 `.metricValue` 的后代 span、特异性同为 0,2,0，
 * 而单位那条在源码里更靠后），于是 `font-weight: 600` 胜出，
 * 首页 KPI 主数字从 `<strong>` 继承的 `--av-weight-figure: 800` 被吞掉 ——
 * 「数字加粗」这条改动实际没生效，而上面那种「某条规则写了什么」的断言照样是绿的。
 *
 * 所以这里不再只读单条规则，而是**按 CSS 级联规则推演**：
 * 给定元素链（祖先 → 自身），收集所有能命中它的 `font-weight` 声明，
 * 按（特异性 → 源码顺序）选出胜出者，遇到 `inherit` 就沿祖先链继续解析，
 * 令牌则解析成最终字重。这条推演能真正回答「浏览器里数字到底有多粗」。
 */
describe("智能音视频平台 数字字重级联（BLF-1423 复审 P2）", () => {
  const ui = cssFiles.find((entry) => entry.tag === "AvUI")!;

  /** `<div class="metricValue"><strong><span class="metricNumber">93.3</span></strong>…` */
  const KPI_NUMBER: NodeSpec[] = [
    { tag: "div", classes: ["metricValue"] },
    { tag: "strong", classes: [] },
    { tag: "span", classes: ["metricNumber"] },
  ];
  /** 同一容器里的单位：`<span class="metricUnit">%</span>` */
  const KPI_UNIT: NodeSpec[] = [
    { tag: "div", classes: ["metricValue"] },
    { tag: "span", classes: ["metricUnit"] },
  ];

  it("KPI 主数字最终生效的字重是 800，单位规则不许顺带压细它", () => {
    expect(computedFontWeight(ui.source, KPI_NUMBER)).toBe("800");
  });

  it("单位自己固定 600，且与数字互不命中", () => {
    expect(computedFontWeight(ui.source, KPI_UNIT)).toBe("600");
    // 根因防线：单位绝不能再写成裸后代 `span`（那会连计数器里的 span 一起命中）
    expect(maskComments(ui.source)).not.toMatch(/\.metricValue\s+span\s*\{/);
  });

  it("守卫有牙：两道防线全撤，推演结果变回 600", () => {
    // 不复现一次「改坏就红」，上面两条只是看起来对的断言。
    // 这里的退化版就是 HEAD `43a0575` 的真实形态：数字规则不写字重 + 单位用裸后代 span。
    const original = maskComments(ui.source);
    const noNumberWeight = original.replace(
      /(\.metricValue \.metricNumber \{[^}]*?)font-weight: inherit;\n/,
      "$1",
    );
    expect(noNumberWeight).not.toBe(original);
    const regressed = noNumberWeight.replace(
      ".metricValue .metricUnit {",
      ".metricValue span {",
    );
    expect(regressed).not.toBe(noNumberWeight);
    expect(computedFontWeight(regressed, KPI_NUMBER)).toBe("600");

    // 只撤一道：另一道能兜住 —— 两层防线不是同一件事的重复
    expect(computedFontWeight(noNumberWeight, KPI_NUMBER)).toBe("800");
    const bareSpanOnly = original.replace(
      ".metricValue .metricUnit {",
      ".metricValue span {",
    );
    expect(computedFontWeight(bareSpanOnly, KPI_NUMBER)).toBe("800");
  });

  it("「未处置 N」也走字重令牌，不是裸 600", () => {
    const pages = cssFiles.find((entry) => entry.tag === "AvPages")!;
    expect(ruleBody(pages.source, ".levelSub")).toMatch(
      /font-weight:\s*var\(--av-weight-emphasis\);/,
    );
  });
});

/* ---------------------------------------------------------------------------
 * 级联推演的小工具（只支持 module.css 里实际用到的写法：标签 + 类 + 后代选择器）
 * ------------------------------------------------------------------------- */

type Compound = { tag: string | null; classes: string[] };
/** 元素链上的一环：标签名 + 该类名列表（就地写 CSS Modules 的源类名，不含哈希） */
type NodeSpec = { tag: string; classes: string[] };

const COMPOUND_PATTERN = /^([a-z][a-z0-9-]*)?((?:\.[A-Za-z0-9_-]+)*)$/;

/** `.metricValue strong` → [{classes:[metricValue]}, {tag:strong}]；不支持的写法返回 null。 */
function parseSelector(selector: string): Compound[] | null {
  const parts: Compound[] = [];
  for (const raw of selector.trim().split(/\s+/)) {
    const match = COMPOUND_PATTERN.exec(raw);
    if (!match || (!match[1] && !match[2])) return null;
    parts.push({
      tag: match[1] ?? null,
      classes: match[2] ? match[2].split(".").filter(Boolean) : [],
    });
  }
  return parts.length > 0 ? parts : null;
}

function nodeMatches(node: NodeSpec, compound: Compound): boolean {
  if (compound.tag && compound.tag !== node.tag) return false;
  return compound.classes.every((name) => node.classes.includes(name));
}

/** 选择器是否命中「元素链的最后一环」（前面的复合选择器按后代关系匹配祖先）。 */
function selectorMatches(selector: string, path: NodeSpec[]): boolean {
  const parts = parseSelector(selector);
  if (!parts || parts.length > path.length) return false;
  if (!nodeMatches(path[path.length - 1], parts[parts.length - 1])) return false;
  let cursor = path.length - 2;
  for (let index = parts.length - 2; index >= 0; index -= 1) {
    let found = -1;
    for (let probe = cursor; probe >= 0; probe -= 1) {
      if (nodeMatches(path[probe], parts[index])) {
        found = probe;
        break;
      }
    }
    if (found < 0) return false;
    cursor = found - 1;
  }
  return true;
}

type WeightRule = {
  selector: string;
  value: string;
  order: number;
  classes: number;
  tags: number;
};

/**
 * 一份 CSS 里**断点外**的所有 `font-weight` 声明。
 *
 * 只统计桌面宽屏基线（断点内是另一套排版，窄屏覆盖不在本守卫的验收范围）；
 * 特异性按 CSS 的（类数 → 标签数）两级记，够区分 module.css 里全部规则。
 */
function fontWeightRules(source: string): WeightRule[] {
  const css = maskComments(source);
  const rules: WeightRule[] = [];
  let cursor = 0;
  let order = 0;
  while (cursor < css.length) {
    const brace = css.indexOf("{", cursor);
    if (brace < 0) break;
    const prelude = css.slice(cursor, brace).trim();
    let depth = 1;
    let end = brace + 1;
    while (end < css.length && depth > 0) {
      if (css[end] === "{") depth += 1;
      else if (css[end] === "}") depth -= 1;
      end += 1;
    }
    const body = css.slice(brace + 1, end - 1);
    cursor = end;
    if (prelude.startsWith("@")) continue; // 条件组规则整块跳过
    const weight = /font-weight:\s*([^;]+);/.exec(body);
    if (!weight) continue;
    const selector = prelude.split("\n").pop()?.trim() ?? "";
    const parts = parseSelector(selector);
    if (!parts) continue;
    rules.push({
      selector,
      value: weight[1].trim(),
      order: (order += 1),
      classes: parts.reduce((total, part) => total + part.classes.length, 0),
      tags: parts.reduce((total, part) => total + (part.tag ? 1 : 0), 0),
    });
  }
  return rules;
}

/** `inherit` / `unset` 返回 null（表示「去祖先链上找」）。 */
function resolveWeightValue(value: string): string | null {
  if (value === "inherit" || value === "unset") return null;
  const tokenRef = /^var\((--av-[a-z0-9-]+)\)$/.exec(value);
  if (tokenRef) return tokens.get(tokenRef[1]) ?? `MISSING:${tokenRef[1]}`;
  return value;
}

/**
 * 推演元素链最后一环**最终生效**的 font-weight。
 *
 * 从自身向上逐层找胜出声明：同一层内按（类数 → 标签数 → 源码顺序）决胜；
 * 胜出值是 `inherit` 就继续上一层，一层都没有声明就继续往上（CSS 继承语义）。
 */
function computedFontWeight(source: string, path: NodeSpec[]): string {
  const rules = fontWeightRules(source);
  for (let depth = path.length - 1; depth >= 0; depth -= 1) {
    const scoped = path.slice(0, depth + 1);
    const matched = rules.filter((rule) => selectorMatches(rule.selector, scoped));
    if (matched.length === 0) continue;
    const winner = matched.reduce((best, rule) => {
      if (rule.classes !== best.classes) return rule.classes > best.classes ? rule : best;
      if (rule.tags !== best.tags) return rule.tags > best.tags ? rule : best;
      return rule.order > best.order ? rule : best;
    });
    const resolved = resolveWeightValue(winner.value);
    if (resolved !== null) return resolved;
  }
  return "unset";
}
