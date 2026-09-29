"use client";
// 友商建档 / 编辑抽屉（BLF-1153）：基本信息 + 业绩合同行内增删 +
// 资质证书及其他附件上传 / 预览 / 下载 / 删除。
//
// 口径与 ContactDrawer 对齐：先保存基本信息拿到建档 id，子表与附件区才可用；
// 失败只 Toast + 行内报错，表单内容保留（不 reset）。
import { useCallback, useEffect, useRef, useState } from "react";
import {
  PARTNER_ATTACHMENT_CATEGORY_LABELS,
  errText,
  fetchObjectUrl,
  partnersApi,
  type Attachment,
  type Partner,
  type PartnerAttachment,
  type PartnerAttachmentCategory,
  type PartnerContract,
} from "@/lib/api";
import {
  batchFailureToast,
  classifyTransferFailure,
  failureToast,
} from "@/lib/uploadErrors";
import { canPreviewInline, previewBlobType } from "@/lib/contentPreview";
import { fmtDateTime, fmtMoney } from "@/lib/labels";
import { useForm } from "@/lib/useForm";
import { isAbortError } from "@/lib/useAsyncData";
import {
  CONTRACT_ATTACHMENT_EXTENSIONS,
  PARTNER_ATTACHMENT_EXTENSIONS,
  PARTNER_ATTACHMENT_HINT,
  formatFileSize,
} from "@/lib/uploadLimits";
import { useUploadQueue } from "@/lib/useUploadQueue";
import { Confirm, Drawer } from "@/components/ui/Modal";
import Field from "@/components/ui/Field";
import { DatePicker } from "@/components/ui/DatePicker";
import Select from "@/components/ui/Select";
import FileDropZone from "@/components/ui/FileDropZone";
import { useToast } from "@/components/ui/Toast";
import AttachmentPreviewDialog from "@/components/ui/AttachmentPreviewDialog";

interface BasicValues {
  name: string;
  contact_name: string;
  phone: string;
  email: string;
  address: string;
  remark: string;
}

const BLANK_BASIC: BasicValues = {
  name: "",
  contact_name: "",
  phone: "",
  email: "",
  address: "",
  remark: "",
};

function toBasic(partner: Partner): BasicValues {
  return {
    name: partner.name || "",
    contact_name: partner.contact_name || "",
    phone: partner.phone || "",
    email: partner.email || "",
    address: partner.address || "",
    remark: partner.remark || "",
  };
}

function toBasicPayload(values: BasicValues): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(values)) {
    payload[key] = String(raw ?? "").trim();
  }
  return payload;
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

interface ContractDraft {
  project_name: string;
  amount: string;
  signed_date: string;
  remark: string;
}

const BLANK_CONTRACT: ContractDraft = { project_name: "", amount: "", signed_date: "", remark: "" };

/** 金额空着 = 不传（后端保留 0 默认）；填了必须是 ≥0 的有效数字。 */
function contractPayload(draft: ContractDraft): { ok: boolean; body: Record<string, unknown>; error: string } {
  const project_name = draft.project_name.trim();
  if (!project_name) return { ok: false, body: {}, error: "项目名称不能为空" };
  const body: Record<string, unknown> = {
    project_name,
    signed_date: draft.signed_date || null,
    remark: draft.remark.trim(),
  };
  const rawAmount = draft.amount.trim();
  if (rawAmount) {
    const amount = Number(rawAmount);
    if (!Number.isFinite(amount)) return { ok: false, body: {}, error: "合同金额须为有效数字" };
    if (amount < 0) return { ok: false, body: {}, error: "合同金额不能为负数" };
    body.amount = amount;
  }
  return { ok: true, body, error: "" };
}

type PendingDelete =
  | { scope: "contract"; id: number; name: string }
  | { scope: "attachment"; id: number; name: string };

export default function PartnerDrawer({
  partnerId,
  onClose,
  onSaved,
}: {
  partnerId: number | "new" | null;
  onClose: () => void;
  onSaved: (partner: Partner) => void;
}) {
  const toast = useToast();
  const [partner, setPartner] = useState<Partner | null>(null);
  const [contracts, setContracts] = useState<PartnerContract[]>([]);
  const [attachments, setAttachments] = useState<PartnerAttachment[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [formErr, setFormErr] = useState("");
  const [category, setCategory] = useState<PartnerAttachmentCategory>("qual_cert");
  const uploads = useUploadQueue();
  const contractUploads = useUploadQueue();
  const [preview, setPreview] = useState<Attachment | null>(null);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  // 业绩合同行内增改
  const [contractDraft, setContractDraft] = useState<ContractDraft>(BLANK_CONTRACT);
  const [contractErr, setContractErr] = useState("");
  const [contractBusy, setContractBusy] = useState(false);
  const [editingContract, setEditingContract] = useState<{ id: number; draft: ContractDraft } | null>(null);
  const readControllerRef = useRef<AbortController | null>(null);

  const form = useForm<BasicValues>(BLANK_BASIC, {
    name: { required: "友商名称不能为空", max: 128, label: "友商名称" },
    contact_name: { max: 64, label: "联系人" },
    phone: { max: 64, label: "联系电话" },
    email: {
      label: "邮箱",
      max: 128,
      custom: (value) => (!value || EMAIL_RE.test(String(value)) ? null : "邮箱格式不正确"),
    },
    address: { max: 255, label: "地址" },
    remark: { max: 1000, label: "备注" },
  });

  useEffect(() => {
    readControllerRef.current?.abort();
    readControllerRef.current = null;
    if (!partnerId) return;
    const controller = new AbortController();
    readControllerRef.current = controller;
    if (partnerId === "new") {
      setPartner(null);
      setContracts([]);
      setAttachments([]);
      setFormErr("");
      setContractErr("");
      setContractDraft(BLANK_CONTRACT);
      setEditingContract(null);
      setPreview(null);
      setPendingDelete(null);
      setLoading(false);
      form.reset(BLANK_BASIC);
      return () => {
        controller.abort();
        if (readControllerRef.current === controller) readControllerRef.current = null;
      };
    }
    let alive = true;
    setLoading(true);
    setFormErr("");
    Promise.all([
      partnersApi.get(partnerId, controller.signal),
      partnersApi.attachments(partnerId, "", controller.signal),
    ])
      .then(([detail, files]) => {
        if (!alive || controller.signal.aborted) return;
        setPartner(detail);
        form.reset(toBasic(detail));
        setContracts(detail.contracts ?? []);
        setAttachments(files);
      })
      .catch((e) => {
        if (alive && !controller.signal.aborted && !isAbortError(e)) setFormErr(errText(e));
      })
      .finally(() => {
        if (alive && !controller.signal.aborted) setLoading(false);
        if (readControllerRef.current === controller) readControllerRef.current = null;
      });
    return () => {
      alive = false;
      controller.abort();
      if (readControllerRef.current === controller) readControllerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [partnerId]);

  const refreshAttachments = useCallback(async (partnerIdValue: number) => {
    readControllerRef.current?.abort();
    const controller = new AbortController();
    readControllerRef.current = controller;
    try {
      return await partnersApi.attachments(partnerIdValue, "", controller.signal);
    } finally {
      if (readControllerRef.current === controller) readControllerRef.current = null;
    }
  }, []);

  // 抽屉关闭或切换档案时中止在途上传，避免「关掉抽屉还在传」
  useEffect(() => {
    uploads.reset();
    contractUploads.reset();
    // 只依赖 reset（稳定引用）：依赖整个 uploads 对象会在每次进度更新时重跑，把上传掐断
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [partnerId, uploads.reset, contractUploads.reset]);

  async function saveBasic() {
    if (!form.validate()) return;
    setSaving(true);
    setFormErr("");
    try {
      const payload = toBasicPayload(form.values);
      const saved = partner
        ? await partnersApi.update(partner.id, payload)
        : await partnersApi.create(payload);
      setPartner(saved);
      form.reset(toBasic(saved));
      // 新建后留在抽屉里继续录业绩 / 附件：合同区用刚回来的数组初始化
      setContracts(saved.contracts ?? contracts);
      toast.ok(partner ? "友商档案已保存" : "友商已建档，可继续录入业绩与附件");
      onSaved(saved);
    } catch (e) {
      const message = errText(e);
      setFormErr(message);
      toast.err(message);
    } finally {
      setSaving(false);
    }
  }

  // ---------------- 业绩合同 ----------------

  async function addContract() {
    if (!partner) return;
    const parsed = contractPayload(contractDraft);
    if (!parsed.ok) {
      setContractErr(parsed.error);
      return;
    }
    setContractErr("");
    setContractBusy(true);
    try {
      const created = await partnersApi.createContract(partner.id, parsed.body);
      setContracts((rows) => [...rows, created]);
      setContractDraft(BLANK_CONTRACT);
      toast.ok("业绩合同已添加");
    } catch (e) {
      const message = errText(e);
      setContractErr(message);
      toast.err(message);
    } finally {
      setContractBusy(false);
    }
  }

  async function saveContractEdit() {
    if (!partner || !editingContract) return;
    const parsed = contractPayload(editingContract.draft);
    if (!parsed.ok) {
      setContractErr(parsed.error);
      return;
    }
    setContractErr("");
    setContractBusy(true);
    try {
      const updated = await partnersApi.updateContract(partner.id, editingContract.id, parsed.body);
      setContracts((rows) => rows.map((row) => (row.id === updated.id ? updated : row)));
      setEditingContract(null);
      toast.ok("业绩合同已更新");
    } catch (e) {
      const message = errText(e);
      setContractErr(message);
      toast.err(message);
    } finally {
      setContractBusy(false);
    }
  }

  // ---------------- 删除（合同 / 附件共用一个确认框） ----------------

  async function confirmDelete() {
    if (!partner || !pendingDelete) return;
    setDeleteBusy(true);
    try {
      if (pendingDelete.scope === "contract") {
        await partnersApi.deleteContract(partner.id, pendingDelete.id);
        setContracts((rows) => rows.filter((row) => row.id !== pendingDelete.id));
        if (editingContract?.id === pendingDelete.id) setEditingContract(null);
        toast.ok("业绩合同已删除");
      } else {
        await partnersApi.deleteAttachment(partner.id, pendingDelete.id);
        setAttachments((rows) => rows.filter((row) => row.id !== pendingDelete.id));
        toast.ok("附件已删除");
      }
      setPendingDelete(null);
    } catch (e) {
      toast.err(failureToast(classifyTransferFailure(e)));
    } finally {
      setDeleteBusy(false);
    }
  }

  // ---------------- 附件 ----------------

  async function uploadPicked(
    files: File[],
    uploadCategory: PartnerAttachmentCategory = category,
  ) {
    if (!partner || !files.length) return;
    setUploading(true);
    const result = await uploads.start<PartnerAttachment>(files, (file, options) =>
      partnersApi.upload(partner.id, uploadCategory, file, options),
    );
    setUploading(false);
    if (result.aborted) return;
    if (result.failed) {
      toast.err(batchFailureToast(result.failures));
      return;
    }
    let fresh: PartnerAttachment[] | null = null;
    try {
      fresh = await refreshAttachments(partner.id);
    } catch (e) {
      if (isAbortError(e)) return;
    }
    if (fresh) setAttachments(fresh);
    else setAttachments((rows) => [...result.ok, ...rows]);
    toast.ok(`附件已上传 ${result.ok.length} 份`);
  }

  async function retryUpload(id: number) {
    if (!partner) return;
    setUploading(true);
    const result = await uploads.retry<PartnerAttachment>(id);
    setUploading(false);
    if (result.aborted) return;
    if (result.failed) {
      toast.err(batchFailureToast(result.failures));
      return;
    }
    let fresh: PartnerAttachment[] | null = null;
    try {
      fresh = await refreshAttachments(partner.id);
    } catch (e) {
      if (isAbortError(e)) return;
    }
    if (fresh) setAttachments(fresh);
    else setAttachments((rows) => [...result.ok, ...rows]);
    toast.ok("附件已补传成功");
  }

  async function uploadContractPicked(files: File[]) {
    if (!partner || !files.length) return;
    const result = await contractUploads.start<PartnerAttachment>(files, (file, options) =>
      partnersApi.upload(partner.id, "contract", file, options),
    );
    if (result.aborted) return;
    if (result.failed) {
      toast.err(batchFailureToast(result.failures));
      return;
    }
    let fresh: PartnerAttachment[] | null = null;
    try {
      fresh = await refreshAttachments(partner.id);
    } catch (e) {
      if (isAbortError(e)) return;
    }
    if (fresh) setAttachments(fresh);
    else setAttachments((rows) => [...result.ok, ...rows]);
    toast.ok(`合同附件已上传 ${result.ok.length} 份`);
  }

  async function retryContractUpload(id: number) {
    if (!partner) return;
    const result = await contractUploads.retry<PartnerAttachment>(id);
    if (result.aborted) return;
    if (result.failed) {
      toast.err(batchFailureToast(result.failures));
      return;
    }
    let fresh: PartnerAttachment[] | null = null;
    try {
      fresh = await refreshAttachments(partner.id);
    } catch (e) {
      if (isAbortError(e)) return;
    }
    if (fresh) setAttachments(fresh);
    else setAttachments((rows) => [...result.ok, ...rows]);
    toast.ok("合同附件已补传成功");
  }

  const fetchPreviewUrl = useCallback(
    async (a: Attachment): Promise<string> => {
      if (!partner) return "";
      // 强制按扩展名定 blob MIME：这份 URL 会交给 <img> / <iframe>，
      // 不能让上传时客户端声明的 Content-Type 决定字节怎么被解释（存储型 XSS）。
      return fetchObjectUrl(
        `/partners/${partner.id}/attachments/${a.id}/download`,
        previewBlobType(a) ?? undefined,
      );
    },
    [partner],
  );

  async function downloadAttachment(item: PartnerAttachment) {
    if (!partner) return;
    try {
      await partnersApi.downloadAttachment(partner.id, item.id, item.filename);
    } catch (e) {
      toast.err(failureToast(classifyTransferFailure(e)));
    }
  }

  const title = partner ? `友商档案 · ${partner.name}` : "新建友商";

  return (
    <>
        <Drawer
        open={partnerId !== null}
        onClose={onClose}
        title={title}
        width={860}
        dirty={form.dirty || uploads.uploading || contractUploads.uploading}
        footer={
          <>
            <button className="btn-ghost" onClick={onClose} disabled={saving}>关闭</button>
            <button className="btn-primary" onClick={saveBasic} disabled={saving || loading}>
              {saving ? "保存中…" : partner ? "保存档案" : "保存并建档"}
            </button>
          </>
        }
      >
        {loading ? (
          <div className="skel skel-title" />
        ) : partnerId !== "new" && !partner ? (
          <div className="err-banner" role="alert">{formErr || "档案加载失败"}</div>
        ) : (
          <>
            {formErr && <div className="err-banner" role="alert">{formErr}</div>}

            <div className="form-section">
              <div className="form-section-head">
                <div>
                  <h3>基本信息</h3>
                  <p>名称必填且全局唯一。</p>
                </div>
              </div>
              <div className="form-grid">
                <Field label="友商名称" required error={form.errors.name}>
                  <input
                    value={form.values.name}
                    aria-invalid={!!form.errors.name}
                    onChange={(e) => form.set("name", e.target.value)}
                    placeholder="如 嵩讯科技"
                  />
                </Field>
                <Field label="联系人">
                  <input value={form.values.contact_name} onChange={(e) => form.set("contact_name", e.target.value)} />
                </Field>
                <Field label="联系电话">
                  <input value={form.values.phone} onChange={(e) => form.set("phone", e.target.value)} />
                </Field>
                <Field label="邮箱" error={form.errors.email}>
                  <input
                    value={form.values.email}
                    aria-invalid={!!form.errors.email}
                    onChange={(e) => form.set("email", e.target.value)}
                  />
                </Field>
                <Field label="地址" span>
                  <input value={form.values.address} onChange={(e) => form.set("address", e.target.value)} />
                </Field>
                <Field label="备注" span>
                  <textarea rows={3} value={form.values.remark} onChange={(e) => form.set("remark", e.target.value)} />
                </Field>
              </div>
            </div>

            <div className="form-section">
              <div className="form-section-head">
                <div>
                  <h3>业绩合同{contracts.length > 0 && `（${contracts.length}）`}</h3>
                </div>
              </div>
              {!partner ? (
                <div className="tiny">先保存基本信息完成建档，再录入业绩合同。</div>
              ) : (
                <>
                  {contractErr && <div className="err-banner" role="alert">{contractErr}</div>}
                  {contracts.length === 0 ? (
                    <div className="tiny">暂无业绩合同</div>
                  ) : (
                    <div className="attachment-list">
                      {contracts.map((item) => (
                        <div className="attachment-row" key={item.id}>
                          {editingContract?.id === item.id ? (
                            <span style={{ display: "flex", gap: 8, flexWrap: "wrap", flex: 1 }}>
                              <input
                                style={{ width: 150 }}
                                value={editingContract.draft.project_name}
                                aria-label="项目名称"
                                onChange={(e) => setEditingContract({ id: item.id, draft: { ...editingContract.draft, project_name: e.target.value } })}
                                placeholder="项目名称（必填）"
                              />
                              <input
                                style={{ width: 110 }}
                                inputMode="decimal"
                                value={editingContract.draft.amount}
                                aria-label="合同金额"
                                onChange={(e) => setEditingContract({ id: item.id, draft: { ...editingContract.draft, amount: e.target.value } })}
                                placeholder="金额（元）"
                              />
                              <DatePicker
                                style={{ width: 140 }}
                                value={editingContract.draft.signed_date}
                                ariaLabel="签订日期"
                                quick={false}
                                onChange={(v) => setEditingContract({ id: item.id, draft: { ...editingContract.draft, signed_date: v } })}
                              />
                              <button type="button" className="linklike" disabled={contractBusy} onClick={() => void saveContractEdit()}>
                                保存
                              </button>
                              <button type="button" className="linklike" onClick={() => { setEditingContract(null); setContractErr(""); }}>
                                取消
                              </button>
                            </span>
                          ) : (
                            <>
                              <span className="attachment-name" title={item.project_name}>{item.project_name}</span>
                              <span className="tiny">
                                {fmtMoney(item.amount)}{item.signed_date ? ` · 签约 ${item.signed_date}` : ""}
                              </span>
                              <button
                                type="button"
                                className="linklike"
                                onClick={() => {
                                  setContractErr("");
                                  setEditingContract({
                                    id: item.id,
                                    draft: {
                                      project_name: item.project_name,
                                      amount: item.amount ? String(item.amount) : "",
                                      signed_date: item.signed_date || "",
                                      remark: item.remark,
                                    },
                                  });
                                }}
                              >
                                编辑
                              </button>
                              <button
                                type="button"
                                className="linklike danger-link"
                                onClick={() => setPendingDelete({ scope: "contract", id: item.id, name: item.project_name })}
                              >
                                删除
                              </button>
                            </>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                  <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
                    <input
                      style={{ width: 150 }}
                      value={contractDraft.project_name}
                      aria-label="新增项目名称"
                      onChange={(e) => setContractDraft({ ...contractDraft, project_name: e.target.value })}
                      placeholder="项目名称（必填）"
                    />
                    <input
                      style={{ width: 110 }}
                      inputMode="decimal"
                      value={contractDraft.amount}
                      aria-label="新增合同金额"
                      onChange={(e) => setContractDraft({ ...contractDraft, amount: e.target.value })}
                      placeholder="金额（元）"
                    />
                    <DatePicker
                      style={{ width: 140 }}
                      value={contractDraft.signed_date}
                      ariaLabel="新增签订日期"
                      quick={false}
                      onChange={(v) => setContractDraft({ ...contractDraft, signed_date: v })}
                    />
                    <button type="button" className="btn-ghost" style={{ width: "auto" }} disabled={contractBusy} onClick={() => void addContract()}>
                      {contractBusy ? "添加中…" : "+ 添加业绩"}
                    </button>
                    <FileDropZone
                      variant="button"
                      extensions={CONTRACT_ATTACHMENT_EXTENSIONS}
                      items={contractUploads.items}
                      disabled={contractUploads.uploading}
                      label={contractUploads.uploading ? "上传中…" : "上传合同附件"}
                      ariaLabel="上传合同附件"
                      onRetry={(id) => void retryContractUpload(id)}
                      onFiles={(picked) => void uploadContractPicked(picked)}
                    />
                  </div>
                </>
              )}
            </div>

            <div className="form-section">
              <div className="form-section-head">
                <div>
                  <h3>资质证书及其他{attachments.length > 0 && `（${attachments.length}）`}</h3>
                  <p>{PARTNER_ATTACHMENT_HINT}。</p>
                </div>
              </div>
              {!partner ? (
                <div className="tiny">先保存基本信息完成建档，再上传资质证书与附件资料。</div>
              ) : (
                <>
                  <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
                    <span style={{ width: 170 }}>
                      <Select
                        value={category}
                        onChange={(value) => setCategory(value as PartnerAttachmentCategory)}
                        aria-label="附件分类"
                      >
                        {(Object.keys(PARTNER_ATTACHMENT_CATEGORY_LABELS) as PartnerAttachmentCategory[])
                          .filter((value) => value !== "contract")
                          .map((value) => (
                            <option key={value} value={value}>{PARTNER_ATTACHMENT_CATEGORY_LABELS[value]}</option>
                          ))}
                      </Select>
                    </span>
                    <FileDropZone
                      variant="button"
                      extensions={PARTNER_ATTACHMENT_EXTENSIONS}
                      items={uploads.items}
                      disabled={uploading}
                      label={uploading ? "上传中…" : "上传附件"}
                      ariaLabel="上传资质证书及其他附件"
                      onRetry={(id) => void retryUpload(id)}
                      onFiles={(picked) => void uploadPicked(picked)}
                    />
                  </div>
                  {attachments.length === 0 ? (
                    <div className="tiny">暂未上传附件</div>
                  ) : (
                    <div className="attachment-list">
                      {attachments.map((item) => (
                        <div className="attachment-row" key={item.id}>
                          <span className="chip">
                            {PARTNER_ATTACHMENT_CATEGORY_LABELS[item.category as PartnerAttachmentCategory] || item.category_label || "其他"}
                          </span>
                          <span className="attachment-name" title={item.filename}>{item.filename}</span>
                          <span className="tiny">{formatFileSize(item.size)} · {fmtDateTime(item.uploaded_at)}</span>
                          {canPreviewInline(item) && (
                            <button type="button" className="linklike" onClick={() => setPreview(item)}>
                              预览
                            </button>
                          )}
                          <button type="button" className="linklike" onClick={() => void downloadAttachment(item)}>
                            下载
                          </button>
                          <button
                            type="button"
                            className="linklike danger-link"
                            onClick={() => setPendingDelete({ scope: "attachment", id: item.id, name: item.filename })}
                          >
                            删除
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          </>
        )}
      </Drawer>

      <AttachmentPreviewDialog
        attachment={preview}
        loadUrl={fetchPreviewUrl}
        onClose={() => setPreview(null)}
        onDownload={(a) => {
          const item = attachments.find((x) => x.id === a.id);
          if (item) void downloadAttachment(item);
        }}
      />

      <Confirm
        open={!!pendingDelete}
        title={
          pendingDelete?.scope === "contract"
            ? `删除业绩合同「${pendingDelete?.name}」？`
            : `删除附件「${pendingDelete?.name ?? ""}」？`
        }
        text="删除后不可恢复。"
        danger
        loading={deleteBusy}
        okText="确认删除"
        onConfirm={() => void confirmDelete()}
        onCancel={() => setPendingDelete(null)}
      />
    </>
  );
}
