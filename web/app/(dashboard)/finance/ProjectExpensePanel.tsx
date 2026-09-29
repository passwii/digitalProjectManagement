"use client";

import { useMemo, useState } from "react";
import { DatePicker } from "@/components/ui/DatePicker";
import { Dialog } from "@/components/ui/Modal";
import Empty from "@/components/ui/Empty";
import { LoadingBlock, LoadFailed } from "@/components/ui/PageState";
import { useToast } from "@/components/ui/Toast";
import Select from "@/components/ui/Select";
import {
  errText, financeApi, HttpError, projectsApi,
  type FinanceAccount, type FinanceAuxiliaryItem, type FinanceAuxiliaryKind,
  type FinanceBook, type FinancePeriod, type FinanceProjectExpense,
  type FinanceProjectExpenseVoucherInput,
} from "@/lib/api";
import { useAsyncData } from "@/lib/useAsyncData";

const PAGE_SIZE = 20;
const auxKinds: FinanceAuxiliaryKind[] = ["customer", "vendor", "department", "employee", "project", "cashflow"];
const auxFields = [
  { flag: "customer", kind: "customer", label: "客户" },
  { flag: "vendor", kind: "vendor", label: "供应商" },
  { flag: "dept", kind: "department", label: "部门" },
  { flag: "employee", kind: "employee", label: "员工" },
  { flag: "project", kind: "project", label: "项目" },
] as const;

function money(value: string | number): string {
  return Number(value || 0).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function voucherSummary(value: FinanceProjectExpense["source_voucher_summary"]): string {
  if (!value) return "未生成";
  if (value.converted) return value.message || "已在其他账套转换";
  const state = { draft: "草稿", pending: "待审核", posted: "已过账", void: "已作废" }[value.status || "draft"];
  return `${value.voucher_no || `凭证 #${value.id}`} · ${state}${value.summary ? ` · ${value.summary}` : ""}`;
}

function conflictText(error: unknown): string {
  if (error instanceof HttpError && error.status === 409) {
    try {
      const detail = JSON.parse(error.body).detail;
      if (detail?.code === "F-PROJECT-EXPENSE-LINKED") {
        return `${detail.message || "项目支出已生成凭证"}：${voucherSummary(detail.source_voucher_summary)}`;
      }
    } catch { /* 保留通用错误文案 */ }
  }
  return errText(error);
}

function sourceDateInPeriod(expense: FinanceProjectExpense, period: FinancePeriod): boolean {
  return !!expense.exp_date && expense.exp_date >= period.start_date && expense.exp_date <= period.end_date;
}

function ConversionDialog({ expense, book, periods, accounts, onClose, onSaved }: {
  expense: FinanceProjectExpense; book: FinanceBook; periods: FinancePeriod[]; accounts: FinanceAccount[];
  onClose: () => void; onSaved: (voucherNo: string) => void;
}) {
  const openPeriods = periods.filter((period) => period.status === "open");
  const matchingPeriod = openPeriods.find((period) => sourceDateInPeriod(expense, period));
  const [periodId, setPeriodId] = useState(String(matchingPeriod?.id ?? ""));
  const period = openPeriods.find((item) => String(item.id) === periodId);
  const [date, setDate] = useState(matchingPeriod ? expense.exp_date ?? "" : "");
  const [summary, setSummary] = useState(`${expense.project.code} · 来源记录 #${expense.id} · ${expense.subject}`.slice(0, 255));
  const [debitId, setDebitId] = useState("");
  const [creditId, setCreditId] = useState("");
  const [auxValues, setAuxValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const auxiliaries = useAsyncData(
    async (signal) => {
      const pairs = await Promise.all(auxKinds.map(async (kind) => [kind, await financeApi.auxiliaryItems(book.code, kind, signal)] as const));
      return Object.fromEntries(pairs) as Record<FinanceAuxiliaryKind, FinanceAuxiliaryItem[]>;
    }, [book.id], { resetOnDepChange: true },
  );
  const leaves = accounts.filter((account) => account.is_active && account.is_leaf);
  const selected = { debit: leaves.find((account) => String(account.id) === debitId), credit: leaves.find((account) => String(account.id) === creditId) };

  function line(side: "debit" | "credit") {
    const account = selected[side]!;
    const aux_detail: Record<string, number> = {};
    for (const { flag } of auxFields) {
      const value = auxValues[`${side}.${flag}`];
      if (account.aux_flags?.[flag] && value) aux_detail[flag] = Number(value);
    }
    const cashflow = auxValues[`${side}.cashflow`];
    return { account_id: account.id, aux_detail, ...(account.aux_flags?.cashflow && cashflow ? { cashflow_item: cashflow } : {}) };
  }

  async function save() {
    if (saving) return;
    if (!period || !date || date < period.start_date || date > period.end_date) { setError("凭证日期必须在开放期间内"); return; }
    if (!selected.debit || !selected.credit) { setError("请选择当前账套启用的借方和贷方末级科目"); return; }
    for (const side of ["debit", "credit"] as const) {
      const flags = selected[side]!.aux_flags;
      for (const { flag, label } of auxFields) {
        if (flags?.[flag] && !auxValues[`${side}.${flag}`]) { setError(`请选择${side === "debit" ? "借方" : "贷方"}${label}`); return; }
      }
      if (flags?.cashflow && !auxValues[`${side}.cashflow`]) { setError(`请选择${side === "debit" ? "借方" : "贷方"}现金流项目`); return; }
    }
    const body: FinanceProjectExpenseVoucherInput = { period_id: period.id, voucher_date: date, summary: summary.trim(), debit: line("debit"), credit: line("credit") };
    setSaving(true);
    setError("");
    try {
      const voucher = await financeApi.createExpenseVoucher(book.code, expense.id, body);
      onSaved(voucher.voucher_no);
    } catch (cause) {
      setError(conflictText(cause));
    } finally {
      setSaving(false);
    }
  }

  function auxiliaryControls(side: "debit" | "credit") {
    const account = selected[side];
    if (!account) return null;
    const label = side === "debit" ? "借方" : "贷方";
    return <>
      {auxFields.filter(({ flag }) => account.aux_flags?.[flag]).map(({ flag, kind, label: kindLabel }) => (
        <label className="field" key={`${side}.${flag}`}><span className="field-label">{label}{kindLabel}</span>
          <Select value={auxValues[`${side}.${flag}`] || ""} onChange={(value) => setAuxValues((values) => ({ ...values, [`${side}.${flag}`]: value }))}>
            <option value="">请选择{kindLabel}</option>
            {(auxiliaries.data?.[kind] ?? []).filter((item) => item.is_active !== false).map((item) => <option key={item.id} value={item.id}>{item.code} · {item.name}</option>)}
          </Select>
        </label>
      ))}
      {account.aux_flags?.cashflow && <label className="field"><span className="field-label">{label}现金流项目</span>
        <Select value={auxValues[`${side}.cashflow`] || ""} onChange={(value) => setAuxValues((values) => ({ ...values, [`${side}.cashflow`]: value }))}>
          <option value="">请选择现金流项目</option>
          {(auxiliaries.data?.cashflow ?? []).filter((item) => item.is_active !== false).map((item) => <option key={item.id} value={item.code}>{item.code} · {item.name}</option>)}
        </Select>
      </label>}
    </>;
  }

  return <Dialog open onClose={onClose} title="项目支出生成凭证" size="md" maskClosable={!saving} footer={<>
    <button className="btn-ghost" disabled={saving} onClick={onClose}>取消</button>
    <button className="btn-primary" disabled={saving || !period || auxiliaries.loading || !!auxiliaries.error} onClick={() => void save()}>{saving ? "生成中…" : "确认生成草稿凭证"}</button>
  </>}>
    <div className="form-grid">
      <div className="field"><span className="field-label">当前账套</span><strong>{book.name}</strong><span className="tiny muted">{book.code}</span></div>
      <div className="field"><span className="field-label">来源项目</span><strong>{expense.project.name}</strong><span className="tiny muted">{expense.project.code}</span></div>
      <div className="field"><span className="field-label">来源记录编号</span><strong>来源记录 #{expense.id}</strong></div>
      <div className="field"><span className="field-label">支出日期</span><span>{expense.exp_date || "-"}</span></div>
      <div className="field"><span className="field-label">审批状态</span><span>{expense.status === "approved" ? "已审批" : "异常审批"}</span></div>
      <div className="field span-2"><span className="field-label">支出说明</span><span>{expense.note || "-"}</span></div>
      <label className="field"><span className="field-label">来源金额</span><input value={money(expense.amount)} readOnly /></label>
      <label className="field"><span className="field-label">会计期间</span><Select value={periodId} onChange={(value) => { const next = openPeriods.find((item) => String(item.id) === value); setPeriodId(value); setDate(next && sourceDateInPeriod(expense, next) ? expense.exp_date ?? "" : ""); }}><option value="">请选择开放期间</option>{openPeriods.map((item) => <option key={item.id} value={item.id}>{item.period}</option>)}</Select></label>
      <label className="field"><span className="field-label">凭证日期</span><DatePicker value={date} onChange={setDate} ariaLabel="凭证日期" min={period?.start_date} max={period?.end_date} /></label>
      {date && expense.exp_date && date !== expense.exp_date && <p className="tiny muted span-2" role="status">凭证日期与原支出日期不一致，请按会计判断确认。</p>}
      <label className="field span-2"><span className="field-label">摘要</span><input value={summary} maxLength={255} onChange={(event) => setSummary(event.target.value)} /></label>
      {(["debit", "credit"] as const).map((side) => <div className="span-2 form-grid" key={side}>
        <label className="field span-2"><span className="field-label">{side === "debit" ? "借方科目" : "贷方科目"}</span><Select value={side === "debit" ? debitId : creditId} onChange={(value) => { (side === "debit" ? setDebitId : setCreditId)(value); setAuxValues((values) => Object.fromEntries(Object.entries(values).filter(([key]) => !key.startsWith(`${side}.`)))); }}><option value="">请选择启用末级科目</option>{leaves.map((item) => <option key={item.id} value={item.id}>{item.code} · {item.name}</option>)}</Select></label>
        {auxiliaryControls(side)}
      </div>)}
    </div>
    {auxiliaries.error && <LoadFailed message={auxiliaries.error} onRetry={auxiliaries.reload} />}
    {error && <div className="field-err" role="alert">{error}</div>}
    {!openPeriods.length && <p className="tiny muted">当前账套没有开放期间，暂时无法生成凭证。</p>}
  </Dialog>;
}

export default function ProjectExpensePanel({ book, periods, accounts, onVoucherCreated }: {
  book: FinanceBook; periods: FinancePeriod[]; accounts: FinanceAccount[]; onVoucherCreated: () => void;
}) {
  const toast = useToast();
  const [projectId, setProjectId] = useState("");
  const [projectSearch, setProjectSearch] = useState("");
  const [projectPage, setProjectPage] = useState(1);
  const [chosenProject, setChosenProject] = useState<{ id: number; code: string; name: string } | null>(null);
  const [status, setStatus] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<FinanceProjectExpense | null>(null);
  const [notice, setNotice] = useState("");
  const projects = useAsyncData(
    (signal) => projectsApi.options({ keyword: projectSearch, page: projectPage, size: PAGE_SIZE }, signal),
    [projectSearch, projectPage], { resetOnDepChange: true },
  );
  const expenses = useAsyncData(
    (signal) => financeApi.projectExpenses(book.code, { project_id: projectId ? Number(projectId) : undefined, status: status || undefined, date_from: dateFrom, date_to: dateTo, page, size: PAGE_SIZE }, signal),
    [book.id, projectId, status, dateFrom, dateTo, page], { resetOnDepChange: true },
  );
  const projectOptions = useMemo(() => {
    const byId = new Map<number, { id: number; code: string; name: string }>();
    if (chosenProject) byId.set(chosenProject.id, chosenProject);
    for (const project of projects.data?.items ?? []) byId.set(project.id, project);
    for (const item of expenses.data?.items ?? []) byId.set(item.project.id, item.project);
    return Array.from(byId.values());
  }, [chosenProject, projects.data, expenses.data]);
  const projectTotalPages = Math.max(1, Math.ceil((projects.data?.total ?? 0) / PAGE_SIZE));
  const totalPages = Math.max(1, Math.ceil((expenses.data?.total ?? 0) / PAGE_SIZE));
  const openPeriods = periods.some((period) => period.status === "open");

  function saved(voucherNo: string) {
    setSelected(null);
    const message = `${voucherNo}：草稿凭证已生成，需继续审核和过账`;
    setNotice(message);
    toast.ok(message);
    expenses.reload();
    onVoucherCreated();
  }

  return <>
    <div className="section-head"><div><h2>项目支出入账</h2><p>选择已审批项目支出，逐笔生成当前账套的草稿凭证。</p></div><button className="btn-ghost" onClick={expenses.reload}>刷新</button></div>
    {notice && <div className="card" role="status">{notice}</div>}
    <div className="filter-row">
      <label className="toolbar-field"><span>搜索项目</span><input value={projectSearch} onChange={(event) => { setProjectSearch(event.target.value); setProjectPage(1); }} placeholder="项目名称或编号" /></label>
      <label className="toolbar-field"><span>项目</span><Select value={projectId} onChange={(value) => { setProjectId(value); setChosenProject(projectOptions.find((item) => String(item.id) === value) ?? null); setPage(1); }}><option value="">全部项目</option>{projectOptions.map((project) => <option key={project.id} value={project.id}>{project.code} · {project.name}</option>)}</Select></label>
      <div className="row-actions"><span className="tiny muted">项目 {projectPage}/{projectTotalPages} 页</span><button className="btn-ghost" disabled={projectPage <= 1 || projects.loading} onClick={() => setProjectPage((current) => current - 1)}>上一页项目</button><button className="btn-ghost" disabled={projectPage >= projectTotalPages || projects.loading} onClick={() => setProjectPage((current) => current + 1)}>下一页项目</button></div>
      {projects.error && <LoadFailed message={projects.error} onRetry={projects.reload} />}
      <label className="toolbar-field"><span>审批状态</span><Select value={status} onChange={(value) => { setStatus(value); setPage(1); }}><option value="">全部状态</option><option value="approved">已审批</option><option value="exception">异常审批</option></Select></label>
      <label className="toolbar-field"><span>开始日期</span><DatePicker size="toolbar" value={dateFrom} max={dateTo || undefined} onChange={(v) => { setDateFrom(v); setPage(1); }} ariaLabel="开始日期" quick={false} /></label>
      <label className="toolbar-field"><span>结束日期</span><DatePicker size="toolbar" value={dateTo} min={dateFrom || undefined} onChange={(v) => { setDateTo(v); setPage(1); }} ariaLabel="结束日期" quick={false} /></label>
    </div>
    {expenses.firstLoad ? <LoadingBlock kpis={0} label="加载项目支出…" /> : expenses.error ? <LoadFailed message={expenses.error} onRetry={expenses.reload} /> : !expenses.data?.items.length ? <div className="card"><Empty title="没有匹配的项目支出" hint="调整项目、状态或日期筛选条件。" /></div> : <>
      <div className="table-scroll"><table className="grid"><thead><tr><th>项目</th><th>支出</th><th>日期</th><th className="num">来源金额</th><th>审批状态</th><th>关联凭证</th><th>操作</th></tr></thead><tbody>{expenses.data.items.map((item) => <tr key={item.id}><td>{item.project.name}<span className="tiny muted"> · {item.project.code}</span></td><td>{item.subject}<span className="tiny muted"> · 来源记录 #{item.id}{item.note ? ` · ${item.note}` : ""}</span></td><td>{item.exp_date || "-"}</td><td className="num">{money(item.amount)}</td><td>{item.status === "approved" ? "已审批" : "异常审批"}</td><td>{voucherSummary(item.source_voucher_summary)}</td><td><button className="btn-xs btn-primary" disabled={!!item.source_voucher_summary || !openPeriods} title={!openPeriods ? "需要开放会计期间" : item.source_voucher_summary ? "此支出已经转换" : undefined} onClick={() => setSelected(item)}>生成凭证</button></td></tr>)}</tbody></table></div>
      <div className="row-actions"><span className="tiny muted">共 {expenses.data.total} 条 · 第 {page}/{totalPages} 页</span><button className="btn-ghost" disabled={page <= 1} onClick={() => setPage((current) => current - 1)}>上一页</button><button className="btn-ghost" disabled={page >= totalPages} onClick={() => setPage((current) => current + 1)}>下一页</button></div>
    </>}
    {selected && <ConversionDialog key={selected.id} expense={selected} book={book} periods={periods} accounts={accounts} onClose={() => setSelected(null)} onSaved={saved} />}
  </>;
}
