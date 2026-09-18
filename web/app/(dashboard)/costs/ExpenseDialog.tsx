"use client";
// 支出登记 / 被驳回后修改重新提交弹窗。
// 提交失败（超预算等业务错误）时**不清空表单**，用户改完可以直接重试。
// 票据证明（BLF-1151）：先建单、再挂票据——支出 id 建单后才存在，待传文件暂存本地，
// 建单成功后逐个上传到新单据；票据失败不关闭弹层、不丢表单（Toast + 行内提示）。
import { useEffect, useState } from "react";
import { batchFailureToast } from "@/lib/uploadErrors";
import { errText, expensesApi, type Attachment, type Expense } from "@/lib/api";
import { EXPENSE_PEOPLE, todayISO } from "@/lib/labels";
import { VOUCHER_ATTACHMENT_EXTENSIONS, VOUCHER_ATTACHMENT_HINT } from "@/lib/uploadLimits";
import { useForm } from "@/lib/useForm";
import { useUploadQueue } from "@/lib/useUploadQueue";
import { Dialog } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import Field from "@/components/ui/Field";
import FileDropZone from "@/components/ui/FileDropZone";

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
  const [files, setFiles] = useState<File[]>([]);
  const [saving, setSaving] = useState(false);
  // 建单成功后锁定为「补传模式」：支出单已存在，再走 submit 会重复建单，
  // 后续只允许重试失败票据（review：防重复创建）。
  const [created, setCreated] = useState<{ id: number; msg: string; warn: boolean; total: number } | null>(null);
  const toast = useToast();
  const uploads = useUploadQueue();
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
    setFiles([]);
    setCreated(null);
    uploads.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, resubmitOf?.id]);

  // 弹层关闭即中止在途上传：避免「关掉弹层还在传」
  useEffect(() => {
    if (!open) uploads.abort();
    // 只依赖 abort（稳定引用）：依赖整个 uploads 对象会在每次进度更新时重跑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, uploads.abort]);

  async function submit() {
    // 已建单成功：直接忽略，避免重复调用 expensesApi.create 产生重复支出单
    if (created) return;
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
    setSaving(true);
    try {
      const saved = await expensesApi.create(payload);
      const rate = saved.execution?.rate;
      const msg =
        saved.status === "pending"
          ? isResubmit
            ? "已重新提交，等待审批后计入执行"
            : "支出已提交，等待审批后计入执行"
          : `支出已登记并计入执行${rate != null ? `（执行率 ${(rate * 100).toFixed(1)}%）` : ""}`;
      const warn = !!saved.execution?.warn;
      // 先落锁再传票据：票据部分失败时提交按钮保持禁用，只能走行内重试补传
      setCreated({ id: saved.id, msg, warn, total: files.length });
      // 票据挂到刚建好的单据上；单个失败不阻断其余文件，失败时留在弹层里
      if (files.length) {
        const result = await uploads.start<Attachment>(files, (file, options) =>
          expensesApi.uploadVoucher(saved.id, file, options),
        );
        if (result.aborted) return;
        if (result.failed) {
          const msg = batchFailureToast(result.failures);
          setFormErr(msg);
          toast.err(msg);
          return;
        }
      }
      onSaved(files.length ? `${msg}，票据 ${files.length} 份已上传` : msg, warn);
      setFiles([]);
      onClose();
    } catch (e) {
      // 超预算等业务错误：**保留弹窗内容**（含已填数据与待传票据），提示下一步可走的路径
      const msg = errText(e);
      setFormErr(
        /超预算/.test(msg)
          ? `${msg}。可调整预算，或先把单据提交为待审批再由管理员「特批放行」。`
          : msg,
      );
    } finally {
      setSaving(false);
    }
  }

  /**
   * 补传一条失败的票据（文件还在队列里，不必重新选择，也不会重复上传已成功的那些）。
   *
   * 全部失败项都补完后才收尾关弹层；否则留在弹层里继续处理剩下的失败行。
   */
  async function retryUpload(id: number) {
    const result = await uploads.retry<Attachment>(id);
    if (result.aborted) return;
    if (result.failures[0]) {
      const msg = batchFailureToast(result.failures);
      setFormErr(msg);
      toast.err(msg);
      return;
    }
    const remaining = uploads.items.filter((item) => item.id !== id && item.status !== "done");
    if (!remaining.length) {
      // 最后一张失败票据补传成功：走与 submit 成功一致的收尾——先刷新父列表再关弹层，
      // 且全程不再调 create（created 锁保证无重复建单）。
      if (created) {
        onSaved(created.total ? `${created.msg}，票据 ${created.total} 份已上传` : created.msg, created.warn);
        setCreated(null);
      } else {
        toast.ok("票据已补传成功");
      }
      setFiles([]);
      setFormErr("");
      onClose();
    } else {
      toast.ok("票据已补传成功");
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      dirty={form.dirty || files.length > 0}
      title={isResubmit ? `重新提交支出 · ${resubmitOf?.subject ?? ""}` : "添加支出"}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose} disabled={saving}>取消</button>
          <button className="btn-primary" onClick={submit} disabled={saving || !!created}>
            {saving ? "保存中…" : created ? "已创建，请补传票据" : isResubmit ? "重新提交" : "提交支出"}
          </button>
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
      <div className="form-section">
        <div className="form-section-head">
          <h3>票据证明</h3>
        </div>
        <div className="field span-2">
          <span className="field-label">发票 PDF / 凭证图片</span>
          <FileDropZone
            extensions={VOUCHER_ATTACHMENT_EXTENSIONS}
            items={uploads.items}
            disabled={saving || !!created}
            label={created ? "支出已创建，失败票据请点行内「重试」补传" : files.length ? `已选择 ${files.length} 个文件，随单据一起提交` : "选择票据文件"}
            onRetry={retryUpload}
            hint={
              files.length
                ? "可继续点击或拖拽追加文件"
                : "点击选择，或把文件拖到这里；也可直接粘贴截图"
            }
            onFiles={(picked) =>
              setFiles((prev) => [
                ...prev,
                // 同名同体积视为同一份，避免拖拽与选择器重复入队
                ...picked.filter(
                  (f) => !prev.some((x) => x.name === f.name && x.size === f.size),
                ),
              ])
            }
          />
          <span className="field-hint">{VOUCHER_ATTACHMENT_HINT}</span>
          {files.length > 0 && (
            <ul className="pending-file-list">
              {files.map((file, index) => (
                <li key={`${file.name}-${file.size}-${index}`}>
                  <span className="pending-file-name" title={file.name}>{file.name}</span>
                  <button
                    type="button"
                    className="linklike danger-link"
                    onClick={() =>
                      setFiles((prev) => prev.filter((_, i) => i !== index))
                    }
                  >
                    移除
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      {formErr && <div className="err-banner" style={{ marginTop: 10, marginBottom: 0 }} role="alert">{formErr}</div>}
      {isResubmit && <p className="tiny">原单保留，按审批意见修改后重新提交。</p>}
    </Dialog>
  );
}
