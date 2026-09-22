"use client";

import type { ReactNode } from "react";
import CountUp from "@/components/motion/CountUp";
import s from "./DashboardMetricCard.module.css";

export type DashboardMetricTone = "neutral" | "warn" | "danger" | "done";

export default function DashboardMetricCard({
  label,
  value,
  format,
  detail,
  tone = "neutral",
}: {
  label: string;
  value: number;
  format?: (value: number) => string;
  detail: ReactNode;
  tone?: DashboardMetricTone;
}) {
  return (
    <article
      className={`${s.card} ${s[tone]}`}
      data-dashboard-metric="true"
      data-testid="dashboard-metric"
      data-tone={tone}
      aria-label={label}
    >
      <div className={s.head}>
        <span className={s.label}>{label}</span>
        <span className={s.signal} aria-hidden="true" />
      </div>
      <div className={s.value} data-metric-value={value}>
        <CountUp value={value} format={format} />
      </div>
      <div className={s.detail}>{detail}</div>
    </article>
  );
}
