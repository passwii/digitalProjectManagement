"use client";

import { Suspense, useMemo, useState } from "react";
import {
  errText,
  financeApi,
  type FinanceAccount,
  type FinanceBook,
  type FinanceEntry,
  type FinancePeriod,
  type FinanceVoucher,
} from "@/lib/api";
import { useAsyncData } from "@/lib/useAsyncData";
import { useMenus } from "@/lib/useMeta";
import { LoadingBlock, LoadFailed, NoAccess } from "@/components/ui/PageState";
import Empty from "@/components/ui/Empty";
import PageHeader from "@/components/ui/PageHeader";
import MotionTabs from "@/components/motion/MotionTabs";
import { Confirm, Dialog } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import ArapPanel from "./ArapPanel";
import { AccountBookRecycleBinDialog, MoveBookToRecycleBinDialog } from "./AccountBookLifecycle";

const TABS = ["账套概览", "基础设置", "凭证", "应收应付", "出纳与对账", "固定资产", "账簿与报表", "期末结账"] as const;
type Tab = (typeof TABS)[number];

function money(value: string | number) {
  return Number(value || 0).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function FinanceInner() {
  const { canFinance, isAdmin, loading: permissionLoading, error: permissionError, reload: reloadPermission } = useMenus();
  const toast = useToast();
  const [tab, setTab] = useState<Tab>("账套概览");
  const [bookCode, setBookCode] = useState("");
  const [voucherOpen, setVoucherOpen] = useState(false);
  const [bookOpen, setBookOpen] = useState(false);
  const [templateOpen, setTemplateOpen] = useState(false);
  const [recycleBinOpen, setRecycleBinOpen] = useState(false);
  const [deleteBookOpen, setDeleteBookOpen] = useState(false);

  const books = useAsyncData((signal) => financeApi.books.list(signal), [], { resetOnDepChange: true });
  const book = books.data?.find((item) => item.code === bookCode) ?? books.data?.[0] ?? null;
  const activeBook = book?.code ?? "";
  const periods = useAsyncData((signal) => financeApi.periods(activeBook, undefined, signal), [activeBook], { enabled: !!activeBook, resetOnDepChange: true });
  const accounts = useAsyncData((signal) => financeApi.accounts(activeBook, signal), [activeBook], { enabled: !!activeBook && (tab === "基础设置" || tab === "应收应付" || voucherOpen), resetOnDepChange: true });
  const opening = useAsyncData((signal) => financeApi.openingCheck(activeBook, signal), [activeBook], { enabled: !!activeBook, resetOnDepChange: true });
  const currentPeriod = periods.data?.find((period) => period.status === "open") ?? periods.data?.[0] ?? null;
  const vouchers = useAsyncData(
    (signal) => financeApi.vouchers(activeBook, { period_id: currentPeriod?.id, page: 1, size: 20 }, signal),
    [activeBook, currentPeriod?.id],
    { enabled: !!activeBook && !!currentPeriod && tab === "凭证", resetOnDepChange: true },
  );
  const templates = useAsyncData((signal) => financeApi.templates(activeBook, signal), [activeBook], { enabled: !!activeBook && tab === "凭证", resetOnDepChange: true });
  const bankStatements = useAsyncData((signal) => financeApi.bankStatements(activeBook, currentPeriod?.id, signal), [activeBook, currentPeriod?.id], { enabled: !!activeBook && !!currentPeriod && tab === "出纳与对账", resetOnDepChange: true });
  const reconciliation = useAsyncData((signal) => financeApi.reconciliation(activeBook, currentPeriod!.id, signal), [activeBook, currentPeriod?.id], { enabled: !!activeBook && !!currentPeriod && tab === "出纳与对账", resetOnDepChange: true });
  const fixedAssets = useAsyncData((signal) => financeApi.fixedAssets(activeBook, signal), [activeBook], { enabled: !!activeBook && tab === "固定资产", resetOnDepChange: true });
  const balances = useAsyncData(
    (signal) => financeApi.balances(activeBook, currentPeriod!.id, signal),
    [activeBook, currentPeriod?.id],
    { enabled: !!activeBook && !!currentPeriod && tab === "账簿与报表", resetOnDepChange: true },
  );
  const reports = useAsyncData(
    async (signal) => {
      const [balanceSheet, income, cashflow] = await Promise.all([
        financeApi.balanceSheet(activeBook, currentPeriod!.id, signal),
        financeApi.income(activeBook, currentPeriod!.id, signal),
        financeApi.cashflow(activeBook, currentPeriod!.id, signal),
      ]);
      return { balanceSheet, income, cashflow };
    },
    [activeBook, currentPeriod?.id],
    { enabled: !!activeBook && !!currentPeriod && tab === "账簿与报表", resetOnDepChange: true },
  );
  const closeCheck = useAsyncData(
    (signal) => financeApi.closeCheck(activeBook, currentPeriod!.id, signal),
    [activeBook, currentPeriod?.id, currentPeriod?.version],
    { enabled: !!activeBook && !!currentPeriod && tab === "期末结账", resetOnDepChange: true },
  );

  async function refreshAll() {
    books.reload();
    periods.reload();
    opening.reload();
    accounts.reload();
    vouchers.reload();
    balances.reload();
  }

  if (permissionLoading) return <LoadingBlock kpis={0} label="确认财务权限…" />;
  if (permissionError) return <LoadFailed message={permissionError} onRetry={reloadPermission} />;
  if (!canFinance) return <NoAccess title="暂无财务账套权限" hint="当前账号没有被授权访问财务账套。请联系系统管理员分配账套角色。" />;
  if (books.firstLoad) return <LoadingBlock kpis={4} label="加载财务账套…" />;
  if (books.error) return <LoadFailed message={books.error} onRetry={books.reload} />;

  return (
    <div>
      <PageHeader
        title="财务管理"
        filters={
          <>
            <label className="toolbar-field">
              <span>当前账套</span>
              <select value={activeBook} onChange={(event) => setBookCode(event.target.value)} aria-label="选择财务账套">
                {!books.data?.length && <option value="">暂无账套</option>}
                {books.data?.map((item) => <option key={item.code} value={item.code}>{item.name} · {item.code}</option>)}
              </select>
            </label>
            <span className="tiny muted">项目成本与财务账独立，项目支出不会自动生成会计凭证。</span>
          </>
        }
        actions={
          <>
            <button className="btn-ghost" onClick={refreshAll} title="刷新财务工作台">刷新</button>
            {isAdmin && <button className="btn-ghost" onClick={() => setBookOpen(true)}>+ 新建账套</button>}
            {isAdmin && <button className="btn-ghost" onClick={() => setRecycleBinOpen(true)}>账套回收站</button>}
            {isAdmin && book && <button className="btn-danger-outline" onClick={() => setDeleteBookOpen(true)}>移入回收站</button>}
            {activeBook && currentPeriod && <button className="btn-primary" onClick={() => setVoucherOpen(true)}>+ 凭证</button>}
          </>
        }
      />

      {!book ? (
        <>
          <div className="card"><Empty title="还没有财务账套" hint="点击右上角“新建账套”创建第一个独立核算账套。" /></div>
          <BookDialog open={bookOpen} onClose={() => setBookOpen(false)} onSaved={() => { setBookOpen(false); books.reload(); toast.ok("账套已创建"); }} />
        </>
      ) : (
        <>
          <MotionTabs items={TABS.map((item) => ({ id: item, label: item }))} active={tab} onChange={setTab}>
            {tab === "账套概览" && <Overview book={book} period={currentPeriod} periods={periods.data ?? []} opening={opening.data ?? undefined} />}
            {tab === "基础设置" && <Foundation accounts={accounts.data ?? []} loading={accounts.loading} error={accounts.error} onRetry={accounts.reload} />}
            {tab === "凭证" && <VoucherList book={activeBook} period={currentPeriod} templates={templates.data ?? []} data={vouchers.data?.items ?? []} loading={vouchers.loading} error={vouchers.error} onRetry={vouchers.reload} onCreate={() => setVoucherOpen(true)} onTemplate={() => setTemplateOpen(true)} onAction={async (action, voucher, reason) => {
              try {
                if (action === "submit") await financeApi.submitVoucher(activeBook, voucher.id);
                if (action === "approve") await financeApi.approveVoucher(activeBook, voucher.id);
                if (action === "post") await financeApi.postVoucher(activeBook, voucher.id);
                if (action === "reverse") await financeApi.reverseVoucher(activeBook, voucher.id);
                if (action === "delete") await financeApi.deleteVoucher(activeBook, voucher.id);
                if (action === "void") await financeApi.voidVoucher(activeBook, voucher.id, reason ?? "");
                toast.ok(action === "delete" ? "草稿凭证已删除；相关核销余额已释放（如有）" : action === "void" ? "凭证已作废；相关核销余额已释放（如有）" : "凭证状态已更新");
                vouchers.reload();
                return true;
              } catch (error) { toast.err(errText(error)); return false; }
            }} />}
            {tab === "应收应付" && <ArapPanel book={activeBook} period={currentPeriod} accounts={accounts.data ?? []} accountsLoading={accounts.loading} accountsError={accounts.error} reloadAccounts={accounts.reload} isAdmin={isAdmin} />}
            {tab === "出纳与对账" && <CashierList book={activeBook} period={currentPeriod} statements={bankStatements.data?.items ?? []} summary={reconciliation.data ?? undefined} loading={bankStatements.loading || reconciliation.loading} error={bankStatements.error || reconciliation.error} onRetry={() => { bankStatements.reload(); reconciliation.reload(); }} onChanged={() => { bankStatements.reload(); reconciliation.reload(); }} />}
            {tab === "固定资产" && <FixedAssetList book={activeBook} period={currentPeriod} items={fixedAssets.data?.items ?? []} loading={fixedAssets.loading} error={fixedAssets.error} onRetry={fixedAssets.reload} onChanged={fixedAssets.reload} />}
            {tab === "账簿与报表" && <BalanceList period={currentPeriod} items={balances.data?.items ?? []} reports={reports.data ?? undefined} loading={balances.loading || reports.loading} error={balances.error || reports.error} onRetry={() => { balances.reload(); reports.reload(); }} />}
            {tab === "期末结账" && <ClosePanel book={activeBook} period={currentPeriod} check={closeCheck.data} loading={closeCheck.loading} error={closeCheck.error} onRefresh={() => { closeCheck.reload(); periods.reload(); }} onClosed={() => { closeCheck.reload(); periods.reload(); }} />}
          </MotionTabs>
          <VoucherDialog open={voucherOpen} book={book} period={currentPeriod} accounts={accounts.data ?? []} onClose={() => setVoucherOpen(false)} onSaved={() => { setVoucherOpen(false); vouchers.reload(); toast.ok("凭证草稿已保存"); }} />
          <BookDialog open={bookOpen} onClose={() => setBookOpen(false)} onSaved={() => { setBookOpen(false); books.reload(); toast.ok("账套已创建"); }} />
          <TemplateDialog open={templateOpen} book={activeBook} period={currentPeriod} accounts={accounts.data ?? []} templates={templates.data ?? []} onClose={() => setTemplateOpen(false)} onSaved={() => { setTemplateOpen(false); templates.reload(); toast.ok("模板已保存"); }} onGenerated={() => { setTemplateOpen(false); vouchers.reload(); toast.ok("已按模板生成凭证草稿"); }} />
        </>
      )}
      {isAdmin && <AccountBookRecycleBinDialog open={recycleBinOpen} onClose={() => setRecycleBinOpen(false)} onRestored={() => books.reload()} />}
      {isAdmin && <MoveBookToRecycleBinDialog open={deleteBookOpen} book={book} onClose={() => setDeleteBookOpen(false)} onDeleted={() => {
        if (book) books.setData((books.data ?? []).filter((item) => item.id !== book.id));
        setBookCode("");
        books.reload();
        toast.ok("账套已移入回收站，数据保留且可恢复");
      }} />}
    </div>
  );
}

function Overview({ book, period, periods, opening }: { book: FinanceBook; period: FinancePeriod | null; periods: FinancePeriod[]; opening?: { balanced: boolean; debit: string; credit: string; difference: string } }) {
  return <>
    <div className="kpi-row">
      <div className="kpi"><div className="k">账套</div><div className="v" style={{ fontSize: 22 }}>{book.name}</div><div className="kpi-foot">{book.code} · {book.base_currency}</div></div>
      <div className="kpi"><div className="k">当前期间</div><div className="v">{period?.period ?? "-"}</div><div className="kpi-foot">{period?.status === "open" ? "开放录入" : period?.status === "closed" ? "已结账" : "已锁定"}</div></div>
      <div className="kpi"><div className="k">期间总数</div><div className="v">{periods.length}</div><div className="kpi-foot">自然月期间</div></div>
      <div className="kpi"><div className="k">期初平衡</div><div className="v">{opening?.balanced ? "平衡" : "待校正"}</div><div className="kpi-foot">借 {money(opening?.debit ?? "0")} · 贷 {money(opening?.credit ?? "0")}</div></div>
    </div>
    <div className="section-head"><div><h2>财务闭环</h2><p>账套 → 凭证 → 账簿 → 报表 → 结账，所有事实以已过账凭证为源头。</p></div></div>
    <div className="card" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", gap: 12 }}>
      {["账套与科目", "凭证录入与审核", "总账与余额表", "期末结账"].map((label, index) => <div key={label} className="status-row"><b>0{index + 1}</b><span>{label}</span><span className="badge done">已接入</span></div>)}
    </div>
  </>;
}

function Foundation({ accounts, loading, error, onRetry }: { accounts: FinanceAccount[]; loading: boolean; error: string; onRetry: () => void }) {
  if (loading) return <LoadingBlock kpis={0} label="加载科目体系…" />;
  if (error) return <LoadFailed message={error} onRetry={onRetry} />;
  return <>
    <div className="section-head"><div><h2>基础设置</h2><p>2022 版企业会计准则科目树，停用和辅助核算由后端规则控制。</p></div><span className="tiny muted">{accounts.length} 个科目</span></div>
    <div className="table-scroll"><table className="grid"><thead><tr><th>编码</th><th>科目名称</th><th>类别</th><th>方向</th><th>辅助核算</th><th>状态</th></tr></thead><tbody>{accounts.slice(0, 120).map((account) => <tr key={account.id}><td className="mono">{account.code}</td><td style={{ paddingLeft: Math.max(12, account.level * 18) }}>{account.name}</td><td>{account.category}</td><td>{account.direction === "D" ? "借" : "贷"}</td><td>{Object.entries(account.aux_flags ?? {}).filter(([, enabled]) => enabled).map(([key]) => key).join("、") || "-"}</td><td><span className={`badge ${account.is_active ? "done" : "muted"}`}>{account.is_active ? "启用" : "停用"}</span></td></tr>)}</tbody></table></div>
  </>;
}

function VoucherList({ book, period, templates, data, loading, error, onRetry, onCreate, onTemplate, onAction }: { book: string; period: FinancePeriod | null; templates: { id: number; code: string; name: string }[]; data: FinanceVoucher[]; loading: boolean; error: string; onRetry: () => void; onCreate: () => void; onTemplate: () => void; onAction: (action: "submit" | "approve" | "post" | "reverse" | "delete" | "void", voucher: FinanceVoucher, reason?: string) => Promise<boolean> }) {
  const [deleteTarget, setDeleteTarget] = useState<FinanceVoucher | null>(null);
  const [voidTarget, setVoidTarget] = useState<FinanceVoucher | null>(null);
  const [voidReason, setVoidReason] = useState("");
  const [voidError, setVoidError] = useState("");
  const [busyVoucherId, setBusyVoucherId] = useState<number | null>(null);

  async function runAction(action: "submit" | "approve" | "post" | "reverse" | "delete" | "void", voucher: FinanceVoucher, reason?: string) {
    setBusyVoucherId(voucher.id);
    try {
      const saved = await onAction(action, voucher, reason);
      if (saved) {
        if (action === "delete") setDeleteTarget(null);
        if (action === "void") { setVoidTarget(null); setVoidReason(""); setVoidError(""); }
      }
    } finally {
      setBusyVoucherId(null);
    }
  }

  async function confirmVoid() {
    if (!voidTarget) return;
    if (!voidReason.trim()) { setVoidError("作废凭证必须填写原因。"); return; }
    setVoidError("");
    await runAction("void", voidTarget, voidReason.trim());
  }

  if (loading) return <LoadingBlock kpis={0} label="加载凭证…" />;
  if (error) return <LoadFailed message={error} onRetry={onRetry} />;
  return <>
    <div className="section-head"><div><h2>凭证</h2><p>当前期间的凭证流水，草稿、待审核和已过账状态由后端控制。</p></div><div className="row-actions"><button className="btn-ghost" onClick={onTemplate}>模板</button><button className="btn-ghost" onClick={() => document.getElementById("finance-voucher-import")?.click()}>导入 Excel</button><input id="finance-voucher-import" type="file" accept=".xlsx" hidden onChange={async (event) => { const file = event.target.files?.[0]; if (file && period) { await financeApi.importVouchers(book, period.id, file); window.location.reload(); } }} /><button className="btn-ghost" disabled={!period} onClick={() => period && financeApi.exportVouchers(book, period.id)}>导出 Excel</button><button className="btn-primary" onClick={onCreate}>+ 新建凭证</button></div></div>
    {!data.length ? <div className="card"><Empty title="当前期间还没有凭证" hint="从一张手工凭证开始建立财务事实。" /></div> : <div className="table-scroll"><table className="grid"><thead><tr><th>凭证号</th><th>日期</th><th>摘要</th><th className="num">借方</th><th className="num">贷方</th><th>状态</th><th className="no-print">操作</th></tr></thead><tbody>{data.map((voucher) => <tr key={voucher.id}><td className="mono">{voucher.voucher_no}</td><td>{voucher.voucher_date}</td><td>{voucher.summary || "-"}</td><td className="num">{money(voucher.total_debit)}</td><td className="num">{money(voucher.total_credit)}</td><td><span className={`badge ${voucher.status === "posted" ? "done" : voucher.status === "pending" ? "doing" : "muted"}`}>{({ draft: "草稿", pending: "待审核", posted: "已过账", void: "已作废" } as Record<string, string>)[voucher.status]}</span></td><td className="no-print"><div className="row-actions">{voucher.status === "draft" && <><button className="btn-xs btn-ghost" disabled={busyVoucherId !== null} onClick={() => void runAction("submit", voucher)}>提交</button><button className="btn-xs btn-danger-outline" disabled={busyVoucherId !== null} onClick={() => setDeleteTarget(voucher)}>删除草稿</button></>}{voucher.status === "pending" && <><button className="btn-xs btn-ghost" disabled={busyVoucherId !== null} onClick={() => void runAction("approve", voucher)}>审核</button><button className="btn-xs btn-primary" disabled={busyVoucherId !== null} onClick={() => void runAction("post", voucher)}>过账</button><button className="btn-xs btn-danger-outline" disabled={busyVoucherId !== null} onClick={() => { setVoidTarget(voucher); setVoidReason(""); setVoidError(""); }}>作废</button></>}{voucher.status === "posted" && <button className="btn-xs btn-ghost" disabled={busyVoucherId !== null} onClick={() => void runAction("reverse", voucher)}>红字冲销</button>}</div></td></tr>)}</tbody></table></div>}
    <Confirm
      open={!!deleteTarget}
      title="删除草稿凭证？"
      text="草稿凭证将被删除。如果这是收付款核销凭证，系统会同步释放已占用的未核销余额，并保留核销分配历史。"
      okText="删除草稿"
      danger
      loading={busyVoucherId === deleteTarget?.id}
      onConfirm={() => { if (deleteTarget) void runAction("delete", deleteTarget); }}
      onCancel={() => setDeleteTarget(null)}
    />
    <Dialog
      open={!!voidTarget}
      onClose={() => { if (busyVoucherId === null) { setVoidTarget(null); setVoidReason(""); setVoidError(""); } }}
      title={voidTarget ? `作废凭证 ${voidTarget.voucher_no}` : "作废凭证"}
      size="sm"
      maskClosable={busyVoucherId === null}
      footer={<><button className="btn-ghost" disabled={busyVoucherId !== null} onClick={() => { setVoidTarget(null); setVoidReason(""); setVoidError(""); }}>取消</button><button className="btn-danger" disabled={busyVoucherId !== null || !voidReason.trim()} onClick={() => void confirmVoid()}>{busyVoucherId === voidTarget?.id ? "处理中…" : "确认作废"}</button></>}
    >
      <p>作废后该凭证不可继续审核或过账。若它占用了收付款核销余额，余额会在本次操作中释放。请填写作废原因。</p>
      <label className="field"><span className="field-label">作废原因</span><textarea maxLength={500} value={voidReason} onChange={(event) => setVoidReason(event.target.value)} rows={4} placeholder="说明作废原因" /></label>
      {voidError && <div className="field-err" role="alert">{voidError}</div>}
    </Dialog>
  </>;
}

function CashierList({ book, period, statements, summary, loading, error, onRetry, onChanged }: { book: string; period: FinancePeriod | null; statements: { id: number; external_id: string; transaction_date: string; direction: "inflow" | "outflow"; amount: string; account_code: string; summary: string; counterparty: string; status: string; matched_voucher_id: number | null }[]; summary?: { bank_total: string; unmatched_count: number; unmatched_amount: string }; loading: boolean; error: string; onRetry: () => void; onChanged: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  async function importFile(file: File) {
    if (!period) return;
    setBusy(true);
    try { await financeApi.importBankStatements(book, period.id, file); toast.ok("银行流水已导入"); onChanged(); } catch (e) { toast.err(errText(e)); } finally { setBusy(false); }
  }
  return <>
    <div className="section-head"><div><h2>出纳与对账</h2><p>银行流水先入账待匹配区，再与当前账套已过账凭证核对。</p></div><div className="row-actions"><button className="btn-ghost" onClick={() => document.getElementById("finance-bank-import")?.click()} disabled={busy || !period}>导入银行流水</button><input id="finance-bank-import" type="file" accept=".xlsx" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void importFile(file); }} /><button className="btn-ghost" onClick={onRetry}>刷新</button></div></div>
    {loading ? <LoadingBlock kpis={3} label="加载银行对账…" /> : error ? <LoadFailed message={error} onRetry={onRetry} /> : <><div className="kpi-row"><div className="kpi"><div className="k">银行流水净额</div><div className="v">{money(summary?.bank_total ?? "0")}</div><div className="kpi-foot">当前期间导入流水</div></div><div className="kpi"><div className="k">未匹配笔数</div><div className="v">{summary?.unmatched_count ?? 0}</div><div className="kpi-foot">需要与凭证核对</div></div><div className="kpi"><div className="k">未匹配金额</div><div className="v">{money(summary?.unmatched_amount ?? "0")}</div><div className="kpi-foot">未达账项提示</div></div></div><div className="table-scroll"><table className="grid"><thead><tr><th>流水号</th><th>日期</th><th>方向</th><th className="num">金额</th><th>摘要</th><th>对方</th><th>状态</th></tr></thead><tbody>{statements.map((row) => <tr key={row.id}><td className="mono">{row.external_id}</td><td>{row.transaction_date}</td><td>{row.direction === "inflow" ? "流入" : "流出"}</td><td className="num">{money(row.amount)}</td><td>{row.summary || "-"}</td><td>{row.counterparty || "-"}</td><td><span className={`badge ${row.status === "matched" ? "done" : "doing"}`}>{row.status === "matched" ? "已匹配" : "待匹配"}</span></td></tr>)}</tbody></table></div></>}
  </>;
}

function FixedAssetList({ book, period, items, loading, error, onRetry, onChanged }: { book: string; period: FinancePeriod | null; items: { code: string; name: string; category: string; acquisition_date: string; original_cost: string; accumulated_depreciation: string; net_book_value: string; status: string }[]; loading: boolean; error: string; onRetry: () => void; onChanged: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  async function depreciate() {
    if (!period) return;
    setBusy(true);
    try { const result = await financeApi.depreciateFixedAssets(book, period.id); toast.ok(`本期已计提 ${result.depreciated} 项折旧，共 ${money(result.total_amount)} 元`); onChanged(); } catch (e) { toast.err(errText(e)); } finally { setBusy(false); }
  }
  return <>
    <div className="section-head"><div><h2>固定资产</h2><p>资产卡片与月度直线法折旧；新增资产当月不折旧，次月开始计提。</p></div><div className="row-actions"><button className="btn-primary" disabled={busy || !period} onClick={depreciate}>计提本期折旧</button><button className="btn-ghost" onClick={onRetry}>刷新</button></div></div>
    {loading ? <LoadingBlock kpis={0} label="加载固定资产…" /> : error ? <LoadFailed message={error} onRetry={onRetry} /> : <div className="table-scroll"><table className="grid"><thead><tr><th>资产编码</th><th>名称</th><th>类别</th><th>取得日期</th><th className="num">原值</th><th className="num">累计折旧</th><th className="num">账面净值</th><th>状态</th></tr></thead><tbody>{items.map((item) => <tr key={item.code}><td className="mono">{item.code}</td><td>{item.name}</td><td>{item.category || "-"}</td><td>{item.acquisition_date}</td><td className="num">{money(item.original_cost)}</td><td className="num">{money(item.accumulated_depreciation)}</td><td className="num">{money(item.net_book_value)}</td><td><span className="badge done">{item.status === "active" ? "在用" : "已处置"}</span></td></tr>)}</tbody></table></div>}
  </>;
}

function BalanceList({ period, items, reports, loading, error, onRetry }: { period: FinancePeriod | null; items: { account_code: string; account_name: string; debit_total: string; credit_total: string; ending_debit: string; ending_credit: string }[]; reports?: { balanceSheet: { totals: { assets: string; liabilities: string; equity: string; profit_before_close: string; balanced: boolean } }; income: { totals: { income: string; expense: string; profit: string } }; cashflow: { ready: boolean; unclassified_amount: string } }; loading: boolean; error: string; onRetry: () => void }) {
  if (loading) return <LoadingBlock kpis={0} label="加载余额表…" />;
  if (error) return <LoadFailed message={error} onRetry={onRetry} />;
  return <><div className="section-head"><div><h2>账簿与报表</h2><p>{period?.period ?? "当前期间"} 的余额表和三大报表摘要，明细查询以后端已过账凭证为准。</p></div></div><div className="kpi-row"><div className="kpi"><div className="k">资产负债表</div><div className="v">{reports?.balanceSheet.totals.balanced ? "平衡" : "需检查"}</div><div className="kpi-foot">资产 {money(reports?.balanceSheet.totals.assets ?? "0")} · 负债+权益 {money((Number(reports?.balanceSheet.totals.liabilities ?? 0) + Number(reports?.balanceSheet.totals.equity ?? 0)))}</div></div><div className="kpi"><div className="k">利润表</div><div className="v">{money(reports?.income.totals.profit ?? "0")}</div><div className="kpi-foot">收入 {money(reports?.income.totals.income ?? "0")} · 费用 {money(reports?.income.totals.expense ?? "0")}</div></div><div className="kpi"><div className="k">现金流量表</div><div className="v">{reports?.cashflow.ready ? "已归类" : "待归类"}</div><div className="kpi-foot">未分类 {money(reports?.cashflow.unclassified_amount ?? "0")}</div></div></div><div className="table-scroll"><table className="grid"><thead><tr><th>科目</th><th>科目名称</th><th className="num">本期借方</th><th className="num">本期贷方</th><th className="num">期末借方</th><th className="num">期末贷方</th></tr></thead><tbody>{items.map((item) => <tr key={item.account_code}><td className="mono">{item.account_code}</td><td>{item.account_name}</td><td className="num">{money(item.debit_total)}</td><td className="num">{money(item.credit_total)}</td><td className="num">{money(item.ending_debit)}</td><td className="num">{money(item.ending_credit)}</td></tr>)}</tbody></table></div></>;
}

function ClosePanel({ book, period, check, loading, error, onRefresh, onClosed }: { book: string; period: FinancePeriod | null; check?: { ready: boolean; issues: { code: string; message: string }[] } | null; loading: boolean; error: string; onRefresh: () => void; onClosed: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  async function close() {
    if (!period) return;
    setBusy(true);
    try { await financeApi.close(book, period.id, period.version); toast.ok("期间已结账"); onClosed(); } catch (e) { toast.err(errText(e)); } finally { setBusy(false); }
  }
  async function reopen() {
    if (!period) return;
    setBusy(true);
    try { await financeApi.reopen(book, period.id, period.version); toast.ok("期间已反结账"); onClosed(); } catch (e) { toast.err(errText(e)); } finally { setBusy(false); }
  }
  return <><div className="section-head"><div><h2>期末结账</h2><p>结账前检查未审核凭证、断号、试算平衡和报表恒等式。</p></div><button className="btn-ghost" onClick={onRefresh}>刷新检查</button></div><div className="card"><div className="status-row"><b>当前期间</b><span>{period?.period ?? "-"}</span><span className={`badge ${period?.status === "open" ? "doing" : "done"}`}>{period?.status === "open" ? "待结账" : period?.status === "closed" ? "已结账" : "已锁定"}</span></div>{loading ? <p className="muted">正在执行结账前检查…</p> : error ? <p className="field-err">{error}</p> : check?.issues.length ? <div className="warning-list">{check.issues.map((issue) => <div className="status-row" key={issue.code}><span className="badge warn">阻断</span><span>{issue.message}</span><span className="mono tiny">{issue.code}</span></div>)}</div> : <div className="status-row"><span className="badge done">检查通过</span><span>当前期间满足结账前置条件。</span></div>}<div className="row-actions" style={{ marginTop: 16 }}>{period?.status === "open" && <button className="btn-primary" disabled={busy || !check?.ready} onClick={close}>结账</button>}{period?.status === "closed" && <button className="btn-danger-outline" disabled={busy} onClick={reopen}>反结账</button>}</div></div></>;
}

function VoucherDialog({ open, book, period, accounts, onClose, onSaved }: { open: boolean; book: FinanceBook; period: FinancePeriod | null; accounts: FinanceAccount[]; onClose: () => void; onSaved: () => void }) {
  const [summary, setSummary] = useState("");
  const [debitAccount, setDebitAccount] = useState("");
  const [creditAccount, setCreditAccount] = useState("");
  const [amount, setAmount] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const leaves = useMemo(() => accounts.filter((item) => item.is_leaf && item.is_active && !item.aux_flags?.cashflow), [accounts]);
  async function save() {
    if (!period || !debitAccount || !creditAccount || Number(amount) <= 0) { setError("请填写期间、借方科目、贷方科目和正数金额"); return; }
    setSaving(true); setError("");
    try {
      await financeApi.createVoucher(book.code, { period_id: period.id, voucher_no: `记-${String(Date.now()).slice(-4)}`, voucher_date: period.start_date, summary, lines: [{ account_id: Number(debitAccount), summary, debit: amount, credit: "0", aux_detail: {} }, { account_id: Number(creditAccount), summary, debit: "0", credit: amount, aux_detail: {} }] });
      onSaved();
    } catch (e) { setError(errText(e)); } finally { setSaving(false); }
  }
  return <Dialog open={open} onClose={onClose} title="新建凭证" size="md" footer={<><button className="btn-ghost" onClick={onClose}>取消</button><button className="btn-primary" disabled={saving} onClick={save}>{saving ? "保存中…" : "保存草稿"}</button></>}><div className="form-grid"><label className="field span-2"><span className="field-label">摘要</span><input value={summary} onChange={(event) => setSummary(event.target.value)} placeholder="例如：办公费" /></label><label className="field"><span className="field-label">借方科目</span><select value={debitAccount} onChange={(event) => setDebitAccount(event.target.value)}><option value="">请选择</option>{leaves.map((item) => <option key={item.id} value={item.id}>{item.code} {item.name}</option>)}</select></label><label className="field"><span className="field-label">贷方科目</span><select value={creditAccount} onChange={(event) => setCreditAccount(event.target.value)}><option value="">请选择</option>{leaves.map((item) => <option key={item.id} value={item.id}>{item.code} {item.name}</option>)}</select></label><label className="field"><span className="field-label">金额</span><input inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="0.00" /></label></div>{error && <div className="field-err" role="alert">{error}</div>}<p className="tiny muted">当前首期只提供手工草稿录入；凭证审核、过账和账簿取数由后端状态机控制。</p></Dialog>;
}

function BookDialog({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: () => void }) {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  async function save() {
    if (!code.trim() || !name.trim()) { setError("请填写账套编码和名称"); return; }
    setSaving(true); setError("");
    try { await financeApi.books.create({ code: code.trim(), name: name.trim(), base_currency: "CNY" }); onSaved(); setCode(""); setName(""); } catch (e) { setError(errText(e)); } finally { setSaving(false); }
  }
  return <Dialog open={open} onClose={onClose} title="新建账套" size="sm" footer={<><button className="btn-ghost" onClick={onClose}>取消</button><button className="btn-primary" disabled={saving} onClick={save}>{saving ? "创建中…" : "创建账套"}</button></>}><div className="form-grid"><label className="field"><span className="field-label">账套编码</span><input value={code} onChange={(event) => setCode(event.target.value)} placeholder="AB-2026-001" /></label><label className="field"><span className="field-label">账套名称</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="某某公司" /></label></div>{error && <div className="field-err" role="alert">{error}</div>}<p className="tiny muted">创建后自动生成本年度自然月期间和预置科目树。</p></Dialog>;
}

function TemplateDialog({ open, book, period, accounts, templates, onClose, onSaved, onGenerated }: { open: boolean; book: string; period: FinancePeriod | null; accounts: FinanceAccount[]; templates: { id: number; code: string; name: string }[]; onClose: () => void; onSaved: () => void; onGenerated: () => void }) {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [selected, setSelected] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const leaves = accounts.filter((account) => account.is_leaf && account.is_active && !account.aux_flags?.cashflow);
  async function create() {
    if (!code.trim() || !name.trim() || leaves.length < 2) { setError("请填写模板信息，并确保科目树已加载"); return; }
    setSaving(true); setError("");
    try { await financeApi.createTemplate(book, { code: code.trim(), name: name.trim(), lines: [{ account_id: leaves[0].id, summary: name.trim(), debit: "100.00", credit: "0", aux_detail: {} }, { account_id: leaves[1].id, summary: name.trim(), debit: "0", credit: "100.00", aux_detail: {} }] }); onSaved(); } catch (e) { setError(errText(e)); } finally { setSaving(false); }
  }
  async function generate() {
    if (!selected || !period) { setError("请选择模板和当前期间"); return; }
    setSaving(true); setError("");
    try { await financeApi.fromTemplate(book, { template_id: Number(selected), period_id: period.id, voucher_no: `记-${String(Date.now()).slice(-4)}`, voucher_date: period.start_date, summary: "按模板生成" }); onGenerated(); } catch (e) { setError(errText(e)); } finally { setSaving(false); }
  }
  return <Dialog open={open} onClose={onClose} title="凭证模板" size="md" footer={<><button className="btn-ghost" onClick={onClose}>关闭</button><button className="btn-ghost" disabled={saving} onClick={create}>保存当前科目模板</button><button className="btn-primary" disabled={saving} onClick={generate}>生成草稿凭证</button></>}><div className="form-grid"><label className="field"><span className="field-label">模板</span><select value={selected} onChange={(event) => setSelected(event.target.value)}><option value="">请选择模板</option>{templates.map((template) => <option key={template.id} value={template.id}>{template.code} · {template.name}</option>)}</select></label><label className="field"><span className="field-label">新模板编码</span><input value={code} onChange={(event) => setCode(event.target.value)} placeholder="OFFICE" /></label><label className="field span-2"><span className="field-label">新模板名称</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="办公费模板" /></label></div>{error && <div className="field-err" role="alert">{error}</div>}<p className="tiny muted">模板保存当前科目树的首个借贷科目组合；Excel 导入适合批量凭证，导出会记录审计。</p></Dialog>;
}

export default function FinancePage() {
  return <Suspense fallback={<LoadingBlock kpis={4} label="加载财务管理…" />}><FinanceInner /></Suspense>;
}
