"use client";

import { useEffect, useState } from "react";
import { errText, projectsApi, type Attachment, type Project } from "@/lib/api";
import { useMeta } from "@/lib/useMeta";
import { CONTRACT_STATUSES, PROJECT_OWNERS } from "@/lib/labels";
import { useForm } from "@/lib/useForm";
import { Dialog } from "@/components/ui/Modal";
import Field from "@/components/ui/Field";

interface FormValues {
  name: string;
  code: string;
  owner_name: string;
  budget_total: string;
  client: string;
  description: string;
  contract_status: string;
  forward_contract: string;
  backward_contract: string;
}

const BLANK: FormValues = {
  name: "",
  code: "",
  owner_name: "",
  budget_total: "",
  client: "",
  description: "",
  contract_status: "未签订",
  forward_contract: "",
  backward_contract: "",
};

function toValues(p?: Project | null): FormValues {
  if (!p) return BLANK;
  return {
    name: p.name,
    code: p.code || "",
    owner_name: p.owner_name || "",
    budget_total: p.budget_total == null ? "" : String(p.budget_total),
    client: p.client || "",
    description: p.description || "",
    contract_status: p.contract_status || "未签订",
    forward_contract: p.forward_contract || "",
    backward_contract: p.backward_contract || "",
  };
}

export default function ProjectFormDialog({
  open,
  onClose,
  project,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  project: Project | null;
  onSaved: (p: Project, isNew: boolean) => void;
}) {
  const { users } = useMeta();
  const isEdit = !!project;
  const [formErr, setFormErr] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [existing, setExisting] = useState<Attachment[]>([]);
  const [saving, setSaving] = useState(false);

  const form = useForm<FormValues>(toValues(project), {
    name: { required: "项目名称不能为空", max: 60, label: "项目名称" },
    code: { required: "项目编号不能为空", max: 32, label: "项目编号" },
    owner_name: { required: "请选择项目负责人" },
    budget_total: {
      label: "项目预算",
      custom: (v) => {
        if (v === "") return null;
        const n = Number(v);
        return Number.isFinite(n) && n >= 0 ? null : "预算须为不小于 0 的数字";
      },
    },
  });

  useEffect(() => {
    if (!open) return;
    form.reset(toValues(project));
    setFiles([]);
    setFormErr("");
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

  async function submit() {
    if (!form.validate()) return;
    const v = form.values;
    const match = users.find((u) => u.real_name === v.owner_name);
    const payload: Record<string, unknown> = {
      code: v.code.trim(),
      name: v.name.trim(),
      owner_id: match?.id ?? null,
      owner_name: v.owner_name,
      budget_total: v.budget_total === "" ? 0 : Number(v.budget_total),
      client: v.client.trim(),
      description: v.description.trim(),
      contract_status: v.contract_status,
      forward_contract: v.contract_status === "已签订" ? v.forward_contract.trim() : "",
      backward_contract: v.contract_status === "已签订" ? v.backward_contract.trim() : "",
    };

    setSaving(true);
    setFormErr("");
    try {
      const saved = isEdit
        ? await projectsApi.update(project!.id, payload)
        : await projectsApi.create(payload as Partial<Project>);
      for (const file of files) {
        await projectsApi.upload(saved.id, file, "contract");
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

  async function removeExisting(a: Attachment) {
    if (!project) return;
    try {
      await projectsApi.deleteAttachment(project.id, a.id);
      setExisting((rows) => rows.filter((x) => x.id !== a.id));
    } catch (e) {
      setFormErr(errText(e));
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      dirty={form.dirty || files.length > 0}
      size="lg"
      title={isEdit ? `编辑项目 · ${project?.code ?? ""}` : "新建项目"}
      footer={
        <>
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
            <select value={form.values.owner_name} onChange={(e) => form.set("owner_name", e.target.value)}>
              <option value="">请选择负责人</option>
              {PROJECT_OWNERS.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          </Field>
          <Field label="项目预算（元）" error={form.errors.budget_total}>
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
            <select value={form.values.contract_status} onChange={(e) => form.set("contract_status", e.target.value)}>
              {CONTRACT_STATUSES.map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          </Field>
          {form.values.contract_status === "已签订" && (
            <>
              <Field label="前向合同（甲方）">
                <input
                  value={form.values.forward_contract}
                  onChange={(e) => form.set("forward_contract", e.target.value)}
                  placeholder="填写甲方或前向合同名称"
                />
              </Field>
              <Field label="后向合同（乙方）">
                <input
                  value={form.values.backward_contract}
                  onChange={(e) => form.set("backward_contract", e.target.value)}
                  placeholder="填写乙方或后向合同名称"
                />
              </Field>
            </>
          )}
          {form.values.contract_status === "已签订" && (
            <div className="field span-2">
              <span className="field-label">合同附件</span>
              <label className="file-drop">
                <input
                  type="file"
                  multiple
                  accept=".pdf,.docx,.xlsx,.png,.jpg,.jpeg"
                  onChange={(e) => {
                    setFiles(Array.from(e.target.files ?? []));
                    e.target.value = "";
                  }}
                />
                <span className="file-drop-main">{files.length ? `已选择 ${files.length} 个文件` : "选择合同附件"}</span>
                <span className="file-drop-sub">{files.length ? files.map((f) => f.name).join("、") : "创建项目后自动保存到合同档案"}</span>
              </label>
              <span className="field-hint">支持 PDF / Word / Excel / 图片，单个文件不超过 20MB</span>
            </div>
          )}
          {existing.length > 0 && (
            <div className="attachment-list span-2">
              {existing.map((a) => (
                <div className="attachment-row" key={a.id}>
                  <span className="attachment-name" title={a.filename}>{a.filename}</span>
                  <span className="tiny">{(a.size / 1024).toFixed(1)} KB</span>
                  <button type="button" className="linklike danger-link" onClick={() => removeExisting(a)}>移除</button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {formErr && <div className="err-banner" style={{ marginTop: 12, marginBottom: 0 }} role="alert">{formErr}</div>}
    </Dialog>
  );
}
