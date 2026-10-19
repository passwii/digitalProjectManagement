import type { CSSProperties, ReactNode } from "react";
import AvGlyph from "./AvGlyph";
import type { AvIconName } from "@/lib/av/navigation";
import type { AvTone } from "@/lib/av/labels";
import { levelMeta } from "@/lib/av/labels";
import { toneVar } from "@/lib/av/tone";
import s from "./AvUI.module.css";

/**
 * AV 通用视觉件。
 *
 * 三条约定：
 *   · 颜色只通过 CSS 自定义属性（`--tone` / `--metric-tone` / `--badge-*`）注入，
 *     值一律是 `var(--av-*)` 的引用，本文件里不存在任何颜色字面量；
 *   · 所有会被 Stage 3 加动效的元素都带 `data-motion-*` 标记：稳定的 key + 稳定的
 *     DOM 顺序，动效层只需要挂载，不需要改结构；
 *   · 动效只在 CSS 里声明（时长取 `--av-dur-*` / 曲线取 `--av-ease-*`），`?static=1`
 *     与减少动效由根节点的统一开关一次关掉 —— 所以截图、弱网首帧、JS 未水合
 *     看到的是同一个静态页面。
 *
 * 为什么本文件**没有** "use client"：Stage 3 的动效全部落在 CSS 上（时长取
 * `--av-dur-*`，`?static=1` / 减少动效由根节点的全局开关一次性关掉），所以这一层
 * 不需要任何 hook。保持「服务端可直接渲染」有两个好处：
 *   · capability / __stress / audio 空态这些服务端页面不会因为 import 本文件就把
 *     整棵子树拖进客户端 bundle；
 *   · 本文件导出的组件里没有函数型 props，不会触发 RSC 的
 *     「Props must be serializable」告警。
 * 真正需要 hook / framer 的三件（Tab 滑块、KPI 数字滚动）分别在
 * `components/av/AvTabs.tsx` 与 `components/av/motion/AvCounter.tsx` 里。
 */

function toneStyle(tone: AvTone): CSSProperties {
  return { "--tone": toneVar(tone) } as CSSProperties;
}

export function AvPageHeader({
  title,
  subtitle,
  route,
  actions,
  aside,
}: {
  title: string;
  subtitle: string;
  route: string;
  actions?: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <header className={s.pageHeader} data-motion="page-header">
      <div className={s.pageHeading}>
        <div className={s.routeLine}>
          <i aria-hidden="true" />
          {route}
        </div>
        <h1>{title}</h1>
        <p>{subtitle}</p>
      </div>
      <div className={s.headerAside}>
        {aside}
        {actions}
      </div>
    </header>
  );
}

export function AvPanel({
  title,
  subtitle,
  meta,
  icon,
  action,
  children,
  flush = false,
  motionKey,
  className,
}: {
  title: string;
  subtitle?: string;
  meta?: string;
  icon?: AvIconName;
  action?: ReactNode;
  children: ReactNode;
  flush?: boolean;
  motionKey?: string;
  className?: string;
}) {
  return (
    <section className={`${s.panel} ${className ?? ""}`} data-motion="panel" data-motion-key={motionKey}>
      <div className={s.panelHeader}>
        <div className={s.panelTitle}>
          {icon && <AvGlyph name={icon} size={15} />}
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
        </div>
        {action ?? (meta ? <span className={s.panelMeta}>{meta}</span> : null)}
      </div>
      <div className={`${s.panelBody} ${flush ? s.panelFlush : ""}`}>{children}</div>
    </section>
  );
}

export function AvMetric({
  label,
  value,
  unit,
  detail,
  note,
  tone,
  icon,
}: {
  label: string;
  /** 数字本体：字符串，或调用方传入的滚动组件（`AvCounter`） */
  value: ReactNode;
  unit?: string;
  detail: string;
  note?: string;
  tone: AvTone;
  icon?: AvIconName;
}) {
  return (
    <article
      className={s.metric}
      style={{ "--metric-tone": toneVar(tone) } as CSSProperties}
      data-motion="metric"
      data-motion-key={label}
      data-tone={tone}
    >
      <div className={s.metricHead}>
        <span>{label}</span>
        {icon && <AvGlyph name={icon} size={15} />}
      </div>
      <div className={s.metricValue}>
        {/* KPI 数字进入视口时从 0 滚到目标值（slow）；tabular-nums 由 CSS 给，不抖 */}
        <strong>{value}</strong>
        {unit && <span>{unit}</span>}
      </div>
      <div className={s.metricFoot}>
        <span>{detail}</span>
        {note && <small>{note}</small>}
      </div>
    </article>
  );
}

/**
 * 告警级别徽标：**颜色 + 文字双通道**。
 * `data-level` 供 CSS 取色，`data-downgraded` 用虚线描边表达「误报观察期」，
 * 文字用数据自带的 `level_label`（如「二级·紧急」）；缺省回落到本地表。
 */
export function AvLevelBadge({
  level,
  label,
  downgraded = false,
}: {
  level: number;
  label?: string;
  downgraded?: boolean;
}) {
  const meta = levelMeta(level as 1 | 2 | 3 | 4);
  const text = (label ?? "").trim() || meta.label;
  /*
   * 一级告警色条的 3s 呼吸由 CSS 按 `data-level="1"` 选中（AvUI.module.css），
   * 不在 JS 里再判一次：服务端渲染出的 HTML 必须已经带上这个行为，否则
   * 水合前那一屏就没有呼吸，截图 / 录屏对不上。
   */
  return (
    <span
      className={s.levelBadge}
      data-level={level}
      data-downgraded={downgraded || undefined}
      style={
        {
          "--badge-tone": `var(--av-level-${level})`,
          "--badge-soft": `var(--av-level-${level}-soft)`,
          "--badge-line": `var(--av-level-${level}-line)`,
        } as CSSProperties
      }
      title={`告警级别：${text}`}
    >
      <i className={s.levelSwatch} aria-hidden="true" />
      <span>{text}</span>
    </span>
  );
}

export function AvStatusBadge({
  tone,
  children,
  swap = false,
}: {
  tone: AvTone;
  children: ReactNode;
  /**
   * 是否为「状态变更」播一次弹入（quick，0.9 → 1）。
   *
   * 默认关闭：告警列表一屏 50 个徽标，若都带入场动画会变成满屏跳动 ——
   * 与「多个元素同时持续循环动」是同一类噪音（§五 反面清单）。
   * 只有真的会变的地方（翻页新增的行、实时告警流逐条揭示）传 true。
   */
  swap?: boolean;
}) {
  return (
    <span
      /*
       * `key` 换掉节点让 CSS 动画重播，而不是在内部再套一层动画 wrapper：
       * DOM 结构不变（`closest("span")` 拿到的仍是带 `--tone` 的徽标本身），
       * 外面的 `.tag` 样式与主题用例都不受影响。key 是 `String(children)` +
       * `swap`，服务端与客户端算出来一致，不引入水合差异。
       */
      key={`${String(children)}-${swap}`}
      className={`${s.tag} ${swap ? s.swapIn : ""}`}
      data-tone={tone}
      style={toneStyle(tone)}
    >
      {children}
    </span>
  );
}

export function AvBar({
  label,
  value,
  max,
  tone,
  detail,
}: {
  label: string;
  value: number;
  max: number;
  tone: AvTone;
  detail?: string;
}) {
  const percent = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  return (
    <div className={s.bar} style={toneStyle(tone)}>
      <div className={s.barHead}>
        <span>{label}</span>
        <strong>{detail ?? value}</strong>
      </div>
      <div
        className={s.barTrack}
        role="progressbar"
        aria-valuenow={Math.round(percent)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
      >
        {/* 宽度是最终值（不参与动画）；入场由 `.barFill` 的 scaleX 关键帧完成 */}
        <span className={s.barFill} style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

export function AvLegend({ items }: { items: { label: string; value?: string; tone: AvTone }[] }) {
  return (
    <div className={s.legend}>
      {items.map((item) => (
        <span key={item.label} className={s.legendItem} style={toneStyle(item.tone)}>
          <i aria-hidden="true" />
          {item.label}
          {item.value != null && <strong>{item.value}</strong>}
        </span>
      ))}
    </div>
  );
}

export function AvEmpty({ title, hint }: { title: string; hint: string }) {
  return (
    <div className={s.empty} data-motion="empty">
      <strong>{title}</strong>
      <span>{hint}</span>
    </div>
  );
}

export function AvKV({ rows }: { rows: { label: string; value: ReactNode }[] }) {
  return (
    <dl className={s.kv}>
      {rows.map((row) => (
        <div key={row.label} style={{ display: "contents" }}>
          <dt>{row.label}</dt>
          <dd>{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function AvTableWrap({ children, caption }: { children: ReactNode; caption?: string }) {
  return (
    <div className={s.tableWrap}>
      <table className={s.table}>
        {caption && <caption>{caption}</caption>}
        {children}
      </table>
    </div>
  );
}
