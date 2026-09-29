"use client";

import { useEffect, useState } from "react";
import Field from "@/components/ui/Field";
import { DatePicker } from "@/components/ui/DatePicker";
import { Dialog } from "@/components/ui/Modal";
import { errText, type ProjectReceivable, type ProjectReceivableInput, type ProjectReceivablePayment, type ProjectReceivablePaymentInput } from "@/lib/api";

function today(): string {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

function normalizePositiveAmount(value: string): string | null {
  const raw = value.trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(raw)) return null;
  const [whole, fraction = ""] = raw.split(".");
  const normalized = `${BigInt(whole)}.${(fraction + "00").slice(0, 2)}`;
  return /^0\.00$/.test(normalized) ? null : normalized;
}

export function ProjectReceivableDialog({
  open,
  receivable,
  onClose,
  onSave,
}: {
  open: boolean;
  receivable?: ProjectReceivable | null;
  onClose: () => void;
  onSave: (body: ProjectReceivableInput) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [receivableDate, setReceivableDate] = useState(today());
  const [dueDate, setDueDate] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(receivable?.name ?? "");
    setAmount(receivable?.amount ?? "");
    setReceivableDate(receivable?.receivable_date ?? today());
    setDueDate(receivable?.due_date ?? "");
    setNote(receivable?.note ?? "");
    setError("");
  }, [open, receivable]);

  async function submit() {
    if (!name.trim()) return setError("请填写款项名称");
    const normalizedAmount = normalizePositiveAmount(amount);
    if (!normalizedAmount) return setError("应收金额须大于 0，且最多保留两位小数");
    if (!receivableDate || !dueDate) return setError("请填写应收日期和到期日");
    if (dueDate < receivableDate) return setError("到期日不能早于应收日期");
    setSaving(true);
    setError("");
    try {
      await onSave({
        name: name.trim(),
        amount: normalizedAmount,
        receivable_date: receivableDate,
        due_date: dueDate,
        note: note.trim(),
      });
      onClose();
    } catch (cause) {
      setError(errText(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={receivable ? "编辑应收" : "新增应收"}
      footer={<>
        <button type="button" className="btn-ghost" onClick={onClose} disabled={saving}>取消</button>
        <button type="button" className="btn-primary" onClick={submit} disabled={saving}>
          {saving ? "保存中…" : "保存应收"}
        </button>
      </>}
    >
      <div className="form-grid">
        <Field label="款项名称" required span>
          <input value={name} onChange={(event) => setName(event.target.value)} maxLength={128} />
        </Field>
        <Field label="应收金额（元）" required>
          <input inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} />
        </Field>
        <Field label="应收日期" required>
          <DatePicker value={receivableDate} onChange={setReceivableDate} ariaLabel="应收日期" />
        </Field>
        <Field label="到期日" required>
          <DatePicker value={dueDate} onChange={setDueDate} ariaLabel="到期日" />
        </Field>
        <Field label="说明" span>
          <textarea value={note} onChange={(event) => setNote(event.target.value)} rows={3} maxLength={1000} />
        </Field>
      </div>
      {error && <div className="err-banner" role="alert">{error}</div>}
    </Dialog>
  );
}

export function ProjectReceivablePaymentDialog({
  open,
  payment,
  onClose,
  onSave,
}: {
  open: boolean;
  payment?: ProjectReceivablePayment | null;
  onClose: () => void;
  onSave: (body: ProjectReceivablePaymentInput) => Promise<void>;
}) {
  const [amount, setAmount] = useState("");
  const [paymentDate, setPaymentDate] = useState(today());
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setAmount(payment?.amount ?? "");
    setPaymentDate(payment?.payment_date ?? today());
    setNote(payment?.note ?? "");
    setError("");
  }, [open, payment]);

  async function submit() {
    const normalizedAmount = normalizePositiveAmount(amount);
    if (!normalizedAmount) return setError("回款金额须大于 0，且最多保留两位小数");
    if (!paymentDate) return setError("请填写回款日期");
    setSaving(true);
    setError("");
    try {
      await onSave({ amount: normalizedAmount, payment_date: paymentDate, note: note.trim() });
      onClose();
    } catch (cause) {
      setError(errText(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={payment ? "更正回款" : "登记回款"}
      footer={<>
        <button type="button" className="btn-ghost" onClick={onClose} disabled={saving}>取消</button>
        <button type="button" className="btn-primary" onClick={submit} disabled={saving}>
          {saving ? "保存中…" : "保存回款"}
        </button>
      </>}
    >
      <div className="form-grid">
        <Field label="回款金额（元）" required>
          <input inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} />
        </Field>
        <Field label="回款日期" required>
          <DatePicker value={paymentDate} onChange={setPaymentDate} ariaLabel="回款日期" />
        </Field>
        <Field label="备注" span>
          <textarea value={note} onChange={(event) => setNote(event.target.value)} rows={3} maxLength={1000} />
        </Field>
      </div>
      {error && <div className="err-banner" role="alert">{error}</div>}
    </Dialog>
  );
}
