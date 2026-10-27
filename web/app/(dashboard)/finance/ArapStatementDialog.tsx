"use client";

import { useEffect, useMemo, useState } from "react";
import { DatePicker } from "@/components/ui/DatePicker";
import { Dialog } from "@/components/ui/Modal";
import Select from "@/components/ui/Select";
import { financeApi, errText, type FinanceAccount, type FinanceARAPStatement, type FinanceAuxiliaryItem } from "@/lib/api";
import type { ArapDocumentKind } from "./ArapDialogs";
import fm from "./finance.module.css";

function localDate(): string {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

function cents(value: string): bigint {
  const raw = value.trim();
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(raw)) return BigInt(0);
  const negative = raw.startsWith("-");
  const [whole, fraction = ""] = (negative ? raw.slice(1) : raw).split(".");
  const amount = BigInt(whole) * BigInt(100) + BigInt((fraction + "00").slice(0, 2));
  return negative ? -amount : amount;
}

function money(value: string): string {
  const amount = cents(value);
  const negative = amount < BigInt(0);
  const absolute = negative ? -amount : amount;
  const whole = (absolute / BigInt(100)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const fraction = (absolute % BigInt(100)).toString().padStart(2, "0");
  return `${negative ? "−" : ""}${whole}.${fraction}`;
}

export default function ArapStatementDialog({
  open,
  kind,
  book,
  party,
  initialAccountId,
  accounts,
  defaultFromDate,
  onClose,
}: {
  open: boolean;
  kind: ArapDocumentKind;
  book: string;
  party: FinanceAuxiliaryItem | null;
  initialAccountId: number;
  accounts: FinanceAccount[];
  defaultFromDate: string;
  onClose: () => void;
}) {
  const [accountId, setAccountId] = useState(String(initialAccountId));
  const [fromDate, setFromDate] = useState(defaultFromDate);
  const [toDate, setToDate] = useState(localDate());
  const [query, setQuery] = useState<{
    accountId: number | null;
    fromDate: string;
    toDate: string;
    page: number;
  } | null>(null);
  const [statement, setStatement] = useState<FinanceARAPStatement | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const isReceivable = kind === "receivable";
  const partyLabel = isReceivable ? "客户" : "供应商";
  const accountsForKind = useMemo(() => accounts.filter((account) =>
    account.is_active && account.is_leaf && account.aux_flags?.[isReceivable ? "customer" : "vendor"] &&
    Object.entries(account.aux_flags ?? {}).every(([flag, enabled]) => !enabled || flag === (isReceivable ? "customer" : "vendor")),
  ), [accounts, isReceivable]);
  const invalidRange = !fromDate || !toDate || fromDate > toDate;

  useEffect(() => {
    if (!open || !query || !party) return;
    const controller = new AbortController();
    setStatement(null);
    setLoading(true);
    setError("");
    financeApi.arapStatement(book, kind, {
      party_id: party.id,
      account_id: query.accountId,
      from_date: query.fromDate,
      to_date: query.toDate,
      page: query.page,
      page_size: 50,
    }, controller.signal)
      .then(setStatement)
      .catch((cause) => {
        if (!controller.signal.aborted) setError(errText(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [book, kind, open, party, query]);

  function runQuery() {
    if (invalidRange) return;
    setError("");
    setStatement(null);
    setQuery({
      accountId: accountId ? Number(accountId) : null,
      fromDate,
      toDate,
      page: 1,
    });
  }

  function changeAccount(value: string) {
    setAccountId(value);
    setQuery(null);
    setStatement(null);
    setLoading(false);
    setError("");
  }

  function changeDate(setter: (value: string) => void, value: string) {
    setter(value);
    setQuery(null);
    setStatement(null);
    setLoading(false);
    setError("");
  }

  function changePage(offset: number) {
    setStatement(null);
    setQuery((current) => current ? { ...current, page: current.page + offset } : current);
  }

  const pageCount = statement ? Math.max(1, Math.ceil(statement.total_lines / statement.page_size)) : 1;
  const partyName = party?.name ?? `${partyLabel} #${party?.id ?? "未知"}`;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`${partyName} · ${isReceivable ? "客户" : "供应商"}对账单`}
      size="lg"
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>关闭</button>
          <button className="btn-primary" disabled={loading || invalidRange || !party} onClick={runQuery}>
            {loading ? "查询中…" : "查询对账单"}
          </button>
        </>
      }
    >
      <div className="form-grid">
        <label className="field span-2">
          <span className="field-label">往来科目</span>
          <Select value={accountId} onChange={changeAccount}>
            <option value="">全部往来科目</option>
            {accountsForKind.map((account) => (
              <option key={account.id} value={account.id}>{account.code} · {account.name}</option>
            ))}
          </Select>
        </label>
        <label className="field">
          <span className="field-label">开始日期</span>
          <DatePicker value={fromDate} onChange={(v) => changeDate(setFromDate, v)} ariaLabel="开始日期" />
        </label>
        <label className="field">
          <span className="field-label">结束日期</span>
          <DatePicker value={toDate} onChange={(v) => changeDate(setToDate, v)} ariaLabel="结束日期" />
        </label>
      </div>

      {error && <div className="field-err" role="alert">{error}</div>}
      {invalidRange && <div className="field-err" role="alert">开始日期不能晚于结束日期。</div>}
      <p className="tiny muted">本对账单只包括本工作台登记并已过账的往来单据与收付款核销，暂不含普通手工、模板、导入凭证及期初辅助余额。按凭证日期列示，用于往来核对，不是纳税申报表。</p>
      {loading && <p className="tiny muted" role="status">正在查询对账单…</p>}

      {statement && !loading && (
        <>
          <div className="kpi-row">
            <div className="kpi"><div className="k">期初余额</div><div className="v">{money(statement.opening_balance)}</div></div>
            <div className="kpi"><div className="k">本期增加</div><div className="v">{money(statement.period_increase)}</div></div>
            <div className="kpi"><div className="k">本期减少</div><div className="v">{money(statement.period_decrease)}</div></div>
            <div className="kpi"><div className="k">期末余额</div><div className="v">{money(statement.closing_balance)}</div></div>
          </div>
          {!statement.items.length ? (
            <div className="card"><p className="tiny muted">所选日期范围内没有已过账往来流水。</p></div>
          ) : (
            <div className="table-scroll">
              <table className={`grid ${fm.scrollTable} ${fm.arapStatementTable}`}>
                <thead><tr><th>日期</th><th>凭证号</th><th>业务</th><th>摘要</th><th>方向</th><th className="num">金额</th><th className="num">余额</th><th>状态</th></tr></thead>
                <tbody>
                  {statement.items.map((item, index) => (
                    <tr key={`${item.voucher_id}-${item.transaction_id}-${index}`}>
                      <td>{item.transaction_date}</td>
                      <td className="mono">{item.voucher_no}</td>
                      <td>{item.event_type}</td>
                      <td>{item.summary || "-"}</td>
                      <td>{item.direction === "increase" ? "增加" : "减少"}</td>
                      <td className="num">{money(item.amount)}</td>
                      <td className="num"><b>{money(item.balance_after)}</b></td>
                      <td><span className="badge done">已过账</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="row-actions" style={{ justifyContent: "space-between", marginTop: 12 }}>
            <span className="tiny muted">共 {statement.total_lines} 笔 · 第 {statement.page} / {pageCount} 页</span>
            <div className="row-actions">
              <button className="btn-xs btn-ghost" disabled={loading || statement.page <= 1} onClick={() => changePage(-1)}>上一页</button>
              <button className="btn-xs btn-ghost" disabled={loading || statement.page >= pageCount} onClick={() => changePage(1)}>下一页</button>
            </div>
          </div>
        </>
      )}
    </Dialog>
  );
}
