"use client";

import { useEffect, useMemo, useState } from "react";
import { Dialog } from "@/components/ui/Modal";
import {
  errText,
  financeApi,
  type FinanceAccount,
  type FinanceARAPDocumentResult,
  type FinanceARAPItem,
  type FinanceARAPPaymentResult,
  type FinanceARAPPaymentInput,
  type FinanceAuxiliaryItem,
  type FinanceAuxiliaryKind,
  type FinancePeriod,
} from "@/lib/api";

export type ArapDocumentKind = "receivable" | "payable";

function localDate(): string {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

function defaultDate(period: FinancePeriod | null): string {
  const today = localDate();
  return period && today >= period.start_date && today <= period.end_date
    ? today
    : period?.start_date ?? today;
}

function defaultDateFromRange(startDate?: string, endDate?: string): string {
  const today = localDate();
  return startDate && endDate && today >= startDate && today <= endDate
    ? today
    : startDate ?? today;
}

function toCents(value: string): bigint | null {
  const trimmed = value.trim();
  if (!/^\d{1,16}(?:\.\d{1,2})?$/.test(trimmed)) return null;
  const [whole, fraction = ""] = trimmed.split(".");
  return BigInt(whole) * BigInt(100) + BigInt((fraction + "00").slice(0, 2));
}

function money(value: string | number): string {
  return Number(value || 0).toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatCents(value: bigint): string {
  const absolute = value < BigInt(0) ? -value : value;
  const whole = (absolute / BigInt(100)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${value < BigInt(0) ? "-" : ""}${whole}.${(absolute % BigInt(100)).toString().padStart(2, "0")}`;
}

function apiAmount(value: bigint): string {
  return `${value / BigInt(100)}.${(value % BigInt(100)).toString().padStart(2, "0")}`;
}

function accountLabel(account: FinanceAccount): string {
  return `${account.code} · ${account.name}`;
}

export function ArapDocumentDialog({
  open,
  kind,
  book,
  period,
  customers,
  vendors,
  accounts,
  onClose,
  onSaved,
}: {
  open: boolean;
  kind: ArapDocumentKind;
  book: string;
  period: FinancePeriod | null;
  customers: FinanceAuxiliaryItem[];
  vendors: FinanceAuxiliaryItem[];
  accounts: FinanceAccount[];
  onClose: () => void;
  onSaved: (result: FinanceARAPDocumentResult) => void;
}) {
  const [partyId, setPartyId] = useState("");
  const [accountId, setAccountId] = useState("");
  const [offsetAccountId, setOffsetAccountId] = useState("");
  const [date, setDate] = useState(defaultDate(period));
  const [amount, setAmount] = useState("");
  const [summary, setSummary] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const isReceivable = kind === "receivable";
  const partyKind = isReceivable ? "customer" : "vendor";
  const parties = isReceivable ? customers : vendors;
  const requiredFlag = partyKind;
  const partyAccounts = useMemo(
    () => accounts.filter((account) =>
      account.is_active && account.is_leaf && account.aux_flags?.[requiredFlag] &&
      Object.entries(account.aux_flags ?? {}).every(([flag, enabled]) => !enabled || flag === requiredFlag),
    ),
    [accounts, requiredFlag],
  );
  const offsetAccounts = useMemo(
    () => accounts.filter((account) => {
      const isIncome = account.direction === "C" && account.category === "损益";
      const isExpense = account.direction === "D" && (account.category === "损益" || account.category === "成本");
      const hasAuxiliaryRequirement = Object.values(account.aux_flags ?? {}).some(Boolean);
      return account.is_active && account.is_leaf && !hasAuxiliaryRequirement && (isReceivable ? isIncome : isExpense);
    }),
    [accounts, isReceivable],
  );

  useEffect(() => {
    if (!open) return;
    setPartyId("");
    setAccountId("");
    setOffsetAccountId("");
    setDate(defaultDateFromRange(period?.start_date, period?.end_date));
    setAmount("");
    setSummary("");
    setError("");
  }, [open, book, period?.id, period?.start_date, period?.end_date]);

  async function save() {
    const cents = toCents(amount);
    if (!period || period.status !== "open") {
      setError("当前没有开放期间，暂时不能登记往来单据。");
      return;
    }
    if (!date || date < period.start_date || date > period.end_date) {
      setError("交易日期必须在当前开放期间内。");
      return;
    }
    if (!partyId || !accountId || !offsetAccountId) {
      setError("请选择往来主体和两项会计科目。");
      return;
    }
    if (cents === null || cents <= BigInt(0)) {
      setError("金额须为大于零且最多保留两位小数的数字。");
      return;
    }

    const base = {
      period_id: period.id,
      transaction_date: date,
      amount: amount.trim(),
      summary: summary.trim(),
    };
    setSaving(true);
    setError("");
    try {
      const result = isReceivable
        ? await financeApi.createReceivable(book, {
            ...base,
            customer_id: Number(partyId),
            receivable_account_id: Number(accountId),
            revenue_account_id: Number(offsetAccountId),
          })
        : await financeApi.createPayable(book, {
            ...base,
            vendor_id: Number(partyId),
            payable_account_id: Number(accountId),
            expense_account_id: Number(offsetAccountId),
          });
      onSaved(result);
    } catch (cause) {
      setError(errText(cause));
    } finally {
      setSaving(false);
    }
  }

  const partyLabel = isReceivable ? "客户" : "供应商";
  const title = isReceivable ? "登记应收" : "登记应付";

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      size="md"
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>取消</button>
          <button className="btn-primary" disabled={saving || period?.status !== "open"} onClick={save}>
            {saving ? "保存中…" : "保存并生成草稿凭证"}
          </button>
        </>
      }
    >
      <div className="form-grid">
        <label className="field span-2">
          <span className="field-label">{partyLabel}</span>
          <select value={partyId} onChange={(event) => setPartyId(event.target.value)}>
            <option value="">请选择{partyLabel}</option>
            {parties.map((party) => <option key={party.id} value={party.id}>{party.code} · {party.name}</option>)}
          </select>
        </label>
        <label className="field">
          <span className="field-label">{isReceivable ? "应收科目" : "应付科目"}</span>
          <select value={accountId} onChange={(event) => setAccountId(event.target.value)}>
            <option value="">请选择</option>
            {partyAccounts.map((account) => <option key={account.id} value={account.id}>{accountLabel(account)}</option>)}
          </select>
        </label>
        <label className="field">
          <span className="field-label">{isReceivable ? "收入科目" : "费用科目"}</span>
          <select value={offsetAccountId} onChange={(event) => setOffsetAccountId(event.target.value)}>
            <option value="">请选择</option>
            {offsetAccounts.map((account) => <option key={account.id} value={account.id}>{accountLabel(account)}</option>)}
          </select>
        </label>
        <label className="field">
          <span className="field-label">交易日期</span>
          <input
            type="date"
            min={period?.start_date}
            max={period?.end_date}
            value={date}
            onChange={(event) => setDate(event.target.value)}
          />
        </label>
        <label className="field">
          <span className="field-label">金额</span>
          <input inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="0.00" />
        </label>
        <label className="field span-2">
          <span className="field-label">摘要</span>
          <input value={summary} onChange={(event) => setSummary(event.target.value)} placeholder={isReceivable ? "例如：项目阶段款" : "例如：采购货款"} />
        </label>
      </div>
      {error && <div className="field-err" role="alert">{error}</div>}
      {!parties.length && <p className="tiny muted">当前账套还没有有效{partyLabel}资料，请由系统管理员先维护辅助资料。</p>}
      {(!partyAccounts.length || !offsetAccounts.length) && <p className="tiny muted">缺少可用的科目，请检查基础设置中的启用末级科目与辅助核算标记。</p>}
      <p className="tiny muted">保存后会生成草稿凭证，仍需按凭证审核流程提交和过账。</p>
    </Dialog>
  );
}

export function ArapSettlementDialog({
  open,
  kind,
  book,
  period,
  party,
  account,
  outstanding,
  documents,
  accounts,
  cashflows,
  onClose,
  onSaved,
}: {
  open: boolean;
  kind: ArapDocumentKind;
  book: string;
  period: FinancePeriod | null;
  party: FinanceAuxiliaryItem | null;
  account: FinanceAccount | null;
  outstanding: string;
  documents: FinanceARAPItem[];
  accounts: FinanceAccount[];
  cashflows: FinanceAuxiliaryItem[];
  onClose: () => void;
  onSaved: (result: FinanceARAPPaymentResult) => void;
}) {
  const [cashAccountId, setCashAccountId] = useState("");
  const [cashflowCode, setCashflowCode] = useState("");
  const [date, setDate] = useState(defaultDate(period));
  const [amount, setAmount] = useState("");
  const [summary, setSummary] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [allocationMode, setAllocationMode] = useState<"fifo" | "manual">("fifo");
  const [allocationAmounts, setAllocationAmounts] = useState<Record<number, string>>({});
  const isReceipt = kind === "receivable";
  const cashAccounts = useMemo(
    () => accounts.filter((account) =>
      account.is_active && account.is_leaf && /^(1001|1002|1012)/.test(account.code) &&
      Object.entries(account.aux_flags ?? {}).every(([flag, enabled]) => !enabled || flag === "cashflow"),
    ),
    [accounts],
  );
  const selectedCashAccount = cashAccounts.find((account) => String(account.id) === cashAccountId) ?? null;
  const requiresCashflow = Boolean(selectedCashAccount?.aux_flags?.cashflow);
  const availableCents = toCents(outstanding) ?? BigInt(0);
  const enteredCents = toCents(amount);
  const eligibleDocuments = useMemo(() => documents.filter((item) =>
    item.party_id === party?.id && item.account_id === account?.id &&
    item.voucher_status === "posted" && !item.is_reversing && !item.is_reversed &&
    item.voucher_date !== null && item.voucher_date <= date && (toCents(item.outstanding) ?? BigInt(0)) > BigInt(0),
  ).sort((a, b) => (a.voucher_date ?? "").localeCompare(b.voucher_date ?? "") || a.id - b.id), [documents, party?.id, account?.id, date]);
  const allocationTotal = eligibleDocuments.reduce(
    (sum, item) => sum + (toCents(allocationAmounts[item.id] ?? "") ?? BigInt(0)), BigInt(0),
  );
  const invalidAllocation = eligibleDocuments.find((item) => {
    const raw = allocationAmounts[item.id] ?? "";
    if (!raw.trim()) return false;
    const value = toCents(raw);
    return value === null || value > (toCents(item.outstanding) ?? BigInt(0));
  });
  const manualReason = allocationMode === "manual"
    ? availableCents <= BigInt(0) ? "没有剩余可核销额度。"
      : !eligibleDocuments.length ? "没有可核销单据，请调整交易日期或核对已过账单据。"
        : enteredCents === null || enteredCents <= BigInt(0) ? `请先填写${isReceipt ? "收款" : "付款"}金额。`
          : invalidAllocation ? `单据 ${invalidAllocation.voucher_no ?? invalidAllocation.id} 的本次核销额无效或超过可核销余额。`
            : allocationTotal !== enteredCents ? `核销合计必须等于${isReceipt ? "收款" : "付款"}金额。` : null
    : null;

  useEffect(() => {
    if (!open) return;
    setCashAccountId("");
    setCashflowCode("");
    setDate(defaultDateFromRange(period?.start_date, period?.end_date));
    setAmount("");
    setSummary("");
    setError("");
    setAllocationMode("fifo");
    setAllocationAmounts({});
  }, [open, book, period?.id, period?.start_date, period?.end_date, party?.id]);

  async function save() {
    if (!period || period.status !== "open") {
      setError("当前没有开放期间，暂时不能登记收付款。");
      return;
    }
    if (!party) {
      setError("往来主体资料不可用，请刷新页面后重试。");
      return;
    }
    if (!account) {
      setError("往来科目资料不可用，请刷新页面后重试。");
      return;
    }
    if (!date || date < period.start_date || date > period.end_date) {
      setError("交易日期必须在当前开放期间内。");
      return;
    }
    if (!cashAccountId) {
      setError("请选择现金或银行科目。");
      return;
    }
    if (requiresCashflow && !cashflowCode) {
      setError("所选现金科目要求填写现金流项目。");
      return;
    }
    if (enteredCents === null || enteredCents <= BigInt(0)) {
      setError("金额须为大于零且最多保留两位小数的数字。");
      return;
    }
    if (enteredCents > availableCents) {
      setError(`金额不能超过此主体的可核销余额 ${money(outstanding)} 元。`);
      return;
    }
    if (manualReason) {
      setError(manualReason);
      return;
    }

    const base: FinanceARAPPaymentInput = {
      period_id: period.id,
      transaction_date: date,
      amount: apiAmount(enteredCents),
      cash_account_id: Number(cashAccountId),
      account_id: account.id,
      cashflow_item: cashflowCode || undefined,
      summary: summary.trim(),
      ...(allocationMode === "manual" ? {
        allocations: eligibleDocuments.flatMap((item) => {
          const value = toCents(allocationAmounts[item.id] ?? "");
          return value !== null && value > BigInt(0)
            ? [{ target_id: item.id, amount: apiAmount(value) }]
            : [];
        }),
      } : {}),
    };
    setSaving(true);
    setError("");
    try {
      const result = isReceipt
        ? await financeApi.collectReceivable(book, { ...base, customer_id: party.id })
        : await financeApi.payPayable(book, { ...base, vendor_id: party.id });
      onSaved(result);
    } catch (cause) {
      setError(errText(cause));
    } finally {
      setSaving(false);
    }
  }

  const label = isReceipt ? "登记收款" : "登记付款";
  const partyLabel = isReceipt ? "客户" : "供应商";

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`${label}${party ? ` · ${party.name}` : ""}`}
      size="md"
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>取消</button>
          <button className="btn-primary" disabled={saving || period?.status !== "open" || !party || !account || availableCents <= BigInt(0) || Boolean(manualReason)} onClick={save}>
            {saving ? "提交中…" : label}
          </button>
        </>
      }
    >
      <div className="status-row">
        <b>{partyLabel}</b>
        <span>{party?.code} · {party?.name}</span>
        <span>往来科目 {account ? accountLabel(account) : "资料不可用"}</span>
        <span>可核销余额 {money(outstanding)} 元</span>
      </div>
      <div className="form-grid" style={{ marginTop: 16 }}>
        <label className="field">
          <span className="field-label">交易日期</span>
          <input
            type="date"
            min={period?.start_date}
            max={period?.end_date}
            value={date}
            onChange={(event) => { setDate(event.target.value); setAllocationAmounts({}); }}
          />
        </label>
        <label className="field">
          <span className="field-label">金额</span>
          <input inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="0.00" />
        </label>
        <label className="field span-2">
          <span className="field-label">现金/银行科目</span>
          <select value={cashAccountId} onChange={(event) => { setCashAccountId(event.target.value); setCashflowCode(""); }}>
            <option value="">请选择</option>
            {cashAccounts.map((account) => <option key={account.id} value={account.id}>{accountLabel(account)}</option>)}
          </select>
        </label>
        {requiresCashflow && (
          <label className="field span-2">
            <span className="field-label">现金流项目</span>
            <select value={cashflowCode} onChange={(event) => setCashflowCode(event.target.value)}>
              <option value="">请选择</option>
              {cashflows.map((item) => <option key={item.id} value={item.code}>{item.code} · {item.name}</option>)}
            </select>
          </label>
        )}
        <label className="field span-2">
          <span className="field-label">摘要</span>
          <input value={summary} onChange={(event) => setSummary(event.target.value)} placeholder={isReceipt ? "例如：收到阶段款" : "例如：支付采购款"} />
        </label>
      </div>
      <fieldset style={{ marginTop: 16 }}>
        <legend className="field-label">核销方式</legend>
        <label><input type="radio" name="allocation-mode" checked={allocationMode === "fifo"} onChange={() => setAllocationMode("fifo")} /> 按凭证日期先进先出</label>
        <label style={{ marginLeft: 16 }}><input type="radio" name="allocation-mode" checked={allocationMode === "manual"} onChange={() => setAllocationMode("manual")} /> 指定单据</label>
      </fieldset>
      {allocationMode === "manual" && (
        <div className="card" style={{ marginTop: 16 }}>
          {eligibleDocuments.map((item) => (
            <div key={item.id} className="status-row" style={{ marginBottom: 10 }}>
              <span className="mono">{item.voucher_no ?? `凭证 #${item.voucher_id ?? item.id}`}</span>
              <span>{item.voucher_date}</span>
              <span>{item.summary || "-"}</span>
              <span>剩余额 {formatCents(toCents(item.outstanding) ?? BigInt(0))} 元</span>
              <label className="field">
                <span className="field-label">本次核销额 · {item.voucher_no ?? item.id}</span>
                <input inputMode="decimal" placeholder="0.00" value={allocationAmounts[item.id] ?? ""}
                  onChange={(event) => setAllocationAmounts((current) => ({ ...current, [item.id]: event.target.value }))} />
              </label>
            </div>
          ))}
          <p className="tiny">核销合计 {formatCents(allocationTotal)} 元；差额 {formatCents((enteredCents ?? BigInt(0)) - allocationTotal)} 元</p>
          {manualReason && <p className="field-err" role="status">{manualReason}</p>}
        </div>
      )}
      {error && <div className="field-err" role="alert">{error}</div>}
      {!cashAccounts.length && <p className="tiny muted">当前账套没有启用的现金或银行末级科目。</p>}
      {requiresCashflow && !cashflows.length && <p className="tiny muted">当前账套没有可选现金流项目，请联系系统管理员维护。</p>}
      <div className="card" style={{ marginTop: 16 }}>
        <p className="tiny"><b>核销与凭证说明</b></p>
        <p className="tiny muted" style={{ marginBottom: 0 }}>
          保存时系统会按所选方式分配并立即占用可核销余额，同时生成待审核草稿凭证。过账后才会进入正式账簿；目前作废或删除该草稿不会自动释放核销额度，请提交前核对主体、科目、期间和金额。
        </p>
      </div>
    </Dialog>
  );
}

export function ArapAuxiliaryDialog({
  open,
  kind,
  book,
  onClose,
  onSaved,
}: {
  open: boolean;
  kind: FinanceAuxiliaryKind;
  book: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const kindName = kind === "customer" ? "客户" : kind === "vendor" ? "供应商" : "现金流项目";

  useEffect(() => {
    if (!open) return;
    setCode("");
    setName("");
    setError("");
  }, [open, book, kind]);

  async function save() {
    if (!code.trim() || !name.trim()) {
      setError("请填写编码和名称。");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await financeApi.createAuxiliaryItem(book, {
        kind,
        code: code.trim(),
        name: name.trim(),
        metadata: {},
      });
      onSaved();
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
      title={`新建${kindName}辅助资料`}
      size="sm"
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>取消</button>
          <button className="btn-primary" disabled={saving} onClick={save}>{saving ? "保存中…" : "保存"}</button>
        </>
      }
    >
      <div className="form-grid">
        <label className="field">
          <span className="field-label">编码</span>
          <input value={code} onChange={(event) => setCode(event.target.value)} maxLength={64} placeholder={kind === "cashflow" ? "按已确认口径填写" : "例如：CUST-001"} />
        </label>
        <label className="field">
          <span className="field-label">名称</span>
          <input value={name} onChange={(event) => setName(event.target.value)} maxLength={128} placeholder={`输入${kindName}名称`} />
        </label>
      </div>
      {error && <div className="field-err" role="alert">{error}</div>}
      <p className="tiny muted">编码在当前账套与资料类型内必须唯一；辅助资料保存后立即可供财务往来使用。</p>
    </Dialog>
  );
}
