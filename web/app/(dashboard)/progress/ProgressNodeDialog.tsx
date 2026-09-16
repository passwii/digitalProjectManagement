"use client";

import { useEffect, useState } from "react";
import { errText, tasksApi, type Task } from "@/lib/api";
import { useForm } from "@/lib/useForm";
import { Dialog } from "@/components/ui/Modal";
import Field from "@/components/ui/Field";

interface Values {
  node_date: string;
  content: string;
}

const BLANK: Values = { node_date: "", content: "" };

function toValues(task?: Task | null): Values {
  if (!task) return BLANK;
  return {
    node_date: task.plan_end || task.plan_start || "",
    content: task.name || "",
  };
}

export default function ProgressNodeDialog({
  open,
  onClose,
  projectId,
  task,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  projectId: number;
  task?: Task | null;
  onSaved: () => void;
}) {
  const isEdit = !!task;
  const [formErr, setFormErr] = useState("");
  const [saving, setSaving] = useState(false);
  const form = useForm<Values>(toValues(task), {
    node_date: { required: "请选择进度节点时间" },
    content: { required: "请填写进度关键内容", max: 128, label: "进度关键内容" },
  });

  useEffect(() => {
    if (!open) return;
    form.reset(toValues(task));
    setFormErr("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, task?.id]);

  async function submit() {
    if (!form.validate()) return;
    setSaving(true);
    setFormErr("");
    const payload = {
      project_id: projectId,
      name: form.values.content.trim(),
      plan_start: form.values.node_date,
      plan_end: form.values.node_date,
      weight: 1,
    };
    try {
      if (isEdit) await tasksApi.update(task!.id, payload);
      else await tasksApi.create(payload);
      onSaved();
      onClose();
    } catch (e) {
      setFormErr(errText(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      dirty={form.dirty}
      title={isEdit ? "编辑进度" : "添加进度"}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose} disabled={saving}>取消</button>
          <button className="btn-primary" onClick={submit} disabled={saving}>
            {saving ? "保存中…" : isEdit ? "保存修改" : "添加进度"}
          </button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="进度节点时间" required error={form.errors.node_date}>
          <input
            type="date"
            value={form.values.node_date}
            aria-invalid={!!form.errors.node_date}
            onChange={(e) => form.set("node_date", e.target.value)}
          />
        </Field>
        <Field label="进度关键内容" required error={form.errors.content} span>
          <textarea
            rows={5}
            value={form.values.content}
            aria-invalid={!!form.errors.content}
            onChange={(e) => form.set("content", e.target.value)}
            placeholder="填写本节点完成事项、交付结果或关键结论"
          />
        </Field>
      </div>
      {formErr && <div className="err-banner" style={{ marginTop: 12, marginBottom: 0 }} role="alert">{formErr}</div>}
    </Dialog>
  );
}
