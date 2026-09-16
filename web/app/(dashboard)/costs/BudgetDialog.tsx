"use client";
// 预算登记 / 调整申请弹窗
import { useEffect } from "react";
import { budgetsApi, type Budget } from "@/lib/api";
import { SUBJECTS } from "@/lib/labels";
import { useForm } from "@/lib/useForm";
import { Dialog } from "@/components/ui/Modal";
import Field from "@/components/ui/Field";

interface Values {
  subject: string;
  amount: string;
  period_start: string;
  period_end: string;
}

const BLANK: Values = { subject: "人工", amount: "", period_start: "", period_end: "" };

function toValues(b: Budget): Values {
  return {
    subject: b.subject,
    amount: String(b.amount ?? ""),
    period_start: b.period_start ?? "",
    period_end: b.period_end ?? "",
  };
}

export default function BudgetDialog({
  open,
  onClose,
  projectId,
  budget,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  projectId: number;
  /** 传 budget 为调整（走审批留痕），null 为新增 */
  budget: Budget | null;
  onSaved: (isAdjust: boolean) => void;
}) {
  const isAdjust = !!budget;

  const form = useForm<Values>(isAdjust ? toValues(budget) : BLANK, {
    amount: {
      required: "请填写预算金额",
      label: "预算金额",
      custom: (v) => (Number(v) >= 0 ? null : "预算金额不能为负"),
    },
    period_end: {
      label: "预算期间结束",
      custom: (v, all) =>
        all.period_start && v && String(v) < all.period_start ? "期间开始不能晚于结束" : null,
    },
  });

  useEffect(() => {
    if (open) form.reset(isAdjust && budget ? toValues(budget) : BLANK);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, budget?.id]);

  async function submit() {
    if (!form.validate()) return;
    const v = form.values;
    const payload = {
      project_id: projectId,
      subject: v.subject,
      amount: Number(v.amount),
      period_start: v.period_start || null,
      period_end: v.period_end || null,
    };
    if (isAdjust) await budgetsApi.adjust(budget!.id, payload);
    else await budgetsApi.create(payload);
    onSaved(isAdjust);
    onClose();
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      dirty={form.dirty}
      title={isAdjust ? `预算调整申请 · ${budget?.subject ?? ""}` : "登记预算"}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>取消</button>
          <button className="btn-primary" onClick={submit}>{isAdjust ? "提交调整申请" : "保存预算"}</button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="科目" required>
          <select value={form.values.subject} disabled={isAdjust} onChange={(e) => form.set("subject", e.target.value)}>
            {SUBJECTS.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </Field>
        <Field label="预算金额（元）" required error={form.errors.amount}>
          <input
            value={form.values.amount}
            aria-invalid={!!form.errors.amount}
            onChange={(e) => form.set("amount", e.target.value)}
            placeholder="如：200000"
            inputMode="decimal"
          />
        </Field>
        <Field label="预算期间-开始" hint="须落在项目计划起止内">
          <input type="date" value={form.values.period_start} onChange={(e) => form.set("period_start", e.target.value)} />
        </Field>
        <Field label="预算期间-结束" error={form.errors.period_end}>
          <input
            type="date"
            value={form.values.period_end}
            aria-invalid={!!form.errors.period_end}
            onChange={(e) => form.set("period_end", e.target.value)}
          />
        </Field>
      </div>
      {isAdjust && <p className="tiny">调整需审批（开关可配置），通过后自动更新预算执行数据并留痕。</p>}
    </Dialog>
  );
}
