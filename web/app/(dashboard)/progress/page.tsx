"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  errText, milestonesApi, projectsApi, reportsApi, tasksApi,
  type Milestone, type Project, type Task, type Warnings,
} from "@/lib/api";
import { useMeta } from "@/lib/useMeta";
import { TASK_STATUS, TASK_STATUS_ORDER, fmtDate, isOverdueTask, taskStatusLabel, taskTone } from "@/lib/labels";
import Badge from "@/components/ui/Badge";
import Avatar from "@/components/ui/Avatar";
import Empty from "@/components/ui/Empty";
import ProgressBar from "@/components/ui/ProgressBar";
import { Confirm } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import TaskDialog from "./TaskDialog";
import MilestoneDialog from "./MilestoneDialog";
import ReportDialog from "./ReportDialog";

type View = "列表" | "看板" | "甘特图";

export default function ProgressPage() {
  return (
    <Suspense fallback={<p className="muted">加载中…</p>}>
      <ProgressInner />
    </Suspense>
  );
}

function ProgressInner() {
  const sp = useSearchParams();
  const { userName } = useMeta();
  const toast = useToast();

  const [projects, setProjects] = useState<Project[]>([]);
  const [pid, setPid] = useState<string>(sp.get("project_id") ?? "");
  const [view, setView] = useState<View>("列表");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [miles, setMiles] = useState<Milestone[]>([]);
  const [warns, setWarns] = useState<Warnings | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const [taskOpen, setTaskOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [reportTask, setReportTask] = useState<Task | null>(null);
  const [milestoneOpen, setMilestoneOpen] = useState(false);
  const [editingMilestone, setEditingMilestone] = useState<Milestone | null>(null);
  const [confirm, setConfirm] = useState<{ title: string; text?: string; run: () => Promise<void> } | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const data = await projectsApi.list("?size=100");
        setProjects(data.items ?? []);
        if (!pid && data.items?.length) setPid(String(data.items[0].id));
      } catch (e) {
        setErr(errText(e));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const load = useCallback(async () => {
    if (!pid) return;
    setErr("");
    try {
      const [t, m, w] = await Promise.all([
        tasksApi.list(`?project_id=${pid}`),
        milestonesApi.list(Number(pid)),
        reportsApi.warnings().catch(() => null),
      ]);
      setTasks(t);
      setMiles(m);
      setWarns(w);
    } catch (e) {
      setErr(errText(e));
    }
  }, [pid]);

  useEffect(() => { load(); }, [load]);

  const weighted = useMemo(() => {
    const tw = tasks.reduce((s, t) => s + (t.weight || 1), 0) || 1;
    return Math.round((tasks.reduce((s, t) => s + (t.progress || 0) * (t.weight || 1), 0) / tw) * 100) / 100;
  }, [tasks]);

  const myOverdue = tasks.filter(isOverdueTask);
  const nearMiles = warns?.milestones.filter((x) => String(x.project_id) === pid) ?? [];
  const stagnant = warns?.stagnant_projects.find((x) => String(x.project_id) === pid);

  async function run(fn: () => Promise<unknown>, okMsg: string) {
    setBusy(true);
    setErr("");
    try {
      await fn();
      toast.ok(okMsg);
      await load();
    } catch (e) {
      toast.err(errText(e));
    } finally {
      setBusy(false);
    }
  }

  const current = projects.find((p) => String(p.id) === pid);

  return (
    <div>
      <div className="page-head">
        <h1>
          进度跟进
          <span className="sub">加权进度 <span className="mono">{weighted}%</span> · {tasks.length} 个任务</span>
        </h1>
        <div className="actions no-print">
          {(["列表", "看板", "甘特图"] as View[]).map((v) => (
            <button key={v} className={view === v ? "btn-primary" : "btn-ghost"} style={view === v ? { width: "auto" } : undefined} onClick={() => setView(v)}>
              {v}
            </button>
          ))}
          {current && (
            <button
              className="btn-ghost"
              disabled={busy}
              onClick={() =>
                setConfirm({
                  title: "确认项目进度？",
                  text: `将按任务加权重算并写入快照留痕（当前 ${weighted}%）。`,
                  run: async () => {
                    const r = await projectsApi.confirmProgress(Number(pid));
                    toast.ok(`已确认并快照当前进度 ${r.progress}%`);
                    await load();
                  },
                })
              }
            >
              确认进度
            </button>
          )}
          <button className="btn-primary" style={{ width: "auto" }} onClick={() => { setEditingTask(null); setTaskOpen(true); }}>+ 任务</button>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 12, padding: "10px 16px", display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
        <label style={{ display: "flex", alignItems: "center", gap: 8, margin: 0 }}>
          <span className="muted" style={{ fontSize: 13 }}>项目</span>
          <select style={{ width: 260 }} value={pid} onChange={(e) => setPid(e.target.value)} aria-label="选择项目">
            <option value="">请选择项目</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.code} {p.name}</option>)}
          </select>
        </label>
        <div style={{ flex: 1, minWidth: 220 }}><ProgressBar value={weighted} tone="brand" /></div>
      </div>

      {err && <div className="err-banner">{err}</div>}
      {(myOverdue.length > 0 || nearMiles.length > 0 || stagnant) && (
        <div className="warn-banner">
          {myOverdue.length > 0 && <div>逾期任务 {myOverdue.length} 个：{myOverdue.map((t) => t.name).join("、")}</div>}
          {nearMiles.length > 0 && <div>里程碑临近/逾期 {nearMiles.length} 个：{nearMiles.map((m) => m.name).join("、")}</div>}
          {stagnant && <div>项目已 {stagnant.days_no_log} 天无进度填报</div>}
        </div>
      )}

      {view === "列表" && (
        tasks.length === 0 ? (
          <div className="card"><Empty title="暂无任务" hint="先选择项目，再新增任务即可填报进度。" /></div>
        ) : (
          <table className="grid">
            <thead><tr><th>任务</th><th>状态</th><th>进度</th><th className="num">权重</th><th>负责人</th><th>计划期</th><th className="no-print" /></tr></thead>
            <tbody>
              {tasks.map((t) => {
                const od = isOverdueTask(t);
                return (
                  <tr key={t.id} style={od ? { background: "var(--danger-bg)" } : undefined}>
                    <td>
                      <span className="ellipsis" title={t.name} style={{ paddingLeft: (t.level - 1) * 12 }}>
                        {t.level > 1 ? "└ " : ""}{t.name}
                      </span>
                    </td>
                    <td><Badge status={od ? "已逾期" : taskStatusLabel(t.status)} tone={taskTone(t.status, od)} /></td>
                    <td><ProgressBar value={t.progress} tone="brand" /></td>
                    <td className="num">{t.weight}</td>
                    <td><span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><Avatar name={userName(t.owner_id)} size={22} />{userName(t.owner_id)}</span></td>
                    <td className="mono tiny">{fmtDate(t.plan_start)} ~ {fmtDate(t.plan_end)}</td>
                    <td className="no-print">
                      <span style={{ display: "inline-flex", gap: 6 }}>
                        <button className="btn-ghost" style={{ height: 26, lineHeight: "24px", padding: "0 8px", fontSize: 12 }} onClick={() => setReportTask(t)}>填报</button>
                        <button className="btn-ghost" style={{ height: 26, lineHeight: "24px", padding: "0 8px", fontSize: 12 }} onClick={() => { setEditingTask(t); setTaskOpen(true); }}>编辑</button>
                        <button
                          className="btn-ghost"
                          style={{ height: 26, lineHeight: "24px", padding: "0 8px", fontSize: 12, color: "var(--danger)", borderColor: "var(--line-danger)" }}
                          onClick={() =>
                            setConfirm({
                              title: `删除任务「${t.name}」？`,
                              text: "删除后该任务的填报历史一并移除，操作不可撤销。",
                              run: async () => {
                                await tasksApi.remove(t.id);
                                toast.ok("任务已删除");
                                await load();
                              },
                            })
                          }
                        >
                          删除
                        </button>
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )
      )}

      {view === "看板" && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
          {TASK_STATUS_ORDER.map((s) => {
            const col = tasks.filter((t) => t.status === s);
            return (
              <div key={s} className="card">
                <h3 style={{ margin: "0 0 8px", fontSize: 14 }}>
                  {TASK_STATUS[s]} <span className="mono tiny">{col.length}</span>
                </h3>
                {col.map((t) => (
                  <div key={t.id} className="card" style={{ marginBottom: 8, background: "var(--bg)", cursor: "pointer" }} onClick={() => setReportTask(t)}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
                      <span className="ellipsis" title={t.name}>{t.name}</span>
                      <Badge status={isOverdueTask(t) ? "逾期" : taskStatusLabel(t.status)} tone={taskTone(t.status, isOverdueTask(t))} />
                    </div>
                    <div style={{ marginTop: 8 }}><ProgressBar value={t.progress} tone="brand" /></div>
                    <div className="tiny" style={{ marginTop: 6 }}>{userName(t.owner_id)}</div>
                  </div>
                ))}
                {col.length === 0 && <Empty title="空列" hint="点卡片填报；编辑请在列表操作。" />}
              </div>
            );
          })}
        </div>
      )}

      {view === "甘特图" && <Gantt tasks={tasks} />}

      <div className="card" style={{ marginTop: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <h3 className="section-title" style={{ margin: 0 }}>里程碑</h3>
          <button className="btn-ghost" onClick={() => { setEditingMilestone(null); setMilestoneOpen(true); }}>+ 里程碑</button>
        </div>
        {miles.length === 0 ? (
          <Empty title="暂无里程碑" hint="里程碑计划日期前 3 天自动预警（可配置）。" />
        ) : (
          <table className="grid">
            <thead><tr><th>里程碑</th><th>计划日期</th><th>实际日期</th><th>状态</th><th>负责人</th><th className="no-print" /></tr></thead>
            <tbody>
              {miles.map((m) => (
                <tr key={m.id}>
                  <td>{m.name}</td>
                  <td className="mono tiny">{fmtDate(m.plan_date)}</td>
                  <td className="mono tiny">{fmtDate(m.actual_date)}</td>
                  <td>
                    <Badge
                      status={m.overdue ? "已逾期" : m.near ? "临近" : m.status === "closed" ? "已完成" : "进行中"}
                      tone={m.overdue ? "danger" : m.near ? "warn" : m.status === "closed" ? "done" : "doing"}
                    />
                  </td>
                  <td>{userName(m.owner_id)}</td>
                  <td className="no-print">
                    <span style={{ display: "inline-flex", gap: 6 }}>
                      {m.status !== "closed" && (
                        <button className="btn-ghost" style={{ height: 26, lineHeight: "24px", padding: "0 8px", fontSize: 12 }} disabled={busy}
                          onClick={() => run(() => milestonesApi.update(m.id, { actual_date: new Date().toISOString().slice(0, 10) }), "里程碑已完成")}>
                          完成
                        </button>
                      )}
                      <button className="btn-ghost" style={{ height: 26, lineHeight: "24px", padding: "0 8px", fontSize: 12 }}
                        onClick={() => { setEditingMilestone(m); setMilestoneOpen(true); }}>
                        编辑
                      </button>
                      <button
                        className="btn-ghost"
                        style={{ height: 26, lineHeight: "24px", padding: "0 8px", fontSize: 12, color: "var(--danger)", borderColor: "var(--line-danger)" }}
                        onClick={() =>
                          setConfirm({
                            title: `删除里程碑「${m.name}」？`,
                            text: "删除后不可恢复。",
                            run: async () => {
                              await milestonesApi.remove(m.id);
                              toast.ok("里程碑已删除");
                              await load();
                            },
                          })
                        }
                      >
                        删除
                      </button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <TaskDialog
        open={taskOpen}
        onClose={() => setTaskOpen(false)}
        projectId={Number(pid)}
        task={editingTask}
        tasks={tasks}
        onSaved={() => { toast.ok(editingTask ? "任务已保存" : "任务已创建"); load(); }}
      />

      <MilestoneDialog
        open={milestoneOpen}
        onClose={() => setMilestoneOpen(false)}
        projectId={Number(pid)}
        milestone={editingMilestone}
        onSaved={() => { toast.ok(editingMilestone ? "里程碑已保存" : "里程碑已创建"); load(); }}
      />

      <ReportDialog
        open={!!reportTask}
        onClose={() => setReportTask(null)}
        task={reportTask}
        onSaved={() => { toast.ok("进度已填报"); load(); }}
      />

      <Confirm
        open={!!confirm}
        danger
        loading={busy}
        title={confirm?.title ?? ""}
        text={confirm?.text}
        okText="确认"
        onConfirm={async () => {
          if (!confirm) return;
          try {
            await confirm.run();
          } catch (e) {
            toast.err(errText(e));
          } finally {
            setConfirm(null);
          }
        }}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}

function Gantt({ tasks }: { tasks: Task[] }) {
  const ranged = tasks.filter((t) => t.plan_start && t.plan_end);
  if (ranged.length === 0) {
    return (
      <div className="card">
        <h3 className="section-title" style={{ marginTop: 0 }}>时间轴（只读）</h3>
        <Empty title="暂无可展示任务" hint="任务需填写计划起止日期后显示在时间轴。" />
      </div>
    );
  }
  const min = Math.min(...ranged.map((t) => +new Date(t.plan_start!)));
  const max = Math.max(...ranged.map((t) => +new Date(t.plan_end!)));
  const total = max - min || 1;
  return (
    <div className="card">
      <h3 className="section-title" style={{ marginTop: 0 }}>时间轴（只读）</h3>
      <div style={{ display: "grid", gap: 6 }}>
        {ranged.map((t) => {
          const left = ((+new Date(t.plan_start!) - min) / total) * 100;
          const width = Math.max(((+new Date(t.plan_end!) - +new Date(t.plan_start!)) / total) * 100, 2);
          return (
            <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span className="ellipsis" style={{ width: 180, fontSize: 13 }} title={t.name}>{t.name}</span>
              <span style={{ position: "relative", flex: 1, height: 16, background: "var(--todo-bg)", borderRadius: 4 }}>
                <span style={{ position: "absolute", left: `${left}%`, width: `${width}%`, height: 16, borderRadius: 4, background: "var(--brand-soft)", border: "1px solid var(--line-blue)" }}>
                  <span style={{ display: "block", height: 14, width: `${t.progress}%`, background: "var(--brand)", borderRadius: 4 }} />
                </span>
              </span>
              <span className="mono tiny" style={{ width: 150 }}>{fmtDate(t.plan_start)} ~ {fmtDate(t.plan_end)}</span>
            </div>
          );
        })}
      </div>
      <p className="tiny" style={{ marginTop: 10 }}>甘特图只读版；拖拽调整计划为二期。</p>
    </div>
  );
}
