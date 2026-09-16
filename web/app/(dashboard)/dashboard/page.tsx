"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, Pie, PieChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { dashboardApi, errText, type DashboardSummary, type Weekly } from "@/lib/api";
import { useMe, useMeta, useMenus } from "@/lib/useMeta";
import { fmtDate, fmtMoney, fmtPct, fmtDateTime, projectStatusLabel } from "@/lib/labels";
import Badge from "@/components/ui/Badge";
import Empty from "@/components/ui/Empty";
import ProgressBar from "@/components/ui/ProgressBar";
import { LoadingBlock } from "@/components/ui/PageState";

const SUBJECT_COLORS = ["#2b5cff", "#0e7490", "#15803d", "#b45309", "#6d28d9"];

const HEALTH_LABEL: Record<string, string> = {
  ok: "正常",
  risk: "风险",
  bad: "异常",
  closed: "已关闭",
};
const HEALTH_TONE: Record<string, "done" | "warn" | "danger" | "paused"> = {
  ok: "done",
  risk: "warn",
  bad: "danger",
  closed: "paused",
};

export default function DashboardPage() {
  const { userName, deptName } = useMeta();
  const { me, displayName } = useMe();
  // 审批入口与管理/审批权限均以后端菜单契约为准，不再自行拼角色判断
  const { isAdmin } = useMenus();
  const [data, setData] = useState<DashboardSummary | null>(null);
  const [weekly, setWeekly] = useState<Weekly | null>(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setErr("");
    try {
      const [s, w] = await Promise.all([dashboardApi.summary(), dashboardApi.weekly().catch(() => null)]);
      setData(s);
      setWeekly(w);
    } catch (e) {
      setErr(errText(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) return <LoadingBlock kpis={4} />;
  if (err) return <div className="err-banner" role="alert">{err}</div>;
  if (!data) return null;

  const k = data.kpi;
  const trendData = data.trend.map((t) => ({ ...t, label: t.month.slice(5) + "月" }));

  return (
    <div>
      <div className="page-head">
        <h1>
          工作台
          <span className="sub">
            {displayName || "当前用户"} 视角
            <span className="mono">
              {" · "}
              {isAdmin ? "管理员 · 全局管理与审批" : "普通用户 · 项目参与"}
            </span>
          </span>
        </h1>
        <div className="actions no-print">
          <button className="btn-ghost" onClick={load}>刷新</button>
          <Link className="btn-ghost" href="/reports">成本报表</Link>
          {isAdmin && (
            <Link className="btn-primary" href="/approvals" style={{ display: "inline-flex", alignItems: "center", padding: "0 14px" }}>
              待审批 {k.pending_approvals}
            </Link>
          )}
        </div>
      </div>

      <div className="kpi-row">
        <div className="kpi"><div className="k">我的项目</div><div className="v mono">{k.my_projects}</div><div className="tiny">进行中 {k.active_projects}</div></div>
        <div className="kpi"><div className="k">逾期任务</div><div className="v mono" style={k.overdue_tasks > 0 ? { color: "var(--danger)" } : undefined}>{k.overdue_tasks}</div><div className="tiny">我负责 {k.my_overdue_tasks}</div></div>
        {isAdmin ? (
          <div className="kpi"><div className="k">待我审批</div><div className="v mono" style={k.pending_approvals > 0 ? { color: "var(--warn)" } : undefined}>{k.pending_approvals}</div><div className="tiny">未读通知 {k.unread_notifications}</div></div>
        ) : (
          <div className="kpi"><div className="k">未读通知</div><div className="v mono">{k.unread_notifications}</div><div className="tiny">审批结果会通过通知告知您</div></div>
        )}
        <div className="kpi"><div className="k">{k.month} 支出</div><div className="v mono">{fmtMoney(k.month_spent)}</div><div className="tiny">累计执行率 {fmtPct(k.total_rate)}</div></div>
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
                  <Line type="monotone" dataKey="spent" stroke="#2b5cff" strokeWidth={2} dot={{ r: 3 }} activeDot={{ r: 5 }} name="支出" />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        <div className="card">
          <h3 className="section-title" style={{ marginTop: 0 }}>科目支出构成</h3>
          {data.by_subject.length === 0 ? (
            <Empty title="暂无科目数据" hint="登记预算与支出后显示占比。" />
          ) : (
            <div style={{ width: "100%", height: 220 }}>
              <ResponsiveContainer>
                <PieChart>
                  <Pie data={data.by_subject} dataKey="spent" nameKey="subject" innerRadius={48} outerRadius={78} paddingAngle={2}>
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

      <div className="card" style={{ marginTop: 16 }}>
        <h3 className="section-title" style={{ marginTop: 0 }}>预算 vs 支出（按科目）</h3>
        {data.by_subject.length === 0 ? (
          <Empty title="暂无预算数据" hint="登记预算后显示对比。" />
        ) : (
          <div style={{ width: "100%", height: 240 }}>
            <ResponsiveContainer>
              <BarChart data={data.by_subject} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
                <CartesianGrid stroke="#eef0f4" vertical={false} />
                <XAxis dataKey="subject" tick={{ fontSize: 12, fill: "#8993a4" }} axisLine={{ stroke: "#e3e6eb" }} tickLine={false} />
                <YAxis tick={{ fontSize: 12, fill: "#8993a4" }} axisLine={false} tickLine={false} width={64}
                  tickFormatter={(v) => (Number(v) >= 10000 ? `${Math.round(Number(v) / 10000)}万` : String(v))} />
                <Tooltip formatter={(v) => `${fmtMoney(Number(v))} 元`} contentStyle={{ fontSize: 12, borderRadius: 6, border: "1px solid #e3e6eb" }} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="budget" fill="#c7d7fe" name="预算" radius={[3, 3, 0, 0]} />
                <Bar dataKey="spent" fill="#2b5cff" name="已支出" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      <div className="split" style={{ marginTop: 16 }}>
        <div>
          <h2 className="section-title">项目健康度</h2>
          {data.health.length === 0 ? (
            <div className="card"><Empty title="暂无项目" hint="新建项目后显示健康度。" /></div>
          ) : (
            <table className="grid">
              <thead>
                <tr><th>项目</th><th>健康度</th><th>进度</th><th className="num">执行率</th><th className="num">逾期</th></tr>
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
                    <td className="num" style={h.rate > 1 ? { color: "var(--danger)" } : undefined}>{fmtPct(h.rate)}</td>
                    <td className="num" style={h.overdue_tasks > 0 ? { color: "var(--danger)" } : undefined}>{h.overdue_tasks}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div>
          <h2 className="section-title">
            本周动态
            {weekly && <span className="sub">近 7 天填报 <span className="mono">{weekly.log_count}</span> 条</span>}
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
    </div>
  );
}
