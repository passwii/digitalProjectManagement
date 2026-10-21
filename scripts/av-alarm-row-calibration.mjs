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
//   · panelNaturalBottom − railContentBottom：左侧面板的**自然底边**（自然高度算出来的
//     底边，不含栅格拉伸）与 `railStack` **内容底边**（最后一张卡的底边）的差。
//     三个量都不能用盒子的 rect：`railStack` 被栅格 stretch 到整行高，`splitWide`
//     又把左面板 `height:100%` 拉到同一行高，于是 1280/1180（右栏更高）时
//     `panelRect.bottom === railRect.bottom === railContentBottom`，用它们相减恒为 0，
//     行高标定彻底失控也照样过（Codex P2 on PR #175）。自然高度才是行高在控制的量；
//   · rowOverflow / clipped：行内内容溢出与文本裁切（负向自检见脚本末尾）；
//   · truncation：标题 / 告警编号是否被压成省略号。ellipsis 既不溢出也不裁字，
//     `clipped` 抱不到，但它才是「标题只剩三个字」的真实取值；
//   · columnCount：`splitWide` 实际几栏（验证两栏带的下界与单栏那一侧）；
//   · loadMore：点「加载下一页」后条数 +N、新行是否带入场动效。
//
// 判定口径：|panelNaturalBottom − railContentBottom| ≤ 12px（必需宽度全要过）、
// 必需宽度两栏、下界下方 1px 单栏、所有量过的宽度标题 / 编号不被省略，
// 且必需宽度的标题列宽 ≥ 200px（不靠「恰好排得下」）。
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { relative, resolve, sep } from "node:path";

const args = process.argv.slice(2);
const baseUrl = args.find((arg) => !arg.startsWith("--") && !args[args.indexOf(arg) - 1]?.startsWith("--")) ?? "http://127.0.0.1:3001";
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};
const EXPECTED_ROWS = Number(flag("rows", 12));
const OUT_DIR = flag("out", null);
const chromePath = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
/**
 * /alarm 两栏带的**下界**（与 `AvPages.module.css` 的 `@media (min-width: …)` 一致）。
 *
 * 为什么不是外壳的 1100 档：1100 只是「侧栏宽 220」的档位，不等于「面板装得下自己」。
 * 实测（生产构建，dark，1100–1180 逐档扫）：1100/1101 时左面板 528 / 497px，装不下
 * 工具条（搜索框 min 180 + 场景 Tabs），`.alarmToolbar` 38 → 76px，面板 chrome +38px、
 * 底边差从 −8.5 变成 +29.5（超 ±12）；临界在 1150（换行）→ 1151（单行，面板 547）。
 * 取 1160 = 面板 556px，给临界点留 9px 余量。
 */
const TWO_COLUMN_MIN_WIDTH = 1160;
/**
 * 必需宽度档：三档验收宽度（issue §验收标准）+ 两栏带的下界。
 *
 * 下界必须单独量 —— 901 时代的 P2 就是「下界取了个没量过副作用的值」：
 * 那一档左面板只剩 329px，标题被压成省略号却没人发现（而它恰好不在
 * 三档验收宽度里）。同理，上界也不能只靠「1180 恰好单行」这种巧合。
 * 1920 只做参考，不参与判定。
 */
const REQUIRED_WIDTHS = [1440, 1280, 1180, TWO_COLUMN_MIN_WIDTH];
/**
 * 边界对照：下界下方 1px 必须回到共享断点的**单栏**（底边等式不再适用），
 * 而它的标题仍然排得开 —— 即「切换那一瞬间两侧都可用」。
 */
const BAND_PROBE_WIDTHS = [TWO_COLUMN_MIN_WIDTH - 1];
const REFERENCE_WIDTHS = [1920];
const WIDTHS = (flag("widths", null) ?? [...REQUIRED_WIDTHS, ...BAND_PROBE_WIDTHS, ...REFERENCE_WIDTHS].join(","))
  .split(",")
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value));
const VIEWPORT_HEIGHT = 1200;
/** 面板底边与三卡栈内容底边的允许差。 */
const ALIGN_TOLERANCE_PX = 12;
/**
 * 必需宽度下标题列的最小可用宽度（px）。
 *
 * 只看「没被省略」不够：样例告警标题只有 4–10 个字，列宽只剩 40px 时也可能恰好排得下，
 * 下一个人换一条长标题就变成省略号。这个数 = 约 14 个汉字（--av-text-panel 14px），
 * 是「标题能读出是什么事」的下限，901 时代的 40px 会直接在这里挂掉。
 */
const MIN_TITLE_WIDTH_PX = 200;
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
  // 栏数来自实际计算值（不是猜断点）：单栏是 1 个轨道，两栏是 2 个。
  const trackCount = (value) => value.split(" ").filter((part) => /px|fr|auto|%/.test(part)).length;
  const columnCount = trackCount(getComputedStyle(split).gridTemplateColumns);
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

  /*
   * 标题 / 编号是不是被压成了省略号。
   *
   * 上面的 clipped 只抓「溢出且**没有** ellipsis」；标题本身带 ellipsis，
   * 被压窄时会安静地变成「3 号炉主蒸…」—— 既不溢出也不裁字，验收却已经退化。
   * 所以这里直接量 scrollWidth 与 clientWidth 的差：能排下的文本两者相等。
   */
  const truncationOf = (el) => {
    if (!el) return null;
    return {
      text: (el.textContent ?? "").trim().slice(0, 24),
      clientWidth: el.clientWidth,
      scrollWidth: el.scrollWidth,
      truncated: el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1,
    };
  };
  const titleCells = cards.map((card) => truncationOf(card.querySelector('[class*="alarmTitle"]')));
  const numberCells = cards.map((card) =>
    truncationOf(card.querySelector('[class*="alarmFacts"] > span:last-child')),
  );
  const widths = (cells) => cells.map((cell) => cell?.clientWidth ?? 0).filter((value) => value > 0);
  const truncatedCount = (cells) => cells.filter((cell) => cell?.truncated).length;
  const truncation = {
    titleMinWidth: Math.min(...widths(titleCells)),
    titleMaxWidth: Math.max(...widths(titleCells)),
    truncatedTitles: truncatedCount(titleCells),
    truncatedNumbers: truncatedCount(numberCells),
    // 只留前几条样本，JSON 不至于被 12 行的全文撑大。
    titleSamples: titleCells.filter((cell) => cell?.truncated).slice(0, 3),
    numberSamples: numberCells.filter((cell) => cell?.truncated).slice(0, 3),
  };

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
    columnCount,
    rowHeights: heights,
    rowHeightMin: heights.length ? Math.min(...heights) : null,
    rowHeightMax: heights.length ? Math.max(...heights) : null,
    // 盒子 rect：1280/1180 被 splitWide 的 height:100% 拉伸，仅作诊断，不参与判定。
    panelTop: round(panelRect.top),
    panelBoxBottom: round(panelRect.bottom),
    panelBoxHeight: round(panelRect.height),
    panelNaturalHeight,
    panelNaturalBottom: round(panelRect.top + panelNaturalHeight),
    // 拉伸量 = 盒子高 − 自然高；> 0 说明这一档是右栏在撑高左面板。
    panelStretch: round(panelRect.height - panelNaturalHeight),
    panelPaddingX: round(parseFloat(panelStyle.paddingLeft)),
    railTop: round(railRect.top),
    railBoxBottom: round(railRect.bottom),
    railContentBottom: round(railContentBottom),
    railCardHeights: railCards.map((card) => round(card.getBoundingClientRect().height)),
    railGap: railCards.length > 1 ? round(railCards[1].getBoundingClientRect().top - railCards[0].getBoundingClientRect().bottom) : null,
    // 判定用的底边差：自然底边 vs 三卡栈内容底边（见文件头注释）。
    deltaPanelRail: round(panelRect.top + panelNaturalHeight - railContentBottom),
    listHeight: listRect ? round(listRect.height) : null,
    chromeHeight,
    parts,
    chromeParts,
    rowOverflow,
    clipped,
    truncation,
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
      // 存相对路径：绝对路径里带着本机 workspace id / worktree 名，产物是要进仓库的。
      shot = relative(process.cwd(), file).split(sep).join("/");
    }
    results.push({ width, theme: await evaluate(`document.documentElement.dataset.theme ?? null`), shot, ...metrics });
    process.stderr.write(`measure ${width}px: cols=${metrics.columnCount} rows=${metrics.rows} rowH=${metrics.rowHeightMin}–${metrics.rowHeightMax} panelNatural=${metrics.panelNaturalHeight} stretch=${metrics.panelStretch} railContent=${Math.round((metrics.railContentBottom - metrics.railTop) * 10) / 10} delta=${metrics.deltaPanelRail} title=${metrics.truncation.titleMinWidth}–${metrics.truncation.titleMaxWidth} truncated=${metrics.truncation.truncatedTitles}/${metrics.truncation.truncatedNumbers}\n`);
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
        `${entry.width}px：面板自然底边与三卡栈内容底边差 ${entry.deltaPanelRail}px（允许 ±${ALIGN_TOLERANCE_PX}px；拉伸量 ${entry.panelStretch}px 不参与判定）`,
      );
    }
    // 栏数：下界及以上必须两栏（否则 1180 的验收不成立）；下界下方 1px 必须回到单栏。
    if (REQUIRED_WIDTHS.includes(entry.width) && entry.columnCount !== 2) {
      failures.push(`${entry.width}px：splitWide 是 ${entry.columnCount} 栏，期望 2 栏`);
    }
    if (BAND_PROBE_WIDTHS.includes(entry.width) && entry.columnCount !== 1) {
      failures.push(`${entry.width}px：两栏带下方应为单栏，实际 ${entry.columnCount} 栏`);
    }
    if (entry.rowOverflow.length > 0) {
      failures.push(`${entry.width}px：${entry.rowOverflow.length} 行内容溢出卡片（${JSON.stringify(entry.rowOverflow.slice(0, 3))}）`);
    }
    if (entry.clipped.length > 0) {
      failures.push(`${entry.width}px：${entry.clipped.length} 处文本被裁且无 ellipsis（${JSON.stringify(entry.clipped.slice(0, 3))}）`);
    }
    // 标题被压成省略号 = 「有没有标题」只看得见三五个字；编号被截断 = 主键对不上
    // 抽屉与搜索。两者都不算「溢出」，所以必须单独断。
    if (entry.truncation.truncatedTitles > 0) {
      failures.push(
        `${entry.width}px：${entry.truncation.truncatedTitles} 行标题被压成省略号（标题宽 ${entry.truncation.titleMinWidth}–${entry.truncation.titleMaxWidth}px；${JSON.stringify(entry.truncation.titleSamples)}）`,
      );
    }
    if (entry.truncation.truncatedNumbers > 0) {
      failures.push(
        `${entry.width}px：${entry.truncation.truncatedNumbers} 行告警编号被截断（编号是主键，不允许省略；${JSON.stringify(entry.truncation.numberSamples)}）`,
      );
    }
    if (REQUIRED_WIDTHS.includes(entry.width) && entry.truncation.titleMinWidth < MIN_TITLE_WIDTH_PX) {
      failures.push(
        `${entry.width}px：标题列宽 ${entry.truncation.titleMinWidth}px 小于下限 ${MIN_TITLE_WIDTH_PX}px（标题会被压成 3–5 个字）`,
      );
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
        `${REQUIRED_WIDTHS.join("/")}px 面板底边与三卡栈内容底边差 ≤ ${ALIGN_TOLERANCE_PX}px、` +
        `两栏带下界 ${TWO_COLUMN_MIN_WIDTH}px（下界下方 ${BAND_PROBE_WIDTHS.join("/")}px 为单栏）、` +
        `无溢出/裁字/省略号截断、翻页追加 ${loadMore.added} 条且带入场动效。`,
    );
  }
} finally {
  try {
    ws?.close();
  } catch {}
  chrome.kill("SIGTERM");
}
