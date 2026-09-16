"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import {
  MAX_PAGE_SIZE, buildQuery, errText, milestonesApi, projectsApi, reportsApi, tasksApi, unwrapPaged,
  type Milestone, type Task, type Warnings,
} from "@/lib/api";
import { useAsyncData } from "@/lib/useAsyncData";
import { useUrlState } from "@/lib/useUrlState";
import { useProjectsProbe } from "@/lib/useProjects";
import { useMeta } from "@/lib/useMeta";
import { TASK_STATUS, TASK_STATUS_ORDER, fmtDate, isOverdueTask, taskStatusLabel, taskTone } from "@/lib/labels";
import Badge from "@/components/ui/Badge";
import Avatar from "@/components/ui/Avatar";
import Empty from "@/components/ui/Empty";
import ProjectPicker from "@/components/ui/ProjectPicker";
import { LoadingBlock, LoadFailed } from "@/components/ui/PageState";
import ProgressBar from "@/components/ui/ProgressBar";
import { Confirm } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import TaskDialog from "./TaskDialog";
import MilestoneDialog from "./MilestoneDialog";
import ReportDialog from "./ReportDialog";

type View = "list" | "board" | "gantt";

const VIEWS: { code: View; label: string }[] = [
  { code: "list", label: "列表" },
  { code: "board", label: "看板" },
  { code: "gantt", label: "甘特图" },
];

// 当前项目与视图模式写入 URL：链接可分享，刷新/后退不丢状态
const URL_DEFAULTS = { project_id: "", view: "list" };

export default function ProgressPage() {
  return (
    <Suspense
      fallback={
        <div>
          <div className="skel skel-title" />
          <LoadingBlock kpis={0} label="加载进度页…" />
        </div>
      }
    >
      <ProgressInner />
    </Suspense>
  );
}

function ProgressInner() {
  const [url, setUrl] = useUrlState(URL_DEFAULTS);
  const pid = url.project_id;
  const view: View = (VIEWS.find((v) => v.code === url.view)?.code ?? "list") as View;

  const { userName } = useMeta();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  // 是否有可参与项目：只探测 1 条，不再拉取 100 条项目判断存在性
  const { hasProjects, probing, probeError, reloadProbe } = useProjectsProbe();

  const { data, loading, firstLoad, error, reload } = useAsyncData(
    async (signal) => {
      const [t, m, w] = await Promise.all([
        tasksApi.list(buildQuery({ project_id: pid }), signal),
        // Stage 3A：一律回分页信封（用 unwrapPaged 兼容旧裸数组）
        milestonesApi.list(Number(pid), { size: MAX_PAGE_SIZE }, signal),
        // 预警是辅助信息：失败不影响任务/里程碑展示
        reportsApi.warnings().catch(() => null),
      ]);
      const milestonePage = unwrapPaged<Milestone>(m);
      return {
        tasks: unwrapPaged<Task>(t).items,
        miles: milestonePage.items,
        milesTotal: milestonePage.total,
        warns: w as Warnings | null,
      };
    },
    [pid],
    { enabled: !!pid, resetOnDepChange: true },
  );

  const tasks = data?.tasks ?? [];
  const miles: Milestone[] = data?.miles ?? [];
  const milesTotal = data?.milesTotal ?? miles.length;
  const warns = data?.warns ?? null;

  const [taskOpen, setTaskOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [reportTask, setReportTask] = useState<Task | null>(null);
  const [milestoneOpen, setMilestoneOpen] = useState(false);
  const [editingMilestone, setEditingMilestone] = useState<Milestone | null>(null);
  const [confirm, setConfirm] = useState<{ title: string; text?: string; run: () => Promise<void> } | null>(null);

  const weighted = useMemo(() => {
    const tw = tasks.reduce((s, t) => s + (t.weight || 1), 0) || 1;
    return Math.round((tasks.reduce((s, t) => s + (t.progress || 0) * (t.weight || 1), 0) / tw) * 100) / 100;
  }, [tasks]);

  // 切换项目后清理弹窗状态，避免把上一个项目的任务写回新项目
  useEffect(() => {
    setEditingTask(null);
    setReportTask(null);
    setTaskOpen(false);
    setEditingMilestone(null);
    setMilestoneOpen(false);
  }, [pid]);

  const myOverdue = tasks.filter(isOverdueTask);
  const nearMiles = warns?.milestones.filter((x) => String(x.project_id) === pid) ?? [];
  const stagnant = warns?.stagnant_projects.find((x) => String(x.project_id) === pid);

  const run = useCallback(
    async (fn: () => Promise<unknown>, okMsg: string) => {
      setBusy(true);
      try {
        await fn();
        toast.ok(okMsg);
        reload();
      } catch (e) {
        toast.err(errText(e));
      } finally {
        setBusy(false);
      }
    },
    [reload, toast],
  );

  return (
    <div>
      <div className="page-head">
        <h1>
          进度跟进
          {pid && data && (
            <span className="sub">
              加权进度 <span className="mono">{weighted}%</span> · {tasks.length} 个任务
            </span>
          )}
        </h1>
        <div className="actions no-print">
          {VIEWS.map((v) => (
            <button
              key={v.code}
              className={view === v.code ? "btn-primary" : "btn-ghost"}
              style={view === v.code ? { width: "auto" } : undefined}
              aria-pressed={view === v.code}
              onClick={() => setUrl({ view: v.code }, { history: "push" })}
            >
              {v.label}
            </button>
          ))}
          {pid && (
            <button
              className="btn-ghost"
              disabled={busy || loading}
              onClick={() =>
                setConfirm({
                  title: "确认项目进度？",
                  text: `将按任务加权重算并写入快照留痕（当前 ${weighted}%）。`,
                  run: async () => {
                    const r = await projectsApi.confirmProgress(Number(pid));
                    toast.ok(`已确认并快照当前进度 ${r.progress}%`);
                    reload();
                  },
                })
              }
            >
              确认进度
            </button>
          )}
          <button
            className="btn-primary"
            style={{ width: "auto" }}
            disabled={!pid}
            onClick={() => { setEditingTask(null); setTaskOpen(true); }}
          >
            + 任务
          </button>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 12, padding: "10px 16px", display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
        <label style={{ display: "flex", alignItems: "center", gap: 8, margin: 0, flex: "0 1 320px", minWidth: 0 }}>
          <span className="muted" style={{ fontSize: 13, flex: "none" }}>项目</span>
          <ProjectPicker
            value={pid}
            onChange={(id) => setUrl({ project_id: id }, { history: "push" })}
            ariaLabel="选择项目"
            placeholder="搜索名称 / 编号 / 客户…"
            className="picker-grow"
          />
        </label>
        {pid && <div style={{ flex: 1, minWidth: 160 }}><ProgressBar value={weighted} tone="brand" /></div>}
      </div>

      {error && <LoadFailed message={error} onRetry={reload} />}

      {probing ? (
        <LoadingBlock kpis={0} label="加载项目范围…" />
      ) : probeError ? (
        <LoadFailed message={probeError} onRetry={reloadProbe} />
      ) : !hasProjects ? (
        <div className="card">
          <Empty title="暂无可参与的项目" hint="您还没有负责或参与的项目，暂时无法填报进度。" />
        </div>
      ) : !pid ? (
        <div className="card">
          <Empty
            title="请先选择项目"
            hint="用上方项目选择器搜索并选择项目（超过一页也可按关键词检索），链接会带上 project_id 便于分享。"
          />
        </div>
      ) : firstLoad ? (
        <LoadingBlock kpis={0} label="加载任务与里程碑…" />
      ) : (
        <>
          {(myOverdue.length > 0 || nearMiles.length > 0 || stagnant) && (
            <div className="warn-banner">
              {myOverdue.length > 0 && <div>逾期任务 {myOverdue.length} 个：{myOverdue.map((t) => t.name).join("、")}</div>}
              {nearMiles.length > 0 && <div>里程碑临近/逾期 {nearMiles.length} 个：{nearMiles.map((m) => m.name).join("、")}</div>}
              {stagnant && <div>项目已 {stagnant.days_no_log} 天无进度填报</div>}
            </div>
          )}

          {view === "list" && (
            tasks.length === 0 ? (
              <div className="card"><Empty title="暂无任务" hint="点击右上角 + 任务 新增后即可填报进度。" /></div>
            ) : (
              <div className="table-scroll">
                <table className="grid" aria-busy={loading}>
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
                                      reload();
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
              </div>
            )
          )}

          {view === "board" && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>
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

          {view === "gantt" && <Gantt tasks={tasks} />}

          <div className="card" style={{ marginTop: 16 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, gap: 8, flexWrap: "wrap" }}>
              <h3 className="section-title" style={{ margin: 0 }}>里程碑</h3>
              <button className="btn-ghost" onClick={() => { setEditingMilestone(null); setMilestoneOpen(true); }}>+ 里程碑</button>
            </div>
            {miles.length === 0 ? (
              <Empty title="暂无里程碑" hint="里程碑计划日期前 3 天自动预警（可配置）。" />
            ) : (
              <div className="table-scroll">
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
                                    reload();
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
              </div>
            )}
            {milesTotal > miles.length && (
              <div className="muted tiny" style={{ marginTop: 8 }}>
                共 {milesTotal} 条里程碑，当前显示前 {miles.length} 条
              </div>
            )}
          </div>

          <TaskDialog
            open={taskOpen}
            onClose={() => setTaskOpen(false)}
            projectId={Number(pid)}
            task={editingTask}
            tasks={tasks}
            onSaved={() => { toast.ok(editingTask ? "任务已保存" : "任务已创建"); reload(); }}
          />

          <MilestoneDialog
            open={milestoneOpen}
            onClose={() => setMilestoneOpen(false)}
            projectId={Number(pid)}
            milestone={editingMilestone}
            onSaved={() => { toast.ok(editingMilestone ? "里程碑已保存" : "里程碑已创建"); reload(); }}
          />

          <ReportDialog
            open={!!reportTask}
            onClose={() => setReportTask(null)}
            task={reportTask}
            onSaved={() => { toast.ok("进度已填报"); reload(); }}
          />
        </>
      )}

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
