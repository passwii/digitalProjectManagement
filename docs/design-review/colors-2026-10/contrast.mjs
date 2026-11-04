#!/usr/bin/env node
/**
 * 配色审计复现脚本（只读，无第三方依赖）。
 * repo 根目录 = 本文件向上三级。
 *
 * 运行：node docs/design-review/colors-2026-10/contrast.mjs
 *      node docs/design-review/colors-2026-10/contrast.mjs --scan   # 只跑硬编码扫描
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../..");
const CSS_PATH = path.join(REPO, "web/app/globals.css");

/* ---------------- 颜色基础 ---------------- */

function parseColor(input) {
  const s = String(input).trim();
  if (s === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  let m = s.match(/^#([0-9a-f]{3,8})$/i);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join("");
    if (h.length !== 6 && h.length !== 8) throw new Error("bad hex: " + s);
    const n = parseInt(h.slice(0, 6), 16);
    const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a };
  }
  m = s.match(/^rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:[ ,/]+([\d.%]+))?\s*\)$/i);
  if (m) {
    let a = 1;
    if (m[4] != null) a = m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return { r: parseFloat(m[1]), g: parseFloat(m[2]), b: parseFloat(m[3]), a };
  }
  throw new Error("unsupported color: " + s);
}

const clamp01 = (x) => Math.min(1, Math.max(0, x));

function composite(fg, bg) {
  const a = fg.a;
  return {
    r: fg.r * a + bg.r * (1 - a),
    g: fg.g * a + bg.g * (1 - a),
    b: fg.b * a + bg.b * (1 - a),
    a: 1,
  };
}

function toHex(c) {
  const h = (x) => Math.round(clamp01(x / 255) * 255).toString(16).padStart(2, "0");
  return "#" + h(c.r) + h(c.g) + h(c.b);
}

function srgbToLinear(c) {
  const x = c / 255;
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
}

function relativeLuminance(c) {
  const r = srgbToLinear(c.r), g = srgbToLinear(c.g), b = srgbToLinear(c.b);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(fg, bg) {
  const L1 = relativeLuminance(fg), L2 = relativeLuminance(bg);
  const hi = L1 >= L2 ? L1 : L2;
  const lo = L1 >= L2 ? L2 : L1;
  return (hi + 0.05) / (lo + 0.05);
}

/* sRGB → OKLab → OKLCH（D65，Björn Ottosson 系数） */
function toOklch(c) {
  const r = srgbToLinear(c.r), g = srgbToLinear(c.g), b = srgbToLinear(c.b);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const C = Math.hypot(A, B);
  let h = (Math.atan2(B, A) * 180) / Math.PI;
  if (h < 0) h += 360;
  return { L, C, h };
}

/* sRGB → HSL */
function toHsl(c) {
  const r = c.r / 255, g = c.g / 255, b = c.b / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const d = max - min;
  const L = (max + min) / 2;
  let h = 0, s = 0;
  if (d !== 0) {
    s = d / (1 - Math.abs(2 * L - 1));
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: s * 100, l: L * 100 };
}

function hueDelta(h1, h2) {
  const d = Math.abs(h1 - h2) % 360;
  return d > 180 ? 360 - d : d;
}

/* ---------------- 解析 globals.css ---------------- */

const css = readFileSync(CSS_PATH, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const rootDecls = new Map();
const lightDecls = new Map();

for (const m of css.matchAll(/(^|\n)(:root(?:\[data-theme="light"\])?)\s*\{([^}]*)\}/g)) {
  const selector = m[2];
  const body = m[3];
  const target = selector.includes("light") ? lightDecls : rootDecls;
  for (const d of body.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) {
    target.set(d[1], d[2].trim().replace(/\s+/g, " "));
  }
}

function resolveRaw(name, theme) {
  const seen = new Set();
  let cur = theme === "light" && lightDecls.has(name) ? lightDecls.get(name) : rootDecls.get(name);
  if (cur == null) return null;
  while (/^var\(/.test(cur)) {
    if (seen.has(cur)) return null;
    seen.add(cur);
    const mm = cur.match(/^var\(\s*(--[\w-]+)\s*(?:,\s*([^)]+))?\)$/);
    if (!mm) return null;
    const next = theme === "light" && lightDecls.has(mm[1].slice(2)) ? lightDecls.get(mm[1].slice(2)) : rootDecls.get(mm[1].slice(2));
    cur = next != null ? next : mm[2];
    if (cur == null) return null;
  }
  return cur;
}

/* 每个 rgba 令牌假设叠加的底色（用于给出等效 hex） */
const BASE = {
  "ink-2": "bg", "ink-3": "bg",
  line: "bg", "line-soft": "bg", "line-blue": "bg", "line-warn": "bg", "line-danger": "bg", "line-done": "bg",
  "brand-soft": "bg", "row-hover": "card", "skeleton-base": "card", "skeleton-shine": "card",
  "todo-bg": "bg", "doing-bg": "bg", "done-bg": "bg", "warn-bg": "bg", "danger-bg": "bg", "paused-bg": "bg",
  "violet-soft": "bg", "overlay": "bg", "signal-glow": "bg",
  "th-bg": "card",
  "nav-muted": "nav-bg", "nav-border": "nav-bg", "nav-hover-bg": "nav-bg", "nav-active-bg": "nav-bg",
};

function resolvedColor(name, theme) {
  const raw = resolveRaw(name, theme);
  if (raw == null) return null;
  return { raw: raw, color: parseColor(raw) };
}

function solidColor(name, theme, depth) {
  depth = depth || 0;
  const r = resolvedColor(name, theme);
  if (!r) return null;
  if (r.color.a >= 1) return r.color;
  const baseName = BASE[name] || "bg";
  const base = solidColor(baseName, theme, depth + 1);
  if (!base) return null;
  return composite(r.color, base);
}

/* ---------------- 令牌语义表 ---------------- */
const TOKENS = [
  ["bg", "页面底色", "表面"],
  ["card", "卡片 / 面板面", "表面"],
  ["card-lift", "抬升表面（表头、面板头）", "表面"],
  ["th-bg", "表头底（半透明）", "表面"],
  ["navy", "品牌深蓝基准（侧栏 / 登录深色区）", "表面"],
  ["overlay", "遮罩", "表面"],
  ["ink", "主文字", "文字"],
  ["ink-2", "次级文字", "文字"],
  ["ink-3", "三级 / 辅助文字", "文字"],
  ["on-brand", "品牌色上的文字", "文字"],
  ["on-action", "主按钮上的文字", "文字"],
  ["on-danger", "危险按钮上的文字", "文字"],
  ["line", "主分隔线", "描边 / 分隔"],
  ["line-soft", "弱分隔线", "描边 / 分隔"],
  ["separator", "分隔线（仅浅色定义）", "描边 / 分隔"],
  ["control-border", "表单控件描边（仅浅色定义）", "描边 / 分隔"],
  ["action-border", "主按钮描边（仅浅色定义）", "描边 / 分隔"],
  ["nav-border", "导航边框", "描边 / 分隔"],
  ["line-blue", "品牌色描边", "描边 / 分隔"],
  ["line-warn", "警告描边", "描边 / 分隔"],
  ["line-danger", "危险描边", "描边 / 分隔"],
  ["line-done", "完成描边", "描边 / 分隔"],
  ["brand", "品牌信号色", "品牌"],
  ["brand-hover", "品牌色悬停", "品牌"],
  ["brand-soft", "品牌淡底", "品牌"],
  ["signal-glow", "品牌 / 焦点光晕", "品牌"],
  ["action", "主按钮底色", "动作"],
  ["action-hover", "主按钮悬停底", "动作"],
  ["todo", "待办状态文字", "状态"],
  ["todo-bg", "待办状态底", "状态"],
  ["doing", "进行中状态", "状态"],
  ["doing-bg", "进行中状态底", "状态"],
  ["done", "完成状态", "状态"],
  ["done-bg", "完成状态底", "状态"],
  ["success-ink", "成功文字（仅浅色定义）", "状态"],
  ["warn", "警告状态", "状态"],
  ["warn-bg", "警告状态底", "状态"],
  ["danger", "危险状态", "状态"],
  ["danger-bg", "危险状态底", "状态"],
  ["paused", "暂停状态", "状态"],
  ["paused-bg", "暂停状态底", "状态"],
  ["violet-soft", "数据紫淡底", "状态"],
  ["data-violet", "数据系列：紫", "数据系列"],
  ["data-blue", "数据系列：蓝", "数据系列"],
  ["data-magenta", "数据系列：品红", "数据系列"],
  ["data-aqua", "数据系列：水绿", "数据系列"],
  ["data-lemon", "数据系列：柠檬", "数据系列"],
  ["data-green", "数据系列：绿（仅浅色定义）", "数据系列"],
  ["nav-bg", "导航 / 侧栏底色", "导航"],
  ["nav-ink", "导航主文字", "导航"],
  ["nav-muted", "导航次级文字", "导航"],
  ["nav-hover-bg", "导航悬停底", "导航"],
  ["nav-active-bg", "导航激活底", "导航"],
  ["nav-active-ink", "导航激活文字", "导航"],
  ["nav-active-accent", "导航激活强调色", "导航"],
  ["nav-badge-border", "导航徽标描边", "导航"],
  ["dock-bg", "移动 Dock 底", "Dock（别名）"],
  ["dock-ink", "移动 Dock 文字", "Dock（别名）"],
  ["dock-muted", "移动 Dock 次级文字", "Dock（别名）"],
  ["dock-hover-bg", "移动 Dock 悬停底", "Dock（别名）"],
  ["dock-active-bg", "移动 Dock 激活底", "Dock（别名）"],
  ["dock-active-accent", "移动 Dock 激活强调", "Dock（别名）"],
  ["dock-focus", "移动 Dock 焦点", "Dock（别名）"],
  ["dock-badge-border", "移动 Dock 徽标描边", "Dock（别名）"],
  ["avatar-1", "头像底色 1", "头像"],
  ["avatar-2", "头像底色 2", "头像"],
  ["avatar-3", "头像底色 3", "头像"],
  ["avatar-4", "头像底色 4", "头像"],
  ["avatar-5", "头像底色 5", "头像"],
  ["avatar-6", "头像底色 6", "头像"],
  ["row-hover", "表格行悬停", "交互 / 骨架"],
  ["skeleton-base", "骨架基色", "交互 / 骨架"],
  ["skeleton-shine", "骨架高光", "交互 / 骨架"],
];

function typeOf(name, theme) {
  const raw = theme === "light" ? (lightDecls.get(name) ?? rootDecls.get(name)) : rootDecls.get(name);
  if (raw == null) return "未定义";
  if (/^var\(/.test(raw)) return "别名";
  if (/^#/.test(raw)) return "hex";
  if (/^rgba?/.test(raw)) return "rgba";
  return raw.startsWith("hsl") ? "hsl" : "其他";
}

function printTokenTable() {
  console.log("\n## 1. 令牌对账（rgba 等效 hex 按表下假设底色合成）\n");
  console.log("| 语义组 | 角色（令牌） | 深色值 | 深色等效 | 浅色值 | 浅色等效 | 值类型 |");
  console.log("| --- | --- | --- | --- | --- | --- | --- |");
  for (const item of TOKENS) {
    const name = item[0], role = item[1], group = item[2];
    const dark = resolvedColor(name, "dark");
    const light = resolvedColor(name, "light");
    const darkSolid = solidColor(name, "dark");
    const lightSolid = solidColor(name, "light");
    const dType = typeOf(name, "dark");
    const lType = typeOf(name, "light");
    const darkVal = dark ? dark.raw : "—";
    const lightVal = light ? light.raw : "—";
    const type = dType === lType ? dType : dType + " / " + lType;
    const darkEq = darkSolid ? toHex(darkSolid) : "—";
    const lightEq = lightSolid ? toHex(lightSolid) : "—";
    console.log("| " + group + " | " + role + " (" + name + ") | " + darkVal + " | " + darkEq + " | " + lightVal + " | " + lightEq + " | " + type + " |");
  }
  console.log("\n合成底色假设：ink-2/ink-3/line*/ *-bg /brand-soft/violet-soft/overlay/signal-glow → --bg；th-bg/row-hover/skeleton-* → --card；nav-muted/nav-border/nav-hover-bg/nav-active-bg → --nav-bg。");
}

/* ---------------- 对比度 ---------------- */
const PAIRS = [
  ["ink / bg", "ink", "bg", "text"],
  ["ink-2 / bg", "ink-2", "bg", "text"],
  ["ink-3 / bg", "ink-3", "bg", "text"],
  ["ink / card", "ink", "card", "text"],
  ["ink-2 / card", "ink-2", "card", "text"],
  ["ink-3 / card", "ink-3", "card", "text"],
  ["brand / bg", "brand", "bg", "text"],
  ["brand / card", "brand", "card", "text"],
  ["on-action / action", "on-action", "action", "text"],
  ["on-brand / brand", "on-brand", "brand", "text"],
  ["warn / bg", "warn", "bg", "text"],
  ["danger / bg", "danger", "bg", "text"],
  ["done / done-bg", "done", "done-bg", "text"],
  ["todo / todo-bg", "todo", "todo-bg", "text"],
  ["nav-ink / nav-bg", "nav-ink", "nav-bg", "text"],
  ["nav-muted / nav-bg", "nav-muted", "nav-bg", "text"],
  ["nav-active-accent / nav-active-bg", "nav-active-accent", "nav-active-bg", "text"],
  ["line / bg（非文本）", "line", "bg", "nontext"],
  ["line / card（非文本）", "line", "card", "nontext"],
  ["brand 焦点环 / bg（非文本）", "brand", "bg", "nontext"],
  ["brand 焦点环 / card（非文本）", "brand", "card", "nontext"],
];

function printContrast(theme) {
  console.log("\n## 2. 对比度实测（" + (theme === "dark" ? "深色" : "浅色") + "，WCAG 2.1 sRGB 相对亮度）\n");
  console.log("| 组合 | 前景等效 | 背景等效 | 对比度 | 阈值 | 结果 |");
  console.log("| --- | --- | --- | --- | --- | --- |");
  for (const pair of PAIRS) {
    const label = pair[0], fgName = pair[1], bgName = pair[2], kind = pair[3];
    const bgBase = solidColor(bgName, theme);
    const fg = resolvedColor(fgName, theme);
    if (!bgBase || !fg) {
      console.log("| " + label + " | — | — | — | " + (kind === "text" ? "4.5:1" : "3:1") + " | 无法计算 |");
      continue;
    }
    let fgColor = fg.color;
    if (fgColor.a < 1) fgColor = composite(fgColor, bgBase);
    const ratio = contrastRatio(fgColor, bgBase);
    const threshold = kind === "text" ? 4.5 : 3;
    const ok = ratio >= threshold;
    console.log("| " + label + " | " + toHex(fgColor) + " | " + toHex(bgBase) + " | **" + ratio.toFixed(2) + ":1** | " + threshold + ":1 | " + (ok ? "通过" : "**未达标**") + " |");
  }
}

/* ---------------- 主题等价性 ---------------- */
const EQ_PAIRS = [
  ["brand", "#6cf3ff", "#17617d"],
  ["brand-hover", "#c6ff72", "#124d64"],
  ["action", "#c6ff72", "#c6df7b"],
  ["done", "#c6ff72", "#356b4b"],
  ["danger", "#ff9a6a", "#a23e39"],
  ["warn", "#ffc46b", "#805518"],
  ["data-violet", "#bda6ff", "#6d4cc2"],
  ["nav-active-accent", "#6cf3ff", "#c6df7b"],
];

function printEquivalence() {
  console.log("\n## 5. 同令牌深浅两套的 OKLCH / HSL 差异\n");
  console.log("| 令牌 | 深色 | 浅色 | 深 OKLCH (L / C / h) | 浅 OKLCH (L / C / h) | ΔL | ΔC | Δh | 深 HSL (H / S / L) | 浅 HSL (H / S / L) |");
  console.log("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const pair of EQ_PAIRS) {
    const name = pair[0], darkHex = pair[1], lightHex = pair[2];
    const d = parseColor(darkHex), l = parseColor(lightHex);
    const dk = toOklch(d), lt = toOklch(l);
    const dh = toHsl(d), lh = toHsl(l);
    console.log("| " + name + " | " + darkHex + " | " + lightHex + " | " + dk.L.toFixed(3) + " / " + dk.C.toFixed(3) + " / " + dk.h.toFixed(1) + "° | " + lt.L.toFixed(3) + " / " + lt.C.toFixed(3) + " / " + lt.h.toFixed(1) + "° | " + ((lt.L - dk.L) * 100).toFixed(1) + "pp | " + (lt.C - dk.C).toFixed(3) + " | " + hueDelta(dk.h, lt.h).toFixed(1) + "° | " + dh.h.toFixed(0) + "° / " + dh.s.toFixed(0) + "% / " + dh.l.toFixed(0) + "% | " + lh.h.toFixed(0) + "° / " + lh.s.toFixed(0) + "% / " + lh.l.toFixed(0) + "% |");
  }
}

/* ---------------- --brand 一词多职责 ---------------- */
function walkAll(dir, out) {
  out = out || [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next") continue;
    const p = path.join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walkAll(p, out);
    else if (name.endsWith(".css") || name.endsWith(".tsx")) out.push(p);
  }
  return out;
}

const BRAND_GROUPS = [
  ["ALIAS", "令牌别名定义（把 --brand 转成其他语义）"],
  ["FOCUS", "焦点外框（outline / outline-color）"],
  ["RING", "高亮环 / 内阴影（box-shadow）"],
  ["NATIVE", "原生控件（光标 / checkbox accent）"],
  ["CHART", "图表系列（stroke / fill）"],
  ["FILL", "背景填充（选中块 / 进度条 / 徽标 / 图表点）"],
  ["BORDER", "控件描边与悬停边框"],
  ["TEXT", "文字 / 链接 / 图标颜色"],
  ["OTHER", "其他（列表左侧指示条等）"],
];

function brandClass(text) {
  if (/^\s*--[\w-]+\s*:\s*var\(--brand\)/.test(text)) return "ALIAS";
  if (/outline(-color)?\s*:/.test(text)) return "FOCUS";
  if (/box-shadow/.test(text)) return "RING";
  if (/caret-color|accent-color/.test(text)) return "NATIVE";
  if (/stroke|fill\s*=/.test(text)) return "CHART";
  if (/background(-color)?\s*:/.test(text)) return "FILL";
  if (/border/.test(text)) return "BORDER";
  if (/color\s*:/.test(text)) return "TEXT";
  return "OTHER";
}

function printBrandResponsibility() {
  const files = walkAll(path.join(REPO, "web/app")).concat(walkAll(path.join(REPO, "web/components")));
  const counts = {};
  let occ = 0, lineCount = 0, fileCount = 0;
  for (const file of files) {
    const lines = readFileSync(file, "utf8").split("\n");
    let has = false;
    lines.forEach((line) => {
      const n = (line.match(/var\(--brand\)/g) || []).length;
      if (!n) return;
      has = true;
      lineCount++;
      occ += n;
      const g = brandClass(line);
      counts[g] = (counts[g] || 0) + n;
    });
    if (has) fileCount++;
  }
  console.log("\n## 4. --brand 引用面（直接 var(--brand)，全部 *.css / *.tsx）\n");
  console.log("| 语义分组（按行内属性优先级归类） | 引用处数 | 示例 |");
  console.log("| --- | --- | --- |");
  const examples = {
    ALIAS: "app/globals.css:100 --nav-active-accent；app/globals.css:2663 --av-signal",
    FOCUS: "app/globals.css:405 outline: 2px solid；components/ui/CardList.module.css:98",
    RING: "app/globals.css:372 box-shadow ring；app/(dashboard)/changelog/changelog.module.css:207",
    NATIVE: "app/globals.css:288 caret-color；app/globals.css:358 accent-color",
    CHART: "app/(dashboard)/dashboard/page.tsx:301 stroke=var(--brand)",
    FILL: "components/ui/ProgressBar.module.css:4；components/motion/ActivityBar.module.css:17",
    BORDER: "app/globals.css:366 input focus border；components/ui/DatePicker.module.css:216",
    TEXT: "app/globals.css:292 a 链接；components/ui/Shell.module.css:206 导航激活图标",
    OTHER: "app/globals.css:696 inset 3px 0 0",
  };
  for (const g of BRAND_GROUPS) {
    console.log("| " + g[1] + " | " + (counts[g[0]] || 0) + " | " + examples[g[0]] + " |");
  }
  console.log("| **合计** | **" + occ + "** | " + lineCount + " 行 / " + fileCount + " 个文件 |");
  console.log("\n别名消费（同一 --brand 经别名再被引用）：\n");
  console.log("| 别名 | 语义 | 定义位置 | 消费处数 |");
  console.log("| --- | --- | --- | --- |");
  const aliases = [
    ["nav-active-accent", "导航激活强调色", "app/globals.css:100"],
    ["dock-active-accent", "移动 Dock 激活", "app/globals.css:208"],
    ["dock-focus", "移动 Dock 焦点", "app/globals.css:209"],
    ["av-signal", "音视频站点信号色", "app/globals.css:2663"],
    ["av-series-1", "音视频图表系列 1", "app/globals.css:2706"],
    ["av-level-3", "三级告警色（0 消费，死别名）", "app/globals.css:2677"],
    ["dash-cyan", "仪表盘信号色", "app/(dashboard)/dashboard/dashboard.module.css:10"],
    ["login-signal", "登录页信号色", "app/login/login.module.css:759（浅色）/ :8（深色字面）"],
    ["select-accent", "Select 组件强调色", "components/ui/Select.module.css:104"],
  ];
  let indirect = 0;
  for (const a of aliases) {
    const needle = "var(--" + a[0];
    let n = 0;
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      let idx = 0;
      while ((idx = text.indexOf(needle, idx)) !== -1) {
        const after = text[idx + needle.length] || "";
        if (!/[\w-]/.test(after)) n++;
        idx += needle.length;
      }
    }
    indirect += n;
    console.log("| --" + a[0] + " | " + a[1] + " | " + a[2] + " | " + n + " |");
  }
  console.log("| **合计** | | | **" + indirect + "** |");
  console.log("\n口径：直接引用 = 文本中 var(--brand) 的出现次数；别名消费 = 9 个间接令牌被 var(--…) 引用的次数（不含令牌定义行）。--doing（#6cf3ff）是字面重复而非别名，未计入。");
}

/* ---------------- 硬编码扫描（粗口径） ---------------- */
function walk(dir, out) {
  out = out || [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next") continue;
    const p = path.join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (name.endsWith(".module.css") || name.endsWith(".tsx")) out.push(p);
  }
  return out;
}

const LITERAL = /#[0-9a-fA-F]{3,8}\b|\brgba?\([^)]*\)|\bhsla?\([^)]*\)/g;

function scan() {
  const files = walk(path.join(REPO, "web/app")).concat(walk(path.join(REPO, "web/components")));
  const rows = [];
  let raw = 0;
  for (const file of files) {
    let text = readFileSync(file, "utf8");
    const rel = path.relative(path.join(REPO, "web"), file);
    raw += (text.match(LITERAL) || []).length;
    text = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const lines = text.split("\n");
    const hits = [];
    lines.forEach((line, i) => {
      LITERAL.lastIndex = 0;
      let m;
      let count = 0;
      while ((m = LITERAL.exec(line))) {
        count++;
      }
      if (count) hits.push({ line: i + 1, count: count, text: line.trim() });
    });
    if (hits.length) rows.push({ file: rel, count: hits.reduce((s, h) => s + h.count, 0), hits: hits });
  }
  rows.sort((a, b) => b.count - a.count);
  console.log("\n## 3. 硬编码色值扫描（*.module.css + *.tsx，去注释后）\n");
  console.log("| 文件 | 处数 |");
  console.log("| --- | --- |");
  for (const r of rows) console.log("| " + r.file + " | " + r.count + " |");
  console.log("\n文件数 " + rows.length + "；去注释后处数 " + rows.reduce((s, r) => s + r.count, 0) + "；含注释粗口径 " + raw + "。");
}

const onlyScan = process.argv.includes("--scan");
if (!onlyScan) {
  printTokenTable();
  printContrast("dark");
  printContrast("light");
  printEquivalence();
  printBrandResponsibility();
}
scan();
