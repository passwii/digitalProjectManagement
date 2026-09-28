"use client";
// 任务新建/编辑弹窗（编辑走 PATCH，父/前置任务可选）
import { useEffect, useState } from "react";
import { errText, tasksApi, type Task } from "@/lib/api";
import { useMeta } from "@/lib/useMeta";
import { useForm } from "@/lib/useForm";
import { Dialog } from "@/components/ui/Modal";
import Field from "@/components/ui/Field";
import Select from "@/components/ui/Select";

interface Values {
  name: string;
  owner_id: string;
  parent_id: string;
  predecessor_id: string;
  plan_start: string;
  plan_end: string;
  weight: string;
}

const BLANK: Values = {
  name: "", owner_id: "", parent_id: "", predecessor_id: "",
  plan_start: "", plan_end: "", weight: "1",
};

function toValues(t: Task): Values {
  return {
    name: t.name,
    owner_id: t.owner_id ? String(t.owner_id) : "",
    parent_id: t.parent_id ? String(t.parent_id) : "",
    predecessor_id: t.predecessor_id ? String(t.predecessor_id) : "",
    plan_start: t.plan_start ?? "",
    plan_end: t.plan_end ?? "",
    weight: String(t.weight ?? 1),
  };
}

export default function TaskDialog({
  open,
  onClose,
  projectId,
  task,
  tasks,
  taskScopeNote,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  projectId: number;
  task: Task | null;
  tasks: Task[];
  /** 父/前置任务候选只覆盖当前显示范围时的说明（任务已分页） */
  taskScopeNote?: string;
  onSaved: () => void;
}) {
  const { users } = useMeta();
  const isEdit = !!task;
  // 提交失败原因：保存/校验被后端拒绝时必须让用户看到，而不是静默留在弹窗里
  const [formErr, setFormErr] = useState("");

  const form = useForm<Values>(isEdit ? toValues(task) : BLANK, {
    name: { required: "任务名称不能为空", max: 80, label: "任务名称" },
    weight: {
      label: "权重",
      custom: (v) => {
        const n = Number(v);
        return !v || (Number.isFinite(n) && n > 0) ? null : "权重须为大于 0 的数字";
      },
    },
    plan_end: {
      label: "计划结束",
      custom: (v, all) =>
        all.plan_start && v && String(v) < all.plan_start ? "计划结束不能早于计划开始" : null,
    },
  });

  useEffect(() => {
    if (open) {
      form.reset(isEdit && task ? toValues(task) : BLANK);
      setFormErr("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, task?.id]);

  async function submit() {
    if (!form.validate()) return;
    setFormErr("");
    const v = form.values;
    const payload: Record<string, unknown> = {
      project_id: projectId,
      name: v.name.trim(),
      owner_id: v.owner_id ? Number(v.owner_id) : null,
      parent_id: v.parent_id ? Number(v.parent_id) : null,
      predecessor_id: v.predecessor_id ? Number(v.predecessor_id) : null,
      plan_start: v.plan_start || null,
      plan_end: v.plan_end || null,
      weight: Number(v.weight || 1),
    };
    try {
      if (isEdit) await tasksApi.update(task!.id, payload);
      else await tasksApi.create(payload);
    } catch (e) {
      // 保留已填内容，用户改完可直接重试
      setFormErr(errText(e));
      return;
    }
    onSaved();
    onClose();
  }

  const others = tasks.filter((t) => t.id !== task?.id);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      dirty={form.dirty}
      title={isEdit ? `编辑任务 · ${task?.name ?? ""}` : "新建任务"}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>取消</button>
          <button className="btn-primary" onClick={submit}>{isEdit ? "保存修改" : "创建任务"}</button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="任务名称" required error={form.errors.name} span>
          <input
            value={form.values.name}
            aria-invalid={!!form.errors.name}
            onChange={(e) => form.set("name", e.target.value)}
            placeholder="如：需求评审"
          />
        </Field>
        <Field label="负责人" hint="留空默认当前用户">
          <Select value={form.values.owner_id} onChange={(value) => form.set("owner_id", value)}>
            <option value="">默认当前用户</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.real_name}</option>)}
          </Select>
        </Field>
        <Field label="权重" error={form.errors.weight} hint="加权进度按权重折算">
          <input value={form.values.weight} onChange={(e) => form.set("weight", e.target.value)} inputMode="decimal" />
        </Field>
        <Field label="父任务" hint={taskScopeNote ? `最多 5 级 · ${taskScopeNote}` : "最多 5 级"}>
          <Select value={form.values.parent_id} onChange={(value) => form.set("parent_id", value)}>
            <option value="">无（作为一级任务）</option>
            {others.map((t) => <option key={t.id} value={t.id}>{t.level > 1 ? "└ " : ""}{t.name}</option>)}
          </Select>
        </Field>
        <Field label="前置任务" hint={taskScopeNote ? `存在环会被后端拦截 · ${taskScopeNote}` : "存在环会被后端拦截"}>
          <Select value={form.values.predecessor_id} onChange={(value) => form.set("predecessor_id", value)}>
            <option value="">无</option>
            {others.map((t) => <option key={t.id} value={t.id}>{t.name}（{t.progress}%）</option>)}
          </Select>
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
      </div>
      {formErr && <div className="err-banner" style={{ marginTop: 10, marginBottom: 0 }} role="alert">{formErr}</div>}
    </Dialog>
  );
}
