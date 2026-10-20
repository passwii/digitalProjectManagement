// BLF-1399 溢出回归：等高策略会不会让内容溢出卡片（issue 风险 #1）。
// 用法：node scripts/av-layout-overflow.mjs <baseUrl>
//
// 判定口径：
//   · 卡片（面板/度量卡/通道卡/场景卡/状态格）的内容不得超出自己的盒子；
//   · 页面不得出现横向滚动；
//   · 文本节点不得被裁掉（scrollWidth > clientWidth 且 overflow 不是 visible）。
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const baseUrl = process.argv[2] ?? "http://127.0.0.1:3111";
const chromePath = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PAGES = ["overview", "monitor", "alarm", "event", "device", "capability", "audio", "__stress"];
const WIDTHS = [1440, 1920, 1180, 900, 720];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PROBE = `(() => {
  const out = [];
  const cardSelectors = [
    '[class*="panel"]', '[class*="metric"]', '[class*="channel"]',
    '[class*="sceneCard"]', '[class*="statusCell"]', '[class*="algoCard"]',
  ];
  const seen = new Set();
  for (const sel of cardSelectors) {
    for (const el of document.querySelectorAll(sel)) {
      if (seen.has(el)) continue;
      seen.add(el);
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      // 内容超出卡片盒子（向下溢出）
      const overflowY = el.scrollHeight - el.clientHeight;
      const overflowX = el.scrollWidth - el.clientWidth;
      const clippedY = overflowY > 1 && ["hidden", "clip", "auto", "scroll"].includes(style.overflowY);
      const clippedX = overflowX > 1 && ["hidden", "clip", "auto", "scroll"].includes(style.overflowX);
      if (clippedY || clippedX) {
        out.push({
          cls: el.className,
          overflowY,
          overflowX,
          clippedY,
          clippedX,
        });
      }
    }
  }
  // 文本被裁掉：自身可滚动但内容更宽
  const textClipped = [];
  for (const el of document.querySelectorAll("h1, h2, h3, strong, span, td, th")) {
    // .ptr-label 是**移动端下拉刷新**的读屏提示（globals.css 里的 .ptr 组件），
    // 不是本站点的卡片 —— 它在基线上就报（视觉隐藏 + 1px 盒），
    // 与本次排版标定无关，排除掉免得淹没真问题。
    if (el.closest(".ptr")) continue;
    const style = getComputedStyle(el);
    if (style.overflow === "visible" && style.textOverflow !== "ellipsis") continue;
    if (style.textOverflow === "ellipsis") continue;
    if (el.scrollWidth - el.clientWidth > 1) {
      textClipped.push({ cls: el.className, tag: el.tagName, over: el.scrollWidth - el.clientWidth });
    }
  }
  return {
    cards: out,
    textClipped: textClipped.slice(0, 10),
    scrollX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  };
})()`;

const port = 9800 + Math.floor(Math.random() * 150);
const chrome = spawn(chromePath, [
  "--headless=new",
  "--disable-gpu",
  "--hide-scrollbars",
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${resolve(tmpdir(), `av-layout-overflow-${port}`)}`,
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

const failures = [];

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

  for (const width of WIDTHS) {
    for (const page of PAGES) {
      await send("Emulation.setDeviceMetricsOverride", { width, height: 1400, deviceScaleFactor: 1, mobile: false });
      const url = `${baseUrl}/stream-monitor/${page}?static=1`;
      await send("Page.navigate", { url });
      await sleep(2600);
      const probe = await send("Runtime.evaluate", { expression: PROBE, returnByValue: true });
      const value = probe.result.value;
      if (value.cards.length > 0) {
        failures.push(`${page} ${width}px：卡片内容溢出 ${JSON.stringify(value.cards.slice(0, 4))}`);
      }
      if (value.textClipped.length > 0) {
        failures.push(`${page} ${width}px：文本被裁 ${JSON.stringify(value.textClipped)}`);
      }
      if (value.scrollX !== 0) {
        failures.push(`${page} ${width}px：横向溢出 ${value.scrollX}px`);
      }
      process.stdout.write(`${page} ${width} ok\n`);
    }
  }

  if (failures.length > 0) {
    console.error(`\n验收不通过：\n  ${failures.join("\n  ")}`);
    process.exitCode = 1;
  } else {
    console.log("\n验收通过：无卡片内容溢出、无文本裁切、无横向滚动。");
  }
} finally {
  try {
    ws?.close();
  } catch {}
  chrome.kill("SIGTERM");
}
