/**
 * 登录页主题与响应式契约。
 *
 * 登录页的明暗差异全部落在样式层：深色默认值必须与工作台
 * `[data-console-shell="true"]` 的语义角色一致，浅色覆盖必须把同一组
 * 本地令牌交接给工作台浅色值；移动端仍是一张卡片单列，故事区不再叠一层大背景。
 * 这里读真实 CSS，锁住三件事：
 *   1. 深/浅两套本地调色板存在，且与工作台对应语义令牌逐项相等；
 *   2. CSS 里引用的每个 --login-* 都能在任一调色板里解析（拼错变量 = 静默失效）；
 *   3. 关键文字/按钮/错误态的组合对比度达到 WCAG AA。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const loginCss = readFileSync(resolve(process.cwd(), "app/login/login.module.css"), "utf8");
const shellCss = readFileSync(resolve(process.cwd(), "components/ui/Shell.module.css"), "utf8");
const globalsCss = readFileSync(resolve(process.cwd(), "app/globals.css"), "utf8");
const passwordInputCss = readFileSync(resolve(process.cwd(), "components/ui/PasswordInput.module.css"), "utf8");

/** 取一条规则下扁平的自定义属性定义（只用于调色板块）。 */
function tokensIn(css: string, selector: string): Record<string, string> {
  const start = css.indexOf(selector);
  expect(start, `缺少令牌块：${selector}`).toBeGreaterThanOrEqual(0);
  const end = css.indexOf("\n}", start);
  expect(end).toBeGreaterThan(start);
  return Object.fromEntries(
    Array.from(css.slice(start, end).matchAll(/--([\w-]+):\s*([^;]+);/g), ([, name, value]) => [name, value.trim()]),
  );
}

const darkPalette = tokensIn(loginCss, "\n.wrap {");
const lightPalette = tokensIn(loginCss, ':global(:root[data-theme="light"]) .wrap {');
const shellDark = tokensIn(shellCss, '.shell[data-console-shell="true"] {');
const shellLight = tokensIn(shellCss, ':global(:root[data-theme="light"]) .shell[data-console-shell="true"] {');

/** 登录页本地令牌 → 工作台语义令牌。两套主题都必须逐项相等。 */
const WORKBENCH_ROLES: Readonly<Record<string, string>> = {
  "--login-bg": "--bg",
  "--login-surface": "--card",
  "--login-surface-raised": "--card-lift",
  "--login-ink": "--ink",
  "--login-ink-2": "--ink-2",
  "--login-ink-3": "--ink-3",
  "--login-line": "--line",
  "--login-line-soft": "--line-soft",
  "--login-brand": "--brand",
  "--login-brand-hover": "--brand-hover",
  "--login-brand-soft": "--brand-soft",
  "--login-line-blue": "--line-blue",
  "--login-focus": "--focus-ring",
  "--login-danger": "--danger",
  "--login-danger-bg": "--danger-bg",
  "--login-line-danger": "--line-danger",
  "--login-control-border": "--control-border",
  "--login-success-ink": "--success-ink",
  "--login-done-bg": "--done-bg",
  "--login-on-brand": "--on-brand",
};

function luminance(color: string) {
  const channels = color
    .match(/[a-f\d]{2}/gi)
    ?.slice(0, 3)
    .map((channel) => {
      const value = parseInt(channel, 16) / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
  if (!channels || channels.length !== 3 || !color.startsWith("#")) {
    throw new Error(`Expected opaque hex color, received ${color}`);
  }
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function contrast(foreground: string, background: string) {
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

describe("登录页主题契约", () => {
  it("深色默认调色板与工作台语义令牌一致", () => {
    for (const [local, workbench] of Object.entries(WORKBENCH_ROLES)) {
      expect(darkPalette[local], `深色缺令牌 ${local}`).toBe(shellDark[workbench]);
    }
  });

  it("浅色调色板与工作台浅色语义令牌一致", () => {
    for (const [local, workbench] of Object.entries(WORKBENCH_ROLES)) {
      expect(lightPalette[local], `浅色缺令牌 ${local}`).toBe(shellLight[workbench]);
    }
  });

  it("所有 --login-* 引用都能在任一调色板解析", () => {
    const referenced = new Set(
      Array.from(loginCss.matchAll(/var\(--(login-[\w-]+)/g), ([, name]) => name),
    );
    expect(referenced.size).toBeGreaterThan(15);
    const defined = new Set([...Object.keys(darkPalette), ...Object.keys(lightPalette)]);
    expect(Array.from(referenced).filter((name) => !defined.has(name))).toEqual([]);
  });

  it("浅色段不再残留旧青色科幻配色", () => {
    for (const oldColor of [
      "#6cf3ff",
      "#c6ff72",
      "#07131f",
      "#0d1d2c",
      "#eaf9fb",
      "#ff9a6a",
      "rgba(108, 243, 255",
      "rgba(198, 255, 114",
      "rgba(146, 189, 210",
    ]) {
      expect(loginCss.toLowerCase()).not.toContain(oldColor.toLowerCase());
    }
  });

  it("正文、字段标签、按钮与错误文案满足 WCAG AA", () => {
    for (const palette of [darkPalette, lightPalette]) {
      expect(contrast(palette["login-ink"], palette["login-bg"])).toBeGreaterThanOrEqual(4.5);
      expect(contrast(palette["login-ink"], palette["login-surface"])).toBeGreaterThanOrEqual(4.5);
      expect(contrast(palette["login-ink-2"], palette["login-surface"])).toBeGreaterThanOrEqual(4.5);
      expect(contrast(palette["login-ink-3"], palette["login-surface"])).toBeGreaterThanOrEqual(4.5);
      expect(contrast(palette["login-on-brand"], palette["login-brand"])).toBeGreaterThanOrEqual(4.5);
      expect(contrast(palette["login-danger"], palette["login-surface"])).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("移动端是一张卡片单列，故事区不重复铺大背景", () => {
    const mobileStart = loginCss.indexOf("@media (max-width: 820px)");
    expect(mobileStart).toBeGreaterThanOrEqual(0);
    const mobile = loginCss.slice(mobileStart, loginCss.indexOf("@media (max-width: 420px)", mobileStart));

    expect(mobile).toMatch(/\.authCard\s*\{[^}]*flex-direction:\s*column/);
    const storyBlock = mobile.match(/\.story\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(storyBlock).toContain("border-right: 0");
    expect(storyBlock).toContain("border-bottom: 1px solid var(--login-line)");
    expect(storyBlock).not.toContain("background");
    expect(mobile).toMatch(/\.lede\s*\{\s*display:\s*none/);
    expect(mobile).toMatch(/\.steps\s*\{\s*display:\s*none/);
  });

  it("动效尊重 prefers-reduced-motion", () => {
    expect(loginCss).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    expect(loginCss).toMatch(/\.submitSpinner\s*\{\s*animation:\s*none/);
  });

  it("共享密码可见性按钮在浅色下仍使用语义色（改密页复用）", () => {
    expect(passwordInputCss).toContain(':global(:root[data-theme="light"]) .toggle');
    expect(passwordInputCss).toMatch(
      /:global\(:root\[data-theme="light"\]\) \.toggle:hover:not\(:disabled\)[^}]*border-color:\s*var\(--brand\)/,
    );
    // 共享组件仍消费工作台浅色令牌；只做存在性检查，避免与全站主题守卫重复。
    expect(globalsCss).toContain(':root[data-theme="light"] {');
  });
});
