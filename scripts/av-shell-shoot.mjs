// BLF-1398 视觉验收：桌面两个宽度 + 手机两个宽度，各截一张顶栏。
// 用法：node scripts/av-shell-shoot.mjs <baseUrl> <outDir>
//
// 量的不只是控件高度，还有**顶栏的行数** —— 行数是「44px 触控档把顶栏从 2 行
// 挤成 3 行」这类回退的唯一可见指标（顶栏高度会变，但行数才说清是不是换行了）。
// 行数按**子元素纵向重叠**聚类得出，不是数 `child.top`：同一行的元素 top 相同、
// 但 flex 行内的对齐方式会让 top 有零点几像素的差别，数 top 会把一行数成两行。
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

  // 桌面宽度（1440 / 1920）走双主题，手机宽度（430 / 390 / 360）只走深色 ——
  // 手机顶栏的行数与主题无关，两个主题都截只是多几张几乎一样的图。
  const desktopWidths = [1440, 1920];
  const mobileWidths = [430, 390, 360];
  const themes = ["dark", "light"];
  const results = [];

  for (const theme of themes) {
    for (const width of [...desktopWidths, ...(theme === "dark" ? mobileWidths : [])]) {
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

      // 量一下顶栏控件的实际高度（用真实渲染值，而不是 CSS 声明），以及顶栏行数
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

          // 顶栏高度 + 行数
          const header = document.querySelector("header");
          if (header) {
            out.topbarHeight = Math.round(header.getBoundingClientRect().height);
            // 行数 = 按纵向重叠把顶栏的直接子元素聚类。
            // 同一行的元素可能 top 差零点几像素（align-items / 边框），
            // 所以用「重叠高度超过自身高度一半」判同一行，而不是比较 top。
            const rows = [];
            for (const el of header.children) {
              const rect = el.getBoundingClientRect();
              if (rect.width === 0 || rect.height === 0) continue;
              const style = getComputedStyle(el);
              if (style.display === "none" || style.visibility === "hidden") continue;
              const row = rows.find((candidate) => {
                const overlap =
                  Math.min(candidate.bottom, rect.bottom) - Math.max(candidate.top, rect.top);
                const shorter = Math.min(candidate.bottom - candidate.top, rect.height);
                return overlap > shorter * 0.5;
              });
              if (row) {
                row.top = Math.min(row.top, rect.top);
                row.bottom = Math.max(row.bottom, rect.bottom);
                row.items.push(el.className || el.tagName);
              } else {
                rows.push({ top: rect.top, bottom: rect.bottom, items: [el.className || el.tagName] });
              }
            }
            out.topbarRows = rows.length;
            out.topbarRowItems = rows.map((row) => row.items.length);
          }

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

  // 断言：这些是**视觉验收的硬口径**，红了就是回退了。
  // 顶栏行数是这里最要紧的一条：44px 触控档一旦让顶栏多换一行，
  // 手机首屏就被顶栏吃掉近 20%，而顶栏高度本身（113px）看着不刺眼。
  const failures = [];
  for (const { theme, width, metrics } of results) {
    const mobile = width <= 430;
    // 手机（390 / 360）顶栏必须是 2 行：第 1 行 = 菜单键 + 状态簇，第 2 行 = 搜索框。
    // 桌面必须 1 行。
    const maxRows = mobile ? 2 : 1;
    if ((metrics.topbarRows ?? 0) > maxRows) {
      failures.push(`${theme} ${width}px：顶栏 ${metrics.topbarRows} 行，超过 ${maxRows} 行`);
    }
    if (metrics.scrollX !== 0) {
      failures.push(`${theme} ${width}px：横向溢出 ${metrics.scrollX}px`);
    }
    if (metrics.anchorCount !== 1) {
      failures.push(`${theme} ${width}px：「数据锚点」出现 ${metrics.anchorCount} 次，应为 1 次`);
    }
    // 触控档：≤900px 的控件必须是 44px；桌面必须回到 34px。
    const expectedShell = mobile ? 44 : 34;
    for (const key of ["searchBox", "themeButton", "backLink"]) {
      if (metrics[key] !== expectedShell) {
        failures.push(`${theme} ${width}px：${key} = ${metrics[key]}px，应为 ${expectedShell}px`);
      }
    }
  }
  if (failures.length > 0) {
    console.error(`\n验收不通过：\n  ${failures.join("\n  ")}`);
    process.exitCode = 1;
  }
} finally {
  try {
    ws?.close();
  } catch {}
  chrome.kill("SIGTERM");
}
