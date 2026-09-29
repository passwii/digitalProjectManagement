"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { classifyTransferFailure, batchFailureToast, failureToast } from "@/lib/uploadErrors";
import { errText, fetchObjectUrl, projectsApi, type Attachment, type Project } from "@/lib/api";
import { canPreviewInline, previewBlobType } from "@/lib/contentPreview";
import { useMeta } from "@/lib/useMeta";
import {
  CONTRACT_STATUSES,
  contractStatusLabel,
  isKnownContractStatus,
  PROJECT_OWNERS,
} from "@/lib/labels";
import { ATTACHMENT_HINT, CONTRACT_ATTACHMENT_EXTENSIONS } from "@/lib/uploadLimits";
import { useForm } from "@/lib/useForm";
import { useUploadQueue } from "@/lib/useUploadQueue";
import { Dialog } from "@/components/ui/Modal";
import Field from "@/components/ui/Field";
import Select from "@/components/ui/Select";
import FileDropZone from "@/components/ui/FileDropZone";
import AttachmentPreviewDialog from "@/components/ui/AttachmentPreviewDialog";

interface FormValues {
  name: string;
  code: string;
  owner_name: string;
  budget_total: string;
  client: string;
  client_contact: string;
  client_phone: string;
  description: string;
  contract_status: string;
}

const BLANK: FormValues = {
  name: "",
  code: "",
  owner_name: "",
  budget_total: "",
  client: "",
  client_contact: "",
  client_phone: "",
  description: "",
  contract_status: "未签订",
};

function toValues(p?: Project | null): FormValues {
  if (!p) return BLANK;
  return {
    name: p.name,
    code: p.code || "",
    owner_name: p.owner_name || "",
    budget_total: p.budget_total == null ? "" : String(p.budget_total),
    client: p.client || "",
    client_contact: p.client_contact || "",
    client_phone: p.client_phone || "",
    description: p.description || "",
    // 历史数据可能仍返回 signed/unsigned 等英文值；表单展示统一中文，提交仍使用中文契约值。
    contract_status: contractStatusLabel(p.contract_status || "未签订"),
  };
}

export default function ProjectFormDialog({
  open,
  onClose,
  project,
  onSaved,
  onRequestDelete,
}: {
  open: boolean;
  onClose: () => void;
  project: Project | null;
  onSaved: (p: Project, isNew: boolean) => void;
  onRequestDelete?: () => void;
}) {
  const { users } = useMeta();
  const isEdit = !!project;
  const [formErr, setFormErr] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [existing, setExisting] = useState<Attachment[]>([]);
  const [preview, setPreview] = useState<Attachment | null>(null);
  const [saving, setSaving] = useState(false);
  const uploads = useUploadQueue();
  /** 主记录已写入（项目已建/已改）但附件可能还失败：重试补传成功时用它收尾 */
  const savedRef = useRef<Project | null>(null);

  const fetchPreviewUrl = useCallback(
    async (attachment: Attachment): Promise<string> => {
      if (!project) return "";
      return fetchObjectUrl(
        `/projects/${project.id}/attachments/${attachment.id}/download`,
        previewBlobType(attachment) ?? undefined,
      );
    },
    [project],
  );

  const form = useForm<FormValues>(toValues(project), {
    name: { required: "项目名称不能为空", max: 60, label: "项目名称" },
    code: { required: "项目编号不能为空", max: 32, label: "项目编号" },
    owner_name: { required: "请选择项目负责人" },
    budget_total: {
      label: "合同金额",
      custom: (v) => {
        if (v === "") return null;
        const n = Number(v);
        return Number.isFinite(n) && n >= 0 ? null : "合同金额须为不小于 0 的数字";
      },
    },
    // 与后端一致：可选（默认空串），String(64) 上限
    client_contact: { max: 64, label: "客户联系人" },
    client_phone: { max: 64, label: "联系方式" },
  });

  useEffect(() => {
    if (!open) return;
    form.reset(toValues(project));
    setFiles([]);
    setPreview(null);
    setFormErr("");
    uploads.reset();
    if (project) {
      projectsApi
        .attachments(project.id, "contract")
        .then(setExisting)
        .catch(() => setExisting([]));
    } else {
      setExisting([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, project?.id]);

  // 弹层关闭即中止在途上传：避免「关掉弹层还在传」
  useEffect(() => {
    if (!open) uploads.abort();
    // 只依赖 abort（稳定引用）：依赖整个 uploads 对象会在每次进度更新时重跑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, uploads.abort]);

  async function submit() {
    if (!form.validate()) return;
    const v = form.values;
    if (!isKnownContractStatus(v.contract_status)) {
      setFormErr(
        `检测到历史合同状态“${v.contract_status}”，请重新选择“已签订”或“未签订”后再保存。`,
      );
      return;
    }
    const match = users.find((u) => u.real_name === v.owner_name);
    const payload: Record<string, unknown> = {
      code: v.code.trim(),
      name: v.name.trim(),
      owner_id: match?.id ?? null,
      owner_name: v.owner_name,
      budget_total: v.budget_total === "" ? 0 : Number(v.budget_total),
      client: v.client.trim(),
      client_contact: v.client_contact.trim(),
      client_phone: v.client_phone.trim(),
      description: v.description.trim(),
      contract_status: v.contract_status,
    };

    setSaving(true);
    setFormErr("");
    try {
      const saved = isEdit
        ? await projectsApi.update(project!.id, payload)
        : await projectsApi.create(payload as Partial<Project>);
      // 合同附件逐个上传并显示进度；单个失败不阻断其余文件
      savedRef.current = saved;
      if (files.length) {
        const result = await uploads.start<Attachment>(files, (file, options) =>
          projectsApi.upload(saved.id, file, "contract", options),
        );
        if (result.aborted) return;
        if (result.failed) {
          // 按档位说明（502 存储暂不可用可重试 / 404 已丢失 / 400 不合规），不一律「请重试」
          setFormErr(batchFailureToast(result.failures));
          return;
        }
      }
      onSaved(saved, !isEdit);
      form.reset();
      setFiles([]);
      onClose();
    } catch (e) {
      setFormErr(errText(e));
    } finally {
      setSaving(false);
    }
  }

  /**
   * 补传一条失败的合同附件（文件还在队列里，不必重新选择，也不会重复上传已成功的那些）。
   *
   * 全部失败项都补完后才收尾关弹层；否则留在弹层里继续处理剩下的失败行。
   */
  async function retryUpload(id: number) {
    const result = await uploads.retry<Attachment>(id);
    if (result.aborted) return;
    if (result.failures[0]) {
      setFormErr(batchFailureToast(result.failures));
      return;
    }
    const remaining = uploads.items.filter((item) => item.id !== id && item.status !== "done");
    const saved = savedRef.current;
    if (!remaining.length && saved) {
      onSaved(saved, !isEdit);
      form.reset();
      setFiles([]);
      onClose();
    }
  }

  async function removeExisting(a: Attachment) {
    if (!project) return;
    try {
      await projectsApi.deleteAttachment(project.id, a.id);
      setExisting((rows) => rows.filter((x) => x.id !== a.id));
    } catch (e) {
      // 删除失败同样分档：502 存储不可用时是「稍后重试」，404 才是「附件已丢失」
      setFormErr(failureToast(classifyTransferFailure(e)));
    }
  }

  async function downloadExisting(a: Attachment) {
    if (!project) return;
    try {
      await projectsApi.downloadAttachment(project.id, a.id, a.filename);
    } catch (e) {
      setFormErr(errText(e));
    }
  }

  return (
    <>
      <Dialog
        open={open}
        onClose={onClose}
        dirty={form.dirty || files.length > 0}
        size="lg"
        title={isEdit ? `编辑项目 · ${project?.code ?? ""}` : "新建项目"}
        footer={
          <>
            {isEdit && onRequestDelete && (
              <button className="btn-ghost btn-danger-outline" onClick={onRequestDelete} disabled={saving}>
                删除项目
              </button>
            )}
            <button className="btn-ghost" onClick={onClose} disabled={saving}>取消</button>
            <button className="btn-primary" onClick={submit} disabled={saving}>
              {saving ? "保存中…" : isEdit ? "保存修改" : "创建项目"}
            </button>
          </>
        }
      >
      <div className="form-section">
        <div className="form-section-head">
          <h3>基础信息</h3>
        </div>
        <div className="form-grid">
          <Field label="项目名称" required error={form.errors.name}>
            <input
              value={form.values.name}
              aria-invalid={!!form.errors.name}
              onChange={(e) => form.set("name", e.target.value)}
              placeholder="如：数智化经营分析平台"
            />
          </Field>
          <Field label="项目编号" required error={form.errors.code}>
            <input
              value={form.values.code}
              aria-invalid={!!form.errors.code}
              onChange={(e) => form.set("code", e.target.value)}
              placeholder="如：SHzk-2026-001"
            />
          </Field>
          <Field label="项目负责人" required>
            <Select value={form.values.owner_name} onChange={(value) => form.set("owner_name", value)}>
              <option value="">请选择负责人</option>
              {PROJECT_OWNERS.map((name) => <option key={name} value={name}>{name}</option>)}
            </Select>
          </Field>
          <Field label="合同金额（元）" error={form.errors.budget_total}>
            <input
              value={form.values.budget_total}
              aria-invalid={!!form.errors.budget_total}
              onChange={(e) => form.set("budget_total", e.target.value)}
              placeholder="如：500000"
              inputMode="decimal"
            />
          </Field>
          <Field label="客户 / 委托方">
            <input value={form.values.client} onChange={(e) => form.set("client", e.target.value)} placeholder="填写客户或委托单位" />
          </Field>
          <Field label="客户联系人" error={form.errors.client_contact}>
            <input value={form.values.client_contact} onChange={(e) => form.set("client_contact", e.target.value)} placeholder="填写客户联系人姓名" maxLength={64} />
          </Field>
          <Field label="联系方式" error={form.errors.client_phone}>
            <input value={form.values.client_phone} onChange={(e) => form.set("client_phone", e.target.value)} placeholder="填写电话或手机" maxLength={64} inputMode="tel" />
          </Field>
          <Field label="项目简介" span>
            <textarea
              rows={3}
              value={form.values.description}
              onChange={(e) => form.set("description", e.target.value)}
              placeholder="项目背景、目标与交付边界"
            />
          </Field>
        </div>
      </div>

      <div className="form-section">
        <div className="form-section-head">
          <h3>合同信息</h3>
        </div>
        <div className="form-grid">
          <Field label="合同状态" required>
            <Select
              value={form.values.contract_status}
              onChange={(value) => form.set("contract_status", value)}
            >
              {!isKnownContractStatus(form.values.contract_status) && (
                <option value={form.values.contract_status} disabled>
                  历史状态：{form.values.contract_status}（请重新选择）
                </option>
              )}
              {CONTRACT_STATUSES.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </Select>
            {!isKnownContractStatus(form.values.contract_status) && (
              <span className="field-hint">
                该历史值无法直接提交，请选择一个有效合同状态。
              </span>
            )}
          </Field>
          {form.values.contract_status === "已签订" && (
            <div className="field span-2">
              <span className="field-label">合同附件</span>
              <FileDropZone
                extensions={CONTRACT_ATTACHMENT_EXTENSIONS}
                items={uploads.items}
                disabled={saving}
                label={files.length ? `已选择 ${files.length} 个文件` : "选择合同附件"}
                onRetry={retryUpload}
                hint={
                  files.length
                    ? "可继续点击或拖拽追加文件"
                    : "点击选择，或把文件拖到这里；也可直接粘贴截图"
                }
                onFiles={(picked) =>
                  setFiles((prev) => [
                    ...prev,
                    // 同名同体积视为同一份，避免拖拽与选择器重复入队
                    ...picked.filter(
                      (f) => !prev.some((x) => x.name === f.name && x.size === f.size),
                    ),
                  ])
                }
              />
              <span className="field-hint">{ATTACHMENT_HINT}</span>
              {files.length > 0 && (
                <ul className="pending-file-list">
                  {files.map((file, index) => (
                    <li key={`${file.name}-${file.size}-${index}`}>
                      <span className="pending-file-name" title={file.name}>{file.name}</span>
                      <button
                        type="button"
                        className="linklike danger-link"
                        onClick={() =>
                          setFiles((prev) => prev.filter((_, i) => i !== index))
                        }
                      >
                        移除
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {existing.length > 0 && (
            <div className="attachment-list span-2">
              {existing.map((a) => (
                <div className="attachment-row" key={a.id}>
                  <span className="attachment-name" title={a.filename}>{a.filename}</span>
                  <span className="tiny">{(a.size / 1024).toFixed(1)} KB</span>
                  {canPreviewInline(a) && (
                    <button type="button" className="linklike" onClick={() => setPreview(a)}>
                      预览
                    </button>
                  )}
                  <button type="button" className="linklike danger-link" onClick={() => removeExisting(a)}>移除</button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {formErr && <div className="err-banner" style={{ marginTop: 12, marginBottom: 0 }} role="alert">{formErr}</div>}
      </Dialog>

      <AttachmentPreviewDialog
        attachment={preview}
        loadUrl={fetchPreviewUrl}
        onClose={() => setPreview(null)}
        onDownload={(attachment) => void downloadExisting(attachment)}
      />
    </>
  );
}
