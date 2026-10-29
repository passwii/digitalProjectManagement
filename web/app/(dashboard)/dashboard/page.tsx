"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import Link from "next/link";
import { useReducedMotion } from "framer-motion";
import { avDurationMs } from "@/lib/av/motion";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { dashboardApi, errText, type DashboardSummary, type HealthRow, type Weekly } from "@/lib/api";
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
import { isAbortError } from "@/lib/useAsyncData";
import { linkAbortSignal, refreshAbortMessage, useRegisterPageRefresh } from "@/lib/pageRefresh";

const SUBJECT_SIGNALS = ["cyan", "blue", "violet", "magenta", "aqua", "amber", "lime", "muted"] as const;

// 首页只保留最需要关注的项目；完整台账在 /projects。风险优先级：异常 > 风险 > 正常 > 已结束。
const ROUTE_LIMIT = 8;
const HEALTH_RANK: Record<HealthRow["health"], number> = { bad: 0, risk: 1, ok: 2, closed: 3 };

function rankRoutes(a: HealthRow, b: HealthRow) {
  const byHealth = HEALTH_RANK[a.health] - HEALTH_RANK[b.health];
  if (byHealth !== 0) return byHealth;
  if (b.overdue_tasks !== a.overdue_tasks) return b.overdue_tasks - a.overdue_tasks;
  return a.progress - b.progress;
}

function SubjectPulse({ subjects }: { subjects: DashboardSummary["by_subject"] }) {
  if (subjects.length === 0) {
    return <Empty title="暂无科目构成" hint="登记并通过支出后显示科目脉冲。" />;
  }

  const single = subjects.length === 1;
  const peak = Math.max(...subjects.map((subject) => subject.spent), 1);
  return (
    <div className={s.subjectList}>
      {subjects.map((subject, index) => {
        const percent = Math.max(0, Math.min(100, (subject.spent / peak) * 100));
        const signal = SUBJECT_SIGNALS[index % SUBJECT_SIGNALS.length];
        return (
          <div className={`${s.subjectRow} ${s[signal]}`} key={subject.subject}>
            <div className={s.subjectHead}>
              <span>{subject.subject}</span>
              <b>{fmtMoney(subject.spent)} 元</b>
            </div>
            {!single && (
              <div className={s.subjectTrack} aria-label={`${subject.subject}支出 ${fmtMoney(subject.spent)} 元`}>
                <span
                  className={`${s.subjectFill} ${s[signal]}`}
                  style={{ "--subject-progress": percent / 100 } as CSSProperties}
                />
              </div>
            )}
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
  const { canApprove } = useMenus();
  const { beginActivity } = useActivity();
  const reduced = useReducedMotion();
  const chartAnimationMs = avDurationMs("slow", { reduced: Boolean(reduced), frozen: false });
  const [data, setData] = useState<DashboardSummary | null>(null);
  const [weekly, setWeekly] = useState<Weekly | null>(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);
  const loadSeq = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);

  const load = useCallback(async (externalSignal?: AbortSignal): Promise<string | null> => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const detach = linkAbortSignal(externalSignal, controller);
    const id = ++loadSeq.current;
    const reportAbort = () => {
      const message = refreshAbortMessage(externalSignal);
      if (message && loadSeq.current === id) setErr(message);
      return message;
    };
    const finish = beginActivity({ label: "刷新工作台", scope: "content" });
    setLoading(true);
    setErr("");
    try {
      if (controller.signal.aborted) return reportAbort();
      const [s, w] = await Promise.all([
        dashboardApi.summary(controller.signal),
        dashboardApi.weekly(0, controller.signal).catch(() => null),
      ]);
      if (loadSeq.current !== id) return null;
      if (controller.signal.aborted) return reportAbort();
      setData(s);
      setWeekly(w);
      return null;
    } catch (e) {
      if (loadSeq.current !== id) return null;
      if (controller.signal.aborted) return reportAbort();
      if (isAbortError(e)) return null;
      const message = errText(e);
      setErr(message);
      return message;
    } finally {
      detach();
      if (loadSeq.current === id) setLoading(false);
      finish();
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  }, [beginActivity]);

  useRegisterPageRefresh(async (signal) => {
    const message = await load(signal);
    if (message) throw new Error(message);
  });

  useEffect(() => {
    load();
    return () => {
      controllerRef.current?.abort();
      controllerRef.current = null;
    };
  }, [load]);

  if (!data) {
    if (loading) {
      return (
        <div className={s.bootLoading} role="status" aria-live="polite" aria-busy="true">
          <LoadingBlock title={false} kpis={4} label="正在加载工作台数据…" />
        </div>
      );
    }
    return (
      <div className={s.initialError} role="alert">
        <span className={s.errorSignal} aria-hidden="true" />
        <strong>暂时无法加载工作台数据</strong>
        <span>{err || "暂时无法获取工作台数据。"}</span>
        <button className={s.headerButton} type="button" onClick={() => void load()}>重新加载</button>
      </div>
    );
  }

  const k = data.kpi;
  const trendData = data.trend.map((point) => ({ ...point, label: point.month.slice(5) + "月" }));
  const routeRows = [...data.health].sort(rankRoutes).slice(0, ROUTE_LIMIT);
  const hiddenRoutes = data.health.length - routeRows.length;
  const showApprovalLink = canApprove && k.pending_approvals > 0;

  return (
    <div className={s.dashboard} data-dashboard-page="true" aria-busy={loading}>
      <PageHeader
        title="交付坐标盘"
        className={s.commandHeader}
        actions={showApprovalLink ? (
          <Link className={s.approvalButton} href="/approvals">
            进入审批 · {k.pending_approvals}
          </Link>
        ) : undefined}
      />
      {err && (
        <div className={s.staleBanner} role="alert">
          <span><b>数据刷新失败，以下为上次成功数据。</b>{err}</span>
          <button className={s.headerButton} type="button" onClick={() => void load()} disabled={loading}>重试</button>
        </div>
      )}

      <MotionStagger className={s.motion}>
        <section className={s.readoutZone} data-testid="dashboard-zone-readouts" aria-label="工作台关键指标">
          <div className={s.readoutRail}>
            <DashboardReadout
              label="我的项目"
              value={k.my_projects}
              detail={<>进行中 <span className="mono">{k.active_projects}</span></>}
              accent="cyan"
            />
            <DashboardReadout
              label="逾期任务"
              value={k.overdue_tasks}
              tone={k.overdue_tasks > 0 ? "danger" : "neutral"}
              detail={<>我负责 <span className="mono">{k.my_overdue_tasks}</span></>}
              accent={k.overdue_tasks > 0 ? "coral" : "green"}
            />
            {canApprove ? (
              <DashboardReadout
                label="待我审批"
                value={k.pending_approvals}
                tone={k.pending_approvals > 0 ? "warn" : "done"}
                detail={<>未读通知 <span className="mono">{k.unread_notifications}</span></>}
                accent={k.pending_approvals > 0 ? "amber" : "green"}
              />
            ) : (
              <DashboardReadout
                label="未读通知"
                value={k.unread_notifications}
                tone="neutral"
                detail="审批结果会通过通知告知您"
                accent={k.unread_notifications > 0 ? "violet" : "blue"}
              />
            )}
            <DashboardReadout
              label={`${k.month} 支出`}
              value={k.month_spent}
              format={fmtMoney}
              detail="按已通过支出统计"
              accent="blue"
            />
          </div>
        </section>

        <div className={s.commandGrid}>
          <section className={`${s.zone} ${s.routesZone}`} data-testid="dashboard-zone-routes" aria-labelledby="dashboard-routes-title">
            <div className={s.zoneHeader}>
              <h2 id="dashboard-routes-title">项目航迹</h2>
              <span className={s.zoneMetric}><span className="mono">{data.health.length}</span> 个项目</span>
            </div>
            <DashboardRouteField health={routeRows} />
            {hiddenRoutes > 0 && (
              <Link className={s.zoneMore} href="/projects">
                <span>查看全部项目</span>
                <span aria-hidden="true">→</span>
              </Link>
            )}
          </section>

          <section className={`${s.zone} ${s.interventionZone}`} data-testid="dashboard-zone-interventions" aria-labelledby="dashboard-interventions-title">
            <div className={s.zoneHeader}>
              <h2 id="dashboard-interventions-title">需要介入</h2>
            </div>
            <DashboardInterventionQueue weekly={weekly} kpi={k} isAdmin={canApprove} userName={userName} />
          </section>
        </div>

        <section className={`${s.zone} ${s.pulseZone}`} data-testid="dashboard-zone-pulse" aria-labelledby="dashboard-pulse-title">
          <div className={s.zoneHeader}>
            <h2 id="dashboard-pulse-title">数据脉冲</h2>
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
                    <AreaChart data={trendData} margin={{ top: 12, right: 18, bottom: 0, left: 0 }}>
                      <defs>
                        <linearGradient id="dashboard-spend-field" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="var(--dash-cyan)" stopOpacity={0.28} />
                          <stop offset="72%" stopColor="var(--dash-cyan)" stopOpacity={0.04} />
                          <stop offset="100%" stopColor="var(--dash-cyan)" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid stroke="var(--line-soft)" vertical={false} />
                      <XAxis dataKey="label" tick={{ fontSize: 11, fill: "var(--ink-2)" }} axisLine={{ stroke: "var(--line)" }} tickLine={false} />
                      <YAxis tick={{ fontSize: 11, fill: "var(--ink-2)" }} axisLine={false} tickLine={false} width={58} tickFormatter={(value) => (Number(value) >= 10000 ? `${Math.round(Number(value) / 10000)}万` : String(value))} />
                      <Tooltip formatter={(value) => [`${fmtMoney(Number(value))} 元`, "支出"]} contentStyle={{ background: "var(--card)", border: "1px solid var(--line-blue)", borderRadius: 0, color: "var(--ink)", fontSize: 12 }} />
                      <Area
                        type="monotone"
                        dataKey="spent"
                        stroke="none"
                        fill="url(#dashboard-spend-field)"
                        isAnimationActive={chartAnimationMs > 0}
                        animationDuration={chartAnimationMs}
                      />
                      <Line type="monotone" dataKey="spent" stroke="var(--brand)" strokeWidth={2} dot={{ r: 3, fill: "var(--bg)", stroke: "var(--brand)", strokeWidth: 1.5 }} activeDot={{ r: 5, fill: "var(--action)", stroke: "var(--bg)", strokeWidth: 2 }} name="支出" isAnimationActive={chartAnimationMs > 0} animationDuration={chartAnimationMs} />
                    </AreaChart>
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
