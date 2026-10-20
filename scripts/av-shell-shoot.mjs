// BLF-1398 视觉验收：两个宽度 × 深浅两套主题，各截一张顶栏。
// 用法：node scripts/av-shell-shoot.mjs <baseUrl> <outDir>
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

const baseUrl = process.argv[2] ?? "http://127.0.0.1:3111";
const outDir = process.argv[3] ?? "/tmp/av-shell-shoot";
const chromePath = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const port = 9335;

mkdirSync(outDir, { recursive: true });

const chrome = spawn(chromePath, [
  "--headless=new",
  "--disable-gpu",
  "--hide-scrollbars",
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${outDir}/profile`,
  "--window-size=1920,1400",
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
  await send("Runtime.enable");

  const widths = [1440, 1920];
  const themes = ["dark", "light"];
  const results = [];

  for (const theme of themes) {
    for (const width of widths) {
      await send("Emulation.setDeviceMetricsOverride", { width, height: 1400, deviceScaleFactor: 1, mobile: false });
      // 主题：写 localStorage 后重新导航（bootstrap 脚本会读它）
      await send("Page.navigate", { url: `${baseUrl}/stream-monitor/overview?static=1` });
      await sleep(2500);
      await send("Runtime.evaluate", {
        expression: `localStorage.setItem("shuzhi-theme-mode", ${JSON.stringify(theme)})`,
        returnByValue: true,
      });
      await send("Page.navigate", { url: `${baseUrl}/stream-monitor/overview?static=1` });
      await sleep(3500);

      // 量一下顶栏控件的实际高度（用真实渲染值，而不是 CSS 声明）
      const metrics = await send("Runtime.evaluate", {
        expression: `(() => {
          const out = {};
          const grab = (label, sel) => {
            const el = document.querySelector(sel);
            out[label] = el ? Math.round(el.getBoundingClientRect().height) : null;
          };
          grab("searchBox", "form[role=search]");
          grab("themeButton", "button[aria-label^='切换到']");
          grab("backLink", "a[title='返回数科云办公']");
          grab("chip", "header span[title*='数据锚点']");
          grab("clock", "header span[aria-label^='当前时间']");
          grab("topbar", "header");
          out.anchorCount = (document.body.innerText.match(/数据锚点/g) || []).length;
          out.theme = document.documentElement.dataset.theme;
          out.scrollX = document.documentElement.scrollWidth - document.documentElement.clientWidth;
          return out;
        })()`,
        returnByValue: true,
      });

      const shot = await send("Page.captureScreenshot", { format: "png" });
      const buffer = Buffer.from(shot.data, "base64");
      const file = `${outDir}/${theme}-${width}.png`;
      writeFileSync(file, buffer);
      results.push({
        theme,
        width,
        file,
        md5: createHash("md5").update(buffer).digest("hex").slice(0, 8),
        metrics: metrics.result.value,
      });
    }
  }

  console.log(JSON.stringify(results, null, 2));
} finally {
  try {
    ws?.close();
  } catch {}
  chrome.kill("SIGTERM");
}
