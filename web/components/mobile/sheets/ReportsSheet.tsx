"use client";

import { dashboardApi } from "@/lib/api";
import { fmtMoney } from "@/lib/labels";
import { useAsyncData } from "@/lib/useAsyncData";
import { LoadFailed } from "@/components/ui/PageState";
import SheetCard from "../SheetCard";
import type { SheetContentProps } from "./index";
import s from "./sheets.module.css";

export default function ReportsSheet({ onSelect }: SheetContentProps) {
  const { data, error, reload } = useAsyncData(
    async (signal) => dashboardApi.summary(signal),
    [],
  );
  const k = data?.kpi;

  return (
    <>
      <SheetCard
        href="/reports"
        title="支出报表"
        note="科目 / 人员 / 项目维度"
        onSelect={onSelect}
      />
      {k ? (
        <SheetCard
          href="/reports"
          title={`${k.month}支出`}
          note="按已通过支出统计"
          value={`¥${fmtMoney(k.month_spent)}`}
          tone="brand"
          onSelect={onSelect}
        />
      ) : error ? (
        <div className={s.full}>
          <LoadFailed message={error} onRetry={reload} />
        </div>
      ) : null}
    </>
  );
}
