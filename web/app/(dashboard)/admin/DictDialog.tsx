"use client";
// 数据字典新增弹窗
import { useEffect } from "react";
import { adminApi } from "@/lib/api";
import { useForm } from "@/lib/useForm";
import { Dialog } from "@/components/ui/Modal";
import Field from "@/components/ui/Field";

const TYPES = ["project_type", "priority", "subject", "followup_method", "project_status"];

interface Values {
  type: string;
  code: string;
  label: string;
  sort: string;
}

const BLANK: Values = { type: "project_type", code: "", label: "", sort: "0" };

export default function DictDialog({
  open,
  onClose,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const form = useForm<Values>(BLANK, {
    type: { required: "请选择字典类型", label: "字典类型" },
    code: { required: "请填写编码", max: 32, label: "编码" },
    label: { required: "请填写显示名", max: 64, label: "显示名" },
  });

  useEffect(() => {
    if (open) form.reset(BLANK);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function submit() {
    if (!form.validate()) return;
    await adminApi.createDict({
      type: form.values.type,
      code: form.values.code.trim(),
      label: form.values.label.trim(),
      sort: Number(form.values.sort || 0),
    });
    onSaved();
    onClose();
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      dirty={form.dirty}
      title="新增字典项"
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>取消</button>
          <button className="btn-primary" onClick={submit}>保存</button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="字典类型" required error={form.errors.type}>
          <input
            value={form.values.type}
            list="dict-types"
            onChange={(e) => form.set("type", e.target.value)}
            aria-invalid={!!form.errors.type}
          />
        </Field>
        <datalist id="dict-types">
          {TYPES.map((t) => <option key={t} value={t} />)}
        </datalist>
        <Field label="排序" hint="数字越小越靠前">
          <input value={form.values.sort} onChange={(e) => form.set("sort", e.target.value)} inputMode="numeric" />
        </Field>
        <Field label="编码" required error={form.errors.code}>
          <input
            value={form.values.code}
            aria-invalid={!!form.errors.code}
            onChange={(e) => form.set("code", e.target.value)}
            placeholder="如：research"
          />
        </Field>
        <Field label="显示名" required error={form.errors.label}>
          <input
            value={form.values.label}
            aria-invalid={!!form.errors.label}
            onChange={(e) => form.set("label", e.target.value)}
            placeholder="如：研发"
          />
        </Field>
      </div>
    </Dialog>
  );
}
