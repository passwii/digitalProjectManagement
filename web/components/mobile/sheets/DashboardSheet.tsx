"use client";

// 工作台抽屉（BLF-1127 / S4，§3 第一行）：快捷跳转卡。
//
// 五张卡与桌面工作台 KPI 同口径，不新造统计：
//   · 待我审批 / 未读通知 —— `dashboard/summary.kpi`（与 `dashboard/page.tsx` 同一字段）；
//   · 待填报 / 逾期 —— `dashboard/my-weekly`（与工作台「近 7 天」区块同一来源）；
//   · 临近里程碑 / 本月支出 —— `summary.kpi.near_milestones / month_spent`。
// 「今日待填报」没有精确到日的接口：值取 7 天内到期的任务数，note 如实写
// 「7 天内到期」，不伪造今日口径。
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
  variant,
  onSelect,
  canApprove,
}: SheetContentProps) {
  const { data, firstLoad, error, reload } = useAsyncData(async () => {
    const [summary, weekly] = await Promise.all([
      dashboardApi.summary(),
      dashboardApi.weekly().catch(() => null),
    ]);
    return { summary, weekly };
  }, []);

  if (firstLoad)
    return <LoadingBlock title={false} kpis={4} label="加载工作台…" />;
  if (error || !data)
    return (
      <LoadFailed message={error || "加载失败，请重试"} onRetry={reload} />
    );

  const k = data.summary.kpi;
  const dueSoon = data.weekly?.due_soon.length ?? 0;
  const overdue = data.weekly?.overdue.length ?? 0;

  return (
    <>
      {canApprove ? (
        <SheetCard
          variant={variant}
          href="/approvals"
          title="待我审批"
          note={`未读通知 ${k.unread_notifications}`}
          value={String(k.pending_approvals)}
          tone={k.pending_approvals > 0 ? "warn" : "default"}
          onSelect={onSelect}
        />
      ) : (
        <SheetCard
          variant={variant}
          href="/dashboard"
          title="未读通知"
          note="审批结果会通过通知告知您"
          value={String(k.unread_notifications)}
          onSelect={onSelect}
        />
      )}
      <SheetCard
        variant={variant}
        href="/progress"
        title="待填报"
        note={
          overdue > 0 ? `7 天内到期 · 另有逾期 ${overdue}` : "7 天内到期的任务"
        }
        value={String(dueSoon)}
        onSelect={onSelect}
      />
      <SheetCard
        variant={variant}
        href="/progress"
        title="逾期任务"
        note={`我负责 ${k.my_overdue_tasks}`}
        value={String(k.overdue_tasks)}
        tone={k.overdue_tasks > 0 ? "danger" : "default"}
        onSelect={onSelect}
      />
      <SheetCard
        variant={variant}
        href="/progress"
        title="临近里程碑"
        note="近期到期"
        value={String(k.near_milestones)}
        tone={k.near_milestones > 0 ? "warn" : "default"}
        onSelect={onSelect}
      />
      <SheetCard
        variant={variant}
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
