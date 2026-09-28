"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import PageHeader from "@/components/ui/PageHeader";
import { CardItem, CardList, DesktopTable } from "@/components/ui/CardList";
import { Drawer } from "@/components/ui/Modal";
import MotionTabs from "@/components/motion/MotionTabs";
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
  const visibleSections = SECTIONS.filter((item) =>
    (item.id !== "categories" && item.id !== "inbound") || isAdmin,
  );
  const visibleRows = ledgerData?.items ?? [];

  return <main className="asset-module">
    <PageHeader title="公司设备资产" actions={isAdmin ? <><label className="btn-ghost asset-import-button">导入 CSV / Excel<input type="file" accept=".csv,.xlsx" aria-label="导入 CSV 或 Excel 台账" onChange={(e) => { const file = e.currentTarget.files?.[0]; if (file) void perform(() => api.upload(file), "导入完成"); e.currentTarget.value = ""; }} /></label><button className="btn-ghost" onClick={() => void exportAssets("csv")}>导出 CSV</button><button className="btn-ghost" onClick={() => void exportAssets("xlsx")}>导出 Excel</button></> : null} />
    <p className="asset-intro">公司设备台账、入库和领用借用记录。</p>
    {loadError && <LoadFailed message={loadError} onRetry={reload} />}{error && <div className="asset-error" role="alert">{error}</div>}{toast && <div className="asset-toast" role="status">{toast}</div>}
    <MotionTabs items={visibleSections} active={section} onChange={setSection}>
    {loading && !data ? <LoadingBlock label="正在读取设备资产…" /> : data && <>
      {section === "overview" && <Overview overview={data.overview} stats={data.stats} categories={categories} onSection={setSection} />}
      {section === "ledger" && <section className="asset-panel"><div className="asset-filters"><input aria-label="搜索设备" placeholder="编号、名称、序列号…" value={filters.keyword} onChange={(e) => setFilters({ ...filters, keyword: e.target.value })} /><select aria-label="设备分类" value={filters.category_code} onChange={(e) => setFilters({ ...filters, category_code: e.target.value })}><option value="">全部分类</option>{categories.map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}</select><select aria-label="设备状态" value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })}><option value="">全部状态</option>{Object.entries(STATUS).map(([v, label]) => <option key={v} value={v}>{label}</option>)}</select>{filters.holder_id && <button className="btn-ghost" onClick={() => setFilters({ ...filters, holder_id: "" })}>清除使用人筛选</button>}</div>{ledgerLoading && !ledgerData ? <LoadingBlock label="读取设备台账…" /> : <><AssetRows rows={visibleRows} categories={categories} onOpen={openAsset} userName={userName} /><div className="asset-pagination"><span>第 {page} 页 · 共 {ledgerData?.total ?? 0} 件</span><button className="btn-ghost" disabled={page <= 1 || ledgerLoading} onClick={() => setPage(page - 1)}>上一页</button><button className="btn-ghost" disabled={page * 20 >= (ledgerData?.total ?? 0) || ledgerLoading} onClick={() => setPage(page + 1)}>下一页</button></div></>}</section>}
      {section === "inbound" && isAdmin && <InboundForm categories={categories} busy={busy} onSubmit={(body) => perform(() => api.inbound(body), "已建立入库批次")} />}
      {section === "batches" && <section className="asset-panel"><div className="asset-panel-heading"><div><h2>入库批次</h2><p>按批次查看来源、验收情况和设备明细</p></div></div>{batchesLoading && !batchesData ? <LoadingBlock label="读取入库批次…" /> : batchesData && <>{batchesData.items.length ? <div className="asset-batch-list">{batchesData.items.map((b) => <article key={b.id}><div><b>批次 #{b.id}</b><span>{b.source || "未填写来源"} · {b.supplier || "未填写供应商"}</span><small>采购单 {b.purchase_order_no || "—"} · 发票 {b.invoice_no || "—"}</small></div><span className={`asset-status ${b.acceptance_status}`}>{b.acceptance_status === "accepted" ? "已验收" : "待验收"}</span>{b.acceptance_status === "pending_acceptance" && isAdmin && <button disabled={busy} className="btn-primary" onClick={() => perform(() => api.acceptBatch(b.id), "批次验收完成")}>确认验收</button>}<button className="btn-ghost" disabled={batchLoadingId === b.id} onClick={() => void loadBatch(b.id)}>{batchLoadingId === b.id ? "读取中…" : "查看设备"}</button>{batch?.id === b.id && <div className="asset-batch-assets">{batch.items?.map((a) => <button key={a.id} onClick={() => openAsset(a)}>{a.code} · {a.name}</button>)}</div>}</article>)}</div> : <div className="asset-empty">暂无入库批次</div>}<div className="asset-pagination"><span>第 {batchesData.page} 页 · 共 {batchesData.total} 批</span><button className="btn-ghost" disabled={batchesData.page <= 1 || batchesLoading} onClick={() => setBatchPage(batchesData.page - 1)}>上一页批次</button><button className="btn-ghost" disabled={batchesData.page * batchesData.size >= batchesData.total || batchesLoading} onClick={() => setBatchPage(batchesData.page + 1)}>下一页批次</button></div></>}</section>}
      {section === "overdue" && <section className="asset-panel"><div className="asset-panel-heading"><div><h2>逾期借用</h2><p>仅展示超过归还日期的设备</p></div><span className="asset-count">{overdueData?.total ?? 0} 件</span></div>{overdueLoading && !overdueData ? <LoadingBlock label="读取逾期借用…" /> : overdueData && <>{overdueData.items.length ? <AssetRows rows={overdueData.items} categories={categories} onOpen={openAsset} userName={userName} /> : <div className="asset-empty">当前没有逾期设备</div>}<div className="asset-pagination"><span>第 {overdueData.page} 页 · 共 {overdueData.total} 件</span><button className="btn-ghost" disabled={overdueData.page <= 1 || overdueLoading} onClick={() => setOverduePage(overdueData.page - 1)}>上一页逾期</button><button className="btn-ghost" disabled={overdueData.page * overdueData.size >= overdueData.total || overdueLoading} onClick={() => setOverduePage(overdueData.page + 1)}>下一页逾期</button></div></>}</section>}
      {section === "statistics" && <Statistics stats={data.stats} categories={categories} onHolder={(id) => { setFilters({ ...filters, holder_id: String(id) }); setSection("ledger"); }} />}
      {section === "categories" && isAdmin && <CategoryManager categories={categories} busy={busy} onChange={async () => { await refresh(); }} onError={(e) => setError(errText(e))} onToast={notify} />}
    </>}
    </MotionTabs>
    {selected && <AssetDetail asset={selected} categories={categories} batch={batch} events={events} userName={userName} isAdmin={isAdmin} currentUser={data?.me.id} busy={busy} onClose={() => setSelected(null)} onEdit={(body) => perform(() => api.update(selected.id, body), "档案已更新")} onAction={(action, body) => perform(() => action === "claim" ? api.claim(selected.id, body) : action === "borrow" ? api.borrow(selected.id, body) : action === "return" ? api.return(selected.id, body) : api.transition(selected.id, action, body), "设备状态已更新")} />}
  </main>;
}

function Overview({ overview, stats, categories, onSection }: { overview: { total: number; by_status: Record<string, number>; overdue: number }; stats: EquipmentStatistics; categories: EquipmentCategory[]; onSection: (s: Section) => void }) {
  return <>
    <div className="asset-kpis">
      <button type="button" onClick={() => onSection("ledger")}><span>设备总数</span><b>{overview.total}</b></button>
      <button type="button" onClick={() => onSection("ledger")}><span>可用设备</span><b>{overview.by_status.available ?? 0}</b></button>
      <button type="button" onClick={() => onSection("batches")}><span>待验收</span><b>{overview.by_status.pending_acceptance ?? 0}</b></button>
      <button type="button" onClick={() => onSection("overdue")}><span>逾期借用</span><b className={overview.overdue ? "alert" : ""}>{overview.overdue}</b></button>
    </div>
    <section className="asset-panel">
      <div className="asset-panel-heading">
        <div><h2>设备状态</h2><p>按当前台账状态汇总</p></div>
        <button type="button" className="btn-ghost" onClick={() => onSection("statistics")}>查看统计</button>
      </div>
      <div className="asset-status-grid">
        {Object.entries(STATUS).map(([key, label]) => <div key={key}><span>{label}</span><b>{overview.by_status[key] ?? 0}</b></div>)}
      </div>
      <div className="asset-panel-heading asset-category-heading"><div><h3>分类分布</h3><p>当前台账中的设备分类</p></div></div>
      {stats.by_category.length ? <div className="asset-status-grid">
        {stats.by_category.map((category) => <div key={category.category_code}><span>{categories.find((item) => item.code === category.category_code)?.label ?? category.category_code}</span><b>{category.count}</b></div>)}
      </div> : <p className="asset-empty asset-empty-inline">暂无分类数据</p>}
    </section>
  </>;
}

function AssetRows({ rows, categories, onOpen, userName }: { rows: EquipmentAsset[]; categories: EquipmentCategory[]; onOpen: (a: EquipmentAsset) => void; userName: (id: number | null) => string }) {
  const label = (code: string) => categories.find((c) => c.code === code)?.label ?? code;
  return <>
    <CardList label="设备台账">{rows.map((asset) => <CardItem
      key={asset.id}
      title={asset.name}
      code={asset.code}
      badges={<span className={`asset-status ${asset.status}`}>{STATUS[asset.status] ?? asset.status}</span>}
      fields={[{ label: "分类", value: label(asset.category_code) }, { label: "使用人", value: userName(asset.holder_id) }, { label: "到期日", value: asset.due_date ?? "—" }, { label: "位置", value: asset.location ?? "—" }]}
      actions={<button type="button" className="btn-ghost" onClick={() => onOpen(asset)}>详情</button>}
    />)}</CardList>
    <DesktopTable><table className="grid"><thead><tr><th>编号 / 名称</th><th>分类</th><th>状态</th><th>使用人</th><th>到期日</th><th>位置</th><th /></tr></thead><tbody>{rows.map((asset) => <tr key={asset.id}><td><b>{asset.code}</b><div>{asset.name}</div></td><td>{label(asset.category_code)}</td><td><span className={`asset-status ${asset.status}`}>{STATUS[asset.status] ?? asset.status}</span></td><td>{userName(asset.holder_id)}</td><td>{asset.due_date ?? "—"}</td><td>{asset.location ?? "—"}</td><td><button type="button" className="btn-ghost" onClick={() => onOpen(asset)}>查看</button></td></tr>)}</tbody></table></DesktopTable>
    {rows.length === 0 && <div className="asset-empty">没有符合条件的设备</div>}
  </>;
}

function InboundForm({ categories, busy, onSubmit }: { categories: EquipmentCategory[]; busy: boolean; onSubmit: (body: { source?: string; supplier?: string; purchase_order_no?: string; invoice_no?: string; acceptance_status: "pending_acceptance" | "accepted"; note?: string; items: EquipmentWrite[] }) => void }) {
  const [count, setCount] = useState(1); const [acceptance, setAcceptance] = useState<"pending_acceptance" | "accepted">("accepted");
  const submit = (e: React.FormEvent<HTMLFormElement>) => { e.preventDefault(); const fd = new FormData(e.currentTarget); const items = Array.from({ length: count }, (_, i) => ({ name: String(fd.get(`name-${i}`) || "").trim(), category_code: String(fd.get(`category-${i}`) || ""), serial_number: String(fd.get(`serial-${i}`) || "").trim() || undefined, brand: String(fd.get(`brand-${i}`) || "").trim() || undefined, model: String(fd.get(`model-${i}`) || "").trim() || undefined, location: String(fd.get(`location-${i}`) || "").trim() || undefined, purchase_date: String(fd.get(`purchase_date-${i}`) || "") || undefined, purchase_price: fd.get(`purchase_price-${i}`) ? Number(fd.get(`purchase_price-${i}`)) : undefined })); onSubmit({ source: String(fd.get("source") || ""), supplier: String(fd.get("supplier") || ""), purchase_order_no: String(fd.get("purchase_order_no") || ""), invoice_no: String(fd.get("invoice_no") || ""), acceptance_status: acceptance, note: String(fd.get("note") || ""), items }); };
  return <form className="asset-panel asset-form" onSubmit={submit}><div className="asset-panel-heading"><div><h2>登记设备入库</h2><p>同一批次可录入多件设备；待验收设备验收后才可领用或借用。</p></div><label>设备件数 <input type="number" min={1} max={30} value={count} onChange={(e) => setCount(Math.max(1, Math.min(30, Number(e.target.value))))} /></label></div><div className="asset-form-grid"><label>来源<input name="source" placeholder="采购 / 调拨 / 捐赠" /></label><label>供应商<input name="supplier" /></label><label>采购单号<input name="purchase_order_no" /></label><label>发票号<input name="invoice_no" /></label><label>验收状态<select value={acceptance} onChange={(e) => setAcceptance(e.target.value as typeof acceptance)}><option value="accepted">已验收</option><option value="pending_acceptance">待验收</option></select></label><label className="wide">批次备注<input name="note" /></label></div>{Array.from({ length: count }, (_, i) => <fieldset key={i} className="asset-item-form"><legend>设备 {i + 1}</legend><div className="asset-form-grid"><label>名称<input name={`name-${i}`} required /></label><label>分类<select name={`category-${i}`} required defaultValue={categories[0]?.code ?? ""}>{categories.map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}</select></label><label>序列号<input name={`serial-${i}`} /></label><label>品牌<input name={`brand-${i}`} /></label><label>型号<input name={`model-${i}`} /></label><label>存放位置<input name={`location-${i}`} /></label><label>购置日期<input type="date" name={`purchase_date-${i}`} /></label><label>购置金额<input type="number" step="0.01" min="0" name={`purchase_price-${i}`} /></label></div></fieldset>)}<button className="btn-primary" disabled={busy}>{busy ? "提交中…" : `登记 ${count} 件设备`}</button></form>;
}

function Statistics({ stats, categories, onHolder }: { stats: EquipmentStatistics; categories: EquipmentCategory[]; onHolder: (id: number) => void }) {
  const categoryTotal = stats.by_category.reduce((total, row) => total + row.count, 0);
  return <div className="asset-stat-columns">
    <section className="asset-panel">
      <div className="asset-panel-heading"><div><h2>分类占比</h2><p>按当前设备总数计算</p></div></div>
      {stats.by_category.length ? stats.by_category.map((row) => {
        const percent = categoryTotal ? (row.count / categoryTotal) * 100 : 0;
        const name = categories.find((category) => category.code === row.category_code)?.label ?? row.category_code;
        return <div className="asset-stat-row" key={row.category_code}>
          <div className="asset-stat-label"><span>{name}</span><b>{row.count} 件 <small>{percent.toFixed(0)}%</small></b></div>
          <div className="asset-stat-track" role="progressbar" aria-label={`${name}占比`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)}><span style={{ width: `${percent}%` }} /></div>
        </div>;
      }) : <p className="asset-empty asset-empty-inline">暂无分类数据</p>}
    </section>
    <section className="asset-panel">
      <div className="asset-panel-heading"><div><h2>状态数量</h2><p>按当前设备状态统计</p></div></div>
      {stats.by_status.length ? stats.by_status.map((row) => <div className="asset-stat-row asset-stat-count" key={row.status}><span>{STATUS[row.status] ?? row.status}</span><b>{row.count}</b></div>) : <p className="asset-empty asset-empty-inline">暂无状态数据</p>}
    </section>
    <section className="asset-panel asset-wide">
      <div className="asset-panel-heading"><div><h2>月度出入库</h2><p>入库与出库记录按月份汇总</p></div></div>
      {stats.by_month.length ? <div className="asset-months">{stats.by_month.map((row) => <div key={row.month}><b>{row.month}</b><span>入库 <strong>{row.inbound}</strong></span><span>出库 <strong>{row.outbound}</strong></span></div>)}</div> : <p className="asset-empty asset-empty-inline">暂无出入库记录</p>}
    </section>
    <section className="asset-panel asset-wide">
      <div className="asset-panel-heading"><div><h2>使用人设备清单</h2><p>选择使用人查看其设备台账</p></div></div>
      {stats.by_holder.length ? <div className="asset-holder-list">{stats.by_holder.map((row) => <button type="button" key={row.user_id} onClick={() => onHolder(row.user_id)}><span>{row.name || `用户 ${row.user_id}`}</span><b>{row.count} 件</b><small>查看设备明细 <span aria-hidden="true">→</span></small></button>)}</div> : <p className="asset-empty asset-empty-inline">暂无使用人设备数据</p>}
    </section>
  </div>;
}

function CategoryManager({ categories, busy, onChange, onError, onToast }: { categories: EquipmentCategory[]; busy: boolean; onChange: () => Promise<void>; onError: (e: unknown) => void; onToast: (s: string) => void }) {
  const [code, setCode] = useState(""); const [label, setLabel] = useState("");
  const save = async (e: React.FormEvent) => { e.preventDefault(); try { await api.createCategory({ code, label }); setCode(""); setLabel(""); await onChange(); onToast("分类已新增"); } catch (err) { onError(err); } };
  return <section className="asset-panel"><h2>资产分类</h2><form className="asset-category-add" onSubmit={save}><label>分类编码<input value={code} onChange={(e) => setCode(e.target.value)} required /></label><label>分类名称<input value={label} onChange={(e) => setLabel(e.target.value)} required /></label><button className="btn-primary" disabled={busy}>新增分类</button></form><div className="asset-category-list">{categories.map((c) => <CategoryRow key={c.code} category={c} onError={onError} onChange={onChange} onToast={onToast} />)}</div></section>;
}
function CategoryRow({ category, onError, onChange, onToast }: { category: EquipmentCategory; onError: (e: unknown) => void; onChange: () => Promise<void>; onToast: (s: string) => void }) {
  const [label, setLabel] = useState(category.label);
  return <div><code>{category.code}</code><input aria-label={`${category.label}分类名称`} value={label} onChange={(e) => setLabel(e.target.value)} /><button type="button" className="btn-ghost" onClick={async () => { try { await api.updateCategory(category.code, { label }); await onChange(); onToast("分类已更新"); } catch (e) { onError(e); } }}>保存</button><button type="button" className="btn-ghost asset-danger" onClick={async () => { try { await api.deleteCategory(category.code); await onChange(); onToast("分类已删除"); } catch (e) { onError(e); } }}>删除</button></div>;
}

function AssetDetail({ asset, categories, batch, events, userName, isAdmin, currentUser, busy, onClose, onEdit, onAction }: { asset: EquipmentAsset; categories: EquipmentCategory[]; batch: EquipmentBatch | null; events: EquipmentEvent[]; userName: (id: number | null) => string; isAdmin: boolean; currentUser?: number; busy: boolean; onClose: () => void; onEdit: (body: EquipmentWrite) => void; onAction: (action: "claim" | "borrow" | "return" | "maintenance" | "restore" | "scrap" | "void", body: { note?: string; due_date?: string }) => void }) {
  const [note, setNote] = useState("");
  const [due, setDue] = useState("");
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<EquipmentWrite>({
    name: asset.name,
    category_code: asset.category_code,
    serial_number: asset.serial_number ?? "",
    brand: asset.brand ?? "",
    model: asset.model ?? "",
    location: asset.location ?? "",
    note: asset.note ?? "",
    purchase_date: asset.purchase_date ?? "",
    purchase_price: asset.purchase_price ?? undefined,
  });
  const { canReturn, canClaim, canBorrow } = equipmentAssetActions(asset, isAdmin, currentUser);
  const categoryName = categories.find((category) => category.code === asset.category_code)?.label ?? asset.category_code;

  return <Drawer
    open
    onClose={onClose}
    title={<><span className="asset-drawer-code">{asset.code}</span><span aria-hidden="true"> · </span>{asset.name}</>}
    width={720}
  >
    <div className="asset-detail">
      <div className="asset-detail-summary" role="group" tabIndex={0} aria-label={`设备状态：${STATUS[asset.status] ?? asset.status}`}><span className={`asset-status ${asset.status}`}>{STATUS[asset.status] ?? asset.status}</span><span>设备档案</span></div>
      <div className="asset-detail-grid">
        <div><span>分类</span><b>{categoryName}</b></div>
        <div><span>使用人</span><b>{userName(asset.holder_id)}</b></div>
        <div><span>到期日</span><b>{asset.due_date ?? "—"}</b></div>
        <div><span>存放位置</span><b>{asset.location || "—"}</b></div>
        <div><span>序列号</span><b>{asset.serial_number || "—"}</b></div>
        <div><span>品牌 / 型号</span><b>{[asset.brand, asset.model].filter(Boolean).join(" / ") || "—"}</b></div>
        <div><span>购置日期</span><b>{asset.purchase_date || "—"}</b></div>
        <div><span>购置金额</span><b>{asset.purchase_price ?? "—"}</b></div>
      </div>

      {batch && <section className="asset-detail-batch">
        <div className="asset-section-heading"><div><h3>入库批次 #{batch.id}</h3><p>批次来源及验收信息</p></div><span className={`asset-status ${batch.acceptance_status}`}>{batch.acceptance_status === "accepted" ? "已验收" : "待验收"}</span></div>
        <dl><div><dt>来源 / 供应商</dt><dd>{batch.source || "—"} / {batch.supplier || "—"}</dd></div><div><dt>采购单 / 发票</dt><dd>{batch.purchase_order_no || "—"} / {batch.invoice_no || "—"}</dd></div></dl>
      </section>}

      {isAdmin && <section className="asset-detail-section">
        <div className="asset-section-heading"><div><h3>设备操作</h3><p>状态变更会记录在设备流水中</p></div></div>
        <div className="asset-detail-actions">
          {asset.status === "pending_acceptance" && <span className="asset-muted">待验收设备请在入库批次中完成验收。</span>}
          {!(["void", "scrapped", "pending_acceptance"].includes(asset.status)) && <button type="button" className="btn-ghost" disabled={busy} onClick={() => setEditing(!editing)}>{editing ? "取消编辑" : "编辑档案"}</button>}
          {asset.status === "available" && <button type="button" className="btn-ghost" disabled={busy} onClick={() => onAction("maintenance", { note })}>送修</button>}
          {asset.status === "maintenance" && <button type="button" className="btn-ghost" disabled={busy} onClick={() => onAction("restore", { note })}>恢复可用</button>}
          {["available", "maintenance"].includes(asset.status) && <button type="button" className="btn-ghost asset-danger" disabled={busy} onClick={() => onAction("scrap", { note })}>报废</button>}
          {!(["void", "scrapped", "pending_acceptance"].includes(asset.status)) && <button type="button" className="btn-ghost asset-danger" disabled={busy} onClick={() => onAction("void", { note })}>作废</button>}
        </div>
        {editing && <form className="asset-edit-form" onSubmit={(event) => { event.preventDefault(); onEdit(form); }}>
          <h4>编辑资产档案</h4>
          <div className="asset-form-grid">
            <label>名称<input required value={form.name ?? ""} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
            <label>分类<select value={form.category_code ?? ""} onChange={(event) => setForm({ ...form, category_code: event.target.value })}>{categories.map((category) => <option key={category.code} value={category.code}>{category.label}</option>)}</select></label>
            <label>序列号<input value={form.serial_number ?? ""} onChange={(event) => setForm({ ...form, serial_number: event.target.value })} /></label>
            <label>品牌<input value={form.brand ?? ""} onChange={(event) => setForm({ ...form, brand: event.target.value })} /></label>
            <label>型号<input value={form.model ?? ""} onChange={(event) => setForm({ ...form, model: event.target.value })} /></label>
            <label>位置<input value={form.location ?? ""} onChange={(event) => setForm({ ...form, location: event.target.value })} /></label>
          </div>
          <button className="btn-primary" disabled={busy}>{busy ? "保存中…" : "保存档案"}</button>
        </form>}
      </section>}

      {(canClaim || canBorrow || canReturn) && <section className="asset-detail-section">
        <div className="asset-section-heading"><div><h3>领用与借用</h3><p>领用或借用后，设备将记录当前使用人</p></div></div>
        <div className="asset-detail-actions">
          {(canClaim || canBorrow) && <label>借用到期日<input type="date" value={due} onChange={(event) => setDue(event.target.value)} /></label>}
          {canClaim && <button type="button" disabled={busy} className="btn-primary" onClick={() => onAction("claim", { note })}>领用</button>}
          {canBorrow && <button type="button" disabled={busy || !due} className="btn-ghost" onClick={() => onAction("borrow", { due_date: due, note })}>借用</button>}
          {canReturn && <button type="button" disabled={busy} className="btn-primary" onClick={() => onAction("return", { note })}>登记归还</button>}
        </div>
      </section>}

      {(isAdmin || canReturn || asset.status === "available") && <label className="asset-note">操作备注<input value={note} onChange={(event) => setNote(event.target.value)} placeholder="可选" /></label>}

      <section className="asset-detail-section asset-event-section">
        <div className="asset-section-heading"><div><h3>设备流水</h3><p>记录入库、领用、借用、归还和状态变化</p></div><span className="asset-event-count">{events.length} 条</span></div>
        {events.length ? <ol className="asset-events">{events.map((event) => <li key={event.id}><b>{event.action}</b><span>{event.from_status ? `${STATUS[event.from_status] ?? event.from_status} → ` : ""}{STATUS[event.to_status ?? ""] ?? event.to_status ?? ""}</span><time>{new Date(event.created_at).toLocaleString("zh-CN")}</time>{event.note && <small>{event.note}</small>}</li>)}</ol> : <p className="asset-empty asset-empty-inline">暂无流水记录</p>}
      </section>
    </div>
  </Drawer>;
}
