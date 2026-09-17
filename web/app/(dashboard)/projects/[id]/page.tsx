"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  errText, expensesApi, fetchObjectUrl, projectsApi, tasksApi, unwrapPaged,
  type Attachment, type Expense, type Project, type ProjectChange, type Task,
} from "@/lib/api";
import { useMeta } from "@/lib/useMeta";
import { expenseStatusLabel, expenseTone, fmtDate, fmtDateTime, fmtMoney } from "@/lib/labels";
import { CONTRACT_ATTACHMENT_ACCEPT } from "@/lib/uploadLimits";
import Badge from "@/components/ui/Badge";
import Empty from "@/components/ui/Empty";
import { LoadingBlock } from "@/components/ui/PageState";
import { Dialog } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import MotionTabs from "@/components/motion/MotionTabs";
import { useActivity } from "@/lib/useActivity";
import ProjectFormDialog from "../ProjectFormDialog";
import ProgressNodeDialog from "../../progress/ProgressNodeDialog";
import ExpenseDialog from "../../costs/ExpenseDialog";

const TABS = ["白板", "合同", "进度", "支出", "变更"] as const;
type Tab = (typeof TABS)[number];

function parseTab(raw: string | null): Tab {
  if (raw && (TABS as readonly string[]).includes(raw)) return raw as Tab;
  if (raw === "基本" || raw === "附件" || raw === "跟进") return "白板";
  return "白板";
}

export default function ProjectDetailPage({ params }: { params: { id: string } }) {
  return (
    <Suspense fallback={<LoadingBlock kpis={0} label="加载项目档案…" />}>
      <ProjectDetail pid={Number(params.id)} />
    </Suspense>
  );
}

function ProjectDetail({ pid }: { pid: number }) {
  const router = useRouter();
  const search = useSearchParams();
  const { userName } = useMeta();
  const toast = useToast();
  const { beginActivity } = useActivity();
  const [tab, setTab] = useState<Tab>(() => parseTab(search.get("tab")));
  const [project, setProject] = useState<Project | null>(null);
  const [content, setContent] = useState("");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [assets, setAssets] = useState<Attachment[]>([]);
  const [contracts, setContracts] = useState<Attachment[]>([]);
  const [previews, setPreviews] = useState<Record<number, string>>({});
  const [changes, setChanges] = useState<ProjectChange[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [editOpen, setEditOpen] = useState(false);
  const [nodeOpen, setNodeOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [expenseOpen, setExpenseOpen] = useState(false);
  const [filePreview, setFilePreview] = useState<Attachment | null>(null);
  const previewUrlsRef = useRef<string[]>([]);
  const hydratedRef = useRef(false);
  const objectUrlFor = useCallback(async (a: Attachment) => {
    try {
      return await fetchObjectUrl(`/projects/${pid}/attachments/${a.id}/download`);
    } catch {
      return "";
    }
  }, [pid]);

  const loadAll = useCallback(async () => {
    const finish = beginActivity({ label: "加载项目档案", scope: "content" });
    setLoading(true);
    setErr("");
    try {
      const [p, assetRows, contractRows, changeRows, taskRows, expenseRows] = await Promise.all([
        projectsApi.get(pid),
        projectsApi.attachments(pid),
        projectsApi.attachments(pid, "contract"),
        projectsApi.changes(pid),
        tasksApi.list(`?project_id=${pid}&page=1&size=100&sort=-plan_end`),
        expensesApi.list(`?project_id=${pid}&page=1&size=100&sort=-exp_date`),
      ]);
      const pagedTasks = unwrapPaged<Task>(taskRows);
      const pagedExpenses = unwrapPaged<Expense>(expenseRows);
      setProject(p);
      setContent(p.description || "");
      setAssets(assetRows);
      setContracts(contractRows);
      setChanges(changeRows);
      setTasks(pagedTasks.items);
      setExpenses(pagedExpenses.items);
      hydratedRef.current = true;

      previewUrlsRef.current.forEach(URL.revokeObjectURL);
      previewUrlsRef.current = [];
      const imageRows = assetRows.filter((a) => (a.content_type || "").startsWith("image/"));
      const pairs = await Promise.all(imageRows.map(async (a) => [a.id, await objectUrlFor(a)] as const));
      const next: Record<number, string> = {};
      for (const [id, url] of pairs) {
        if (!url) continue;
        next[id] = url;
        previewUrlsRef.current.push(url);
      }
      setPreviews(next);
    } catch (e) {
      setErr(errText(e));
    } finally {
      setLoading(false);
      finish();
    }
  }, [beginActivity, objectUrlFor, pid]);

  useEffect(() => { loadAll(); }, [loadAll]);
  useEffect(() => () => previewUrlsRef.current.forEach(URL.revokeObjectURL), []);
  useEffect(() => {
    const t = parseTab(search.get("tab"));
    setTab(t);
  }, [search]);

  useEffect(() => {
    if (!project || !hydratedRef.current) return;
    if (content === (project.description || "")) return;
    const timer = window.setTimeout(async () => {
      const finish = beginActivity({ label: "保存项目白板", scope: "form" });
      setSaveState("saving");
      try {
        const saved = await projectsApi.update(pid, { description: content });
        setProject(saved);
        setSaveState("saved");
      } catch {
        setSaveState("error");
      } finally {
        finish();
      }
    }, 900);
    return () => window.clearTimeout(timer);
  }, [beginActivity, content, pid, project]);

  function selectTab(next: Tab) {
    setTab(next);
    const q = new URLSearchParams(search.toString());
    q.set("tab", next);
    router.replace(`/projects/${pid}?${q.toString()}`, { scroll: false });
  }

  async function uploadAsset(file: File) {
    const finish = beginActivity({ label: "上传项目素材", scope: "form" });
    setBusy(true);
    try {
      await projectsApi.upload(pid, file);
      toast.ok("图片已上传到项目白板");
      await loadAll();
    } catch (e) {
      toast.err(errText(e));
    } finally {
      setBusy(false);
      finish();
    }
  }

  async function uploadContract(files: FileList | null) {
    if (!files?.length) return;
    const finish = beginActivity({ label: "上传合同附件", scope: "form" });
    setBusy(true);
    try {
      for (const file of Array.from(files)) {
        await projectsApi.upload(pid, file, "contract");
      }
      toast.ok("合同附件已上传");
      setContracts(await projectsApi.attachments(pid, "contract"));
    } catch (e) {
      toast.err(errText(e));
    } finally {
      setBusy(false);
      finish();
    }
  }

  async function download(a: Attachment) {
    const finish = beginActivity({ label: "下载附件", scope: "form" });
    try {
      await projectsApi.downloadAttachment(pid, a.id, a.filename);
    } catch (e) {
      toast.err(errText(e));
    } finally {
      finish();
    }
  }

  async function removeAsset(a: Attachment) {
    const finish = beginActivity({ label: "移除项目素材", scope: "form" });
    setBusy(true);
    try {
      await projectsApi.deleteAttachment(pid, a.id);
      toast.ok("素材已移除");
      await loadAll();
    } catch (e) {
      toast.err(errText(e));
    } finally {
      setBusy(false);
      finish();
    }
  }

  if (loading && !project) return <LoadingBlock kpis={2} label="加载项目档案…" />;
  if (err && !project) return <div className="err-banner">{err}</div>;
  if (!project) return <Empty title="项目不存在" hint="项目可能已删除，或当前账号无权访问。" />;

  const owner = project.owner_name || userName(project.owner_id);
  const spent = expenses
    .filter((x) => ["approved", "exception"].includes(x.status))
    .reduce((sum, x) => sum + x.amount, 0);

  return (
    <div>
      <div className="page-head project-detail-head">
        <div>
          <div className="eyebrow">项目完整档案</div>
          <h1>
            <span className="ellipsis" title={project.name}>{project.name}</span>
            <span className="sub mono">{project.code}</span>
          </h1>
          <div className="project-meta">
            <span>负责人：{owner || "-"}</span>
            <span>客户：{project.client || "-"}</span>
            <span>合同：{project.contract_status || "未登记"}</span>
          </div>
        </div>
        <div className="actions no-print">
          <button className="btn-ghost" onClick={() => setEditOpen(true)}>编辑项目</button>
          <Link className="btn-ghost" href={`/progress?project_id=${pid}`}>进度跟踪</Link>
          <Link className="btn-ghost" href={`/costs?project_id=${pid}`}>支出记录</Link>
          <Link className="btn-ghost" href="/projects">返回台账</Link>
        </div>
      </div>

      {err && <div className="err-banner">{err}</div>}

      <MotionTabs
        items={TABS.map((item) => ({ id: item, label: item }))}
        active={tab}
        onChange={selectTab}
      >

      {tab === "白板" && (
        <section className="whiteboard-shell">
          <div className="whiteboard-toolbar">
            <div>
              <strong>项目白板</strong>
            </div>
            <div className="whiteboard-actions">
              <span className={`save-state ${saveState}`}>
                {saveState === "saving" ? "保存中…" : saveState === "saved" ? "已自动保存" : saveState === "error" ? "保存失败" : "自动保存"}
              </span>
              <label className="btn-ghost btn-file">
                {busy ? "上传中…" : "上传图片"}
                <input
                  type="file"
                  accept="image/*"
                  disabled={busy}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) uploadAsset(f);
                    e.target.value = "";
                  }}
                />
              </label>
            </div>
          </div>
          <textarea
            className="whiteboard-editor"
            value={content}
            onChange={(e) => { setSaveState("idle"); setContent(e.target.value); }}
            placeholder="在这里记录项目背景、目标、会议结论、现场情况或下一步安排…"
          />
          <div className="whiteboard-assets">
            {assets.length === 0 ? (
              <div className="whiteboard-empty">上传的图片会依次显示在这里，形成项目素材墙。</div>
            ) : assets.map((a) => (
              <figure className="asset-tile" key={a.id}>
                {(a.content_type || "").startsWith("image/") && previews[a.id] ? (
                  <button type="button" className="asset-preview" onClick={() => setFilePreview(a)}>
                    <img src={previews[a.id]} alt={a.filename} />
                  </button>
                ) : (
                  <div className="asset-file">FILE</div>
                )}
                <figcaption>
                  <span className="ellipsis" title={a.filename}>{a.filename}</span>
                  <span className="asset-actions">
                    <button type="button" onClick={() => download(a)}>下载</button>
                    <button type="button" className="danger-link" onClick={() => removeAsset(a)}>移除</button>
                  </span>
                </figcaption>
              </figure>
            ))}
          </div>
        </section>
      )}

      {tab === "合同" && (
        <section className="card detail-section">
          <div className="section-head">
            <div>
              <h2>合同档案</h2>
            </div>
            <label className="btn-primary btn-file">
              {busy ? "上传中…" : "上传合同附件"}
              <input
                type="file"
                multiple
                accept={CONTRACT_ATTACHMENT_ACCEPT}
                disabled={busy}
                onChange={(e) => { uploadContract(e.target.files); e.target.value = ""; }}
              />
            </label>
          </div>
          <div className="contract-grid">
            <div className="contract-card">
              <span>合同状态</span>
              <Badge status={project.contract_status || "未登记"} tone={project.contract_status === "已签订" ? "done" : "todo"} />
            </div>
            <div className="contract-card">
              <span>前向合同（甲方）</span>
              <strong>{project.forward_contract || "-"}</strong>
            </div>
            <div className="contract-card">
              <span>后向合同（乙方）</span>
              <strong>{project.backward_contract || "-"}</strong>
            </div>
          </div>
          {contracts.length === 0 ? (
            <Empty title="暂无合同附件" hint="上传合同扫描件或电子文件后，会在这里统一归档。" />
          ) : (
            <div className="attachment-list">
              {contracts.map((a) => (
                <div className="attachment-row" key={a.id}>
                  <span className="attachment-name" title={a.filename}>{a.filename}</span>
                  <span className="tiny">{(a.size / 1024).toFixed(1)} KB · {fmtDateTime(a.uploaded_at)}</span>
                  <button className="linklike" onClick={() => download(a)}>下载</button>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {tab === "进度" && (
        <section className="card detail-section">
          <div className="section-head">
            <div>
              <h2>进度记录</h2>
            </div>
            <button className="btn-primary" onClick={() => { setEditingTask(null); setNodeOpen(true); }}>+ 添加进度</button>
          </div>
          {tasks.length === 0 ? (
            <Empty title="暂无进度" hint="点击「添加进度」记录第一条项目进展。" />
          ) : (
            <div className="table-scroll">
              <table className="grid">
                <thead><tr><th>进度节点时间</th><th>进度关键内容</th><th>记录人</th><th className="no-print" /></tr></thead>
                <tbody>
                  {tasks.map((t) => (
                    <tr key={t.id}>
                      <td className="mono">{fmtDate(t.plan_end || t.plan_start)}</td>
                      <td><span className="ellipsis" title={t.name}>{t.name}</span></td>
                      <td>{userName(t.owner_id)}</td>
                      <td className="no-print">
                        <button className="btn-ghost btn-xs" onClick={() => { setEditingTask(t); setNodeOpen(true); }}>编辑</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {tab === "支出" && (
        <section className="card detail-section">
          <div className="section-head">
            <div>
              <h2>项目支出</h2>
              <p>项目预算 {fmtMoney(project.budget_total)} 元 · 已登记支出 {fmtMoney(spent)} 元</p>
            </div>
            <button className="btn-primary" onClick={() => setExpenseOpen(true)}>+ 支出</button>
          </div>
          {expenses.length === 0 ? (
            <Empty title="暂无支出" hint="点击「+ 支出」登记项目关联费用。" />
          ) : (
            <div className="table-scroll">
              <table className="grid">
                <thead><tr><th>日期</th><th>人员</th><th className="num">金额</th><th>费用说明</th><th>状态</th></tr></thead>
                <tbody>
                  {expenses.map((x) => (
                    <tr key={x.id}>
                      <td className="mono">{fmtDate(x.exp_date)}</td>
                      <td>{x.subject}</td>
                      <td className="num">{fmtMoney(x.amount)}</td>
                      <td><span className="ellipsis" title={x.note}>{x.note || "-"}</span></td>
                      <td><Badge status={expenseStatusLabel(x.status)} tone={expenseTone(x.status)} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {tab === "变更" && (
        <section className="card detail-section">
          <div className="section-head">
            <div>
              <h2>操作记录</h2>
            </div>
          </div>
          {changes.length === 0 ? (
            <Empty title="暂无变更记录" hint="修改项目信息后，系统会自动记录变更。" />
          ) : (
            <ul className="timeline">
              {changes.map((c) => (
                <li key={c.id}>
                  <span className="t mono">{fmtDateTime(c.at)}</span>
                  <span><b>{c.field}</b>：<span className="muted">{c.old || "空"}</span> → <span>{c.new || "空"}</span></span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      </MotionTabs>

      <ProjectFormDialog
        open={editOpen}
        onClose={() => setEditOpen(false)}
        project={project}
        onSaved={(saved) => { setProject(saved); toast.ok("项目信息已保存"); }}
      />
      <ProgressNodeDialog
        open={nodeOpen}
        onClose={() => setNodeOpen(false)}
        projectId={pid}
        task={editingTask}
        onSaved={async () => {
          toast.ok(editingTask ? "进度已更新" : "进度已添加");
          const rows = await tasksApi.list(`?project_id=${pid}&page=1&size=100&sort=-plan_end`);
          setTasks(unwrapPaged<Task>(rows).items);
        }}
      />
      <ExpenseDialog
        open={expenseOpen}
        onClose={() => setExpenseOpen(false)}
        projectId={pid}
        onSaved={async (msg) => {
          toast.ok(msg);
          const rows = await expensesApi.list(`?project_id=${pid}&page=1&size=100&sort=-exp_date`);
          setExpenses(unwrapPaged<Expense>(rows).items);
        }}
      />
      <Dialog
        open={!!filePreview}
        onClose={() => setFilePreview(null)}
        size="lg"
        title={filePreview?.filename || "图片预览"}
        footer={<button className="btn-primary" onClick={() => setFilePreview(null)}>关闭</button>}
      >
        {filePreview && previews[filePreview.id] && (
          <img className="image-preview" src={previews[filePreview.id]} alt={filePreview.filename} />
        )}
      </Dialog>
    </div>
  );
}
