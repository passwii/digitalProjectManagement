"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useReducedMotion } from "framer-motion";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { dashboardApi, errText, type DashboardSummary, type Weekly } from "@/lib/api";
import { useMe, useMeta, useMenus } from "@/lib/useMeta";
import { MONEY_LABEL } from "@/lib/kpi";
import { fmtMoney, fmtDateTime } from "@/lib/labels";
import DashboardInterventionQueue from "@/components/dashboard/DashboardInterventionQueue";
import DashboardReadout from "@/components/dashboard/DashboardReadout";
import DashboardRouteField from "@/components/dashboard/DashboardRouteField";
import Empty from "@/components/ui/Empty";
import { LoadingBlock } from "@/components/ui/PageState";
import PageHeader from "@/components/ui/PageHeader";
import CountUp from "@/components/motion/CountUp";
import MotionStagger from "@/components/motion/MotionStagger";
import { useActivity } from "@/lib/useActivity";
import s from "./dashboard.module.css";

const SUBJECT_SIGNALS = ["cyan", "lime", "amber", "violet", "muted"] as const;

function SubjectPulse({ subjects }: { subjects: DashboardSummary["by_subject"] }) {
  if (subjects.length === 0) {
    return <Empty title="暂无科目构成" hint="登记并通过支出后显示科目脉冲。" />;
  }

  const peak = Math.max(...subjects.map((subject) => subject.spent), 1);
  return (
    <div className={s.subjectList}>
      {subjects.map((subject, index) => {
        const percent = Math.max(0, Math.min(100, (subject.spent / peak) * 100));
        const signal = SUBJECT_SIGNALS[index % SUBJECT_SIGNALS.length];
        return (
          <div className={s.subjectRow} key={subject.subject}>
            <div className={s.subjectHead}>
              <span>{subject.subject}</span>
              <b>{fmtMoney(subject.spent)} 元</b>
            </div>
            <div className={s.subjectTrack} aria-label={`${subject.subject}支出 ${fmtMoney(subject.spent)} 元`}>
              <span className={`${s.subjectFill} ${s[signal]}`} style={{ transform: `scaleX(${percent / 100})` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function DeliveryLog({ weekly, userName }: { weekly: Weekly | null; userName: (id: number | null) => string }) {
  const logs = weekly?.progress_logs ?? [];
  if (logs.length === 0) {
    return <Empty title="暂无交付日志" hint="成员填报进度后，最新动作会在这里留下记录。" />;
  }

  return (
    <ol className={s.logList}>
      {logs.slice(0, 6).map((log, index) => (
        <li className={s.logItem} key={`${log.task_id}-${index}`}>
          <span className={s.logTime}>{fmtDateTime(log.created_at)}</span>
          <span className={s.logNode} aria-hidden="true" />
          <Link href={`/projects/${log.project_id}`} className={s.logBody}>
            <span className={s.logTitle}>任务 #{log.task_id} 填报 <b>{log.progress}%</b></span>
            <span className={s.logMeta}>{userName(log.user_id)}{log.note ? ` · ${log.note}` : ""}</span>
          </Link>
        </li>
      ))}
    </ol>
  );
}

export default function DashboardPage() {
  const { userName, deptName } = useMeta();
  const { me } = useMe();
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
      const [summary, currentWeek] = await Promise.all([
        dashboardApi.summary(),
        dashboardApi.weekly().catch(() => null),
      ]);
      setData(summary);
      setWeekly(currentWeek);
    } catch (e) {
      setErr(errText(e));
    } finally {
      setLoading(false);
      finish();
    }
  }, [beginActivity]);

  useEffect(() => { load(); }, [load]);

  if (!data) {
    if (loading) {
      return (
        <div className={s.bootLoading} role="status" aria-live="polite" aria-busy="true">
          <LoadingBlock title={false} kpis={4} label="正在接入交付坐标盘…" />
        </div>
      );
    }
    return (
      <div className={s.initialError} role="alert">
        <span className={s.errorSignal} aria-hidden="true" />
        <strong>交付坐标盘暂时无法接入</strong>
        <span>{err || "暂时无法获取工作台数据。"}</span>
        <button className={s.headerButton} type="button" onClick={load}>重新接入</button>
      </div>
    );
  }

  const k = data.kpi;
  const trendData = data.trend.map((point) => ({ ...point, label: point.month.slice(5) + "月" }));
  const actionState = loading ? "校准中" : err ? "待检查" : "已接入";

  return (
    <div className={s.dashboard} data-dashboard-page="true" aria-busy={loading}>
      <PageHeader
        title="交付坐标盘"
        className={s.commandHeader}
        filters={
          <div className={s.headerCluster}>
            <p className={s.pageIntro}>把项目状态、介入事项与资金脉冲收束在同一张工作面上。</p>
          </div>
        }
        actions={
          <>
            <span className={s.headerState}><i aria-hidden="true" />节点 / {actionState}</span>
            <button
              className={s.headerButton}
              type="button"
              onClick={load}
              disabled={loading}
              aria-busy={loading}
            >
              {loading ? "校准中" : "刷新坐标"}
            </button>
            {isAdmin && (
              <Link className={s.approvalButton} href="/approvals">
                进入审批 · {k.pending_approvals}
              </Link>
            )}
          </>
        }
      />

      {err && (
        <div className={s.staleBanner} role="alert">
          <span><b>链路未完成校准。</b> 以下为上次成功数据。{err}</span>
          <button className={s.headerButton} type="button" onClick={load} disabled={loading}>重试</button>
        </div>
      )}

      <MotionStagger className={s.motion}>
        <section className={s.readoutZone} data-testid="dashboard-zone-readouts" aria-labelledby="dashboard-readouts-title">
          <div className={s.zoneHeader}>
            <div>
              <h2 id="dashboard-readouts-title">当前工作态势</h2>
              <p>实时读数 · 数据源已连接</p>
            </div>
            <span className={s.zoneCode}>实时坐标</span>
          </div>
          <div className={s.readoutRail}>
            <DashboardReadout
              label="我的项目"
              value={k.my_projects}
              detail={<>进行中 <span className="mono">{k.active_projects}</span></>}
            />
            <DashboardReadout
              label="逾期任务"
              value={k.overdue_tasks}
              tone={k.overdue_tasks > 0 ? "danger" : "neutral"}
              detail={<>我负责 <span className="mono">{k.my_overdue_tasks}</span></>}
            />
            {isAdmin ? (
              <DashboardReadout
                label="待我审批"
                value={k.pending_approvals}
                tone={k.pending_approvals > 0 ? "warn" : "done"}
                detail={<>未读通知 <span className="mono">{k.unread_notifications}</span></>}
              />
            ) : (
              <DashboardReadout
                label="未读通知"
                value={k.unread_notifications}
                tone={k.unread_notifications > 0 ? "warn" : "neutral"}
                detail="审批结果会通过通知告知您"
              />
            )}
            <DashboardReadout
              label={`${k.month} 支出`}
              value={k.month_spent}
              format={fmtMoney}
              detail="按已通过支出统计"
            />
          </div>
        </section>

        <div className={s.commandGrid}>
          <section className={`${s.zone} ${s.routesZone}`} data-testid="dashboard-zone-routes" aria-labelledby="dashboard-routes-title">
            <div className={s.zoneHeader}>
              <div>
                <h2 id="dashboard-routes-title">项目航迹</h2>
                <p>以进度、执行率和风险定位交付坐标</p>
              </div>
              <span className={s.zoneMetric}><span className="mono">{data.health.length}</span> 个项目</span>
            </div>
            <DashboardRouteField health={data.health} />
          </section>

          <section className={`${s.zone} ${s.interventionZone}`} data-testid="dashboard-zone-interventions" aria-labelledby="dashboard-interventions-title">
            <div className={s.zoneHeader}>
              <div>
                <h2 id="dashboard-interventions-title">需要介入</h2>
                <p>优先处理会改变交付节奏的事项</p>
              </div>
              <span className={s.zoneCode}>待办队列</span>
            </div>
            <DashboardInterventionQueue weekly={weekly} kpi={k} isAdmin={isAdmin} userName={userName} />
          </section>
        </div>

        <section className={`${s.zone} ${s.pulseZone}`} data-testid="dashboard-zone-pulse" aria-labelledby="dashboard-pulse-title">
          <div className={s.zoneHeader}>
            <div>
              <h2 id="dashboard-pulse-title">数据脉冲</h2>
              <p>资金流动和团队动作的连续读数</p>
            </div>
            <span className={s.zoneCode}>近 6 个月</span>
          </div>

          <div className={s.pulseGrid}>
            <section className={s.pulseChart} aria-labelledby="dashboard-trend-title">
              <div className={s.subhead}>
                <h3 id="dashboard-trend-title">近 6 个月支出趋势</h3>
                <span>元</span>
              </div>
              {trendData.every((point) => point.spent === 0) ? (
                <Empty title="暂无资金脉冲" hint="登记并通过支出后显示趋势。" />
              ) : (
                <div className={s.chart}>
                  <ResponsiveContainer>
                    <LineChart data={trendData} margin={{ top: 12, right: 18, bottom: 0, left: 0 }}>
                      <CartesianGrid stroke="var(--line-soft)" vertical={false} />
                      <XAxis dataKey="label" tick={{ fontSize: 11, fill: "var(--ink-2)" }} axisLine={{ stroke: "var(--line)" }} tickLine={false} />
                      <YAxis tick={{ fontSize: 11, fill: "var(--ink-2)" }} axisLine={false} tickLine={false} width={58} tickFormatter={(value) => (Number(value) >= 10000 ? `${Math.round(Number(value) / 10000)}万` : String(value))} />
                      <Tooltip formatter={(value) => [`${fmtMoney(Number(value))} 元`, "支出"]} contentStyle={{ background: "var(--card)", border: "1px solid var(--line-blue)", borderRadius: 0, color: "var(--ink)", fontSize: 12 }} />
                      <Line type="monotone" dataKey="spent" stroke="var(--brand)" strokeWidth={2} dot={{ r: 3, fill: "var(--bg)", stroke: "var(--brand)", strokeWidth: 1.5 }} activeDot={{ r: 5, fill: "var(--action)", stroke: "var(--bg)", strokeWidth: 2 }} name="支出" isAnimationActive={!reduced} animationDuration={620} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              )}
            </section>

            <section className={s.subjectPulse} aria-labelledby="dashboard-subject-title">
              <div className={s.subhead}>
                <h3 id="dashboard-subject-title">科目构成</h3>
                <span>已通过</span>
              </div>
              <SubjectPulse subjects={data.by_subject} />
            </section>
          </div>

          <section className={s.logZone} aria-labelledby="dashboard-log-title">
            <div className={s.subhead}>
              <h3 id="dashboard-log-title">交付日志</h3>
              {weekly && <span>近 7 天填报 <CountUp value={weekly.log_count} /> 条</span>}
            </div>
            <DeliveryLog weekly={weekly} userName={userName} />
          </section>

          <p className={s.metaNote}>
            部门：{deptName(me?.dept_id ?? null)} · {MONEY_LABEL.spent}只统计「已通过 / 特批通过」
          </p>
        </section>
      </MotionStagger>
    </div>
  );
}
