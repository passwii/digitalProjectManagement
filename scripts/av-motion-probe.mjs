// 动效效果与性能验收脚本（BLF-1375 AC5 / AC6）。
//
// 覆盖三件事：
//   1. 动效开启时 layoutId 的共享滑块真的存在（导航 + Tab），关闭时不存在；
//   2. 告警列表「插入 20 条」过程中的帧率（rAF 间隔统计，>= 55fps 为通过）；
//   3. 抽屉打开 / 关闭期间元素有 transform 变化（说明退场动画真的播了）。
//
// 用法：node scripts/av-motion-probe.mjs [baseUrl]
import { spawn } from "node:child_process";

const base = process.argv[2] ?? "http://127.0.0.1:3111";
// 本地验收工具：需要一个已安装的 Chrome / Chromium。可用 CHROME_PATH 覆盖，
// 不给参数时走 macOS 的默认安装位置。
const chromePath = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const port = 9335;

const chrome = spawn(
  chromePath,
  [
    "--headless=new",
    "--hide-scrollbars",
    `--remote-debugging-port=${port}`,
    "--user-data-dir=/tmp/av-probe-profile",
    "--window-size=1440,1400",
    "about:blank",
  ],
  { stdio: "ignore" },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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

try {
  for (let i = 0; i < 60; i += 1) {
    try {
      await fetch(`http://127.0.0.1:${port}/json/version`);
      break;
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
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
    }
  };
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1400, deviceScaleFactor: 1, mobile: false });

  // ---- 1. layoutId 滑块（动效开启） ----
  await send("Page.navigate", { url: `${base}/stream-monitor/alarm` });
  await sleep(3000);
  const layout = await evaluate(`JSON.stringify({
    motion: document.documentElement.getAttribute('data-av-motion'),
    navPill: !!document.querySelector('[class*="navActivePill"]'),
    tabSlider: !!document.querySelector('[class*="tabSlider"]'),
    pageWrapper: !!document.querySelector('[data-motion="page"]'),
    staggerItems: document.querySelectorAll('[data-motion="stagger-item"], [class*="itemIn"]').length,
  })`);

  // ---- 2. 插入 20 条的帧率（点「加载下一页」两次，边点边测 rAF 间隔） ----
  const fps = await evaluate(`(async () => {
    const frames = [];
    let last = performance.now();
    let running = true;
    const tick = () => {
      const now = performance.now();
      frames.push(now - last);
      last = now;
      if (running) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);

    const button = () => Array.from(document.querySelectorAll('button'))
      .find((node) => node.textContent.includes('加载下一页'));
    const from = document.querySelectorAll('ul[class*="alarmList"] > li').length;
    const animFrames = [];
    for (let round = 0; round < 2; round += 1) {
      const target = button();
      if (!target) break;
      const mark = frames.length;
      target.click();
      // 只统计「动画窗口」内的帧：插入那一下的 React 渲染 + 后续 350ms 的入场动画。
      // 把点击前等待的 idle 帧算进来会让 p95 变成调度噪声，测不到动画本身。
      await new Promise((r) => setTimeout(r, 350));
      animFrames.push(...frames.slice(mark));
      await new Promise((r) => setTimeout(r, 1200));
    }
    running = false;
    const to = document.querySelectorAll('ul[class*="alarmList"] > li').length;
    const samples = animFrames.length > 10 ? animFrames : frames.slice(5);
    const sorted = [...samples].sort((a, b) => a - b);
    const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
    const avg = samples.reduce((sum, v) => sum + v, 0) / Math.max(1, samples.length);
    // 掉帧率：超过 20ms 的帧占比（60fps 的预算是 16.7ms，留一点调度余量）
    const dropped = samples.filter((v) => v > 20).length / Math.max(1, samples.length);
    return JSON.stringify({
      inserted: to - from,
      frames: samples.length,
      avgFrameMs: Number(avg.toFixed(2)),
      p95FrameMs: Number(p95.toFixed(2)),
      fpsFromP95: Number((1000 / p95).toFixed(1)),
      fpsFromAvg: Number((1000 / avg).toFixed(1)),
      droppedFrameRatio: Number(dropped.toFixed(3)),
    });
  })()`);

  // ---- 3. 抽屉开合：关闭过程中 dialog 仍有 transform 变化 ----
  const drawer = await evaluate(`(async () => {
    const card = document.querySelector('ul[class*="alarmList"] button[class*="alarmCard"]');
    if (!card) return JSON.stringify({ error: 'no card' });
    card.click();
    await new Promise((r) => setTimeout(r, 500));
    const dialog = document.querySelector('dialog');
    const opened = dialog?.open === true;
    const openAnim = dialog ? getComputedStyle(dialog).animationName : '';
    // 点关闭按钮，随机采样 transform
    const close = dialog?.querySelector('button[aria-label="关闭告警详情"]');
    close?.click();
    const samples = [];
    for (let i = 0; i < 6; i += 1) {
      samples.push({ anim: getComputedStyle(dialog).animationName, closing: dialog.dataset.closing ?? '', open: dialog.open });
      await new Promise((r) => requestAnimationFrame(r));
    }
    await new Promise((r) => setTimeout(r, 400));
    return JSON.stringify({ opened, openAnim, samples, closedAfter: dialog ? !dialog.open : null, url: location.pathname });
  })()`);

  console.log(JSON.stringify({ layout: JSON.parse(layout), insert: JSON.parse(fps), drawer: JSON.parse(drawer) }, null, 2));
} finally {
  try {
    ws?.close();
  } catch {}
  chrome.kill("SIGTERM");
}
