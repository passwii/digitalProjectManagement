"use client";
// 项目新建/编辑弹窗：声明字段 + 校验，保存结果由调用方 toast
import { useEffect } from "react";
import { projectsApi, type Project } from "@/lib/api";
import { useMeta } from "@/lib/useMeta";
import { PRIORITIES, PROJECT_TYPES } from "@/lib/labels";
import { useForm } from "@/lib/useForm";
import { Dialog } from "@/components/ui/Modal";
import Field from "@/components/ui/Field";

interface FormValues {
  name: string;
  type: string;
  dept_id: string;
  owner_id: string;
  plan_start: string;
  plan_end: string;
  budget_total: string;
  priority: string;
  client: string;
  description: string;
}

const BLANK: FormValues = {
  name: "", type: "研发", dept_id: "", owner_id: "", plan_start: "", plan_end: "",
  budget_total: "", priority: "中", client: "", description: "",
};

function toValues(p: Project): FormValues {
  return {
    name: p.name,
    type: p.type || "研发",
    dept_id: p.dept_id ? String(p.dept_id) : "",
    owner_id: p.owner_id ? String(p.owner_id) : "",
    plan_start: p.plan_start ?? "",
    plan_end: p.plan_end ?? "",
    budget_total: String(p.budget_total ?? ""),
    priority: p.priority || "中",
    client: p.client || "",
    description: p.description || "",
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
  /** 传 project 为编辑，null 为新建 */
  project: Project | null;
  onSaved: (p: Project, isNew: boolean) => void;
}) {
  const { users, depts } = useMeta();
  const isEdit = !!project;

  const form = useForm<FormValues>(isEdit ? toValues(project) : BLANK, {
    name: { required: "项目名称不能为空", max: 60, label: "项目名称" },
    plan_end: {
      label: "计划结束",
      custom: (v, all) =>
        all.plan_start && v && String(v) < all.plan_start ? "计划结束不能早于计划开始" : null,
    },
    budget_total: {
      label: "项目预算",
      custom: (v) => {
        if (v === "") return null;
        const n = Number(v);
        return Number.isFinite(n) && n >= 0 ? null : "预算须为不小于 0 的数字";
      },
    },
  });

  // 打开时同步初始值
  useEffect(() => {
    if (open) form.reset(isEdit && project ? toValues(project) : BLANK);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, project?.id]);

  async function submit() {
    if (!form.validate()) return;
    const v = form.values;
    const payload: Record<string, unknown> = {
      name: v.name.trim(),
      type: v.type,
      dept_id: v.dept_id ? Number(v.dept_id) : null,
      owner_id: v.owner_id ? Number(v.owner_id) : null,
      plan_start: v.plan_start || null,
      plan_end: v.plan_end || null,
      budget_total: v.budget_total === "" ? 0 : Number(v.budget_total),
      priority: v.priority,
      client: v.client.trim(),
      description: v.description.trim(),
    };
    const saved = isEdit
      ? await projectsApi.update(project!.id, payload)
      : await projectsApi.create(payload as Partial<Project>);
    onSaved(saved, !isEdit);
    form.reset();
  }

  const busy = false;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      dirty={form.dirty}
      size="lg"
      title={isEdit ? `编辑项目 · ${project?.code ?? ""}` : "新建项目"}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>取消</button>
          <button className="btn-primary" onClick={submit} disabled={busy}>
            {isEdit ? "保存修改" : "创建项目"}
          </button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="项目名称" required error={form.errors.name} span>
          <input
            value={form.values.name}
            aria-invalid={!!form.errors.name}
            onChange={(e) => form.set("name", e.target.value)}
            placeholder="如：官网改版"
          />
        </Field>
        <Field label="项目类型">
          <select value={form.values.type} onChange={(e) => form.set("type", e.target.value)}>
            {PROJECT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </Field>
        <Field label="优先级">
          <select value={form.values.priority} onChange={(e) => form.set("priority", e.target.value)}>
            {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </Field>
        <Field label="所属部门" hint={isEdit ? undefined : "留空则取当前用户部门"}>
          <select value={form.values.dept_id} onChange={(e) => form.set("dept_id", e.target.value)}>
            <option value="">{isEdit ? "未设置" : "按当前用户部门"}</option>
            {depts.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </Field>
        <Field label="项目负责人" hint={isEdit ? undefined : "留空则默认当前用户"}>
          <select value={form.values.owner_id} onChange={(e) => form.set("owner_id", e.target.value)}>
            <option value="">{isEdit ? "未设置" : "默认当前用户"}</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.real_name}</option>)}
          </select>
        </Field>
        <Field label="计划开始">
          <input type="date" value={form.values.plan_start} onChange={(e) => form.set("plan_start", e.target.value)} />
        </Field>
        <Field label="计划结束" error={form.errors.plan_end}>
          <input
            type="date"
            value={form.values.plan_end}
            aria-invalid={!!form.errors.plan_end}
            onChange={(e) => form.set("plan_end", e.target.value)}
          />
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
          <input value={form.values.client} onChange={(e) => form.set("client", e.target.value)} placeholder="可为空" />
        </Field>
        <Field label="项目简介" span>
          <textarea
            rows={3}
            value={form.values.description}
            onChange={(e) => form.set("description", e.target.value)}
            placeholder="背景与目标说明"
          />
        </Field>
      </div>
    </Dialog>
  );
}
