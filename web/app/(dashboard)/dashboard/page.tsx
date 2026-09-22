"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
import Badge from "@/components/ui/Badge";
import Empty from "@/components/ui/Empty";
import ProgressBar from "@/components/ui/ProgressBar";
import { LoadingBlock } from "@/components/ui/PageState";
import PageHeader from "@/components/ui/PageHeader";
import CountUp from "@/components/motion/CountUp";
import MotionStagger from "@/components/motion/MotionStagger";
import { useActivity } from "@/lib/useActivity";
import { isAbortError } from "@/lib/useAsyncData";

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
  const loadSeq = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const id = ++loadSeq.current;
    const finish = beginActivity({ label: "刷新工作台", scope: "content" });
    setLoading(true);
    setErr("");
    try {
      const [s, w] = await Promise.all([
        dashboardApi.summary(controller.signal),
        dashboardApi.weekly(0, controller.signal).catch(() => null),
      ]);
      if (controller.signal.aborted || loadSeq.current !== id) return;
      setData(s);
      setWeekly(w);
    } catch (e) {
      if (controller.signal.aborted || loadSeq.current !== id || isAbortError(e)) return;
      setErr(errText(e));
    } finally {
      if (loadSeq.current === id) setLoading(false);
      finish();
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  }, [beginActivity]);

  useEffect(() => {
    load();
    return () => {
      controllerRef.current?.abort();
      controllerRef.current = null;
    };
  }, [load]);

  if (loading && !data) return <LoadingBlock kpis={4} />;
  if (!data) return err ? <div className="err-banner" role="alert">{err}</div> : null;

  const k = data.kpi;
  const trendData = data.trend.map((t) => ({ ...t, label: t.month.slice(5) + "月" }));

  return (
    <div>
      <PageHeader
        title="工作台"
        actions={
          <>
          <button className="btn-ghost" onClick={load}>刷新</button>
          {isAdmin && (
            <Link className="btn-primary" href="/approvals">
              待审批 {k.pending_approvals}
            </Link>
          )}
          </>
        }
      />
      {err && <div className="err-banner" role="alert">{err}</div>}

      <MotionStagger>
      <div className="kpi-row">
        <div className="kpi"><div className="k">我的项目</div><div className="v"><CountUp value={k.my_projects} /></div><div className="tiny">进行中 <CountUp value={k.active_projects} /></div></div>
        <div className="kpi"><div className="k">逾期任务</div><div className="v" style={k.overdue_tasks > 0 ? { color: "var(--danger)" } : undefined}><CountUp value={k.overdue_tasks} /></div><div className="tiny">我负责 <CountUp value={k.my_overdue_tasks} /></div></div>
        {isAdmin ? (
          <div className="kpi"><div className="k">待我审批</div><div className="v" style={k.pending_approvals > 0 ? { color: "var(--warn)" } : undefined}><CountUp value={k.pending_approvals} /></div><div className="tiny">未读通知 <CountUp value={k.unread_notifications} /></div></div>
        ) : (
          <div className="kpi"><div className="k">未读通知</div><div className="v"><CountUp value={k.unread_notifications} /></div><div className="tiny">审批结果会通过通知告知您</div></div>
        )}
        <div className="kpi"><div className="k">{k.month} 支出</div><div className="v"><CountUp value={k.month_spent} format={fmtMoney} /></div><div className="tiny">按已通过支出统计</div></div>
      </div>
      <div className="split">
        <div className="card">
          <h3 className="section-title" style={{ marginTop: 0 }}>近 6 个月支出趋势</h3>
          {trendData.every((t) => t.spent === 0) ? (
            <Empty title="暂无支出数据" hint="登记支出后显示趋势。" />
          ) : (
            <div style={{ width: "100%", height: 220 }}>
              <ResponsiveContainer>
                <LineChart data={trendData} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
                  <CartesianGrid stroke="#eef0f4" vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 12, fill: "#8993a4" }} axisLine={{ stroke: "#e3e6eb" }} tickLine={false} />
                  <YAxis tick={{ fontSize: 12, fill: "#8993a4" }} axisLine={false} tickLine={false} width={64}
                    tickFormatter={(v) => (Number(v) >= 10000 ? `${Math.round(Number(v) / 10000)}万` : String(v))} />
                  <Tooltip formatter={(v) => [`${fmtMoney(Number(v))} 元`, "支出"]} contentStyle={{ fontSize: 12, borderRadius: 6, border: "1px solid #e3e6eb" }} />
                  <Line type="monotone" dataKey="spent" stroke="#1677FF" strokeWidth={2} dot={{ r: 3 }} activeDot={{ r: 5 }} name="支出"
                    isAnimationActive={!reduced} animationDuration={500} animationBegin={0} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        <div className="card">
          <h3 className="section-title" style={{ marginTop: 0 }}>人员支出构成</h3>
          {data.by_subject.length === 0 ? (
            <Empty title="暂无人员支出数据" hint="登记支出后显示人员维度占比。" />
          ) : (
            <div style={{ width: "100%", height: 220 }}>
              <ResponsiveContainer>
                <PieChart>
                  <Pie data={data.by_subject} dataKey="spent" nameKey="subject" innerRadius={42} outerRadius={64} paddingAngle={2}
                    isAnimationActive={!reduced} animationDuration={500} animationBegin={80}>
                    {data.by_subject.map((s, i) => (
                      <Cell key={s.subject} fill={SUBJECT_COLORS[i % SUBJECT_COLORS.length]} />
                    ))}
                  </Pie>
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Tooltip formatter={(v) => `${fmtMoney(Number(v))} 元`} contentStyle={{ fontSize: 12, borderRadius: 6, border: "1px solid #e3e6eb" }} />
                </PieChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      </div>

      <div className="split" style={{ marginTop: 16 }}>
        <div>
          <h2 className="section-title">项目健康度</h2>
          {data.health.length === 0 ? (
            <div className="card"><Empty title="暂无项目" hint="新建项目后显示健康度。" /></div>
          ) : (
            <div className="table-scroll health-table-scroll">
              <table className="grid health-table">
              <thead>
                <tr><th>项目</th><th>健康度</th><th>{PROGRESS_LABEL.weighted}</th><th className="num">{MONEY_LABEL.rate}</th><th className="num">逾期</th></tr>
              </thead>
              <tbody>
                {data.health.map((h) => (
                  <tr key={h.id}>
                    <td>
                      <Link href={`/projects/${h.id}`}><span className="ellipsis" title={h.name}>{h.name}</span></Link>
                      <div className="tiny mono">{h.code} · {projectStatusLabel(h.status)}</div>
                    </td>
                    <td><Badge status={HEALTH_LABEL[h.health]} tone={HEALTH_TONE[h.health]} /></td>
                    <td style={{ minWidth: 130 }}><ProgressBar value={h.progress} tone="brand" /></td>
                    <td className="num" style={rateBadge(h.rate)?.tone === "danger" ? { color: "var(--danger)" } : undefined}>
                      {fmtPct(h.rate)}{rateBadge(h.rate) ? <span className="muted"> · {rateBadge(h.rate)!.status}</span> : null}
                    </td>
                    <td className="num" style={h.overdue_tasks > 0 ? { color: "var(--danger)" } : undefined}>{h.overdue_tasks}</td>
                  </tr>
                ))}
              </tbody>
              </table>
            </div>
          )}
        </div>

        <div>
          <h2 className="section-title">
            本周动态
            {weekly && <span className="sub">近 7 天填报 <CountUp value={weekly.log_count} /> 条</span>}
          </h2>
          <div className="card">
            {!weekly || (weekly.progress_logs.length === 0 && weekly.overdue.length === 0 && weekly.due_soon.length === 0) ? (
              <Empty title="本周暂无动态" hint="成员填报进度后显示。" />
            ) : (
              <>
                {weekly.overdue.length > 0 && (
                  <div style={{ marginBottom: 10 }}>
                    <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>逾期任务 {weekly.overdue.length}</div>
                    <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
                      {weekly.overdue.slice(0, 4).map((t) => (
                        <li key={t.id}>{t.name} <span className="tiny mono">截止 {fmtDate(t.plan_end)}</span></li>
                      ))}
                    </ul>
                  </div>
                )}
                {weekly.due_soon.length > 0 && (
                  <div style={{ marginBottom: 10 }}>
                    <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>7 天内到期 {weekly.due_soon.length}</div>
                    <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
                      {weekly.due_soon.slice(0, 4).map((t) => (
                        <li key={t.id}>{t.name} <span className="tiny mono">{fmtDate(t.plan_end)}</span></li>
                      ))}
                    </ul>
                  </div>
                )}
                {weekly.progress_logs.length > 0 && (
                  <div>
                    <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>最近填报</div>
                    <ul className="timeline">
                      {weekly.progress_logs.slice(0, 6).map((l, i) => (
                        <li key={`${l.task_id}-${i}`}>
                          <span className="t mono">{fmtDateTime(l.created_at)}</span>
                          <span>
                            任务#{l.task_id} 填报 <b className="mono">{l.progress}%</b>
                            {l.note ? ` · ${l.note}` : ""}
                            <span className="tiny"> · {userName(l.user_id)}</span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            )}
          </div>
          <p className="tiny" style={{ marginTop: 8 }}>
            部门：{deptName(me?.dept_id ?? null)} · 统计口径与报表一致（已通过支出）
          </p>
        </div>
      </div>
      </MotionStagger>
    </div>
  );
}
