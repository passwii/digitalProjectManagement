// 逐帧验收脚本（BLF-1433）：为 8 个代表性动画取「真的在播」的证据。
//
// 用法：node scripts/av-keyframes-evidence.mjs http://127.0.0.1:3001
// 前提：web 已 `npm run dev`；本机有 Chrome（CHROME_PATH 可覆盖）。
// 产物：artifacts/blf1433/*.png（逐帧截图）+ observations.json（动画事件 / currentTime 轨迹）。
//
// 三条证据链，互不替代：
//   ① animationstart 事件表 —— 页面真实加载/交互过程中，浏览器确实为这些帧名派发了动画事件；
//   ② el.getAnimations() 的 currentTime 轨迹 —— 动画在推进，不是停在首帧（这是本次修复的核心）；
//   ③ 逐帧截图 —— 画面真的在变（入场类用「暂停 → currentTime=0 → 放行」重放后抓帧，
//      否则 300ms 的入场在截图往返（每次 ~60–100ms）里早就播完了）。
//
// 产物：artifacts/blf1433/*.png + observations.json
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const base = (process.argv[2] ?? "http://127.0.0.1:3001").replace(/\/$/, "");
const chromePath = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const outDir = resolve(process.cwd(), "artifacts/blf1433");
mkdirSync(outDir, { recursive: true });
const port = 9338;

const chrome = spawn(
  chromePath,
  [
    "--headless=new",
    "--hide-scrollbars",
    "--disable-gpu",
    `--remote-debugging-port=${port}`,
    "--user-data-dir=/tmp/av-evidence-1433",
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
  return new Promise((resolve2, reject) => pending.set(id, { resolve: resolve2, reject }));
}

async function evaluate(expression) {
  const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}

/** 在每个新文档里记录 animationstart（含伪元素），作为「真的开始播」的事件级证据。 */
const ANIMATION_EVENT_RECORDER = `
  window.__avAnimationEvents = [];
  document.addEventListener("animationstart", (event) => {
    const target = event.target;
    const cls = target && typeof target.className === "string" ? target.className : "";
    window.__avAnimationEvents.push({
      name: event.animationName,
      pseudo: event.pseudoElement || null,
      target: (target && target.tagName ? target.tagName.toLowerCase() : "") + (cls ? "." + cls.split(/\\s+/).slice(0, 2).join(".") : ""),
    });
  }, true);
`;

async function navigate(path) {
  await send("Page.navigate", { url: `${base}${path}` });
  for (let i = 0; i < 100; i += 1) {
    if ((await evaluate("document.readyState")) === "complete") break;
    await sleep(100);
  }
  await evaluate("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))");
  await sleep(300);
}

async function animationEvents() {
  const raw = await evaluate("JSON.stringify(window.__avAnimationEvents ?? [])");
  return JSON.parse(raw);
}

function distinctNames(events) {
  return Array.from(new Set(events.map((event) => `${event.name}${event.pseudo ?? ""}`))).sort();
}

async function rect(selector) {
  const raw = await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return "null";
    const r = el.getBoundingClientRect();
    return JSON.stringify({ x: Math.max(0, r.x), y: Math.max(0, r.y), width: Math.min(r.width, innerWidth - Math.max(0, r.x)), height: Math.min(r.height, innerHeight - Math.max(0, r.y)) });
  })()`);
  return raw === "null" ? null : JSON.parse(raw);
}

async function shot(name, clip) {
  const params = { format: "png" };
  if (clip && clip.width > 4 && clip.height > 4) params.clip = { ...clip, scale: 1 };
  const result = await send("Page.captureScreenshot", params);
  const buffer = Buffer.from(result.data, "base64");
  writeFileSync(`${outDir}/${name}.png`, buffer);
  return { file: `artifacts/blf1433/${name}.png`, md5: createHash("md5").update(buffer).digest("hex") };
}

async function slowDown(frames, rate = 0.08) {
  return evaluate(`(() => {
    const names = ${JSON.stringify(frames)};
    const hit = document.getAnimations().filter((a) => names.includes(a.animationName));
    for (const a of hit) a.updatePlaybackRate(${rate});
    return hit.length;
  })()`);
}

async function restoreSpeed() {
  return evaluate("document.getAnimations().forEach((a) => a.updatePlaybackRate(1)), document.getAnimations().length");
}

async function resume() {
  return evaluate("document.getAnimations().forEach((a) => a.play()), document.getAnimations().length");
}

/**
 * 把子树里的动画暂停并定位到指定时刻，用于逐帧重放截图。
 * 先前的 animationstart + currentTime 轨迹已经证明「真的在播」，这里只是把
 * 300–600ms 的入场过程拉到可截图的时间尺度上（否则截图往返就把它跳过去了）。
 */
async function stepTo(selector, milliseconds) {
  return evaluate(`(() => {
    const root = document.querySelector(${JSON.stringify(selector)});
    if (!root) return -1;
    const list = Array.from(root.getAnimations({ subtree: true }));
    for (const a of list) { a.pause(); a.currentTime = ${milliseconds}; }
    return list.length;
  })()`);
}

/**
 * 在文档创建时就给「目标元素」挂上 animation-play-state: paused。
 * 这样入场动画（avRiseIn / avWipeUp / avSkeleton…）在真实加载时被创建但停在 0 帧，
 * 逐帧截图才有意义；页面级的 pageIn 不受影响（否则整页全透明拍不到东西）。
 */
async function navigatePausing(path, selectors) {
  const rule = `${selectors.join(", ")} { animation-play-state: paused !important; }`;
  // document_start 时 <html> 可能还不存在，直接 appendChild 会抛错 → 用 MutationObserver 等根节点。
  const source = `(() => {
    const inject = () => {
      if (document.getElementById("av-evidence-pause-targets")) return true;
      const style = document.createElement("style");
      style.id = "av-evidence-pause-targets";
      style.textContent = ${JSON.stringify(rule)};
      (document.head || document.documentElement).appendChild(style);
      return true;
    };
    if (document.documentElement) { inject(); return; }
    const observer = new MutationObserver(() => {
      if (document.documentElement) { inject(); observer.disconnect(); }
    });
    observer.observe(document, { childList: true, subtree: true });
  })();`;
  const { identifier } = await send("Page.addScriptToEvaluateOnNewDocument", { source });
  await navigate(path);
  return identifier;
}

async function releasePaused(identifier) {
  await send("Page.removeScriptToEvaluateOnNewDocument", { identifier });
  await evaluate('document.getElementById("av-evidence-pause-targets")?.remove()');
}

async function sampleAnimations(selector, { frames = 3, gapMs = 60, subtree = true } = {}) {
  const raw = await evaluate(`(async () => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return JSON.stringify({ error: "no element" });
    const samples = [];
    for (let i = 0; i < ${frames}; i += 1) {
      samples.push(Array.from(el.getAnimations({ subtree: ${subtree} })).map((a) => ({
        name: a.animationName,
        pseudo: (a.effect && a.effect.pseudoElement) || null,
        playState: a.playState,
        currentTime: a.currentTime == null ? null : Math.round(a.currentTime),
      })));
      await new Promise((r) => setTimeout(r, ${gapMs}));
    }
    return JSON.stringify(samples);
  })()`);
  return JSON.parse(raw);
}

/** 同一帧名在多次采样里的 currentTime 是否真的推进（= 不是停在首帧）。 */
function progression(samples) {
  if (!Array.isArray(samples)) return [{ animation: "n/a", currentTimes: [], advancing: false }];
  const byName = new Map();
  for (const frame of samples) {
    for (const animation of frame) {
      const key = `${animation.name}${animation.pseudo ?? ""}`;
      if (!byName.has(key)) byName.set(key, []);
      byName.get(key).push(animation.currentTime);
    }
  }
  return Array.from(byName.entries()).map(([key, times]) => ({
    animation: key,
    currentTimes: times,
    advancing: times.filter((t) => t != null).length > 1 && times[times.length - 1] !== times[0],
  }));
}

const evidence = [];
function record(entry) {
  evidence.push(entry);
  const summary = entry.animations.map((a) => `${a.animation}${a.advancing ? "✓" : "·"}`).join(" ") || "—";
  const distinct = entry.shots ? `${new Set(entry.shots.map((s) => s.md5)).size}/${entry.shots.length} 帧不同` : "";
  console.log(`- ${entry.scenario}: ${summary} ${distinct}`);
}

try {
  for (let i = 0; i < 100; i += 1) {
    try {
      await fetch(`http://127.0.0.1:${port}/json/version`);
      break;
    } catch {
      if (i === 99) throw new Error("Chrome 没起来");
      await sleep(200);
    }
  }
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve2, reject) => {
    ws.onopen = resolve2;
    ws.onerror = reject;
  });
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve: resolve2, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve2(message.result);
    }
  };
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Network.enable");
  await send("Page.addScriptToEvaluateOnNewDocument", { source: ANIMATION_EVENT_RECORDER });
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1400, deviceScaleFactor: 1, mobile: false });

  // ---- 1. overview 切时间范围：.rangeBody / .rangeChart ----
  await navigate("/stream-monitor/overview");
  const rangeLoadEvents = await animationEvents();
  const rangeClip = await rect('[class*="rangeBody"]');
  const tabs = JSON.parse(
    await evaluate(`JSON.stringify(Array.from(document.querySelectorAll('[role="group"][aria-label="时间范围"] button')).map((b) => b.textContent.trim()))`),
  );
  const rangeClick = await evaluate(`(() => {
    const buttons = Array.from(document.querySelectorAll('[role="group"][aria-label="时间范围"] button'));
    const target = buttons.find((b) => b.getAttribute('aria-pressed') !== 'true');
    if (!target) return "no inactive tab";
    target.click();
    return target.textContent.trim();
  })()`);
  await slowDown(["avRangeSwap", "avFadeIn"], 0.05);
  const rangeShots = [];
  for (let i = 0; i < 3; i += 1) {
    rangeShots.push(await shot(`range-swap-${i + 1}`, rangeClip && { ...rangeClip, height: Math.min(rangeClip.height, 520) }));
    await sleep(120);
  }
  await restoreSpeed();
  const rangeSamples = await sampleAnimations('[class*="rangeBody"]', { frames: 3, gapMs: 50, subtree: false });
  const rangeEvents = await animationEvents();
  record({
    scenario: "overview 切时间范围（avRangeSwap 整块上浮淡入 + avFadeIn 图表容器）",
    tabs,
    clicked: rangeClick,
    loadEventNames: distinctNames(rangeLoadEvents),
    eventNames: distinctNames(rangeEvents),
    animations: progression(rangeSamples),
    shots: rangeShots,
  });

  // ---- 2. 一级告警呼吸：.levelBadge[data-level="1"] .levelSwatch ----
  await navigate("/stream-monitor/alarm");
  const alarmLoadEvents = await animationEvents();
  const breatheSelector = '[class*="levelBadge"][data-level="1"] [class*="levelSwatch"]';
  const breatheOk = await evaluate(`!!document.querySelector(${JSON.stringify(breatheSelector)})`);
  const badgeClip = await rect('[class*="levelBadge"][data-level="1"]');
  const breatheSamples = await sampleAnimations(breatheSelector, { frames: 4, gapMs: 400, subtree: false });
  await slowDown(["avBreathe"], 0.25);
  const breatheShots = [];
  for (let i = 0; i < 3; i += 1) {
    breatheShots.push(await shot(`breathe-${i + 1}`, badgeClip && { ...badgeClip, width: Math.max(badgeClip.width, 130) }));
    await sleep(350);
  }
  await restoreSpeed();
  record({
    scenario: '一级告警色条呼吸（avBreathe，data-level="1"，全站唯一持续循环）',
    found: breatheOk,
    loadEventNames: distinctNames(alarmLoadEvents),
    animations: progression(breatheSamples),
    shots: breatheShots,
  });

  // ---- 3. 骨架屏高光：.skeleton（把网络延迟拉高，让 loading 态真的露出来） ----
  await send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 1500,
    downloadThroughput: 200 * 1024,
    uploadThroughput: 200 * 1024,
  });
  const nextButton = await evaluate(`(() => {
    const button = Array.from(document.querySelectorAll('button')).find((b) => b.textContent.includes('加载下一页'));
    if (!button) return "missing";
    button.click();
    return "clicked";
  })()`);
  let skeletonSelector = null;
  for (let i = 0; i < 40; i += 1) {
    const found = await evaluate(`(() => {
      const el = document.querySelector('[class*="skeleton"]');
      if (!el) return "";
      return el.className.match(/[A-Za-z]*skeleton[A-Za-z]*/i)?.[0] ?? "";
    })()`);
    if (found) {
      skeletonSelector = `[class*="${found}"]`;
      break;
    }
    await sleep(50);
  }
  const skeletonSamples = skeletonSelector
    ? await sampleAnimations(skeletonSelector, { frames: 3, gapMs: 120, subtree: false })
    : { error: "skeleton never appeared" };
  const skeletonClip = skeletonSelector ? await rect(skeletonSelector) : null;
  const skeletonShots = [];
  for (let i = 0; i < 3; i += 1) {
    skeletonShots.push(await shot(`skeleton-${i + 1}`, skeletonClip && { x: skeletonClip.x, y: skeletonClip.y, width: Math.min(skeletonClip.width, 900), height: Math.min(skeletonClip.height, 90) }));
    await sleep(180);
  }
  const skeletonEvents = (await animationEvents()).filter((event) => event.name === "avSkeleton");
  await send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  record({
    scenario: "骨架屏高光扫过（avSkeleton，alarm「加载下一页」的 loading 占位）",
    nextButton,
    skeletonSelector,
    skeletonStartEvents: skeletonEvents.length,
    animations: progression(skeletonSamples),
    shots: skeletonShots,
  });

  // ---- 4. event 时间线逐节点点亮：avRiseIn / avDotPop / avGrowY ----
  const timelinePause = await navigatePausing("/stream-monitor/event", ["[data-motion-node]"]);
  const timelinePauseCheck = await evaluate(`(() => {
    const el = document.querySelector("[data-motion-node]");
    return JSON.stringify({ styleInjected: !!document.getElementById("av-evidence-pause-targets"), playState: el ? getComputedStyle(el).animationPlayState : null, opacity: el ? getComputedStyle(el).opacity : null });
  })()`);
  const timelineInfo = JSON.parse(await evaluate(`(() => {
    const nodes = Array.from(document.querySelectorAll('[data-motion-node]'));
    return JSON.stringify({
      count: nodes.length,
      maxIndex: Math.max(...nodes.map((el) => Number(el.style.getPropertyValue('--av-i') || 0))),
      delays: nodes.map((el) => el.style.getPropertyValue('--av-i')),
    });
  })()`));
  const timelineClip = await rect('[class*="timeline"]');
  const timelineFrozen = await sampleAnimations("[data-motion-node]", { frames: 1, gapMs: 0, subtree: true });
  const timelineShots = [await shot("timeline-1", timelineClip && { ...timelineClip, height: Math.min(timelineClip.height, 560) })];
  await releasePaused(timelinePause);
  await sleep(120);
  const timelineSamples = await sampleAnimations("[data-motion-node]", { frames: 2, gapMs: 120, subtree: true });
  for (const [index, milliseconds] of [90, 260, 900].entries()) {
    await stepTo("[data-motion-node]", milliseconds);
    timelineShots.push(await shot(`timeline-${index + 2}`, timelineClip && { ...timelineClip, height: Math.min(timelineClip.height, 560) }));
  }
  await stepTo("[data-motion-node]", 3000);
  await sleep(200);
  const timelineLoadEvents = await animationEvents();
  const timelineSettled = JSON.parse(await evaluate(`(() => {
    const nodes = Array.from(document.querySelectorAll('[data-motion-node]'));
    return JSON.stringify({ count: nodes.length, minOpacity: Math.min(...nodes.map((el) => Number(getComputedStyle(el).opacity))) });
  })()`));
  record({
    scenario: "event 时间线逐节点点亮（avRiseIn + avDotPop + avGrowY，--av-i 错峰）",
    timeline: timelineInfo,
    frozenAnimations: timelineFrozen,
    pauseCheck: JSON.parse(timelinePauseCheck),
    loadEventNames: distinctNames(timelineLoadEvents),
    animations: progression(timelineSamples),
    settled: timelineSettled,
    shots: timelineShots,
  });

  // ---- 5. audio 频谱擦除：avWipeUp on ::after ----
  const audioPause = await navigatePausing("/stream-monitor/audio", ['[class*="spectroWrap"]::after']);
  const audioPauseCheck = await evaluate(`(() => {
    const el = document.querySelector('[class*="spectroWrap"]');
    return JSON.stringify({ styleInjected: !!document.getElementById("av-evidence-pause-targets"), playState: el ? getComputedStyle(el, "::after").animationPlayState : null, transform: el ? getComputedStyle(el, "::after").transform : null });
  })()`);
  const spectroClip = await rect('[class*="spectroWrap"]');
  const spectroFrozen = await sampleAnimations('[class*="spectroWrap"]', { frames: 1, gapMs: 0, subtree: true });
  const spectroShots = [await shot("audio-wipe-1", spectroClip)];
  await releasePaused(audioPause);
  await sleep(180);
  const spectroSamples = await sampleAnimations('[class*="spectroWrap"]', { frames: 2, gapMs: 150, subtree: true });
  for (const [index, milliseconds] of [120, 320, 640].entries()) {
    await stepTo('[class*="spectroWrap"]', milliseconds);
    spectroShots.push(await shot(`audio-wipe-${index + 2}`, spectroClip));
  }
  await stepTo('[class*="spectroWrap"]', 3000);
  await sleep(200);
  const audioLoadEvents = await animationEvents();
  record({
    scenario: "audio 频谱遮罩自下而上收走（avWipeUp，::after）",
    found: Boolean(spectroClip),
    frozenAnimations: spectroFrozen,
    pauseCheck: JSON.parse(audioPauseCheck),
    loadEventNames: distinctNames(audioLoadEvents),
    animations: progression(spectroSamples),
    shots: spectroShots,
  });

  // ---- 6. capability 场景卡 / 链路步骤错峰入场 ----
  const capabilityPause = await navigatePausing("/stream-monitor/capability", ['[class*="sceneCard"]', '[class*="chainStep"]']);
  const capabilityPauseCheck = await evaluate(`(() => {
    const el = document.querySelector('[class*="sceneCard"]');
    return JSON.stringify({ styleInjected: !!document.getElementById("av-evidence-pause-targets"), playState: el ? getComputedStyle(el).animationPlayState : null, opacity: el ? getComputedStyle(el).opacity : null });
  })()`);
  const sceneClip = await rect('[class*="sceneGrid"]');
  const sceneFrozen = await sampleAnimations('[class*="sceneGrid"]', { frames: 1, gapMs: 0, subtree: true });
  const sceneShots = [await shot("capability-in-1", sceneClip && { ...sceneClip, height: Math.min(sceneClip.height, 460) })];
  await releasePaused(capabilityPause);
  await sleep(30);
  const sceneSamples = await sampleAnimations('[class*="sceneGrid"]', { frames: 2, gapMs: 150, subtree: true });
  for (const [index, milliseconds] of [60, 200, 1200].entries()) {
    await stepTo('[class*="sceneCard"], [class*="chainStep"]', milliseconds);
    sceneShots.push(await shot(`capability-in-${index + 2}`, sceneClip && { ...sceneClip, height: Math.min(sceneClip.height, 460) }));
  }
  await stepTo('[class*="sceneCard"], [class*="chainStep"]', 3000);
  await sleep(200);
  const capabilityLoadEvents = await animationEvents();
  await sleep(600);
  const sceneSettled = JSON.parse(await evaluate(`(() => {
    const cards = Array.from(document.querySelectorAll('[class*="sceneCard"], [class*="chainStep"]'));
    return JSON.stringify({ count: cards.length, minOpacity: cards.length ? Math.min(...cards.map((el) => Number(getComputedStyle(el).opacity))) : null });
  })()`));
  record({
    scenario: "capability 场景卡 / 链路步骤错峰入场（avRiseIn，--av-i 由页面写入）",
    frozenAnimations: sceneFrozen,
    pauseCheck: JSON.parse(capabilityPauseCheck),
    loadEventNames: distinctNames(capabilityLoadEvents),
    animations: progression(sceneSamples),
    settled: sceneSettled,
    shots: sceneShots,
  });

  // ---- 7. 抽屉开合 + 遮罩 ----
  await navigate("/stream-monitor/alarm");
  const opened = await evaluate(`(() => {
    const card = document.querySelector('button[class*="alarmCard"]') ?? document.querySelector('[class*="alarmRow"] button');
    if (!card) return false;
    card.click();
    return true;
  })()`);
  await sleep(80);
  const drawerOpenAll = JSON.parse(await evaluate(`(() => {
    const dialog = document.querySelector('dialog[open]');
    if (!dialog) return JSON.stringify([]);
    return JSON.stringify(dialog.getAnimations({ subtree: true }).map((a) => ({ name: a.animationName, pseudo: (a.effect && a.effect.pseudoElement) || null, playState: a.playState, currentTime: a.currentTime == null ? null : Math.round(a.currentTime) })));
  })()`));
  const backdropAnimation = JSON.parse(await evaluate(`(() => {
    const dialog = document.querySelector('dialog[open]');
    if (!dialog) return JSON.stringify(null);
    const style = getComputedStyle(dialog, '::backdrop');
    return JSON.stringify({ animationName: style.animationName, animationDuration: style.animationDuration, opacity: style.opacity, background: style.backgroundColor });
  })()`));
  const drawerClip = await rect("dialog[open]");
  const drawerOpenShots = [];
  await slowDown(["avDrawerIn", "avFadeIn"], 0.08);
  for (let i = 0; i < 3; i += 1) {
    drawerOpenShots.push(await shot(`drawer-open-${i + 1}`, drawerClip && { ...drawerClip, height: Math.min(drawerClip.height, 420) }));
    await sleep(130);
  }
  await restoreSpeed();
  const closeInfo = await evaluate(`(() => {
    const dialog = document.querySelector('dialog[open]');
    const close = dialog && dialog.querySelector('button[aria-label="关闭告警详情"]');
    if (!close) return "no close button";
    close.click();
    return "clicked";
  })()`);
  await sleep(40);
  const drawerCloseAll = JSON.parse(await evaluate(`(() => {
    const dialog = document.querySelector('dialog');
    if (!dialog) return JSON.stringify([]);
    return JSON.stringify(dialog.getAnimations({ subtree: true }).map((a) => ({ name: a.animationName, pseudo: (a.effect && a.effect.pseudoElement) || null, playState: a.playState, currentTime: a.currentTime == null ? null : Math.round(a.currentTime) })));
  })()`));
  const drawerCloseShots = [];
  await slowDown(["avDrawerOut", "avFadeOut"], 0.12);
  for (let i = 0; i < 3; i += 1) {
    drawerCloseShots.push(await shot(`drawer-close-${i + 1}`, drawerClip && { ...drawerClip, height: Math.min(drawerClip.height, 420) }));
    await sleep(35);
  }
  await restoreSpeed();
  await sleep(700);
  const drawerClosed = await evaluate("!document.querySelector('dialog[open]')");
  record({
    scenario: "抽屉滑入 / 滑出 + 遮罩淡入淡出（avDrawerIn/Out、avFadeIn/Out、::backdrop）",
    opened,
    closeInfo,
    openAnimations: drawerOpenAll,
    closeAnimations: drawerCloseAll,
    backdropAnimation,
    closedAfter: drawerClosed,
    animations: drawerOpenAll.map((a) => ({
      animation: `${a.name}${a.pseudo ?? ""}`,
      currentTimes: [a.currentTime],
      advancing: a.playState === "running",
    })).concat(drawerCloseAll.map((a) => ({ animation: `${a.name}${a.pseudo ?? ""}`, currentTimes: [a.currentTime], advancing: a.playState === "running" }))),
    shots: drawerOpenShots.concat(drawerCloseShots),
  });

  // ---- 8. 顶栏时钟秒跳：.clockTick ----
  await navigate("/stream-monitor/overview");
  const clockClip = await rect('[aria-label^="当前时间"]');
  const clockTrace = JSON.parse(await evaluate(`(async () => {
    const sample = () => {
      const tick = document.querySelector('[class*="clockTick"]');
      if (!tick) return null;
      return {
        text: tick.textContent,
        opacity: Number(getComputedStyle(tick).opacity),
        animations: tick.getAnimations().map((a) => ({ name: a.animationName, currentTime: a.currentTime == null ? null : Math.round(a.currentTime), playState: a.playState })),
      };
    };
    const frames = [];
    const t0 = performance.now();
    while (performance.now() - t0 < 2600) {
      const sampleValue = sample();
      if (sampleValue) frames.push({ t: Math.round(performance.now() - t0), ...sampleValue });
      await new Promise((r) => requestAnimationFrame(r));
    }
    return JSON.stringify(frames);
  })()`));
  const clockShots = [];
  await slowDown(["avFadeIn"], 0.1);
  for (let i = 0; i < 3; i += 1) {
    clockShots.push(await shot(`clock-${i + 1}`, clockClip && { ...clockClip, width: Math.max(clockClip.width, 130) }));
    await sleep(100);
  }
  await restoreSpeed();
  const clockAnimations = clockTrace.flatMap((frame) => frame.animations).filter((a) => a.name === "avFadeIn");
  record({
    scenario: "顶栏时钟秒跳闪一帧（avFadeIn，.clockTick 每秒重挂载）",
    distinctSeconds: Array.from(new Set(clockTrace.map((frame) => frame.text))).length,
    opacityRange: [Math.min(...clockTrace.map((frame) => frame.opacity)), Math.max(...clockTrace.map((frame) => frame.opacity))],
    clockAnimations: clockAnimations.slice(0, 10),
    animations: [{ animation: "avFadeIn", currentTimes: clockAnimations.map((a) => a.currentTime), advancing: clockAnimations.some((a) => a.playState === "running") }],
    shots: clockShots,
  });

  // ---- 9. ?static=1 三连拍（每页 MD5 必须一致，且没有半透明面板） ----
  const pages = ["overview", "monitor", "alarm", "event", "device", "capability", "audio"];
  const staticResults = [];
  for (const page of pages) {
    await navigate(`/stream-monitor/${page}?static=1`);
    const hashes = [];
    for (let i = 0; i < 3; i += 1) {
      const result = await send("Page.captureScreenshot", { format: "png" });
      hashes.push(createHash("md5").update(Buffer.from(result.data, "base64")).digest("hex"));
      await sleep(700);
    }
    const info = JSON.parse(await evaluate(`(() => {
      const nodes = Array.from(document.querySelectorAll('[data-motion-node], [class*="panel"], [class*="sceneCard"]'));
      return JSON.stringify({
        invisible: nodes.filter((el) => Number(getComputedStyle(el).opacity) < 0.99).length,
        nodeCount: nodes.length,
        animations: document.getAnimations().length,
        motion: document.documentElement.getAttribute('data-av-motion'),
      });
    })()`));
    staticResults.push({ page, identical: new Set(hashes).size === 1, hashes, ...info });
    console.log(`  static ${page}: 3 连拍一致=${new Set(hashes).size === 1} 半透明节点=${info.invisible} 在跑动画=${info.animations} motion=${info.motion}`);
  }
  evidence.push({ scenario: "?static=1 三连拍 MD5 + 无半透明 / 空白面板", staticResults });

  // ---- 10. prefers-reduced-motion: reduce ----
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  const reducedResults = [];
  for (const page of pages) {
    await navigate(`/stream-monitor/${page}`);
    const info = JSON.parse(await evaluate(`(() => {
      const nodes = Array.from(document.querySelectorAll('[data-motion-node], [class*="panel"], [class*="sceneCard"]'));
      return JSON.stringify({
        runningAnimations: document.getAnimations().filter((a) => a.playState === 'running').length,
        allAnimations: document.getAnimations().length,
        invisible: nodes.filter((el) => Number(getComputedStyle(el).opacity) < 0.99).length,
        nodeCount: nodes.length,
      });
    })()`));
    reducedResults.push({ page, ...info });
    console.log(`  reduce ${page}: 在跑动画=${info.runningAnimations} 半透明节点=${info.invisible}`);
  }
  await send("Emulation.setEmulatedMedia", { features: [] });
  evidence.push({ scenario: "prefers-reduced-motion: reduce 下完全冻结", reducedResults });

  writeFileSync(`${outDir}/observations.json`, JSON.stringify(evidence, null, 2));
  console.log(`\n证据写入 ${outDir}`);
} finally {
  try {
    ws?.close();
  } catch {
    // ignore
  }
  chrome.kill("SIGTERM");
}
