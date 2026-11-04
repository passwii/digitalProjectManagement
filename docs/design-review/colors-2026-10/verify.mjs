import { palettes, resolve, contrast, oklch } from './tokens.mjs';

const TEXT = 4.5, GRAPHIC = 3;
const textPairs = [
  ['ink', 'bg'], ['ink', 'card'], ['ink', 'cardLift'],
  ['ink2', 'bg'], ['ink2', 'card'],
  ['ink3', 'bg'],
  ['brand', 'bg'], ['brand', 'card'],
  ['onAction', 'action'], ['onAction', 'actionHover'],
  ['done', 'doneSoft'], ['warn', 'warnSoft'], ['danger', 'dangerSoft'], ['todo', 'todoSoft'], ['doing', 'doingSoft'],
  ['done', 'bg'], ['warn', 'bg'], ['danger', 'bg'], ['todo', 'bg'],
  ['navInk', 'nav'], ['navMuted', 'nav'], ['navInk', 'navActiveBg'], ['brand', 'brandSoft'],
];
const graphicPairs = [
  ['brand', 'bg'], ['brand', 'card'], ['action', 'bg'], ['action', 'card'],
  ['navActiveAccent', 'navActiveBg'], ['navActiveAccent', 'nav'],
  ['s0', 'card'], ['s1', 'card'], ['s2', 'card'], ['s3', 'card'], ['s4', 'card'], ['s5', 'card'],
  ['done', 'card'], ['warn', 'card'], ['danger', 'card'], ['controlBorder', 'card'], ['controlBorder', 'bg'],
];

const rows = [];
let fails = 0;
for (const key of Object.keys(palettes)) {
  for (const mode of ['dark', 'light']) {
    const t = resolve(palettes[key], mode);
    const check = (a, b, min, kind) => {
      const A = a.startsWith('s') ? t.series[+a.slice(1)] : t[a];
      const B = b.startsWith('s') ? t.series[+b.slice(1)] : t[b];
      const c = contrast(A, B);
      const ok = c >= min;
      if (!ok) fails++;
      rows.push({ palette: key, mode, kind, pair: a + '/' + b, a: A, b: B, ratio: +c.toFixed(2), min, ok });
    };
    for (const [a, b] of textPairs) check(a, b, TEXT, 'text');
    for (const [a, b] of graphicPairs) check(a, b, GRAPHIC, 'graphic');
  }
}
const bad = rows.filter(r => !r.ok);
console.log('checks:', rows.length, 'fails:', fails);
for (const r of bad) console.log([r.palette, r.mode, r.kind, r.pair, r.a, r.b, r.ratio, '<' + r.min].join('  '));

// 色相间距诊断（只统计彩度 >0.05 的色相；灰阶的 H 无意义）
console.log('\\n=== OKLCH 诊断 ===');
for (const key of Object.keys(palettes)) {
  for (const mode of ['dark', 'light']) {
    const t = resolve(palettes[key], mode);
    const s = t.series.map(h => oklch(h)).filter(v => v.C > 0.05);
    const gaps = [];
    for (let i = 1; i < s.length; i++) { let d = Math.abs(s[i].H - s[i - 1].H); gaps.push(d > 180 ? 360 - d : d); }
    const loud = ['brand', 'action', 'done', 'warn', 'danger'].filter(k => oklch(t[k]).L > 72 && oklch(t[k]).C > 0.09);
    console.log(key, mode,
      '| bg L' + oklch(t.bg).L + ' C' + oklch(t.bg).C,
      '| brand L' + oklch(t.brand).L + ' C' + oklch(t.brand).C + ' H' + oklch(t.brand).H,
      '| action L' + oklch(t.action).L + ' C' + oklch(t.action).C + ' H' + oklch(t.action).H,
      '| 高亮角色数', loud.length, loud.join(','),
      '| 彩度系列 H', s.map(v => v.H).join(','), '| minGap', gaps.length ? Math.min(...gaps) : '-');
  }
}
