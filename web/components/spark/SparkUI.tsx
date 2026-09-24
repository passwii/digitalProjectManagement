import type { ReactNode } from "react";
import type { SparkIconName } from "@/lib/spark/navigation";
import SparkGlyph from "./SparkGlyph";
import s from "./SparkPages.module.css";

export type SparkTone = "cyan" | "violet" | "green" | "amber" | "rose" | "slate";

export function SparkPageHeader({
  title,
  subtitle,
  icon,
  status,
  actions,
}: {
  title: string;
  subtitle: string;
  icon: SparkIconName;
  status?: string;
  actions?: ReactNode;
}) {
  return (
    <div className={s.pageHeader}>
      <div className={s.pageHeading}>
        <div className={s.titleLine}>
          <SparkGlyph name={icon} size={22} className={s.titleIcon} />
          <h1>{title}</h1>
        </div>
        <p>{subtitle}</p>
      </div>
      <div className={s.headerActions}>
        {status && <span className={s.liveStatus}><i />{status}</span>}
        {actions}
      </div>
    </div>
  );
}

export function SparkMetric({
  label,
  value,
  unit,
  delta,
  detail,
  tone = "cyan",
  icon,
}: {
  label: string;
  value: string | number;
  unit?: string;
  delta?: string;
  detail?: string;
  tone?: SparkTone;
  icon?: SparkIconName;
}) {
  return (
    <article className={`${s.metricCard} ${s[`tone_${tone}`]}`}>
      <div className={s.metricHead}>
        <span>{label}</span>
        {icon && <SparkGlyph name={icon} size={17} />}
      </div>
      <div className={s.metricValue}>
        <strong>{value}</strong>
        {unit && <span>{unit}</span>}
      </div>
      <div className={s.metricFoot}>
        {delta && <span className={s.metricDelta}>{delta}</span>}
        {detail && <span className={s.metricDetail}>{detail}</span>}
      </div>
    </article>
  );
}

export function SparkPanel({
  title,
  subtitle,
  action,
  children,
  className,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`${s.panel} ${className ?? ""}`}>
      <div className={s.panelHeader}>
        <div>
          <h2>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        {action}
      </div>
      <div className={s.panelContent}>{children}</div>
    </section>
  );
}

export function SparkBadge({ children, tone = "slate" }: { children: ReactNode; tone?: SparkTone }) {
  return <span className={`${s.badge} ${s[`tone_${tone}`]}`}>{children}</span>;
}

export function SparkProgress({ value, tone = "cyan", label }: { value: number; tone?: SparkTone; label?: string }) {
  const normalized = Math.min(100, Math.max(0, value));
  return (
    <div className={s.progressWrap}>
      <div className={s.progressTrack} role="progressbar" aria-valuenow={normalized} aria-valuemin={0} aria-valuemax={100} aria-label={label ?? "完成度"}>
        <span className={`${s.progressFill} ${s[`fill_${tone}`]}`} style={{ width: `${normalized}%` }} />
      </div>
      {label && <span className={s.progressLabel}>{label}</span>}
    </div>
  );
}

export function SparkButton({
  children,
  onClick,
  variant = "ghost",
  type = "button",
  ariaLabel,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "ghost" | "primary" | "quiet";
  type?: "button" | "submit";
  ariaLabel?: string;
}) {
  return (
    <button type={type} className={`${s.button} ${s[`button_${variant}`]}`} onClick={onClick} aria-label={ariaLabel}>
      {children}
    </button>
  );
}

export function SparkTabs<T extends string>({
  items,
  value,
  onChange,
  label,
}: {
  items: readonly { value: T; label: string; count?: number }[];
  value: T;
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div className={s.tabs} role="group" aria-label={label}>
      {items.map((item) => (
        <button
          key={item.value}
          type="button"
          className={`${s.tab} ${value === item.value ? s.tabActive : ""}`}
          aria-pressed={value === item.value}
          onClick={() => onChange(item.value)}
        >
          {item.label}
          {item.count != null && <small>{item.count}</small>}
        </button>
      ))}
    </div>
  );
}

export function SparkToggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`${s.toggle} ${checked ? s.toggleOn : ""}`}
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  );
}
