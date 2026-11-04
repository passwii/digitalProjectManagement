// 配色方案令牌 —— 单一真源（预览页与校验脚本共用）
// 用法：node docs/design-review/colors-2026-10/build.mjs（生成 palettes.css + contrast.json）
// 命名与 web/app/globals.css 保持一致，便于直接落地。

export function hexToRgb(h) {
  const s = h.replace('#', '');
  const v = s.length === 3 ? s.split('').map(c => c + c).join('') : s;
  return [0, 2, 4].map(i => parseInt(v.slice(i, i + 2), 16));
}
export function rgbToHex(rgb) {
  return '#' + rgb.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
}
export function mix(a, b, t) {
  const A = hexToRgb(a), B = hexToRgb(b);
  return rgbToHex(A.map((v, i) => v + (B[i] - v) * t));
}
function lin(c) { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
export function relLum(hex) {
  const [r, g, b] = hexToRgb(hex).map(lin);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(a, b) {
  const l1 = relLum(a), l2 = relLum(b);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}
// 沿 from→to 混合，直到与 ref 的对比度达到 target（用于派生控件描边这类「刚好够看」的边界色）
export function mixUntilContrast(from, to, ref, target) {
  let lo = 0, hi = 1;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (contrast(mix(from, to, mid), ref) >= target) hi = mid; else lo = mid;
  }
  return mix(from, to, hi);
}

export function oklch(hex) {
  const [r, g, b] = hexToRgb(hex).map(lin);
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
  const l_ = Math.cbrt(l), m_ = Math.cbrt(m), s_ = Math.cbrt(s);
  const L = 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_;
  const A = 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_;
  const B = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_;
  let H = Math.atan2(B, A) * 180 / Math.PI; if (H < 0) H += 360;
  return { L: +(L * 100).toFixed(1), C: +Math.hypot(A, B).toFixed(3), H: +H.toFixed(0) };
}

// 每套方案只写「核心色」，柔和底 / 描边由 resolve() 统一派生，
// 保证同一方案里所有 badge 的软底来自同一条混合规则，不会各写一个值慢慢漂。
export const palettes = {
  current: {
    key: 'current', name: '现状 · 青 + 蓝', short: '现状',
    headline: '电光青信号 + 荧光青柠行动 + 深海蓝底',
    dark: {
      bg: '#07131f', card: '#0d1d2c', cardLift: '#13293c',
      ink: '#eaf9fb', ink2: '#93a9b2', ink3: '#647781',
      line: '#22323f', lineSoft: '#16242f', controlBorder: '#2a4350',
      brand: '#6cf3ff', brandHover: '#c6ff72',
      action: '#c6ff72', actionHover: '#d9ff9b', onAction: '#07131f',
      done: '#c6ff72', warn: '#ffc46b', danger: '#ff9a6a', todo: '#9cb4c4', doing: '#6cf3ff',
      nav: '#081622', navInk: '#eaf2ff', navMuted: '#a3b3c0',
      navActiveBg: '#102b3a', navActiveAccent: '#6cf3ff', navBorder: '#16242f', navHover: '#0d1d2c',
      series: ['#6cf3ff', '#7db4ff', '#bda6ff', '#ff8fc7', '#ff9a6a', '#ffc46b'],
    },
    light: {
      bg: '#f1f5f7', card: '#ffffff', cardLift: '#e8eef2',
      ink: '#1c2c38', ink2: '#526575', ink3: '#5e707d',
      line: '#d8e1e7', lineSoft: '#e7edf1', controlBorder: '#82939e', actionLine: '#adc95d',
      brand: '#17617d', brandHover: '#124d64',
      action: '#c6df7b', actionHover: '#bdd76e', onAction: '#26351a',
      done: '#356b4b', warn: '#805518', danger: '#a23e39', todo: '#5e707d', doing: '#17617d',
      nav: '#142f40', navInk: '#f4f8fa', navMuted: '#bdcbd3',
      navActiveBg: '#244657', navActiveAccent: '#c6df7b', navBorder: '#314b5a', navHover: '#1b3a4d',
      series: ['#17617d', '#2f5fbf', '#6d4cc2', '#a03b73', '#a23e39', '#805518'],
    },
  },

  a: {
    key: 'a', name: 'A · 石墨靛蓝', short: 'A',
    headline: '中性石墨表面 + 唯一靛蓝强调，颜色只用来指路',
    dark: {
      bg: '#14161a', card: '#1a1d22', cardLift: '#22262d',
      ink: '#e8e9ec', ink2: '#a3a8b2', ink3: '#7d838e',
      line: '#2a2e36', lineSoft: '#212429',
      brand: '#8ca6f8', brandHover: '#adc0ff',
      action: '#5b77e0', actionHover: '#6e8aed', onAction: '#0c0e14',
      done: '#58c98a', warn: '#e3b15c', danger: '#f0746b', todo: '#9ba1ac', doing: '#8ca6f8',
      nav: '#0f1115', navInk: '#e8e9ec', navMuted: '#9aa0aa',
      navActiveBg: '#20263a', navActiveAccent: '#a9bcff', navBorder: '#22262c', navHover: '#191c21',
      series: ['#8ca6f8', '#57c6d2', '#e88bc4', '#e3b15c', '#58c98a', '#97a3b8'],
    },
    light: {
      bg: '#f6f7f9', card: '#ffffff', cardLift: '#eff1f5',
      ink: '#191c22', ink2: '#545b66', ink3: '#6a7280',
      line: '#e3e6eb', lineSoft: '#edeff3',
      brand: '#3d56c4', brandHover: '#2e44a8',
      action: '#3d56c4', actionHover: '#2e44a8', onAction: '#ffffff',
      done: '#2c7a57', warn: '#8a5d12', danger: '#ae3a34', todo: '#5f6773', doing: '#3d56c4',
      nav: '#23272f', navInk: '#eff0f3', navMuted: '#a8aeb8',
      navActiveBg: '#333a47', navActiveAccent: '#b3c4ff', navBorder: '#31363f', navHover: '#2a2f38',
      series: ['#3d56c4', '#177f8e', '#a8447c', '#8a5d12', '#2c7a57', '#6b7280'],
    },
  },

  b: {
    key: 'b', name: 'B · 深海青 · 纸白', short: 'B',
    headline: '保留深海青基因但去霓虹，主按钮改纸白中性',
    dark: {
      bg: '#081316', card: '#0f1d21', cardLift: '#172a2f',
      ink: '#e3edef', ink2: '#9db0b4', ink3: '#74888d',
      line: '#22353a', lineSoft: '#1a2a2f',
      brand: '#4fc3d1', brandHover: '#74d6e1',
      action: '#e8e2d4', actionHover: '#f4efe5', onAction: '#17211f',
      done: '#55c08c', warn: '#e0ae5a', danger: '#f0756b', todo: '#93a6aa', doing: '#4fc3d1',
      nav: '#061012', navInk: '#e3edef', navMuted: '#92a6aa',
      navActiveBg: '#0f2a2e', navActiveAccent: '#74d6e1', navBorder: '#1b2c30', navHover: '#0d1b1e',
      series: ['#4fc3d1', '#e0ae5a', '#b79be8', '#e8839e', '#55c08c', '#8fa0a6'],
    },
    light: {
      bg: '#f2f6f6', card: '#ffffff', cardLift: '#e8efef',
      ink: '#13262b', ink2: '#4d646a', ink3: '#597075',
      line: '#dee7e8', lineSoft: '#eaf0f1',
      brand: '#0e6b79', brandHover: '#0a5462',
      action: '#14282d', actionHover: '#1d3a40', onAction: '#f7fafa',
      done: '#256b4c', warn: '#7e5514', danger: '#ab3a34', todo: '#5b6e73', doing: '#0e6b79',
      nav: '#0b2228', navInk: '#f1f7f7', navMuted: '#a5bcc0',
      navActiveBg: '#14383f', navActiveAccent: '#7fe0e8', navBorder: '#1c3a41', navHover: '#123036',
      series: ['#0e6b79', '#9a6b12', '#6c4ba8', '#a8446e', '#256b4c', '#5b6e73'],
    },
  },

  c: {
    key: 'c', name: 'C · 墨玉 · 黄铜', short: 'C',
    headline: '墨玉单色信号 + 黄铜行动，账本式的稳',
    dark: {
      bg: '#12140f', card: '#1b1d17', cardLift: '#262920',
      ink: '#e9eadf', ink2: '#a5a79a', ink3: '#878b7c',
      line: '#2b2e24', lineSoft: '#22251d',
      brand: '#5cbd90', brandHover: '#7fd0a8',
      action: '#ce9350', actionHover: '#dca463', onAction: '#1a1206',
      done: '#4fa978', warn: '#e8c55c', danger: '#e87c6a', todo: '#989b8e', doing: '#57b3ab',
      nav: '#0e100b', navInk: '#e9eadf', navMuted: '#9ca091',
      navActiveBg: '#1e2a22', navActiveAccent: '#7fd0a8', navBorder: '#23261d', navHover: '#171a13',
      series: ['#5cbd90', '#e8c55c', '#6fa8b8', '#dd5c4c', '#7fa8d9', '#a99bd8'],
    },
    light: {
      bg: '#f8f6f0', card: '#ffffff', cardLift: '#f1eee5',
      ink: '#1e1c15', ink2: '#575443', ink3: '#6f6b5a',
      line: '#e2ded2', lineSoft: '#edeae1',
      brand: '#1e6b4c', brandHover: '#15523a',
      action: '#8a5c14', actionHover: '#744c0e', onAction: '#ffffff',
      done: '#25694a', warn: '#7c6410', danger: '#a33a2b', todo: '#6b6656', doing: '#1d7a72',
      nav: '#12211a', navInk: '#f2f0e6', navMuted: '#a9a797',
      navActiveBg: '#1d3327', navActiveAccent: '#8cd3a8', navBorder: '#26301f', navHover: '#18251c',
      series: ['#1e6b4c', '#96700f', '#2f7f92', '#a33a2b', '#2f5f9e', '#6c4ba8'],
    },
  },

  d: {
    key: 'd', name: 'D · 单一主色', short: 'D',
    headline: '只留一个强调色，主次靠填充 / 描边 / 文字的形态区分，而不是再加第二种颜色',
    dark: {
      bg: '#07131f', card: '#0d1d2c', cardLift: '#152c3e',
      ink: '#eaf9fb', ink2: '#a8c2cc', ink3: '#7d949e',
      line: '#233746', lineSoft: '#172633', controlBorder: '#586d79',
      brand: '#5fe7f5', brandHover: '#8aecf7',
      action: '#5fe7f5', actionHover: '#93effa', actionLine: '#5fe7f5', onAction: '#04191d',
      doing: '#5fe7f5', done: '#6fdca6', warn: '#f0bf6a', danger: '#f28a72', todo: '#9cb4c4',
      nav: '#081622', navInk: '#eaf2ff', navMuted: '#a3b3c0',
      navActiveBg: '#0f2b3a', navActiveAccent: '#5fe7f5', navBorder: '#16242f', navHover: '#0d1d2c',
      series: ['#5fe7f5', '#7db4ff', '#bda6ff', '#ff8fc7', '#ff9a6a', '#ffc46b'],
    },
    light: {
      bg: '#f1f5f7', card: '#ffffff', cardLift: '#e8eef2',
      ink: '#1c2c38', ink2: '#4c6068', ink3: '#5a6d74',
      line: '#d8e1e7', lineSoft: '#e7edf1',
      brand: '#17617d', brandHover: '#124d64',
      action: '#17617d', actionHover: '#124d64', actionLine: '#17617d', onAction: '#ffffff',
      doing: '#17617d', done: '#2f7a55', warn: '#7d5417', danger: '#9e3a33', todo: '#5e707d',
      nav: '#142f40', navInk: '#f4f8fa', navMuted: '#bdcbd3',
      navActiveBg: '#244657', navActiveAccent: '#7fe0e8', navBorder: '#314b5a', navHover: '#1b3a4d',
      series: ['#17617d', '#2f5fbf', '#6d4cc2', '#a03b73', '#a23e39', '#7d5417'],
    },
  },
};

// 派生层：软底 / 描边统一从这里出，避免每个 badge 各写一个值
export function resolve(pal, mode) {
  const t = pal[mode];
  const card = t.card, bg = t.bg;
  const softT = mode === 'dark' ? 0.16 : 0.10;
  const lineT = mode === 'dark' ? 0.42 : 0.42;
  const base = mode === 'dark' ? mix(card, bg, 0.0) : card;
  return {
    ...t,
    mode,
    brandSoft: mix(base, t.brand, mode === 'dark' ? 0.16 : 0.10),
    brandLine: mix(base, t.brand, lineT),
    actionSoft: mix(base, t.action, softT),
    doneSoft: mix(base, t.done, softT),
    doingSoft: mix(base, t.doing, softT),
    doingLine: mix(base, t.doing, lineT),
    warnSoft: mix(base, t.warn, softT),
    dangerSoft: mix(base, t.danger, softT),
    todoSoft: mix(base, t.todo, mode === 'dark' ? 0.12 : 0.07),
    doneLine: mix(base, t.done, lineT),
    warnLine: mix(base, t.warn, lineT),
    dangerLine: mix(base, t.danger, lineT),
    // 控件描边（输入框 / Select / 分段控件边界）按「对卡片底色 ≥3:1」派生，
    // 不再依赖 --line 那种只够看的装饰性分隔线。
    // 深色主题限制造约的是卡片（更亮），浅色主题限制造约的是画布（更暗）
    controlBorder: t.controlBorder || mixUntilContrast(card, t.ink2, mode === 'dark' ? card : bg, 3.15),
    focus: t.brand,
    overlay: mode === 'dark' ? 'rgba(4, 6, 9, 0.62)' : 'rgba(24, 26, 30, 0.28)',
    shadowFloat: mode === 'dark'
      ? '0 24px 60px rgba(0, 0, 0, 0.55)'
      : '0 12px 32px rgba(20, 22, 28, 0.14)',
  };
}