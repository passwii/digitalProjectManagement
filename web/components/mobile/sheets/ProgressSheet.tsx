"use client";

// 进度抽屉（BLF-1127 / S4，§3 第三行）：待填报 / 逾期 / 临近里程碑预览卡 + 待处理条目。
//
// 数据与桌面页同源，不新开接口：
//   · 待填报 / 逾期条目 —— `dashboard/my-weekly`（与工作台「近 7 天」区块同一来源，
//     含 `projects` 名称映射，不展示裸 `project_id`）；
//   · 临近里程碑 —— `reports/warnings.milestones`（`overdue=false` 的按 `days_left`
//     取最近，未返回时如实展示「–」，不把 0 当数据）。
// 条目落点是带 `project_id` 的进度跟踪页（与深链定位同参数），点进去即该项目的任务列表。

import { dashboardApi, reportsApi } from "@/lib/api";
import { fmtDate } from "@/lib/labels";
import { useAsyncData } from "@/lib/useAsyncData";
import Empty from "@/components/ui/Empty";
import { LoadFailed, LoadingBlock } from "@/components/ui/PageState";
import SheetCard from "../SheetCard";
import type { SheetContentProps } from "./index";
import s from "./sheets.module.css";

export default function ProgressSheet({
  variant,
  onSelect,
}: SheetContentProps) {
  const { data, firstLoad, error, reload } = useAsyncData(async (signal) => {
    const [weekly, warns] = await Promise.all([
      dashboardApi.weekly(0, signal).catch(() => null),
      reportsApi.warnings(signal).catch(() => null),
    ]);
    return { weekly, warns };
  }, []);

  if (firstLoad)
    return <LoadingBlock title={false} kpis={3} label="加载进度…" />;
  if (error || !data)
    return (
      <LoadFailed message={error || "加载失败，请重试"} onRetry={reload} />
    );

  const overdue = data.weekly?.overdue ?? [];
  const dueSoon = data.weekly?.due_soon ?? [];
  const projName = new Map(
    (data.weekly?.projects ?? []).map((p) => [p.id, p.name] as const),
  );
  const coming = (data.warns?.milestones ?? [])
    .filter((m) => !m.overdue)
    .sort((a, b) => a.days_left - b.days_left);
  const rows = [...overdue, ...dueSoon].slice(0, 6);

  return (
    <>
      <SheetCard
        variant={variant}
        href="/progress"
        title="待填报"
        note="7 天内到期的任务"
        value={String(dueSoon.length)}
        onSelect={onSelect}
      />
      <SheetCard
        variant={variant}
        href="/progress"
        title="逾期"
        note={
          overdue.length > 0
            ? `${overdue[0].name}等 ${overdue.length} 项`
            : "暂无逾期任务"
        }
        value={String(overdue.length)}
        tone={overdue.length > 0 ? "danger" : "default"}
        onSelect={onSelect}
      />
      <SheetCard
        variant={variant}
        href="/progress"
        title="临近里程碑"
        note={
          data.warns == null
            ? "里程碑数据暂不可用"
            : coming.length > 0
              ? `${coming[0].name} · ${coming[0].days_left} 天后`
              : "暂无临近里程碑"
        }
        value={data.warns == null ? "–" : String(coming.length)}
        tone={coming.length > 0 ? "warn" : "default"}
        onSelect={onSelect}
      />
      <div className={s.sec}>需要处理的条目</div>
      {rows.length === 0 ? (
        <div className={s.full}>
          <Empty title="暂无待处理" hint="逾期与近期到期的任务会列在这里。" />
        </div>
      ) : (
        rows.map((t) => (
          <SheetCard
            key={`${t.project_id}-${t.id}`}
            variant={variant}
            href={`/progress?project_id=${t.project_id}`}
            title={t.name}
            note={`${projName.get(t.project_id) ?? `项目#${t.project_id}`} · 截止 ${fmtDate(t.plan_end)}`}
            onSelect={onSelect}
          />
        ))
      )}
    </>
  );
}
