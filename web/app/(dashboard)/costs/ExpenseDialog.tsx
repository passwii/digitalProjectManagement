"use client";
// 支出登记 / 被驳回后修改重新提交弹窗。
// 提交失败（超预算等业务错误）时**不清空表单**，用户改完可以直接重试。
import { useEffect, useState } from "react";
import { errText, expensesApi, type Expense } from "@/lib/api";
import { EXPENSE_PEOPLE, todayISO } from "@/lib/labels";
import { useForm } from "@/lib/useForm";
import { Dialog } from "@/components/ui/Modal";
import Field from "@/components/ui/Field";

interface Values {
  subject: string;
  amount: string;
  exp_date: string;
  note: string;
}

const BLANK: Values = { subject: EXPENSE_PEOPLE[0], amount: "", exp_date: "", note: "" };

/** 被驳回单据 → 表单预填：让「修改后重新提交」不必重新敲一遍 */
function fromExpense(x: Expense): Values {
  return {
    subject: x.subject || BLANK.subject,
    amount: String(x.amount ?? ""),
    exp_date: x.exp_date ?? todayISO(),
    note: x.note ?? "",
  };
}

export default function ExpenseDialog({
  open,
  onClose,
  projectId,
  resubmitOf,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  projectId: number;
  /** 传入被驳回的支出 → 以它为模板重新提交（标题与提示切换为「重新提交」） */
  resubmitOf?: Expense | null;
  onSaved: (msg: string, warn: boolean) => void;
}) {
  const [formErr, setFormErr] = useState("");
  const isResubmit = !!resubmitOf;
  const form = useForm<Values>(BLANK, {
    amount: {
      required: "请填写支出金额",
      label: "支出金额",
      custom: (v) => (Number(v) > 0 ? null : "支出金额须大于 0"),
    },
  });

  useEffect(() => {
    if (!open) return;
    form.reset(resubmitOf ? fromExpense(resubmitOf) : { ...BLANK, exp_date: todayISO() });
    setFormErr("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, resubmitOf?.id]);

  async function submit() {
    setFormErr("");
    if (!form.validate()) return;
    const v = form.values;
    const payload = {
      project_id: projectId,
      subject: v.subject,
      amount: Number(v.amount),
      exp_date: v.exp_date || null,
      note: v.note.trim(),
    };
    try {
      const saved = await expensesApi.create(payload);
      const rate = saved.execution?.rate;
      const msg =
        saved.status === "pending"
          ? isResubmit
            ? "已重新提交，等待审批后计入执行"
            : "支出已提交，等待审批后计入执行"
          : `支出已登记并计入执行${rate != null ? `（执行率 ${(rate * 100).toFixed(1)}%）` : ""}`;
      onSaved(msg, !!saved.execution?.warn);
      onClose();
    } catch (e) {
      // 超预算等业务错误：**保留弹窗内容**（含已填数据），提示下一步可走的路径
      const msg = errText(e);
      setFormErr(
        /超预算/.test(msg)
          ? `${msg}。可调整预算，或先把单据提交为待审批再由管理员「特批放行」。`
          : msg,
      );
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      dirty={form.dirty}
      title={isResubmit ? `重新提交支出 · ${resubmitOf?.subject ?? ""}` : "添加支出"}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>取消</button>
          <button className="btn-primary" onClick={submit}>{isResubmit ? "重新提交" : "提交支出"}</button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="人员" required>
          <select value={form.values.subject} onChange={(e) => form.set("subject", e.target.value)}>
            {EXPENSE_PEOPLE.map((s) => <option key={s} value={s}>{s}</option>)}
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
      {isResubmit && <p className="tiny">原单保留，按审批意见修改后重新提交。</p>}
    </Dialog>
  );
}
