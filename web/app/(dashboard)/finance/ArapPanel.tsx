"use client";

import { useMemo, useState } from "react";
import Empty from "@/components/ui/Empty";
import { LoadFailed, LoadingBlock } from "@/components/ui/PageState";
import { useToast } from "@/components/ui/Toast";
import { useAsyncData } from "@/lib/useAsyncData";
import {
  financeApi,
  type FinanceAccount,
  type FinanceARAPItem,
  type FinanceAuxiliaryItem,
  type FinanceAuxiliaryKind,
  type FinancePeriod,
} from "@/lib/api";
import {
  ArapAuxiliaryDialog,
  ArapDocumentDialog,
  ArapSettlementDialog,
  type ArapDocumentKind,
} from "./ArapDialogs";

type ArapView = "receivable" | "payable";
type DialogState =
  | { type: "document"; kind: ArapDocumentKind }
  | { type: "settlement"; kind: ArapDocumentKind; partyId: number; accountId: number }
  | { type: "auxiliary"; kind: FinanceAuxiliaryKind }
  | null;

function cents(value: string | number): bigint {
  const raw = String(value ?? "0").trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) return BigInt(0);
  const [whole, fraction = ""] = raw.split(".");
  return BigInt(whole) * BigInt(100) + BigInt((fraction + "00").slice(0, 2));
}

function formatCents(value: bigint): string {
  const whole = (value / BigInt(100)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const fraction = (value % BigInt(100)).toString().padStart(2, "0");
  return `${whole}.${fraction}`;
}

function today(): string {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

function total(items: FinanceARAPItem[], field: "amount" | "applied_amount" | "outstanding"): bigint {
  return items.reduce((sum, item) => sum + cents(item[field]), BigInt(0));
}

export default function ArapPanel({
  book,
  period,
  accounts,
  accountsLoading,
  accountsError,
  reloadAccounts,
  isAdmin,
}: {
  book: string;
  period: FinancePeriod | null;
  accounts: FinanceAccount[];
  accountsLoading: boolean;
  accountsError: string;
  reloadAccounts: () => void;
  isAdmin: boolean;
}) {
  const toast = useToast();
  const [view, setView] = useState<ArapView>("receivable");
  const [search, setSearch] = useState("");
  const [asOf, setAsOf] = useState(today());
  const [auxiliaryKind, setAuxiliaryKind] = useState<FinanceAuxiliaryKind>("customer");
  const [dialog, setDialog] = useState<DialogState>(null);

  const receivables = useAsyncData(
    (signal) => financeApi.receivables(book, signal),
    [book],
    { enabled: !!book, resetOnDepChange: true },
  );
  const payables = useAsyncData(
    (signal) => financeApi.payables(book, signal),
    [book],
    { enabled: !!book, resetOnDepChange: true },
  );
  const auxiliaries = useAsyncData(async (signal) => {
    const [customers, vendors, cashflows] = await Promise.all([
      financeApi.auxiliaryItems(book, "customer", signal),
      financeApi.auxiliaryItems(book, "vendor", signal),
      financeApi.auxiliaryItems(book, "cashflow", signal),
    ]);
    return {
      customers: customers.filter((item) => item.is_active !== false),
      vendors: vendors.filter((item) => item.is_active !== false),
      cashflows: cashflows.filter((item) => item.is_active !== false),
    };
  }, [book], { enabled: !!book, resetOnDepChange: true });
  const aging = useAsyncData(
    (signal) => financeApi.payableAging(book, asOf, signal),
    [book, asOf],
    { enabled: !!book && view === "payable", resetOnDepChange: true },
  );

  const itemList = useMemo(
    () => view === "receivable"
      ? receivables.data?.items ?? []
      : payables.data?.items ?? [],
    [view, receivables.data?.items, payables.data?.items],
  );
  const counterparties = useMemo(() => {
    const customers = auxiliaries.data?.customers;
    const vendors = auxiliaries.data?.vendors;
    return view === "receivable" ? customers ?? [] : vendors ?? [];
  }, [view, auxiliaries.data?.customers, auxiliaries.data?.vendors]);
  const partyById = useMemo(() => {
    return new Map(counterparties.map((item) => [item.id, item]));
  }, [counterparties]);
  const accountById = useMemo(
    () => new Map(accounts.map((account) => [account.id, account])),
    [accounts],
  );
  const filteredItems = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    if (!query) return itemList;
    return itemList.filter((item) => {
      const party = partyById.get(item.party_id);
      const account = accountById.get(item.account_id);
      return [party?.name, party?.code, account?.name, account?.code, item.summary, item.transaction_date, String(item.party_id), String(item.account_id)]
        .some((value) => value?.toLocaleLowerCase().includes(query));
    });
  }, [accountById, itemList, partyById, search]);

  const reload = () => {
    receivables.reload();
    payables.reload();
    auxiliaries.reload();
    aging.reload();
    reloadAccounts();
  };
  const currentError =
    accountsError ||
    receivables.error ||
    payables.error ||
    auxiliaries.error ||
    (view === "payable" ? aging.error : "");
  if (currentError) return <LoadFailed message={currentError} onRetry={reload} />;

  const firstLoad =
    accountsLoading ||
    receivables.firstLoad ||
    payables.firstLoad ||
    auxiliaries.firstLoad ||
    (view === "payable" && aging.firstLoad);
  if (firstLoad) return <LoadingBlock kpis={3} label="加载应收应付…" />;

  const currentItems = itemList;
  const canWrite = period?.status === "open";
  const cashAccounts = accounts.filter((account) =>
    account.is_active && account.is_leaf && /^(1001|1002|1012)/.test(account.code) &&
    Object.entries(account.aux_flags ?? {}).every(([flag, enabled]) => !enabled || flag === "cashflow"),
  );
  const cashflowItems = auxiliaries.data?.cashflows ?? [];
  const paymentSetupReady = cashAccounts.some(
    (account) => !account.aux_flags?.cashflow || cashflowItems.length > 0,
  );
  const outstandingFor = (partyId: number, accountId: number) =>
    formatCents(currentItems
      .filter((item) => item.party_id === partyId && item.account_id === accountId)
      .reduce((sum, item) => sum + cents(item.outstanding), BigInt(0)));
  const visibleTotal = formatCents(total(currentItems, "amount"));
  const visibleApplied = formatCents(total(currentItems, "applied_amount"));
  const visibleOutstanding = formatCents(total(currentItems, "outstanding"));
  const viewLabel = view === "receivable" ? "应收" : "应付";
  const documentKind: ArapDocumentKind = view;
  const createTitle = view === "receivable" ? "新建应收" : "新建应付";
  const missingPartyData = counterparties.length === 0;

  function openSettlement(item: FinanceARAPItem) {
    if (item.outstanding === "0" || cents(item.outstanding) <= BigInt(0)) return;
    setDialog({ type: "settlement", kind: documentKind, partyId: item.party_id, accountId: item.account_id });
  }

  function onDocumentSaved(result: { voucher: { voucher_no: string } }) {
    setDialog(null);
    toast.ok(`${viewLabel}已登记，草稿凭证 ${result.voucher.voucher_no} 待审核。`);
    receivables.reload();
    payables.reload();
  }

  function onSettlementSaved(result: { voucher: { voucher_no: string } }) {
    setDialog(null);
    toast.ok(`已生成草稿凭证 ${result.voucher.voucher_no}；核销额度已占用，请继续审核和过账。`);
    receivables.reload();
    payables.reload();
    aging.reload();
  }

  function onAuxiliarySaved() {
    setDialog(null);
    auxiliaries.reload();
    toast.ok("辅助资料已保存");
  }

  const dialogParty = dialog?.type === "settlement" ? partyById.get(dialog.partyId) ?? null : null;
  const dialogKind = dialog?.type === "settlement" ? dialog.kind : "receivable";

  return (
    <>
      <div className="section-head">
        <div>
          <h2>往来台账</h2>
          <p>按当前账套查看所有期间的应收应付；收付款由后端按主体、往来科目和单据日期 FIFO 核销。</p>
        </div>
        <div className="row-actions">
          <button className="btn-ghost" onClick={reload}>刷新</button>
          {isAdmin && (
            <>
              <label className="toolbar-field">
                <span>辅助资料</span>
                <select value={auxiliaryKind} onChange={(event) => setAuxiliaryKind(event.target.value as FinanceAuxiliaryKind)}>
                  <option value="customer">客户</option>
                  <option value="vendor">供应商</option>
                  <option value="cashflow">现金流项目</option>
                </select>
              </label>
              <button className="btn-ghost" onClick={() => setDialog({ type: "auxiliary", kind: auxiliaryKind })}>新增资料</button>
            </>
          )}
          <button
            className="btn-primary"
            disabled={!canWrite || missingPartyData}
            title={!canWrite ? "需要开放会计期间" : missingPartyData ? `请先维护${view === "receivable" ? "客户" : "供应商"}辅助资料` : undefined}
            onClick={() => setDialog({ type: "document", kind: documentKind })}
          >
            + {createTitle}
          </button>
        </div>
      </div>

      <div className="tabs detail-tabs" role="tablist" aria-label="应收应付台账">
        <button role="tab" aria-selected={view === "receivable"} className={view === "receivable" ? "active" : ""} onClick={() => setView("receivable")}>应收台账</button>
        <button role="tab" aria-selected={view === "payable"} className={view === "payable" ? "active" : ""} onClick={() => setView("payable")}>应付台账</button>
      </div>

      {!canWrite && (
        <div className="card" role="status">
          <div className="status-row"><span className="badge warn">只读</span><span>当前账套没有开放期间；可以查看台账，但不能新增往来单据或登记收付款。</span></div>
        </div>
      )}

      {isAdmin && (!counterparties.length || !cashflowItems.length) && (
        <div className="card" role="status">
          <div className="status-row">
            <span className="badge doing">需要设置</span>
            <span>
              {!counterparties.length
                ? `当前账套没有有效${view === "receivable" ? "客户" : "供应商"}资料，请在右上方新增辅助资料。`
                : "当前账套还没有现金流项目，银行收付款需要现金流核算时请先由管理员维护。"}
            </span>
          </div>
        </div>
      )}

      <div className="kpi-row">
        <div className="kpi"><div className="k">{viewLabel}单据</div><div className="v">{currentItems.length}</div><div className="kpi-foot">当前账套全部期间</div></div>
        <div className="kpi"><div className="k">累计金额</div><div className="v">{visibleTotal}</div><div className="kpi-foot">{viewLabel}原始单据</div></div>
        <div className="kpi"><div className="k">可核销余额</div><div className="v">{visibleOutstanding}</div><div className="kpi-foot">已分配 {visibleApplied} 元</div></div>
      </div>

      {view === "payable" && (
        <section className="card" aria-label="应付账龄">
          <div className="section-head">
            <div><h2>应付账龄</h2><p>按截止日期统计当前账套所有未核销应付。</p></div>
            <label className="toolbar-field">
              <span>截止日期</span>
              <input type="date" value={asOf} onChange={(event) => { if (event.target.value) setAsOf(event.target.value); }} />
            </label>
          </div>
          {aging.loading ? <LoadingBlock title={false} kpis={4} label="计算应付账龄…" /> : aging.data && (
            <div className="kpi-row">
              <div className="kpi"><div className="k">未核销总额</div><div className="v">{formatCents(cents(aging.data.total_outstanding))}</div><div className="kpi-foot">截止 {aging.data.as_of}</div></div>
              <div className="kpi"><div className="k">0–30 天</div><div className="v">{formatCents(cents(aging.data.buckets["0_30"]))}</div></div>
              <div className="kpi"><div className="k">31–60 天</div><div className="v">{formatCents(cents(aging.data.buckets["31_60"]))}</div></div>
              <div className="kpi"><div className="k">61–90 天</div><div className="v">{formatCents(cents(aging.data.buckets["61_90"]))}</div></div>
              <div className="kpi"><div className="k">90 天以上</div><div className="v">{formatCents(cents(aging.data.buckets["90_plus"]))}</div></div>
            </div>
          )}
        </section>
      )}

      <div className="section-head">
        <div>
          <h2>{viewLabel}明细</h2>
          <p>主体与科目余额汇总自每笔单据；收付款登记后按相同主体和科目 FIFO 占用可核销余额。</p>
        </div>
        <label className="toolbar-field">
          <span>搜索主体、科目或摘要</span>
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="输入主体或科目名称、编码，或摘要" />
        </label>
      </div>

      {!filteredItems.length ? (
        <div className="card">
          <Empty
            title={currentItems.length ? "没有匹配记录" : `当前账套还没有${viewLabel}单据`}
            hint={currentItems.length ? "试试其他主体名称、编码或摘要。" : `选择“新建${viewLabel}”登记第一笔往来单据。`}
          />
        </div>
      ) : (
        <div className="table-scroll">
          <table className="grid">
            <thead>
              <tr>
                <th>{view === "receivable" ? "客户" : "供应商"}</th>
                <th>往来科目</th>
                <th>日期</th>
                <th>摘要</th>
                <th className="num">单据金额</th>
                <th className="num">已分配</th>
                <th className="num">可核销余额</th>
                <th>关联凭证</th>
                <th className="no-print">操作</th>
              </tr>
            </thead>
            <tbody>
              {filteredItems.map((item) => {
                const party = partyById.get(item.party_id);
                const account = accountById.get(item.account_id);
                const canSettle = Boolean(party && account && cents(outstandingFor(item.party_id, item.account_id)) > BigInt(0) && canWrite && paymentSetupReady);
                return (
                  <tr key={item.id}>
                    <td>{party ? <><span>{party.name}</span><span className="tiny muted"> · {party.code}</span></> : <span className="muted">未知主体 #{item.party_id}</span>}</td>
                    <td>{account ? <><span>{account.name}</span><span className="tiny muted"> · {account.code}</span></> : <span className="muted">科目 #{item.account_id}</span>}</td>
                    <td>{item.transaction_date}</td>
                    <td>{item.summary || "-"}</td>
                    <td className="num">{formatCents(cents(item.amount))}</td>
                    <td className="num">{formatCents(cents(item.applied_amount))}</td>
                    <td className="num"><b>{formatCents(cents(item.outstanding))}</b></td>
                    <td>{item.voucher_no ? <span className="mono">{item.voucher_no}</span> : item.voucher_id ? <span className="mono">凭证 #{item.voucher_id}</span> : "-"}</td>
                    <td className="no-print">
                      {cents(item.outstanding) > BigInt(0) && (
                        <button
                          className="btn-xs btn-ghost"
                          disabled={!canSettle}
                          title={!canWrite ? "需要开放会计期间" : !paymentSetupReady ? "需要维护现金/银行科目和现金流项目" : !party ? "缺少有效往来主体资料" : !account ? "缺少有效往来科目资料" : undefined}
                          onClick={() => openSettlement(item)}
                        >
                          {view === "receivable" ? "登记收款" : "登记付款"}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {missingPartyData && !isAdmin && (
        <p className="tiny muted">此账套暂无有效{view === "receivable" ? "客户" : "供应商"}辅助资料，请联系系统管理员维护。</p>
      )}
      {cashAccounts.length > 0 && !paymentSetupReady && (
        <p className="tiny muted">此账套缺少现金流项目，无法使用当前需要现金流辅助核算的现金/银行科目登记收付款。</p>
      )}

      {dialog?.type === "document" && (
        <ArapDocumentDialog
          key={`document-${dialog.kind}`}
          open
          kind={dialog.kind}
          book={book}
          period={period}
          customers={auxiliaries.data?.customers ?? []}
          vendors={auxiliaries.data?.vendors ?? []}
          accounts={accounts}
          onClose={() => setDialog(null)}
          onSaved={onDocumentSaved}
        />
      )}
      {dialog?.type === "settlement" && (
        <ArapSettlementDialog
          key={`settlement-${dialog.kind}-${dialog.partyId}-${dialog.accountId}`}
          open
          kind={dialogKind}
          book={book}
          period={period}
          party={dialogParty}
          account={accountById.get(dialog.accountId) ?? null}
          outstanding={dialogParty ? outstandingFor(dialog.partyId, dialog.accountId) : "0.00"}
          accounts={accounts}
          cashflows={cashflowItems}
          onClose={() => setDialog(null)}
          onSaved={onSettlementSaved}
        />
      )}
      {dialog?.type === "auxiliary" && (
        <ArapAuxiliaryDialog
          key={`auxiliary-${dialog.kind}`}
          open
          kind={dialog.kind}
          book={book}
          onClose={() => setDialog(null)}
          onSaved={onAuxiliarySaved}
        />
      )}
    </>
  );
}
