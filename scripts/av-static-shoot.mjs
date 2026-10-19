// 用 CDP 连真实 Chrome：同一页面连截 3 次，比对 MD5（验收 AC2）。
// 用法：node scripts/av-static-shoot.mjs <url> <outDir>
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

const url = process.argv[2] ?? "http://127.0.0.1:3111/av/overview?static=1";
const outDir = process.argv[3] ?? "/tmp/av-cdp";
// 本地验收工具：需要一个已安装的 Chrome / Chromium。可用 CHROME_PATH 覆盖，
// 不给参数时走 macOS 的默认安装位置。
const chromePath = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const port = 9333;

mkdirSync(outDir, { recursive: true });

const chrome = spawn(chromePath, [
  "--headless=new",
  "--disable-gpu",
  "--hide-scrollbars",
  `--remote-debugging-port=${port}`,
  "--user-data-dir=/tmp/av-cdp-profile",
  "--window-size=1440,1400",
  "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function json(path, method = "GET") {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method });
  return res.json();
}

let ws;
let nextId = 1;
const pending = new Map();

function send(method, params = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

try {
  for (let i = 0; i < 60; i += 1) {
    try {
      await json("/json/version");
      break;
    } catch {
      await sleep(200);
    }
  }
  // 新版本 Chrome 要求用 PUT 创建 target（GET 会返回一段纯文本错误）
  const target = await json("/json/new?about:blank", "PUT");
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
  await send("Page.navigate", { url });
  await sleep(3500); // 水合 + 字体 + 图表挂载

  const hashes = [];
  for (let i = 1; i <= 3; i += 1) {
    const shot = await send("Page.captureScreenshot", { format: "png" });
    const buffer = Buffer.from(shot.data, "base64");
    writeFileSync(`${outDir}/shot-${i}.png`, buffer);
    hashes.push(createHash("md5").update(buffer).digest("hex"));
    await sleep(800);
  }
  const clock = await send("Runtime.evaluate", {
    expression: "document.querySelector('[aria-label^=\"当前时间\"]')?.textContent ?? 'none'",
    returnByValue: true,
  });
  const motion = await send("Runtime.evaluate", {
    expression: "document.documentElement.getAttribute('data-av-motion')",
    returnByValue: true,
  });
  console.log(JSON.stringify({ url, hashes, identical: new Set(hashes).size === 1, clock: clock.result.value, motion: motion.result.value }));
} finally {
  try {
    ws?.close();
  } catch {}
  chrome.kill("SIGTERM");
}
