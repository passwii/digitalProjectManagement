// 总览页「时间范围真实换数 + 多系列趋势图」的验收脚本（BLF-1424）。
//
// 覆盖验收标准里靠眼睛守不住的部分：
//   1. 三档（近 24 小时 / 今日 / 近 7 日）的 KPI 四值、趋势曲线路径、热力行数**都不同**；
//   2. 「告警趋势」至少 4 条系列，且 stroke 颜色互不相同；
//   3. `?static=1` 下把三档来回切三次，每次读到的 DOM 签名完全一致（截图稳定的前提）；
//   4. 动效开启时切档有可观测的过渡（切换后 ~80ms 与 ~250ms 各截一帧）。
//
// 用法：node scripts/av-overview-ranges.mjs [baseUrl] [outDir]
// 依赖本机 Chrome（可用 CHROME_PATH 覆盖），走 CDP，与 av-static-shoot.mjs 同一套做法。
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";

const baseUrl = process.argv[2] ?? "http://127.0.0.1:3001";
const outDir = process.argv[3] ?? "artifacts/blf1424";
const chromePath = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const port = 9337;

mkdirSync(outDir, { recursive: true });

const RANGES = [
  { key: "live", label: "近 24 小时", file: "overview-live" },
  { key: "today", label: "今日", file: "overview-today" },
  { key: "week", label: "近 7 日", file: "overview-week" },
];

const chrome = spawn(
  chromePath,
  [
    "--headless=new",
    "--hide-scrollbars",
    `--remote-debugging-port=${port}`,
    "--user-data-dir=/tmp/av-ranges-profile",
    "--window-size=1440,1600",
    "about:blank",
  ],
  { stdio: "ignore" },
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let ws;
let nextId = 1;
const pending = new Map();

function send(method, params = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

async function evaluate(expression) {
  const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}

async function screenshot(file, beyond = true) {
  const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: beyond });
  const buffer = Buffer.from(shot.data, "base64");
  writeFileSync(file, buffer);
  return { file, md5: createHash("md5").update(buffer).digest("hex") };
}

/** 页面上的「事实」：KPI 四值、趋势曲线、热力行数、系列颜色。 */
const READ_STATE = `(() => {
  const page = document.querySelector('[data-av-page="overview"]');
  const metrics = Array.from(page.querySelectorAll('[data-motion="metric"]')).map((card) => ({
    label: (card.querySelector('[class*="metricHead"] span') || {}).textContent || "",
    value: (card.querySelector('[class*="metricValue"]') || {}).textContent || "",
  }));
  const curves = Array.from(page.querySelectorAll(".recharts-area-curve"));
  // 柱状图：recharts v3 把每个色块画成 <g class="recharts-bar-rectangle"><path fill=...>，
  // 颜色在里面的 path 上，取外层 g 只会拿到 null。
  const barGroups = Array.from(page.querySelectorAll(".recharts-bar-rectangle"));
  const barPaths = barGroups.flatMap((g) => Array.from(g.querySelectorAll("path")));
  const heat = page.querySelector("[data-rows]");
  const trendPanel = page.querySelector('[data-motion-key="overview-trend"]');
  return {
    range: page.querySelector("[data-av-range]")?.getAttribute("data-av-range") || "",
    metrics,
    seriesCount: curves.length || new Set(barPaths.map((p) => p.getAttribute("fill"))).size,
    seriesStrokes: curves.map((p) => p.getAttribute("stroke")),
    seriesPaths: curves.map((p) => p.getAttribute("d") || ""),
    barFills: Array.from(new Set(barPaths.map((p) => p.getAttribute("fill")).filter(Boolean))),
    heatRows: heat ? heat.getAttribute("data-rows") : "",
    heatRowCount: page.querySelectorAll('[class*="heatRow"]').length,
    heatCells: page.querySelectorAll('[class*="heatCell"]:not([class*="heatCells"])').length,
    peakLabel: trendPanel ? (Array.from(trendPanel.querySelectorAll("text")).map((t) => t.textContent).find((t) => t && t.startsWith("峰值")) || "") : "",
    legend: Array.from(page.querySelectorAll('[data-motion-key="overview-trend"] [class*="legendItem"]')).map((item) => item.textContent),
    trendTotal: (trendPanel ? trendPanel.querySelector('[class*="softNote"]') || {} : {}).textContent || "",
  };
})()`;

const clickRange = (label) => `(() => {
  const buttons = Array.from(document.querySelectorAll('[data-av-page="overview"] button'));
  const hit = buttons.find((b) => (b.textContent || "").trim() === ${JSON.stringify(label)});
  if (!hit) throw new Error("找不到档位按钮：" + ${JSON.stringify(label)});
  hit.click();
  return true;
})()`;

const signature = (state) =>
  JSON.stringify({
    metrics: state.metrics,
    paths: state.seriesPaths,
    heatRows: state.heatRowCount,
    heatCells: state.heatCells,
    trendTotal: state.trendTotal,
    peaks: state.peakLabel,
  });

const report = { ranges: {}, staticStability: null, transition: null, failures: [] };
let wsReady = false;

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
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
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
  wsReady = true;

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1600, deviceScaleFactor: 1, mobile: false });

  // ---- 1. 三档各截一张 + 读状态（static，保证曲线已画完且不再推进） ----
  for (const range of RANGES) {
    await send("Page.navigate", { url: `${baseUrl}/stream-monitor/overview?static=1` });
    await sleep(2600);
    await evaluate(clickRange(range.label));
    await sleep(1400);
    const state = await evaluate(READ_STATE);
    const shot = await screenshot(`${outDir}/${range.file}.png`);
    report.ranges[range.key] = { ...state, screenshot: shot.file, md5: shot.md5, signature: signature(state) };
    process.stdout.write(`${range.key} 截图完成（${shot.md5}）\n`);
  }

  // ---- 1b. 浅色主题也截一张（tone / 系列色必须是令牌，换主题不能画错色） ----
  await evaluate(`localStorage.setItem("shuzhi-theme-mode", "light")`);
  await send("Page.navigate", { url: `${baseUrl}/stream-monitor/overview?static=1` });
  await sleep(2600);
  await evaluate(clickRange("近 7 日"));
  await sleep(1400);
  const lightState = await evaluate(READ_STATE);
  const lightShot = await screenshot(`${outDir}/overview-week-light.png`);
  report.lightTheme = {
    screenshot: lightShot.file,
    colors: lightState.seriesStrokes.filter(Boolean).length ? lightState.seriesStrokes : lightState.barFills,
  };
  if (new Set(report.lightTheme.colors).size < 4) {
    report.failures.push(`浅色主题下系列色只有 ${new Set(report.lightTheme.colors).size} 种`);
  }
  await evaluate(`localStorage.setItem("shuzhi-theme-mode", "dark")`);

  // ---- 2. 静态稳定：三档来回切三轮，签名必须逐字一致 ----
  await send("Page.navigate", { url: `${baseUrl}/stream-monitor/overview?static=1` });
  await sleep(2600);
  const signatures = [];
  for (let round = 0; round < 3; round += 1) {
    for (const range of RANGES) {
      await evaluate(clickRange(range.label));
      await sleep(700);
      signatures.push(signature(await evaluate(READ_STATE)));
    }
  }
  const unique = new Set(signatures);
  report.staticStability = { rounds: 3, states: signatures.length, unique: unique.size };
  if (unique.size !== RANGES.length) {
    report.failures.push(`?static=1 下三档签名应为 ${RANGES.length} 种，实测 ${unique.size} 种（轮次之间不稳定）`);
  }

  // ---- 3. 三档必须真的不同 ----
  const live = report.ranges.live;
  const today = report.ranges.today;
  const week = report.ranges.week;
  const metricText = (state) => state.metrics.map((row) => `${row.label}=${row.value}`).join("|");
  if (new Set([metricText(live), metricText(today), metricText(week)]).size !== 3) {
    report.failures.push("三档 KPI 四值没有全部不同");
  }
  if (new Set([live.signature, today.signature, week.signature]).size !== 3) {
    report.failures.push("三档的曲线 / 热力 / 峰值签名没有全部不同");
  }
  if (live.heatRowCount !== 1 || today.heatRowCount !== 1 || week.heatRowCount !== 7) {
    report.failures.push(`热力行数不是 1 / 1 / 7：${live.heatRowCount} / ${today.heatRowCount} / ${week.heatRowCount}`);
  }

  // ---- 4. 四条系列、四种颜色 ----
  for (const [key, state] of Object.entries(report.ranges)) {
    const strokes = key === "week" ? state.barFills : state.seriesStrokes.filter(Boolean);
    if (state.seriesCount < 4) report.failures.push(`${key}: 趋势图只有 ${state.seriesCount} 条系列`);
    if (new Set(strokes).size < 4) report.failures.push(`${key}: 系列颜色只有 ${new Set(strokes).size} 种`);
  }

  // ---- 5. 动效开启时：数据流真的在推进（KPI 会变、热力有脉冲），且切档有过渡 ----
  await send("Page.navigate", { url: `${baseUrl}/stream-monitor/overview?static=0` });
  await sleep(3000);
  const flowBefore = await evaluate(READ_STATE);
  const pulseBefore = await evaluate(`document.querySelectorAll('[data-av-page="overview"] [data-hot="true"]').length`);
  await sleep(6000); // 一个 tick（5s）多一点
  const flowAfter = await evaluate(READ_STATE);
  const pulseAfter = await evaluate(`document.querySelectorAll('[data-av-page="overview"] [data-hot="true"]').length`);
  report.liveStream = {
    before: flowBefore.metrics.map((row) => `${row.label}=${row.value}`),
    after: flowAfter.metrics.map((row) => `${row.label}=${row.value}`),
    pulseBefore,
    pulseAfter,
    moved: signature(flowBefore) !== signature(flowAfter),
  };
  if (!report.liveStream.moved) report.failures.push("动效开启时 6 秒内 KPI / 曲线 / 热力都没有推进");
  if (pulseAfter < 1) report.failures.push("数据流推进时没有热力脉冲（data-hot 未出现）");
  await screenshot(`${outDir}/overview-flow.png`);

  await evaluate(clickRange("今日"));
  await sleep(80);
  const mid = await screenshot(`${outDir}/transition-080ms.png`, false);
  await sleep(170);
  const end = await screenshot(`${outDir}/transition-250ms.png`, false);
  report.transition = { mid: mid.md5, end: end.md5, differs: mid.md5 !== end.md5 };
  if (mid.md5 === end.md5) report.failures.push("切档后 80ms 与 250ms 的画面完全一致，过渡不可观测");

  writeFileSync(`${outDir}/overview-ranges-report.json`, JSON.stringify(report, null, 2));
  const compact = Object.fromEntries(
    Object.entries(report.ranges).map(([key, state]) => [
      key,
      {
        metrics: state.metrics.map((row) => `${row.label}=${row.value}`),
        seriesCount: state.seriesCount,
        colors: state.seriesStrokes.filter(Boolean).length ? state.seriesStrokes : state.barFills,
        heat: `${state.heatRowCount} 行 × 24 格（${state.heatRows}）`,
        trendTotal: state.trendTotal,
        screenshot: state.screenshot,
      },
    ]),
  );
  console.log(
    JSON.stringify(
      { ranges: compact, staticStability: report.staticStability, liveStream: report.liveStream, transition: report.transition },
      null,
      2,
    ),
  );
  if (report.failures.length > 0) {
    console.error(`\n验收不通过：\n  ${report.failures.join("\n  ")}`);
    process.exitCode = 1;
  } else {
    console.log("\n验收通过：三档数据不同 / 4 条系列 4 种颜色 / 静态签名稳定 / 切档有过渡。");
  }
} finally {
  try {
    ws?.close();
  } catch {}
  if (wsReady || true) chrome.kill("SIGTERM");
}
