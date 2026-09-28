"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import PageHeader from "@/components/ui/PageHeader";
import { CardItem, CardList, DesktopTable } from "@/components/ui/CardList";
import { LoadingBlock, LoadFailed } from "@/components/ui/PageState";
import { useAsyncData } from "@/lib/useAsyncData";
import { useMenus, useMeta } from "@/lib/useMeta";
import { authApi, errText, equipmentAssetActions, equipmentAssetsApi as api, type EquipmentAsset, type EquipmentBatch, type EquipmentCategory, type EquipmentEvent, type EquipmentStatistics, type EquipmentWrite } from "@/lib/api";
import "./assets.css";

type Section = "overview" | "ledger" | "inbound" | "batches" | "overdue" | "statistics" | "categories";
const SECTIONS: { id: Section; label: string }[] = [
  { id: "overview", label: "总览" }, { id: "ledger", label: "设备台账" }, { id: "inbound", label: "入库" },
  { id: "batches", label: "入库批次" }, { id: "overdue", label: "逾期借用" }, { id: "statistics", label: "统计" }, { id: "categories", label: "分类维护" },
];
const STATUS: Record<string, string> = { pending_acceptance: "待验收", available: "可用", claimed: "已领用", borrowed: "借用中", maintenance: "维修中", scrapped: "已报废", void: "已作废" };

export default function AssetsPage() {
  return <Suspense fallback={<LoadingBlock label="加载资产模块…" />}><AssetsInner /></Suspense>;
}

function AssetsInner() {
  const { isAdmin } = useMenus();
  const { users } = useMeta();
  const userName = useCallback((id: number | null) => id === null ? "—" : users.find((u) => u.id === id)?.real_name || `用户 ${id}`, [users]);
  const [section, setSection] = useState<Section>("overview");
  const [selected, setSelected] = useState<EquipmentAsset | null>(null);
  const [filters, setFilters] = useState({ keyword: "", category_code: "", status: "", holder_id: "" });
  const [page, setPage] = useState(1);
  const [batchPage, setBatchPage] = useState(1);
  const [overduePage, setOverduePage] = useState(1);
  const [batchLoadingId, setBatchLoadingId] = useState<number | null>(null);
  const [toast, setToast] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { data, loading, error: loadError, reload } = useAsyncData(async (signal) => {
    const [overview, categories, stats, me] = await Promise.all([
      api.overview(signal), api.categories(signal), api.statistics(signal), authApi.me(signal),
    ]);
    return { overview, categories, stats, me };
  }, [], { resetOnDepChange: false });
  const categories = data?.categories ?? [];
  useEffect(() => { setPage(1); }, [filters.keyword, filters.category_code, filters.status, filters.holder_id]);
  const { data: ledgerData, loading: ledgerLoading, reload: reloadLedger } = useAsyncData(
    (signal) => api.list({ keyword: filters.keyword.trim(), category_code: filters.category_code, status: filters.status, holder_id: filters.holder_id, page, size: 20 }, signal),
    [filters.keyword, filters.category_code, filters.status, filters.holder_id, page],
    { resetOnDepChange: true },
  );
  const { data: batchesData, loading: batchesLoading, reload: reloadBatches } = useAsyncData(
    (signal) => api.batches(batchPage, 100, signal), [batchPage], { resetOnDepChange: true },
  );
  const { data: overdueData, loading: overdueLoading, reload: reloadOverdue } = useAsyncData(
    (signal) => api.overdue(overduePage, 100, signal), [overduePage], { resetOnDepChange: true },
  );
  const [events, setEvents] = useState<EquipmentEvent[]>([]);
  const [batch, setBatch] = useState<EquipmentBatch | null>(null);

  const notify = (message: string) => { setToast(message); window.setTimeout(() => setToast(""), 3200); };
  const refresh = useCallback(async () => { await reload(); }, [reload]);
  const loadBatch = async (id: number) => {
    setBatchLoadingId(id);
    setError("");
    try { setBatch(await api.batch(id)); }
    catch (e) { setError(errText(e)); }
    finally { setBatchLoadingId(null); }
  };
  const openAsset = async (asset: EquipmentAsset) => {
    setSelected(asset); setEvents([]); setBatch(null);
    try {
      const [detail, history] = await Promise.all([api.get(asset.id), api.events(asset.id)]);
      setSelected(detail); setEvents(history.items);
      if (detail.batch_id) setBatch(await api.batch(detail.batch_id));
    } catch (e) { setError(errText(e)); }
  };
  const perform = async (action: () => Promise<unknown>, success = "操作完成") => {
    setBusy(true); setError("");
    try { await action(); notify(success); await refresh(); reloadLedger(); reloadBatches(); reloadOverdue(); if (selected) await openAsset(selected); }
    catch (e) { setError(errText(e)); }
    finally { setBusy(false); }
  };
  const exportAssets = async (format: "csv" | "xlsx") => {
    setError("");
    try { await api.export(format); } catch (e) { setError(errText(e)); }
  };
  const visibleRows = ledgerData?.items ?? [];

  return <main className="asset-module">
    <PageHeader title="公司设备资产" actions={isAdmin ? <><label className="btn-ghost asset-import-button">导入 CSV / Excel<input type="file" accept=".csv,.xlsx" onChange={(e) => { const file = e.currentTarget.files?.[0]; if (file) void perform(() => api.upload(file), "导入完成"); e.currentTarget.value = ""; }} /></label><button className="btn-ghost" onClick={() => void exportAssets("csv")}>导出 CSV</button><button className="btn-ghost" onClick={() => void exportAssets("xlsx")}>导出 Excel</button></> : null} />
    <p className="asset-intro">公司设备台账、入库和领用借用记录。</p>
    {loadError && <LoadFailed message={loadError} onRetry={reload} />}{error && <div className="asset-error" role="alert">{error}</div>}{toast && <div className="asset-toast" role="status">{toast}</div>}
    <nav className="asset-tabs" aria-label="资产模块分区">{SECTIONS.filter((s) => s.id !== "categories" || isAdmin).map((s) => <button key={s.id} className={section === s.id ? "active" : ""} onClick={() => setSection(s.id)}>{s.label}</button>)}</nav>
    {loading && !data ? <LoadingBlock label="正在读取设备资产…" /> : data && <>
      {section === "overview" && <Overview overview={data.overview} stats={data.stats} categories={categories} onSection={setSection} />}
      {section === "ledger" && <section className="asset-panel"><div className="asset-filters"><input aria-label="搜索设备" placeholder="编号、名称、序列号…" value={filters.keyword} onChange={(e) => setFilters({ ...filters, keyword: e.target.value })} /><select aria-label="设备分类" value={filters.category_code} onChange={(e) => setFilters({ ...filters, category_code: e.target.value })}><option value="">全部分类</option>{categories.map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}</select><select aria-label="设备状态" value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })}><option value="">全部状态</option>{Object.entries(STATUS).map(([v, label]) => <option key={v} value={v}>{label}</option>)}</select>{filters.holder_id && <button className="btn-ghost" onClick={() => setFilters({ ...filters, holder_id: "" })}>清除使用人筛选</button>}</div>{ledgerLoading && !ledgerData ? <LoadingBlock label="读取设备台账…" /> : <><AssetRows rows={visibleRows} categories={categories} onOpen={openAsset} userName={userName} /><div className="asset-pagination"><span>第 {page} 页 · 共 {ledgerData?.total ?? 0} 件</span><button className="btn-ghost" disabled={page <= 1 || ledgerLoading} onClick={() => setPage(page - 1)}>上一页</button><button className="btn-ghost" disabled={page * 20 >= (ledgerData?.total ?? 0) || ledgerLoading} onClick={() => setPage(page + 1)}>下一页</button></div></>}</section>}
      {section === "inbound" && isAdmin && <InboundForm categories={categories} busy={busy} onSubmit={(body) => perform(() => api.inbound(body), "已建立入库批次")} />}
      {section === "batches" && <section className="asset-panel"><h2>入库批次</h2>{batchesLoading && !batchesData ? <LoadingBlock label="读取入库批次…" /> : batchesData && <><div className="asset-batch-list">{batchesData.items.map((b) => <article key={b.id}><div><b>批次 #{b.id}</b><span>{b.source || "未填写来源"} · {b.supplier || "未填写供应商"}</span><small>采购单 {b.purchase_order_no || "—"} · 发票 {b.invoice_no || "—"}</small></div><span className={`asset-status ${b.acceptance_status}`}>{b.acceptance_status === "accepted" ? "已验收" : "待验收"}</span>{b.acceptance_status === "pending_acceptance" && isAdmin && <button disabled={busy} className="btn-primary" onClick={() => perform(() => api.acceptBatch(b.id), "批次验收完成")}>确认验收</button>}<button className="btn-ghost" disabled={batchLoadingId === b.id} onClick={() => void loadBatch(b.id)}>{batchLoadingId === b.id ? "读取中…" : "查看设备"}</button>{batch?.id === b.id && <div className="asset-batch-assets">{batch.items?.map((a) => <button key={a.id} onClick={() => openAsset(a)}>{a.code} · {a.name}</button>)}</div>}</article>)}</div><div className="asset-pagination"><span>第 {batchesData.page} 页 · 共 {batchesData.total} 批</span><button className="btn-ghost" disabled={batchesData.page <= 1 || batchesLoading} onClick={() => setBatchPage(batchesData.page - 1)}>上一页批次</button><button className="btn-ghost" disabled={batchesData.page * batchesData.size >= batchesData.total || batchesLoading} onClick={() => setBatchPage(batchesData.page + 1)}>下一页批次</button></div></>}</section>}
      {section === "overdue" && <section className="asset-panel"><h2>逾期借用 <span className="asset-count">{overdueData?.total ?? 0}</span></h2>{overdueLoading && !overdueData ? <LoadingBlock label="读取逾期借用…" /> : overdueData && <><AssetRows rows={overdueData.items} categories={categories} onOpen={openAsset} userName={userName} /><div className="asset-pagination"><span>第 {overdueData.page} 页 · 共 {overdueData.total} 件</span><button className="btn-ghost" disabled={overdueData.page <= 1 || overdueLoading} onClick={() => setOverduePage(overdueData.page - 1)}>上一页逾期</button><button className="btn-ghost" disabled={overdueData.page * overdueData.size >= overdueData.total || overdueLoading} onClick={() => setOverduePage(overdueData.page + 1)}>下一页逾期</button></div></>}</section>}
      {section === "statistics" && <Statistics stats={data.stats} categories={categories} onHolder={(id) => { setFilters({ ...filters, holder_id: String(id) }); setSection("ledger"); }} />}
      {section === "categories" && isAdmin && <CategoryManager categories={categories} busy={busy} onChange={async () => { await refresh(); }} onError={(e) => setError(errText(e))} onToast={notify} />}
    </>}
    {selected && <AssetDetail asset={selected} categories={categories} batch={batch} events={events} userName={userName} isAdmin={isAdmin} currentUser={data?.me.id} busy={busy} onClose={() => setSelected(null)} onEdit={(body) => perform(() => api.update(selected.id, body), "档案已更新")} onAction={(action, body) => perform(() => action === "claim" ? api.claim(selected.id, body) : action === "borrow" ? api.borrow(selected.id, body) : action === "return" ? api.return(selected.id, body) : api.transition(selected.id, action, body), "设备状态已更新")} />}
  </main>;
}

function Overview({ overview, stats, categories, onSection }: { overview: { total: number; by_status: Record<string, number>; overdue: number }; stats: EquipmentStatistics; categories: EquipmentCategory[]; onSection: (s: Section) => void }) {
  return <><div className="asset-kpis"><button onClick={() => onSection("ledger")}><span>设备总数</span><b>{overview.total}</b></button><button onClick={() => { onSection("ledger"); }}><span>可用设备</span><b>{overview.by_status.available ?? 0}</b></button><button onClick={() => onSection("batches")}><span>待验收</span><b>{overview.by_status.pending_acceptance ?? 0}</b></button><button onClick={() => onSection("overdue")}><span>逾期借用</span><b className={overview.overdue ? "alert" : ""}>{overview.overdue}</b></button></div><div className="asset-panel"><div className="asset-panel-heading"><div><h2>设备状态</h2><p>按当前台账状态汇总</p></div><button className="btn-ghost" onClick={() => onSection("statistics")}>查看统计</button></div><div className="asset-status-grid">{Object.entries(STATUS).map(([key, label]) => <div key={key}><span>{label}</span><b>{overview.by_status[key] ?? 0}</b></div>)}</div><h3>分类分布</h3><div className="asset-status-grid">{stats.by_category.map((c) => <div key={c.category_code}><span>{categories.find((item) => item.code === c.category_code)?.label ?? c.category_code}</span><b>{c.count}</b></div>)}</div></div></>;
}

function AssetRows({ rows, categories, onOpen, userName }: { rows: EquipmentAsset[]; categories: EquipmentCategory[]; onOpen: (a: EquipmentAsset) => void; userName: (id: number | null) => string }) {
  const label = (code: string) => categories.find((c) => c.code === code)?.label ?? code;
  return <><CardList label="设备台账">{rows.map((a) => <CardItem key={a.id} title={a.name} code={a.code} fields={[{ label: "分类", value: label(a.category_code) }, { label: "状态", value: STATUS[a.status] ?? a.status }, { label: "使用人", value: userName(a.holder_id) }, { label: "到期日", value: a.due_date ?? "—" }, { label: "位置", value: a.location ?? "—" }]} actions={<button className="btn-ghost" onClick={() => onOpen(a)}>详情</button>} />)}</CardList><DesktopTable><table className="grid"><thead><tr><th>编号 / 名称</th><th>分类</th><th>状态</th><th>使用人</th><th>到期日</th><th>位置</th><th /></tr></thead><tbody>{rows.map((a) => <tr key={a.id}><td><b>{a.code}</b><div>{a.name}</div></td><td>{label(a.category_code)}</td><td><span className={`asset-status ${a.status}`}>{STATUS[a.status]}</span></td><td>{userName(a.holder_id)}</td><td>{a.due_date ?? "—"}</td><td>{a.location ?? "—"}</td><td><button className="btn-ghost" onClick={() => onOpen(a)}>查看</button></td></tr>)}</tbody></table></DesktopTable>{rows.length === 0 && <div className="asset-empty">没有符合条件的设备</div>}</>;
}

function InboundForm({ categories, busy, onSubmit }: { categories: EquipmentCategory[]; busy: boolean; onSubmit: (body: { source?: string; supplier?: string; purchase_order_no?: string; invoice_no?: string; acceptance_status: "pending_acceptance" | "accepted"; note?: string; items: EquipmentWrite[] }) => void }) {
  const [count, setCount] = useState(1); const [acceptance, setAcceptance] = useState<"pending_acceptance" | "accepted">("accepted");
  const submit = (e: React.FormEvent<HTMLFormElement>) => { e.preventDefault(); const fd = new FormData(e.currentTarget); const items = Array.from({ length: count }, (_, i) => ({ name: String(fd.get(`name-${i}`) || "").trim(), category_code: String(fd.get(`category-${i}`) || ""), serial_number: String(fd.get(`serial-${i}`) || "").trim() || undefined, brand: String(fd.get(`brand-${i}`) || "").trim() || undefined, model: String(fd.get(`model-${i}`) || "").trim() || undefined, location: String(fd.get(`location-${i}`) || "").trim() || undefined, purchase_date: String(fd.get(`purchase_date-${i}`) || "") || undefined, purchase_price: fd.get(`purchase_price-${i}`) ? Number(fd.get(`purchase_price-${i}`)) : undefined })); onSubmit({ source: String(fd.get("source") || ""), supplier: String(fd.get("supplier") || ""), purchase_order_no: String(fd.get("purchase_order_no") || ""), invoice_no: String(fd.get("invoice_no") || ""), acceptance_status: acceptance, note: String(fd.get("note") || ""), items }); };
  return <form className="asset-panel asset-form" onSubmit={submit}><div className="asset-panel-heading"><div><h2>登记设备入库</h2><p>同一批次可录入多件设备；待验收设备验收后才可领用或借用。</p></div><label>设备件数 <input type="number" min={1} max={30} value={count} onChange={(e) => setCount(Math.max(1, Math.min(30, Number(e.target.value))))} /></label></div><div className="asset-form-grid"><label>来源<input name="source" placeholder="采购 / 调拨 / 捐赠" /></label><label>供应商<input name="supplier" /></label><label>采购单号<input name="purchase_order_no" /></label><label>发票号<input name="invoice_no" /></label><label>验收状态<select value={acceptance} onChange={(e) => setAcceptance(e.target.value as typeof acceptance)}><option value="accepted">已验收</option><option value="pending_acceptance">待验收</option></select></label><label className="wide">批次备注<input name="note" /></label></div>{Array.from({ length: count }, (_, i) => <fieldset key={i} className="asset-item-form"><legend>设备 {i + 1}</legend><div className="asset-form-grid"><label>名称<input name={`name-${i}`} required /></label><label>分类<select name={`category-${i}`} required defaultValue={categories[0]?.code ?? ""}>{categories.map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}</select></label><label>序列号<input name={`serial-${i}`} /></label><label>品牌<input name={`brand-${i}`} /></label><label>型号<input name={`model-${i}`} /></label><label>存放位置<input name={`location-${i}`} /></label><label>购置日期<input type="date" name={`purchase_date-${i}`} /></label><label>购置金额<input type="number" step="0.01" min="0" name={`purchase_price-${i}`} /></label></div></fieldset>)}<button className="btn-primary" disabled={busy}>{busy ? "提交中…" : `登记 ${count} 件设备`}</button></form>;
}

function Statistics({ stats, categories, onHolder }: { stats: EquipmentStatistics; categories: EquipmentCategory[]; onHolder: (id: number) => void }) {
  return <div className="asset-stat-columns"><section className="asset-panel"><h2>分类占比</h2>{stats.by_category.map((x) => <div className="asset-stat-row" key={x.category_code}><span>{categories.find((c) => c.code === x.category_code)?.label ?? x.category_code}</span><b>{x.count}</b><i style={{ width: `${Math.max(3, stats.by_category.length ? x.count / Math.max(...stats.by_category.map((r) => r.count)) * 100 : 0)}%` }} /></div>)}</section><section className="asset-panel"><h2>状态数量</h2>{stats.by_status.map((x) => <div className="asset-stat-row" key={x.status}><span>{STATUS[x.status] ?? x.status}</span><b>{x.count}</b></div>)}</section><section className="asset-panel asset-wide"><h2>月度出入库</h2><div className="asset-months">{stats.by_month.map((x) => <div key={x.month}><b>{x.month}</b><span>入库 {x.inbound}</span><span>出库 {x.outbound}</span></div>)}</div></section><section className="asset-panel asset-wide"><h2>使用人设备清单</h2><div className="asset-holder-list">{stats.by_holder.map((x) => <button key={x.user_id} onClick={() => onHolder(x.user_id)}><span>{x.name || `用户 ${x.user_id}`}</span><b>{x.count} 件</b><small>查看其设备明细 →</small></button>)}</div></section></div>;
}

function CategoryManager({ categories, busy, onChange, onError, onToast }: { categories: EquipmentCategory[]; busy: boolean; onChange: () => Promise<void>; onError: (e: unknown) => void; onToast: (s: string) => void }) {
  const [code, setCode] = useState(""); const [label, setLabel] = useState("");
  const save = async (e: React.FormEvent) => { e.preventDefault(); try { await api.createCategory({ code, label }); setCode(""); setLabel(""); await onChange(); onToast("分类已新增"); } catch (err) { onError(err); } };
  return <section className="asset-panel"><h2>资产分类</h2><form className="asset-category-add" onSubmit={save}><label>分类编码<input value={code} onChange={(e) => setCode(e.target.value)} required /></label><label>分类名称<input value={label} onChange={(e) => setLabel(e.target.value)} required /></label><button className="btn-primary" disabled={busy}>新增分类</button></form><div className="asset-category-list">{categories.map((c) => <CategoryRow key={c.code} category={c} onError={onError} onChange={onChange} onToast={onToast} />)}</div></section>;
}
function CategoryRow({ category, onError, onChange, onToast }: { category: EquipmentCategory; onError: (e: unknown) => void; onChange: () => Promise<void>; onToast: (s: string) => void }) {
  const [label, setLabel] = useState(category.label);
  return <div><code>{category.code}</code><input aria-label={`${category.label}分类名称`} value={label} onChange={(e) => setLabel(e.target.value)} /><button className="btn-ghost" onClick={async () => { try { await api.updateCategory(category.code, { label }); await onChange(); onToast("分类已更新"); } catch (e) { onError(e); } }}>保存</button><button className="btn-ghost danger" onClick={async () => { try { await api.deleteCategory(category.code); await onChange(); onToast("分类已删除"); } catch (e) { onError(e); } }}>删除</button></div>;
}

function AssetDetail({ asset, categories, batch, events, userName, isAdmin, currentUser, busy, onClose, onEdit, onAction }: { asset: EquipmentAsset; categories: EquipmentCategory[]; batch: EquipmentBatch | null; events: EquipmentEvent[]; userName: (id: number | null) => string; isAdmin: boolean; currentUser?: number; busy: boolean; onClose: () => void; onEdit: (body: EquipmentWrite) => void; onAction: (action: "claim" | "borrow" | "return" | "maintenance" | "restore" | "scrap" | "void", body: { note?: string; due_date?: string }) => void }) {
  const [note, setNote] = useState(""); const [due, setDue] = useState(""); const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<EquipmentWrite>({ name: asset.name, category_code: asset.category_code, serial_number: asset.serial_number ?? "", brand: asset.brand ?? "", model: asset.model ?? "", location: asset.location ?? "", note: asset.note ?? "", purchase_date: asset.purchase_date ?? "", purchase_price: asset.purchase_price ?? undefined });
  const { canReturn, canClaim, canBorrow } = equipmentAssetActions(asset, isAdmin, currentUser);
  return <div className="asset-overlay" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}><section className="asset-detail" role="dialog" aria-modal="true" aria-label={`${asset.code}设备详情`}><header><div><small>{asset.code}</small><h2>{asset.name}</h2></div><button className="btn-ghost" onClick={onClose} aria-label="关闭详情">关闭</button></header><div className="asset-detail-body"><div className="asset-detail-grid"><div><span>分类</span><b>{categories.find((c) => c.code === asset.category_code)?.label ?? asset.category_code}</b></div><div><span>状态</span><b>{STATUS[asset.status]}</b></div><div><span>持有人</span><b>{userName(asset.holder_id)}</b></div><div><span>到期日</span><b>{asset.due_date ?? "—"}</b></div><div><span>序列号</span><b>{asset.serial_number || "—"}</b></div><div><span>品牌 / 型号</span><b>{[asset.brand, asset.model].filter(Boolean).join(" / ") || "—"}</b></div><div><span>位置</span><b>{asset.location || "—"}</b></div><div><span>购置日期 / 金额</span><b>{asset.purchase_date || "—"} / {asset.purchase_price ?? "—"}</b></div></div>{batch && <section className="asset-detail-batch"><h3>入库批次 #{batch.id} · {batch.acceptance_status === "accepted" ? "已验收" : "待验收"}</h3><p>来源：{batch.source || "—"}　供应商：{batch.supplier || "—"}</p><p>采购单：{batch.purchase_order_no || "—"}　发票：{batch.invoice_no || "—"}</p></section>}
      {isAdmin && <div className="asset-detail-actions">{asset.status === "pending_acceptance" && <span className="asset-muted">待验收设备请在入库批次中完成验收。</span>}{!["void", "scrapped", "pending_acceptance"].includes(asset.status) && <button className="btn-ghost" onClick={() => setEditing(!editing)}>编辑档案</button>}{asset.status === "available" && <button className="btn-ghost" onClick={() => onAction("maintenance", { note })}>送修</button>}{asset.status === "maintenance" && <button className="btn-ghost" onClick={() => onAction("restore", { note })}>恢复可用</button>}{["available", "maintenance"].includes(asset.status) && <button className="btn-ghost danger" onClick={() => onAction("scrap", { note })}>报废</button>}{!["void", "scrapped", "pending_acceptance"].includes(asset.status) && <button className="btn-ghost danger" onClick={() => onAction("void", { note })}>作废</button>}</div>}
      {editing && isAdmin && <form className="asset-edit-form" onSubmit={(e) => { e.preventDefault(); onEdit(form); }}><h3>编辑资产档案</h3><div className="asset-form-grid"><label>名称<input required value={form.name ?? ""} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label><label>分类<select value={form.category_code ?? ""} onChange={(e) => setForm({ ...form, category_code: e.target.value })}>{categories.map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}</select></label><label>序列号<input value={form.serial_number ?? ""} onChange={(e) => setForm({ ...form, serial_number: e.target.value })} /></label><label>品牌<input value={form.brand ?? ""} onChange={(e) => setForm({ ...form, brand: e.target.value })} /></label><label>型号<input value={form.model ?? ""} onChange={(e) => setForm({ ...form, model: e.target.value })} /></label><label>位置<input value={form.location ?? ""} onChange={(e) => setForm({ ...form, location: e.target.value })} /></label></div><button className="btn-primary">保存档案</button></form>}
      {(canClaim || canBorrow) && <div className="asset-detail-actions"><label>借用到期日<input type="date" value={due} onChange={(e) => setDue(e.target.value)} /></label>{canClaim && <button disabled={busy} className="btn-primary" onClick={() => onAction("claim", { note })}>领用</button>}{canBorrow && <button disabled={busy || !due} className="btn-ghost" onClick={() => onAction("borrow", { due_date: due, note })}>借用</button>}</div>}
      {canReturn && <div className="asset-detail-actions"><button disabled={busy} className="btn-primary" onClick={() => onAction("return", { note })}>登记归还</button></div>}
      {(isAdmin || canReturn || asset.status === "available") && <label className="asset-note">操作备注<input value={note} onChange={(e) => setNote(e.target.value)} placeholder="可选" /></label>}
      <h3>设备流水</h3>{events.length ? <ol className="asset-events">{events.map((ev) => <li key={ev.id}><b>{ev.action}</b><span>{ev.from_status ? `${STATUS[ev.from_status] ?? ev.from_status} → ` : ""}{STATUS[ev.to_status ?? ""] ?? ev.to_status ?? ""}</span><time>{new Date(ev.created_at).toLocaleString("zh-CN")}</time>{ev.note && <small>{ev.note}</small>}</li>)}</ol> : <p className="asset-muted">暂无流水记录</p>}</div></section></div>;
}
