// BLF-1429（父 issue 的 Stage 8）动效/配色回归之一：主题切换后图表色是否重读。
//
// 背景：recharts 的 `stroke` / `fill` 只接受具体色值，`var(--av-*)` 传不进去，所以
// `useAvPalette()` 用 `getComputedStyle` 读令牌的**计算值**。读的时机很关键：
// 依赖 `resolvedTheme` 会在 `data-theme` 还没落盘时读，图表停在上一套配色直到刷新
// （Stage 1 的 AC5）。判断「有没有重读」不能靠看截图 —— 必须比较切换前/后 SVG 上
// 真实挂着的 `stroke` / `fill`。
//
// 判定（任一条不成立即 fail）：
//   1. 深/浅两套令牌的 `--av-series-1` 必须不同（否则这条用例恒真）；
//   2. 切换前，图表里必须出现深色系列色（计数 > 0，防「命中 0 个元素也通过」）；
//   3. 切换后，图表里**不得残留**任何深色系列色；
//   4. 切换后，图表里必须出现浅色系列色。
//
// 用法：node scripts/av-palette-check.mjs <baseUrl> [outDir]
//   默认页面 /stream-monitor/overview?static=1（系列色最多的一页）。
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const baseUrl = process.argv[2] ?? "http://127.0.0.1:3012";
const outDir = process.argv[3] ?? "artifacts/blf1422";
const page = "overview";
const chromePath = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

mkdirSync(outDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const port = 9700 + Math.floor(Math.random() * 90);
const chrome = spawn(chromePath, [
  "--headless=new",
  "--disable-gpu",
  "--hide-scrollbars",
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${resolve(tmpdir(), `av-palette-check-${port}`)}`,
  "--window-size=1440,1400",
  "about:blank",
], { stdio: "ignore" });

let ws;
let nextId = 1;
const pending = new Map();

function send(method, params = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolvePromise, rejectPromise) => pending.set(id, { resolve: resolvePromise, reject: rejectPromise }));
}

async function evaluate(expression) {
  const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails));
  return result.result.value;
}

async function waitFor(expression, timeoutMs = 20000, label = expression) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await evaluate(expression)) return;
    await sleep(150);
  }
  throw new Error(`等待超时：${label}`);
}

/** 读令牌 + 图表上真实挂着的颜色（去掉 rgb()/hex 的空格差异后比较）。 */
const SNAPSHOT = `(() => {
  const styles = getComputedStyle(document.documentElement);
  const normalize = (value) => {
    const raw = (value || "").trim().toLowerCase();
    const hex = raw.match(/^#([0-9a-f]{6})$/);
    if (hex) {
      const [r, g, b] = [0, 2, 4].map((offset) => parseInt(hex[1].slice(offset, offset + 2), 16));
      return "rgb(" + r + ", " + g + ", " + b + ")";
    }
    return raw.replace(/\\s+/g, " ");
  };
  const series = Array.from({ length: 8 }, (_, index) => normalize(styles.getPropertyValue("--av-series-" + (index + 1))));
  const painted = new Set();
  for (const node of document.querySelectorAll(".recharts-wrapper path, .recharts-wrapper rect, .recharts-wrapper circle")) {
    for (const attr of ["stroke", "fill"]) {
      const value = node.getAttribute(attr);
      if (value && value !== "none") painted.add(normalize(value));
    }
  }
  return {
    theme: document.documentElement.dataset.theme ?? null,
    series,
    painted: Array.from(painted),
    chartNodes: document.querySelectorAll(".recharts-wrapper svg").length,
  };
})()`;

const result = { baseUrl, page, checks: {}, failures: [], snapshots: {} };

try {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) break;
    } catch {
      await sleep(200);
    }
  }
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolvePromise, rejectPromise) => {
    ws.onopen = resolvePromise;
    ws.onerror = rejectPromise;
  });
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const entry = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
      else entry.resolve(message.result);
    }
  };
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1400, deviceScaleFactor: 1, mobile: false });

  const url = `${baseUrl}/stream-monitor/${page}?static=1`;
  // 先拿同源权限写深色，再重载 —— 与 av-acceptance-catalog / av-layout-shoot 同一做法。
  await send("Page.navigate", { url });
  await waitFor(`!!document.querySelector('[data-av-page="${page}"]')`, 20000, "首页挂载");
  await evaluate(`localStorage.setItem("shuzhi-theme-mode", "dark")`);
  await send("Page.navigate", { url });
  await waitFor(`document.querySelectorAll(".recharts-wrapper svg").length > 0`, 25000, "图表挂载");
  await waitFor(
    `(() => { const b = document.querySelector('button[aria-label^="切换到"]'); return !!b && Object.keys(b).some((k) => k.startsWith("__reactProps")); })()`,
    25000,
    "主题按钮水合",
  );
  await sleep(700);

  const dark = await evaluate(SNAPSHOT);
  result.snapshots.dark = dark;

  // 真实点击主题切换（不是重载），这条才测得到 useAvPalette 的依赖重读。
  await evaluate(`document.querySelector('button[aria-label^="切换到"]').click()`);
  await waitFor(`document.documentElement.dataset.theme === "light"`, 10000, "主题落到 light");
  await sleep(900);
  const light = await evaluate(SNAPSHOT);
  result.snapshots.light = light;

  const darkSeries = new Set(dark.series);
  const lightSeries = new Set(light.series);
  const paintedBefore = dark.painted.filter((color) => darkSeries.has(color));
  const paintedAfter = light.painted;
  const residualDark = paintedAfter.filter((color) => darkSeries.has(color));
  const repaintedLight = paintedAfter.filter((color) => lightSeries.has(color));

  result.checks = {
    seriesDiffer: dark.series[0] !== light.series[0],
    darkSeriesPaintedBefore: paintedBefore.length,
    lightSeriesPaintedAfter: repaintedLight.length,
    residualDarkSeries: residualDark.length,
    chartSvgCount: dark.chartNodes,
    darkTheme: dark.theme,
    lightTheme: light.theme,
  };

  if (!result.checks.seriesDiffer) result.failures.push("深浅主题的 --av-series-1 相同 —— 这条用例无法区分两套配色（恒真）");
  if (dark.theme !== "dark") result.failures.push(`切换前主题是 ${dark.theme}，期望 dark`);
  if (light.theme !== "light") result.failures.push(`切换后主题是 ${light.theme}，期望 light`);
  if (dark.chartNodes === 0) result.failures.push("页面里没有图表 SVG —— 选择器漂了，断言会恒真");
  if (paintedBefore.length === 0) result.failures.push("切换前图表没有绘制任何系列色 —— 配色没生效或选择器漂了");
  if (residualDark.length > 0) result.failures.push(`切换后仍残留深色系列色 ${residualDark.slice(0, 4).join(" / ")}`);
  if (repaintedLight.length === 0) result.failures.push("切换后图表没有出现浅色系列色 —— useAvPalette 没有重读");

  result.pass = result.failures.length === 0;
  result.darkSeriesPainted = paintedBefore;
  result.residualDark = residualDark;
  result.repaintedLight = repaintedLight;

  writeFileSync(`${outDir}/palette-check.json`, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result.checks, null, 2));
  if (!result.pass) {
    console.error(`\n配色回归不通过：\n  ${result.failures.join("\n  ")}`);
    process.exitCode = 1;
  } else {
    console.log("\n配色回归通过：主题切换后图表重读令牌，深色系列色无残留。");
  }
} finally {
  try {
    ws?.close();
  } catch {}
  chrome.kill("SIGTERM");
}
