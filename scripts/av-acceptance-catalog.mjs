// BLF-1429（父 issue 的 Stage 8）全站视觉验收：五档宽度 × 深浅主题 × before/after 全页图集。
//
// 用法：
//   node scripts/av-acceptance-catalog.mjs <baseUrl> <outDir> <before|after> [pages...]
//
//   # after：当前分支的生产构建（3012）
//   node scripts/av-acceptance-catalog.mjs http://127.0.0.1:3012 artifacts/blf1422 after
//   # before：改造前基线（git worktree add /tmp/blf1422-before 9a867fc，3013）
//   node scripts/av-acceptance-catalog.mjs http://127.0.0.1:3013 artifacts/blf1422 before
//
// 与 av-layout-shoot.mjs 的分工：那个是**排版标定**（1920/720 等历史断点 + 对齐量距），
// 这个是**本 Stage 的验收矩阵**（1440/1280/1180/900/390 五档 + 六页 + 深浅两主题），
// 文件名带 `<suffix>` 让 before / after 落在同一目录里直接对照。整页截图仍走
// `scripts/lib/avFullPageShot.mjs`（撑高视口再拍，避免 recharts 在截图瞬间重排成空白）。
//
// 产物：
//   <outDir>/<page>-<width>-<theme>-<suffix>.png
//   <outDir>/catalog-<suffix>.json      ← 每张图的 theme / 页高 / 横向溢出 / 控制台错误
//
// 判定（只对 after 轮生效 —— before 轮是被对照的旧版，不承担本 Stage 的验收）：
//   · 实际主题必须等于请求主题（localStorage 生效）；
//   · 横向溢出必须为 0（五档宽度都是）；
//   · `/event` 在 ≥1180px 的总高 ≤ 2600px；
//   · 页面不得抛未捕获异常 / console.error。
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { captureFullPage } from "./lib/avFullPageShot.mjs";

const baseUrl = process.argv[2] ?? "http://127.0.0.1:3012";
const outDir = process.argv[3] ?? "artifacts/blf1422";
const suffix = process.argv[4] ?? "after";
const pagesArg = process.argv.slice(5);
const PAGES = pagesArg.length > 0 ? pagesArg : ["overview", "monitor", "alarm", "event", "device", "capability"];
const WIDTHS = (process.env.AV_SHOOT_WIDTHS ?? "1440,1280,1180,900,390")
  .split(",")
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value));
const THEMES = ["dark", "light"];
const VIEWPORT_HEIGHT = 1400;
/** `/event` 的整页高度上限（issue §3）；只对桌面宽度判定，移动端天然更高。 */
const EVENT_MAX_HEIGHT = 2600;
const EVENT_HEIGHT_MIN_WIDTH = 1180;
const chromePath = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

if (!["before", "after"].includes(suffix)) {
  throw new Error(`第三个参数必须是 before / after，收到 ${suffix}`);
}
mkdirSync(outDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const port = 9800 + Math.floor(Math.random() * 150);
/*
 * Chrome 的 user-data-dir 会写出上兆缓存 —— 放临时目录，截完即弃（与 av-layout-shoot 同口径）。
 */
const chrome = spawn(chromePath, [
  "--headless=new",
  "--disable-gpu",
  "--hide-scrollbars",
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${resolve(tmpdir(), `av-acceptance-catalog-${port}`)}`,
  "--window-size=1440,1400",
  "about:blank",
], { stdio: "ignore" });

let ws;
let nextId = 1;
const pending = new Map();
const pageErrors = [];

function send(method, params = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolvePromise, rejectPromise) =>
    pending.set(id, { resolve: resolvePromise, reject: rejectPromise }),
  );
}

async function evaluate(expression) {
  const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails));
  }
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
    // 页面自报的错误：只留未捕获异常与 console.error，console.log 不参与判定。
    if (message.method === "Runtime.exceptionThrown") {
      pageErrors.push(message.params.exceptionDetails?.exception?.description ?? message.params.exceptionDetails?.text ?? "unknown exception");
    }
    if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
      pageErrors.push(message.params.args?.map((arg) => arg.value ?? arg.description).join(" ") ?? "console.error");
    }
    if (message.id && pending.has(message.id)) {
      const entry = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
      else entry.resolve(message.result);
    }
  };

  await send("Page.enable");
  await send("Runtime.enable");

  for (const wantedTheme of THEMES) {
    for (const width of WIDTHS) {
      await send("Emulation.setDeviceMetricsOverride", { width, height: VIEWPORT_HEIGHT, deviceScaleFactor: 1, mobile: false });
      // 主题存在 localStorage 里：先拿一次同源权限写入，后续每次导航都会带上。
      await send("Page.navigate", { url: `${baseUrl}/stream-monitor/overview` });
      await waitFor(`!!document.querySelector('[data-av-page="overview"]')`, 20000, "首页挂载（写主题）");
      await evaluate(`localStorage.setItem("shuzhi-theme-mode", ${JSON.stringify(wantedTheme)})`);

      for (const page of PAGES) {
        pageErrors.length = 0;
        const url = `${baseUrl}/stream-monitor/${page}?static=1`;
        await send("Page.navigate", { url });
        await waitFor(`!!document.querySelector('[data-av-page="${page}"]')`, 25000, `${page} 挂载`);
        // 字体到位 + 图表挂载；`?static=1` 下动效已归零，不需要等入场。
        await evaluate(`document.fonts ? document.fonts.ready.then(() => true) : true`);
        await sleep(700);

        const metrics = await evaluate(`(() => ({
          theme: document.documentElement.dataset.theme ?? null,
          motion: document.documentElement.getAttribute("data-av-motion"),
          pageHeight: Math.ceil(Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)),
          scrollX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        }))()`);

        const shot = await captureFullPage(send, { width, viewportHeight: VIEWPORT_HEIGHT });
        writeFileSync(`${outDir}/${page}-${width}-${wantedTheme}-${suffix}.png`, shot);
        results.push({
          page,
          width,
          themeWanted: wantedTheme,
          suffix,
          bytes: shot.length,
          ...metrics,
          file: `${outDir}/${page}-${width}-${wantedTheme}-${suffix}.png`,
          errors: [...pageErrors],
        });
        process.stdout.write(`${page} ${width} ${wantedTheme} ${suffix} ok (${Math.round(shot.length / 1024)}KB, ${metrics.pageHeight}px)\n`);
      }
    }
  }

  writeFileSync(`${outDir}/catalog-${suffix}.json`, JSON.stringify(results, null, 2));

  const failures = [];
  for (const entry of results) {
    const where = `${entry.page} ${entry.width}px ${entry.theme}`;
    if (entry.theme !== entry.themeWanted) {
      failures.push(`${where}：请求主题 ${entry.themeWanted}，实际渲染 ${entry.theme}`);
    }
    if (entry.scrollX !== 0) failures.push(`${where}：横向溢出 ${entry.scrollX}px`);
    if (entry.page === "event" && entry.width >= EVENT_HEIGHT_MIN_WIDTH && entry.pageHeight > EVENT_MAX_HEIGHT) {
      failures.push(`${where}：/event 总高 ${entry.pageHeight}px > ${EVENT_MAX_HEIGHT}px`);
    }
    if (entry.errors.length > 0) failures.push(`${where}：控制台错误 ${entry.errors.join(" | ")}`);
  }

  if (suffix === "after" && failures.length > 0) {
    console.error(`\n验收不通过：\n  ${failures.join("\n  ")}`);
    process.exitCode = 1;
  } else if (failures.length > 0) {
    // before 轮：旧版本来就不满足本 Stage 的验收，只记录不判失败。
    console.log(`\nbefore 轮记录到 ${failures.length} 条（仅记录，不判失败）：\n  ${failures.join("\n  ")}`);
  } else {
    console.log("\n验收通过：五档宽度 × 深浅主题无横向溢出、/event 未超高、无控制台错误。");
  }
} finally {
  try {
    ws?.close();
  } catch {}
  chrome.kill("SIGTERM");
}
