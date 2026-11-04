import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const base = process.argv[2] ?? 'http://127.0.0.1:4477/index.html';
const outDir = process.argv[3] ?? '/tmp/color-review-shots';
const only = process.argv[4] ? process.argv[4].split(',') : null;
const chromePath = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const port = 9441;
mkdirSync(outDir, { recursive: true });

const chrome = spawn(chromePath, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars',
  '--remote-debugging-port=' + port,
  '--user-data-dir=' + outDir + '/profile',
  '--window-size=1600,1200', 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function json(path, method = 'GET') {
  const res = await fetch('http://127.0.0.1:' + port + path, { method });
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

const configs = [];
for (const p of ['current', 'a', 'b', 'c', 'd']) for (const mode of ['dark', 'light']) configs.push({ p, mode });

try {
  for (let i = 0; i < 80; i++) { try { await json('/json/version'); break; } catch { await sleep(200); } }
  const target = await json('/json/new?about:blank', 'PUT');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (event) => {
    const m = JSON.parse(event.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) p.reject(new Error(JSON.stringify(m.error))); else p.resolve(m.result);
    }
  };
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 2, mobile: false });

  const expr = "(() => { var el = document.querySelector('.frame'); var r = el.getBoundingClientRect(); return JSON.stringify({ x: r.x, y: r.y + window.scrollY, w: r.width, h: r.height }); })()";

  for (const c of configs) {
    const name = c.p + '-' + c.mode;
    if (only && !only.includes(name)) continue;
    await send('Page.navigate', { url: base + '?shot=' + name + '#' + name });
    await sleep(1600);
    const box = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
    const b = JSON.parse(box.result.value);
    const shot = await send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: { x: b.x, y: b.y, width: b.w, height: b.h, scale: 1.5 },
    });
    writeFileSync(outDir + '/app-' + name + '.png', Buffer.from(shot.data, 'base64'));
    console.log('app-' + name + '.png', Math.round(b.w) + 'x' + Math.round(b.h));
  }
} finally {
  try { chrome.kill('SIGKILL'); } catch (e) {}
  process.exit(0);
}
