"use client";

import type { ReactNode } from "react";
import CountUp from "@/components/motion/CountUp";
import s from "./DashboardReadout.module.css";

export type DashboardReadoutTone = "neutral" | "warn" | "danger" | "done";

export default function DashboardReadout({
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
  tone?: DashboardReadoutTone;
}) {
  return (
    <article
      className={`${s.readout} ${s[tone]}`}
      data-dashboard-readout="true"
      data-testid="dashboard-readout"
      data-tone={tone}
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
