import type { CSSProperties } from "react";
import Link from "next/link";
import type { DashboardKpi, Weekly } from "@/lib/api";
import { fmtDate, fmtDateTime } from "@/lib/labels";
import Empty from "@/components/ui/Empty";
import s from "./DashboardInterventionQueue.module.css";

type QueueTone = "signal" | "warn" | "danger" | "neutral";

interface QueueItem {
  id: string;
  tone: QueueTone;
  kind: string;
  title: string;
  meta: string;
  href: string;
}

function buildQueue(
  weekly: Weekly | null,
  kpi: DashboardKpi,
  isAdmin: boolean,
  userName: (id: number | null) => string,
): QueueItem[] {
  const items: QueueItem[] = [];

  if (isAdmin && kpi.pending_approvals > 0) {
    items.push({
      id: "approvals",
      tone: "warn",
      kind: "审批介入",
      title: `${kpi.pending_approvals} 项审批等待处理`,
      meta: "进入审批中心完成决策",
      href: "/approvals",
    });
  }

  if (!isAdmin && kpi.unread_notifications > 0) {
    items.push({
      id: "notifications",
      tone: "signal",
      kind: "通知介入",
      title: `${kpi.unread_notifications} 条未读通知`,
      meta: "审批结果和协作提醒已到达",
      href: "/dashboard",
    });
  }

  for (const task of weekly?.overdue.slice(0, 3) ?? []) {
    items.push({
      id: `overdue-${task.id}`,
      tone: "danger",
      kind: "逾期任务",
      title: task.name,
      meta: `截止 ${fmtDate(task.plan_end)} · 当前进度 ${task.progress}%`,
      href: `/projects/${task.project_id}`,
    });
  }

  for (const task of weekly?.due_soon.slice(0, 3) ?? []) {
    items.push({
      id: `due-${task.id}`,
      tone: "warn",
      kind: "临近到期",
      title: task.name,
      meta: `计划 ${fmtDate(task.plan_end)} · 当前进度 ${task.progress}%`,
      href: `/projects/${task.project_id}`,
    });
  }

  const progressLogs = weekly?.progress_logs.slice(0, 3) ?? [];
  for (let index = 0; index < progressLogs.length; index += 1) {
    const log = progressLogs[index];
    items.push({
      id: `log-${log.task_id}-${index}`,
      tone: "signal",
      kind: "进度留痕",
      title: `任务 #${log.task_id} 已填报 ${log.progress}%`,
      meta: `${fmtDateTime(log.created_at)} · ${userName(log.user_id)}${log.note ? ` · ${log.note}` : ""}`,
      href: `/projects/${log.project_id}`,
    });
  }

  return items.slice(0, 8);
}

export default function DashboardInterventionQueue({
  weekly,
  kpi,
  isAdmin,
  userName = () => "未署名",
}: {
  weekly: Weekly | null;
  kpi: DashboardKpi;
  isAdmin: boolean;
  userName?: (id: number | null) => string;
}) {
  const items = buildQueue(weekly, kpi, isAdmin, userName);

  if (items.length === 0) {
    return (
      <div className={s.empty} data-dashboard-intervention="empty">
        <Empty title="当前没有需要介入的事项" hint="项目、审批或填报出现变化后会在这里出现。" />
      </div>
    );
  }

  return (
    <ol className={s.list} data-testid="dashboard-intervention-list" data-dashboard-intervention="true">
      {items.map((item, index) => (
        <li
          className={`${s.item} ${s[item.tone]}`}
          key={item.id}
          style={{ "--queue-delay": `${index * 55}ms` } as CSSProperties}
        >
          <span className={s.pin} aria-hidden="true" />
          <Link className={s.link} href={item.href} aria-label={`${item.kind}：${item.title}`}>
            <span className={s.kind}>{item.kind}</span>
            <span className={s.title}>{item.title}</span>
            <span className={s.meta}>{item.meta}</span>
            <span className={s.arrow} aria-hidden="true">
              <svg viewBox="0 0 16 16" fill="none">
                <path d="M3 13 13 3M6 3h7v7" />
              </svg>
            </span>
          </Link>
        </li>
      ))}
    </ol>
  );
}
