"use client";

import { Suspense, useState } from "react";
import {
  DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, buildQuery, errText, tasksApi,
  unwrapPaged, type Task,
} from "@/lib/api";
import { useAsyncData } from "@/lib/useAsyncData";
import { urlInt, useUrlState } from "@/lib/useUrlState";
import { useProjectsProbe } from "@/lib/useProjects";
import { useMeta } from "@/lib/useMeta";
import { parseTarget, rowClass, useTargetScroll } from "@/lib/deepLink";
import { fmtDate, fmtDateTime } from "@/lib/labels";
import Avatar from "@/components/ui/Avatar";
import Empty from "@/components/ui/Empty";
import Pagination from "@/components/ui/Pagination";
import ProjectPicker from "@/components/ui/ProjectPicker";
import { LoadingBlock, LoadFailed } from "@/components/ui/PageState";
import { Confirm } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import PageHeader from "@/components/ui/PageHeader";
import { CardItem, CardList, DesktopTable, useVisibleTargetScroll } from "@/components/ui/CardList";
import MotionReveal from "@/components/motion/MotionReveal";
import { useActivity } from "@/lib/useActivity";
import { AV_STAGGER } from "@/lib/av/motion";
import ProgressNodeDialog from "./ProgressNodeDialog";

const URL_DEFAULTS = {
  project_id: "",
  page: "1",
  size: String(DEFAULT_PAGE_SIZE),
  task: "",
};

export default function ProgressPage() {
  return (
    <Suspense fallback={<LoadingBlock kpis={0} label="加载进度…" />}>
      <ProgressInner />
    </Suspense>
  );
}

function ProgressInner() {
  const [url, setUrl] = useUrlState(URL_DEFAULTS, { pageKey: "page" });
  const pid = Number(url.project_id || 0);
  const page = urlInt(url.page, 1);
  const size = urlInt(url.size, DEFAULT_PAGE_SIZE, { max: MAX_PAGE_SIZE });
  const target = parseTarget(url.task);
  const { userName } = useMeta();
  const toast = useToast();
  const { beginActivity } = useActivity();
  const { hasProjects, probing, probeError, reloadProbe } = useProjectsProbe();
  const [nodeOpen, setNodeOpen] = useState(false);
  const [editing, setEditing] = useState<Task | null>(null);
  const [removeTarget, setRemoveTarget] = useState<Task | null>(null);
  const [busy, setBusy] = useState(false);

  const { data, loading, firstLoad, error, reload } = useAsyncData(
    (signal) => tasksApi.list(buildQuery({ project_id: pid, page, size, sort: "-plan_end" }), signal),
    [pid, page, size],
    { enabled: !!pid, resetOnDepChange: true, cacheKey: "progress:tasks", cacheMaxAgeMs: 60_000 },
  );
  const paged = unwrapPaged<Task>(data);
  const tasks = paged.items;
  const total = paged.total;
  useTargetScroll(target, !firstLoad && tasks.some((t) => t.id === target));
  useVisibleTargetScroll(target, !firstLoad && tasks.some((t) => t.id === target));

  async function remove() {
    if (!removeTarget) return;
    const finish = beginActivity({ label: "删除进度记录", scope: "form" });
    setBusy(true);
    try {
      await tasksApi.remove(removeTarget.id);
      toast.ok("进度记录已删除");
      setRemoveTarget(null);
      reload();
    } catch (e) {
      toast.err(errText(e));
    } finally {
      setBusy(false);
      finish();
    }
  }

  if (probing) return <LoadingBlock kpis={0} label="加载项目范围…" />;
  if (probeError) return <LoadFailed message={probeError} onRetry={reloadProbe} />;

  return (
    <div>
      <PageHeader
        title="进度跟踪"
        filters={
          <ProjectPicker
            value={url.project_id}
            onChange={(id) => setUrl({ project_id: id, page: "1", task: "" }, { history: "push" })}
            ariaLabel="选择项目"
            placeholder="搜索项目名称或编号"
            className="picker-grow filter-span-2"
          />
        }
        actions={
          <button
            className="btn-primary"
            disabled={!pid}
            title={pid ? "添加一条项目进度记录" : "请先选择项目"}
            onClick={() => { setEditing(null); setNodeOpen(true); }}
          >
            + 添加进度
          </button>
        }
      />

      {error && <LoadFailed message={error} onRetry={reload} />}

      {!hasProjects ? (
        <MotionReveal><div className="card"><Empty title="暂无可参与的项目" hint="项目创建或加入后，可在这里记录关键进度。" /></div></MotionReveal>
      ) : !pid ? (
        <MotionReveal><div className="card"><Empty title="请先选择项目" hint="选择项目后查看和添加进度节点。" /></div></MotionReveal>
      ) : firstLoad ? (
        <LoadingBlock kpis={0} label="加载进度记录…" />
      ) : tasks.length === 0 ? (
        <div className="card"><Empty title="暂无进度" hint="点击「添加进度」，记录节点时间和关键内容。" /></div>
      ) : (
        <MotionReveal delay={AV_STAGGER.list * 2}>
          <CardList label="进度记录">
            {tasks.map((t) => (
              <CardItem
                key={t.id}
                title={t.name}
                code={fmtDate(t.plan_end || t.plan_start)}
                fields={[
                  { label: "添加人", value: userName(t.owner_id) },
                  { label: "记录时间", value: fmtDateTime(t.created_at), mono: true },
                ]}
                targetId={t.id}
                hit={t.id === target}
                actions={
                  <>
                    <button className="btn-ghost btn-xs" onClick={() => { setEditing(t); setNodeOpen(true); }}>编辑</button>
                    <button className="btn-ghost btn-xs btn-danger-outline" onClick={() => setRemoveTarget(t)}>删除</button>
                  </>
                }
              />
            ))}
          </CardList>
          <DesktopTable>
            <table className="grid" aria-busy={loading}>
              <thead>
                <tr>
                  <th>进度节点时间</th>
                  <th>进度关键内容</th>
                  <th>添加人</th>
                  <th>记录时间</th>
                  <th className="no-print" />
                </tr>
              </thead>
              <tbody>
                {tasks.map((t) => (
                  <tr key={t.id} data-target-id={t.id} className={rowClass(undefined, t.id === target)}>
                    <td className="mono">{fmtDate(t.plan_end || t.plan_start)}</td>
                    <td><span className="ellipsis" title={t.name}>{t.name}</span></td>
                    <td>
                      <span className="inline-person">
                        <Avatar name={userName(t.owner_id)} size={22} />
                        {userName(t.owner_id)}
                      </span>
                    </td>
                    <td className="mono tiny">{fmtDateTime(t.created_at)}</td>
                    <td className="no-print">
                      <span className="table-actions">
                        <button className="btn-ghost btn-xs" onClick={() => { setEditing(t); setNodeOpen(true); }}>
                          编辑
                        </button>
                        <button className="btn-ghost btn-xs btn-danger-outline" onClick={() => setRemoveTarget(t)}>
                          删除
                        </button>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </DesktopTable>
          <Pagination
            page={page}
            size={size}
            total={total}
            loading={loading}
            ariaLabel="进度记录分页"
            onChange={(next) => setUrl({ page: String(next.page), size: String(next.size) })}
          />
        </MotionReveal>
      )}

      <ProgressNodeDialog
        open={nodeOpen}
        onClose={() => setNodeOpen(false)}
        projectId={pid}
        task={editing}
        onSaved={() => {
          toast.ok(editing ? "进度已更新" : "进度已添加");
          reload();
        }}
      />

      <Confirm
        open={!!removeTarget}
        danger
        loading={busy}
        title="删除这条进度记录？"
        text={removeTarget ? `「${removeTarget.name}」删除后不可恢复。` : ""}
        okText="确认删除"
        onConfirm={remove}
        onCancel={() => setRemoveTarget(null)}
      />
    </div>
  );
}
