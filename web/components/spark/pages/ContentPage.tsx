"use client";

import { useMemo, useState } from "react";
import {
  CONTENT_ADDITIONAL,
  CONTENT_EVENTS,
  CONTENT_EVENT_STATUSES,
  CONTENT_GAMES,
  CONTENT_LEADERBOARD,
  CONTENT_METRICS,
  CONTENT_REVIEW_QUEUE,
  CONTENT_REVIEW_TYPES,
  CONTENT_SUBTITLE,
  CONTENT_TABS,
  GAME_CATEGORIES,
} from "@/lib/spark/content";
import type { ContentTab } from "@/lib/spark/content";
import { SparkBadge, SparkMetric, SparkPageHeader, SparkPanel, SparkProgress, SparkTabs } from "../SparkUI";
import p from "../SparkPages.module.css";
import s from "./BillingContent.module.css";

type ReviewDecision = "通过" | "驳回";

function normalize(value: string) {
  return value.trim().toLocaleLowerCase("zh-CN");
}

function EmptyResults({ onReset }: { onReset: () => void }) {
  return (
    <div className={`${p.panel} ${s.emptyPanel}`}>
      <div className={p.emptyState}>
        <span>没有符合当前搜索和分类条件的内容</span>
        <button type="button" className={p.button_quiet} onClick={onReset}>清除筛选</button>
      </div>
    </div>
  );
}

function ContentSearch({ value, onChange, placeholder }: { value: string; onChange: (value: string) => void; placeholder: string }) {
  return (
    <label className={p.searchInput} style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span aria-hidden="true" className={p.muted}>⌕</span>
      <input aria-label={placeholder} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} style={{ width: "100%", border: 0, outline: 0, color: "inherit", background: "transparent", fontSize: 10 }} />
    </label>
  );
}

function FilterChips({ options, value, onChange, label }: { options: readonly string[]; value: string; onChange: (value: string) => void; label: string }) {
  return (
    <div className={p.filterRow} aria-label={label}>
      {options.map((option) => <button key={option} type="button" className={`${p.filterButton} ${value === option ? p.filterSelected : ""}`} aria-pressed={value === option} onClick={() => onChange(option)}>{option}</button>)}
    </div>
  );
}

function GamesTab({ query, category, onReset }: { query: string; category: string; onReset: () => void }) {
  const normalizedQuery = normalize(query);
  const visibleGames = useMemo(() => CONTENT_GAMES.filter((game) => {
    const matchesCategory = category === "全部" || game.category === category;
    const searchable = normalize([game.id, game.name, game.category, game.publisher, game.size, game.rating, game.distribution].join(" "));
    return matchesCategory && (!normalizedQuery || searchable.includes(normalizedQuery));
  }), [category, normalizedQuery]);

  return (
    <>
      {visibleGames.length ? (
        <div className={s.gameGrid}>
          {visibleGames.map((game) => (
            <article className={s.gameCard} key={game.id}>
              <div className={s.gameCardTop}><SparkBadge tone="cyan">{game.category}</SparkBadge><small>{game.id}</small></div>
              <h2>{game.name}</h2>
              <p className={s.gamePublisher}>{game.publisher} · {game.size}</p>
              <div className={s.gameFacts}><span>评分 <strong>{game.rating}</strong></span><SparkBadge tone="green">已分发 {game.distribution}</SparkBadge></div>
              <div className={s.popularityRow}><span>热度指数</span><SparkProgress value={game.popularity} tone={game.popularity >= 90 ? "cyan" : "violet"} label={String(game.popularity)} /></div>
              <div className={s.gameCardFoot}><SparkBadge tone="slate">全量分发</SparkBadge><span>详情　↗</span></div>
            </article>
          ))}
        </div>
      ) : <EmptyResults onReset={onReset} />}
    </>
  );
}

function EventsTab({ query, category, registered, onRegister, onReset }: {
  query: string;
  category: string;
  registered: ReadonlySet<string>;
  onRegister: (id: string) => void;
  onReset: () => void;
}) {
  const normalizedQuery = normalize(query);
  const visibleEvents = useMemo(() => CONTENT_EVENTS.filter((event) => {
    const status = registered.has(event.id) ? "已报名" : event.status;
    const matchesCategory = category === "全部" || event.status === category || status === category;
    const searchable = normalize([event.id, event.name, event.game, event.venue, event.time, event.status, status].join(" "));
    return matchesCategory && (!normalizedQuery || searchable.includes(normalizedQuery));
  }), [category, normalizedQuery, registered]);

  return (
    <>
      {visibleEvents.length ? <>
        <div className={s.eventGrid}>
          {visibleEvents.map((event) => {
            const isRegistered = registered.has(event.id);
            const tone = event.status === "直播中" ? "rose" : event.status === "报名中" ? "green" : "amber";
            return (
              <article className={s.eventCard} key={event.id}>
                <div className={s.eventCardTop}><SparkBadge tone={isRegistered ? "cyan" : tone}>{isRegistered ? "已报名" : event.status}</SparkBadge><span className={p.mono}>{event.id}</span></div>
                <h2>{event.name}</h2>
                <div className={s.eventMeta}><span>{event.game}</span><span>{event.venue}</span><span>{event.time}</span><span>{event.teams} 支战队</span></div>
                <div className={s.eventFooter}><span><small>总奖金池</small><strong>{event.prizePool}</strong></span>
                  {"viewers" in event && event.viewers ? <span><small>直播观看</small><strong>{event.viewers}</strong></span> : event.status !== "直播中" ? <button type="button" className={p.button} onClick={() => onRegister(event.id)}>{isRegistered ? "已报名" : "立即报名"}</button> : null}
                </div>
              </article>
            );
          })}
        </div>
        <SparkPanel title="苏州城市战队积分榜 · 2026 春季赛">
          <div className={p.tableWrap}>
            <table className={`${p.dataTable} ${s.leaderboardTable}`}>
              <thead><tr><th>排名</th><th>战队</th><th>胜场</th><th>负场</th><th>积分</th></tr></thead>
              <tbody>{CONTENT_LEADERBOARD.map((team) => <tr key={team.tag}><td className={p.mono}>{team.rank}</td><td><SparkBadge tone={team.rank === "1" ? "cyan" : "slate"}>{team.tag}</SparkBadge><span className={s.teamName}>{team.name}</span></td><td className={p.mono}>{team.wins}</td><td className={p.mono}>{team.losses}</td><td className={p.mono}>{team.points}</td></tr>)}</tbody>
            </table>
          </div>
        </SparkPanel>
      </> : <EmptyResults onReset={onReset} />}
    </>
  );
}

function AdditionalTab({ query, category, onReset }: { query: string; category: string; onReset: () => void }) {
  const normalizedQuery = normalize(query);
  const visibleItems = useMemo(() => CONTENT_ADDITIONAL.filter((item) => {
    const matchesCategory = category === "全部" || item.category === category;
    const searchable = normalize([item.name, item.description, item.metric, item.category].join(" "));
    return matchesCategory && (!normalizedQuery || searchable.includes(normalizedQuery));
  }), [category, normalizedQuery]);

  return (
    <>
      {visibleItems.length ? (
        <div className={s.addonGrid}>
          {visibleItems.map((item, index) => (
            <article className={s.addonCard} key={item.name}>
              <div className={`${s.addonIcon} ${s[`addonIcon${index + 1}`]}`} aria-hidden="true">{["▣", "♫", "◉", "✦"][index]}</div>
              <div><SparkBadge tone={(["violet", "cyan", "rose", "amber"] as const)[index]}>{item.name}</SparkBadge><p>{item.description}</p><strong>{item.metric}</strong></div>
            </article>
          ))}
        </div>
      ) : <EmptyResults onReset={onReset} />}
    </>
  );
}

function ComplianceTab({ query, category, decisions, onDecision, onReset }: {
  query: string;
  category: string;
  decisions: Readonly<Record<string, ReviewDecision>>;
  onDecision: (id: string, decision: ReviewDecision) => void;
  onReset: () => void;
}) {
  const normalizedQuery = normalize(query);
  const visibleQueue = useMemo(() => CONTENT_REVIEW_QUEUE.filter((item) => {
    const decision = decisions[item.id];
    const state = decision ? `已${decision}` : item.risk;
    const matchesCategory = category === "全部" || item.type === category;
    const searchable = normalize([item.name, item.type, item.submitter, item.submitted, item.risk, state].join(" "));
    return matchesCategory && (!normalizedQuery || searchable.includes(normalizedQuery));
  }), [category, decisions, normalizedQuery]);

  return (
    <>
      <SparkPanel title="内容合规审核队列" subtitle="审核状态仅在当前页面生效" action={<SparkBadge tone="green">今日已处理 48 条</SparkBadge>}>
        {visibleQueue.length ? (
          <div className={s.reviewList}>
            {visibleQueue.map((item) => {
              const decision = decisions[item.id];
              return (
                <article className={s.reviewItem} key={item.id}>
                  <div className={s.reviewCopy}><h2>{item.name}</h2><p>{item.type} <span>· 提交人</span> {item.submitter} <span>·</span> {item.submitted}</p></div>
                  <SparkBadge tone={decision === "通过" ? "green" : decision === "驳回" ? "rose" : item.risk === "低风险" ? "cyan" : "amber"}>{decision ? `已${decision}` : item.risk}</SparkBadge>
                  <div className={s.reviewActions}>
                    <button type="button" className={s.approveButton} aria-label={`通过：${item.name}`} onClick={() => onDecision(item.id, "通过")}>通过</button>
                    <button type="button" className={s.rejectButton} aria-label={`驳回：${item.name}`} onClick={() => onDecision(item.id, "驳回")}>驳回</button>
                  </div>
                </article>
              );
            })}
          </div>
        ) : <div className={s.inlineEmpty}><span>没有符合当前搜索和分类条件的审核内容</span><button type="button" className={p.button_quiet} onClick={onReset}>清除筛选</button></div>}
      </SparkPanel>
    </>
  );
}

export default function ContentPage() {
  const [tab, setTab] = useState<ContentTab>("games");
  const [category, setCategory] = useState("全部");
  const [query, setQuery] = useState("");
  const [registered, setRegistered] = useState<ReadonlySet<string>>(() => new Set());
  const [decisions, setDecisions] = useState<Readonly<Record<string, ReviewDecision>>>({});

  const categories: readonly string[] = tab === "games" ? GAME_CATEGORIES : tab === "events" ? CONTENT_EVENT_STATUSES : tab === "additional" ? ["全部", ...CONTENT_ADDITIONAL.map((item) => item.category)] : CONTENT_REVIEW_TYPES;
  const changeTab = (nextTab: ContentTab) => { setTab(nextTab); setCategory("全部"); };
  const resetFilters = () => { setCategory("全部"); setQuery(""); };

  return (
    <div className={p.pageStack}>
      <SparkPageHeader title="游戏内容库与电竞赛事" subtitle={CONTENT_SUBTITLE} icon="content" status="苏州全域内容分发" />
      <div className={s.tabsRow}><SparkTabs items={CONTENT_TABS} value={tab} onChange={changeTab} label="内容管理模块" /></div>
      {tab === "games" && <div className={p.metricGrid}>{CONTENT_METRICS.map((metric) => <SparkMetric key={metric.label} {...metric} />)}</div>}
      <div className={s.contentToolbar}>
        <ContentSearch value={query} onChange={setQuery} placeholder={tab === "games" ? "搜索游戏名称" : tab === "events" ? "搜索赛事名称、游戏或地点" : tab === "additional" ? "搜索增值内容" : "搜索内容、提交人或风险状态"} />
        <span className={s.toolbarHint}>{tab === "games" ? "热门游戏 · 近 7 日启动 Top" : tab === "events" ? "苏州本地赛事 · 2026 春季赛" : tab === "additional" ? "影音、赛事与互动服务" : "审核状态与风险等级"}</span>
      </div>
      <FilterChips options={categories} value={category} onChange={setCategory} label="按当前内容分类筛选" />
      {tab === "games" && <GamesTab query={query} category={category} onReset={resetFilters} />}
      {tab === "events" && <EventsTab query={query} category={category} registered={registered} onRegister={(id) => setRegistered((current) => new Set(current).add(id))} onReset={resetFilters} />}
      {tab === "additional" && <AdditionalTab query={query} category={category} onReset={resetFilters} />}
      {tab === "compliance" && <ComplianceTab query={query} category={category} decisions={decisions} onDecision={(id, decision) => setDecisions((current) => ({ ...current, [id]: decision }))} onReset={resetFilters} />}
    </div>
  );
}
