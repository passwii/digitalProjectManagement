import { writeFileSync } from 'node:fs';
import { palettes, resolve, contrast, oklch } from './tokens.mjs';

const TOKENS = (t) => ({
  'bg': t.bg, 'card': t.card, 'card-lift': t.cardLift,
  'ink': t.ink, 'ink-2': t.ink2, 'ink-3': t.ink3,
  'line': t.line, 'line-soft': t.lineSoft, 'control-border': t.controlBorder,
  'brand': t.brand, 'brand-hover': t.brandHover, 'brand-soft': t.brandSoft, 'brand-line': t.brandLine,
  'action': t.action, 'action-hover': t.actionHover, 'action-soft': t.actionSoft, 'action-line': t.actionLine || t.actionHover, 'on-action': t.onAction,
  'doing': t.doing, 'doing-bg': t.doingSoft, 'doing-line': t.doingLine,
  'done': t.done, 'done-bg': t.doneSoft, 'done-line': t.doneLine,
  'warn': t.warn, 'warn-bg': t.warnSoft, 'warn-line': t.warnLine,
  'danger': t.danger, 'danger-bg': t.dangerSoft, 'danger-line': t.dangerLine,
  'todo': t.todo, 'todo-bg': t.todoSoft,
  'nav': t.nav, 'nav-ink': t.navInk, 'nav-muted': t.navMuted,
  'nav-active-bg': t.navActiveBg, 'nav-active-accent': t.navActiveAccent,
  'nav-border': t.navBorder, 'nav-hover': t.navHover,
  'series-1': t.series[0], 'series-2': t.series[1], 'series-3': t.series[2],
  'series-4': t.series[3], 'series-5': t.series[4], 'series-6': t.series[5],
  'focus': t.focus, 'overlay': t.overlay, 'shadow-float': t.shadowFloat,
});

const css = [];
css.push('/* 由 build.mjs 从 tokens.mjs 生成，不要手改。 */');
for (const key of Object.keys(palettes)) {
  for (const mode of ['dark', 'light']) {
    const t = resolve(palettes[key], mode);
    const props = Object.entries(TOKENS(t)).map(([k, v]) => `  --${k}: ${v};`).join('\n');
    css.push(`[data-p="${key}"][data-mode="${mode}"] {\n${props}\n}\n`);
  }
}
writeFileSync(new URL('./palettes.css', import.meta.url), css.join('\n'));

// ---- 对比度报告（供预览页显示真实数字）----
const textPairs = [
  ['ink', 'bg', '正文 / 画布'], ['ink', 'card', '正文 / 卡片'], ['ink-2', 'bg', '次级文字 / 画布'],
  ['ink-3', 'bg', '弱文字 / 画布'],
  ['brand', 'bg', '链接 / 画布'], ['brand', 'card', '链接 / 卡片'],
  ['on-action', 'action', '按钮文字 / 按钮'], ['on-action', 'action-hover', '按钮文字 / 悬停态'],
  ['doing', 'doing-bg', '进行中徽标'], ['done', 'done-bg', '完成徽标'], ['warn', 'warn-bg', '警告徽标'],
  ['danger', 'danger-bg', '危险徽标'], ['todo', 'todo-bg', '中性徽标'],
  ['nav-ink', 'nav', '导航文字 / 侧栏'], ['nav-muted', 'nav', '导航弱文字 / 侧栏'],
  ['nav-ink', 'nav-active-bg', '导航文字 / 当前项底'],
];
const graphicPairs = [
  ['control-border', 'card', '控件描边 / 卡片'], ['control-border', 'bg', '控件描边 / 画布'],
  ['nav-active-accent', 'nav-active-bg', '导航当前项标记'],
  ['action', 'bg', '主按钮底 / 画布'], ['action', 'card', '主按钮底 / 卡片'],
  ['series-1', 'card', '图表系列 1'], ['series-2', 'card', '图表系列 2'], ['series-3', 'card', '图表系列 3'],
  ['series-4', 'card', '图表系列 4'], ['series-5', 'card', '图表系列 5'], ['series-6', 'card', '图表系列 6'],
];
const report = { text: [], graphic: [], meta: {} };
for (const key of Object.keys(palettes)) {
  for (const mode of ['dark', 'light']) {
    const t = resolve(palettes[key], mode);
    const tok = TOKENS(t);
    for (const [a, b, label] of textPairs) {
      const r = contrast(tok[a], tok[b]);
      report.text.push({ palette: key, mode, label, a: tok[a], b: tok[b], ratio: +r.toFixed(2), ok: r >= 4.5 });
    }
    for (const [a, b, label] of graphicPairs) {
      const r = contrast(tok[a], tok[b]);
      report.graphic.push({ palette: key, mode, label, a: tok[a], b: tok[b], ratio: +r.toFixed(2), ok: r >= 3 });
    }
    const s = t.series.map(h => oklch(h)).filter(v => v.C > 0.05);
    const gaps = [];
    for (let i = 1; i < s.length; i++) { let d = Math.abs(s[i].H - s[i - 1].H); gaps.push(d > 180 ? 360 - d : d); }
    const loud = ['brand', 'action', 'done', 'warn', 'danger'].filter(k => {
      const c = oklch(t[k]); return c.L > 72 && c.C > 0.09;
    });
    report.meta[key + ':' + mode] = {
      bgChroma: oklch(t.bg).C,
      brand: oklch(t.brand),
      action: oklch(t.action),
      loudRoles: loud,
      seriesMinGap: gaps.length ? Math.round(Math.min(...gaps)) : null,
      surfaces: [t.bg, t.card, t.cardLift].map(h => oklch(h).L),
    };
  }
}

// ---- 结构指标：共用色值 / 系列间距 / 对比度不达标数 ----
const ROLES = ['brand', 'brandHover', 'action', 'actionHover', 'done', 'doing', 'warn', 'danger', 'todo', 'navActiveAccent'];
const struct = {};
for (const key of Object.keys(palettes)) {
  for (const mode of ['dark', 'light']) {
    const t = resolve(palettes[key], mode);
    // 同一个色值被多少个语义角色共用（只统计共享 ≥2 的角色组）
    const byValue = {};
    for (const r of ROLES) {
      const v = (t[r] || '').toLowerCase();
      if (!v) continue;
      (byValue[v] = byValue[v] || []).push(r);
    }
    const shared = Object.values(byValue).filter(g => g.length > 1);
    const fails = [...report.text, ...report.graphic].filter(r => r.palette === key && r.mode === mode && !r.ok).length;
    const hueDist = (() => {
      const a = oklch(t.action), br = oklch(t.brand);
      let d = Math.abs(a.H - br.H); if (d > 180) d = 360 - d;
      return Math.round(d);
    })();
    struct[key + ':' + mode] = {
      sharedGroups: shared.map(g => g.join('/')),
      maxShared: shared.length ? Math.max(...shared.map(g => g.length)) : 1,
      seriesMinGap: (() => {
        const s = t.series.map(h => oklch(h)).filter(v => v.C > 0.05);
        const gaps = [];
        for (let i = 1; i < s.length; i++) { let d = Math.abs(s[i].H - s[i - 1].H); gaps.push(d > 180 ? 360 - d : d); }
        return gaps.length ? Math.round(Math.min(...gaps)) : null;
      })(),
      actionVsBrandHue: hueDist,
      sameActionBrand: (t.action || '').toLowerCase() === (t.brand || '').toLowerCase(),
      fails,
    };
  }
}
report.struct = struct;
writeFileSync(new URL('./contrast.json', import.meta.url), JSON.stringify(report, null, 1));
writeFileSync(new URL('./data.js', import.meta.url),
  'window.__COLORS__ = ' + JSON.stringify({
    contrast: report,
    meta: report.meta,
    struct: report.struct,
    palettes: Object.fromEntries(Object.entries(palettes).map(([k, v]) => [k, {
      key: k, name: v.name, short: v.short, headline: v.headline,
      swatches: {
        dark: TOKENS(resolve(v, 'dark')), light: TOKENS(resolve(v, 'light')),
      },
    }])),
  }) + ';\n');
console.log('\n=== 结构指标（深色）===');
for (const key of Object.keys(palettes)) {
  const s = struct[key + ':dark'];
  console.log(key.padEnd(8), 'fails=' + s.fails, 'maxShared=' + s.maxShared, '[' + s.sharedGroups.join(' ') + ']', 'seriesGap=' + s.seriesMinGap, 'actionVsBrand=' + (s.sameActionBrand ? '同色' : s.actionVsBrandHue + '°'));
}
console.log('palettes:', Object.keys(palettes).join(','), '| css bytes:', css.join('\n').length);
const allFails = [...report.text, ...report.graphic].filter(r => !r.ok);
console.log('contrast rows:', report.text.length + report.graphic.length, '| fails:', allFails.length);
for (const f of allFails) console.log(' ', f.palette, f.mode, f.label, f.ratio);
for (const [k, v] of Object.entries(report.meta)) console.log(k, 'loud=' + v.loudRoles.length, 'gap=' + v.seriesMinGap, 'bgC=' + v.bgChroma);