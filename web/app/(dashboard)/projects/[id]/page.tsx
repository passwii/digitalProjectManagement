"use client";

import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  errText, projectsApi,
  type Attachment, type Followup, type Project, type ProjectChange,
} from "@/lib/api";
import { useMeta } from "@/lib/useMeta";
import {
  PROJECT_FLOW, fmtDate, fmtDateTime, fmtMoney, projectStatusLabel, projectTone,
} from "@/lib/labels";
import Badge from "@/components/ui/Badge";
import Empty from "@/components/ui/Empty";
import ProgressBar from "@/components/ui/ProgressBar";
import { Confirm } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import ProjectFormDialog from "../ProjectFormDialog";
import FollowupDialog from "../FollowupDialog";
import MembersDialog from "../MembersDialog";

const TABS = ["基本", "变更", "附件", "跟进"] as const;
type Tab = (typeof TABS)[number];
const DESTRUCTIVE = new Set(["cancelled", "archived", "done"]);

export default function ProjectDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const pid = Number(id);
  const { userName, deptName } = useMeta();
  const toast = useToast();

  const [tab, setTab] = useState<Tab>("基本");
  const [project, setProject] = useState<Project | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const [changes, setChanges] = useState<ProjectChange[]>([]);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [followups, setFollowups] = useState<Followup[]>([]);

  const [editOpen, setEditOpen] = useState(false);
  const [followOpen, setFollowOpen] = useState(false);
  const [editingFollow, setEditingFollow] = useState<Followup | null>(null);
  const [membersOpen, setMembersOpen] = useState(false);
  const [confirmTo, setConfirmTo] = useState<string | null>(null);
  const [confirmDel, setConfirmDel] = useState<{ title: string; text?: string; run: () => Promise<void> } | null>(null);

  const loadProject = useCallback(async () => {
    try {
      setProject(await projectsApi.get(pid));
    } catch (e) {
      setErr(errText(e));
    }
  }, [pid]);

  useEffect(() => { loadProject(); }, [loadProject]);

  const loadTab = useCallback(async () => {
    try {
      if (tab === "变更") setChanges(await projectsApi.changes(pid));
      if (tab === "附件") setAttachments(await projectsApi.attachments(pid));
      if (tab === "跟进") setFollowups(await projectsApi.followups(pid));
    } catch (e) {
      setErr(errText(e));
    }
  }, [tab, pid]);

  useEffect(() => { loadTab(); }, [loadTab]);

  async function changeStatus(to: string) {
    setBusy(true);
    try {
      const updated = await projectsApi.status(pid, to, "页面流转");
      setProject(updated);
      toast.ok(`已流转为「${projectStatusLabel(updated.status)}」`);
      if (tab === "变更") loadTab();
    } catch (e) {
      toast.err(errText(e));
    } finally {
      setBusy(false);
      setConfirmTo(null);
    }
  }

  async function uploadFile(file: File) {
    setBusy(true);
    try {
      await projectsApi.upload(pid, file);
      toast.ok("附件已上传");
      setAttachments(await projectsApi.attachments(pid));
    } catch (e) {
      toast.err(errText(e));
    } finally {
      setBusy(false);
    }
  }

  async function confirmProgress() {
    setBusy(true);
    try {
      const r = await projectsApi.confirmProgress(pid);
      toast.ok(`已确认并快照当前进度 ${r.progress}%`);
      await loadProject();
    } catch (e) {
      toast.err(errText(e));
    } finally {
      setBusy(false);
    }
  }

  if (err && !project) return <div className="err-banner">{err}</div>;
  if (!project) return <p className="muted">加载中…</p>;

  const nextStatuses = PROJECT_FLOW[project.status] ?? [];

  return (
    <div>
      <div className="page-head">
        <h1 className="ellipsis" style={{ maxWidth: "100%" }} title={project.name}>
          {project.name}
          <span className="sub mono">{project.code}</span>
        </h1>
        <div className="actions">
          <button className="btn-ghost" onClick={() => setEditOpen(true)}>编辑</button>
          <Link className="btn-ghost" href={`/progress?project_id=${project.id}`}>进度</Link>
          <Link className="btn-ghost" href={`/costs?project_id=${project.id}`}>成本</Link>
          <Link className="btn-ghost" href="/projects">返回列表</Link>
        </div>
      </div>

      <div className="kpi-row">
        <div className="kpi"><div className="k">状态</div><div className="v"><Badge status={projectStatusLabel(project.status)} tone={projectTone(project.status)} /></div></div>
        <div className="kpi"><div className="k">加权进度</div><div className="v mono">{project.progress ?? 0}%</div><ProgressBar value={project.progress ?? 0} tone="brand" /></div>
        <div className="kpi"><div className="k">负责人</div><div className="v" style={{ fontSize: 15 }}>{userName(project.owner_id)}</div></div>
        <div className="kpi"><div className="k">预算总额</div><div className="v mono">{fmtMoney(project.budget_total)}</div></div>
      </div>

      {err && <div className="err-banner">{err}</div>}

      <div className="tabs">
        {TABS.map((t) => (
          <button key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>{t}</button>
        ))}
      </div>

      {tab === "基本" && (
        <div className="card">
          <dl className="kv">
            <div><dt>项目类型</dt><dd>{project.type || "-"}</dd></div>
            <div><dt>所属部门</dt><dd>{deptName(project.dept_id)}</dd></div>
            <div><dt>客户 / 委托方</dt><dd>{project.client || "-"}</dd></div>
            <div><dt>优先级</dt><dd>{project.priority}</dd></div>
            <div><dt>计划起止</dt><dd className="mono">{fmtDate(project.plan_start)} ~ {fmtDate(project.plan_end)}</dd></div>
            <div className="span-2">
              <dt>项目成员</dt>
              <dd style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <span>{project.member_ids.map((m) => userName(m)).join("、") || "-"}</span>
                <button className="btn-ghost no-print" style={{ height: 26, lineHeight: "24px", padding: "0 8px", fontSize: 12 }} onClick={() => setMembersOpen(true)}>
                  管理成员
                </button>
              </dd>
            </div>
            <div className="span-2"><dt>项目简介</dt><dd>{project.description || "-"}</dd></div>
          </dl>

          <div style={{ marginTop: 16, paddingTop: 12, borderTop: "1px solid var(--line-soft)", display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <button className="btn-ghost" disabled={busy} onClick={confirmProgress}>确认进度快照</button>
            {nextStatuses.map((to) =>
              DESTRUCTIVE.has(to) ? (
                <button key={to} className="btn-ghost" onClick={() => setConfirmTo(to)}>→ {projectStatusLabel(to)}</button>
              ) : (
                <button key={to} className="btn-ghost" disabled={busy} onClick={() => changeStatus(to)}>→ {projectStatusLabel(to)}</button>
              )
            )}
          </div>
        </div>
      )}

      {tab === "变更" && (
        <div className="card">
          {changes.length === 0 ? (
            <Empty title="暂无变更记录" hint="项目字段或状态变更后会自动留痕。" />
          ) : (
            <ul className="timeline">
              {changes.map((c) => (
                <li key={c.id}>
                  <span className="t mono">{fmtDateTime(c.at)}</span>
                  <span>
                    <b>{c.field}</b>：<span className="muted">{c.old ?? "空"}</span> → <span className="mono">{c.new ?? "空"}</span>
                    <span className="tiny"> · {userName(c.by_id)}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {tab === "附件" && (
        <div className="card">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, gap: 12, flexWrap: "wrap" }}>
            <span className="muted" style={{ fontSize: 13 }}>支持 pdf / docx / xlsx / png / jpg，单文件 ≤ 20MB</span>
            <label className="btn-ghost" style={{ display: "inline-flex", alignItems: "center", height: 32, cursor: "pointer" }}>
              上传附件
              <input type="file" style={{ display: "none" }} accept=".pdf,.docx,.xlsx,.png,.jpg,.jpeg"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadFile(f); e.target.value = ""; }} />
            </label>
          </div>
          {attachments.length === 0 ? (
            <Empty title="暂无附件" hint="可上传立项书、合同扫描件、需求文档等。" />
          ) : (
            <table className="grid">
              <thead><tr><th>文件名</th><th className="num">大小</th><th>上传人</th><th>上传时间</th><th className="no-print" /></tr></thead>
              <tbody>
                {attachments.map((a) => (
                  <tr key={a.id}>
                    <td className="ellipsis" title={a.filename}>{a.filename}</td>
                    <td className="num">{(a.size / 1024).toFixed(1)} KB</td>
                    <td>{userName(a.uploaded_by)}</td>
                    <td className="mono tiny">{fmtDateTime(a.uploaded_at)}</td>
                    <td className="no-print">
                      <span style={{ display: "inline-flex", gap: 6 }}>
                        <button
                          className="btn-ghost"
                          style={{ height: 26, lineHeight: "24px", padding: "0 8px", fontSize: 12 }}
                          onClick={async () => {
                            try {
                              await projectsApi.downloadAttachment(pid, a.id, a.filename);
                              toast.ok(`已开始下载 ${a.filename}`);
                            } catch (e) {
                              toast.err(errText(e));
                            }
                          }}
                        >
                          下载
                        </button>
                        <button
                          className="btn-ghost"
                          style={{ height: 26, lineHeight: "24px", padding: "0 8px", fontSize: 12, color: "var(--danger)", borderColor: "var(--line-danger)" }}
                          onClick={() =>
                            setConfirmDel({
                              title: `删除附件「${a.filename}」？`,
                              text: "文件将从服务器一并移除，操作不可撤销。",
                              run: async () => {
                                await projectsApi.deleteAttachment(pid, a.id);
                                toast.ok("附件已删除");
                                setAttachments(await projectsApi.attachments(pid));
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
      )}

      {tab === "跟进" && (
        <div className="card">
          <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 10 }}>
            <button className="btn-primary" style={{ width: "auto" }} onClick={() => { setEditingFollow(null); setFollowOpen(true); }}>+ 新增跟进</button>
          </div>
          {followups.length === 0 ? (
            <Empty title="暂无跟进记录" hint="记录每次沟通，并可设置到期提醒。" />
          ) : (
            <ul className="timeline">
              {followups.map((f) => (
                <li key={f.id}>
                  <span className="t mono">{fmtDateTime(f.happened_at)}</span>
                  <span style={{ flex: 1 }}>
                    <Badge status={f.method || "跟进"} />
                    <div>{f.content || "-"}</div>
                    {f.next_step && <div className="muted" style={{ fontSize: 12 }}>下一步：{f.next_step}</div>}
                    {f.remind_at && <div className="chip warn" style={{ marginTop: 4 }}>提醒 {fmtDateTime(f.remind_at)}</div>}
                    <div className="tiny" style={{ marginTop: 2 }}>{userName(f.user_id)}</div>
                  </span>
                  <span className="no-print" style={{ display: "inline-flex", gap: 6, alignSelf: "flex-start" }}>
                    <button className="btn-ghost" style={{ height: 26, lineHeight: "24px", padding: "0 8px", fontSize: 12 }}
                      onClick={() => { setEditingFollow(f); setFollowOpen(true); }}>
                      编辑
                    </button>
                    <button
                      className="btn-ghost"
                      style={{ height: 26, lineHeight: "24px", padding: "0 8px", fontSize: 12, color: "var(--danger)", borderColor: "var(--line-danger)" }}
                      onClick={() =>
                        setConfirmDel({
                          title: "删除这条跟进记录？",
                          text: "删除后不可恢复。",
                          run: async () => {
                            await projectsApi.deleteFollowup(pid, f.id);
                            toast.ok("跟进记录已删除");
                            setFollowups(await projectsApi.followups(pid));
                          },
                        })
                      }
                    >
                      删除
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <ProjectFormDialog
        open={editOpen}
        onClose={() => setEditOpen(false)}
        project={project}
        onSaved={(saved) => {
          toast.ok("项目信息已保存（变更已留痕）");
          setProject(saved);
          setEditOpen(false);
          loadTab();
        }}
      />

      <FollowupDialog
        open={followOpen}
        onClose={() => setFollowOpen(false)}
        projectId={pid}
        followup={editingFollow}
        onSaved={(isNew) => { toast.ok(isNew ? "跟进记录已新增" : "跟进记录已保存"); loadTab(); }}
      />

      <MembersDialog
        open={membersOpen}
        onClose={() => setMembersOpen(false)}
        project={project}
        onSaved={(saved) => { toast.ok("项目成员已更新"); setProject(saved); }}
      />

      <Confirm
        open={!!confirmDel}
        danger
        loading={busy}
        title={confirmDel?.title ?? ""}
        text={confirmDel?.text}
        okText="确认删除"
        onConfirm={async () => {
          if (!confirmDel) return;
          setBusy(true);
          try {
            await confirmDel.run();
          } catch (e) {
            toast.err(errText(e));
          } finally {
            setBusy(false);
            setConfirmDel(null);
          }
        }}
        onCancel={() => setConfirmDel(null)}
      />

      <Confirm
        open={!!confirmTo}
        danger
        loading={busy}
        title={`确认流转为「${confirmTo ? projectStatusLabel(confirmTo) : ""}」？`}
        text={confirmTo === "archived" ? "归档后项目变为只读，需管理员解除归档。" : "该操作会记入变更留痕。"}
        okText="确认流转"
        onConfirm={() => confirmTo && changeStatus(confirmTo)}
        onCancel={() => setConfirmTo(null)}
      />
    </div>
  );
}
