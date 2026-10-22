import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * CSS Module 关键帧名转发契约（BLF-1433）。
 *
 * ## 守的是什么
 *
 * CSS Modules（Next 14 的 css-loader）会把 `animation` / `animation-name` 里的**名字**
 * 一起本地化成 `<模块>_<名字>__hash`，而 `app/globals.css` 里的 `@keyframes av*` 是
 * 全局作用域、不会被改写。两边名字对不上时 `animation-name` 不是 `none`（它带着哈希名），
 * 但样式表里没有同名 `@keyframes` —— 整条动画**静默不执行**，元素永远停在首帧。
 * 这类失效在截图里就是「该动的地方常年不动」，肉眼 review 很难抓到，所以用源码守卫兜住。
 *
 * 合法写法只有两种：
 *   1. `animation: var(--av-kf-xxx) …` —— 变量替换发生在计算值阶段，不经过本地化（首选）；
 *   2. 帧名在本文件里声明过（`@keyframes` 同文件），本地化后两边仍然对得上（存量例外，
 *      只有 `motion/AvMotion.module.css` 的 `pageInFrames` / `riseInFrames`，理由见那里的注释）。
 *
 * ## 与其它守卫的分工
 *
 * | 守卫 | 只守 |
 * | --- | --- |
 * | 本文件 | 5 个模块里**所有** `animation` / `animation-name` 的帧名通道 + `--av-kf-*` 与 `@keyframes` 的双向一致 |
 * | `monitorMotion.vitest.test.tsx` | /monitor 通道卡那几处具体声明（波形周期、LIVE 呼吸、离线静止） |
 * | `motion.vitest.test.ts` | 裸毫秒 / 缓动字面量；关键帧只动 transform / opacity |
 *
 * 三者互补，不要把这里的扫描删掉换成某几处硬编码断言：BLF-1433 收口时正是 19 处
 * 分散在 4 个文件里，逐个写断言既漏又难维护。
 */

const GLOBALS = "app/globals.css";

/** 5 个消费帧动画的 CSS 模块（AvCharts 目前没有声明，仍然纳入扫描以防以后加）。 */
const CSS_MODULES = [
  "components/av/AvUI.module.css",
  "components/av/pages/AvPages.module.css",
  "components/av/AvShell.module.css",
  "components/av/AvCharts.module.css",
  "components/av/motion/AvMotion.module.css",
] as const;

function read(relative: string): string {
  return readFileSync(resolve(process.cwd(), relative), "utf8");
}

/** 去掉注释后再扫描：注释里写的 `animation: avXxx`（解释「改之前长什么样」）不是使用。 */
function maskComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "));
}

/** 按顶层空白切分（`calc(var(--a) * 2)` 内部的空格不算分隔）。 */
/** 按顶层定界符切分（`var(--a, 1)` / `calc(var(--a) * 2)` 内部的逗号与空格不算分隔）。 */
function splitTopLevel(value: string, separator: " " | "," = " "): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of value) {
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    const isSeparator = separator === " " ? /\s/.test(char) : char === separator;
    if (depth === 0 && isSeparator) {
      if (current) parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current) parts.push(current);
  return parts;
}

/** `animation` 简写里不是帧名的关键字。 */
const KEYWORDS = new Set([
  "none",
  "infinite",
  "normal",
  "reverse",
  "alternate",
  "alternate-reverse",
  "forwards",
  "backwards",
  "both",
  "running",
  "paused",
  "linear",
  "ease",
  "ease-in",
  "ease-out",
  "ease-in-out",
  "step-start",
  "step-end",
]);

/** 时长 / 缓动 / 错峰令牌取值：`var(--av-dur-quick)`、`calc(var(--av-dur-slow) * 6)`、`0s`。 */
const TIMING_TOKEN =
  /^(?:var\(--av-(?:dur|ease|stagger)-[a-z0-9-]+\)|calc\(|cubic-bezier\(|steps\(|linear\(|0s$|0ms$|\d+(?:\.\d+)?m?s$)/;

/** 帧名转发变量：`var(--av-kf-fade-in)`。 */
const FRAMES_VAR = /^var\((--av-kf-[a-z0-9-]+)\)$/;

type Declaration = { file: string; value: string };

type Audit = {
  declarations: Declaration[];
  problems: string[];
};

/** 收集一个模块里的 `animation` / `animation-name` 声明（保留原值，便于报错）。 */
function animationDeclarations(source: string): string[] {
  const masked = maskComments(source);
  const values: string[] = [];
  const pattern = /(?:^|[;{])\s*animation(?:-name)?\s*:\s*([^;}]+)/g;
  for (const match of Array.from(masked.matchAll(pattern))) {
    const value = (match[1] ?? "").replace(/!important/g, "").trim();
    if (value) values.push(value);
  }
  return values;
}

/** 本文件内声明过的帧名（这些帧名会被同样本地化，所以两边仍然对得上）。 */
function localFrameNames(source: string): Set<string> {
  const names = new Set<string>();
  for (const match of Array.from(maskComments(source).matchAll(/@keyframes\s+([A-Za-z_][\w-]*)/g))) {
    names.add(match[1]);
  }
  return names;
}

type AuditContext = {
  file: string;
  local: Set<string>;
  declaredTokens: Set<string>;
  problems: string[];
};

/** 检查一条 `animation` 值（逗号分隔后的单段）：帧名 token 的合法性判定都在这里。 */
function inspectValue(value: string, context: AuditContext): void {
  const { file, local, declaredTokens, problems } = context;
  for (const token of splitTopLevel(value)) {
    if (KEYWORDS.has(token) || TIMING_TOKEN.test(token)) continue;

    const framesVar = FRAMES_VAR.exec(token);
    if (framesVar) {
      if (!declaredTokens.has(framesVar[1])) {
        problems.push(
          `${file}: \`${token}\` 引用了未声明的变量 —— 帧名会解析成空值，` +
            `请在 ${GLOBALS} 的 \`--av-kf-*\` 段补上 \`${framesVar[1]}: <帧名>;\``,
        );
      }
      continue;
    }

    if (local.has(token)) continue;

    problems.push(
      `${file}: \`animation: ${value}\` 里的帧名 \`${token}\` 会被 CSS Modules 本地化，` +
        `找不到 stylesheet 里的全局 \`@keyframes ${token}\`，动画会静默不播。` +
        `修复：在 ${GLOBALS} 里加 \`--av-kf-xxx: ${token};\`，这里改写成 \`var(--av-kf-xxx)\`；` +
        `若必须留在模块内，则在本文件声明 \`@keyframes\``,
    );
    // 一段声明只报第一个裸帧名：后面的 token 大概率是同一条写法的重复
    return;
  }
}

/**
 * 审计一组模块：里头的帧名 token 只能是
 *   · `var(--av-kf-*)`，且该令牌在 globals.css 里真的声明过；
 *   · 本文件 `@keyframes` 声明过的名字。
 * 其余一律记成问题（带上修复提示），而不是直接 fail —— 这样既能对真实文件断言，
 * 也能用坏样本做负向自检。
 */
function auditFrames(
  files: Array<{ file: string; source: string }>,
  declaredTokens: Set<string>,
): Audit {
  const declarations: Declaration[] = [];
  const problems: string[] = [];

  for (const { file, source } of files) {
    const local = localFrameNames(source);
    for (const raw of animationDeclarations(source)) {
      const context = { file, local, declaredTokens, problems };
      for (const part of splitTopLevel(raw, ",")) {
        const value = part.trim();
        if (!value) continue;
        declarations.push({ file, value });
        inspectValue(value, context);
      }
    }
  }

  return { declarations, problems };
}

/** 先去掉注释再读 globals.css：注释里出现过 `--av-kf-xxx: avXxx` 这种反例。 */
const globalsSource = maskComments(read(GLOBALS));

/** `--av-kf-*` 令牌名 → 帧名。 */
function framesTokens(source: string): Map<string, string> {
  const tokens = new Map<string, string>();
  for (const match of Array.from(source.matchAll(/(--av-kf-[a-z0-9-]+)\s*:\s*([A-Za-z_][\w-]*)\s*;/g))) {
    tokens.set(match[1], match[2]);
  }
  return tokens;
}

/** globals.css 里定义过的 `@keyframes` 名。 */
const globalKeyframes = localFrameNames(read(GLOBALS));
const tokenToFrame = framesTokens(globalsSource);
const declaredTokens = new Set(tokenToFrame.keys());

const modules = CSS_MODULES.map((file) => ({ file, source: read(file) }));

describe("帧名通道：模块里的 animation 只能走 var(--av-kf-*) 或本文件 @keyframes", () => {
  it("5 个模块全部零未解析帧名（BLF-1433 收口的 19 处）", () => {
    const audit = auditFrames(modules, declaredTokens);
    expect(audit.problems).toEqual([]);
    // 恒真防御：扫描真跑到了东西，而不是正则没命中就「通过」
    expect(audit.declarations.length).toBeGreaterThanOrEqual(19);
  });

  it("负向自检：裸帧名 / 拼错的 --av-kf-* 都必须被报出来", () => {
    const broken = [
      {
        file: "fixture.module.css",
        source: ".bad { animation: avFadeIn var(--av-dur-base) var(--av-ease-enter) both; }",
      },
      {
        file: "fixture.module.css",
        source: ".typo { animation: var(--av-kf-fadein) var(--av-dur-base) both; }",
      },
    ];
    const audit = auditFrames(broken, declaredTokens);
    expect(audit.problems).toHaveLength(2);
    expect(audit.problems[0]).toContain("avFadeIn");
    expect(audit.problems[1]).toContain("--av-kf-fadein");
  });

  it("负向自检：本文件声明过的帧名与「注释里的裸帧名」不误报", () => {
    const fixture = [
      {
        file: "fixture.module.css",
        source: [
          "@keyframes localFrames { from { opacity: 0 } to { opacity: 1 } }",
          ".ok { animation: localFrames var(--av-dur-base) var(--av-ease-enter) both; }",
          ".forward { animation: var(--av-kf-fade-in) var(--av-dur-quick) linear infinite; }",
          "/* 历史写法：animation: avFadeIn var(--av-dur-base); */",
        ].join("\n"),
      },
    ];
    const audit = auditFrames(fixture, declaredTokens);
    expect(audit.problems).toEqual([]);
    expect(audit.declarations).toHaveLength(2);
  });

  it("模块用到的每个 --av-kf-* 都在 globals.css 里声明过，且没有死令牌", () => {
    const used = new Set<string>();
    for (const { source } of modules) {
      for (const match of Array.from(maskComments(source).matchAll(/var\((--av-kf-[a-z0-9-]+)\)/g))) {
        used.add(match[1]);
      }
    }
    // 用到的都必须有声明（拼错会静默失效，且不受 CSS 报错保护）
    expect(Array.from(used).filter((name) => !declaredTokens.has(name))).toEqual([]);
    // 声明了的都必须有人用（否则改令牌名时容易留下无人消费的半套别名）
    expect(Array.from(declaredTokens).filter((name) => !used.has(name))).toEqual([]);
  });
});

describe("反向断言：每个 --av-kf-x 指向的帧名都在 globals.css 里有 @keyframes", () => {
  it("令牌值与本文件的 @keyframes 一一对上（防拼错 / 删帧）", () => {
    const dangling = Array.from(tokenToFrame.entries())
      .filter(([, frame]) => !globalKeyframes.has(frame))
      .map(([token, frame]) => `${token}: ${frame}（globals.css 里没有 @keyframes ${frame}）`);
    expect(dangling).toEqual([]);
    expect(tokenToFrame.size).toBeGreaterThanOrEqual(20);
  });

  it("负向自检：指向不存在的帧名会被报出来", () => {
    const fixture = ".x { --av-kf-nope: avNopeFrames; }";
    const bad = framesTokens(maskComments(fixture));
    const dangling = Array.from(bad.entries()).filter(([, frame]) => !globalKeyframes.has(frame));
    expect(dangling).toHaveLength(1);
  });
});

describe("BLF-1433 修复后仍成立的填充模式（from 帧带 opacity: 0 的那几处）", () => {
  const pages = read("components/av/pages/AvPages.module.css");
  const readRule = (selector: string): string => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // 同一个选择器可能拆成多条规则（布局一条、动画一条），全部拼起来再断言
    return Array.from(pages.matchAll(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, "g")))
      .map((match) => match[1] ?? "")
      .join("\n");
  };

  it("时间线节点保持 backwards + --av-i 延迟（不能改成 both，否则 transform 被钉住）", () => {
    const body = readRule(".timelineItem[data-motion-node]");
    expect(body).toMatch(/animation:\s*var\(--av-kf-rise-in\)[^;]*\sbackwards;/);
    expect(body).toMatch(/animation-delay:\s*calc\(var\(--av-stagger-timeline\)\s*\*\s*var\(--av-i/);
  });

  it("时间线节点的 --av-i 有上限，最后一个节点在延迟结束后一定是可见的", () => {
    const view = read("components/av/pages/EventView.tsx");
    expect(view).toMatch(/"--av-i":\s*Math\.min\(index,\s*\d+\)/);
  });

  it("抽屉开合与遮罩都走变量转发，且退场仍是 quick", () => {
    expect(readRule(".dialog")).toMatch(/animation:\s*var\(--av-kf-drawer-in\)\s+var\(--av-dur-base\)/);
    expect(readRule('.dialog[data-closing="true"]')).toMatch(
      /animation:\s*var\(--av-kf-drawer-out\)\s+var\(--av-dur-quick\)/,
    );
    expect(readRule(".dialog::backdrop")).toMatch(/animation:\s*var\(--av-kf-fade-in\)/);
    expect(readRule('.dialog[data-closing="true"]::backdrop')).toMatch(
      /animation:\s*var\(--av-kf-fade-out\)\s+var\(--av-dur-quick\)/,
    );
  });
});
