// BLF-1399 溢出回归：等高策略会不会让内容溢出卡片（issue 风险 #1）。
// 用法：node scripts/av-layout-overflow.mjs <baseUrl>
//
// 判定口径：
//   · 卡片（面板/度量卡/通道卡/场景卡/状态格）的内容不得超出自己的盒子；
//   · 页面不得出现横向滚动；
//   · 文本节点不得被裁掉（scrollWidth > clientWidth 且 overflow 不是 visible）。
//
// ⚠️ 「卡片内容是否超出盒子」的判定**不在本文件里**，而在
//    `scripts/lib/avOverflowRule.mjs` —— 本文件把那个函数原样嵌进浏览器探针
//    （`classifyCardBox.toString()`），`web/lib/av/avOverflowRule.vitest.test.ts`
//    则直接 import 同一个模块做行为级守卫。脚本与守卫共用一份口径，
//    不会各自漂移；改口径只需要改那一个文件。
//
// 口径为什么**不看 overflow 计算值**（上一版看的是错的）：
//   上一版要求「delta > 1 且 overflow ∈ {hidden, clip, auto, scroll}」才算溢出。
//   而站点那六个卡片族（.panel / .metric / .channel / .sceneCard / .statusCell /
//   .algoCard）在两份受管 CSS 里**一条 overflow 都没设**（默认 visible），
//   于是「内容真的溢出盒子」这件事在这个脚本里**永远判不出来**——
//   实测把 .metric 压成 height:44px（可见溢出 83px），脚本仍报绿灯。
//   现在改成：任一轴的 delta 超过容差即记溢出；内容是被裁、可滚动还是
//   溢出到盒子外，只影响报告里的措辞，不影响「算不算溢出」。
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { OVERFLOW_TOLERANCE_PX, classifyCardBox } from "./lib/avOverflowRule.mjs";

const baseUrl = process.argv[2] ?? "http://127.0.0.1:3111";
const chromePath = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PAGES = ["overview", "monitor", "alarm", "event", "device", "capability", "audio", "__stress"];
const WIDTHS = [1440, 1920, 1180, 900, 720];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PROBE = `(() => {
  // 判定函数从 scripts/lib/avOverflowRule.mjs 原样嵌进来（toString），
  // 好让脚本与 avOverflowRule.vitest.test.ts 跑的是同一份口径。
  const classifyCardBox = ${classifyCardBox.toString()};
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
      // 内容超出卡片盒子（向下 / 向右）。判定口径见 scripts/lib/avOverflowRule.mjs，
      // 这里是同一个函数的源码（嵌进来跑，好让脚本与守卫共用一份口径）。
      const verdict = classifyCardBox({
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
        overflowY: style.overflowY,
        overflowX: style.overflowX,
      }, ${OVERFLOW_TOLERANCE_PX});
      if (verdict.overflow) {
        out.push({
          cls: el.className,
          overflowY: verdict.overflowY,
          overflowX: verdict.overflowX,
          axisY: verdict.axisY,
          axisX: verdict.axisX,
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
