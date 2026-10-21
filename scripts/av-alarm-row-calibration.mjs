// /alarm 首屏行数 + 行高标定的真机量距脚本（BLF-1426）。
//
// 用法：
//   node scripts/av-alarm-row-calibration.mjs [baseUrl] [--rows 12] [--out artifacts/blf1426]
//
// 为什么不是 vitest + jsdom：jsdom 没有布局引擎，`getBoundingClientRect()`
// 一律返回 0，算不出「左侧面板底边与右侧三卡栈底边差几像素」。这个 issue 的
// 验收标准本身就是**几何等式**，只能在真实排版下量：
//
//   左侧面板高 = 面板 chrome + N × 行高
//   面板 chrome = 面板头 + 工具条 + 底栏 + 内边距
//
// 量什么（每档宽度、dark、`?static=1` 冻结动效）：
//   · rows：首屏 `.alarmList > li` 条数（必须等于 --rows）；
//   · rowHeights：每条 `.alarmCard` 的实测高度（必须等于 --av-alarm-row-h）；
//   · panelBottom − railContentBottom：左侧面板底边与 `railStack` **内容底边**
//     （最后一张卡的底边）的差 —— `railStack` 本身被栅格 stretch 拉伸到整行高，
//     它的盒子底边恒等于面板底边，量它等于恒真，没有意义；
//   · rowOverflow / clipped：行内内容溢出与文本裁切（负向自检见脚本末尾）；
//   · loadMore：点「加载下一页」后条数 +N、新行是否带入场动效。
//
// 判定口径：|panelBottom − railContentBottom| ≤ 12px（三档宽度都要过）。
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const baseUrl = args.find((arg) => !arg.startsWith("--") && !args[args.indexOf(arg) - 1]?.startsWith("--")) ?? "http://127.0.0.1:3001";
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};
const EXPECTED_ROWS = Number(flag("rows", 12));
const OUT_DIR = flag("out", null);
const chromePath = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
/** 验收要求的宽度档（issue §验收标准）。1920 只做参考，不参与判定。 */
const REQUIRED_WIDTHS = [1440, 1280, 1180];
const REFERENCE_WIDTHS = [1920];
const WIDTHS = (flag("widths", null) ?? [...REQUIRED_WIDTHS, ...REFERENCE_WIDTHS].join(","))
  .split(",")
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value));
const VIEWPORT_HEIGHT = 1200;
/** 面板底边与三卡栈内容底边的允许差。 */
const ALIGN_TOLERANCE_PX = 12;
/** 行高允许的取整误差。 */
const ROW_HEIGHT_TOLERANCE_PX = 1;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (OUT_DIR) mkdirSync(OUT_DIR, { recursive: true });

const MEASURE = `(() => {
  const round = (value) => Math.round(value * 10) / 10;
  const page = document.querySelector('[data-av-page="alarm"]');
  if (!page) return { error: "no [data-av-page=alarm]" };

  const split = page.querySelector('[class*="splitWide"]');
  if (!split) return { error: "no splitWide" };
  const panel = split.firstElementChild;
  const rail = split.querySelector('[class*="railStack"]');
  if (!panel || !rail) return { error: "no panel / railStack" };

  const panelRect = panel.getBoundingClientRect();
  const railRect = rail.getBoundingClientRect();
  const railCards = Array.from(rail.children);
  const lastRailCard = railCards.at(-1) ?? null;
  const railContentBottom = lastRailCard ? lastRailCard.getBoundingClientRect().bottom : railRect.bottom;

  const list = panel.querySelector('[class*="alarmList"]');
  const items = list ? Array.from(list.children) : [];
  const cards = items.map((item) => item.querySelector('[class*="alarmCard"]') ?? item);
  const heights = cards.map((card) => round(card.getBoundingClientRect().height));
  const listRect = list ? list.getBoundingClientRect() : null;

  const panelStyle = getComputedStyle(panel);
  const listStyle = list ? getComputedStyle(list) : null;

  // 行内内容溢出：卡片盒子 vs 内容的实际外接框（bottom/right 超 1px 记溢出）。
  const rowOverflow = [];
  for (const [index, card] of cards.entries()) {
    const rect = card.getBoundingClientRect();
    let contentBottom = rect.bottom;
    let contentRight = rect.right;
    for (const child of card.querySelectorAll("*")) {
      const childRect = child.getBoundingClientRect();
      if (childRect.width === 0 && childRect.height === 0) continue;
      contentBottom = Math.max(contentBottom, childRect.bottom);
      contentRight = Math.max(contentRight, childRect.right);
    }
    const overflowY = round(contentBottom - rect.bottom);
    const overflowX = round(contentRight - rect.right);
    if (overflowY > 1 || overflowX > 1) {
      rowOverflow.push({ index, overflowY, overflowX });
    }
  }

  // 文本被裁：可滚动但内容更宽、且没有 ellipsis 兜底。
  const clipped = [];
  for (const el of page.querySelectorAll('[class*="alarmTitle"], [class*="alarmFacts"] > span, [class*="alarmAside"] > span')) {
    const style = getComputedStyle(el);
    const scrollWidth = el.scrollWidth;
    const clientWidth = el.clientWidth;
    if (clientWidth === 0) continue;
    if (scrollWidth <= clientWidth + 1) continue;
    const hasEllipsis = style.textOverflow === "ellipsis";
    if (!hasEllipsis) {
      clipped.push({ cls: el.className, text: (el.textContent ?? "").slice(0, 24), scrollWidth, clientWidth });
    }
  }

  // 行内部件高度（诊断用）：定位「84px 是谁撑起来的」，调行高时不用猜。
  const firstCard = cards[0] ?? null;
  const heightOf = (el) => (el ? round(el.getBoundingClientRect().height) : null);
  const aside = firstCard?.querySelector('[class*="alarmAside"]') ?? null;
  const parts = firstCard
    ? {
        card: heights[0],
        badge: heightOf(firstCard.querySelector('[class*="levelBadge"]')),
        main: heightOf(firstCard.querySelector('[class*="alarmCardMain"]')),
        title: heightOf(firstCard.querySelector('[class*="alarmTitle"]')),
        facts: heightOf(firstCard.querySelector('[class*="alarmFacts"]')),
        aside: heightOf(aside),
        asideChildren: aside ? Array.from(aside.children).map((child) => heightOf(child)) : [],
        paddingTop: round(parseFloat(getComputedStyle(firstCard).paddingTop)),
        paddingBottom: round(parseFloat(getComputedStyle(firstCard).paddingBottom)),
      }
    : null;

  const chromeParts = {
    header: heightOf(panel.querySelector('[class*="panelHeader"]')),
    toolbar: heightOf(panel.querySelector('[class*="alarmToolbar"]')),
    list: listRect ? round(listRect.height) : null,
    foot: heightOf(panel.querySelector('[class*="alarmFoot"]')),
    panelPaddingTop: round(parseFloat(panelStyle.paddingTop)),
    panelPaddingBottom: round(parseFloat(panelStyle.paddingBottom)),
    body: (() => {
      const body = panel.querySelector('[class*="panelBody"]');
      if (!body) return null;
      const style = getComputedStyle(body);
      return {
        h: round(body.getBoundingClientRect().height),
        padTop: round(parseFloat(style.paddingTop)),
        padBottom: round(parseFloat(style.paddingBottom)),
        rowGap: round(parseFloat(style.rowGap || "0")),
        overflowY: style.overflowY,
      };
    })(),
    childHeights: Array.from(panel.children).map((child) => ({ cls: String(child.className).slice(0, 30), h: round(child.getBoundingClientRect().height) })),
  };

  /*
   * 面板的**自然高度** = 直接子元素高度 + 上下边框。
   *
   * 不能直接用 panelRect.height：[class*=splitWide] > *:not(.railStack) 的 height:100%
   * 会把左面板拉伸到整行高，右栏比它高时（1280/1180）量到的就是 rail 的高度 ——
   * 那会让「底边差 0」变成恒真。自然高度才是行高标定真正在控制的量。
   */
  const panelNaturalHeight = round(
    Array.from(panel.children).reduce((sum, child) => sum + child.getBoundingClientRect().height, 0) +
      parseFloat(panelStyle.borderTopWidth || "0") +
      parseFloat(panelStyle.borderBottomWidth || "0"),
  );
  const chromeHeight = listRect
    ? round(panelNaturalHeight - listRect.height - parseFloat(listStyle.marginTop || "0") - parseFloat(listStyle.marginBottom || "0"))
    : null;

  return {
    rows: cards.length,
    rowHeights: heights,
    rowHeightMin: heights.length ? Math.min(...heights) : null,
    rowHeightMax: heights.length ? Math.max(...heights) : null,
    panelTop: round(panelRect.top),
    panelBottom: round(panelRect.bottom),
    panelHeight: round(panelRect.height),
    panelNaturalHeight,
    panelPaddingX: round(parseFloat(panelStyle.paddingLeft)),
    railTop: round(railRect.top),
    railBoxBottom: round(railRect.bottom),
    railContentBottom: round(railContentBottom),
    railCardHeights: railCards.map((card) => round(card.getBoundingClientRect().height)),
    railGap: railCards.length > 1 ? round(railCards[1].getBoundingClientRect().top - railCards[0].getBoundingClientRect().bottom) : null,
    deltaPanelRail: round(panelRect.bottom - railContentBottom),
    listHeight: listRect ? round(listRect.height) : null,
    chromeHeight,
    parts,
    chromeParts,
    rowOverflow,
    clipped,
  };
})()`;

const port = 9800 + Math.floor(Math.random() * 150);
const chrome = spawn(
  chromePath,
  [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${resolve(tmpdir(), `av-alarm-calibration-${port}`)}`,
    "--window-size=1920,1400",
    "about:blank",
  ],
  { stdio: "ignore" },
);

let ws;
let nextId = 1;
const pending = new Map();

function send(method, params = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolvePromise, rejectPromise) => pending.set(id, { resolve: resolvePromise, reject: rejectPromise }));
}

async function evaluate(expression) {
  const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails));
  }
  return result.result.value;
}

async function waitFor(expression, timeoutMs = 15000, label = expression) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await evaluate(expression)) return;
    await sleep(150);
  }
  throw new Error(`等待超时：${label}`);
}

async function setDarkTheme() {
  await evaluate(`localStorage.setItem("shuzhi-theme-mode", "dark")`);
}

const results = [];
let loadMore;

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
    await send("Emulation.setDeviceMetricsOverride", { width, height: VIEWPORT_HEIGHT, deviceScaleFactor: 1, mobile: false });
    // 第一次导航拿同源 localStorage 权限，再写入 dark 后重载（与 av-layout-shoot 同做法）。
    await send("Page.navigate", { url: `${baseUrl}/stream-monitor/alarm?static=1` });
    await waitFor(`!!document.querySelector('[data-av-page="alarm"]')`);
    await setDarkTheme();
    await send("Page.navigate", { url: `${baseUrl}/stream-monitor/alarm?static=1` });
    await waitFor(`document.querySelectorAll('[class*="alarmList"] > li').length > 0`, 20000, "首屏告警行");
    // 等字体 / 布局稳定
    await evaluate(`document.fonts ? document.fonts.ready.then(() => true) : true`);
    await sleep(600);

    const metrics = await evaluate(MEASURE);
    let shot = null;
    if (OUT_DIR) {
      const data = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
      const file = resolve(OUT_DIR, `alarm-${width}.png`);
      writeFileSync(file, Buffer.from(data.data, "base64"));
      shot = file;
    }
    results.push({ width, theme: await evaluate(`document.documentElement.dataset.theme ?? null`), shot, ...metrics });
    process.stderr.write(`measure ${width}px: rows=${metrics.rows} rowH=${metrics.rowHeightMin}–${metrics.rowHeightMax} panel=${metrics.panelHeight} rail=${metrics.railContentBottom - metrics.railTop} delta=${metrics.deltaPanelRail}\n`);
  }

  // 「加载下一页」：12 → 24，且新增行带入场动效（插入瞬间 opacity/transform 非终值）。
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: VIEWPORT_HEIGHT, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: `${baseUrl}/stream-monitor/alarm` });
  await waitFor(`document.querySelectorAll('[class*="alarmList"] > li').length > 0`, 20000, "首页告警行");
  await setDarkTheme();
  await send("Page.navigate", { url: `${baseUrl}/stream-monitor/alarm` });
  await waitFor(`document.querySelectorAll('[class*="alarmList"] > li').length > 0`, 20000, "首页告警行");
  await evaluate(`(() => {
    window.__alarmInserted = [];
    const list = document.querySelector('[class*="alarmList"]');
    if (!list) return false;
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!(node instanceof HTMLElement)) continue;
          const style = getComputedStyle(node);
          window.__alarmInserted.push({
            tag: node.tagName,
            opacity: style.opacity,
            transform: style.transform,
            inlineStyle: node.getAttribute("style") ?? "",
          });
        }
      }
    });
    observer.observe(list, { childList: true });
    window.__alarmObserver = observer;
    return true;
  })()`);
  const before = await evaluate(`document.querySelectorAll('[class*="alarmList"] > li').length`);
  await evaluate(`(() => {
    const button = Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === '加载下一页');
    if (!button) return false;
    button.scrollIntoView({ block: 'center' });
    button.click();
    return true;
  })()`);
  await waitFor(
    `document.querySelectorAll('[class*="alarmList"] > li').length > ${before}`,
    20000,
    "加载下一页追加行",
  );
  await sleep(1000);
  const after = await evaluate(`document.querySelectorAll('[class*="alarmList"] > li').length`);
  const inserted = await evaluate(`window.__alarmInserted ?? []`);
  loadMore = {
    before,
    after,
    added: after - before,
    insertedCount: inserted.length,
    // framer-motion 的初始帧：opacity < 1 且/或 transform 带位移；或内联 style 里有 opacity/transform。
    animated: inserted.filter(
      (entry) =>
        Number(entry.opacity) < 1 ||
        (entry.transform && entry.transform !== "none") ||
        /opacity|transform/.test(entry.inlineStyle),
    ).length,
    sample: inserted.slice(0, 3),
  };

  const failures = [];
  for (const entry of results) {
    if (entry.error) {
      failures.push(`${entry.width}px：量距失败（${entry.error}）`);
      continue;
    }
    if (entry.rows !== EXPECTED_ROWS) {
      failures.push(`${entry.width}px：首屏 ${entry.rows} 条，期望 ${EXPECTED_ROWS} 条`);
    }
    if (entry.rowHeightMin === null || Math.abs(entry.rowHeightMax - entry.rowHeightMin) > ROW_HEIGHT_TOLERANCE_PX) {
      failures.push(`${entry.width}px：行高不一致 ${entry.rowHeightMin}–${entry.rowHeightMax}px`);
    }
    if (REQUIRED_WIDTHS.includes(entry.width) && Math.abs(entry.deltaPanelRail) > ALIGN_TOLERANCE_PX) {
      failures.push(
        `${entry.width}px：面板底边与三卡栈内容底边差 ${entry.deltaPanelRail}px（允许 ±${ALIGN_TOLERANCE_PX}px）`,
      );
    }
    if (entry.rowOverflow.length > 0) {
      failures.push(`${entry.width}px：${entry.rowOverflow.length} 行内容溢出卡片（${JSON.stringify(entry.rowOverflow.slice(0, 3))}）`);
    }
    if (entry.clipped.length > 0) {
      failures.push(`${entry.width}px：${entry.clipped.length} 处文本被裁且无 ellipsis（${JSON.stringify(entry.clipped.slice(0, 3))}）`);
    }
  }
  if (loadMore.before !== EXPECTED_ROWS) {
    failures.push(`加载前 ${loadMore.before} 条，期望 ${EXPECTED_ROWS} 条`);
  }
  if (loadMore.added !== EXPECTED_ROWS) {
    failures.push(`「加载下一页」追加 ${loadMore.added} 条，期望 ${EXPECTED_ROWS} 条`);
  }
  if (loadMore.animated === 0) {
    failures.push(`「加载下一页」新增的 ${loadMore.insertedCount} 行没有入场动效（opacity/transform 均为终值）`);
  }

  if (OUT_DIR) {
    writeFileSync(resolve(OUT_DIR, "alarm-row-calibration.json"), JSON.stringify({ baseUrl, expectedRows: EXPECTED_ROWS, results, loadMore, failures }, null, 2));
  }
  console.log(JSON.stringify({ results, loadMore, failures }, null, 2));

  if (failures.length > 0) {
    process.stderr.write(`\n验收不通过（${failures.length} 项）：\n  ${failures.join("\n  ")}`);
    process.exitCode = 1;
  } else {
    process.stderr.write(
      `\n验收通过：${EXPECTED_ROWS} 条首屏、行高 ${results[0]?.rowHeightMin}px、` +
        `三档宽度面板底边与三卡栈内容底边差 ≤ ${ALIGN_TOLERANCE_PX}px、无溢出/裁字、翻页追加 ${loadMore.added} 条且带入场动效。`,
    );
  }
} finally {
  try {
    ws?.close();
  } catch {}
  chrome.kill("SIGTERM");
}
