"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  errText, expensesApi, fetchObjectUrl, projectsApi, tasksApi, unwrapPaged,
  type Attachment, type Expense, type Project, type ProjectChange, type Task,
} from "@/lib/api";
import {
  batchFailureToast,
  classifyTransferFailure,
  failureLine,
  failureToast,
  type TransferFailure,
} from "@/lib/uploadErrors";
import { useMenus, useMeta } from "@/lib/useMeta";
import {
  contractStatusLabel,
  expenseStatusLabel,
  expenseTone,
  fmtDate,
  fmtDateTime,
  fmtMoney,
  projectChangeFieldLabel,
  projectChangeValueLabel,
} from "@/lib/labels";
import {
  CONTRACT_ATTACHMENT_EXTENSIONS, DOCUMENT_ATTACHMENT_EXTENSIONS, IMAGE_ATTACHMENT_EXTENSIONS,
  MAX_ATTACHMENT_SIZE_LABEL, formatFileSize,
} from "@/lib/uploadLimits";
import {
  canPreviewInline, fileTypeLabel, isImageAttachment, previewBlobType,
} from "@/lib/contentPreview";
import { PROJECT_TABS, parseProjectTab, type ProjectTab } from "@/lib/projectTabs";
import Badge from "@/components/ui/Badge";
import Empty from "@/components/ui/Empty";
import { CardItem, CardList, DesktopTable } from "@/components/ui/CardList";
import { LoadingBlock } from "@/components/ui/PageState";
import FileDropZone from "@/components/ui/FileDropZone";
import { useToast } from "@/components/ui/Toast";
import MotionTabs from "@/components/motion/MotionTabs";
import { useActivity } from "@/lib/useActivity";
import { isAbortError } from "@/lib/useAsyncData";
import { linkAbortSignal, refreshAbortMessage, useRegisterPageRefresh } from "@/lib/pageRefresh";
import { useUploadQueue } from "@/lib/useUploadQueue";
import ProjectFormDialog from "../ProjectFormDialog";
import AttachmentPreviewDialog from "@/components/ui/AttachmentPreviewDialog";
import ProgressNodeDialog from "../../progress/ProgressNodeDialog";
import ExpenseDialog from "../../costs/ExpenseDialog";
import ExpenseDetailDialog from "../../costs/ExpenseDetailDialog";
import ProjectReceivablesPanel from "./ProjectReceivablesPanel";

/** Tab 定义与 `?tab=` 兼容规则在 `@/lib/projectTabs`（纯逻辑、有单测）。 */
const TABS = PROJECT_TABS;
type Tab = ProjectTab;

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
  const { hasProjectScope, isSuperAdmin } = useMenus();
  const toast = useToast();
  const { beginActivity } = useActivity();
  const [tab, setTab] = useState<Tab>(() => parseProjectTab(search.get("tab")));
  const [project, setProject] = useState<Project | null>(null);
  const [content, setContent] = useState("");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  /** 项目级附件（`ref_type=""`）：图片进素材墙，其余（PDF/Word/Excel）进附件资料列表。 */
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [contracts, setContracts] = useState<Attachment[]>([]);
  /** 图片附件的对象 URL（缩略图用）；调用方负责 revoke，见 previewUrlsRef。 */
  const [previews, setPreviews] = useState<Record<number, string>>({});
  /** 缩略图取不到的分层结果（502 可重试 / 404 已丢失）：与「还没有缩略图」区分开，见 BLF-1137。 */
  const [previewFailures, setPreviewFailures] = useState<Record<number, TransferFailure>>({});
  const [changes, setChanges] = useState<ProjectChange[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const imageUploads = useUploadQueue();
  const documentUploads = useUploadQueue();
  const contractUploads = useUploadQueue();
  const [err, setErr] = useState("");
  const [editOpen, setEditOpen] = useState(false);
  const [nodeOpen, setNodeOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [expenseOpen, setExpenseOpen] = useState(false);
  /** 被驳回的支出：打开登记弹层时预填原单（复用成本页的「重新提交」流程）。 */
  const [resubmitOf, setResubmitOf] = useState<Expense | null>(null);
  /** 打开只读详情的支出（`null` = 未打开）；成本 Tab 卡片 / 行点击绑定。 */
  const [expenseDetail, setExpenseDetail] = useState<Expense | null>(null);
  /** 打开预览的文件（`null` = 未打开）。图片与 PDF 内联渲染，其余给出下载引导。 */
  const [filePreview, setFilePreview] = useState<Attachment | null>(null);
  const previewUrlsRef = useRef<string[]>([]);
  const hydratedRef = useRef(false);
  const loadSeqRef = useRef(0);
  /** `reloadChanges` 的乱序守卫：只有最后一次请求的响应才允许写入 `changes`。 */
  const changesSeqRef = useRef(0);
  const loadControllerRef = useRef<AbortController | null>(null);
  const auxiliaryControllerRef = useRef<AbortController | null>(null);

  const readAuxiliary = useCallback(async <T,>(loader: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    auxiliaryControllerRef.current?.abort();
    const controller = new AbortController();
    auxiliaryControllerRef.current = controller;
    try {
      return await loader(controller.signal);
    } finally {
      if (auxiliaryControllerRef.current === controller) auxiliaryControllerRef.current = null;
    }
  }, []);
  /**
   * 取附件预览的对象 URL：**一律走鉴权下载接口**（`Attachment.path` 是私有桶 S3 URL，不可热链）。
   *
   * 失败时**抛出**原始异常，由调用方各自收口 —— 两处需要的收尾不同：
   *   · 缩略图：`loadAll` / `retryPreview` 捕获后按 `uploadErrors` 存成分层结果（502/404 分开显示）；
   *   · 预览弹层：`AttachmentPreviewDialog` 自己捕获并分层渲染（502 给「重试」，404 只说已丢失）。
   */
  const fetchPreviewUrl = useCallback(
    async (a: Attachment): Promise<string> =>
      // 强制按扩展名定 blob MIME：这份 URL 会交给图片元素 / iframe，
      // 不能让上传时客户端声明的 Content-Type 决定字节怎么被解释（存储型 XSS）。
      fetchObjectUrl(
        `/projects/${pid}/attachments/${a.id}/download`,
        previewBlobType(a) ?? undefined,
      ),
    [pid],
  );

  // 图片与文档分开呈现：素材墙是缩略图网格，附件资料是文件行，
  // 两者共用同一份后端列表（都是项目级附件），因此不重复展示同一个文件。
  const documentRows = useMemo(
    () => attachments.filter((a) => !isImageAttachment(a)),
    [attachments],
  );
  const imageRows = useMemo(
    () => attachments.filter(isImageAttachment),
    [attachments],
  );

  const loadAll = useCallback(async ({
    trackActivity = true,
    signal: externalSignal,
  }: { trackActivity?: boolean; signal?: AbortSignal } = {}): Promise<string | null> => {
    loadControllerRef.current?.abort();
    auxiliaryControllerRef.current?.abort();
    auxiliaryControllerRef.current = null;
    const controller = new AbortController();
    const detach = linkAbortSignal(externalSignal, controller);
    const loadId = ++loadSeqRef.current;
    const reportAbort = () => {
      const message = refreshAbortMessage(externalSignal);
      if (message && loadSeqRef.current === loadId) setErr(message);
      return message;
    };
    loadControllerRef.current = controller;
    const finish = trackActivity
      ? beginActivity({ label: "加载项目档案", scope: "content" })
      : () => {};
    setLoading(true);
    setErr("");
    try {
      if (controller.signal.aborted) return reportAbort();
      const [p, assetRows, contractRows, changeRows, taskRows, expenseRows] = await Promise.all([
        projectsApi.get(pid, controller.signal),
        projectsApi.attachments(pid, "", controller.signal),
        projectsApi.attachments(pid, "contract", controller.signal),
        projectsApi.changes(pid, controller.signal),
        tasksApi.list(`?project_id=${pid}&page=1&size=100&sort=-plan_end`, controller.signal),
        expensesApi.list(`?project_id=${pid}&page=1&size=100&sort=-exp_date`, controller.signal),
      ]);
      if (loadSeqRef.current !== loadId) return null;
      if (controller.signal.aborted) return reportAbort();
      const pagedTasks = unwrapPaged<Task>(taskRows);
      const pagedExpenses = unwrapPaged<Expense>(expenseRows);
      setProject(p);
      setContent(p.description || "");
      setAttachments(assetRows);
      setContracts(contractRows);
      // 整页重取也会覆盖变更日志：递增序号，让任何在途的 reloadChanges 响应作废，
      // 避免它晚于本次 loadAll 返回、又把旧日志写回去。
      changesSeqRef.current += 1;
      setChanges(changeRows);
      setTasks(pagedTasks.items);
      setExpenses(pagedExpenses.items);
      hydratedRef.current = true;

      previewUrlsRef.current.forEach(URL.revokeObjectURL);
      previewUrlsRef.current = [];
      // 缩略图只为图片附件生成：PDF 的 blob 动辄数 MB，缩略图位置实际用不到。
      const imageRows = assetRows.filter(isImageAttachment);
      const outcomes = await Promise.all(
        imageRows.map(async (a) => {
          try {
            return { id: a.id, url: await fetchPreviewUrl(a), failure: null };
          } catch (e) {
            // 缩略图取不到不是页面级错误：按分层记下来，行内给「重试」而不是整页报错
            return { id: a.id, url: "", failure: classifyTransferFailure(e) };
          }
        }),
      );
      if (loadSeqRef.current !== loadId) return null;
      if (controller.signal.aborted) return reportAbort();
      const next: Record<number, string> = {};
      const nextFailures: Record<number, TransferFailure> = {};
      for (const { id, url, failure } of outcomes) {
        if (url) {
          next[id] = url;
          previewUrlsRef.current.push(url);
        } else if (failure) {
          nextFailures[id] = failure;
        }
      }
      setPreviews(next);
      setPreviewFailures(nextFailures);
      return null;
    } catch (e) {
      if (loadSeqRef.current !== loadId) return null;
      if (controller.signal.aborted) return reportAbort();
      if (isAbortError(e)) return null;
      const message = errText(e);
      setErr(message);
      return message;
    } finally {
      detach();
      if (loadSeqRef.current === loadId) setLoading(false);
      finish();
      if (loadControllerRef.current === controller) loadControllerRef.current = null;
    }
  }, [beginActivity, fetchPreviewUrl, pid]);

  /**
   * 只重取变更日志，不触发整页 `loadAll`。
   *
   * 文档自动保存、进度 / 成本 / 应收弹层保存后都会调用它：这些操作只新增一条日志，
   * 若走 `loadAll` 会把附件、缩略图等一并重取并整体替换，既慢又打断用户当前视图。
   * 用 `changesSeqRef` 守卫乱序：只有最后一次请求的响应才写回，快速连续变更时
   * 旧响应不会覆盖新结果。失败静默（下次打开日志 Tab 或任一保存动作会再试），
   * 日志刷新失败不值得弹错误打断用户。
   */
  const reloadChanges = useCallback(async () => {
    const seq = ++changesSeqRef.current;
    try {
      const rows = await projectsApi.changes(pid);
      if (seq !== changesSeqRef.current) return;
      setChanges(rows);
    } catch {
      // 静默：变更日志不是关键路径。
    }
  }, [pid]);

  useRegisterPageRefresh(async (signal) => {
    const editing = project !== null && content !== (project.description || "");
    if (
      editing || saveState === "saving" || busy || imageUploads.uploading ||
      documentUploads.uploading || contractUploads.uploading
    ) {
      throw new Error("有未保存的内容，请保存后再刷新");
    }
    const message = await loadAll({ signal });
    if (message) throw new Error(message);
  });

  useEffect(() => {
    loadAll();
    return () => {
      loadControllerRef.current?.abort();
      loadControllerRef.current = null;
      auxiliaryControllerRef.current?.abort();
      auxiliaryControllerRef.current = null;
    };
  }, [loadAll]);
  useEffect(() => () => previewUrlsRef.current.forEach(URL.revokeObjectURL), []);
  useEffect(() => {
    const t = parseProjectTab(search.get("tab"));
    setTab(t);
  }, [search]);

  // 打开「日志」Tab 时重取一次：外部（审批 / 他人编辑）造成的变更也能被及时看到。
  useEffect(() => {
    if (tab !== "日志") return;
    void reloadChanges();
  }, [tab, reloadChanges]);

  useEffect(() => {
    if (!project || !hydratedRef.current) return;
    if (content === (project.description || "")) return;
    const timer = window.setTimeout(async () => {
      const finish = beginActivity({ label: "保存项目文档", scope: "form" });
      setSaveState("saving");
      try {
        const saved = await projectsApi.update(pid, { description: content });
        setProject(saved);
        setSaveState("saved");
        // 文档自动保存也会写一条变更日志：立即刷新，用户切到「日志」Tab 无需整页刷新。
        void reloadChanges();
      } catch {
        setSaveState("error");
      } finally {
        finish();
      }
    }, 900);
    return () => window.clearTimeout(timer);
  }, [beginActivity, content, pid, project, reloadChanges]);

  function selectTab(next: Tab) {
    setTab(next);
    const q = new URLSearchParams(search.toString());
    q.set("tab", next);
    router.replace(`/projects/${pid}?${q.toString()}`, { scroll: false });
  }

  /** 打开进度编辑弹层：卡片 / 整行 / 行内「编辑」三个入口共用同一动作。 */
  function editTask(t: Task) {
    setEditingTask(t);
    setNodeOpen(true);
  }

  /**
   * 上传图片素材（素材墙）。
   *
   * 图片与文档走后端同一个项目级附件接口（`ref_type=""`），
   * 分开的只是前端闸口：素材墙只收图片，附件区收 PDF/Word/Excel。
   */
  async function uploadImages(files: File[]) {
    if (!files.length) return;
    setBusy(true);
    try {
      const result = await imageUploads.start(files, (file, options) =>
        // 文件行已有局部进度，项目档案上传不再额外拉起横跨页面的全局活动条。
        projectsApi.upload(pid, file, "", { ...options, trackActivity: false }),
      );
      // 取消（切走页签 / 卸载）不算失败，也不刷新列表
      if (result.aborted) return;
      if (result.ok.length) {
        toast.ok(result.ok.length === 1 ? "图片已上传" : `${result.ok.length} 张图片已上传`);
      }
      // 失败原因按档位给（502 可重试 / 404 已丢失 / 400 不合规），不再一律「请查看失败原因」
      if (result.failed) toast.err(batchFailureToast(result.failures));
      await loadAll({ trackActivity: false });
    } catch (e) {
      toast.err(failureToast(classifyTransferFailure(e)));
    } finally {
      setBusy(false);
    }
  }

  /** 重试一条失败的项目图片上传（原文件还在内存里，不必让用户重选） */
  async function retryImage(id: number) {
    setBusy(true);
    try {
      const result = await imageUploads.retry(id);
      if (result.aborted) return;
      if (result.ok.length) {
        toast.ok("图片已上传");
        await loadAll({ trackActivity: false });
      } else if (result.failures[0]) {
        toast.err(failureToast(result.failures[0]));
      }
    } catch (e) {
      toast.err(failureToast(classifyTransferFailure(e)));
    } finally {
      setBusy(false);
    }
  }

  /** 重试一张缩略图：502 存储抖一下之后不必刷新整页 */
  async function retryPreview(a: Attachment) {
    try {
      const url = await fetchPreviewUrl(a);
      previewUrlsRef.current.push(url);
      setPreviews((prev) => ({ ...prev, [a.id]: url }));
      setPreviewFailures((prev) => {
        const next = { ...prev };
        delete next[a.id];
        return next;
      });
    } catch (e) {
      const failure = classifyTransferFailure(e);
      setPreviewFailures((prev) => ({ ...prev, [a.id]: failure }));
    }
  }

  /** 上传文档附件（PDF / Word / Excel / 图片，同一项目级附件接口）。 */
  async function uploadDocuments(files: File[]) {
    if (!files.length) return;
    setBusy(true);
    try {
      const result = await documentUploads.start(files, (file, options) =>
        projectsApi.upload(pid, file, "", { ...options, trackActivity: false }),
      );
      if (result.aborted) return;
      if (result.ok.length) {
        toast.ok(result.ok.length === 1 ? "附件已上传" : `${result.ok.length} 个附件已上传`);
      }
      if (result.failed) toast.err(batchFailureToast(result.failures));
      await loadAll({ trackActivity: false });
    } catch (e) {
      toast.err(failureToast(classifyTransferFailure(e)));
    } finally {
      setBusy(false);
    }
  }

  /** 重试一条失败的项目附件上传 */
  async function retryDocument(id: number) {
    setBusy(true);
    try {
      const result = await documentUploads.retry(id);
      if (result.aborted) return;
      if (result.ok.length) {
        toast.ok("附件已上传");
        await loadAll({ trackActivity: false });
      } else if (result.failures[0]) {
        toast.err(failureToast(result.failures[0]));
      }
    } catch (e) {
      toast.err(failureToast(classifyTransferFailure(e)));
    } finally {
      setBusy(false);
    }
  }

  async function uploadContract(files: File[]) {
    if (!files.length) return;
    setBusy(true);
    try {
      const result = await contractUploads.start(files, (file, options) =>
        projectsApi.upload(pid, file, "contract", { ...options, trackActivity: false }),
      );
      if (result.aborted) return;
      if (result.ok.length) toast.ok("合同附件已上传");
      if (result.failed) toast.err(batchFailureToast(result.failures));
      try {
        setContracts(await readAuxiliary((signal) => projectsApi.attachments(pid, "contract", signal)));
      } catch (e) {
        if (!isAbortError(e)) throw e;
      }
    } catch (e) {
      toast.err(failureToast(classifyTransferFailure(e)));
    } finally {
      setBusy(false);
    }
  }

  /** 重试一条失败的合同附件上传 */
  async function retryContract(id: number) {
    setBusy(true);
    try {
      const result = await contractUploads.retry(id);
      if (result.aborted) return;
      if (result.ok.length) {
        toast.ok("合同附件已上传");
        try {
          setContracts(await readAuxiliary((signal) => projectsApi.attachments(pid, "contract", signal)));
        } catch (e) {
          if (!isAbortError(e)) throw e;
        }
      } else if (result.failures[0]) {
        toast.err(failureToast(result.failures[0]));
      }
    } catch (e) {
      toast.err(failureToast(classifyTransferFailure(e)));
    } finally {
      setBusy(false);
    }
  }

  async function download(a: Attachment) {
    const finish = beginActivity({ label: "下载附件", scope: "form" });
    try {
      await projectsApi.downloadAttachment(pid, a.id, a.filename);
    } catch (e) {
      // 下载失败同样分档：502 提示稍后重试，404 才说文件已丢失
      toast.err(failureToast(classifyTransferFailure(e)));
    } finally {
      finish();
    }
  }

  async function removeAttachment(a: Attachment) {
    const finish = beginActivity({ label: "移除项目附件", scope: "form" });
    setBusy(true);
    try {
      await projectsApi.deleteAttachment(pid, a.id);
      toast.ok("附件已移除");
      await loadAll();
    } catch (e) {
      toast.err(failureToast(classifyTransferFailure(e)));
    } finally {
      setBusy(false);
      finish();
    }
  }

  if (loading && !project) return <LoadingBlock kpis={2} label="加载项目档案…" />;
  if (err && !project) return <div className="err-banner">{err}</div>;
  if (!project) return <Empty title="项目不存在" hint="项目可能已删除，或当前账号无权访问。" />;

  const owner = project.owner_name || userName(project.owner_id);
  // 与后端 check_project_access 同判定：任一项目内容模块即全局可写，不再要求是负责人/成员
  const canWriteProject = hasProjectScope;
  const spent = expenses
    .filter((x) => ["approved", "exception"].includes(x.status))
    .reduce((sum, x) => sum + x.amount, 0);

  return (
    <div>
      <div className="page-head project-detail-head">
        <div>
          <h1>
            <span className="ellipsis" title={project.name}>{project.name}</span>
            <span className="sub mono">{project.code}</span>
          </h1>
          <div className="project-meta">
            <span>负责人：{owner || "-"}</span>
            <span>客户：{project.client || "-"}</span>
            <span>合同：{project.contract_status ? contractStatusLabel(project.contract_status) : "未登记"}</span>
          </div>
        </div>
        <div className="actions no-print">
          <button className="btn-ghost" onClick={() => setEditOpen(true)}>编辑项目</button>
          <Link className="btn-ghost" href={`/progress?project_id=${pid}`}>进度跟踪</Link>
          <Link className="btn-ghost" href={`/costs?project_id=${pid}`}>成本记录</Link>
          <Link className="btn-ghost" href="/projects">返回台账</Link>
        </div>
      </div>

      {err && <div className="err-banner">{err}</div>}

      <MotionTabs
        items={TABS.map((item) => ({ id: item, label: item }))}
        active={tab}
        onChange={selectTab}
      >

      {tab === "文档" && (
        <section className="doc-shell">
          <div className="doc-toolbar">
            <div>
              <strong>项目文档</strong>
            </div>
            <div className="doc-actions">
              <span className={`save-state ${saveState}`} role="status">
                {saveState === "saving" ? "保存中…" : saveState === "saved" ? "已自动保存" : saveState === "error" ? "保存失败" : "自动保存"}
              </span>
            </div>
          </div>
          <textarea
            className="doc-editor"
            value={content}
            onChange={(e) => { setSaveState("idle"); setContent(e.target.value); }}
            aria-label="项目文档正文"
            placeholder="在这里记录项目背景、目标、会议结论、现场情况或下一步安排…"
          />

          <div className="doc-block">
            <div className="section-head">
              <div>
                <h2>附件资料</h2>
                <p>单个文件不超过 {MAX_ATTACHMENT_SIZE_LABEL}。</p>
              </div>
              <FileDropZone
                variant="button"
                extensions={DOCUMENT_ATTACHMENT_EXTENSIONS}
                items={documentUploads.items}
                disabled={busy}
                label={documentUploads.uploading ? "上传中…" : "上传附件"}
                ariaLabel="上传项目附件"
                onFiles={uploadDocuments}
                onRetry={retryDocument}
              />
            </div>
            {documentRows.length === 0 ? (
              <div className="doc-empty">上传 PDF、Word 或 Excel 后，点「预览」可在窗口内查看；Word / Excel 浏览器无法渲染，下载后用本地应用打开。</div>
            ) : (
              <ul className="doc-files">
                {documentRows.map((a) => (
                  <li className="doc-file" key={a.id}>
                    <span className="doc-file-type" aria-hidden="true">{fileTypeLabel(a)}</span>
                    <span className="doc-file-name" title={a.filename}>{a.filename}</span>
                    <span className="doc-file-size">{formatFileSize(a.size)}</span>
                    <span className="doc-file-actions">
                      <button type="button" className="linklike" onClick={() => setFilePreview(a)}>
                        {canPreviewInline(a) ? "预览" : "查看"}
                      </button>
                      <button type="button" className="linklike" onClick={() => download(a)}>下载</button>
                      <button type="button" className="linklike danger-link" onClick={() => removeAttachment(a)}>移除</button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="doc-block">
            <div className="section-head">
              <div>
                <h2>图片素材</h2>
              </div>
              <FileDropZone
                variant="button"
                extensions={IMAGE_ATTACHMENT_EXTENSIONS}
                items={imageUploads.items}
                disabled={busy}
                multiple
                label={imageUploads.uploading ? "上传中…" : "上传图片"}
                ariaLabel="上传项目图片"
                onFiles={uploadImages}
                onRetry={retryImage}
              />
            </div>
            <div className="doc-assets">
              {imageRows.length === 0 ? (
                <div className="doc-empty">上传的图片会依次显示在这里，形成项目素材墙。</div>
              ) : imageRows.map((a) => (
                <figure className="asset-tile" key={a.id}>
                  {previews[a.id] ? (
                    <button type="button" className="asset-preview" onClick={() => setFilePreview(a)} aria-label={`预览 ${a.filename}`}>
                      <img src={previews[a.id]} alt={a.filename} />
                    </button>
                  ) : previewFailures[a.id] ? (
                    // 缩略图取不到：分层文案 + 只在可重试档给「重试」（404 给重试按钮是误导）
                    <div className="asset-file asset-failed">
                      <span className={`chip ${previewFailures[a.id].retryable ? "warn" : "danger"}`}>
                        {previewFailures[a.id].label}
                      </span>
                      <span className="tiny">{failureLine(previewFailures[a.id])}</span>
                      {previewFailures[a.id].retryable && (
                        <button type="button" className="linklike" onClick={() => retryPreview(a)}>重试</button>
                      )}
                    </div>
                  ) : (
                    <div className="asset-file">{fileTypeLabel(a)}</div>
                  )}
                  <figcaption>
                    <span className="ellipsis" title={a.filename}>{a.filename}</span>
                    <span className="asset-actions">
                      <button type="button" onClick={() => download(a)}>下载</button>
                      <button type="button" className="danger-link" onClick={() => removeAttachment(a)}>移除</button>
                    </span>
                  </figcaption>
                </figure>
              ))}
            </div>
          </div>
        </section>
      )}

      {tab === "合同" && (
        <section className="card detail-section">
          <div className="section-head">
            <div>
              <h2>合同档案</h2>
            </div>
            <FileDropZone
              variant="button"
              extensions={CONTRACT_ATTACHMENT_EXTENSIONS}
              items={contractUploads.items}
              disabled={busy}
              label={contractUploads.uploading ? "上传中…" : "上传合同附件"}
              ariaLabel="上传合同附件"
              onFiles={uploadContract}
              onRetry={retryContract}
            />
          </div>
          <div className="contract-grid">
            <div className="contract-card">
              <span>合同状态</span>
              <Badge
                status={project.contract_status ? contractStatusLabel(project.contract_status) : "未登记"}
                tone={contractStatusLabel(project.contract_status) === "已签订" ? "done" : "todo"}
              />
            </div>
            <div className="contract-card">
              <span>合同金额</span>
              <strong>{fmtMoney(project.budget_total)} 元</strong>
            </div>
            <div className="contract-card">
              <span>客户联系人</span>
              <strong>{project.client_contact || "-"}</strong>
            </div>
            <div className="contract-card">
              <span>联系方式</span>
              <strong>{project.client_phone || "-"}</strong>
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
                  <button
                    type="button"
                    className="linklike"
                    onClick={() => setFilePreview(a)}
                  >
                    {canPreviewInline(a) ? "预览" : "查看"}
                  </button>
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
            <>
            <CardList label="项目进度记录">
              {tasks.map((t) => (
                <CardItem
                  key={t.id}
                  title={t.name}
                  code={fmtDate(t.plan_end || t.plan_start)}
                  fields={[{ label: "记录人", value: userName(t.owner_id) }]}
                  onSelect={() => editTask(t)}
                  actions={<button className="btn-ghost btn-xs" onClick={() => editTask(t)}>编辑</button>}
                />
              ))}
            </CardList>
            <DesktopTable>
              <table className="grid">
                <thead><tr><th>进度节点时间</th><th>进度关键内容</th><th>记录人</th><th className="no-print" /></tr></thead>
                <tbody>
                  {tasks.map((t) => (
                    <tr
                      key={t.id}
                      className="clickable-row"
                      title="点击编辑进度"
                      onClick={() => editTask(t)}
                    >
                      <td className="mono">{fmtDate(t.plan_end || t.plan_start)}</td>
                      <td><span className="ellipsis" title={t.name}>{t.name}</span></td>
                      <td>{userName(t.owner_id)}</td>
                      <td className="no-print" onClick={(e) => e.stopPropagation()}>
                        <button className="btn-ghost btn-xs" onClick={() => editTask(t)}>编辑</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </DesktopTable>
            </>
          )}
        </section>
      )}

      {tab === "成本" && (
        <section className="card detail-section">
          <div className="section-head">
            <div>
              <h2>项目成本</h2>
              <p>合同金额 {fmtMoney(project.budget_total)} 元 · 已登记成本 {fmtMoney(spent)} 元</p>
            </div>
            <button className="btn-primary" onClick={() => { setResubmitOf(null); setExpenseOpen(true); }}>+ 成本</button>
          </div>
          {expenses.length === 0 ? (
            <Empty title="暂无成本记录" hint="点击「+ 成本」登记项目关联费用。" />
          ) : (
            <>
            <CardList label="项目成本">
              {expenses.map((x) => (
                <CardItem
                  key={x.id}
                  title={`${fmtMoney(x.amount)} 元`}
                  code={fmtDate(x.exp_date)}
                  badges={<Badge status={expenseStatusLabel(x.status)} tone={expenseTone(x.status)} />}
                  fields={[
                    { label: "人员", value: x.subject },
                    { label: "费用说明", value: x.note || "-" },
                  ]}
                  onSelect={() => setExpenseDetail(x)}
                />
              ))}
            </CardList>
            <DesktopTable>
              <table className="grid">
                <thead><tr><th>日期</th><th>人员</th><th className="num">金额</th><th>费用说明</th><th>状态</th></tr></thead>
                <tbody>
                  {expenses.map((x) => (
                    <tr
                      key={x.id}
                      className="clickable-row"
                      title="点击查看支出详情"
                      onClick={() => setExpenseDetail(x)}
                    >
                      <td className="mono">{fmtDate(x.exp_date)}</td>
                      <td>{x.subject}</td>
                      <td className="num">{fmtMoney(x.amount)}</td>
                      <td><span className="ellipsis" title={x.note}>{x.note || "-"}</span></td>
                      <td><Badge status={expenseStatusLabel(x.status)} tone={expenseTone(x.status)} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </DesktopTable>
            </>
          )}
        </section>
      )}

      {tab === "应收" && (
        <ProjectReceivablesPanel
          key={pid}
          projectId={pid}
          canWrite={canWriteProject && project.status !== "archived"}
          canDelete={isSuperAdmin && project.status !== "archived"}
          onChanged={reloadChanges}
        />
      )}

      {tab === "日志" && (
        <section className="card detail-section">
          <div className="section-head">
            <div>
              <h2>项目变更日志</h2>
            </div>
          </div>
          {changes.length === 0 ? (
            <Empty title="暂无变更记录" hint="修改项目信息后，系统会自动记录变更。" />
          ) : (
            <ul className="timeline">
              {changes.map((c) => (
                <li key={c.id}>
                  <span className="t mono">{fmtDateTime(c.at)}</span>
                  <span>
                    <b>{projectChangeFieldLabel(c.field)}</b>：
                    {c.old ? (
                      <>
                        <span className="muted">{projectChangeValueLabel(c.field, c.old)}</span> → {projectChangeValueLabel(c.field, c.new)}
                      </>
                    ) : (
                      // 事件型变更（成本 / 应收 / 回款）：new 本身就是一句人话，
                      // 没有「旧 → 新」可比，直接展示，不补「空」。
                      <>{c.new}</>
                    )}
                    {c.by_id != null && (
                      <span className="muted tiny"> · {userName(c.by_id)}</span>
                    )}
                  </span>
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
        onSaved={(saved) => { setProject(saved); toast.ok("项目信息已保存"); void reloadChanges(); }}
      />
      <ProgressNodeDialog
        open={nodeOpen}
        onClose={() => setNodeOpen(false)}
        projectId={pid}
        task={editingTask}
        onSaved={async () => {
          toast.ok(editingTask ? "进度已更新" : "进度已添加");
          void reloadChanges();
          try {
            const rows = await readAuxiliary((signal) =>
              tasksApi.list(`?project_id=${pid}&page=1&size=100&sort=-plan_end`, signal),
            );
            setTasks(unwrapPaged<Task>(rows).items);
          } catch (e) {
            if (!isAbortError(e)) throw e;
          }
        }}
      />
      <ExpenseDialog
        open={expenseOpen}
        onClose={() => setExpenseOpen(false)}
        projectId={pid}
        resubmitOf={resubmitOf}
        onSaved={async (msg) => {
          toast.ok(msg);
          void reloadChanges();
          try {
            const rows = await readAuxiliary((signal) =>
              expensesApi.list(`?project_id=${pid}&page=1&size=100&sort=-exp_date`, signal),
            );
            setExpenses(unwrapPaged<Expense>(rows).items);
          } catch (e) {
            if (!isAbortError(e)) throw e;
          }
        }}
      />
      <ExpenseDetailDialog
        open={!!expenseDetail}
        expense={expenseDetail}
        onClose={() => setExpenseDetail(null)}
        onResubmit={(x) => {
          // 被驳回的单据：关掉只读详情，复用登记弹层的「重新提交」预填原单。
          setExpenseDetail(null);
          setResubmitOf(x);
          setExpenseOpen(true);
        }}
      />
      <AttachmentPreviewDialog
        attachment={filePreview}
        loadUrl={fetchPreviewUrl}
        onClose={() => setFilePreview(null)}
        onDownload={download}
      />
    </div>
  );
}
