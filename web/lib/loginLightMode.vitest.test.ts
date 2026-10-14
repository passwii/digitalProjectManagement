/**
 * 登录页浅色适配的 CSS 契约（BLF-1343）。
 *
 * 为什么是 CSS 契约而不是 DOM 测试：登录页的明暗差异**全部**落在样式层——组件树、
 * 文案、无障碍语义在两套主题下完全一致（`loginPage.dom.vitest.test.tsx` 守着那部分）。
 * 一个「浅色下仍是深色世界」的回归不会让任何 DOM 断言变红，只会在肉眼上出现。
 * 所以这里读真实 CSS 文件，锁三件事：
 *   1. 浅色覆盖段确实存在，且本地调色板交接给已落地的浅色语义 token（不新造颜色）；
 *   2. 浅色段引用的每个 `var()` 都能解析（拼错变量名 = 静默失效，是最常见的失手）；
 *   3. 关键文字/按钮/错误态的组合对比度达到 WCAG AA。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const globalsCss = readFileSync(resolve(process.cwd(), "app/globals.css"), "utf8");
const loginCss = readFileSync(resolve(process.cwd(), "app/login/login.module.css"), "utf8");
const passwordInputCss = readFileSync(resolve(process.cwd(), "components/ui/PasswordInput.module.css"), "utf8");

/** 浅色覆盖段的起始注释：这段文字就是本测试的入口标记。 */
const LIGHT_SECTION_MARKER = " * 浅色适配（BLF-1343）";
/** 段内定义本地调色板的那条规则（深色默认值在文件开头，一行未动）。 */
const LIGHT_PALETTE_SELECTOR = ':global(:root[data-theme="light"]) .wrap {';

/** 取 `{` 到下一个行首 `}` 之间的扁平 token 定义（只用于调色板块）。 */
function tokensIn(css: string, from: number): Record<string, string> {
  const end = css.indexOf("\n}", from);
  expect(end).toBeGreaterThan(from);
  return Object.fromEntries(
    Array.from(css.slice(from, end).matchAll(/--([\w-]+):\s*([^;]+);/g), ([, name, value]) => [name, value.trim()]),
  );
}

const lightTokens = tokensIn(globalsCss, globalsCss.indexOf(':root[data-theme="light"] {'));

const lightSectionStart = loginCss.indexOf(LIGHT_SECTION_MARKER);
const lightSection = loginCss.slice(lightSectionStart);
const paletteStart = loginCss.indexOf(LIGHT_PALETTE_SELECTOR);
const lightPalette = tokensIn(loginCss, paletteStart);

/** 解析 `var(--x)` 链（globals 的浅色块里存在 `--line: var(--separator)` 这类两层引用）。 */
function resolveColor(color: string, depth = 0): string {
  const match = color.match(/^var\(--([\w-]+)\)$/);
  if (!match || depth > 4) return color;
  const next = lightTokens[match[1]];
  return next ? resolveColor(next, depth + 1) : color;
}

function luminance(color: string) {
  const channels = resolveColor(color)
    .match(/[a-f\d]{2}/gi)
    ?.slice(0, 3)
    .map((channel) => {
      const value = parseInt(channel, 16) / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
  if (!channels || channels.length !== 3) throw new Error(`Expected opaque hex color, received ${color}`);
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function contrast(foreground: string, background: string) {
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

function escapeSelector(selector: string) {
  return selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 取浅色段里某条规则的声明块；缺规则直接失败（没有覆盖 = 深色残留）。 */
function lightRule(css: string, selector: string) {
  const match = css.match(
    new RegExp(`:global\\(:root\\[data-theme="light"\\]\\)\\s*${escapeSelector(selector)}\\s*\\{([^}]*)\\}`),
  );
  expect(match, `浅色段缺少覆盖：${selector}`).toBeTruthy();
  return match![1];
}

describe("登录页浅色适配契约（BLF-1343）", () => {
  it("把登录页的本地调色板交接给浅色语义 token", () => {
    expect(loginCss).toContain(LIGHT_SECTION_MARKER);
    expect(lightPalette).toEqual({
      "login-bg": "var(--bg)",
      "login-surface": "var(--card)",
      "login-line": "var(--line)",
      "login-ink": "var(--ink)",
      "login-muted": "var(--ink-2)",
      "login-dim": "var(--ink-3)",
      "login-signal": "var(--brand)",
      "login-active": "var(--action)",
      "login-story-bg": "var(--nav-bg)",
      "login-story-ink": "var(--nav-ink)",
    });
  });

  it("品牌栏沿用深海蓝导航骨架，工作区切成冷白画布", () => {
    // 左栏是品牌身份：浅色下仍是深蓝导轨（与工作台侧栏同一套 nav token），不是白底
    expect(lightRule(loginCss, ".story")).toMatch(/var\(--login-story-bg\)/);
    expect(lightRule(loginCss, ".mark")).toMatch(/color:\s*var\(--login-story-ink\)/);
    expect(lightRule(loginCss, ".storyMain h1")).toMatch(/color:\s*var\(--login-story-ink\)/);

    // 右栏是工作区：冷白画布 + 白色内容面 + 冷灰边界
    expect(lightRule(loginCss, ".card")).toMatch(/background-size:\s*32px 32px,\s*auto/);
    expect(lightRule(loginCss, ".card")).toMatch(/border-color:\s*var\(--line\)/);
    expect(lightRule(loginCss, ".field input")).toMatch(/border-color:\s*var\(--control-border\)/);
    expect(lightRule(loginCss, ".field input")).toMatch(/background:\s*var\(--card\)/);

    // 浅色纪律：装饰性发光收敛、酸橙不再当装饰线
    expect(lightRule(loginCss, ".card::before")).toMatch(/box-shadow:\s*none/);
    expect(lightRule(loginCss, ".card::after")).toMatch(/background:\s*var\(--login-signal\)/);
    expect(lightRule(loginCss, ".storyMain h1 span")).toMatch(/text-shadow:\s*none/);
  });

  it("浅色段引用的每个 var() 都能解析（没有自造或拼错的 token）", () => {
    const referenced = new Set(Array.from(lightSection.matchAll(/var\(--([\w-]+)/g), ([, name]) => name));
    expect(referenced.size).toBeGreaterThan(15);
    const unresolved = Array.from(referenced).filter(
      (name) => !lightTokens[name] && !lightPalette[name],
    );
    expect(unresolved).toEqual([]);
  });

  it("浅色段不留深色硬编码", () => {
    for (const darkValue of [
      "#07131f",
      "#081622",
      "#0d1d2c",
      "rgba(108, 243, 255",
      "rgba(198, 255, 114",
      "rgba(146, 189, 210",
      "rgba(4, 13, 22",
      "#ff9a6a",
      "#eaf9fb",
    ]) {
      expect(lightSection.toLowerCase()).not.toContain(darkValue.toLowerCase());
    }
  });

  it("正文、标签、按钮与状态文案满足 WCAG AA", () => {
    const local = (name: string) => lightPalette[name];
    const global = (name: string) => lightTokens[name];

    // 工作区：正文 / 字段标签与状态说明 / placeholder
    expect(contrast(local("login-ink"), local("login-bg"))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(local("login-ink"), local("login-surface"))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(local("login-muted"), local("login-surface"))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(local("login-dim"), local("login-surface"))).toBeGreaterThanOrEqual(4.5);

    // 主按钮三态：默认（青柠 + 深前景）/ 载入中（次级面 + 次文字）/ 成功（完成绿 + 完成底）
    expect(lightRule(loginCss, ".submit")).toMatch(/color:\s*var\(--on-action\)/);
    expect(lightRule(loginCss, ".submit:disabled")).toMatch(/background:\s*var\(--th-bg\)/);
    expect(lightRule(loginCss, ".submit:disabled")).toMatch(/color:\s*var\(--ink-2\)/);
    expect(lightRule(loginCss, '.submit[data-phase="success"]')).toMatch(/color:\s*var\(--success-ink\)/);
    expect(contrast(global("on-action"), local("login-active"))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(global("ink-2"), global("th-bg"))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(global("success-ink"), global("done-bg"))).toBeGreaterThanOrEqual(4.5);

    // 错误提示：错误色文字 + 低饱和错误底
    expect(lightRule(loginCss, ".alert")).toMatch(/color:\s*var\(--danger\)/);
    expect(lightRule(loginCss, ".alert")).toMatch(/background:\s*var\(--danger-bg\)/);
    expect(contrast(global("danger"), global("danger-bg"))).toBeGreaterThanOrEqual(4.5);

    // 品牌栏：深海蓝底上的字标与强调行
    expect(contrast(local("login-story-ink"), local("login-story-bg"))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(global("nav-active-accent"), local("login-story-bg"))).toBeGreaterThanOrEqual(4.5);

    // 焦点环与光标用信号青（白底卡片上 ≥ 4.5）
    expect(lightRule(loginCss, ".field input")).toMatch(/caret-color:\s*var\(--login-signal\)/);
    expect(contrast(local("login-signal"), local("login-surface"))).toBeGreaterThanOrEqual(4.5);
  });

  it("手机壳里品牌栏不再铺深蓝，字标与徽记改回工作区颜色", () => {
    const mobile = lightSection.slice(lightSection.indexOf("@media (max-width: 767px)"));
    expect(mobile).toMatch(/\.wrap\[data-login-page\] \.mark\s*\{\s*color:\s*var\(--ink\)/);
    expect(mobile).toMatch(/\.wrap\[data-login-page\] \.brandGlyph\s*\{[^}]*background:\s*var\(--brand-soft\)/);
    expect(mobile).toMatch(/\.wrap\[data-login-page\] \.brandGlyph i\s*\{\s*background:\s*var\(--login-signal\)/);
    // 手机上 `.wrap` 自带底色，`.auth` 不该再叠一层
    expect(mobile).toMatch(/\.wrap\[data-login-page\] \.auth\s*\{\s*background:\s*none/);
    // 品牌栏在手机壳里本来就不铺底（字标浮在画布上），浅色不能把深海蓝重新铺回来
    expect(mobile).toMatch(/\.wrap\[data-login-page\] \.story\s*\{\s*background:\s*none/);
    expect(mobile).toMatch(/\.wrap\[data-login-page\] \.storyGrid[\s\S]*?rgba\(23, 97, 125/);
  });

  it("密码可见性按钮在浅色下换成语义色（图标控件 ≥ 3:1）", () => {
    expect(passwordInputCss).toContain('data-theme="light"');
    const toggle = lightRule(passwordInputCss, ".toggle");
    expect(toggle).toMatch(/color:\s*var\(--ink-2\)/);
    expect(lightRule(passwordInputCss, ".toggle:hover")).toMatch(/border-color:\s*var\(--brand\)/);
    expect(lightRule(passwordInputCss, ".toggle:focus-visible")).toMatch(/outline-color:\s*var\(--brand\)/);
    // 白底卡片上的眼睛图标：`--ink-2` 实测 6:1，远高于图标类 3:1 的下限
    expect(contrast(lightTokens["ink-2"], lightTokens.card)).toBeGreaterThanOrEqual(3);
  });
});
