import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 智能音视频平台 控件尺寸基线契约（Stage 6 / BLF-1398）。
 *
 * 改之前，同一个顶栏里同时存在 34px（搜索框）、36px（菜单按钮）、30px（返回链接）、
 * 26px（chip）四种高度；页内还有 26 / 30 / 32px 三档按钮与 20 / 22px 两档徽标。
 * 同一层级的控件高度参差，是「卡片排版高度不一」的根因之一（卡片本身的排版是
 * BLF-1399 的范围，但控件高度必须先定下来）。
 *
 * 这里守两件事：
 *   1. **档位集合**：同一层级的交互控件，其高度声明必须落在**允许的档位集合**里。
 *      写成「集合」而不是「某个具体值」—— 否则以后想把 30px 调到 32px 就必红，
 *      守卫会变成「禁止调尺寸」而不是「禁止参差」。
 *   2. **不允许写死像素**：控件高度必须消费 globals.css 的基线令牌
 *      （var(--av-ctl-*)），否则又会长出第二套尺寸体系。
 *
 * 两条都是**读源码**就能守的，所以放在 node 环境的 vitest 里（与 avSourceGuard 同源思路）。
 */

/** 基线令牌：名字 → 允许的像素值集合（与 globals.css 的定义一一对应）。 */
const TOKENS: Record<string, { values: number[]; scope: string }> = {
  "--av-ctl-shell": { values: [34, 44], scope: "壳层交互控件（34px 桌面 / 44px 窄屏触控）" },
  "--av-ctl-shell-chip": { values: [26, 28], scope: "壳层状态芯片" },
  "--av-ctl-page": { values: [30], scope: "页内按钮与输入框" },
  "--av-ctl-page-tab": { values: [28], scope: "页内分段控件 Tab" },
  "--av-ctl-badge": { values: [22], scope: "页内徽标与标签" },
};

/** 允许集合的反向索引：像素值 → 令牌名（报错时告诉开发者该用哪个令牌）。 */
const OWNER: Record<number, string> = {
  34: "--av-ctl-shell",
  44: "--av-ctl-shell",
  26: "--av-ctl-shell-chip",
  28: "--av-ctl-page-tab（页内）或 --av-ctl-shell（窄屏触控档）",
  30: "--av-ctl-page",
  22: "--av-ctl-badge",
};

function read(relative: string): string {
  return readFileSync(resolve(process.cwd(), relative), "utf8");
}

const globals = read("app/globals.css");
const shellCss = read("components/av/AvShell.module.css");
const uiCss = read("components/av/AvUI.module.css");
const pagesCss = read("components/av/pages/AvPages.module.css");

/**
 * 取出某个选择器的声明体。
 *
 * 用「选择器 + `{`」定位，再按花括号配平取到对应的 `}` ——
 * 直接用 `\.name\s*\{([^}]*)\}` 在遇到 `}` 出现在选择器里时会截错。
 */
function ruleBody(css: string, selector: string): string {
  // 选择器里的点要转义；其余字符（字母、连字符、空格）原样即可
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

/** 声明体里的 height / min-height（只取这两个，别的量纲不管）。 */
function heights(body: string): number[] {
  const out: number[] = [];
  for (const match of Array.from(body.matchAll(/(?:^|\s)(?:min-)?height\s*:\s*([^;]+);/g))) {
    const value = match[1].trim();
    const pixels = /^(\d+)px$/.exec(value);
    if (pixels) {
      out.push(Number(pixels[1]));
      continue;
    }
    // var(--token)：取令牌名，交给调用方解析
    const token = /^var\((--[\w-]+)\)$/.exec(value);
    if (token) out.push(NaN);
  }
  return out;
}

/** 声明体里出现的基线令牌名。 */
function tokensIn(body: string): string[] {
  return Array.from(body.matchAll(/var\((--av-ctl-[\w-]+)\)/g)).map((match) => match[1]);
}

/**
 * 一条控件契约：class 名、所在文件、允许的档位集合。
 *
 * 「允许集合」而不是「具体值」：同一个档位里将来允许 ±2px 的微调，
 * 但不允许跑到另一个档位去（那才是参差）。
 */
interface ControlContract {
  file: string;
  css: string;
  className: string;
  /** 允许的高度集合（px）。 */
  allowed: number[];
  /** 该控件应当消费的基线令牌。 */
  token: string;
  why: string;
}

const CONTRACTS: ControlContract[] = [
  // —— 壳层（顶栏 / 侧栏）：交互控件一档 ——
  { file: "AvShell.module.css", css: shellCss, className: "menuButton", allowed: TOKENS["--av-ctl-shell"].values, token: "--av-ctl-shell", why: "顶栏菜单按钮（窄屏抽屉入口）" },
  { file: "AvShell.module.css", css: shellCss, className: "searchBox", allowed: TOKENS["--av-ctl-shell"].values, token: "--av-ctl-shell", why: "顶栏搜索框" },
  { file: "AvShell.module.css", css: shellCss, className: "iconButton", allowed: TOKENS["--av-ctl-shell"].values, token: "--av-ctl-shell", why: "主题切换图标按钮" },
  { file: "AvShell.module.css", css: shellCss, className: "backLink", allowed: TOKENS["--av-ctl-shell"].values, token: "--av-ctl-shell", why: "顶栏「返回主系统」链接" },
  { file: "AvShell.module.css", css: shellCss, className: "collapseButton", allowed: TOKENS["--av-ctl-shell"].values, token: "--av-ctl-shell", why: "侧栏折叠按钮" },
  { file: "AvShell.module.css", css: shellCss, className: "chip", allowed: TOKENS["--av-ctl-shell-chip"].values, token: "--av-ctl-shell-chip", why: "顶栏状态芯片" },

  // —— 页内：按钮 / 输入一档、Tab 一档、徽标一档 ——
  { file: "AvUI.module.css", css: uiCss, className: "tab", allowed: TOKENS["--av-ctl-page-tab"].values, token: "--av-ctl-page-tab", why: "页内分段控件 Tab" },
  { file: "AvUI.module.css", css: uiCss, className: "levelBadge", allowed: TOKENS["--av-ctl-badge"].values, token: "--av-ctl-badge", why: "告警级别徽标" },
  { file: "AvUI.module.css", css: uiCss, className: "tag", allowed: TOKENS["--av-ctl-badge"].values, token: "--av-ctl-badge", why: "状态标签" },
  { file: "AvPages.module.css", css: pagesCss, className: "ghostButton", allowed: TOKENS["--av-ctl-page"].values, token: "--av-ctl-page", why: "页内次级按钮" },
  { file: "AvPages.module.css", css: pagesCss, className: "alarmSearch", allowed: TOKENS["--av-ctl-page"].values, token: "--av-ctl-page", why: "告警中心搜索框" },
  { file: "AvPages.module.css", css: pagesCss, className: "primaryAction", allowed: TOKENS["--av-ctl-page"].values, token: "--av-ctl-page", why: "对话框主行动按钮" },
  { file: "AvPages.module.css", css: pagesCss, className: "secondaryAction", allowed: TOKENS["--av-ctl-page"].values, token: "--av-ctl-page", why: "对话框次行动按钮" },
  { file: "AvPages.module.css", css: pagesCss, className: "dialogClose", allowed: TOKENS["--av-ctl-page"].values, token: "--av-ctl-page", why: "对话框关闭按钮" },
  { file: "AvPages.module.css", css: pagesCss, className: "headerChip", allowed: TOKENS["--av-ctl-badge"].values, token: "--av-ctl-badge", why: "页头状态芯片" },
  { file: "AvPages.module.css", css: pagesCss, className: "tagChip", allowed: TOKENS["--av-ctl-badge"].values, token: "--av-ctl-badge", why: "页内标签芯片" },
];

describe("智能音视频平台 控件尺寸基线：令牌与档位（BLF-1398）", () => {
  it("globals.css 声明了全部基线令牌，取值与契约一致", () => {
    for (const [name, spec] of Object.entries(TOKENS)) {
      const match = new RegExp(`${name}:\\s*([^;]+);`).exec(globals);
      expect(match, `globals.css 缺少 ${name}`).not.toBeNull();
      const declared = match![1].trim();
      const pixels = /^(\d+)px$/.exec(declared);
      expect(pixels, `${name} 必须写死成像素档位，而不是 ${declared}`).not.toBeNull();
      // 令牌本身的值必须落在允许集合里（桌面档）
      expect(
        spec.values.map(String).includes(pixels![1]),
        `${name} = ${declared}，不在允许集合 ${spec.values.join("/")} 里`,
      ).toBe(true);
    }
  });

  it("每个受控控件的高度都消费基线令牌（不写死像素）", () => {
    const offenders: string[] = [];
    for (const contract of CONTRACTS) {
      const body = ruleBody(contract.css, contract.className);
      if (!body) {
        offenders.push(`${contract.file}: .${contract.className} 找不到规则`);
        continue;
      }
      const used = tokensIn(body);
      if (!used.includes(contract.token)) {
        offenders.push(
          `${contract.file}: .${contract.className} 必须消费 var(${contract.token})，实际用了 [${used.join(", ") || "无"}]`,
        );
      }
      // 高度声明里不允许出现裸像素
      for (const value of heights(body)) {
        if (!Number.isNaN(value)) {
          offenders.push(
            `${contract.file}: .${contract.className} 的高度写死了 ${value}px，应改用 var(${contract.token})`,
          );
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("每个受控控件的高度都落在允许的档位集合里", () => {
    const offenders: string[] = [];
    for (const contract of CONTRACTS) {
      const body = ruleBody(contract.css, contract.className);
      if (!body) continue;
      // 解析令牌 → 像素（token → 该令牌在 globals.css 里的声明值）
      const resolved: number[] = [];
      for (const match of Array.from(body.matchAll(/(?:^|\s)(?:min-)?height\s*:\s*var\((--av-ctl-[\w-]+)\)/g))) {
        const token = match[1];
        const declared = new RegExp(`${token}:\\s*(\\d+)px`).exec(globals);
        if (!declared) {
          offenders.push(`${contract.file}: .${contract.className} 用了未声明的令牌 ${token}`);
          continue;
        }
        resolved.push(Number(declared[1]));
      }
      for (const value of resolved) {
        if (!contract.allowed.includes(value)) {
          offenders.push(
            `${contract.file}: .${contract.className} = ${value}px，不在允许集合 [${contract.allowed.join("/")}] 里` +
              `（${OWNER[value] ?? "别的档位"}）`,
          );
        }
      }
      if (resolved.length === 0) {
        offenders.push(`${contract.file}: .${contract.className} 没有声明高度`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("窄屏把壳层交互控件抬到 44px 触控档（不把移动端改坏）", () => {
    // 桌面 34px 在手机上太小；窄屏整体抬到 44px 是「抬」不是「降」。
    expect(shellCss).toMatch(/@media \(max-width: 900px\)[\s\S]*?--av-ctl-shell:\s*44px;/);
    // 桌面档仍然是 34px
    expect(globals).toMatch(/--av-ctl-shell:\s*34px;/);
  });

  it("图标按钮是正方形（宽 = 高），不靠内边距硬撑", () => {
    const body = ruleBody(shellCss, "iconButton");
    expect(body).toMatch(/width:\s*var\(--av-ctl-shell\)/);
    expect(body).toMatch(/height:\s*var\(--av-ctl-shell\)/);
    // 正方形按钮不应有左右内边距（那会把它撑成非正方形）
    expect(body).not.toMatch(/padding:\s*0\s+\d+px/);
  });

  it("文字按钮按内容宽度，图标按钮才用方形 —— 两者不共用一套规则", () => {
    const back = ruleBody(shellCss, "backLink");
    const icon = ruleBody(shellCss, "iconButton");
    // 文字按钮不设固定宽度
    expect(back).not.toMatch(/width:\s*var\(--av-ctl-shell\)/);
    // 图标按钮设固定宽度
    expect(icon).toMatch(/width:\s*var\(--av-ctl-shell\)/);
  });

  it("所有新按钮都保留 :focus-visible 可见焦点环", () => {
    for (const className of ["iconButton", "backLink", "collapseButton"]) {
      expect(shellCss, `.${className} 缺少 :focus-visible 焦点环`).toMatch(
        new RegExp(`\\.${className}:focus-visible\\s*\\{`),
      );
    }
    // 页内的次级按钮也不能丢
    expect(pagesCss).toMatch(/\.ghostButton:focus-visible\s*\{/);
    expect(uiCss).toMatch(/\.tab:focus-visible\s*\{/);
  });

  it("输入框内部元素不溢出外壳（显式盖掉全局 input 的 38px）", () => {
    // 全局 input 是 38px（DESIGN.md 的输入框基线），而 AV 的搜索框外壳是 30/34px。
    // 不显式盖掉，input 就会溢出框高 —— 改之前就是这样（框 34px、input 38px）。
    // 控件高度基线必须连内部元素一起对齐，否则「外框统一了、内里还参差」等于没做。
    for (const [name, css, selector] of [
      ["AvShell.module.css", shellCss, ".searchBox input"],
      ["AvPages.module.css", pagesCss, ".alarmSearch input"],
    ] as const) {
      const body = ruleBody(css, selector);
      expect(body, `${name}: ${selector} 找不到规则`).not.toBe("");
      expect(body, `${name}: ${selector} 必须显式定高`).toMatch(/height:\s*100%/);
      expect(body, `${name}: ${selector} 必须清掉全局内边距`).toMatch(/padding:\s*0\s*;/);
    }
  });

  it("新增的过渡只走动效令牌（不写裸毫秒）", () => {
    // 这条与 av/motion.vitest.test.ts 的裸时长守卫是同一件事，但这里的换算是
    // 本 issue 自己新加的：把裸毫秒写进 CSS 会让 CI 直接红。
    const files: [string, string][] = [
      ["AvShell.module.css", shellCss],
      ["AvUI.module.css", uiCss],
      ["AvPages.module.css", pagesCss],
    ];
    const offenders: string[] = [];
    for (const [name, css] of files) {
      const declarations = css.match(/(?:transition|animation)[^;{}]*:[^;{}]*;/g) ?? [];
      for (const declaration of declarations) {
        const stripped = declaration.replace(/var\(--[\w-]+\)/g, "").replace(/calc\([^)]*\)/g, "");
        if (/(^|[^\d.])\d*\.?\d+m?s\b/.test(stripped)) {
          offenders.push(`${name}: ${declaration.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * 主题切换图标（BLF-1398）。
 *
 * 守三件事：
 *   1. `AvGlyph` 的图标集合里真的有 `sun` / `moon`（漏画会让按钮渲染成空白）；
 *   2. `AvIconName` 联合类型已经扩展（漏扩展的话，TS 会拦住调用方 ——
 *      但那是**编译期**的；这里的断言顺带把「类型与图标集合同步」这件事钉住，
 *      防止有人加了图标却没登记、或登记了却没画）；
 *   3. 两个新图标与既有图标同一套画法：24×24 viewBox、stroke="currentColor"、
 *      strokeWidth 1.7、圆头圆角，且**不画填充图形**（直线几何，不是拟物的太阳）。
 */
describe("智能音视频平台 主题切换图标（BLF-1398）", () => {
  const glyph = read("components/av/AvGlyph.tsx");
  const navigation = read("lib/av/navigation.ts");

  it("AvGlyph 的图标集合包含 sun / moon", () => {
    expect(glyph).toMatch(/^\s*sun:\s*\(/m);
    expect(glyph).toMatch(/^\s*moon:\s*\(/m);
  });

  it("AvIconName 类型已扩展 sun / moon", () => {
    expect(navigation).toMatch(/export type AvIconName/);
    const union = navigation.slice(navigation.indexOf("export type AvIconName"));
    expect(union).toMatch(/"sun"/);
    expect(union).toMatch(/"moon"/);
  });

  it("图标画法与既有图标一致（同一套 svg 参数）", () => {
    // viewBox / stroke / strokeWidth 由 AvGlyph 组件统一提供，新增图标不能自带一套
    expect(glyph).toMatch(/viewBox="0 0 24 24"/);
    expect(glyph).toMatch(/stroke="currentColor"/);
    expect(glyph).toMatch(/strokeWidth="1\.7"/);
    expect(glyph).toMatch(/strokeLinecap="round"/);
    expect(glyph).toMatch(/strokeLinejoin="round"/);
  });

  it("sun / moon 是直线几何，不是填充的拟物图形", () => {
    // 只取 PATHS 里这两个图标的定义，别把后面 AvGlyph 组件的 fill="none" 也算进来
    const sun = glyph.slice(glyph.indexOf("  sun: ("), glyph.indexOf("  moon: ("));
    const moon = glyph.slice(glyph.indexOf("  moon: ("), glyph.indexOf("};", glyph.indexOf("  moon: (")));
    // 不允许 fill 属性（既有图标一律靠 stroke 表达）
    expect(sun).not.toMatch(/fill=/);
    expect(moon).not.toMatch(/fill=/);
    // 太阳 = 圆心 + 直线光芒；月亮 = 单条轮廓
    expect(sun).toMatch(/<circle/);
    expect(sun).toMatch(/<path/);
    expect(moon).toMatch(/<path/);
    expect(moon).not.toMatch(/<circle/);
  });
});
