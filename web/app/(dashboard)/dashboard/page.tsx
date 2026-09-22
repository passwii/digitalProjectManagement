"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useReducedMotion } from "framer-motion";
import {
  CartesianGrid, Cell, Legend, Line, LineChart, Pie, PieChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { dashboardApi, errText, type DashboardSummary, type Weekly } from "@/lib/api";
import { useMe, useMeta, useMenus } from "@/lib/useMeta";
import { HEALTH_LABEL, HEALTH_TONE, MONEY_LABEL, PROGRESS_LABEL, rateBadge } from "@/lib/kpi";
import { fmtDate, fmtMoney, fmtPct, fmtDateTime, projectStatusLabel } from "@/lib/labels";
import DashboardMetricCard from "@/components/dashboard/DashboardMetricCard";
import Badge from "@/components/ui/Badge";
import Empty from "@/components/ui/Empty";
import ProgressBar from "@/components/ui/ProgressBar";
import { LoadingBlock } from "@/components/ui/PageState";
import PageHeader from "@/components/ui/PageHeader";
import CountUp from "@/components/motion/CountUp";
import MotionStagger from "@/components/motion/MotionStagger";
import { useActivity } from "@/lib/useActivity";
import s from "./dashboard.module.css";

const SUBJECT_COLORS = ["#1677FF", "#5B8DEF", "#7C5CFC", "#2C9C69", "#D48806"];

export default function DashboardPage() {
  const { userName, deptName } = useMeta();
  const { me } = useMe();
  // 审批入口与管理/审批权限均以后端菜单契约为准，不再自行拼角色判断
  const { isAdmin } = useMenus();
  const { beginActivity } = useActivity();
  const reduced = useReducedMotion();
  const [data, setData] = useState<DashboardSummary | null>(null);
  const [weekly, setWeekly] = useState<Weekly | null>(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const finish = beginActivity({ label: "刷新工作台", scope: "content" });
    setLoading(true);
    setErr("");
    try {
      const [s, w] = await Promise.all([
        dashboardApi.summary(),
        dashboardApi.weekly().catch(() => null),
      ]);
      setData(s);
      setWeekly(w);
    } catch (e) {
      setErr(errText(e));
    } finally {
      setLoading(false);
      finish();
    }
  }, [beginActivity]);

  useEffect(() => { load(); }, [load]);

  if (!data) {
    if (loading) return <LoadingBlock kpis={4} />;
    return (
      <div className={s.initialError} role="alert">
        <strong>工作台加载失败</strong>
        <span>{err || "暂时无法获取工作台数据。"}</span>
        <button className="btn-primary" type="button" onClick={load}>重试</button>
      </div>
    );
  }

  const k = data.kpi;
  const trendData = data.trend.map((t) => ({ ...t, label: t.month.slice(5) + "月" }));

  return (
    <div className={s.dashboard} data-dashboard-page="true" aria-busy={loading}>
      <PageHeader
        title="工作台"
        className={s.pageHeader}
        actions={
          <>
            <button
              className="btn-ghost"
              type="button"
              onClick={load}
              disabled={loading}
              aria-busy={loading}
            >
              {loading ? "刷新中" : "刷新"}
            </button>
            {isAdmin && (
              <Link className="btn-primary" href="/approvals">
                待审批 {k.pending_approvals}
              </Link>
            )}
          </>
        }
      />

      {err && (
        <div className={s.staleBanner} role="alert">
          <span>刷新失败，以下为上次成功数据。{err}</span>
          <button className="btn-ghost" type="button" onClick={load} disabled={loading}>重试</button>
        </div>
      )}

      <MotionStagger className={s.motion}>
        <div className={s.metricGrid}>
          <DashboardMetricCard
            label="我的项目"
            value={k.my_projects}
            detail={<>进行中 <CountUp value={k.active_projects} /></>}
          />
          <DashboardMetricCard
            label="逾期任务"
            value={k.overdue_tasks}
            tone={k.overdue_tasks > 0 ? "danger" : "neutral"}
            detail={<>我负责 <CountUp value={k.my_overdue_tasks} /></>}
          />
          {isAdmin ? (
            <DashboardMetricCard
              label="待我审批"
              value={k.pending_approvals}
              tone={k.pending_approvals > 0 ? "warn" : "neutral"}
              detail={<>未读通知 <CountUp value={k.unread_notifications} /></>}
            />
          ) : (
            <DashboardMetricCard
              label="未读通知"
              value={k.unread_notifications}
              detail="审批结果会通过通知告知您"
            />
          )}
          <DashboardMetricCard
            label={k.month + " 支出"}
            value={k.month_spent}
            format={fmtMoney}
            detail="按已通过支出统计"
          />
        </div>

        <div className={s.chartGrid}>
          <section className={`${s.surface} ${s.chartSurface}`} aria-labelledby="dashboard-trend-title">
            <h2 id="dashboard-trend-title" className={s.sectionTitle}>近 6 个月支出趋势</h2>
            {trendData.every((t) => t.spent === 0) ? (
              <Empty title="暂无支出数据" hint="登记支出后显示趋势。" />
            ) : (
              <div className={s.chart}>
                <ResponsiveContainer>
                  <LineChart data={trendData} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
                    <CartesianGrid stroke="#e8eef5" vertical={false} />
                    <XAxis dataKey="label" tick={{ fontSize: 13, fill: "#78879a" }} axisLine={{ stroke: "#dce5ee" }} tickLine={false} />
                    <YAxis tick={{ fontSize: 13, fill: "#78879a" }} axisLine={false} tickLine={false} width={64}
                      tickFormatter={(v) => (Number(v) >= 10000 ? `${Math.round(Number(v) / 10000)}万` : String(v))} />
                    <Tooltip formatter={(v) => [`${fmtMoney(Number(v))} 元`, "支出"]} contentStyle={{ fontSize: 13, borderRadius: 8, border: "1px solid #dce5ee" }} />
                    <Line type="monotone" dataKey="spent" stroke="#2879ff" strokeWidth={2.2} dot={{ r: 3 }} activeDot={{ r: 5 }} name="支出"
                      isAnimationActive={!reduced} animationDuration={500} animationBegin={0} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
          </section>

          <section className={`${s.surface} ${s.chartSurface}`} aria-labelledby="dashboard-subject-title">
            <h2 id="dashboard-subject-title" className={s.sectionTitle}>人员支出构成</h2>
            {data.by_subject.length === 0 ? (
              <Empty title="暂无人员支出数据" hint="登记支出后显示人员维度占比。" />
            ) : (
              <div className={s.chart}>
                <ResponsiveContainer>
                  <PieChart>
                    <Pie data={data.by_subject} dataKey="spent" nameKey="subject" innerRadius={42} outerRadius={64} paddingAngle={2}
                      isAnimationActive={!reduced} animationDuration={500} animationBegin={80}>
                      {data.by_subject.map((subject, i) => (
                        <Cell key={subject.subject} fill={SUBJECT_COLORS[i % SUBJECT_COLORS.length]} />
                      ))}
                    </Pie>
                    <Legend wrapperStyle={{ fontSize: 13 }} />
                    <Tooltip formatter={(v) => `${fmtMoney(Number(v))} 元`} contentStyle={{ fontSize: 13, borderRadius: 8, border: "1px solid #dce5ee" }} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            )}
          </section>
        </div>

        <div className={s.detailGrid}>
          <section className={s.healthBlock} aria-labelledby="dashboard-health-title">
            <h2 id="dashboard-health-title" className={s.sectionTitle}>项目健康度</h2>
            {data.health.length === 0 ? (
              <div className={s.surface}><Empty title="暂无项目" hint="新建项目后显示健康度。" /></div>
            ) : (
              <div className={s.healthTableScroll}>
                <table className={`grid ${s.healthTable}`}>
                  <thead>
                    <tr><th>项目</th><th>健康度</th><th>{PROGRESS_LABEL.weighted}</th><th className="num">{MONEY_LABEL.rate}</th><th className="num">逾期</th></tr>
                  </thead>
                  <tbody>
                    {data.health.map((health) => {
                      const rate = rateBadge(health.rate);
                      return (
                        <tr key={health.id}>
                          <td>
                            <Link href={`/projects/${health.id}`}><span className="ellipsis" title={health.name}>{health.name}</span></Link>
                            <div className="tiny mono">{health.code} · {projectStatusLabel(health.status)}</div>
                          </td>
                          <td><Badge status={HEALTH_LABEL[health.health]} tone={HEALTH_TONE[health.health]} /></td>
                          <td className={s.progressCell}><ProgressBar value={health.progress} tone="brand" /></td>
                          <td className={`num ${rate?.tone === "danger" ? s.valueDanger : ""}`}>
                            {fmtPct(health.rate)}{rate ? <span className="muted"> · {rate.status}</span> : null}
                          </td>
                          <td className={`num ${health.overdue_tasks > 0 ? s.valueDanger : ""}`}>{health.overdue_tasks}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className={s.activityBlock} aria-labelledby="dashboard-activity-title">
            <h2 id="dashboard-activity-title" className={s.sectionTitle}>
              本周动态
              {weekly && <span className={s.sectionSub}>近 7 天填报 <CountUp value={weekly.log_count} /> 条</span>}
            </h2>
            <div className={`${s.surface} ${s.activityCard}`}>
              {!weekly || (weekly.progress_logs.length === 0 && weekly.overdue.length === 0 && weekly.due_soon.length === 0) ? (
                <Empty title="本周暂无动态" hint="成员填报进度后显示。" />
              ) : (
                <>
                  {weekly.overdue.length > 0 && (
                    <div className={s.activityGroup}>
                      <div className={s.activityLabel}>逾期任务 {weekly.overdue.length}</div>
                      <ul className={s.activityList}>
                        {weekly.overdue.slice(0, 4).map((task) => (
                          <li key={task.id}>{task.name} <span className="tiny mono">截止 {fmtDate(task.plan_end)}</span></li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {weekly.due_soon.length > 0 && (
                    <div className={s.activityGroup}>
                      <div className={s.activityLabel}>7 天内到期 {weekly.due_soon.length}</div>
                      <ul className={s.activityList}>
                        {weekly.due_soon.slice(0, 4).map((task) => (
                          <li key={task.id}>{task.name} <span className="tiny mono">{fmtDate(task.plan_end)}</span></li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {weekly.progress_logs.length > 0 && (
                    <div>
                      <div className={s.activityLabel}>最近填报</div>
                      <ul className="timeline">
                        {weekly.progress_logs.slice(0, 6).map((log, i) => (
                          <li key={`${log.task_id}-${i}`}>
                            <span className="t mono">{fmtDateTime(log.created_at)}</span>
                            <span>
                              任务#{log.task_id} 填报 <b className="mono">{log.progress}%</b>
                              {log.note ? ` · ${log.note}` : ""}
                              <span className="tiny"> · {userName(log.user_id)}</span>
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </>
              )}
            </div>
            <p className={`tiny ${s.metaNote}`}>
              部门：{deptName(me?.dept_id ?? null)} · 统计口径与报表一致（已通过支出）
            </p>
          </section>
        </div>
      </MotionStagger>
    </div>
  );
}
