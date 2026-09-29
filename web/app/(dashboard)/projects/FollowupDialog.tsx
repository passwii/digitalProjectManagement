"use client";
// 跟进记录弹窗：新建 / 编辑
import { useEffect } from "react";
import { projectsApi, type Followup } from "@/lib/api";
import { FOLLOWUP_METHODS } from "@/lib/labels";
import { useForm } from "@/lib/useForm";
import { Dialog } from "@/components/ui/Modal";
import Field from "@/components/ui/Field";
import Select from "@/components/ui/Select";

interface Values {
  method: string;
  happened_at: string;
  content: string;
  next_step: string;
  remind_at: string;
}

const BLANK: Values = { method: "电话", happened_at: "", content: "", next_step: "", remind_at: "" };

/** ISO 时间 → date input 值（YYYY-MM-DD） */
const toDate = (s?: string | null) => (s ? s.slice(0, 10) : "");

export default function FollowupDialog({
  open,
  onClose,
  projectId,
  followup,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  projectId: number;
  /** 传 followup 为编辑，null 为新建 */
  followup: Followup | null;
  onSaved: (isNew: boolean) => void;
}) {
  const isEdit = !!followup;

  const form = useForm<Values>(
    isEdit && followup
      ? {
          method: followup.method || "电话",
          happened_at: toDate(followup.happened_at),
          content: followup.content || "",
          next_step: followup.next_step || "",
          remind_at: toDate(followup.remind_at),
        }
      : BLANK,
    {
      content: { required: "请填写跟进内容", max: 500, label: "跟进内容" },
    }
  );

  useEffect(() => {
    if (!open) return;
    form.reset(
      followup
        ? {
            method: followup.method || "电话",
            happened_at: toDate(followup.happened_at),
            content: followup.content || "",
            next_step: followup.next_step || "",
            remind_at: toDate(followup.remind_at),
          }
        : BLANK
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, followup?.id]);

  async function submit() {
    if (!form.validate()) return;
    const v = form.values;
    const payload = {
      method: v.method,
      happened_at: v.happened_at ? `${v.happened_at}T09:00:00` : null,
      content: v.content.trim(),
      next_step: v.next_step.trim(),
      remind_at: v.remind_at ? `${v.remind_at}T09:00:00` : null,
    };
    if (isEdit) await projectsApi.updateFollowup(projectId, followup!.id, payload);
    else await projectsApi.addFollowup(projectId, payload);
    onSaved(!isEdit);
    onClose();
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      dirty={form.dirty}
      title={isEdit ? "编辑跟进记录" : "新增跟进记录"}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>取消</button>
          <button className="btn-primary" onClick={submit}>{isEdit ? "保存修改" : "保存跟进"}</button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="跟进方式">
          <Select value={form.values.method} onChange={(value) => form.set("method", value)}>
            {FOLLOWUP_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
          </Select>
        </Field>
        <Field label="跟进时间" hint="留空取当前时间">
          <input type="date" value={form.values.happened_at} onChange={(e) => form.set("happened_at", e.target.value)} />
        </Field>
        <Field label="跟进内容" required error={form.errors.content} span>
          <textarea
            rows={3}
            value={form.values.content}
            aria-invalid={!!form.errors.content}
            onChange={(e) => form.set("content", e.target.value)}
            placeholder="本次沟通要点"
          />
        </Field>
        <Field label="下一步计划" span>
          <textarea rows={2} value={form.values.next_step} onChange={(e) => form.set("next_step", e.target.value)} placeholder="后续动作" />
        </Field>
        <Field label="下次跟进提醒" hint="到期后生成站内通知" span>
          <input type="date" value={form.values.remind_at} onChange={(e) => form.set("remind_at", e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}
