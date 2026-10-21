// BLF-1428 验收：/device 的图表组 + 动态数据流 + 抽屉信号曲线。
// 用法：node scripts/av-device-charts.mjs <baseUrl> <outDir>
//
// 为什么单独一个脚本：`av-layout-overflow.mjs` 只看「卡片有没有溢出」，
// `av-static-shoot.mjs` 只看「三连拍 MD5 是否一致」，两者都看不出
// 「首屏到底有几张**真的画出来**的图」「多系列颜色是不是同一色」「悬停卡片有没有业务口径」。
// 这里在真实 Chrome 里量四组事实：
//
//   1. 首屏可见的图表数（图表容器与第一屏视口相交）—— 验收要求 ≥ 3；
//   2. 每张图的容器高度 > 0（Stage 1 的「0 高不渲染」回归点，含抽屉里的信号曲线）；
//   3. 站点柱状图上的三条堆叠系列 + 一条在线率折线，**四条描边/填充色互不相同**
//      （同站点多系列同色 = 图读不出来），且颜色来自 `--av-series-*` / 语义令牌；
//   4. 悬停站点柱时，tooltip 里出现「在线 129/142」这种业务口径；
//   5. 非 static 下 5 秒后站点读数会变（动态数据流不是装饰）；static 下 5 秒后不变。
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { captureFullPage } from "./lib/avFullPageShot.mjs";

const baseUrl = process.argv[2] ?? "http://127.0.0.1:3001";
const outDir = process.argv[3] ?? "artifacts/blf1428/charts";
const chromePath = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
/** 验收要求的动态帧周期上限（毫秒）：脚本按这个数等一帧，和代码里的常量各自独立。 */
const FRAME_WAIT_MS = 6500;

mkdirSync(outDir, { recursive: true });

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

/** 一个页面里所有图表容器（剥掉环形图的外层包装，取真正带高度的那一层）。 */
const CHART_PROBE = `(() => {
  const viewportHeight = window.innerHeight;
  const viewportWidth = window.innerWidth;
  const surfaces = [...document.querySelectorAll('[data-motion="chart"]')].map((node) =>
    node.style.height ? node : node.querySelector('[class*="donutChart"]') ?? node,
  );
  return surfaces.map((node) => {
    const rect = node.getBoundingClientRect();
    return {
      label: node.getAttribute('aria-label'),
      height: Math.round(rect.height),
      width: Math.round(rect.width),
      top: Math.round(rect.top),
      visibleInFirstScreen: rect.top < viewportHeight && rect.bottom > 0 && rect.width > 0,
      insideViewportWidth: rect.right <= viewportWidth + 1,
    };
  });
})()`;

/** 站点堆叠柱里四条系列的描边/填充色 + 第一根柱子的屏幕坐标（给悬停用）。 */
const SERIES_PROBE = `(() => {
  const panel = document.querySelector('[data-motion-key="device-sites"]');
  if (!panel) return { error: 'no-sites-panel' };
  const colors = {
    bars: [...panel.querySelectorAll('[class*="recharts-bar-rectangle"] path')].map((node) => node.getAttribute('fill')),
    line: [...panel.querySelectorAll('[class*="recharts-line-curve"]')].map((node) => node.getAttribute('stroke')),
    legend: [...panel.querySelectorAll('[class*="legendItem"]')].map((node) => getComputedStyle(node.querySelector('i')).backgroundColor),
  };
  const bar = panel.querySelector('[class*="recharts-bar-rectangle"] path');
  const rect = bar ? bar.getBoundingClientRect() : null;
  return {
    ...colors,
    bar: rect ? { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) } : null,
    uniqueBars: [...new Set(colors.bars.filter(Boolean))].length,
    uniqueLegend: [...new Set(colors.legend.filter(Boolean))].length,
  };
})()`;

const SITE_READINGS = `(() => [...document.querySelectorAll('[data-device-site]')].map((node) => node.textContent.trim()))()`;

const port = 9400 + Math.floor(Math.random() * 150);
const chrome = spawn(
  chromePath,
  [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${resolve(tmpdir(), `av-device-charts-${port}`)}`,
    "--window-size=1440,1400",
    "about:blank",
  ],
  { stdio: "ignore" },
);

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
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}

/**
 * 整页截图（口径见 scripts/lib/avFullPageShot.mjs）。
 *
 * 不能直接 `captureBeyondViewport: true`：截图瞬间撑高视口会让 recharts 重排 +
 * 重播入场动画，拍出来是空白的图表区 —— 留档截图要能证明「图真的画出来了」。
 */
async function shot(name) {
  writeFileSync(`${outDir}/${name}.png`, await captureFullPage(send, { width: 1440, viewportHeight: 1400 }));
}

const failures = [];
const report = {};

try {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) break;
    } catch {
      // Chrome 还没起来
    }
    await sleep(200);
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

  /* ---------- 1. 静态首屏：图表数量 / 高度 / 多系列配色 ---------- */
  await send("Page.navigate", { url: `${baseUrl}/stream-monitor/device?static=1` });
  await sleep(3500);

  const charts = await evaluate(CHART_PROBE);
  const firstScreen = charts.filter((chart) => chart.visibleInFirstScreen);
  report.charts = charts;
  if (firstScreen.length < 3) {
    failures.push(`首屏可见图表 ${firstScreen.length} 张，验收要求 ≥ 3（${firstScreen.map((c) => c.label).join(" / ")}）`);
  }
  for (const chart of charts) {
    if (chart.height <= 0) failures.push(`图表「${chart.label}」渲染高度为 ${chart.height}px（0 高 = Stage 1 缺陷复发）`);
    if (chart.width <= 0) failures.push(`图表「${chart.label}」渲染宽度为 ${chart.width}px`);
  }

  const series = await evaluate(SERIES_PROBE);
  report.series = series;
  if (series.error) failures.push(`站点在线情况面板找不到：${series.error}`);
  else {
    if (series.uniqueBars < 3) failures.push(`站点堆叠柱只有 ${series.uniqueBars} 种填充色，验收要求在线/离线/维护中三色互不相同`);
    if (!series.line.length) failures.push("站点在线率折线没有画出来（第二视觉缺失）");
    if (series.uniqueLegend < 4) failures.push(`图例只有 ${series.uniqueLegend} 种颜色（应有 4 种：三档状态 + 在线率）`);
  }

  /* ---------- 2. 悬停：tooltip 必须给出 online/total ---------- */
  if (series.bar) {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: series.bar.x, y: series.bar.y, buttons: 0 });
    await sleep(400);
    const tooltip = await evaluate(
      `(() => { const node = document.querySelector('[class*="tooltip"]'); return node ? node.textContent.trim() : ''; })()`,
    );
    report.tooltip = tooltip;
    if (!/在线\s*\d+\/\d+/.test(tooltip)) {
      failures.push(`站点柱状图悬停卡片没有「在线 x/y」口径：${JSON.stringify(tooltip)}`);
    }
    await shot("device-hover");
  } else {
    failures.push("站点堆叠柱没找到可悬停的柱子");
  }

  /* ---------- 3. 静态下的动态数据流必须停住 ---------- */
  const staticBefore = await evaluate(SITE_READINGS);
  await sleep(FRAME_WAIT_MS);
  const staticAfter = await evaluate(SITE_READINGS);
  report.staticReadings = { before: staticBefore, after: staticAfter };
  if (JSON.stringify(staticBefore) !== JSON.stringify(staticAfter)) {
    failures.push(`?static=1 下站点读数仍在变化：${JSON.stringify(staticBefore)} → ${JSON.stringify(staticAfter)}`);
  }

  /* ---------- 4. 非 static：5 秒后读数必须变（数据在流） ---------- */
  await send("Page.navigate", { url: `${baseUrl}/stream-monitor/device` });
  await sleep(3500);
  const liveBefore = await evaluate(SITE_READINGS);
  const frameBefore = await evaluate(`document.querySelector('[data-device-frame]')?.getAttribute('data-device-frame')`);
  await sleep(FRAME_WAIT_MS);
  const liveAfter = await evaluate(SITE_READINGS);
  const frameAfter = await evaluate(`document.querySelector('[data-device-frame]')?.getAttribute('data-device-frame')`);
  report.live = { before: liveBefore, after: liveAfter, frameBefore, frameAfter };
  if (JSON.stringify(liveBefore) === JSON.stringify(liveAfter)) {
    failures.push(`动效开启时站点读数没有推进：${JSON.stringify(liveBefore)} → ${JSON.stringify(liveAfter)}`);
  }
  if (frameBefore === frameAfter) {
    failures.push(`演示帧号没有推进（${frameBefore} → ${frameAfter}）`);
  }
  await shot("device-live");

  /* ---------- 5. 抽屉里的信号强度曲线（Stage 1 回归点） ---------- */
  await send("Page.navigate", { url: `${baseUrl}/stream-monitor/device?static=1` });
  await sleep(3000);
  const rowPoint = await evaluate(
    `(() => { const row = document.querySelector('tbody tr'); if (!row) return null; const rect = row.getBoundingClientRect(); return { x: Math.round(rect.left + 40), y: Math.round(rect.top + rect.height / 2) }; })()`,
  );
  if (rowPoint) {
    for (const type of ["mousePressed", "mouseReleased"]) {
      await send("Input.dispatchMouseEvent", { type, x: rowPoint.x, y: rowPoint.y, button: "left", clickCount: 1 });
    }
    await sleep(900);
    const drawer = await evaluate(`(() => {
      const dialog = document.querySelector('dialog');
      if (!dialog || !dialog.open) return { open: false };
      const surface = dialog.querySelector('[data-motion="chart"]');
      const rect = surface ? surface.getBoundingClientRect() : null;
      return {
        open: true,
        label: surface ? surface.getAttribute('aria-label') : null,
        height: rect ? Math.round(rect.height) : 0,
        title: dialog.querySelector('h2')?.textContent ?? null,
      };
    })()`);
    report.drawer = drawer;
    /*
     * 抽屉没打开必须算失败：整段断言写在 `if (drawer.open)` 里的话，
     * `{ open: false }` 会让它全跳过并且仍以 0 退出 —— 正好是「抽屉挂了」
     * 这个 Stage 1 回归点最需要红的时候。
     */
    if (!drawer.open) failures.push(`设备抽屉没有打开：${JSON.stringify(drawer)}`);
    if (!drawer.label?.includes("信号强度")) failures.push(`抽屉里没有信号强度曲线：${JSON.stringify(drawer.label)}`);
    if (!drawer.height || drawer.height <= 0) failures.push(`抽屉信号曲线高度为 ${drawer.height}px`);
    await shot("device-drawer");
  } else {
    failures.push("设备台账里没有可点击的行，抽屉用例无法执行");
  }
} finally {
  try {
    ws?.close();
  } catch {
    // 忽略关闭时的竞态
  }
  chrome.kill("SIGTERM");
}

writeFileSync(`${outDir}/report.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (failures.length > 0) {
  console.error(`\n验收失败（${failures.length} 项）：`);
  for (const failure of failures) console.error(`  · ${failure}`);
  process.exitCode = 1;
} else {
  console.log("\n验收通过：首屏图表 ≥3、每张图有高度、多系列配色互不相同、tooltip 有 online/total、静态冻结 / 动态推进、抽屉信号曲线可见。");
}
