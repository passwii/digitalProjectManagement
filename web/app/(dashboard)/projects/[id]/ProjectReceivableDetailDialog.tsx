"use client";
// 应收详情弹层（只读 + 操作入口）：项目档案「应收」Tab 点卡片 / 表格行打开。
//
// 与列表同一份展示口径（金额分组、状态文案 / 色调）——因此这三个纯函数在本模块
// 导出，由 `ProjectReceivablesPanel` 反向导入复用，避免列表与详情各写一份而漂移。
// 动作只做「转发」：编辑 / 登记回款 / 更正回款 / 删除都回调给面板，弹层自己不改数据，
// 也就不必重复权限判断（面板已按 canWrite / canDelete 决定是否传回调）。
import { useCallback, useEffect, useState } from "react";
import Badge from "@/components/ui/Badge";
import Empty from "@/components/ui/Empty";
import { Dialog } from "@/components/ui/Modal";
import {
  errText,
  projectsApi,
  type ProjectReceivable,
  type ProjectReceivablePayment,
} from "@/lib/api";
import { fmtDate } from "@/lib/labels";
import { isAbortError } from "@/lib/useAsyncData";

/** 金额展示：固定两位小数并做千分位分组（列表与详情同口径）。 */
export function money(value: string | number | null | undefined): string {
  const raw = String(value ?? "0").trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) return "0.00";
  const [whole, fraction = ""] = raw.split(".");
  const grouped = BigInt(whole).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${grouped}.${(fraction + "00").slice(0, 2)}`;
}

export function statusLabel(status: ProjectReceivable["status"]): string {
  if (status === "paid") return "已收清";
  if (status === "overdue") return "逾期";
  if (status === "partial") return "部分回款";
  return "未回款";
}

export function statusTone(status: ProjectReceivable["status"]): "done" | "danger" | "warn" | "todo" {
  if (status === "paid") return "done";
  if (status === "overdue") return "danger";
  if (status === "partial") return "warn";
  return "todo";
}

export default function ProjectReceivableDetailDialog({
  open,
  projectId,
  receivable,
  onClose,
  onEdit,
  onAddPayment,
  onEditPayment,
  onDelete,
}: {
  open: boolean;
  projectId: number;
  receivable: ProjectReceivable | null;
  onClose: () => void;
  onEdit?: (receivable: ProjectReceivable) => void;
  onAddPayment?: (receivable: ProjectReceivable) => void;
  onEditPayment?: (receivable: ProjectReceivable, payment: ProjectReceivablePayment) => void;
  onDelete?: (receivable: ProjectReceivable) => void;
}) {
  const [payments, setPayments] = useState<ProjectReceivablePayment[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadErr, setLoadErr] = useState("");

  const rid = receivable?.id ?? 0;

  const loadPayments = useCallback(async (signal: AbortSignal) => {
    if (!rid) return;
    setLoading(true);
    setLoadErr("");
    try {
      const page = await projectsApi.receivablePayments(
        projectId,
        rid,
        { page: 1, size: 50 },
        signal,
      );
      if (!signal.aborted) setPayments(page.items);
    } catch (e) {
      if (!signal.aborted && !isAbortError(e)) setLoadErr(errText(e));
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, [projectId, rid]);

  useEffect(() => {
    if (!open || !rid) {
      setPayments([]);
      setLoadErr("");
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    void loadPayments(controller.signal);
    return () => controller.abort();
  }, [open, rid, loadPayments]);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="md"
      title={receivable ? `应收详情 · ${receivable.name}` : "应收详情"}
      footer={
        <>
          {receivable && onDelete && (
            <button type="button" className="btn-ghost danger-link" onClick={() => onDelete(receivable)}>删除</button>
          )}
          <button type="button" className="btn-ghost" onClick={onClose}>关闭</button>
          {receivable && onEdit && (
            <button type="button" className="btn-ghost" onClick={() => onEdit(receivable)}>编辑</button>
          )}
          {receivable && onAddPayment && receivable.status !== "paid" && (
            <button type="button" className="btn-primary" onClick={() => onAddPayment(receivable)}>登记回款</button>
          )}
        </>
      }
    >
      {receivable && (
        <>
          <dl className="kv one">
            <div><dt>款项名称</dt><dd>{receivable.name}</dd></div>
            <div><dt>应收金额</dt><dd className="mono">{money(receivable.amount)} 元</dd></div>
            <div><dt>已收金额</dt><dd className="mono">{money(receivable.received_amount)} 元</dd></div>
            <div><dt>未收余额</dt><dd className="mono">{money(receivable.outstanding_amount)} 元</dd></div>
            <div><dt>应收日期</dt><dd className="mono">{fmtDate(receivable.receivable_date)}</dd></div>
            <div><dt>到期日</dt><dd className="mono">{fmtDate(receivable.due_date)}</dd></div>
            <div>
              <dt>状态</dt>
              <dd><Badge status={statusLabel(receivable.status)} tone={statusTone(receivable.status)} /></dd>
            </div>
            <div><dt>说明</dt><dd>{receivable.note || "-"}</dd></div>
          </dl>

          <div className="form-section">
            <div className="form-section-head">
              <h3>回款记录{payments.length > 0 && `（${payments.length}）`}</h3>
            </div>
            {loading ? (
              <p className="tiny">加载回款记录…</p>
            ) : loadErr ? (
              <div className="err-banner" role="alert">{loadErr}</div>
            ) : payments.length === 0 ? (
              <Empty title="暂无回款" hint="登记回款后会在这里保留逐笔记录。" />
            ) : (
              <div className="attachment-list">
                {payments.map((payment) => (
                  <div className="attachment-row" key={payment.id}>
                    <span className="attachment-name mono">{money(payment.amount)} 元</span>
                    <span className="tiny mono">{fmtDate(payment.payment_date)}</span>
                    <span className="tiny ellipsis" title={payment.note}>{payment.note || "-"}</span>
                    {onEditPayment && (
                      <button
                        type="button"
                        className="linklike"
                        onClick={() => onEditPayment(receivable, payment)}
                      >
                        更正回款
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </Dialog>
  );
}
