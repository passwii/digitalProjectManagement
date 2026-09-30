"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import Badge from "@/components/ui/Badge";
import { CardItem, CardList, DesktopTable } from "@/components/ui/CardList";
import Empty from "@/components/ui/Empty";
import Pagination from "@/components/ui/Pagination";
import { Confirm } from "@/components/ui/Modal";
import { LoadFailed, LoadingBlock } from "@/components/ui/PageState";
import { useToast } from "@/components/ui/Toast";
import {
  errText,
  projectsApi,
  type ProjectReceivable,
  type ProjectReceivableInput,
  type ProjectReceivableList,
  type ProjectReceivablePayment,
  type ProjectReceivablePaymentInput,
} from "@/lib/api";
import { fmtDate } from "@/lib/labels";
import {
  ProjectReceivableDialog,
  ProjectReceivablePaymentDialog,
} from "./ProjectReceivableDialogs";
// 展示口径（金额分组 / 状态文案与色调）与详情弹层共用一份：列表与详情不得各写一套。
import ProjectReceivableDetailDialog, {
  money,
  statusLabel,
  statusTone,
} from "./ProjectReceivableDetailDialog";
import styles from "./ProjectReceivables.module.css";

type Expanded = { id: number; items: ProjectReceivablePayment[]; page: number; total: number; loading: boolean; error: string } | null;
type DeleteTarget = { kind: "receivable"; receivable: ProjectReceivable } | { kind: "payment"; receivable: ProjectReceivable; payment: ProjectReceivablePayment } | null;
const PAGE_SIZE = 20;
const PAYMENT_PAGE_SIZE = 20;

export default function ProjectReceivablesPanel({
  projectId,
  canWrite,
  canDelete,
  onChanged,
}: {
  projectId: number;
  canWrite: boolean;
  canDelete: boolean;
  /** 应收 / 回款增删改成功后通知父级（刷新项目变更日志） */
  onChanged?: () => void;
}) {
  const toast = useToast();
  const [data, setData] = useState<ProjectReceivableList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [page, setPage] = useState(1);
  const [reloadKey, setReloadKey] = useState(0);
  const [editing, setEditing] = useState<ProjectReceivable | null | undefined>(undefined);
  const [paymentTarget, setPaymentTarget] = useState<{
    receivable: ProjectReceivable;
    payment?: ProjectReceivablePayment;
  } | null>(null);
  const [expanded, setExpanded] = useState<Expanded>(null);
  const [paymentsRevision, setPaymentsRevision] = useState(0);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget>(null);
  const [deleting, setDeleting] = useState(false);
  /** 打开详情的应收（`null` = 未打开）；与卡片 / 表格整行点击绑定。 */
  const [detail, setDetail] = useState<ProjectReceivable | null>(null);

  /** 打开详情；点整行与点卡片共用同一入口。 */
  const openDetail = useCallback((item: ProjectReceivable) => setDetail(item), []);

  const reload = useCallback(() => setReloadKey((value) => value + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    projectsApi.receivables(projectId, { page, size: PAGE_SIZE }, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setData(result);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(errText(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [projectId, page, reloadKey]);

  const loadPayments = useCallback(async (receivable: ProjectReceivable) => {
    if (expanded?.id === receivable.id) {
      setExpanded(null);
      return;
    }
    setExpanded({ id: receivable.id, items: [], page: 1, total: 0, loading: true, error: "" });
    setPaymentsRevision((revision) => revision + 1);
  }, [expanded?.id]);

  useEffect(() => {
    if (!expanded?.loading) return;
    const controller = new AbortController();
    const receivableId = expanded.id;
    projectsApi.receivablePayments(
      projectId,
      receivableId,
      { page: expanded.page, size: PAYMENT_PAGE_SIZE },
      controller.signal,
    )
      .then((response) => {
        if (!controller.signal.aborted) {
          setExpanded({
            id: receivableId,
            items: response.items,
            page: response.page,
            total: response.total,
            loading: false,
            error: "",
          });
        }
      })
      .catch((cause) => {
        if (!controller.signal.aborted) {
          setExpanded({ id: receivableId, items: [], page: expanded.page, total: 0, loading: false, error: errText(cause) });
        }
      });
    return () => controller.abort();
  }, [expanded?.id, expanded?.loading, expanded?.page, paymentsRevision, projectId]);

  function changePaymentPage(page: number) {
    if (expanded) {
      setExpanded({ ...expanded, page, items: [], loading: true, error: "" });
      setPaymentsRevision((revision) => revision + 1);
    }
  }

  async function saveReceivable(body: ProjectReceivableInput) {
    if (editing) {
      await projectsApi.updateReceivable(projectId, editing.id, body);
      toast.ok("应收记录已更新");
    } else {
      await projectsApi.createReceivable(projectId, body);
      toast.ok("应收记录已新增");
      setPage(1);
    }
    reload();
    onChanged?.();
  }

  async function savePayment(body: ProjectReceivablePaymentInput) {
    if (!paymentTarget) return;
    if (paymentTarget.payment) {
      await projectsApi.updateReceivablePayment(
        projectId,
        paymentTarget.receivable.id,
        paymentTarget.payment.id,
        body,
      );
      toast.ok("回款记录已更正");
    } else {
      await projectsApi.createReceivablePayment(projectId, paymentTarget.receivable.id, body);
      toast.ok("回款已登记");
    }
    setPaymentTarget(null);
    reload();
    setExpanded({ id: paymentTarget.receivable.id, items: [], page: 1, total: 0, loading: true, error: "" });
    setPaymentsRevision((revision) => revision + 1);
    onChanged?.();
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      if (deleteTarget.kind === "receivable") {
        await projectsApi.deleteReceivable(projectId, deleteTarget.receivable.id);
        toast.ok("应收记录已移入回收站");
      } else {
        await projectsApi.deleteReceivablePayment(
          projectId,
          deleteTarget.receivable.id,
          deleteTarget.payment.id,
        );
        toast.ok("回款记录已移入回收站");
      }
      reload();
      setExpanded(null);
      onChanged?.();
    } catch (cause) {
      toast.err(errText(cause));
    } finally {
      setDeleting(false);
      setDeleteTarget(null);
    }
  }

  const items = data?.items ?? [];
  const summary = data?.summary ?? { amount: "0.00", received_amount: "0.00", outstanding_amount: "0.00" };

  if (loading && !data) return <LoadingBlock kpis={3} label="加载项目应收…" />;
  if (error && !data) return <LoadFailed message={error} onRetry={reload} />;

  return (
    <section className="detail-section" aria-label="项目应收">
      {error && <LoadFailed message={error} onRetry={reload} />}
      <div className="kpi-row" aria-label="应收汇总">
        <div className="kpi"><div className="k">应收总额</div><div className="v mono">{money(summary.amount)}</div></div>
        <div className="kpi"><div className="k">累计已收</div><div className="v mono">{money(summary.received_amount)}</div></div>
        <div className="kpi"><div className="k">未收余额</div><div className="v mono">{money(summary.outstanding_amount)}</div></div>
      </div>

      <div className="section-head">
        <div>
          <h2>应收记录</h2>
        </div>
        {canWrite && (
          <button type="button" className="btn-primary" onClick={() => setEditing(null)}>+ 新增应收</button>
        )}
      </div>

      {!loading && items.length === 0 ? (
        <Empty title="暂无应收记录" hint={canWrite ? "新增一笔应收，开始跟踪回款。" : "此项目尚未登记应收。"} />
      ) : (
        <>
          <CardList label="项目应收">
            {items.map((item) => (
              <CardItem
                key={item.id}
                title={item.name}
                code={`到期 ${fmtDate(item.due_date)}`}
                badges={<Badge status={statusLabel(item.status)} tone={statusTone(item.status)} />}
                fields={[
                  { label: "应收金额", value: `${money(item.amount)} 元`, mono: true },
                  { label: "已收金额", value: `${money(item.received_amount)} 元`, mono: true },
                  { label: "未收余额", value: `${money(item.outstanding_amount)} 元`, mono: true },
                  { label: "应收日期", value: fmtDate(item.receivable_date), mono: true },
                  ...(item.note ? [{ label: "说明", value: item.note }] : []),
                ]}
                onSelect={() => openDetail(item)}
                actions={
                  <>
                    <button type="button" className="btn-ghost btn-xs" onClick={() => void loadPayments(item)}>
                      {expanded?.id === item.id ? "收起回款" : "回款记录"}
                    </button>
                    {canWrite && <button type="button" className="btn-ghost btn-xs" onClick={() => setEditing(item)}>编辑</button>}
                    {canWrite && item.status !== "paid" && (
                      <button type="button" className="btn-primary btn-xs" onClick={() => setPaymentTarget({ receivable: item })}>登记回款</button>
                    )}
                    {canDelete && <button type="button" className="btn-ghost btn-xs danger-link" aria-label="删除应收" onClick={() => setDeleteTarget({ kind: "receivable", receivable: item })}>删除</button>}
                  </>
                }
              />
            ))}
          </CardList>

          <DesktopTable>
            <table className="grid" aria-busy={loading}>
              <thead><tr><th>款项</th><th>应收日期</th><th>到期日</th><th className="num">应收金额（元）</th><th className="num">已收（元）</th><th className="num">未收（元）</th><th>状态</th><th className="no-print">操作</th></tr></thead>
              <tbody>
                {items.map((item) => (
                  <Fragment key={item.id}>
                    <tr
                      className="clickable-row"
                      title="点击查看应收详情"
                      onClick={() => openDetail(item)}
                    >
                      <td><strong>{item.name}</strong>{item.note && <div className="muted tiny">{item.note}</div>}</td>
                      <td className="mono">{fmtDate(item.receivable_date)}</td>
                      <td className="mono">{fmtDate(item.due_date)}</td>
                      <td className="num mono">{money(item.amount)}</td>
                      <td className="num mono">{money(item.received_amount)}</td>
                      <td className="num mono">{money(item.outstanding_amount)}</td>
                      <td><Badge status={statusLabel(item.status)} tone={statusTone(item.status)} /></td>
                      <td className="no-print" onClick={(e) => e.stopPropagation()}><span className="table-actions">
                        <button type="button" className="btn-ghost btn-xs" onClick={() => void loadPayments(item)}>{expanded?.id === item.id ? "收起回款" : "回款记录"}</button>
                        {canWrite && <button type="button" className="btn-ghost btn-xs" onClick={() => setEditing(item)}>编辑</button>}
                        {canWrite && item.status !== "paid" && <button type="button" className="btn-primary btn-xs" onClick={() => setPaymentTarget({ receivable: item })}>登记回款</button>}
                        {canDelete && <button type="button" className="btn-ghost btn-xs danger-link" aria-label="删除应收" onClick={() => setDeleteTarget({ kind: "receivable", receivable: item })}>删除</button>}
                      </span></td>
                    </tr>
                    {expanded?.id === item.id && <tr>
                      <td colSpan={8}>
                        <PaymentsDetail
                          expanded={expanded}
                          canWrite={canWrite}
                          canDelete={canDelete}
                          onPageChange={changePaymentPage}
                          onEdit={(payment) => setPaymentTarget({ receivable: item, payment })}
                          onDelete={(payment) => setDeleteTarget({ kind: "payment", receivable: item, payment })}
                        />
                      </td>
                    </tr>}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </DesktopTable>

          {items.map((item) => expanded?.id === item.id && (
            <div key={`payments-card-${item.id}`} className={styles.paymentMobile}>
              <PaymentsDetail
                expanded={expanded}
                canWrite={canWrite}
                canDelete={canDelete}
                mobile
                onPageChange={changePaymentPage}
                onEdit={(payment) => setPaymentTarget({ receivable: item, payment })}
                onDelete={(payment) => setDeleteTarget({ kind: "payment", receivable: item, payment })}
              />
            </div>
          ))}

          <Pagination
            page={page}
            size={PAGE_SIZE}
            total={data?.total ?? 0}
            loading={loading}
            ariaLabel="项目应收分页"
            onChange={(next) => setPage(next.page)}
          />
        </>
      )}

      {/* 详情弹层的每个动作先关掉自己再打开对应弹层：两层面板叠在一起会互抢滚动锁与 Esc */}
      <ProjectReceivableDetailDialog
        open={!!detail}
        projectId={projectId}
        receivable={detail}
        onClose={() => setDetail(null)}
        onEdit={canWrite ? (item) => { setDetail(null); setEditing(item); } : undefined}
        onAddPayment={canWrite ? (item) => { setDetail(null); setPaymentTarget({ receivable: item }); } : undefined}
        onEditPayment={canWrite
          ? (item, payment) => { setDetail(null); setPaymentTarget({ receivable: item, payment }); }
          : undefined}
        onDelete={canDelete
          ? (item) => { setDetail(null); setDeleteTarget({ kind: "receivable", receivable: item }); }
          : undefined}
      />
      <ProjectReceivableDialog
        open={editing !== undefined}
        receivable={editing}
        onClose={() => setEditing(undefined)}
        onSave={saveReceivable}
      />
      <ProjectReceivablePaymentDialog
        open={!!paymentTarget}
        payment={paymentTarget?.payment}
        onClose={() => setPaymentTarget(null)}
        onSave={savePayment}
      />
      <Confirm
        open={!!deleteTarget}
        danger
        loading={deleting}
        title={deleteTarget?.kind === "payment" ? "删除这笔回款？" : "删除这笔应收？"}
        text="记录将软删除并保留历史数据，不会物理清除。"
        okText="确认删除"
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleteTarget(null)}
      />
    </section>
  );
}

function PaymentsDetail({
  expanded,
  canWrite,
  canDelete,
  onEdit,
  onDelete,
  onPageChange,
  mobile = false,
}: {
  expanded: Exclude<Expanded, null>;
  canWrite: boolean;
  canDelete: boolean;
  onPageChange: (page: number) => void;
  onEdit: (payment: ProjectReceivablePayment) => void;
  onDelete: (payment: ProjectReceivablePayment) => void;
  mobile?: boolean;
}) {
  if (expanded.loading) return <LoadingBlock kpis={0} label="加载回款记录…" />;
  if (expanded.error) return <div className="err-banner" role="alert">{expanded.error}</div>;
  if (expanded.items.length === 0) return <Empty title="暂无回款" hint="登记回款后会在这里保留逐笔记录。" />;
  return (
    <>
      <div className={mobile ? undefined : styles.paymentMobile}>
        <CardList label="逐笔回款">
          {expanded.items.map((payment) => (
            <CardItem
              key={payment.id}
              title={`${money(payment.amount)} 元`}
              code={fmtDate(payment.payment_date)}
              fields={payment.note ? [{ label: "备注", value: payment.note }] : []}
              actions={<>
              {canWrite && <button type="button" className="btn-ghost btn-xs" onClick={() => onEdit(payment)}>更正回款</button>}
              {canDelete && <button type="button" className="btn-ghost btn-xs danger-link" aria-label="删除回款" onClick={() => onDelete(payment)}>删除</button>}
              </>}
            />
          ))}
        </CardList>
      </div>
      <DesktopTable>
        <table className="grid">
          <thead><tr><th>回款日期</th><th className="num">金额（元）</th><th>备注</th><th className="no-print">操作</th></tr></thead>
          <tbody>{expanded.items.map((payment) => <tr key={payment.id}>
            <td className="mono">{fmtDate(payment.payment_date)}</td>
            <td className="num mono">{money(payment.amount)}</td>
            <td>{payment.note || "-"}</td>
            <td className="no-print"><span className="table-actions">
              {canWrite && <button type="button" className="btn-ghost btn-xs" onClick={() => onEdit(payment)}>更正回款</button>}
              {canDelete && <button type="button" className="btn-ghost btn-xs danger-link" aria-label="删除回款" onClick={() => onDelete(payment)}>删除</button>}
            </span></td>
          </tr>)}</tbody>
        </table>
      </DesktopTable>
      {expanded.total > PAYMENT_PAGE_SIZE && (
        <Pagination
          page={expanded.page}
          size={PAYMENT_PAGE_SIZE}
          total={expanded.total}
          sizeOptions={[PAYMENT_PAGE_SIZE]}
          ariaLabel="项目回款分页"
          onChange={(next) => onPageChange(next.page)}
        />
      )}
    </>
  );
}
