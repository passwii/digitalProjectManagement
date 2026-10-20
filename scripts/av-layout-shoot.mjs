// BLF-1399 视觉验收：逐页 × 五个宽度 × 深浅两主题截图。
// 用法：node scripts/av-layout-shoot.mjs <baseUrl> <outDir> [pages...]
//
// 与 av-static-shoot.mjs 的区别：那个只截一个 URL 并比三次的 MD5（布局确定性）；
// 这个是**排版走查**用的 —— 同一页在 1440 / 1920 / 1180 / 900 / 720 五个宽度、
// 深浅两套主题下各截一张，用来肉眼核对「同行卡片底边对齐」「面板头体左右对齐」
// 「顶栏 / 标题 / 卡片左边缘对齐」。
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const baseUrl = process.argv[2] ?? "http://127.0.0.1:3111";
const outDir = process.argv[3] ?? "/tmp/av-layout-shoot";
const pages = process.argv.slice(4);
const PAGES = pages.length > 0 ? pages : ["overview", "alarm", "device"];
const WIDTHS = [1440, 1920, 1180, 900, 720];
const THEMES = ["dark", "light"];
const chromePath = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

mkdirSync(outDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 量一下页面里的**对齐事实**（而不是只靠肉眼）。
 *
 * 这几项是本次标定的验收口径：
 *   · cardBottomSpread：同一栅格行内各卡片的底边差（px）—— 必须为 0；
 *   · panelPadDelta：面板头与面板体的左右内边距差（px）—— 必须为 0；
 *   · leftEdges：顶栏、页面标题、第一张卡片的左边缘（px）—— 必须一致；
 *   · scrollX：横向溢出（px）—— 必须为 0。
 */
const METRICS = `(() => {
  const out = {};
  const round = (n) => Math.round(n * 100) / 100;

  // 同行卡片底边差：取每一行的「直接子元素是卡片」的最深底边，算行内极差
  const gridSelectors = [
    '[class*="gridTwo"]', '[class*="gridThree"]', '[class*="splitWide"]',
    '[class*="metricGrid"]', '[class*="statusGrid"]', '[class*="channelGrid"]',
    '[class*="sceneGrid"]', '[class*="stressGrid"]',
  ];
  let worstSpread = 0;
  let worstWhere = "";
  for (const sel of gridSelectors) {
    for (const grid of document.querySelectorAll(sel)) {
      // 只看同一栅格行（offsetTop 相同）的直接子元素
      const rows = new Map();
      for (const child of grid.children) {
        const rect = child.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        const key = Math.round(child.offsetTop);
        if (!rows.has(key)) rows.set(key, []);
        rows.get(key).push(rect);
      }
      for (const [key, rects] of rows) {
        if (rects.length < 2) continue;
        const bottoms = rects.map((r) => Math.round(r.bottom));
        const spread = Math.max(...bottoms) - Math.min(...bottoms);
        if (spread > worstSpread) {
          worstSpread = spread;
          worstWhere = sel + " row@" + key;
        }
      }
    }
  }
  out.cardBottomSpread = worstSpread;
  out.cardBottomSpreadWhere = worstWhere;

  // 面板头 / 面板体左右内边距
  const header = document.querySelector('[class*="panelHeader"]');
  const body = document.querySelector('[class*="panelBody"]');
  if (header && body) {
    const hs = getComputedStyle(header);
    const bs = getComputedStyle(body);
    out.panelPadDelta = Math.abs(parseFloat(hs.paddingLeft) - parseFloat(bs.paddingLeft));
    out.panelPadX = round(parseFloat(hs.paddingLeft));
    out.panelPadTop = round(parseFloat(hs.paddingTop));
    out.panelPadBottom = round(parseFloat(bs.paddingBottom));
  }

  // 顶栏 / 页面标题 / 第一张卡片的左边缘
  const topbar = document.querySelector("header");
  const heading = document.querySelector("h1");
  const panel = document.querySelector('[class*="panel"]');
  out.leftEdges = {
    topbar: topbar ? round(topbar.getBoundingClientRect().left + parseFloat(getComputedStyle(topbar).paddingLeft)) : null,
    heading: heading ? round(heading.getBoundingClientRect().left) : null,
    panel: panel ? round(panel.getBoundingClientRect().left) : null,
  };

  out.scrollX = document.documentElement.scrollWidth - document.documentElement.clientWidth;
  out.theme = document.documentElement.dataset.theme;
  out.pageHeight = document.documentElement.scrollHeight;
  return out;
})()`;

const port = 9500 + Math.floor(Math.random() * 300);
/*
 * Chrome 的 user-data-dir 会写出上兆的缓存与扩展文件 —— 放仓库里会污染
 * 工作区（也会被代码扫描当成源码）。所以放临时目录，截完即弃。
 */
const chrome = spawn(chromePath, [
  "--headless=new",
  "--disable-gpu",
  "--hide-scrollbars",
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${resolve(tmpdir(), `av-layout-shoot-${port}`)}`,
  "--window-size=1920,1400",
  "about:blank",
], { stdio: "ignore" });

let ws;
let nextId = 1;
const pending = new Map();

function send(method, params = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolvePromise, rejectPromise) =>
    pending.set(id, { resolve: resolvePromise, reject: rejectPromise }),
  );
}

const results = [];

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

  for (const theme of THEMES) {
    for (const width of WIDTHS) {
      for (const page of PAGES) {
        await send("Emulation.setDeviceMetricsOverride", { width, height: 1400, deviceScaleFactor: 1, mobile: false });
        const url = `${baseUrl}/stream-monitor/${page}?static=1`;
        await send("Page.navigate", { url });
        await sleep(1800);
        await send("Runtime.evaluate", {
          expression: `localStorage.setItem("shuzhi-theme-mode", ${JSON.stringify(theme)})`,
          returnByValue: true,
        });
        await send("Page.navigate", { url });
        await sleep(3200);

        const metrics = await send("Runtime.evaluate", { expression: METRICS, returnByValue: true });
        const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
        const file = `${outDir}/${page}-${width}-${theme}.png`;
        writeFileSync(file, Buffer.from(shot.data, "base64"));
        results.push({ page, width, theme, file, metrics: metrics.result.value });
        process.stdout.write(`${page} ${width} ${theme} ok\n`);
      }
    }
  }

  writeFileSync(`${outDir}/results.json`, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results.map((r) => ({ page: r.page, width: r.width, theme: r.theme, ...r.metrics })), null, 2));

  // 验收口径：同行卡片底边必须齐、面板头体左右内边距必须齐、无横向溢出
  const failures = [];
  for (const { page, width, theme, metrics } of results) {
    if (metrics.cardBottomSpread > 1) {
      failures.push(`${page} ${width}px ${theme}：同行卡片底边差 ${metrics.cardBottomSpread}px（${metrics.cardBottomSpreadWhere}）`);
    }
    if (metrics.panelPadDelta > 0.5) {
      failures.push(`${page} ${width}px ${theme}：面板头/体左右内边距差 ${metrics.panelPadDelta}px`);
    }
    if (metrics.scrollX !== 0) {
      failures.push(`${page} ${width}px ${theme}：横向溢出 ${metrics.scrollX}px`);
    }
    const edges = Object.values(metrics.leftEdges ?? {}).filter((v) => v !== null);
    if (new Set(edges).size > 1) {
      failures.push(`${page} ${width}px ${theme}：左边缘不一致 ${JSON.stringify(metrics.leftEdges)}`);
    }
  }
  if (failures.length > 0) {
    console.error(`\n验收不通过：\n  ${failures.join("\n  ")}`);
    process.exitCode = 1;
  } else {
    console.log("\n验收通过：同行卡片底边齐、面板头体左右对齐、左边缘一致、无横向溢出。");
  }
} finally {
  try {
    ws?.close();
  } catch {}
  chrome.kill("SIGTERM");
}
