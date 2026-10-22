// CSS Module 关键帧名解析审计（BLF-1433）。
//
// 背景：CSS Modules 会把 `animation: avFadeIn` 里的名字本地化成
// `<模块>_avFadeIn__hash`，而 `app/globals.css` 里的 `@keyframes avFadeIn` 是全局的。
// 名字对不上时浏览器**不报错**：`animation-name` 不是 `none`，但样式表里没有同名帧，
// 元素永远停在首帧。所以「源码里写了 animation」不能证明动画在跑，只能在浏览器里
// 拿计算样式 `animationName` 与 `document.styleSheets` 的 `CSSKeyframesRule.name`
// 集合逐一比对 —— 源码守卫（web/lib/av/avKeyframes.vitest.test.ts）挡写法回退，
// 本脚本挡的是「写法对、运行时仍然解析不到」的静默失效。
//
// 判定：
//   · 每页 × 1440 / 390 两档，遍历所有元素及其 ::before / ::after / ::backdrop，
//     收集 `getComputedStyle().animationName`，逐个名字查 @keyframes 集合；
//   · 解析不到的名字记一条，正常应为 **0 条**；
//   · `EXPECTATIONS` 里列的（页面, 选择器, 期望帧名）**按 page × width 逐条记账**：
//     元素没渲染 → failure；元素渲染了但 animationName 是 none → failure；采样到帧名但
//     不是期望的那条 → failure。只有显式标了 `optional: true` 的按需节点（例如点击
//     「加载下一页」后才挂载的骨架屏）允许「没出现」，但仍记进 `expectationMisses`。
//     **不存在「null 即放行」**：这正是 Stage 3/4 review 抓过两次的恒真断言。
//
// **两条负向自检**（任一不通过都直接判失败）：
//   1. 帧名解析口径：先在第一个页面上插一个指向不存在帧名的探针元素，同一套扫描必须
//      报出它（≥1 条）；
//   2. 期望门禁口径：把一条真实期望的选择器换成不存在的，`judgeExpectations` 必须报
//      failure（同一份逻辑，见 expectationGateSelfCheck）。
//   另有端到端模式 `--break-expectation`：真的把第 1 条期望的选择器改坏再跑完整轮，
//   审计必须整体失败、JSON 里 `pass: false`。用法见下。
//
// 用法：
//   node scripts/av-keyframes-audit.mjs [baseUrl] [outDir]
//   node scripts/av-keyframes-audit.mjs [baseUrl] [outDir] --break-expectation
//     ↑ 负向自检模式：期望门禁必须 fail（退出码 1）。产物写到单独目录，别覆盖正式报告。
// 依赖本机 Chrome（可用 CHROME_PATH 覆盖），CDP 薄封装与 av-monitor-motion.mjs /
// av-layout-overflow.mjs 同一套做法。
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const positionalArgs = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const baseUrl = positionalArgs[0] ?? "http://127.0.0.1:3001";
const outDir = positionalArgs[1] ?? "artifacts/blf1433";
// 端到端负向自检：把第 1 条期望的选择器改坏，整轮必须 pass: false。
const breakExpectation = process.argv.includes("--break-expectation");
const chromePath = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

// 五页 + capability / audio（issue 要求的两页额外覆盖）。
const PAGES = ["overview", "monitor", "alarm", "event", "device", "capability", "audio"];
const WIDTHS = [1440, 390];

/**
 * 期望项：元素在该 page × width 必须渲染、且计算 animationName 必须包含 `frame`。
 * 只有显式 `optional: true` 的按需节点允许「没渲染」（仍会记进 expectationMisses）。
 */
// 选择器用 `[class*=...]`：类名在运行时带着 CSS Modules 的哈希后缀（`.rangeBody`
// 实际渲染成 `.AvPages_rangeBody__xxxxx`），写死类名会一条都命中不到。
const EXPECTATIONS = [
  { page: "overview", selector: '[class*="rangeBody"]', frame: "avRangeSwap" },
  { page: "overview", selector: '[class*="heatCellPulse"]', frame: "avHeatPulse" },
  {
    page: "alarm",
    selector: '[class*="levelBadge"][data-level="1"] [class*="levelSwatch"]',
    frame: "avBreathe",
  },
  { page: "event", selector: '[class*="timelineItem"][data-motion-node]', frame: "avRiseIn" },
  { page: "capability", selector: '[class*="sceneCard"]', frame: "avRiseIn" },
  { page: "capability", selector: '[class*="chainStep"]', frame: "avRiseIn" },
  // 骨架屏只在「加载下一页」的等待窗口里存在：先点按钮再轮询（见 pollExpectations 的 action）。
  // 它是否出现取决于数据返回时机，属于按需节点 —— 标 optional，不拿「没采到」当失败；
  // 但一旦采到，帧名仍必须对（下面的 judgeExpectations 对 optional 项照样校验帧名）。
  {
    page: "alarm",
    selector: '[class*="skeleton"]:not([class*="skeletonSwap"])',
    frame: "avSkeleton",
    action: "click-load-more",
    optional: true,
  },
  { page: "audio", selector: '[class*="spectroWrap"]', pseudo: "::after", frame: "avWipeUp" },
];

// 负向自检模式：第 1 条期望的选择器改成页面里不可能存在的特征，门禁必须报 failure。
const BROKEN_EXPECTATION_SELECTOR = '[data-av-kf-audit-missing-selector]';
const ACTIVE_EXPECTATIONS = breakExpectation
  ? EXPECTATIONS.map((item, index) =>
      index === 0 ? { ...item, selector: BROKEN_EXPECTATION_SELECTOR, optional: false } : item,
    )
  : EXPECTATIONS;

/**
 * 期望门禁（纯函数，便于自检）：按 page × width 逐条判定。
 * 返回 { failures, misses }：
 *   · 采样到帧名但不是期望值 → failure；
 *   · 元素渲染了但 animationName 一直是 none → failure（动画没挂上，不是「不存在」）；
 *   · 元素没渲染且没标 optional → failure（选择器漂了或被删了）；
 *   · 元素没渲染且标了 optional → 只进 misses，不算失败。
 * `present` = 采样窗口内元素是否出现过；`names` = 首次采到的 animationName 列表。
 */
function judgeExpectations(records) {
  const failures = [];
  const misses = [];
  for (const record of records) {
    const where = `${record.page} ${record.width}px：${record.selector}${record.pseudo ?? ""}`;
    if (record.names !== null && record.names !== undefined) {
      if (!record.names.includes(record.frame)) {
        failures.push(`${where} 期望 ${record.frame}，实际 ${JSON.stringify(record.names)}`);
      }
      continue;
    }
    misses.push({
      page: record.page,
      width: record.width,
      selector: record.selector,
      optional: record.optional === true,
      reason: record.present ? "element-present-but-no-animation" : "element-not-rendered",
    });
    if (record.optional === true) continue;
    if (record.present) {
      failures.push(`${where} 元素已渲染但 animationName 为 none（期望 ${record.frame}）`);
    } else {
      failures.push(
        `${where} 在该 page × width 未渲染（选择器漂了、元素被删或动画没挂上）` +
          `—— 未标 optional 的期望不允许「没采到就放行」`,
      );
    }
  }
  return { failures, misses };
}


const NEGATIVE_PROBE_FRAME = "avKfAuditMissingFrame";

/**
 * 页内扫描：收集 @keyframes 名 → 逐个 animated 元素（含伪元素）比对。
 * 返回未解析清单、解析成功计数、以及 @keyframes 名字集合（便于排查漏收样式表）。
 */
const SCAN_FN = `(() => {
  const keyframes = new Set();
  const walk = (rules) => {
    for (const rule of Array.from(rules ?? [])) {
      if (rule.type === CSSRule.KEYFRAMES_RULE) keyframes.add(rule.name);
      else if (rule.cssRules) walk(rule.cssRules);
    }
  };
  for (const sheet of Array.from(document.styleSheets)) {
    try { walk(sheet.cssRules); } catch { /* 跨域样式表：本站没有，忽略 */ }
  }
  for (const sheet of Array.from(document.adoptedStyleSheets ?? [])) {
    try { walk(sheet.cssRules); } catch { /* 同上 */ }
  }

  const describe = (el) => {
    const cls = typeof el.className === "string" ? el.className : "";
    return cls ? el.tagName.toLowerCase() + "." + cls.trim().split(/\\s+/).join(".") : el.tagName.toLowerCase();
  };

  const unresolved = [];
  const seenUnresolved = new Set();
  let animated = 0;
  let resolved = 0;

  const inspect = (el, pseudo) => {
    const style = getComputedStyle(el, pseudo || null);
    const raw = style.animationName;
    if (!raw || raw === "none") return;
    for (const name of raw.split(",").map((item) => item.trim())) {
      if (!name || name === "none") continue;
      animated += 1;
      if (keyframes.has(name)) {
        resolved += 1;
        continue;
      }
      const where = describe(el) + (pseudo || "");
      const key = where + "|" + name;
      if (seenUnresolved.has(key)) continue;
      seenUnresolved.add(key);
      unresolved.push({
        name,
        where,
        pseudo: pseudo || null,
        // 名字带下划线与 __ 哈希 = CSS Modules 本地化后残留的典型指纹
        localized: /_[^_]+__[A-Za-z0-9-]+$/.test(name),
      });
    }
  };

  for (const el of Array.from(document.querySelectorAll("*"))) {
    inspect(el, "");
    inspect(el, "::before");
    inspect(el, "::after");
    inspect(el, "::backdrop");
  }

  return {
    keyframes: Array.from(keyframes).sort(),
    animated,
    resolved,
    unresolved,
  };
})`;

/** 直接求值用的扫描表达式（负向自检里要拿到函数本身复用同一份口径）。 */
const SCAN = `${SCAN_FN}()`;

/**
 * 期望值抽样：导航后连续轮询，取元素**第一次出现时**的计算 animationName。
 *
 * 为什么必须轮询：骨架屏只活在水合完成到换上真数据之间，热力脉冲只亮一次 ——
 * 等到页面稳定（3s 后）再查，这两处永远是「元素不存在」，等于没有证据。
 */
function pollExpectations(expectations, budgetMs = 8000) {
  const items = expectations.map((item) => ({
    selector: item.selector,
    pseudo: item.pseudo ?? "",
    frame: item.frame,
    action: item.action ?? "",
  }));
  return `(async () => {
    const items = ${JSON.stringify(items)};
    // 瞬时状态要先制造出来：骨架屏只在「加载下一页」的等待窗口里挂载
    for (const item of items) {
      if (item.action !== "click-load-more") continue;
      const trigger = Array.from(document.querySelectorAll("button")).find((button) =>
        (button.textContent || "").includes("加载下一页"),
      );
      if (trigger) trigger.click();
    }
    const hits = items.map(() => null);
    // 元素是否出现过要单独记：出现但 animationName 一直是 none，和根本没渲染是两回事
    const seen = items.map(() => false);
    const deadline = performance.now() + ${budgetMs};
    while (performance.now() < deadline) {
      let pending = false;
      for (let index = 0; index < items.length; index += 1) {
        if (hits[index]) continue;
        const item = items[index];
        const el = document.querySelector(item.selector);
        if (!el) {
          pending = true;
          continue;
        }
        seen[index] = true;
        const style = getComputedStyle(el, item.pseudo || null);
        const names = (style.animationName || "").split(",").map((value) => value.trim());
        if (names.some((name) => name && name !== "none")) {
          hits[index] = names;
          continue;
        }
        pending = true;
      }
      if (!pending) break;
      await new Promise((done) => setTimeout(done, 120));
    }
    return items.map((item, index) => ({ names: hits[index], found: seen[index], frame: item.frame }));
  })()`;
}

const port = 9800 + Math.floor(Math.random() * 150);
const chrome = spawn(
  chromePath,
  [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${resolve(tmpdir(), `av-keyframes-audit-${port}`)}`,
    "--window-size=1440,1200",
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
  return new Promise((resolvePromise, rejectPromise) =>
    pending.set(id, { resolve: resolvePromise, reject: rejectPromise }),
  );
}

async function evaluate(expression) {
  const result = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}

const report = {
  baseUrl,
  mode: breakExpectation ? "negative-expectation-probe" : "normal",
  widths: WIDTHS,
  pages: PAGES,
  negativeSelfCheck: null,
  expectationGateSelfCheck: null,
  runs: [],
  expectations: [],
  expectationMisses: [],
  staticFreeze: [],
  reducedMotion: [],
  failures: [],
};

try {
  for (let index = 0; index < 60; index += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) break;
    } catch {
      // Chrome 还没起来
    }
    await sleep(200);
  }
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolvePromise, rejectPromise) => {
    ws.onopen = resolvePromise;
    ws.onerror = rejectPromise;
  });
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const entry = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
    else entry.resolve(message.result);
  };

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Network.enable");

  /**
   * 骨架屏的加载窗口在本机（mock 数据已经在内存里）可能只有几毫秒，采样采不到。
   * 给「需要制造加载态」的页面加一层延迟（600ms），让等待窗口足够被轮询捕捉 ——
   * 这不是伪造效果：骨架屏本来就只在真实加载期间存在。
   */
  const throttle = async (latencyMs) => {
    await send("Network.emulateNetworkConditions", {
      offline: false,
      latency: latencyMs,
      downloadThroughput: latencyMs > 0 ? (1.5 * 1024 * 1024) / 8 : -1,
      uploadThroughput: latencyMs > 0 ? (750 * 1024) / 8 : -1,
    });
  };
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 1200,
    deviceScaleFactor: 1,
    mobile: false,
  });

  // ---- 负向自检：插一个指向不存在帧名的元素，扫描必须报出来 ----
  await send("Page.navigate", { url: `${baseUrl}/stream-monitor/overview` });
  await sleep(3200);
  const negative = await evaluate(`(async () => {
    const probe = document.createElement("div");
    probe.id = "__av_kf_negative_probe";
    probe.style.cssText =
      "position:fixed;left:-9999px;top:0;width:2px;height:2px;animation:${NEGATIVE_PROBE_FRAME} 1s linear 1";
    document.body.appendChild(probe);
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    const computed = getComputedStyle(probe).animationName;
    const scan = ${SCAN_FN};
    const withProbe = scan();
    probe.remove();
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    const withoutProbe = scan();
    return { computed, withProbe, withoutProbe };
  })()`);

  const caught = negative.withProbe.unresolved.filter((item) => item.name === NEGATIVE_PROBE_FRAME);
  const negativeOk =
    negative.computed === NEGATIVE_PROBE_FRAME &&
    caught.length === 1 &&
    !negative.withoutProbe.unresolved.some((item) => item.name === NEGATIVE_PROBE_FRAME);
  report.negativeSelfCheck = {
    ok: negativeOk,
    probeFrame: NEGATIVE_PROBE_FRAME,
    computedAnimationName: negative.computed,
    caught: caught.length,
    leftoverAfterRemove: negative.withoutProbe.unresolved.filter(
      (item) => item.name === NEGATIVE_PROBE_FRAME,
    ).length,
  };
  if (!negativeOk) {
    report.failures.push(
      `负向自检未通过：插入 ${NEGATIVE_PROBE_FRAME} 后扫描没有稳定报出 1 条 —— 扫描口径坏了，本次结果不可信`,
    );
  }

  // ---- 正式统计：7 页 × 2 档 ----
  for (const width of WIDTHS) {
    for (const page of PAGES) {
      await send("Emulation.setDeviceMetricsOverride", {
        width,
        height: width <= 390 ? 844 : 1200,
        deviceScaleFactor: 1,
        mobile: width <= 390,
      });
      // 不带 ?static=1：静态档整段 animation: none，比对不出任何东西
      await send("Page.navigate", { url: `${baseUrl}/stream-monitor/${page}` });
      const pageExpectations = ACTIVE_EXPECTATIONS.filter((item) => item.page === page);
      const needsLoadingWindow = pageExpectations.some((item) => item.action === "click-load-more");
      if (needsLoadingWindow) await throttle(600);
      // 导航后立刻开始轮询（瞬时节点），轮询结束后再等页面稳定做全量扫描
      await sleep(350);
      const polled = pageExpectations.length > 0 ? await evaluate(pollExpectations(pageExpectations)) : [];
      if (needsLoadingWindow) await throttle(0);
      await sleep(2600);
      const scan = await evaluate(SCAN);
      // 「真的在播」而不是「只是写了 animation」：同一批动画对象隔 160ms 再采一次，
      // currentTime 必须往前走（停在首帧 = 本次修复前的失效态）。
      const progress = JSON.parse(
        await evaluate(`(async () => {
          const take = () =>
            Array.from(document.getAnimations()).map((animation) => ({
              name: animation.animationName,
              playState: animation.playState,
              time: animation.currentTime == null ? null : Math.round(animation.currentTime),
            }));
          const before = take();
          await new Promise((done) => setTimeout(done, 160));
          const after = take();
          let progressed = 0;
          for (let index = 0; index < Math.min(before.length, after.length); index += 1) {
            const a = before[index];
            const b = after[index];
            if (a.name === b.name && a.time !== null && b.time !== null && a.time !== b.time) progressed += 1;
          }
          return JSON.stringify({
            sampled: after.length,
            running: after.filter((item) => item.playState === "running").length,
            progressed,
          });
        })()`),
      );
      report.runs.push({
        page,
        width,
        keyframes: scan.keyframes.length,
        animated: scan.animated,
        resolved: scan.resolved,
        unresolved: scan.unresolved,
        ...progress,
      });
      if (scan.unresolved.length > 0) {
        for (const item of scan.unresolved) {
          report.failures.push(
            `${page} ${width}px：${item.where} 的 animation-name \`${item.name}\` 在样式表里找不到 @keyframes`,
          );
        }
      }
      process.stdout.write(
        `${page} ${width}px：动画节点 ${scan.animated}、已解析 ${scan.resolved}、未解析 ${scan.unresolved.length}、` +
          `在推进 ${progress.progressed}/${progress.sampled}\n`,
      );

      pageExpectations.forEach((expectation, index) => {
        const polledItem = polled[index] ?? {};
        const names = polledItem.names ?? null;
        report.expectations.push({
          page,
          width,
          selector: expectation.selector,
          pseudo: expectation.pseudo ?? null,
          frame: expectation.frame,
          optional: expectation.optional === true,
          // present = 采样窗口内元素是否出现过；names = 首次采到的 animationName
          present: polledItem.found === true,
          names,
          ok: names === null ? null : names.includes(expectation.frame),
        });
      });
      // 逐 page × width 记账：没渲染 / 没有动画 / 帧名不符都进 failures，
      // 不再依赖「8 项全丢」或跨宽度的 some() 兜底。
      const pageGate = judgeExpectations(
        report.expectations.filter((entry) => entry.page === page && entry.width === width),
      );
      report.failures.push(...pageGate.failures);
      if (pageGate.failures.length > 0) {
        process.stdout.write(`${page} ${width}px：期望门禁 ${pageGate.failures.length} 条失败\n`);
      }
    }
  }

  // ---- ?static=1：每页连拍 3 次，MD5 必须一致（时长归零 + animation: none） ----
  for (const width of WIDTHS) {
    await send("Emulation.setDeviceMetricsOverride", {
      width,
      height: width <= 390 ? 844 : 1200,
      deviceScaleFactor: 1,
      mobile: width <= 390,
    });
    for (const page of PAGES) {
      await send("Page.navigate", { url: `${baseUrl}/stream-monitor/${page}?static=1` });
      await sleep(2600);
      const hashes = [];
      for (let round = 0; round < 3; round += 1) {
        const shot = await send("Page.captureScreenshot", { format: "png" });
        hashes.push(createHash("md5").update(Buffer.from(shot.data, "base64")).digest("hex"));
        await sleep(600);
      }
      const info = JSON.parse(
        await evaluate(`(() => {
          const nodes = Array.from(document.querySelectorAll('[data-motion-node], [class*="panel"], [class*="sceneCard"]'));
          return JSON.stringify({
            nodes: nodes.length,
            invisible: nodes.filter((el) => Number(getComputedStyle(el).opacity) < 0.99).length,
            animations: document.getAnimations().length,
            motion: document.documentElement.getAttribute("data-av-motion"),
          });
        })()`),
      );
      const identical = new Set(hashes).size === 1;
      report.staticFreeze.push({ page, width, identical, hashes, ...info });
      if (!identical) {
        report.failures.push(`${page} ${width}px ?static=1：3 连拍 MD5 不一致（静态档没冻结住）`);
      }
      if (info.animations > 0) {
        report.failures.push(`${page} ${width}px ?static=1：仍有 ${info.animations} 条动画在跑（应为 0）`);
      }
      if (info.invisible > 0) {
        report.failures.push(
          `${page} ${width}px ?static=1：${info.invisible}/${info.nodes} 个面板 opacity < 0.99（from { opacity: 0 } 卡住了）`,
        );
      }
      process.stdout.write(`static ${page} ${width}px：3 连拍一致=${identical}、在跑动画=${info.animations}、半透明面板=${info.invisible}\n`);
    }
  }

  // ---- prefers-reduced-motion: reduce：必须完全冻结且不露空白面板 ----
  await send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  for (const width of WIDTHS) {
    await send("Emulation.setDeviceMetricsOverride", {
      width,
      height: width <= 390 ? 844 : 1200,
      deviceScaleFactor: 1,
      mobile: width <= 390,
    });
    for (const page of PAGES) {
      await send("Page.navigate", { url: `${baseUrl}/stream-monitor/${page}` });
      await sleep(2400);
      const info = JSON.parse(
        await evaluate(`(() => {
          const nodes = Array.from(document.querySelectorAll('[data-motion-node], [class*="panel"], [class*="sceneCard"]'));
          return JSON.stringify({
            nodes: nodes.length,
            running: document.getAnimations().filter((a) => a.playState === "running").length,
            all: document.getAnimations().length,
            invisible: nodes.filter((el) => Number(getComputedStyle(el).opacity) < 0.99).length,
          });
        })()`),
      );
      report.reducedMotion.push({ page, width, ...info });
      if (info.running > 0) {
        report.failures.push(`${page} ${width}px prefers-reduced-motion：${info.running} 条动画仍在跑（应为 0）`);
      }
      if (info.invisible > 0) {
        report.failures.push(
          `${page} ${width}px prefers-reduced-motion：${info.invisible}/${info.nodes} 个面板不可见（动画被关掉后停在首帧）`,
        );
      }
      process.stdout.write(`reduce ${page} ${width}px：在跑动画=${info.running}、半透明面板=${info.invisible}\n`);
    }
  }
  await send("Emulation.setEmulatedMedia", { features: [] });

  // 「0 条未解析」不能是恒真：确认整轮真的扫到了动画节点
  const totalAnimated = report.runs.reduce((sum, run) => sum + run.animated, 0);
  if (totalAnimated === 0) {
    report.failures.push("整轮没有扫到任何 animated 节点 —— 选择器或页面加载有问题，0 条未解析没有意义");
  }
  // 整轮必须至少有一条动画的 currentTime 在推进：否则「都解析到了」也可能只是静态写对了
  const totalProgressed = report.runs.reduce((sum, run) => sum + (run.progressed ?? 0), 0);
  if (totalProgressed === 0) {
    report.failures.push("整轮没有任何动画的 currentTime 在推进 —— 动画没有真的在播，结果不可信");
  }

  // ---- 期望门禁的负向自检（不额外跑一轮浏览器，复用同一份判定逻辑） ----
  // 把一条真实采样改成「选择器漂了」的样子（names: null / present: false），
  // 门禁必须报出它；再把同一条标成 optional，必须不再算失败。
  // 这一步专门证明「元素没渲染不会被静默放行」，而不是靠 matched.length === 0 兜底。
  {
    const target =
      report.expectations.find(
        (item) =>
          item.optional !== true &&
          item.names !== null &&
          item.selector !== BROKEN_EXPECTATION_SELECTOR,
      ) ??
      report.expectations.find(
        (item) => item.optional !== true && item.selector !== BROKEN_EXPECTATION_SELECTOR,
      ) ??
      null;
    if (target === null) {
      report.expectationGateSelfCheck = { ok: false, reason: "没有可用的真实期望采样" };
      report.failures.push("期望门禁自检无法执行：没有任何真实期望采样");
    } else {
      const drifted = {
        ...target,
        selector: BROKEN_EXPECTATION_SELECTOR,
        present: false,
        names: null,
        optional: false,
        ok: null,
      };
      // 用「干净的」真实采样 + 一条漂移项自检；负向模式（--break-expectation）下
      // 正式采样里已经有同选择器的失败，先剔掉，保证自检自己只该多出 1 条。
      const cleanRecords = report.expectations.filter(
        (item) => item.selector !== BROKEN_EXPECTATION_SELECTOR,
      );
      const probe = judgeExpectations([...cleanRecords, drifted]);
      const caught = probe.failures.filter((text) => text.includes(BROKEN_EXPECTATION_SELECTOR));
      const optionalProbe = judgeExpectations([{ ...drifted, optional: true }]);
      const ok = caught.length === 1 && optionalProbe.failures.length === 0;
      report.expectationGateSelfCheck = {
        ok,
        probeSelector: BROKEN_EXPECTATION_SELECTOR,
        mirroredFrom: { page: target.page, width: target.width, selector: target.selector },
        caught: caught.length,
        failureText: caught[0] ?? null,
        optionalTreatedAsFailure: optionalProbe.failures.length,
      };
      if (!ok) {
        report.failures.push(
          `期望门禁自检未通过：选择器改成不存在后 failures=${caught.length}（应为 1），` +
            `标 optional 后 failures=${optionalProbe.failures.length}（应为 0）—— 门禁可能是恒真`,
        );
      }
    }
  }

  // 期望值至少要命中一次，证明「修好之后真的开始播」这条正向证据真的取到了
  const finalGate = judgeExpectations(report.expectations);
  report.expectationHits = report.expectations.filter(
    (item) => item.names !== null && item.names.includes(item.frame),
  ).length;
  // miss 按 page × width × 选择器逐条记（不再用跨宽度的 some() 一笔勾销）
  report.expectationMisses = finalGate.misses;
  report.expectationOptionalMisses = finalGate.misses.filter((item) => item.optional).length;
  if (report.expectationHits === 0) {
    report.failures.push("EXPECTATIONS 一条都没命中（元素均未渲染）—— 正向证据缺失");
  }

  report.pass = report.failures.length === 0;
  mkdirSync(outDir, { recursive: true });
  writeFileSync(`${outDir}/av-keyframes-audit.json`, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    JSON.stringify(
      {
        mode: report.mode,
        pass: report.pass,
        negativeSelfCheck: report.negativeSelfCheck,
        expectationGateSelfCheck: report.expectationGateSelfCheck,
        totalAnimated,
        totalProgressed: report.runs.reduce((sum, run) => sum + (run.progressed ?? 0), 0),
        unresolved: report.runs.reduce((sum, run) => sum + run.unresolved.length, 0),
        staticFreezeIdentical: report.staticFreeze.filter((item) => item.identical).length,
        staticFreezeTotal: report.staticFreeze.length,
        reducedMotionFrozen: report.reducedMotion.filter((item) => item.running === 0).length,
        reducedMotionTotal: report.reducedMotion.length,
        expectationHits: report.expectationHits,
        expectationTotal: report.expectations.length,
        expectationMisses: report.expectationMisses,
        failures: report.failures,
      },
      null,
      2,
    ),
  );
  if (breakExpectation) {
    console.log(
      report.pass
        ? "负向自检模式：期望门禁没有失败 —— 门禁恒真，本次结果不可信"
        : "负向自检模式：期望门禁按预期失败（见上面 failures）",
    );
  }
  if (!report.pass) process.exitCode = 1;
} finally {
  try {
    ws?.close();
  } catch {
    // 关闭失败不影响结果
  }
  chrome.kill("SIGTERM");
}
