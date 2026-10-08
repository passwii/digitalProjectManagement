import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(resolve(process.cwd(), "app/globals.css"), "utf8");

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
    expect(tokens["nav-active-accent"]).toBe("#c6df7b");
    expect(tokens.brand).toBe("#17617d");
    expect(tokens.action).toBe("#c6df7b");
  });

  it("正文、导航文字和主要操作符合 WCAG AA 对比度", () => {
    expect(contrast(tokens.ink, tokens.bg)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(tokens.ink, tokens.card)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(tokens["nav-ink"], tokens["nav-bg"])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(tokens["nav-muted"], tokens["nav-bg"])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(tokens["nav-active-ink"], tokens["nav-active-bg"])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(tokens["nav-active-accent"], tokens["nav-active-bg"])).toBeGreaterThanOrEqual(4.5);
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
