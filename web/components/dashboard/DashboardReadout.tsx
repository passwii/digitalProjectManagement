"use client";

import type { ReactNode } from "react";
import CountUp from "@/components/motion/CountUp";
import s from "./DashboardReadout.module.css";

export type DashboardReadoutTone = "neutral" | "warn" | "danger" | "done";
export type DashboardReadoutAccent = "cyan" | "blue" | "violet" | "amber" | "coral" | "green";

export default function DashboardReadout({
  label,
  value,
  format,
  detail,
  tone = "neutral",
  accent = "cyan",
}: {
  label: string;
  value: number;
  format?: (value: number) => string;
  detail: ReactNode;
  tone?: DashboardReadoutTone;
  accent?: DashboardReadoutAccent;
}) {
  return (
    <article
      className={`${s.readout} ${s[tone]}`}
      data-dashboard-readout="true"
      data-testid="dashboard-readout"
      data-tone={tone}
      data-accent={accent}
      aria-label={label}
    >
      <div className={s.head}>
        <span className={s.label}>{label}</span>
        <span className={s.signal} aria-hidden="true" />
      </div>
      <div className={s.value} data-readout-value={value}>
        <CountUp value={value} format={format} />
      </div>
      <div className={s.detail}>{detail}</div>
    </article>
  );
}
