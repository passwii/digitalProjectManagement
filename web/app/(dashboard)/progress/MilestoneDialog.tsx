"use client";
// 里程碑新建/编辑弹窗
import { useEffect, useState } from "react";
import { errText, milestonesApi, type Milestone } from "@/lib/api";
import { useMeta } from "@/lib/useMeta";
import { useForm } from "@/lib/useForm";
import { Dialog } from "@/components/ui/Modal";
import Field from "@/components/ui/Field";
import Select from "@/components/ui/Select";

interface Values {
  name: string;
  plan_date: string;
  actual_date: string;
  owner_id: string;
}

const BLANK: Values = { name: "", plan_date: "", actual_date: "", owner_id: "" };

function toValues(m: Milestone): Values {
  return {
    name: m.name,
    plan_date: m.plan_date ?? "",
    actual_date: m.actual_date ?? "",
    owner_id: m.owner_id ? String(m.owner_id) : "",
  };
}

export default function MilestoneDialog({
  open,
  onClose,
  projectId,
  milestone,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  projectId: number;
  milestone: Milestone | null;
  onSaved: () => void;
}) {
  const { users } = useMeta();
  const isEdit = !!milestone;
  const [formErr, setFormErr] = useState("");

  const form = useForm<Values>(isEdit ? toValues(milestone) : BLANK, {
    name: { required: "里程碑名称不能为空", max: 60, label: "里程碑名称" },
    plan_date: { required: "请选择计划日期", label: "计划日期" },
  });

  useEffect(() => {
    if (open) {
      form.reset(isEdit && milestone ? toValues(milestone) : BLANK);
      setFormErr("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, milestone?.id]);

  async function submit() {
    if (!form.validate()) return;
    setFormErr("");
    const v = form.values;
    const payload: Record<string, unknown> = {
      project_id: projectId,
      name: v.name.trim(),
      plan_date: v.plan_date || null,
      actual_date: v.actual_date || null,
      owner_id: v.owner_id ? Number(v.owner_id) : null,
    };
    try {
      if (isEdit) await milestonesApi.update(milestone!.id, payload);
      else await milestonesApi.create(payload);
    } catch (e) {
      setFormErr(errText(e));
      return;
    }
    onSaved();
    onClose();
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      dirty={form.dirty}
      title={isEdit ? `编辑里程碑 · ${milestone?.name ?? ""}` : "新增里程碑"}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>取消</button>
          <button className="btn-primary" onClick={submit}>{isEdit ? "保存修改" : "创建里程碑"}</button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="里程碑名称" required error={form.errors.name} span>
          <input
            value={form.values.name}
            aria-invalid={!!form.errors.name}
            onChange={(e) => form.set("name", e.target.value)}
            placeholder="如：一期上线"
          />
        </Field>
        <Field label="计划日期" required error={form.errors.plan_date} hint="计划日前 3 天自动预警">
          <input
            type="date"
            value={form.values.plan_date}
            aria-invalid={!!form.errors.plan_date}
            onChange={(e) => form.set("plan_date", e.target.value)}
          />
        </Field>
        <Field label="实际日期" hint="填写后自动标记完成">
          <input type="date" value={form.values.actual_date} onChange={(e) => form.set("actual_date", e.target.value)} />
        </Field>
        <Field label="负责人" span>
          <Select value={form.values.owner_id} onChange={(value) => form.set("owner_id", value)}>
            <option value="">未指定</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.real_name}</option>)}
          </Select>
        </Field>
      </div>
      {formErr && <div className="err-banner" style={{ marginTop: 10, marginBottom: 0 }} role="alert">{formErr}</div>}
    </Dialog>
  );
}
