/**
 * 功能更新页面的样式，以字符串形式随页面 JS 一起下发，由页面渲染成内联
 * <style>，不再走独立的 CSS Module 文件。
 *
 * 为什么（这是 changelog 冷加载 bug 的根因，别再改回 CSS Module）：
 * Next 14 / React 18 的 App Router 在客户端路由切换时，目标路由的 CSS 是一个
 * 独立 chunk，由 React 在提交新路由 DOM 之后才把 <link rel="stylesheet"> 插进
 * <head>，而且 React 18 不会等样式表加载完再提交 —— 于是页面先以「只有 DOM、
 * 没有页面样式」的状态画出一帧，等 CSS 回来才变成正常排版。这个页面的入口只挂在
 * 账号菜单里（菜单打开才渲染 <Link>），它的 CSS chunk 从不被预取；冷缓存下这一帧
 * 能持续约 1s，正是用户反馈的「先只有文案，过一会儿才出现样式」。
 *
 * 实测（2026-11，生产构建 + Chrome CDP，禁用缓存 + 300ms 网络延迟）：
 *   路由切换后 416ms：.changelog-currentMark 已进 DOM，min-width=0、页面宽度
 *   1360px（未应用样式）；733ms：样式表到达并应用，min-width=112px、宽度 1180px。
 * 直接冷启动时 CSS 在 head 里阻塞渲染，所以 bug 只在客户端切换路由时出现。
 *
 * 页面 JS chunk 是路由渲染的前置依赖（路由会等模块加载完再渲染），所以把同样的
 * CSS 放进页面模块后，样式与 DOM 一定在同一次提交里出现，首帧就是最终样式。
 *
 * 样式里的类名统一加 changelog- 前缀，避免内联后变成无作用域的全局类；类名与
 * 下发 CSS 的一致性由 lib/changelogPage.dom.vitest.test.tsx 与
 * lib/workbenchFeaturePages.vitest.test.ts 守着。
 */

/** 页面用到的类名（保持与 CSS 一一对应，改一处必须同时改另一处）。 */
export const s = {
  page: "changelog-page",
  hero: "changelog-hero",
  currentMark: "changelog-currentMark",
  tabs: "changelog-tabs",
  tab: "changelog-tab",
  tabActive: "changelog-tabActive",
  tabVersion: "changelog-tabVersion",
  panel: "changelog-panel",
  panelHead: "changelog-panelHead",
  count: "changelog-count",
  timeline: "changelog-timeline",
  day: "changelog-day",
  dayLatest: "changelog-dayLatest",
  dateColumn: "changelog-dateColumn",
  nodeColumn: "changelog-nodeColumn",
  node: "changelog-node",
  entries: "changelog-entries",
  entry: "changelog-entry",
  kind: "changelog-kind",
  kindFeature: "changelog-kindFeature",
  kindImprove: "changelog-kindImprove",
  kindFix: "changelog-kindFix",
  kindMobile: "changelog-kindMobile",
  kindFinance: "changelog-kindFinance",
  kindArch: "changelog-kindArch",
  entryCopy: "changelog-entryCopy",
} as const;
export const CHANGELOG_CSS = String.raw`.changelog-page {
  width: min(100%, 1180px);
  margin: 0 auto;
}

.changelog-hero {
  min-height: 64px;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 24px;
  padding: 0 0 16px;
  border-bottom: 1px solid var(--line);
}

.changelog-hero h1 {
  margin: 0;
  color: var(--ink);
  font-size: 38px;
  font-weight: 750;
  letter-spacing: -.035em;
  line-height: 1.2;
}

.changelog-currentMark {
  flex: none;
  min-width: 112px;
  padding: 12px 16px;
  border: 1px solid var(--line-blue);
  background: var(--card-lift);
  box-shadow: inset 0 1px 0 var(--highlight-inset);
}

.changelog-currentMark span,
.changelog-currentMark strong { display: block; }

.changelog-currentMark span {
  color: var(--ink-2);
  font-size: 11px;
}

.changelog-currentMark strong {
  margin-top: 4px;
  color: var(--brand-hover);
  font-family: var(--font-mono);
  font-size: 18px;
  font-variant-numeric: tabular-nums;
}

.changelog-tabs {
  display: flex;
  gap: 4px;
  margin: 24px 0 18px;
  padding: 4px;
  overflow-x: auto;
  border: 1px solid var(--line);
  border-radius: 0;
  background: var(--card-lift);
  box-shadow: inset 0 1px 0 var(--highlight-inset);
  scrollbar-width: none;
}

.changelog-tabs::-webkit-scrollbar { display: none; }

.changelog-tab {
  flex: 1 1 0;
  min-width: 0;
  min-height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 0 16px;
  border: 0;
  border-radius: 0;
  color: var(--ink-2);
  background: transparent;
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
}

.changelog-tab:hover { color: var(--ink); background: var(--card); }
.changelog-tabActive {
  color: var(--ink);
  background: var(--card);
  box-shadow: inset 0 -1px 0 var(--brand), inset 0 1px 0 var(--highlight-inset);
}

.changelog-tabVersion {
  color: var(--brand);
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 700;
}

.changelog-panel {
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: 0;
  background: var(--card);
  box-shadow: inset 0 1px 0 var(--highlight-inset);
}

.changelog-panelHead {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 24px;
  padding: 20px 24px;
  border-bottom: 1px solid var(--line-soft);
  background: var(--card-lift);
}

.changelog-panelHead h2 {
  margin: 0;
  color: var(--ink);
  font-size: 22px;
  font-weight: 720;
  letter-spacing: -.025em;
}

.changelog-panelHead p:last-child {
  max-width: 560px;
  margin: 5px 0 0;
  color: var(--ink-2);
  font-size: 13px;
}

.changelog-count {
  flex: none;
  min-width: 74px;
  padding-left: 15px;
  border-left: 1px solid var(--line);
  text-align: right;
}

.changelog-count strong,
.changelog-count span { display: block; }
.changelog-count strong {
  color: var(--ink);
  font-family: var(--font-mono);
  font-size: 22px;
  line-height: 1.2;
}
.changelog-count span { margin-top: 3px; color: var(--ink-3); font-size: 11px; }

.changelog-timeline { padding: 4px 24px 24px; }

.changelog-day {
  display: grid;
  grid-template-columns: 104px 20px minmax(0, 1fr);
  gap: 12px;
  min-width: 0;
  padding: 24px 0 4px;
}

.changelog-dateColumn {
  padding-top: 4px;
  text-align: right;
}

.changelog-dateColumn time {
  display: block;
  color: var(--ink-2);
  font-family: var(--font-mono);
  font-size: 12px;
  font-weight: 700;
  white-space: nowrap;
}

.changelog-dateColumn span {
  display: inline-block;
  margin-top: 7px;
  color: var(--brand);
  font-size: 10px;
  font-weight: 700;
}

.changelog-nodeColumn {
  position: relative;
  display: flex;
  justify-content: center;
}

.changelog-nodeColumn::before {
  position: absolute;
  top: 0;
  bottom: -28px;
  left: 50%;
  width: 1px;
  content: "";
  background: var(--line);
}

.changelog-day:last-child .changelog-nodeColumn::before { bottom: 38px; }
.changelog-node {
  position: relative;
  z-index: 1;
  width: 10px;
  height: 10px;
  margin-top: 5px;
  border: 2px solid var(--card);
  border-radius: 50%;
  background: var(--ink-3);
  outline: 1px solid var(--line);
  outline-offset: 1px;
}
.changelog-dayLatest .changelog-node {
  background: var(--brand);
  outline: 1px solid var(--line-blue);
  outline-offset: 2px;
}

.changelog-entries { min-width: 0; display: grid; gap: 8px; }

.changelog-entry {
  display: grid;
  grid-template-columns: 54px minmax(0, 1fr);
  align-items: start;
  gap: 13px;
  min-width: 0;
  padding: 12px 16px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--card);
  box-shadow: inset 0 1px 0 var(--highlight-inset);
  transition:
    border-color var(--av-dur-quick) var(--av-ease-standard),
    background var(--av-dur-quick) var(--av-ease-standard);
}

.changelog-entry:hover { border-color: var(--line-blue); background: var(--row-hover); }

.changelog-kind {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 22px;
  padding: 0 8px;
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-badge);
  font-size: 11px;
  font-weight: 600;
  line-height: 1;
  white-space: nowrap;
}

.changelog-kindFeature { border-color: var(--line-blue); color: var(--brand-hover); background: var(--brand-soft); }
.changelog-kindImprove { border-color: var(--line-warn); color: var(--warn); background: var(--warn-bg); }
.changelog-kindFix { color: var(--ink-2); background: var(--todo-bg); }
.changelog-kindMobile { border-color: var(--line-blue); color: var(--brand); background: var(--brand-soft); }
.changelog-kindFinance { border-color: var(--line-done); color: var(--done); background: var(--done-bg); }
.changelog-kindArch {
  border-color: color-mix(in srgb, var(--data-violet) 42%, var(--line));
  color: var(--data-violet);
  background: var(--violet-soft);
}

.changelog-entryCopy { min-width: 0; }
.changelog-entry h3 {
  margin: 0;
  color: var(--ink);
  font-size: 14px;
  font-weight: 600;
  line-height: 1.45;
}
.changelog-entry p {
  margin: 4px 0 0;
  color: var(--ink-2);
  font-size: 13px;
  line-height: 1.65;
}

@media (prefers-reduced-motion: reduce) {
  .changelog-entry { transition: none; }
}

@media (max-width: 767px) {
  .changelog-hero {
    min-height: 0;
    gap: 18px;
    padding-top: 0;
  }

  .changelog-currentMark { min-width: 92px; padding: 10px 11px; }
  .changelog-currentMark strong { font-size: 16px; }
  .changelog-hero h1 { font-size: 30px; }
  .changelog-tabs { margin-top: 18px; }
  .changelog-tab { flex: 1 1 0; gap: 6px; padding: 0 6px; font-size: 12px; }

  .changelog-panelHead {
    gap: 16px;
    padding: 16px;
  }
  .changelog-panelHead h2 { font-size: 19px; }
  .changelog-panelHead p:last-child { font-size: 12px; }
  .changelog-count { min-width: 58px; padding-left: 10px; }
  .changelog-count strong { font-size: 19px; }

  .changelog-timeline { padding: 0 16px 16px; }
  .changelog-day {
    display: block;
    padding: 16px 0 0;
  }
  .changelog-dateColumn {
    display: flex;
    align-items: baseline;
    gap: 9px;
    padding: 0 0 8px;
    text-align: left;
  }
  .changelog-dateColumn span { margin-top: 0; }
  .changelog-nodeColumn { display: none; }
  .changelog-entries { padding-left: 0; }
  .changelog-entry { grid-template-columns: 48px minmax(0, 1fr); gap: 8px; padding: 12px; }
  .changelog-entry p { font-size: 13px; }
}
`;
