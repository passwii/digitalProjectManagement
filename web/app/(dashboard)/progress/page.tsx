"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, buildQuery, errText, milestonesApi, projectsApi, reportsApi,
  tasksApi, unwrapPaged, type Milestone, type Task, type Warnings,
} from "@/lib/api";
import { useAsyncData } from "@/lib/useAsyncData";
import { urlInt, useUrlState } from "@/lib/useUrlState";
import { useProjectsProbe } from "@/lib/useProjects";
import { useMeta } from "@/lib/useMeta";
import {
  LOCATE_PAGE_SIZE, TARGET_KEY, isTargetRow, locateTargetPage, missingTargetText, parseTarget,
  rowClass, useTargetScroll,
} from "@/lib/deepLink";
import { PROGRESS_LABEL } from "@/lib/kpi";
import { TASK_STATUS, TASK_STATUS_ORDER, fmtDate, isOverdueTask, taskStatusLabel, taskTone } from "@/lib/labels";
import Badge from "@/components/ui/Badge";
import Avatar from "@/components/ui/Avatar";
import Empty from "@/components/ui/Empty";
import Pagination from "@/components/ui/Pagination";
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

// 当前项目 / 视图模式 / 任务分页 / 里程碑分页 / 通知定位目标写入 URL：链接可分享，刷新/后退不丢状态
const URL_DEFAULTS = {
  project_id: "",
  view: "list",
  page: "1",
  size: "20",
  mpage: "1",
  msize: "20",
  [TARGET_KEY.task]: "",
  [TARGET_KEY.milestone]: "",
};

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
  const [url, setUrl] = useUrlState(URL_DEFAULTS, { pageKey: false });
  const pid = url.project_id;
  // 通知深链定位目标（任务 / 里程碑）
  const taskTarget = parseTarget(url[TARGET_KEY.task]);
  const mileTarget = parseTarget(url[TARGET_KEY.milestone]);
  // 任务与里程碑各自独立分页：真实翻页，不再单页截断
  const page = urlInt(url.page, 1);
  const size = urlInt(url.size, DEFAULT_PAGE_SIZE, { max: MAX_PAGE_SIZE });
  const mpage = urlInt(url.mpage, 1);
  const msize = urlInt(url.msize, DEFAULT_PAGE_SIZE, { max: MAX_PAGE_SIZE });
  const view: View = (VIEWS.find((v) => v.code === url.view)?.code ?? "list") as View;

  const { userName } = useMeta();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  // 定位失败（目标不在可见范围）时的可理解说明
  const [locateErr, setLocateErr] = useState("");
  const [locating, setLocating] = useState(false);
  // 是否有可参与项目：只探测 1 条，不再拉取 100 条项目判断存在性
  const { hasProjects, probing, probeError, reloadProbe } = useProjectsProbe();

  const { data, loading, firstLoad, error, reload } = useAsyncData(
    async (signal) => {
      const [t, m, w, pg] = await Promise.all([
        // 任务：真实分页（page/size 来自 URL），不再单页截断
        tasksApi.list(buildQuery({ project_id: pid, page, size }), signal),
        // Stage 3A：一律回分页信封（用 unwrapPaged 兼容旧裸数组）
        milestonesApi.list(Number(pid), { page: mpage, size: msize }, signal),
        // 预警是辅助信息：失败不影响任务/里程碑展示
        reportsApi.warnings(signal).catch(() => null),
        // 加权进度：由服务端在**全量任务**上计算（本地按当前页算会在任务被分页时失真）
        projectsApi.progress(Number(pid), signal).catch(() => null),
      ]);
      const taskPage = unwrapPaged<Task>(t);
      const milestonePage = unwrapPaged<Milestone>(m);
      return {
        tasks: taskPage.items,
        tasksTotal: taskPage.total,
        miles: milestonePage.items,
        milesTotal: milestonePage.total,
        warns: w as Warnings | null,
        serverProgress: pg?.progress ?? null,
        serverTaskCount: pg?.task_count ?? null,
      };
    },
    [pid, page, size, mpage, msize],
    { enabled: !!pid, resetOnDepChange: true },
  );

  const tasks = data?.tasks ?? [];
  const tasksTotal = data?.tasksTotal ?? tasks.length;
  // 页头任务数优先用服务端全量计数（分页后当页条数不再等于任务总数）
  const taskTotal = data?.serverTaskCount ?? tasksTotal;
  const miles: Milestone[] = data?.miles ?? [];
  const milesTotal = data?.milesTotal ?? miles.length;
  const warns = data?.warns ?? null;

  // 分页派生值集中计算：页码收敛 + 当前页范围，供范围提示与父/前置任务候选说明复用
  const range = useMemo(() => {
    const pages = Math.max(1, Math.ceil(tasksTotal / Math.max(size, 1)));
    const safePage = Math.min(Math.max(page, 1), pages);
    return {
      pages,
      safePage,
      from: tasksTotal === 0 ? 0 : (safePage - 1) * size + 1,
      to: Math.min(safePage * size, tasksTotal),
    };
  }, [tasksTotal, size, page]);

  const [taskOpen, setTaskOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [reportTask, setReportTask] = useState<Task | null>(null);
  const [milestoneOpen, setMilestoneOpen] = useState(false);
  const [editingMilestone, setEditingMilestone] = useState<Milestone | null>(null);
  const [confirm, setConfirm] = useState<{ title: string; text?: string; run: () => Promise<void> } | null>(null);

  // 兜底：服务端进度接口不可用时，按当前显示的任务估算（页面会标注“估算”）
  const localWeighted = useMemo(() => {
    const tw = tasks.reduce((s, t) => s + (t.weight || 1), 0) || 1;
    return Math.round((tasks.reduce((s, t) => s + (t.progress || 0) * (t.weight || 1), 0) / tw) * 100) / 100;
  }, [tasks]);
  const serverProgress = data?.serverProgress ?? null;
  const weighted = serverProgress ?? localWeighted;
  const weightedEstimated = serverProgress === null;

  // 切换项目后清理弹窗与定位状态，避免把上一个项目的任务写回新项目
  useEffect(() => {
    setEditingTask(null);
    setReportTask(null);
    setTaskOpen(false);
    setEditingMilestone(null);
    setMilestoneOpen(false);
    setLocateErr("");
  }, [pid]);

  // 手动切换项目后，上一个项目的定位参数已失效 → 丢弃（首次进入时不清，否则深链会被自己抹掉）
  const prevPidRef = useRef(pid);
  useEffect(() => {
    if (prevPidRef.current === pid) return;
    prevPidRef.current = pid;
    if (taskTarget || mileTarget) setUrl({ [TARGET_KEY.task]: "", [TARGET_KEY.milestone]: "" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pid]);

  /**
   * 定位任务 / 里程碑（通知深链）。
   *
   * 目标可能落在任意一页：用一次 size=100 的窗口查询定位它的页码，再让页面翻到那一页。
   * 窗口内没有 → 明确告知「已不存在或不在可见范围」，不再让用户自己翻页找。
   *
   * 只对每个 (项目, 目标) 尝试一次（attemptedRef），因此不会因为列表重渲染而反复查询；
   * 失败态会一直保留到用户「清除定位」或换目标。
   */
  const attemptedRef = useRef("");
  useEffect(() => {
    if (!pid || firstLoad) return;
    const job = taskTarget
      ? { key: TARGET_KEY.task, label: "任务", target: taskTarget, donePage: page, onPage: tasks.some((t) => isTargetRow(t.id, taskTarget)), pageSize: size, total: tasksTotal }
      : mileTarget
      ? { key: TARGET_KEY.milestone, label: "里程碑", target: mileTarget, donePage: mpage, onPage: miles.some((m) => isTargetRow(m.id, mileTarget)), pageSize: msize, total: milesTotal }
      : null;
    if (!job) return;
    // 已经在目标页：交给滚动/高亮
    if (job.onPage) {
      setLocateErr("");
      return;
    }
    const attemptKey = `${pid}:${job.key}:${job.target}`;
    if (attemptedRef.current === attemptKey) return;
    attemptedRef.current = attemptKey;

    let alive = true;
    setLocating(true);
    // 两类列表都满足 `{ id }` 的定位契约，这里统一成同一签名的窗口查询
    const fetchWindow = (p: number, s: number) =>
      (job.key === TARGET_KEY.task
        ? tasksApi.list(buildQuery({ project_id: pid, page: p, size: s })).then(unwrapPaged<Task>)
        : milestonesApi
            .list(Number(pid), { page: p, size: s })
            .then(unwrapPaged<Milestone>)
      ) as Promise<import("@/lib/api").Paged<{ id: number }>>;

    locateTargetPage(fetchWindow, job.target, job.pageSize)
      .then((found) => {
        if (!alive) return;
        if (found === null) {
          // 窗口内找不到：给出可理解的说明与「清除定位」的出口
          setLocateErr(missingTargetText(job.label, job.total));
          return;
        }
        setLocateErr("");
        if (found !== job.donePage) {
          setUrl(
            job.key === TARGET_KEY.task ? { page: String(found) } : { mpage: String(found) },
            { history: "replace" },
          );
        }
      })
      .catch(() => {
        if (alive) setLocateErr(`${job.label}定位失败：无法读取列表，请重试。`);
      })
      .finally(() => {
        if (alive) setLocating(false);
      });

    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pid, firstLoad, taskTarget, mileTarget, page, mpage, size, msize, tasksTotal, milesTotal,
      tasks.some((t) => isTargetRow(t.id, taskTarget)), miles.some((m) => isTargetRow(m.id, mileTarget))]);

  // 命中行滚动入视口；列表 / 看板视图下命中行才可见
  useTargetScroll(taskTarget || mileTarget, !firstLoad && (view === "list" || view === "board" || !!mileTarget));

  // 逾期统计：优先用服务端预警（`/reports/warnings` 在全量可见任务上算，不受当前页影响）；
  // 预警接口失败时才退化到当前页估算，并在横幅上标注口径。
  const pageOverdue = tasks.filter(isOverdueTask);
  const overdueWarns = warns?.overdue_tasks.filter((x) => String(x.project_id) === pid) ?? [];
  const overdueEstimated = !warns;
  const overdueCount = warns ? overdueWarns.length : pageOverdue.length;
  const overdueNames = warns ? overdueWarns.map((x) => x.name) : pageOverdue.map((t) => t.name);
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
              {PROGRESS_LABEL.weighted} <span className="mono">{weighted}%</span>
              {weightedEstimated && <span className="tiny">（按当前显示任务估算）</span>} · {taskTotal} 个任务
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
              title="按服务端全量任务重算加权进度并留痕"
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
            onChange={(id) => setUrl({ project_id: id, page: 1, mpage: 1 }, { history: "push" })}
            ariaLabel="选择项目"
            placeholder="搜索名称 / 编号 / 客户…"
            className="picker-grow"
          />
        </label>
        {pid && <div style={{ flex: 1, minWidth: 160 }}><ProgressBar value={weighted} tone="brand" /></div>}
      </div>

      {error && <LoadFailed message={error} onRetry={reload} />}

      {/* 通知定位结果：找不到目标时明确说明原因并给出出口，而不是留一个空页面 */}
      {pid && locating && (
        <div className="muted tiny" role="status" style={{ marginBottom: 8 }}>
          正在定位该{taskTarget ? "任务" : "里程碑"}…
        </div>
      )}
      {pid && locateErr && (
        <div className="err-banner" role="alert" style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ flex: 1, minWidth: 200 }}>{locateErr}</span>
          <button
            type="button"
            className="btn-ghost"
            onClick={() => {
              setLocateErr("");
              setUrl({ [TARGET_KEY.task]: "", [TARGET_KEY.milestone]: "", page: 1, mpage: 1 });
            }}
          >
            清除定位
          </button>
        </div>
      )}

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
          {(overdueCount > 0 || nearMiles.length > 0 || stagnant) && (
            <div className="warn-banner">
              {overdueCount > 0 && (
                <div>
                  逾期任务 {overdueCount} 个：{overdueNames.slice(0, 6).join("、")}
                  {overdueNames.length > 6 && ` 等 ${overdueNames.length} 个`}
                  {overdueEstimated && <span className="tiny">（预警接口不可用，按当前显示范围估算）</span>}
                </div>
              )}
              {nearMiles.length > 0 && <div>里程碑临近/逾期 {nearMiles.length} 个：{nearMiles.map((m) => m.name).join("、")}</div>}
              {stagnant && <div>项目已 {stagnant.days_no_log} 天无进度填报</div>}
            </div>
          )}

          {range.pages > 1 && (
            <div className="muted tiny" role="status" style={{ marginBottom: 8 }}>
              列表 / 看板 / 甘特图展示的都是当前页任务（第 {range.safePage}/{range.pages} 页，第 {range.from}-{range.to} 条）；
              翻页或调整每页条数可查看其余任务。页头加权进度与逾期统计为服务端全量口径。
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
                      const hit = isTargetRow(t.id, taskTarget);
                      return (
                        <tr key={t.id} data-target-id={t.id} className={rowClass(undefined, hit)} style={od && !hit ? { background: "var(--danger-bg)" } : undefined}>
                          <td>
                            <span className="ellipsis" title={t.name} style={{ paddingLeft: (t.level - 1) * 12 }}>
                              {t.level > 1 ? "└ " : ""}{t.name}
                            </span>
                            {hit && <span className="tiny" style={{ marginLeft: 6 }}>· 来自通知</span>}
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
                      <div
                        key={t.id}
                        data-target-id={t.id}
                        className={rowClass("card", isTargetRow(t.id, taskTarget))}
                        style={{ marginBottom: 8, background: "var(--bg)", cursor: "pointer" }}
                        onClick={() => setReportTask(t)}
                      >
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

          {tasksTotal > 0 && (
            <div style={{ marginTop: 4 }}>
              <Pagination
                page={page}
                size={size}
                total={tasksTotal}
                loading={loading}
                scopeText="任务"
                ariaLabel="任务列表分页"
                onChange={(next) =>
                  setUrl(
                    { page: String(next.page), size: String(next.size) },
                    { history: next.page === page ? "replace" : "push" },
                  )
                }
              />
            </div>
          )}

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
                    {miles.map((m) => {
                      const hit = isTargetRow(m.id, mileTarget);
                      return (
                        <tr key={m.id} data-target-id={m.id} className={rowClass(undefined, hit)}>
                          <td>
                            {m.name}
                            {hit && <span className="tiny" style={{ marginLeft: 6 }}>· 来自通知</span>}
                          </td>
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
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {milesTotal > 0 && (
              <Pagination
                page={mpage}
                size={msize}
                total={milesTotal}
                loading={loading}
                scopeText="里程碑"
                ariaLabel="里程碑分页"
                onChange={(next) =>
                  setUrl(
                    { mpage: String(next.page), msize: String(next.size) },
                    { history: next.page === mpage ? "replace" : "push" },
                  )
                }
              />
            )}
          </div>

          <TaskDialog
            open={taskOpen}
            onClose={() => setTaskOpen(false)}
            projectId={Number(pid)}
            task={editingTask}
            tasks={tasks}
            taskScopeNote={
              range.pages > 1
                ? `候选仅含当前页任务（第 ${range.from}-${range.to} 条，共 ${tasksTotal} 条）；要选其他任务请先翻到对应页`
                : undefined
            }
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
