"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { DatePicker } from "@/components/ui/DatePicker";
import PageHeader from "@/components/ui/PageHeader";
import { CardItem, CardList, DesktopTable } from "@/components/ui/CardList";
import { Dialog, Drawer } from "@/components/ui/Modal";
import Select from "@/components/ui/Select";
import MotionTabs from "@/components/motion/MotionTabs";
import { LoadingBlock, LoadFailed } from "@/components/ui/PageState";
import { useAsyncData } from "@/lib/useAsyncData";
import { useMenus, useMeta } from "@/lib/useMeta";
import { authApi, errDetail, errText, EQUIPMENT_ACTION_LABELS, equipmentAssetActions, equipmentAssetsApi as api, type EquipmentAsset, type EquipmentBatch, type EquipmentBatchSelection, type EquipmentCategory, type EquipmentDeleteCheck, type EquipmentEvent, type EquipmentImportError, type EquipmentImportResult, type EquipmentInboundInput, type EquipmentOutbound, type EquipmentOutboundInput, type EquipmentStatistics, type EquipmentWrite } from "@/lib/api";
import "./assets.css";

type Section = "overview" | "ledger" | "inbound" | "outbound" | "borrow";
const SECTIONS: { id: Section; label: string }[] = [
  { id: "overview", label: "总览" }, { id: "ledger", label: "设备台账" }, { id: "inbound", label: "入库" },
  { id: "outbound", label: "出库" }, { id: "borrow", label: "借用" },
];
const STATUS: Record<string, string> = { pending_acceptance: "待验收", available: "可用", claimed: "已领用", borrowed: "借用中", maintenance: "维修中", scrapped: "已报废", void: "已作废" };
/** 导入模板的中文列名与填写说明，与 api/routers/equipment_assets.py 的 IMPORT_FIELDS / FIELD_HINTS 保持一致 */
const IMPORT_COLUMNS: { name: string; required: boolean; hint: string }[] = [
  { name: "设备名称", required: true, hint: "必填，同一序列号不可重复登记" },
  { name: "设备分类", required: true, hint: "填分类名称（如「电脑」），也接受编码（如 computer）" },
  { name: "序列号", required: false, hint: "选填，填了则全库唯一" },
  { name: "品牌", required: false, hint: "选填" },
  { name: "型号", required: false, hint: "选填" },
  { name: "存放位置", required: false, hint: "选填" },
  { name: "采购日期", required: false, hint: "选填，支持 2026-01-05、2026/1/5、2026年1月5日" },
  { name: "采购金额", required: false, hint: "选填，填数字，支持 ¥1,200.00" },
  { name: "备注", required: false, hint: "选填" },
];

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
  const [outboundPage, setOutboundPage] = useState(1);
  const [borrowPage, setBorrowPage] = useState(1);
  const [outboundAsset, setOutboundAsset] = useState<EquipmentAsset | null>(null);
  const [inboundMode, setInboundMode] = useState<"single" | "inventory">("single");
  const [batchPickerRefreshKey, setBatchPickerRefreshKey] = useState(0);
  const [importOpen, setImportOpen] = useState(false);
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
  const { data: outboundsData, loading: outboundsLoading, reload: reloadOutbounds } = useAsyncData(
    (signal) => api.outbounds({ page: outboundPage, size: 20 }, signal), [outboundPage], { resetOnDepChange: true },
  );
  const { data: borrowedData, loading: borrowedLoading, reload: reloadBorrowed } = useAsyncData(
    (signal) => api.list({ status: "borrowed", page: borrowPage, size: 20 }, signal), [borrowPage], { resetOnDepChange: true },
  );
  const [events, setEvents] = useState<EquipmentEvent[]>([]);
  const [batch, setBatch] = useState<EquipmentBatch | null>(null);
  const [deleteCheck, setDeleteCheck] = useState<EquipmentDeleteCheck | null>(null);

  const notify = (message: string) => { setToast(message); window.setTimeout(() => setToast(""), 3200); };
  const refresh = useCallback(async () => { await reload(); }, [reload]);
  const openAsset = async (asset: EquipmentAsset) => {
    setSelected(asset); setEvents([]); setBatch(null); setDeleteCheck(null);
    try {
      const [detail, history, deletion] = await Promise.all([
        api.get(asset.id),
        api.events(asset.id),
        isAdmin ? api.deleteCheck(asset.id) : Promise.resolve(null),
      ]);
      setSelected(detail); setEvents(history.items); setDeleteCheck(deletion);
      if (detail.batch_id) setBatch(await api.batch(detail.batch_id));
    } catch (e) { setError(errText(e)); }
  };
  const perform = async (action: () => Promise<unknown>, success: string | ((result: unknown) => string) = "操作完成") => {
    setBusy(true); setError("");
    try {
      const result = await action();
      notify(typeof success === "function" ? success(result) : success);
      setBatchPickerRefreshKey((key) => key + 1);
      await refresh(); reloadLedger(); reloadOutbounds(); reloadBorrowed();
      if (selected) await openAsset(selected);
    } catch (e) { setError(errText(e)); }
    finally { setBusy(false); }
  };
  const deleteAsset = async (asset: EquipmentAsset, reason: string) => {
    setBusy(true); setError("");
    try {
      await api.remove(asset.id, { confirm_code: asset.code, reason });
      setSelected(null); setEvents([]); setBatch(null); setDeleteCheck(null);
      notify(`资产 ${asset.code} 已永久删除`);
      await refresh();
      reloadLedger(); reloadOutbounds(); reloadBorrowed();
    } catch (e) {
      setError(errText(e));
      throw e;
    } finally {
      setBusy(false);
    }
  };
  const exportAssets = async (format: "csv" | "xlsx") => {
    setError("");
    try { await api.export(format); } catch (e) { setError(errText(e)); }
  };
  const submitOutbound = async (asset: EquipmentAsset, body: EquipmentOutboundInput) => {
    setBusy(true); setError("");
    try {
      const result = await api.outbound(asset.id, body);
      notify(`已出库 ${result.quantity} 件，剩余 ${result.available_quantity} 件`);
      await refresh();
      reloadLedger(); reloadOutbounds(); reloadBorrowed();
      if (selected) await openAsset(selected);
    } catch (e) {
      setError(errText(e));
      throw e;
    } finally {
      setBusy(false);
    }
  };
  const visibleSections = SECTIONS;
  const visibleRows = ledgerData?.items ?? [];

  return <main className="asset-module">
    <PageHeader title="公司设备资产" actions={section === "inbound" ? <div className="asset-header-actions"><button type="button" className={inboundMode === "single" ? "btn-primary" : "btn-ghost"} aria-pressed={inboundMode === "single"} onClick={() => setInboundMode("single")}>单件入库</button><button type="button" className={inboundMode === "inventory" ? "btn-primary" : "btn-ghost"} aria-pressed={inboundMode === "inventory"} onClick={() => setInboundMode("inventory")}>批量入库</button></div> : section === "ledger" && isAdmin ? <div className="asset-header-actions"><button className="btn-ghost" onClick={() => setImportOpen(true)}>导入台账</button><button className="btn-ghost" onClick={() => void exportAssets("csv")}>导出 CSV</button><button className="btn-ghost" onClick={() => void exportAssets("xlsx")}>导出 Excel</button></div> : null} />
    {importOpen && <ImportDialog categories={categories} batchPickerRefreshKey={batchPickerRefreshKey} onClose={() => setImportOpen(false)} onImported={(result) => { setImportOpen(false); notify(`已导入 ${result.created} 件设备，归入「${result.batch_name} · 批次 #${result.batch_id}」`); setBatchPickerRefreshKey((key) => key + 1); void refresh(); reloadLedger(); }} />}
    {loadError && <LoadFailed message={loadError} onRetry={reload} />}{error && <div className="asset-error" role="alert">{error}</div>}{toast && <div className="asset-toast" role="status">{toast}</div>}
    <MotionTabs items={visibleSections} active={section} onChange={setSection} panelOffset={0}>
    {loading && !data ? <LoadingBlock label="正在读取设备资产…" /> : data && <>
      {section === "overview" && <Overview overview={data.overview} stats={data.stats} categories={categories} onSection={setSection} onBorrow={() => setSection("borrow")} onPending={() => { setFilters((current) => ({ ...current, status: "pending_acceptance" })); setSection("ledger"); }} />}
      {section === "ledger" && <section className="asset-panel"><div className="asset-filters"><input aria-label="搜索设备" placeholder="编号、名称、序列号…" value={filters.keyword} onChange={(e) => setFilters({ ...filters, keyword: e.target.value })} /><Select aria-label="设备分类" value={filters.category_code} onChange={(value) => setFilters({ ...filters, category_code: value })}><option value="">全部分类</option>{categories.map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}</Select><Select aria-label="设备状态" value={filters.status} onChange={(value) => setFilters({ ...filters, status: value })}><option value="">全部状态</option>{Object.entries(STATUS).map(([v, label]) => <option key={v} value={v}>{label}</option>)}</Select>{filters.holder_id && <button className="btn-ghost" onClick={() => setFilters({ ...filters, holder_id: "" })}>清除使用人筛选</button>}</div>{ledgerLoading && !ledgerData ? <LoadingBlock label="读取设备台账…" /> : <><AssetRows rows={visibleRows} categories={categories} onOpen={openAsset} onOutbound={setOutboundAsset} isAdmin={isAdmin} userName={userName} /><div className="asset-pagination"><span>第 {page} 页 · 共 {ledgerData?.total ?? 0} 条记录</span><button className="btn-ghost" disabled={page <= 1 || ledgerLoading} onClick={() => setPage(page - 1)}>上一页</button><button className="btn-ghost" disabled={page * 20 >= (ledgerData?.total ?? 0) || ledgerLoading} onClick={() => setPage(page + 1)}>下一页</button></div></>}</section>}
      {section === "inbound" && <InboundForm categories={categories} inventoryManaged={inboundMode === "inventory"} busy={busy} refreshKey={batchPickerRefreshKey} onSubmit={(body) => perform(() => api.inbound(body), (result) => { const batch = result as EquipmentBatch; return `已登记到台账「${batch.name}」`; })} />}
      {section === "outbound" && <section className="asset-panel"><div className="asset-panel-heading"><div><h2>出库记录</h2></div><span className="asset-count">{outboundsData?.total ?? 0} 条</span></div>{outboundsLoading && !outboundsData ? <LoadingBlock label="读取出库记录…" /> : outboundsData && <><OutboundRows rows={outboundsData.items} /><div className="asset-pagination"><span>第 {outboundsData.page} 页 · 共 {outboundsData.total} 条</span><button className="btn-ghost" disabled={outboundsData.page <= 1 || outboundsLoading} onClick={() => setOutboundPage(outboundsData.page - 1)}>上一页</button><button className="btn-ghost" disabled={outboundsData.page * outboundsData.size >= outboundsData.total || outboundsLoading} onClick={() => setOutboundPage(outboundsData.page + 1)}>下一页</button></div></>}</section>}
      {section === "borrow" && <section className="asset-panel"><div className="asset-panel-heading"><div><h2>借用中的设备</h2></div><span className="asset-count">{borrowedData?.total ?? 0} 件</span></div>{borrowedLoading && !borrowedData ? <LoadingBlock label="读取借用记录…" /> : borrowedData && <>{borrowedData.items.length ? <AssetRows rows={borrowedData.items} categories={categories} onOpen={openAsset} onOutbound={setOutboundAsset} isAdmin={isAdmin} userName={userName} /> : <div className="asset-empty">当前没有借用中的设备</div>}<div className="asset-pagination"><span>第 {borrowedData.page} 页 · 共 {borrowedData.total} 件</span><button className="btn-ghost" disabled={borrowedData.page <= 1 || borrowedLoading} onClick={() => setBorrowPage(borrowedData.page - 1)}>上一页</button><button className="btn-ghost" disabled={borrowedData.page * borrowedData.size >= borrowedData.total || borrowedLoading} onClick={() => setBorrowPage(borrowedData.page + 1)}>下一页</button></div></>}</section>}
    </>}
    </MotionTabs>
    {selected && <AssetDetail asset={selected} categories={categories} batch={batch} events={events} deleteCheck={deleteCheck} userName={userName} isAdmin={isAdmin} currentUser={data?.me.id} busy={busy} onClose={() => setSelected(null)} onEdit={(body) => perform(() => api.update(selected.id, body), "档案已更新")} onAction={(action, body) => perform(() => action === "claim" ? api.claim(selected.id, body) : action === "borrow" ? api.borrow(selected.id, body) : action === "return" ? api.return(selected.id, body) : api.transition(selected.id, action, body), "设备状态已更新")} onDelete={(reason) => deleteAsset(selected, reason)} onAcceptBatch={(batchId) => { void perform(() => api.acceptBatch(batchId), "批次全部待验收设备已验收"); }} onOutbound={() => setOutboundAsset(selected)} />}
    {outboundAsset && <OutboundDialog asset={outboundAsset} busy={busy} onClose={() => setOutboundAsset(null)} onSubmit={async (body) => { await submitOutbound(outboundAsset, body); setOutboundAsset(null); }} />}
  </main>;
}

function Overview({ overview, stats, categories, onSection, onBorrow, onPending }: { overview: { total: number; by_status: Record<string, number>; overdue: number }; stats: EquipmentStatistics; categories: EquipmentCategory[]; onSection: (s: Section) => void; onBorrow: () => void; onPending: () => void }) {
  return <>
    <div className="asset-kpis">
      <button type="button" onClick={() => onSection("ledger")}><span>实物总数</span><b>{overview.total}</b></button>
      <button type="button" onClick={() => onSection("ledger")}><span>可用实物</span><b>{overview.by_status.available ?? 0}</b></button>
      <button type="button" onClick={onPending}><span>待验收</span><b>{overview.by_status.pending_acceptance ?? 0}</b></button>
      <button type="button" onClick={onBorrow}><span>逾期借用</span><b className={overview.overdue ? "alert" : ""}>{overview.overdue}</b></button>
    </div>
    <p className="asset-count-note">总览、分类与状态按实物数量统计；台账分页总数按入库记录数统计。</p>
    <section className="asset-panel">
      <div className="asset-panel-heading">
        <div><h2>设备状态</h2></div>
      </div>
      <div className="asset-status-grid">
        {Object.entries(STATUS).map(([key, label]) => <div key={key}><span>{label}</span><b>{overview.by_status[key] ?? 0}</b></div>)}
      </div>
      <div className="asset-panel-heading asset-category-heading"><div><h3>分类分布</h3></div></div>
      {stats.by_category.length ? <div className="asset-status-grid">
        {stats.by_category.map((category) => <div key={category.category_code}><span>{categories.find((item) => item.code === category.category_code)?.label ?? category.category_code}</span><b>{category.count}</b></div>)}
      </div> : <p className="asset-empty asset-empty-inline">暂无分类数据</p>}
    </section>
  </>;
}

function AssetRows({ rows, categories, onOpen, onOutbound, isAdmin, userName }: { rows: EquipmentAsset[]; categories: EquipmentCategory[]; onOpen: (a: EquipmentAsset) => void; onOutbound: (a: EquipmentAsset) => void; isAdmin: boolean; userName: (id: number | null) => string }) {
  const label = (code: string) => categories.find((c) => c.code === code)?.label ?? code;
  const isInventory = (asset: EquipmentAsset) => asset.inventory_managed === true;
  const actions = (asset: EquipmentAsset, mobile = false) => <>
    <button type="button" className="btn-ghost" onClick={() => onOpen(asset)}>{mobile ? "详情" : "查看"}</button>
    {isAdmin && isInventory(asset) && <button type="button" className="btn-primary" disabled={(asset.available_quantity ?? 0) === 0} title={(asset.available_quantity ?? 0) === 0 ? "可用库存为 0，无法出库" : undefined} onClick={() => onOutbound(asset)}>出库</button>}
  </>;
  return <>
    <CardList label="设备台账">{rows.map((asset) => <CardItem
      key={asset.id}
      title={asset.name}
      code={asset.code}
      badges={<span className={`asset-status ${asset.status}`}>{STATUS[asset.status] ?? asset.status}</span>}
      fields={[
        { label: "分类", value: label(asset.category_code) },
        { label: "使用人", value: userName(asset.holder_id) },
        { label: asset.inventory_managed ? "库存" : "到期日", value: asset.inventory_managed ? `可用 ${asset.available_quantity ?? 0} / 入库 ${asset.quantity ?? 0}` : asset.due_date ?? "—" },
        { label: "位置", value: asset.location ?? "—" },
      ]}
      actions={actions(asset, true)}
    />)}</CardList>
    <DesktopTable><table className="grid"><thead><tr><th>编号 / 名称</th><th>分类</th><th>状态</th><th>使用人</th><th>可用库存 / 数量</th><th>位置</th><th /></tr></thead><tbody>{rows.map((asset) => <tr key={asset.id}><td><b>{asset.code}</b><div>{asset.name}</div></td><td>{label(asset.category_code)}</td><td><span className={`asset-status ${asset.status}`}>{STATUS[asset.status] ?? asset.status}</span></td><td>{userName(asset.holder_id)}</td><td>{asset.inventory_managed ? `${asset.available_quantity ?? 0} / ${asset.quantity ?? 0}` : asset.due_date ?? "—"}</td><td>{asset.location ?? "—"}</td><td>{actions(asset)}</td></tr>)}</tbody></table></DesktopTable>
    {rows.length === 0 && <div className="asset-empty">没有符合条件的设备</div>}
  </>;
}

function OutboundRows({ rows }: { rows: EquipmentOutbound[] }) {
  return <>
    <CardList label="出库记录">{rows.map((row) => <CardItem key={row.id} title={row.asset_name} code={row.asset_code} badges={<span className="asset-status available">已出库</span>} fields={[{ label: "出库数量", value: row.quantity }, { label: "客户 / 去向", value: [row.customer, row.destination].filter(Boolean).join(" / ") || "—" }, { label: "发出时间", value: row.shipped_at ? new Date(row.shipped_at).toLocaleString("zh-CN") : "—" }, { label: "备注", value: row.note || "—" }]} />)}</CardList>
    <DesktopTable><table className="grid"><thead><tr><th>设备编号 / 名称</th><th>出库数量</th><th>客户</th><th>去向</th><th>发出时间</th><th>备注</th></tr></thead><tbody>{rows.map((row) => <tr key={row.id}><td><b>{row.asset_code}</b><div>{row.asset_name}</div></td><td>{row.quantity}</td><td>{row.customer || "—"}</td><td>{row.destination || "—"}</td><td>{row.shipped_at ? new Date(row.shipped_at).toLocaleString("zh-CN") : "—"}</td><td>{row.note || "—"}</td></tr>)}</tbody></table></DesktopTable>
    {rows.length === 0 && <div className="asset-empty">暂无出库记录</div>}
  </>;
}

function OutboundDialog({ asset, busy, onClose, onSubmit }: { asset: EquipmentAsset; busy: boolean; onClose: () => void; onSubmit: (body: EquipmentOutboundInput) => Promise<void> }) {
  const [quantity, setQuantity] = useState(1);
  const [customer, setCustomer] = useState("");
  const [destination, setDestination] = useState("");
  const [shippedAt, setShippedAt] = useState(() => {
    const now = new Date();
    now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
    return now.toISOString().slice(0, 16);
  });
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const available = asset.available_quantity ?? 0;
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > available) {
      setError(`出库数量需在 1 至 ${available} 之间`);
      return;
    }
    if (!customer.trim() && !destination.trim()) {
      setError("请填写发货客户或去向");
      return;
    }
    if (!shippedAt) {
      setError("请选择发出时间");
      return;
    }
    setError("");
    try {
      await onSubmit({ quantity, customer: customer.trim(), destination: destination.trim(), shipped_at: new Date(shippedAt).toISOString(), note: note.trim() });
    } catch (e) {
      setError(errText(e));
    }
  };
  return <Dialog open onClose={() => { if (!busy) onClose(); }} title="登记设备出库" size="sm" maskClosable={!busy} footer={<><button type="button" className="btn-ghost" disabled={busy} onClick={onClose}>取消</button><button type="submit" form="asset-outbound-form" className="btn-primary" disabled={busy || available < 1}>{busy ? "提交中…" : "确认出库"}</button></>}>
    <form id="asset-outbound-form" className="asset-form-grid asset-outbound-form" onSubmit={(event) => void submit(event)}>
      <div className="asset-inventory-summary"><span>{asset.name}</span><b>可用库存：{available}</b><small>入库记录 #{asset.id} · {asset.code}</small></div>
      <label>出库数量<input aria-label="出库数量" type="number" min={1} max={available} step={1} value={quantity} onChange={(event) => setQuantity(Number(event.target.value))} required /></label>
      <label>发货客户<input aria-label="发货客户" value={customer} onChange={(event) => setCustomer(event.target.value)} maxLength={255} /></label>
      <label>客户 / 去向<input aria-label="出库去向" value={destination} onChange={(event) => setDestination(event.target.value)} maxLength={255} /></label>
      <label>发出时间<input aria-label="发出时间" type="datetime-local" value={shippedAt} onChange={(event) => setShippedAt(event.target.value)} required /></label>
      <label className="wide">备注<input aria-label="出库备注" value={note} onChange={(event) => setNote(event.target.value)} maxLength={500} /></label>
      <p className="asset-form-hint">发货客户和去向至少填写一项；确认后将从此入库记录的可用库存中扣减。</p>
      {error && <div className="asset-error asset-form-error" role="alert">{error}</div>}
    </form>
  </Dialog>;
}

/**
 * 导入台账弹层：把「该填什么列」直接写在界面上，而不是让用户猜英文列名。
 * 上传与逐行报错都留在弹层内，用户改完文件可直接重试，不用关掉再打开。
 */
function ImportDialog({ categories, onClose, onImported, batchPickerRefreshKey }: {
  categories: EquipmentCategory[];
  onClose: () => void;
  onImported: (result: EquipmentImportResult) => void;
  batchPickerRefreshKey: number;
}) {
  const [busy, setBusy] = useState(false);
  const [rows, setRows] = useState<EquipmentImportError[]>([]);
  const [summary, setSummary] = useState("");
  const [ignored, setIgnored] = useState<Record<string, string[]>>({});
  const [fileName, setFileName] = useState("");
  const [mode, setMode] = useState<"new" | "existing">("new");
  const [batchName, setBatchName] = useState("");
  const [acceptance, setAcceptance] = useState<"pending_acceptance" | "accepted">("accepted");
  const [source, setSource] = useState("");
  const [supplier, setSupplier] = useState("");
  const [purchaseOrderNo, setPurchaseOrderNo] = useState("");
  const [invoiceNo, setInvoiceNo] = useState("");
  const [batchNote, setBatchNote] = useState("");
  const [batchSearch, setBatchSearch] = useState("");
  const [selectedBatchId, setSelectedBatchId] = useState("");
  const [searchKeyword, setSearchKeyword] = useState("");
  useEffect(() => {
    const timer = window.setTimeout(() => setSearchKeyword(batchSearch.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [batchSearch]);
  const { data: batches, loading: batchesLoading, error: batchesError } = useAsyncData(
    (signal) => api.batches({ keyword: searchKeyword, page: 1, size: 20 }, signal),
    [searchKeyword, batchPickerRefreshKey], { resetOnDepChange: true },
  );

  const reset = () => { setRows([]); setSummary(""); setIgnored({}); };
  const upload = async (file: File) => {
    setBusy(true);
    reset();
    setFileName(file.name);
    try {
      const selection: EquipmentBatchSelection = mode === "existing"
        ? { batch_id: Number(selectedBatchId) }
        : { name: batchName.trim(), source: source.trim() || `导入 ${file.name}`, supplier, purchase_order_no: purchaseOrderNo, invoice_no: invoiceNo, acceptance_status: acceptance, note: batchNote };
      const result = await api.upload(file, selection);
      onImported(result);
    } catch (e) {
      // 批量导入的 detail 是 { errors, message } 结构，errText 会退化成整段 JSON，必须单独取。
      const detail = errDetail(e) as { errors?: EquipmentImportError[]; message?: string } | undefined;
      if (detail?.errors?.length) {
        setRows(detail.errors);
        setSummary(detail.message || `有 ${detail.errors.length} 行未能导入，请修正后重试`);
      } else {
        setSummary(errText(e));
      }
    } finally {
      setBusy(false);
    }
  };
  const onPick = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file && (mode === "new" ? batchName.trim() : selectedBatchId)) void upload(file);
  };
  const ignoredNotes = Object.entries(ignored).filter(([, values]) => values.length > 0);

  return <Dialog
    open
    onClose={onClose}
    title="导入设备台账"
    size="md"
    footer={<>
      <button className="btn-ghost" onClick={() => void api.importTemplate("csv")}>下载 CSV 模板</button>
      <button className="btn-ghost" onClick={() => void api.importTemplate("xlsx")}>下载 Excel 模板</button>
      <label className={`btn-primary asset-import-button${busy ? " is-busy" : ""}`}>
        {busy ? "导入中…" : fileName ? "重新选择文件" : "选择文件导入"}
        <input type="file" accept=".csv,.xlsx" aria-label="选择 CSV 或 Excel 台账文件" disabled={busy || (mode === "new" ? !batchName.trim() : !selectedBatchId)} onChange={onPick} />
      </label>
    </>}
  >
    <div className="asset-import">
      <div className="asset-form-grid">
        <label>导入批次方式<Select aria-label="导入批次方式" value={mode} onChange={(value) => { setMode(value as typeof mode); setSelectedBatchId(""); }}><option value="new">新建批次</option><option value="existing">加入已有批次</option></Select></label>
        {mode === "new" ? <><label>批次名称<input aria-label="导入新批次名称" value={batchName} onChange={(event) => setBatchName(event.target.value)} required /></label><label>来源<input aria-label="导入批次来源" value={source} onChange={(event) => setSource(event.target.value)} placeholder={fileName ? `导入 ${fileName}` : "选择文件后默认使用文件名"} /></label><label>供应商<input value={supplier} onChange={(event) => setSupplier(event.target.value)} /></label><label>采购单号<input value={purchaseOrderNo} onChange={(event) => setPurchaseOrderNo(event.target.value)} /></label><label>发票号<input value={invoiceNo} onChange={(event) => setInvoiceNo(event.target.value)} /></label><label>验收状态<Select aria-label="导入新批次验收状态" value={acceptance} onChange={(value) => setAcceptance(value as typeof acceptance)}><option value="accepted">已验收</option><option value="pending_acceptance">待验收</option></Select></label><label>批次备注<input value={batchNote} onChange={(event) => setBatchNote(event.target.value)} /></label></> : <><label>搜索批次<input aria-label="搜索导入目标批次" value={batchSearch} onChange={(event) => { setBatchSearch(event.target.value); setSelectedBatchId(""); }} placeholder="批次名、编号或来源" /></label><label>选择批次<Select aria-label="选择导入批次" value={selectedBatchId} onChange={setSelectedBatchId} required><option value="">{batchesLoading ? "正在读取…" : "请选择已有批次"}</option>{batches?.items.map((item) => <option key={item.id} value={item.id}>{item.name} · 批次 #{item.id} · {item.source || "未填写来源"} · {item.acceptance_status === "accepted" ? "已验收" : "待验收"}</option>)}</Select></label>{batchesError && <span className="asset-error" role="alert">{batchesError}</span>}</>}
      </div>
      <p className="tiny muted">整份文件中的设备会归入同一个批次；加入已有批次时，新设备会继承该批次当前的验收状态。</p>
      <p className="tiny muted">
        支持 CSV 与 Excel（.xlsx），单文件不超过 5 MB。表头请用下面的中文列名，列顺序随意，多余的列会被忽略。
        建议先下载模板，模板里带示例行和填写说明。
      </p>

      <div className="asset-import-columns">
        <table className="grid">
          <thead><tr><th>列名</th><th>是否必填</th><th>填写说明</th></tr></thead>
          <tbody>{IMPORT_COLUMNS.map((column) => <tr key={column.name}>
            <td><b>{column.name}</b></td>
            <td>{column.required ? "必填" : "选填"}</td>
            <td className="tiny muted">{column.hint}</td>
          </tr>)}</tbody>
        </table>
      </div>

      <p className="tiny muted">
        「设备分类」当前可选：
        {categories.length ? categories.map((category) => category.label).join("、") : "暂无，请先到「分类维护」创建"}
        {categories.length ? "" : "（导入前请先创建分类）"}
      </p>
      <p className="tiny muted">设备初始状态由批次验收状态决定；文件中的资产编号、状态、使用人等列即使存在也会被忽略。</p>

      {summary && <div className="asset-error" role="alert">{summary}</div>}
      {!!rows.length && <ol className="asset-import-errors" aria-label="导入失败明细">
        {rows.map((row) => <li key={`${row.row}-${row.message}`}>第 {row.row} 行：{row.message}</li>)}
      </ol>}
      {!!ignoredNotes.length && <div className="asset-import-notes">
        {ignoredNotes.map(([title, values]) => <p className="tiny muted" key={title}>{title}：{values.join("、")}</p>)}
      </div>}
    </div>
  </Dialog>;
}

function InboundForm({ categories, inventoryManaged, busy, refreshKey, onSubmit }: { categories: EquipmentCategory[]; inventoryManaged: boolean; busy: boolean; refreshKey: number; onSubmit: (body: EquipmentInboundInput) => void }) {
  const [quantity, setQuantity] = useState(1);
  const [mode, setMode] = useState<"new" | "existing">("new");
  const [batchName, setBatchName] = useState("");
  const [batchSearch, setBatchSearch] = useState("");
  const [selectedBatchId, setSelectedBatchId] = useState("");
  const [searchKeyword, setSearchKeyword] = useState("");
  useEffect(() => {
    const timer = window.setTimeout(() => setSearchKeyword(batchSearch.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [batchSearch]);
  const { data: batches, loading: batchesLoading, error: batchesError } = useAsyncData(
    (signal) => api.batches({ keyword: searchKeyword, page: 1, size: 20 }, signal),
    [searchKeyword, refreshKey], { resetOnDepChange: true },
  );
  const selectedBatch = batches?.items.find((item) => String(item.id) === selectedBatchId);
  const submit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (mode === "new" && !batchName.trim()) return;
    if (mode === "existing" && !selectedBatchId) return;
    if (inventoryManaged && (!Number.isInteger(quantity) || quantity < 1)) return;
    if (inventoryManaged && selectedBatch && selectedBatch.acceptance_status !== "accepted") return;
    const fd = new FormData(e.currentTarget);
    const equipment = {
      name: String(fd.get("name") || "").trim(), category_code: String(fd.get("category") || ""),
      brand: String(fd.get("brand") || "").trim() || undefined, model: String(fd.get("model") || "").trim() || undefined,
      note: String(fd.get("note") || "").trim() || undefined,
    };
    const selection: EquipmentBatchSelection = mode === "existing"
      ? { batch_id: Number(selectedBatchId) }
      : { name: batchName.trim(), acceptance_status: "accepted" };
    const body: EquipmentInboundInput = inventoryManaged
      ? { ...selection, inventory_managed: true, items: [{ ...equipment, quantity }] }
      : { ...selection, inventory_managed: false, items: [{ ...equipment, serial_number: String(fd.get("serial") || "").trim() || undefined, quantity: 1 }] };
    onSubmit(body);
  };
  return <form className="asset-panel asset-form" onSubmit={submit}>
    <div className="asset-panel-heading"><div><h2>{inventoryManaged ? "批量库存入库" : "单件设备入库"}</h2><p>{inventoryManaged ? "登记可发往客户现场的物料，之后可按入库记录扣减库存。" : "登记办公电脑等单件设备，保存后可在设备台账查看。"}</p></div></div>
    <div className="asset-form-grid"><label>批次录入方式<Select aria-label="批次录入方式" value={mode} onChange={(value) => { setMode(value as typeof mode); setSelectedBatchId(""); }}><option value="new">新建批次</option><option value="existing">加入已有批次</option></Select></label>
      {mode === "new" ? <label>批次名称<input aria-label="新批次名称" value={batchName} onChange={(e) => setBatchName(e.target.value)} required /></label> : <>
        <label>搜索批次<input aria-label="搜索并选择已有批次" value={batchSearch} onChange={(e) => { setBatchSearch(e.target.value); setSelectedBatchId(""); }} placeholder="批次名、编号或来源" /></label>
        <label>选择批次<Select aria-label="选择入库批次" value={selectedBatchId} onChange={setSelectedBatchId} required><option value="">{batchesLoading ? "正在读取…" : "请选择已有批次"}</option>{batches?.items.map((item) => <option key={item.id} value={item.id}>{item.name} · 批次 #{item.id} · {item.acceptance_status === "accepted" ? "已验收" : "待验收"}</option>)}</Select></label>
        {batchesError && <span className="asset-error" role="alert">{batchesError}</span>}{selectedBatch && <p className="tiny muted">将设备关联至「{selectedBatch.name} · 批次 #{selectedBatch.id}」{inventoryManaged && selectedBatch.acceptance_status !== "accepted" ? "；待验收批次不能登记库存物料。" : "。"}</p>}
      </>}
    </div>
    <div className="asset-form-grid">
      <label>名称<input name="name" required /></label>
      <label>分类<Select key={categories[0]?.code ?? ""} surface="console" name="category" required defaultValue={categories[0]?.code ?? ""}>{categories.map((category) => <option key={category.code} value={category.code}>{category.label}</option>)}</Select></label>
      {inventoryManaged && <label>入库数量<input aria-label="入库数量" type="number" min={1} step={1} value={quantity} onChange={(event) => setQuantity(Number(event.target.value))} required /></label>}
      {!inventoryManaged && <label>序列号<input name="serial" /></label>}
      <label>品牌<input name="brand" /></label>
      <label>型号<input name="model" /></label>
      <label className="wide">备注<input name="note" /></label>
    </div>
    <button className="btn-primary" disabled={busy || (mode === "new" ? !batchName.trim() : !selectedBatchId) || (inventoryManaged && (!Number.isInteger(quantity) || quantity < 1 || (selectedBatch?.acceptance_status !== undefined && selectedBatch.acceptance_status !== "accepted")))}>{busy ? "提交中…" : inventoryManaged ? `登记 ${quantity} 件库存` : "登记单件设备"}</button>
  </form>;
}

function Statistics({ stats, categories, onHolder }: { stats: EquipmentStatistics; categories: EquipmentCategory[]; onHolder: (id: number) => void }) {
  const categoryTotal = stats.by_category.reduce((total, row) => total + row.count, 0);
  return <div className="asset-stat-columns">
    <section className="asset-panel">
      <div className="asset-panel-heading"><div><h2>分类占比</h2></div></div>
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
      <div className="asset-panel-heading"><div><h2>状态数量</h2></div></div>
      {stats.by_status.length ? stats.by_status.map((row) => <div className="asset-stat-row asset-stat-count" key={row.status}><span>{STATUS[row.status] ?? row.status}</span><b>{row.count}</b></div>) : <p className="asset-empty asset-empty-inline">暂无状态数据</p>}
    </section>
    <section className="asset-panel asset-wide">
      <div className="asset-panel-heading"><div><h2>月度出入库</h2></div></div>
      {stats.by_month.length ? <div className="asset-months">{stats.by_month.map((row) => <div key={row.month}><b>{row.month}</b><span>入库 <strong>{row.inbound}</strong></span><span>出库 <strong>{row.outbound}</strong></span></div>)}</div> : <p className="asset-empty asset-empty-inline">暂无出入库记录</p>}
    </section>
    <section className="asset-panel asset-wide">
      <div className="asset-panel-heading"><div><h2>使用人设备清单</h2></div></div>
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

function AssetDetail({ asset, categories, batch, events, deleteCheck, userName, isAdmin, currentUser, busy, onClose, onEdit, onAction, onDelete, onAcceptBatch, onOutbound }: { asset: EquipmentAsset; categories: EquipmentCategory[]; batch: EquipmentBatch | null; events: EquipmentEvent[]; deleteCheck: EquipmentDeleteCheck | null; userName: (id: number | null) => string; isAdmin: boolean; currentUser?: number; busy: boolean; onClose: () => void; onEdit: (body: EquipmentWrite) => void; onAction: (action: "claim" | "borrow" | "return" | "maintenance" | "restore" | "scrap" | "void", body: { note?: string; due_date?: string }) => void; onDelete: (reason: string) => Promise<void>; onAcceptBatch: (batchId: number) => void; onOutbound: () => void }) {
  const [note, setNote] = useState("");
  const [due, setDue] = useState("");
  const [editing, setEditing] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [pendingTerminalAction, setPendingTerminalAction] = useState<"scrap" | "void" | null>(null);
  const [confirmCode, setConfirmCode] = useState("");
  const [deleteReason, setDeleteReason] = useState("");
  const [deleteError, setDeleteError] = useState("");
  const [acceptanceBatchId, setAcceptanceBatchId] = useState<number | null>(null);
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
  const deleteReady = Boolean(confirmCode.trim() === asset.code && deleteReason.trim());
  const forceDelete = Boolean(deleteCheck && !deleteCheck.allowed);
  const confirmDelete = async () => {
    setDeleteError("");
    try { await onDelete(deleteReason.trim()); }
    catch (e) { setDeleteError(errText(e)); }
  };
  const confirmTerminalAction = () => {
    if (!pendingTerminalAction || busy) return;
    const action = pendingTerminalAction;
    setPendingTerminalAction(null);
    onAction(action, { note });
  };
  const terminalActionLabel = pendingTerminalAction === "scrap" ? "报废" : "作废";

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
        {asset.inventory_managed ? <><div><span>入库数量</span><b>{asset.quantity ?? 0}</b></div><div><span>可用库存</span><b>{asset.available_quantity ?? 0}</b></div></> : <><div><span>购置日期</span><b>{asset.purchase_date || "—"}</b></div><div><span>购置金额</span><b>{asset.purchase_price ?? "—"}</b></div></>}
      </div>

      {batch && <section className="asset-detail-batch">
        <div className="asset-section-heading"><div><h3>入库批次 #{batch.id}</h3></div></div>
        <dl><div><dt>批次名称</dt><dd>{batch.name}</dd></div></dl>
      </section>}

      {isAdmin && <section className="asset-detail-section">
        <div className="asset-section-heading"><div><h3>设备操作</h3></div></div>
        <div className="asset-detail-actions">
          {asset.inventory_managed && <button type="button" className="btn-primary" disabled={busy || (asset.available_quantity ?? 0) === 0} title={(asset.available_quantity ?? 0) === 0 ? "可用库存为 0，无法出库" : undefined} onClick={onOutbound}>出库</button>}
          {asset.status === "pending_acceptance" && asset.batch_id !== null && <button type="button" className="btn-primary" disabled={busy} onClick={() => setAcceptanceBatchId(asset.batch_id)}>验收该批次全部待验收设备</button>}
          {asset.status === "pending_acceptance" && asset.batch_id === null && <span className="asset-muted">该待验收设备未关联入库批次，请联系管理员核查。</span>}
          {!asset.inventory_managed && !(["void", "scrapped", "pending_acceptance"].includes(asset.status)) && <button type="button" className="btn-ghost" disabled={busy} onClick={() => setEditing(!editing)}>{editing ? "取消编辑" : "编辑档案"}</button>}
          {!asset.inventory_managed && asset.status === "available" && <button type="button" className="btn-ghost" disabled={busy} onClick={() => onAction("maintenance", { note })}>送修</button>}
          {!asset.inventory_managed && asset.status === "maintenance" && <button type="button" className="btn-ghost" disabled={busy} onClick={() => onAction("restore", { note })}>恢复可用</button>}
          {!asset.inventory_managed && ["available", "maintenance"].includes(asset.status) && <button type="button" className="btn-ghost asset-danger" disabled={busy} onClick={() => setPendingTerminalAction("scrap")}>报废</button>}
          {!asset.inventory_managed && !(["void", "scrapped", "pending_acceptance"].includes(asset.status)) && <button type="button" className="btn-ghost asset-danger" disabled={busy} onClick={() => setPendingTerminalAction("void")}>作废</button>}
        </div>
        {editing && <form className="asset-edit-form" onSubmit={(event) => { event.preventDefault(); onEdit(form); }}>
          <h4>编辑资产档案</h4>
          <div className="asset-form-grid">
            <label>名称<input required value={form.name ?? ""} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
            <label>分类<Select value={form.category_code ?? ""} onChange={(value) => setForm({ ...form, category_code: value })}>{categories.map((category) => <option key={category.code} value={category.code}>{category.label}</option>)}</Select></label>
            <label>序列号<input value={form.serial_number ?? ""} onChange={(event) => setForm({ ...form, serial_number: event.target.value })} /></label>
            <label>品牌<input value={form.brand ?? ""} onChange={(event) => setForm({ ...form, brand: event.target.value })} /></label>
            <label>型号<input value={form.model ?? ""} onChange={(event) => setForm({ ...form, model: event.target.value })} /></label>
            <label>位置<input value={form.location ?? ""} onChange={(event) => setForm({ ...form, location: event.target.value })} /></label>
          </div>
          <button className="btn-primary" disabled={busy}>{busy ? "保存中…" : "保存档案"}</button>
        </form>}
      </section>}

      {acceptanceBatchId !== null && <Dialog
        open
        onClose={() => setAcceptanceBatchId(null)}
        title="确认批次验收"
        size="sm"
        maskClosable={!busy}
        footer={<><button type="button" className="btn-ghost" disabled={busy} onClick={() => setAcceptanceBatchId(null)}>取消</button><button type="button" className="btn-primary" disabled={busy} onClick={() => { const batchId = acceptanceBatchId; setAcceptanceBatchId(null); onAcceptBatch(batchId); }}>{busy ? "验收中…" : "确认验收该批次全部待验收设备"}</button></>}
      >
        <p>此操作将验收批次「{batch?.id === acceptanceBatchId ? batch.name : `批次 #${acceptanceBatchId}`}」下全部待验收设备，不只是当前设备。</p>
      </Dialog>}

      {!asset.inventory_managed && (canClaim || canBorrow || canReturn) && <section className="asset-detail-section">
        <div className="asset-section-heading"><div><h3>领用与借用</h3></div></div>
        <div className="asset-detail-actions">
          {(canClaim || canBorrow) && <label>借用到期日<DatePicker value={due} onChange={(v) => setDue(v)} ariaLabel="借用到期日" quick={false} /></label>}
          {canClaim && <button type="button" disabled={busy} className="btn-primary" onClick={() => onAction("claim", { note })}>领用</button>}
          {canBorrow && <button type="button" disabled={busy || !due} className="btn-ghost" onClick={() => onAction("borrow", { due_date: due, note })}>借用</button>}
          {canReturn && <button type="button" disabled={busy} className="btn-primary" onClick={() => onAction("return", { note })}>登记归还</button>}
        </div>
      </section>}

      {(isAdmin || canReturn || asset.status === "available") && <label className="asset-note">操作备注<input value={note} onChange={(event) => setNote(event.target.value)} placeholder="可选" /></label>}

      <section className="asset-detail-section asset-event-section">
        <div className="asset-section-heading"><div><h3>设备流水</h3></div><span className="asset-event-count">{events.length} 条</span></div>
        {events.length ? <ol className="asset-events">{events.map((event) => <li key={event.id}><b>{EQUIPMENT_ACTION_LABELS[event.action] ?? event.action}</b><span>{event.action === "outbound" ? `出库 ${event.quantity ?? 0} 件 · ${[event.customer, event.destination].filter(Boolean).join(" / ")}` : event.from_status ? `${STATUS[event.from_status] ?? event.from_status} → ${STATUS[event.to_status ?? ""] ?? event.to_status ?? ""}` : STATUS[event.to_status ?? ""] ?? event.to_status ?? ""}</span><time>{new Date(event.shipped_at ?? event.created_at).toLocaleString("zh-CN")}</time>{event.note && <small>{event.note}</small>}</li>)}</ol> : <p className="asset-empty asset-empty-inline">暂无流水记录</p>}
      </section>

      {isAdmin && !asset.inventory_managed && <section className="asset-detail-section asset-delete-zone">
        <div className="asset-section-heading"><div><h3>危险操作</h3><p>永久删除会连带清除该资产的设备流水，无法恢复。</p></div></div>
        {!deleteCheck ? <p className="asset-muted">正在检查删除资格…</p> : <>
          {deleteCheck.allowed
            ? <p className="asset-delete-hint">该资产尚未产生领用、借用、维修、报废或作废等业务流水，可以永久删除。所属入库批次会保留。</p>
            : <p className="asset-delete-blocked">{deleteCheck.reason}。管理员仍可强制删除，此操作不可撤销。</p>}
          <button type="button" className="btn-danger" disabled={busy} onClick={() => { setConfirmCode(""); setDeleteReason(""); setDeleteError(""); setDeleteOpen(true); }}>{forceDelete ? "强制删除" : "删除资产"}</button>
        </>}
      </section>}

      {deleteOpen && <Dialog
        open
        onClose={() => { if (!busy) setDeleteOpen(false); }}
        title={forceDelete ? "强制删除资产" : "永久删除资产"}
        size="sm"
        maskClosable={!busy}
        footer={<><button className="btn-ghost" disabled={busy} onClick={() => setDeleteOpen(false)}>取消</button><button className="btn-danger" disabled={busy || !deleteReady} onClick={() => void confirmDelete()}>{busy ? "删除中…" : forceDelete ? "强制删除" : "永久删除"}</button></>}
      >
        <div className="asset-delete-dialog">
          <p>此操作会永久删除设备 <b>{asset.name}</b> 及其设备流水，无法恢复。入库批次不会被删除。</p>
          {forceDelete && <p className="asset-delete-blocked">警告：{deleteCheck?.reason}，继续删除将永久丢失上述业务历史。</p>}
          <div className="asset-delete-code"><span>设备编号</span><code>{asset.code}</code></div>
          <label>请输入设备编号确认<input aria-label="输入设备编号确认删除" value={confirmCode} onChange={(event) => setConfirmCode(event.target.value)} autoComplete="off" /></label>
          <label>删除原因 <span className="asset-required">*</span><textarea aria-label="删除原因" maxLength={500} rows={4} value={deleteReason} onChange={(event) => setDeleteReason(event.target.value)} placeholder="例如：重复录入、录入错误" /></label>
          {confirmCode && confirmCode.trim() !== asset.code && <div className="field-err" role="alert">设备编号不匹配</div>}
          {deleteError && <div className="field-err" role="alert">{deleteError}</div>}
        </div>
      </Dialog>}

      {pendingTerminalAction && <Dialog
        open
        onClose={() => { if (!busy) setPendingTerminalAction(null); }}
        title={`确认${terminalActionLabel}设备`}
        size="sm"
        maskClosable={!busy}
        footer={<>
          <button className="btn-ghost" disabled={busy} onClick={() => setPendingTerminalAction(null)}>取消</button>
          <button className="btn-ghost asset-danger" disabled={busy} onClick={confirmTerminalAction}>{busy ? "处理中…" : `确认${terminalActionLabel}`}</button>
        </>}
      >
        <div className="asset-terminal-dialog">
          <dl className="asset-terminal-identity">
            <div><dt>设备编号</dt><dd>{asset.code}</dd></div>
            <div><dt>设备名称</dt><dd>{asset.name}</dd></div>
            <div><dt>当前状态</dt><dd>{STATUS[asset.status] ?? asset.status}</dd></div>
          </dl>
          <p className="asset-terminal-warning">
            {pendingTerminalAction === "scrap"
              ? "确认后设备将进入「已报废」状态，后续不能恢复或编辑档案。"
              : "确认后设备将进入「已作废」状态，后续不能恢复或编辑档案。"}
          </p>
          {pendingTerminalAction === "void" && ["claimed", "borrowed"].includes(asset.status) && (
            <p className="asset-terminal-warning">作废后，系统会清空该设备的使用人和到期日。</p>
          )}
        </div>
      </Dialog>}
    </div>
  </Drawer>;
}
