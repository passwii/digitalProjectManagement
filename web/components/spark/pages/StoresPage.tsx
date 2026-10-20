"use client";

import { useMemo, useState } from "react";
import { DISTRICTS, STORE_FILTERS, STORE_SUMMARY, STORES } from "@/lib/spark/stores";
import type { SparkStatus, SparkStore } from "@/lib/spark/types";
import { SparkBadge, SparkMetric, SparkPageHeader, SparkProgress } from "../SparkUI";
import p from "../SparkPages.module.css";
import s from "./DashboardStoreCompute.module.css";

const statusTone: Record<SparkStatus, "green" | "amber" | "rose" | "slate"> = {
  "营业中": "green",
  "高负载": "amber",
  "维护中": "rose",
  "离线": "slate",
};

function StoreCard({ store }: { store: SparkStore }) {
  return (
    <article className={s.storeCard}>
      <div className={s.storeCardHeader}>
        <div className={s.storeTitle}>
          <span className={s.storeKind}>{store.type} · {store.district}</span>
          <h2 title={store.name}>{store.name}</h2>
          <p>{store.code}</p>
        </div>
        <SparkBadge tone={statusTone[store.status]}>{store.status}</SparkBadge>
      </div>
      <p className={s.storeAddress}><span aria-hidden="true">⌖</span>{store.address}</p>
      <div className={s.storeLoad}>
        <span>现场负载</span>
        <SparkProgress value={store.load} tone={store.load >= 90 ? "amber" : "cyan"} label={`${store.load}%`} />
        <strong>{store.online}/{store.terminals}</strong>
      </div>
      <div className={s.storeFacts}>
        <div className={s.storeFact}><span>今日营收</span><strong>¥{store.revenue.toLocaleString("zh-CN")}</strong></div>
        <div className={s.storeFact}><span>店长</span><strong>{store.manager}</strong></div>
        <div className={s.storeFact}><span>联系电话</span><strong>{store.phone}</strong></div>
      </div>
    </article>
  );
}

export default function StoresPage() {
  const [district, setDistrict] = useState<(typeof DISTRICTS)[number]>("全部");
  const [status, setStatus] = useState<(typeof STORE_FILTERS)[number]>("全部");
  const [query, setQuery] = useState("");

  const visibleStores = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
    return STORES.filter((store) => {
      const matchesDistrict = district === "全部" || store.district === district;
      const matchesStatus = status === "全部" || store.status === status;
      const searchable = [store.name, store.code, store.address, store.manager, store.phone, store.type].join(" ").toLocaleLowerCase("zh-CN");
      return matchesDistrict && matchesStatus && (!normalizedQuery || searchable.includes(normalizedQuery));
    });
  }, [district, status, query]);

  return (
    <div className={p.pageStack}>
      <SparkPageHeader title="连锁门店" subtitle="苏州全域 33 家门店 · 终端、营收与现场负载统一监测" icon="store" status="33 个运营节点" />

      <div className={`${p.metricGrid} ${s.storeMetrics}`}>
        {STORE_SUMMARY.map((metric) => <SparkMetric key={metric.label} {...metric} />)}
      </div>

      <section className={s.storeToolbar} aria-label="门店筛选">
        <div className={p.toolbar}>
          <label className={p.searchInput} style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span aria-hidden="true" className={p.muted}>⌕</span>
            <input
              aria-label="搜索门店、编码、地址、店长或电话"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索门店、编码、地址、店长或电话…"
              style={{ width: "100%", border: 0, outline: 0, color: "inherit", background: "transparent", fontSize: 10 }}
            />
          </label>
          <span className={p.muted} style={{ marginLeft: "auto", fontSize: 9 }}>显示 {visibleStores.length} / {STORES.length} 家门店</span>
        </div>
        <div className={p.filterRow} aria-label="按区县筛选">
          {DISTRICTS.map((value) => (
            <button key={value} type="button" className={`${p.filterButton} ${district === value ? p.filterSelected : ""}`} aria-pressed={district === value} onClick={() => setDistrict(value)}>{value}</button>
          ))}
        </div>
        <div className={p.filterRow} aria-label="按营业状态筛选">
          {STORE_FILTERS.map((value) => (
            <button key={value} type="button" className={`${p.filterButton} ${status === value ? p.filterSelected : ""}`} aria-pressed={status === value} onClick={() => setStatus(value)}>{value}</button>
          ))}
        </div>
      </section>

      {visibleStores.length ? (
        <div className={s.storeCards}>{visibleStores.map((store) => <StoreCard key={store.code} store={store} />)}</div>
      ) : (
        <div className={p.panel}><div className={p.emptyState}>没有符合当前区县、状态和关键词的门店</div></div>
      )}
    </div>
  );
}
