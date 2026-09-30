"use client";
// 支出详情弹层（只读，BLF-1xxx）：项目档案「成本」Tab 点卡片 / 表格行打开。
//
// 只负责「看」：金额、日期、状态、审批意见与票据证明集中在一处，避免在窄表格里
// 逐列找信息。被驳回的单据额外给「重新提交」入口，但**不在这里改数据**——
// 回调交回页面复用 `ExpenseDialog` 的 `resubmitOf`（与成本页同一套重新提交流程），
// 本组件保持只读语义，票据下载失败用 Toast 收口。
import { useCallback, useEffect, useRef, useState } from "react";
import Badge from "@/components/ui/Badge";
import Empty from "@/components/ui/Empty";
import { Dialog } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import { errText, expensesApi, type Expense, type ExpenseVoucher } from "@/lib/api";
import { expenseStatusLabel, expenseTone, fmtDate, fmtDateTime, fmtMoney } from "@/lib/labels";
import { formatFileSize } from "@/lib/uploadLimits";
import { isAbortError } from "@/lib/useAsyncData";

export default function ExpenseDetailDialog({
  open,
  expense,
  onClose,
  onResubmit,
}: {
  open: boolean;
  expense: Expense | null;
  onClose: () => void;
  /** 被驳回的单据：把「重新提交」交回页面（打开登记弹层并预填原单） */
  onResubmit?: (expense: Expense) => void;
}) {
  const toast = useToast();
  const [vouchers, setVouchers] = useState<ExpenseVoucher[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadErr, setLoadErr] = useState("");
  const readControllerRef = useRef<AbortController | null>(null);

  const eid = expense?.id ?? 0;

  const loadVouchers = useCallback(async () => {
    if (!eid) return;
    // 只保留最新一次请求的响应：快速切换单据时旧响应不得覆盖新单据的票据列表。
    readControllerRef.current?.abort();
    const controller = new AbortController();
    readControllerRef.current = controller;
    setLoading(true);
    setLoadErr("");
    try {
      const rows = await expensesApi.vouchers(eid, controller.signal);
      if (!controller.signal.aborted) setVouchers(rows);
    } catch (e) {
      if (!controller.signal.aborted && !isAbortError(e)) setLoadErr(errText(e));
    } finally {
      if (readControllerRef.current === controller) {
        readControllerRef.current = null;
        if (!controller.signal.aborted) setLoading(false);
      }
    }
  }, [eid]);

  useEffect(() => {
    readControllerRef.current?.abort();
    readControllerRef.current = null;
    if (!open || !eid) {
      setVouchers([]);
      setLoadErr("");
      setLoading(false);
      return;
    }
    void loadVouchers();
    return () => {
      readControllerRef.current?.abort();
      readControllerRef.current = null;
    };
  }, [open, eid, loadVouchers]);

  async function download(v: ExpenseVoucher) {
    try {
      await expensesApi.downloadVoucher(eid, v.id, v.filename);
    } catch (e) {
      toast.err(errText(e));
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="md"
      title={expense ? `支出详情 · ${expense.subject}` : "支出详情"}
      footer={<button type="button" className="btn-primary" onClick={onClose}>关闭</button>}
    >
      {expense && (
        <>
          <dl className="kv one">
            <div><dt>人员</dt><dd>{expense.subject || "-"}</dd></div>
            <div><dt>金额</dt><dd className="mono">{fmtMoney(expense.amount)} 元</dd></div>
            <div><dt>支出日期</dt><dd className="mono">{fmtDate(expense.exp_date)}</dd></div>
            <div><dt>费用说明</dt><dd>{expense.note || "-"}</dd></div>
            <div>
              <dt>状态</dt>
              <dd><Badge status={expenseStatusLabel(expense.status)} tone={expenseTone(expense.status)} /></dd>
            </div>
            <div><dt>审批意见</dt><dd>{expense.decision_reason || "-"}</dd></div>
            <div><dt>决策时间</dt><dd className="mono">{fmtDateTime(expense.decided_at)}</dd></div>
          </dl>

          <div className="form-section">
            <div className="form-section-head">
              <h3>票据证明{vouchers.length > 0 && `（${vouchers.length}）`}</h3>
            </div>
            {loading ? (
              <p className="tiny">加载票据…</p>
            ) : loadErr ? (
              <div className="err-banner" role="alert">
                {loadErr}
                <button type="button" className="linklike" onClick={() => void loadVouchers()}>重试</button>
              </div>
            ) : vouchers.length === 0 ? (
              <Empty title="暂无票据" hint="登记支出时上传的发票或凭证会显示在这里。" />
            ) : (
              <div className="attachment-list">
                {vouchers.map((v) => (
                  <div className="attachment-row" key={v.id}>
                    <span className="attachment-name" title={v.filename}>{v.filename}</span>
                    <span className="tiny">{formatFileSize(v.size)}</span>
                    <button type="button" className="linklike" onClick={() => void download(v)}>下载</button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {expense.status === "rejected" && onResubmit && (
            <div className="form-section">
              <button type="button" className="btn-primary" onClick={() => onResubmit(expense)}>重新提交</button>
              <span className="field-hint">原单保留，按审批意见修改后重新提交。</span>
            </div>
          )}
        </>
      )}
    </Dialog>
  );
}
