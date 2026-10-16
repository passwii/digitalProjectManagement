import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(resolve(process.cwd(), "app/globals.css"), "utf8");
const shellCss = readFileSync(resolve(process.cwd(), "components/ui/Shell.module.css"), "utf8");
const bellCss = readFileSync(resolve(process.cwd(), "components/ui/Bell.module.css"), "utf8");
const installPromptCss = readFileSync(resolve(process.cwd(), "components/pwa/InstallPrompt.module.css"), "utf8");
const mobileDockCss = readFileSync(resolve(process.cwd(), "components/mobile/MobileDock.module.css"), "utf8");

/** 测试约束：只提取 light theme 的扁平 token 块，颜色值为纯 hex 或单层 var()。 */
function lightTokens() {
  const start = css.indexOf(':root[data-theme="light"] {');
  expect(start).toBeGreaterThanOrEqual(0);
  const end = css.indexOf("\n}", start);
  expect(end).toBeGreaterThan(start);
  return Object.fromEntries(
    Array.from(css.slice(start, end).matchAll(/--([\w-]+):\s*([^;]+);/g), ([, name, value]) => [name, value.trim()]),
  );
}

function resolveColor(color: string): string {
  const match = color.match(/^var\(--([\w-]+)\)$/);
  return match ? resolveColor(lightTokens()[match[1]]) : color;
}

function luminance(color: string) {
  const channels = resolveColor(color).match(/[a-f\d]{2}/gi)?.slice(0, 3).map((channel) => {
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

describe("浅色主题色彩契约", () => {
  const tokens = lightTokens();

  it("采用确认的冷白工作面和深海蓝导航骨架", () => {
    expect(tokens.bg).toBe("#f1f5f7");
    expect(tokens.card).toBe("#ffffff");
    expect(tokens["nav-bg"]).toBe("#142f40");
    expect(tokens.navy).toBe(tokens["nav-bg"]);
    expect(tokens["nav-active-bg"]).toBe("#244657");
    expect(tokens["nav-active-ink"]).toBe("#f4f8fa");
    expect(tokens["nav-active-accent"]).toBe("#c6df7b");
    expect(tokens["nav-badge-border"]).toBe("var(--nav-ink)");
    expect(tokens.brand).toBe("#17617d");
    expect(tokens.action).toBe("#c6df7b");
  });

  it("移动 Dock 按压时禁用 Safari 默认的矩形触控高亮", () => {
    expect(mobileDockCss).toMatch(/\.tab\s*\{[\s\S]*?-webkit-tap-highlight-color:\s*transparent/);
  });

  it("移动 Dock 在浅色主题下切换到浅色表面和内容语义色", () => {
    expect(tokens["dock-bg"]).toBe("var(--card)");
    expect(tokens["dock-ink"]).toBe("var(--ink)");
    expect(tokens["dock-muted"]).toBe("var(--ink-2)");
    expect(tokens["dock-hover-bg"]).toBe("var(--row-hover)");
    expect(tokens["dock-active-bg"]).toBe("var(--brand-soft)");
    expect(tokens["dock-active-accent"]).toBe("var(--brand)");
    expect(tokens["dock-focus"]).toBe("var(--brand)");
    expect(tokens["dock-badge-border"]).toBe("var(--card)");

    expect(mobileDockCss).toMatch(/\.dock\s*\{[^}]*background:\s*var\(--dock-bg\)/);
    expect(mobileDockCss).toMatch(/\.tab\s*\{[^}]*color:\s*var\(--dock-muted\)/);
    expect(mobileDockCss).toMatch(/\.tabActive,[\s\S]*?\.tabActive:hover\s*\{[^}]*color:\s*var\(--dock-active-accent/);
    expect(mobileDockCss).toMatch(/\.pill\s*\{[^}]*background:\s*var\(--dock-active-bg/);
    expect(mobileDockCss).toMatch(/\.tab:focus-visible\s*\{\s*outline-color:\s*var\(--dock-focus\)/);
    expect(mobileDockCss).toMatch(/\.dot,[\s\S]*?\.badge\s*\{[^}]*border:\s*1\.5px solid var\(--dock-badge-border, var\(--navy\)\)/);

    expect(contrast(tokens["dock-ink"], tokens["dock-bg"])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(tokens["dock-muted"], tokens["dock-bg"])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(tokens["dock-active-accent"], tokens["dock-active-bg"])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(tokens["dock-focus"], tokens["dock-bg"])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(tokens["dock-badge-border"], tokens.danger)).toBeGreaterThanOrEqual(3);
  });

  it("已确认的白色顶栏及其控件在浅色主题下保持可读", () => {
    expect(shellCss).toMatch(/:global\(:root\[data-theme="light"\]\)\s*\.shell\[data-console-shell="true"\]\s*\.topbar\s*\{[^}]*background:\s*var\(--card\)/s);
    expect(shellCss).toMatch(/:global\(:root\[data-theme="light"\]\)\s*\.shell\[data-console-shell="true"\]\s*\.topTitle\s*\{\s*color:\s*var\(--ink\);\s*\}/);
    expect(shellCss).toMatch(/\.userChip:hover \.avatarSkel,[\s\S]*?\.userChip\[aria-expanded="true"\] \.nameSkel\s*\{[^}]*background:\s*var\(--ink-2\)/s);
    expect(bellCss).toMatch(/\.bell\s*\{[^}]*color:\s*var\(--ink-2\)/s);
    expect(contrast(tokens["ink-2"], tokens.card)).toBeGreaterThanOrEqual(3);
    expect(contrast(tokens.ink, tokens["brand-soft"])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(tokens["ink-2"], tokens["brand-soft"])).toBeGreaterThanOrEqual(3);
    expect(contrast(tokens.brand, tokens.card)).toBeGreaterThanOrEqual(3);
  });

  it("侧栏重试控件使用导航语义色并符合 WCAG AA", () => {
    expect(shellCss).toMatch(/:global\(:root\[data-theme="light"\]\)[\s\S]*?\.navRetry\s*\{[^}]*color:\s*var\(--nav-ink\);\s*background:\s*var\(--nav-bg\)/s);
    expect(contrast(tokens["nav-ink"], tokens["nav-bg"])).toBeGreaterThanOrEqual(4.5);
  });

  it("导航提示文案、焦点环和移动徽标符合组合对比度", () => {
    expect(installPromptCss).toMatch(/\.prompt\s*\{[^}]*background:\s*var\(--nav-bg\)/s);
    expect(installPromptCss).toMatch(/\.copy span\s*\{[^}]*color:\s*var\(--nav-muted\)/s);
    expect(installPromptCss).toMatch(/\.close\s*\{[^}]*color:\s*var\(--nav-muted\)/s);
    expect(installPromptCss).toMatch(/\.install:focus-visible,[\s\S]*?\.close:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--nav-active-accent\)/s);
    expect(shellCss).toMatch(/\.navLink:focus-visible,[\s\S]*?\.collapseBtn:focus-visible\s*\{\s*outline-color:\s*var\(--nav-active-accent\)/s);
    expect(mobileDockCss).toMatch(/\.tab:focus-visible\s*\{\s*outline-color:\s*var\(--dock-focus\)/);
    expect(mobileDockCss).toMatch(/\.dot,[\s\S]*?\.badge\s*\{[^}]*border:\s*1\.5px solid var\(--dock-badge-border, var\(--navy\)\)/);

    expect(contrast(tokens["nav-muted"], tokens["nav-bg"])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(tokens["nav-active-accent"], tokens["nav-bg"])).toBeGreaterThanOrEqual(3);
    expect(contrast(tokens["nav-active-accent"], tokens["nav-active-bg"])).toBeGreaterThanOrEqual(3);
    expect(contrast(tokens["nav-badge-border"], tokens["nav-bg"])).toBeGreaterThanOrEqual(3);
    expect(contrast(tokens["nav-badge-border"], tokens["nav-active-bg"])).toBeGreaterThanOrEqual(3);
    expect(contrast(tokens["nav-badge-border"], tokens.danger)).toBeGreaterThanOrEqual(3);
  });

  it("正文、导航文字和主要操作符合 WCAG AA 对比度", () => {
    expect(contrast(tokens.ink, tokens.bg)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(tokens.ink, tokens.card)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(tokens["nav-ink"], tokens["nav-bg"])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(tokens["nav-muted"], tokens["nav-bg"])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(tokens["nav-active-ink"], tokens["nav-active-bg"])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(tokens["nav-active-accent"], tokens["nav-active-bg"])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(tokens.brand, tokens.bg)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(tokens.warn, tokens.bg)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(tokens.danger, tokens.bg)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(tokens.done, tokens.bg)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(tokens["data-violet"], tokens.bg)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(tokens["data-green"], tokens.bg)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(tokens["on-action"], tokens.action)).toBeGreaterThanOrEqual(4.5);
  });
});
