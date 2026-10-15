import type { CSSProperties } from "react";
import { useState } from "react";
import Link from "next/link";
import type { HealthRow } from "@/lib/api";
import { HEALTH_LABEL } from "@/lib/kpi";
import { fmtDate, fmtPct, projectStatusLabel } from "@/lib/labels";
import Empty from "@/components/ui/Empty";
import s from "./DashboardRouteField.module.css";

const PREVIEW_LIMIT = 3;

const toneClass: Record<HealthRow["health"], string> = {
  ok: s.ok,
  risk: s.risk,
  bad: s.bad,
  closed: s.closed,
};

function progressOf(value: number) {
  return Math.max(0, Math.min(100, Math.round(value || 0)));
}

export default function DashboardRouteField({ health }: { health: HealthRow[] }) {
  const [expanded, setExpanded] = useState(false);

  if (health.length === 0) {
    return (
      <div className={s.empty}>
        <Empty title="暂无项目航迹" hint="新建项目后，交付状态会显示在这里。" />
      </div>
    );
  }

  const visibleHealth = expanded ? health : health.slice(0, PREVIEW_LIMIT);

  return (
    <div className={s.field} id="dashboard-route-field">
      <ol className={s.list} id="dashboard-route-list" data-testid="dashboard-route-list">
        {visibleHealth.map((row, index) => {
          const progress = progressOf(row.progress);
          const state = HEALTH_LABEL[row.health] ?? row.health;
          return (
            <li
              key={row.id}
              className={`${s.route} ${toneClass[row.health]}`}
              data-dashboard-route="true"
              data-health={row.health}
              style={{ "--route-delay": `${index * 55}ms` } as CSSProperties}
            >
              <span className={s.routePin} aria-hidden="true" />
              <div className={s.routeBody}>
                <div className={s.routeHead}>
                  <div className={s.identity}>
                    <Link className={s.name} href={`/projects/${row.id}`}>
                      <span title={row.name}>{row.name}</span>
                    </Link>
                    <span className={s.code}>{row.code} · {projectStatusLabel(row.status)}</span>
                  </div>
                  <span className={s.state}>
                    <i aria-hidden="true" />
                    {state}
                  </span>
                </div>

                <div className={s.trackLine} aria-label={`${row.name} 加权进度 ${progress}%`}>
                  <span className={s.track} aria-hidden="true">
                    <span className={s.trackFill} style={{ transform: `scaleX(${progress / 100})` }} />
                    <span className={s.trackMarker} style={{ left: `${progress}%` }} />
                  </span>
                  <span className={s.progressValue}>{progress}%</span>
                </div>

                <div className={s.meta}>
                  <span>执行率 <b>{fmtPct(row.rate)}</b></span>
                  <span className={row.overdue_tasks > 0 ? s.alertValue : ""}>
                    逾期 <b>{row.overdue_tasks}</b>
                  </span>
                  <span>计划结束 <b>{fmtDate(row.plan_end)}</b></span>
                </div>
              </div>
            </li>
          );
        })}
      </ol>
      {health.length > PREVIEW_LIMIT && (
        <button
          className={s.expand}
          type="button"
          aria-expanded={expanded}
          aria-controls="dashboard-route-list"
          onClick={() => setExpanded((value) => !value)}
        >
          <span>{expanded ? "收起项目航迹" : `展开其余项目（${health.length - PREVIEW_LIMIT}）`}</span>
          <span className={`${s.expandIcon} ${expanded ? s.expandIconOpen : ""}`} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
