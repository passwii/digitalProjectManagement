// /monitor 通道卡动效验收脚本（BLF-1425）。
//
// 覆盖验收标准里靠肉眼守不住的部分：
//   1. 9 张卡 = 2 视频 + 7 音频；7 张音频卡的波形 seed / 周期 / 相位互不相同；
//   2. 在线 LIVE 点真的在呼吸（computed animation-name ≠ none），离线卡是 none；
//   3. 视频卡有动态画面（检测框 / 扫描线 / ROI 的 animation-name 都在跑），
//      离线视频画面是冻结帧（噪点 / 扫描线都不动）；
//   4. 离线音频波形真的静态：每根柱子的 inline style 里没有 `--av-wave-delay`、
//      computed `animation-name` 为 none。这两条都带**负向自检**，防止选择器写错
//      导致「恒真误报」（BLF-1425 review P2：旧版查的是一个组件从不写入的 data 属性，永远得到 0）；
//   5. 动效开启时时间码每秒递增；`?static=1` 下不递增，连拍 3 次 MD5 一致；
//   6. 类型 tab 切换存在可观察的三段式过渡（0ms / ~120ms / ~500ms 各取一帧）。
//
// 用法：node scripts/av-monitor-motion.mjs [baseUrl] [outDir]
// 依赖本机 Chrome（可用 CHROME_PATH 覆盖），走 CDP，与 av-overview-ranges.mjs 同一套做法。
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";

const baseUrl = process.argv[2] ?? "http://127.0.0.1:3001";
const outDir = process.argv[3] ?? "artifacts/blf1425";
const chromePath = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const port = 9341;

mkdirSync(outDir, { recursive: true });

const chrome = spawn(
  chromePath,
  [
    "--headless=new",
    "--hide-scrollbars",
    `--remote-debugging-port=${port}`,
    "--user-data-dir=/tmp/av-monitor-profile",
    "--window-size=1440,1200",
    "about:blank",
  ],
  { stdio: "ignore" },
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
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

async function screenshot(file) {
  const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  const buffer = Buffer.from(shot.data, "base64");
  writeFileSync(`${outDir}/${file}`, buffer);
  return { file, md5: createHash("md5").update(buffer).digest("hex") };
}

/** 页面上的「事实」：卡片数、波形参数、LIVE / 视频动画、时间码。 */
const READ_STATE = `(() => {
  const page = document.querySelector('[data-av-page="monitor"]');
  const cards = Array.from(page.querySelectorAll('[data-motion="channel"]'));
  const waves = Array.from(page.querySelectorAll("[data-waveform]"));
  const live = page.querySelector('[data-live="on"] [data-live-clock]');
  const offlineBadge = page.querySelector('[data-live="off"]');
  const liveDot = page.querySelector('[data-live="on"] i');
  const offlineDot = page.querySelector('[data-live="off"] i');
  const video = page.querySelector("[data-video-seed]");
  const videoBox = video ? video.querySelector('[data-tone]') : null;
  const videoScan = video ? video.querySelector('[class*="videoScan"]') : null;
  const probe = (node) => (node ? getComputedStyle(node).animationName : null);
  const signature = (node) =>
    Array.from(node.querySelectorAll("[data-wave-bar]"))
      .map((bar) => bar.getAttribute("style"))
      .join("|");
  return {
    phase: page.querySelector("[data-filter-phase]")?.getAttribute("data-filter-phase") || "",
    audioCards: page.querySelector("[data-filter-phase]")?.getAttribute("data-audio-cards") || "",
    cards: cards.length,
    kinds: cards.map((card) => card.getAttribute("data-kind")),
    waveCount: waves.length,
    waveSeeds: waves.map((node) => node.getAttribute("data-wave-seed")),
    waveSpeeds: waves.map((node) => node.getAttribute("data-wave-speed")),
    wavePhases: waves.map((node) => node.getAttribute("data-wave-phase")),
    waveSignatures: waves.map(signature),
    /*
     * 离线波形：按**每根柱子的 inline style** 判定，而不是查某个 data 属性。
     * 旧版查的是一个组件从不写入的 data 属性，但 AvWaveform 把延迟写在 CSS 自定义属性
     * --av-wave-delay 上、离线柱根本不设这个属性 —— 选择器永远命中 0 个，
     * 与「离线真的静态」无关，任何回归都抓不到（review P2）。
     */
    offlineWaves: waves
      .filter((node) => node.getAttribute("data-state") === "offline")
      .map((node) => {
        const bars = Array.from(node.querySelectorAll("[data-wave-bar]"));
        return {
          bars: bars.length,
          withDelayVar: bars.filter((bar) => (bar.getAttribute("style") || "").includes("--av-wave-delay")).length,
          animated: bars.filter((bar) => getComputedStyle(bar).animationName !== "none").length,
        };
      }),
    // 真实页面没有离线视频通道时的兜底：如果以后数据里有了，也必须全静态
    offlineVideoScenes: Array.from(page.querySelectorAll('[data-video-seed][data-scene="offline"]')).map((node) => ({
      noise: probe(node.querySelector("[data-video-noise]")),
      scan: node.querySelectorAll('[class*="videoScan"]').length,
      boxes: node.querySelectorAll("[data-tone]").length,
    })),
    liveTimecode: live ? live.textContent : "",
    liveDotAnimation: probe(liveDot),
    offlineDotAnimation: probe(offlineDot),
    liveBadge: offlineBadge ? "has-offline-badge" : "no-offline-badge",
    videoScene: video ? video.getAttribute("data-scene") : "",
    videoBoxes: video ? video.querySelectorAll("[data-tone]").length : 0,
    videoBoxAnimation: probe(videoBox),
    videoScanAnimation: probe(videoScan),
    videoNoiseAnimation: probe(video ? video.querySelector("[data-video-noise]") : null),
    motionAttr: document.documentElement.getAttribute("data-av-motion"),
    // 退场过程中的实际视觉状态：卡片数量 + 第一张卡的透明度
    cardOpacity: cards.length ? getComputedStyle(cards[0]).opacity : "",
  };
})()`;

const OFFLINE_WAVE_SELF_TEST = `(() => {
  const bar = document.querySelector('[data-waveform][data-state="offline"] [data-wave-bar]');
  if (!bar) return { ok: false, reason: "no-offline-bar" };
  const before = bar.getAttribute("style") || "";
  bar.style.setProperty("--av-wave-delay", "0.500");
  const detected = (bar.getAttribute("style") || "").includes("--av-wave-delay");
  bar.setAttribute("style", before);
  return { ok: detected && (bar.getAttribute("style") || "") === before, detected };
})()`;

/**
 * 离线视频画面 = 冻结帧：把在线场景临时切到 `data-scene="offline"`，噪点的
 * computed `animation-name` 必须在**同一帧**变成 none，恢复后重新在动。
 *
 * 为什么不用页面上真实的离线视频卡：数据集里 18 路视频全是在线（只有音频有离线），
 * 真实 DOM 里找不到离线视频节点 —— 查不到就报 fail，不做「没有就跳过」的恒真检查。
 * 这条 probe 验证的是离线态的 CSS 契约，React 侧（离线不渲染扫描线 / 检测框、
 * 噪点换 `videoNoiseIdle`）由 `lib/av/monitorMotion.vitest.test.tsx` 守。
 */
const OFFLINE_SCENE_PROBE = `(() => {
  const scene = document.querySelector("[data-video-seed]");
  if (!scene) return { ok: false, reason: "no-video-scene" };
  if (scene.getAttribute("data-scene") !== "online") return { ok: false, reason: "scene-not-online" };
  const noise = scene.querySelector("[data-video-noise]");
  if (!noise) return { ok: false, reason: "no-noise" };
  const online = getComputedStyle(noise).animationName;
  scene.setAttribute("data-scene", "offline");
  const offline = getComputedStyle(noise).animationName;
  scene.setAttribute("data-scene", "online");
  const restored = getComputedStyle(noise).animationName;
  return { ok: online !== "none" && offline === "none" && restored === online, online, offline, restored };
})()`;

/** 点右上角的类型 tab（按可见文本找，不依赖 CSS module 的哈希类名）。 */
const CLICK_TAB = (label) => `(() => {
  const button = Array.from(document.querySelectorAll("button")).find((node) => (node.textContent || "").includes(${JSON.stringify(label)}));
  if (!button) return false;
  button.click();
  return true;
})()`;

/**
 * 页内采样（不受 CDP 往返延迟影响）：点「音频」后在 t=0 / 80 / 180 / 580ms
 * 各取一次阶段、卡片数、第一张卡的 opacity 与 animation-name。
 * 退场帧必须出现「phase=exit、9 张卡、opacity<1、animation-name=avChannelOut」。
 */
const SAMPLE_SWITCH = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const snap = (t) => {
    const page = document.querySelector('[data-av-page="monitor"]');
    const cards = Array.from(page.querySelectorAll('[data-motion="channel"]'));
    const first = cards[0];
    const audio = cards.find((card) => card.getAttribute("data-kind") === "audio");
    return {
      t,
      phase: page.querySelector("[data-filter-phase]")?.getAttribute("data-filter-phase") || "",
      cards: cards.length,
      opacity: first ? getComputedStyle(first).opacity : "",
      animation: first ? getComputedStyle(first).animationName : "",
      // FLIP：留下来的音频卡由 framer 逐帧写 inline transform，布局重排才是「滑过去」
      audioTransform: audio ? audio.style.transform : "",
    };
  };
  const button = Array.from(document.querySelectorAll("button")).find((node) => (node.textContent || "").includes("音频"));
  button.click();
  const out = [snap(0)];
  await wait(80);
  out.push(snap(80));
  await wait(100);
  out.push(snap(180));
  await wait(400);
  out.push(snap(580));
  return out;
})()`;

const report = {};

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
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1200, deviceScaleFactor: 1, mobile: false });

  // ---------- 动效开启 ----------
  await send("Page.navigate", { url: `${baseUrl}/stream-monitor/monitor` });
  await sleep(3200);
  const motionStart = await evaluate(READ_STATE);
  const liveShot = await screenshot("monitor-live.png");
  const videoShot = await screenshot("monitor-video.png");

  /*
   * 两条离线检查都是**非常真**的：
   *   · 波形：先给一根离线柱注入 --av-wave-delay，检测器必须报「有」；
   *   · 视频：把在线场景临时切到 offline，噪点必须立刻停。
   * 截图已经拍完，这里改 DOM 再同步恢复，不影响后面的帧。
   */
  const offlineWaveSelfTest = await evaluate(OFFLINE_WAVE_SELF_TEST);
  const offlineSceneProbe = await evaluate(OFFLINE_SCENE_PROBE);

  // 时间码：等 2.2s 后必须变；无动画的离线点必须没有 animation
  await sleep(2200);
  const motionAfter = await evaluate(READ_STATE);

  // 页内采样：证明退场帧真的在播（CDP 往返会让「60ms」实际变成 150ms+）
  const switchSamples = await evaluate(SAMPLE_SWITCH);

  // 重新加载后再点一次，取 0 / 60 / 180 / 560ms 四帧截图（视觉证据）
  await send("Page.navigate", { url: `${baseUrl}/stream-monitor/monitor` });
  await sleep(2600);
  await evaluate(CLICK_TAB("音频"));
  const frame0 = { state: await evaluate(READ_STATE), shot: await screenshot("monitor-switch-000ms.png") };
  await sleep(60);
  const frame60 = { state: await evaluate(READ_STATE), shot: await screenshot("monitor-switch-060ms.png") };
  await sleep(120);
  const frame180 = { state: await evaluate(READ_STATE), shot: await screenshot("monitor-switch-180ms.png") };
  await sleep(380);
  const frame560 = { state: await evaluate(READ_STATE), shot: await screenshot("monitor-switch-560ms.png") };

  report.motion = {
    start: motionStart,
    after2200: { liveTimecode: motionAfter.liveTimecode, phase: motionAfter.phase },
    timecodeAdvanced: motionStart.liveTimecode !== motionAfter.liveTimecode,
    offlineWaveSelfTest,
    offlineSceneProbe,
    switchSamples,
    switch: {
      "0ms": { phase: frame0.state.phase, cards: frame0.state.cards, opacity: frame0.state.cardOpacity, shot: frame0.shot },
      "60ms": { phase: frame60.state.phase, cards: frame60.state.cards, opacity: frame60.state.cardOpacity, shot: frame60.shot },
      "180ms": { phase: frame180.state.phase, cards: frame180.state.cards, opacity: frame180.state.cardOpacity, shot: frame180.shot },
      "560ms": { phase: frame560.state.phase, cards: frame560.state.cards, opacity: frame560.state.cardOpacity, shot: frame560.shot },
    },
    shots: [liveShot, videoShot],
  };

  // ---------- ?static=1 / reduced ----------
  await send("Page.navigate", { url: `${baseUrl}/stream-monitor/monitor?static=1` });
  await sleep(3200);
  const staticStart = await evaluate(READ_STATE);
  const shots = [];
  for (let i = 1; i <= 3; i += 1) {
    await sleep(900);
    shots.push(await screenshot(`monitor-static-${i}.png`));
  }
  await sleep(1400);
  const staticAfter = await evaluate(READ_STATE);
  report.static = {
    attrs: staticStart.motionAttr,
    liveTimecodeStart: staticStart.liveTimecode,
    liveTimecodeAfter: staticAfter.liveTimecode,
    timecodeFrozen: staticStart.liveTimecode === staticAfter.liveTimecode,
    liveDotAnimation: staticStart.liveDotAnimation,
    videoBoxAnimation: staticStart.videoBoxAnimation,
    videoScanAnimation: staticStart.videoScanAnimation,
    videoNoiseAnimation: staticStart.videoNoiseAnimation,
    md5: shots.map((shot) => shot.md5),
    staticMd5Identical: new Set(shots.map((shot) => shot.md5)).size === 1,
    shots,
  };

  // ---------- prefers-reduced-motion ----------
  await send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  await send("Page.navigate", { url: `${baseUrl}/stream-monitor/monitor` });
  await sleep(3200);
  const reducedStart = await evaluate(READ_STATE);
  await sleep(2200);
  const reducedAfter = await evaluate(READ_STATE);
  report.reduced = {
    liveDotAnimation: reducedStart.liveDotAnimation,
    liveTimecodeStart: reducedStart.liveTimecode,
    liveTimecodeAfter: reducedAfter.liveTimecode,
    timecodeFrozen: reducedStart.liveTimecode === reducedAfter.liveTimecode,
  };
  await send("Emulation.setEmulatedMedia", { features: [] });

  // ---------- 断言 ----------
  const unique = (values) => new Set(values).size === values.length;
  const checks = {
    "9 张卡（2 视频 + 7 音频）":
      motionStart.cards === 9 &&
      motionStart.kinds.filter((kind) => kind === "audio").length === 7 &&
      motionStart.kinds.filter((kind) => kind === "video").length === 2,
    "音频卡 ≥ 6": Number(motionStart.audioCards) >= 6,
    "波形 seed / 周期 / 相位互不相同":
      unique(motionStart.waveSeeds) && unique(motionStart.waveSpeeds) && unique(motionStart.wavePhases),
    "每张卡的波形签名互不相同": unique(motionStart.waveSignatures),
    "在线 LIVE 点有呼吸动画": motionStart.liveDotAnimation !== "none",
    "离线 LIVE 点没有动画": motionStart.offlineDotAnimation === "none",
    "离线波形：每根柱没有 --av-wave-delay 且 animation-name 为 none": (() => {
      const waves = motionStart.offlineWaves;
      return (
        waves.length > 0 &&
        waves.every((wave) => wave.bars > 0 && wave.withDelayVar === 0 && wave.animated === 0)
      );
    })(),
    "离线波形检查的负向自检（注入 --av-wave-delay 必须被检出）":
      offlineWaveSelfTest.ok && offlineWaveSelfTest.detected === true,
    "（如有）离线视频场景：噪点 / 扫描线 / 检测框全静": motionStart.offlineVideoScenes.every(
      (scene) => scene.noise === "none" && scene.scan === 0 && scene.boxes === 0,
    ),
    "视频卡有检测框 / 扫描线 / 噪点动画":
      motionStart.videoScene === "online" &&
      motionStart.videoBoxes >= 2 &&
      motionStart.videoBoxAnimation !== "none" &&
      motionStart.videoScanAnimation !== "none" &&
      motionStart.videoNoiseAnimation !== "none",
    "离线视频画面是冻结帧（切到 offline 后噪点 animation-name=none，恢复后重新在动）":
      offlineSceneProbe.ok && offlineSceneProbe.online !== "none" && offlineSceneProbe.offline === "none",
    "动效开启时时间码递增": report.motion.timecodeAdvanced,
    "切换有三段式（退场帧真的在播：9 张、opacity<1、animation=avChannelOut；之后 7 张进入 enter）": (() => {
      const exitFrame = switchSamples.find((sample) => sample.phase === "exit" && sample.cards === 9);
      return (
        Boolean(exitFrame) &&
        Number(exitFrame.opacity) < 1 &&
        exitFrame.animation === "avChannelOut" &&
        frame560.state.cards === 7 &&
        ["enter", "idle"].includes(frame560.state.phase)
      );
    })(),
    "FLIP：重排阶段剩余卡片有 inline transform（不是瞬间跳位）": switchSamples.some(
      (sample) => sample.phase === "enter" && /translate3d\(/.test(sample.audioTransform),
    ),
    "?static=1 时间码不递增": report.static.timecodeFrozen,
    "?static=1 动画全关":
      staticStart.liveDotAnimation === "none" &&
      staticStart.videoBoxAnimation === "none" &&
      staticStart.videoScanAnimation === "none" &&
      staticStart.videoNoiseAnimation === "none",
    "?static=1 连拍 3 次 MD5 一致": report.static.staticMd5Identical,
    "prefers-reduced-motion：LIVE 不呼吸、时间码不递增":
      report.reduced.liveDotAnimation === "none" && report.reduced.timecodeFrozen,
  };
  report.checks = checks;
  report.pass = Object.values(checks).every(Boolean);
  writeFileSync(`${outDir}/monitor-motion-report.json`, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ pass: report.pass, checks, staticMd5: report.static.md5 }, null, 2));
  if (!report.pass) process.exitCode = 1;
} finally {
  ws?.close?.();
  chrome.kill("SIGTERM");
}
