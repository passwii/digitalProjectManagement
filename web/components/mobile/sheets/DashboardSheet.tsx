"use client";

// 工作台抽屉（BLF-1127 / S4，§3 第一行）：快捷跳转卡。
//
// 首页快捷卡与桌面工作台 KPI 同口径，不新造统计：
//   · 待我审批 / 未读通知 —— `dashboard/summary.kpi`（与 `dashboard/page.tsx` 同一字段）；
//   · 本月支出 —— `summary.kpi.month_spent`，通过 `/reports` 进入报表。
//
// D3 在这里的体现：`/approvals` 是必然 403 的入口，非管理员不渲染那张卡，
// 改为未读通知卡（§3.2：不展示必然 403 的按钮）。

import { dashboardApi } from "@/lib/api";
import { fmtMoney } from "@/lib/labels";
import { useAsyncData } from "@/lib/useAsyncData";
import { LoadFailed, LoadingBlock } from "@/components/ui/PageState";
import SheetCard from "../SheetCard";
import type { SheetContentProps } from "./index";

export default function DashboardSheet({
  onSelect,
  canApprove,
}: SheetContentProps) {
  const { data, firstLoad, error, reload } = useAsyncData(async (signal) => {
    const summary = await dashboardApi.summary(signal);
    return { summary };
  }, []);

  if (firstLoad)
    return <LoadingBlock title={false} kpis={4} label="加载工作台…" />;
  if (error || !data)
    return (
      <LoadFailed message={error || "加载失败，请重试"} onRetry={reload} />
    );

  const k = data.summary.kpi;
  return (
    <>
      {canApprove ? (
        <SheetCard
          href="/approvals"
          title="待我审批"
          note={`未读通知 ${k.unread_notifications}`}
          value={String(k.pending_approvals)}
          tone={k.pending_approvals > 0 ? "warn" : "default"}
          onSelect={onSelect}
        />
      ) : (
        <SheetCard
          href="/dashboard"
          title="未读通知"
          note="审批结果会通过通知告知您"
          value={String(k.unread_notifications)}
          onSelect={onSelect}
        />
      )}
      <SheetCard
        href="/reports"
        title={`${k.month}支出`}
        note="按已通过支出统计"
        value={`¥${fmtMoney(k.month_spent)}`}
        tone="brand"
        onSelect={onSelect}
      />
    </>
  );
}
