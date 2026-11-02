import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const shellCss = readFileSync(resolve(process.cwd(), "components/ui/Shell.module.css"), "utf8");
const globalsCss = readFileSync(resolve(process.cwd(), "app/globals.css"), "utf8");
const DESIGN_SYSTEM_SELECTOR = '.shell[data-console-shell="true"]';
const LIGHT_SELECTOR = `:global(:root[data-theme="light"]) ${DESIGN_SYSTEM_SELECTOR}`;
const ACTIVE_NAV_SELECTOR = `${DESIGN_SYSTEM_SELECTOR} .navActive`;
const TITLE_MARK_SELECTOR = `${DESIGN_SYSTEM_SELECTOR} .topTitleMark`;
const NARROW_LAYOUT_MEDIA_SELECTOR = "@media (max-width: 900px)";
const INSET_HIGHLIGHT_DECLARATION = "box-shadow: inset 0 1px 0 var(--highlight-inset);";
const REQUIRED_THEME_ROLES = [
  "action",
  "todo",
  "doing",
  "warn",
  "danger",
  "done",
  "paused",
  "line",
  "nav-bg",
  "nav-ink",
  "nav-muted",
  "nav-border",
  "nav-hover-bg",
  "nav-active-bg",
  "nav-active-border",
  "nav-active-ink",
  "nav-active-accent",
  "nav-badge-border",
  "nav-shadow",
  "data-mint",
  "data-amber",
  "data-rose",
  "data-violet",
  "data-blue",
  "data-magenta",
  "data-aqua",
  "data-lemon",
  "data-green",
] as const;
const REQUIRED_RADII = {
  "radius-control": "10px",
  "radius-badge": "6px",
  radius: "12px",
  "radius-sheet": "18px",
} as const;

function declarations(selector: string) {
  const start = shellCss.indexOf(`${selector} {`);
  expect(start, `Missing scoped theme block: ${selector}`).toBeGreaterThanOrEqual(0);
  const end = shellCss.indexOf("\n}", start);
  expect(end, `Unclosed scoped theme block: ${selector}`).toBeGreaterThan(start);
  return Object.fromEntries(
    Array.from(shellCss.slice(start, end).matchAll(/--([\w-]+):\s*([^;]+);/g), ([, name, value]) => [name, value.trim()]),
  ) as Record<string, string>;
}

function cssBlock(source: string, selector: string): string | null {
  const marker = `${selector} {`;
  let start = source.indexOf(marker);
  while (start >= 0) {
    const lineStart = source.lastIndexOf("\n", start - 1) + 1;
    if (source.slice(lineStart, start).trim() === "") break;
    start = source.indexOf(marker, start + marker.length);
  }
  if (start < 0) return null;

  const openingBrace = start + marker.length - 1;
  let depth = 0;
  for (let index = openingBrace; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return null;
}

function hasInsetHighlight(source: string, selector: string): boolean {
  return cssBlock(source, selector)?.includes(INSET_HIGHLIGHT_DECLARATION) ?? false;
}

function resolveToken(name: string, values: Record<string, string>): string {
  const value = values[name];
  expect(value, `Missing token --${name}`).toBeTruthy();
  const ref = value.match(/^var\(--([\w-]+)\)$/);
  return ref ? resolveToken(ref[1], values) : value;
}

function luminance(color: string) {
  const match = color.match(/^#([\da-f]{6})$/i);
  expect(match, `Expected a six-digit hex token, received ${color}`).toBeTruthy();
  const channels = [0, 2, 4].map((index) => {
    const value = parseInt(match![1].slice(index, index + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function contrast(foreground: string, background: string) {
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

describe("authenticated workbench theme tokens", () => {
  it("scopes the graphite palette to the console shell and assigns saturated data roles", () => {
    const dark = declarations(DESIGN_SYSTEM_SELECTOR);

    expect(dark.bg).toBe("#141516");
    expect(dark.card).toBe("#191a1c");
    expect(dark["card-lift"]).toBe("#24272a");
    expect(dark.brand).toBe("#6aa9ff");
    expect(dark["data-mint"]).toBe("#59cdb0");
    expect(dark["data-amber"]).toBe("#f2c65c");
    expect(dark["data-rose"]).toBe("#e984b8");
    expect(dark.warn).toBe("#f2c65c");
    expect(dark.danger).toBe("#f17e78");
  });

  it("defines semantic status, action, line, navigation, data, and radius roles in both themes", () => {
    for (const selector of [DESIGN_SYSTEM_SELECTOR, LIGHT_SELECTOR]) {
      const theme = declarations(selector);

      for (const role of REQUIRED_THEME_ROLES) {
        expect(theme[role], `Missing token --${role} in ${selector}`).toBeTruthy();
      }
      for (const [radius, value] of Object.entries(REQUIRED_RADII)) {
        expect(theme[radius], `Missing or incorrect token --${radius} in ${selector}`).toBe(value);
      }
    }
  });

  it("defines and uses a scoped inset highlight for shell accents", () => {
    const dark = declarations(DESIGN_SYSTEM_SELECTOR);
    const light = declarations(LIGHT_SELECTOR);
    const narrowLayoutStart = shellCss.indexOf(`${NARROW_LAYOUT_MEDIA_SELECTOR} {`);
    expect(narrowLayoutStart, "Missing narrow-layout media block").toBeGreaterThanOrEqual(0);
    const narrowLayout = cssBlock(shellCss, NARROW_LAYOUT_MEDIA_SELECTOR);
    const titleMarkBlock = cssBlock(shellCss, TITLE_MARK_SELECTOR);

    expect(dark["highlight-inset"]).toBe("rgba(237, 237, 237, 0.12)");
    expect(light["highlight-inset"]).toBe("rgba(241, 244, 245, 0.12)");
    expect(hasInsetHighlight(shellCss.slice(0, narrowLayoutStart), ACTIVE_NAV_SELECTOR)).toBe(true);
    expect(hasInsetHighlight(shellCss, TITLE_MARK_SELECTOR)).toBe(true);
    expect(hasInsetHighlight(narrowLayout ?? "", ACTIVE_NAV_SELECTOR)).toBe(true);

    expect(titleMarkBlock).not.toBeNull();
    const changedTitleMarkBlock = titleMarkBlock!.replace("var(--highlight-inset)", "var(--missing-highlight)");
    expect(changedTitleMarkBlock).not.toBe(titleMarkBlock);
    const changedShellCss = shellCss.replace(titleMarkBlock!, changedTitleMarkBlock);
    expect(hasInsetHighlight(changedShellCss, TITLE_MARK_SELECTOR)).toBe(false);
  });

  it("keeps dark workbench text, navigation, focus, and primary action readable", () => {
    const dark = declarations(DESIGN_SYSTEM_SELECTOR);

    expect(contrast(resolveToken("ink", dark), resolveToken("bg", dark))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(resolveToken("nav-ink", dark), resolveToken("nav-bg", dark))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(resolveToken("done", dark), resolveToken("card", dark))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(resolveToken("focus-ring", dark), resolveToken("card", dark))).toBeGreaterThanOrEqual(3);
    expect(contrast(resolveToken("on-action", dark), resolveToken("action", dark))).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps the light workbench palette equivalent and readable", () => {
    const light = declarations(LIGHT_SELECTOR);

    expect(light.bg).toBe("#eef2f3");
    expect(light.card).toBe("#fbfcfd");
    expect(light["card-lift"]).toBe("#e4e9ec");
    expect(light.brand).toBe("#286ca4");
    expect(light["data-mint"]).toBe("#16846e");
    expect(contrast(resolveToken("ink", light), resolveToken("bg", light))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(resolveToken("nav-ink", light), resolveToken("nav-bg", light))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(resolveToken("done", light), resolveToken("card", light))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(resolveToken("focus-ring", light), resolveToken("card", light))).toBeGreaterThanOrEqual(3);
    expect(contrast(resolveToken("on-action", light), resolveToken("action", light))).toBeGreaterThanOrEqual(4.5);
  });

  it("leaves root tokens available to the isolated login and demo surfaces", () => {
    expect(globalsCss).toContain(":root[data-theme=\"light\"] {");
    expect(globalsCss).toContain("--bg: #07131f;");
    expect(globalsCss).toContain("--nav-bg: #142f40;");
  });
});
