import type { CSSProperties, ReactNode } from "react";
import AvGlyph from "./AvGlyph";
import type { AvIconName } from "@/lib/av/navigation";
import type { AvTone } from "@/lib/av/labels";
import { levelMeta } from "@/lib/av/labels";
import s from "./AvUI.module.css";

/**
 * AV 通用视觉件。
 *
 * 两条约定：
 *   · 颜色只通过 CSS 自定义属性（`--tone` / `--metric-tone` / `--badge-*`）注入，
 *     值一律是 `var(--av-*)` 的引用，本文件里不存在任何颜色字面量；
 *   · 所有会被 Stage 3 加动效的元素都带 `data-motion-*` 标记：稳定的 key + 稳定的
 *     DOM 顺序，动效层只需要挂载，不需要改结构。
 */

export function toneVar(tone: AvTone): string {
  return `var(--av-tone-${tone})`;
}

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
  value: string;
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

export function AvStatusBadge({ tone, children }: { tone: AvTone; children: ReactNode }) {
  return (
    <span className={s.tag} data-tone={tone} style={toneStyle(tone)}>
      {children}
    </span>
  );
}

export function AvTabs<T extends string>({
  items,
  value,
  onChange,
  ariaLabel,
}: {
  items: readonly { value: T; label: string; count?: number }[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
}) {
  return (
    <div className={s.tabs} role="group" aria-label={ariaLabel}>
      {items.map((item) => {
        const active = item.value === value;
        return (
          <button
            key={item.value}
            type="button"
            className={`${s.tab} ${active ? s.tabActive : ""}`}
            aria-pressed={active}
            onClick={() => onChange(item.value)}
          >
            {item.label}
            {item.count != null && <span className={s.tabCount}>{item.count}</span>}
          </button>
        );
      })}
    </div>
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
