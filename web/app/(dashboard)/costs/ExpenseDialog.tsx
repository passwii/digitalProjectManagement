"use client";
// 支出登记弹窗：提交后按审批开关决定直接计入 / 待审批
import { useEffect, useState } from "react";
import { errText, expensesApi } from "@/lib/api";
import { SUBJECTS, todayISO } from "@/lib/labels";
import { useForm } from "@/lib/useForm";
import { Dialog } from "@/components/ui/Modal";
import Field from "@/components/ui/Field";

interface Values {
  subject: string;
  amount: string;
  exp_date: string;
  note: string;
}

const BLANK: Values = { subject: "人工", amount: "", exp_date: "", note: "" };

export default function ExpenseDialog({
  open,
  onClose,
  projectId,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  projectId: number;
  onSaved: (msg: string, warn: boolean) => void;
}) {
  const [formErr, setFormErr] = useState("");
  const form = useForm<Values>(BLANK, {
    amount: {
      required: "请填写支出金额",
      label: "支出金额",
      custom: (v) => (Number(v) > 0 ? null : "支出金额须大于 0"),
    },
  });

  useEffect(() => {
    if (open) {
      form.reset({ ...BLANK, exp_date: todayISO() });
      setFormErr("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function submit() {
    setFormErr("");
    if (!form.validate()) return;
    const v = form.values;
    try {
      const saved = await expensesApi.create({
        project_id: projectId,
        subject: v.subject,
        amount: Number(v.amount),
        exp_date: v.exp_date || null,
        note: v.note.trim(),
      });
      const rate = saved.execution?.rate;
      const msg =
        saved.status === "pending"
          ? "支出已提交，等待审批后计入执行"
          : `支出已登记并计入执行${rate != null ? `（执行率 ${(rate * 100).toFixed(1)}%）` : ""}`;
      onSaved(msg, !!saved.execution?.warn);
      onClose();
    } catch (e) {
      // 超预算等业务错误：保留弹窗内容，提示走特批
      const msg = errText(e);
      setFormErr(/超预算/.test(msg) ? `${msg}。可在支出列表对挂起单据点「特批放行」。` : msg);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      dirty={form.dirty}
      title="登记支出"
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>取消</button>
          <button className="btn-primary" onClick={submit}>提交支出</button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="科目" required>
          <select value={form.values.subject} onChange={(e) => form.set("subject", e.target.value)}>
            {SUBJECTS.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </Field>
        <Field label="支出金额（元）" required error={form.errors.amount}>
          <input
            value={form.values.amount}
            aria-invalid={!!form.errors.amount}
            onChange={(e) => form.set("amount", e.target.value)}
            placeholder="如：8000"
            inputMode="decimal"
          />
        </Field>
        <Field label="支出日期">
          <input type="date" value={form.values.exp_date} onChange={(e) => form.set("exp_date", e.target.value)} />
        </Field>
        <Field label="费用说明" span>
          <input value={form.values.note} onChange={(e) => form.set("note", e.target.value)} placeholder="用途说明" />
        </Field>
      </div>
      {formErr && <div className="err-banner" style={{ marginTop: 10, marginBottom: 0 }} role="alert">{formErr}</div>}
      <p className="tiny">审批开关开启或超预算时转为「待审批」；审批关闭且超预算会被直接拦截，需调整预算或走特批。</p>
    </Dialog>
  );
}
