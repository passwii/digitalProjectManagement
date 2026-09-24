"use client";

import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  DASHBOARD_ALERTS,
  DASHBOARD_METRICS,
  DASHBOARD_REVENUE,
  DISTRICT_REVENUE,
  GPU_POOLS,
  REVENUE_LEADERS,
} from "@/lib/spark/dashboard";
import { SparkBadge, SparkMetric, SparkPageHeader, SparkPanel, SparkProgress } from "../SparkUI";
import s from "./DashboardStoreCompute.module.css";
import p from "../SparkPages.module.css";

const chartTick = { fill: "#718096", fontSize: 9 };

export default function DashboardPage() {
  return (
    <div className={p.pageStack}>
      <SparkPageHeader
        title="苏州运营总览"
        subtitle="数据截至 2026-06-08 22:30 · 苏州全域实时监测"
        icon="dashboard"
        status="全部子系统运行正常"
      />

      <div className={`${p.metricGrid} ${s.computeMetrics}`}>
        {DASHBOARD_METRICS.map((metric) => <SparkMetric key={metric.label} {...metric} />)}
      </div>

      <div className={s.dashboardMainGrid}>
        <SparkPanel title="苏州全域 24h 营收曲线" subtitle="网吧时段 + 电竞酒店（元 / 2 小时）" action={<SparkBadge tone="green">实时</SparkBadge>}>
          <div className={`${p.chartBox} ${p.chartBoxTall}`}>
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={DASHBOARD_REVENUE} margin={{ top: 8, right: 6, bottom: 0, left: -18 }}>
                <defs>
                  <linearGradient id="sparkRevenueMember" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#22d3ee" stopOpacity={0.25} /><stop offset="100%" stopColor="#22d3ee" stopOpacity={0.01} /></linearGradient>
                  <linearGradient id="sparkRevenueWalkin" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#a855f7" stopOpacity={0.21} /><stop offset="100%" stopColor="#a855f7" stopOpacity={0.01} /></linearGradient>
                  <linearGradient id="sparkRevenueHotel" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#34d399" stopOpacity={0.18} /><stop offset="100%" stopColor="#34d399" stopOpacity={0.01} /></linearGradient>
                </defs>
                <CartesianGrid stroke="rgba(194,211,239,.08)" vertical={false} />
                <XAxis dataKey="hour" tick={chartTick} axisLine={{ stroke: "rgba(194,211,239,.1)" }} tickLine={false} tickFormatter={(value) => `${value}:00`} />
                <YAxis tick={chartTick} axisLine={false} tickLine={false} width={46} tickFormatter={(value) => Number(value) === 0 ? "0" : `${Math.round(Number(value) / 1000)}k`} />
                <Tooltip
                  contentStyle={{ background: "#101724", border: "1px solid rgba(194,211,239,.16)", borderRadius: 7, color: "#dbe6f5", fontSize: 10 }}
                  labelFormatter={(value) => `${value}:00`}
                  formatter={(value, name) => [`¥${Number(value).toLocaleString("zh-CN")}`, name]}
                />
                <Area type="monotone" dataKey="members" name="会员" stackId="revenue" stroke="#22d3ee" strokeWidth={1.8} fill="url(#sparkRevenueMember)" />
                <Area type="monotone" dataKey="walkIn" name="散客" stackId="revenue" stroke="#a855f7" strokeWidth={1.8} fill="url(#sparkRevenueWalkin)" />
                <Area type="monotone" dataKey="hotel" name="电竞酒店" stackId="revenue" stroke="#34d399" strokeWidth={1.7} fill="url(#sparkRevenueHotel)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
          <div className={p.chartLegend}>
            <span className={p.legendItem}><i style={{ background: "#22d3ee" }} />会员</span>
            <span className={p.legendItem}><i style={{ background: "#a855f7" }} />散客</span>
            <span className={p.legendItem}><i style={{ background: "#34d399" }} />电竞酒店</span>
          </div>
        </SparkPanel>

        <SparkPanel title="平台整体健康度" subtitle="6 大子系统加权评分">
          <div className={s.healthSummary}>
            <div className={s.healthGauge} aria-label="平台健康度 96 分"><strong>96<small>/100</small></strong></div>
            <div className={s.healthCopy}>
              <b>健康 / Excellent</b>
              <span>集群运行正常，无阻断级告警</span>
              <small>GPU · 网络 · 收银 · 内容 · 安全 · 运维</small>
            </div>
          </div>
          <div className={s.poolList} style={{ marginTop: 23 }}>
            {GPU_POOLS.map((pool) => (
              <div className={s.poolItem} key={pool.name}>
                <div className={s.poolHead}><span>{pool.name}</span><strong>{pool.used}/{pool.total}</strong></div>
                <SparkProgress value={pool.used / pool.total * 100} tone={pool.tone} label={`${Math.round(pool.used / pool.total * 100)}%`} />
              </div>
            ))}
          </div>
          <div className={p.balancedGrid} style={{ marginTop: 18 }}>
            <div><span className={p.muted}>平均帧率</span><div className={p.metricValue}><strong style={{ fontSize: 20 }}>178</strong><span>FPS</span></div></div>
            <div><span className={p.muted}>端到端时延</span><div className={p.metricValue}><strong style={{ fontSize: 20 }}>18</strong><span>ms</span></div></div>
          </div>
        </SparkPanel>
      </div>

      <div className={s.dashboardLowerGrid}>
        <SparkPanel title="区县今日营收（千元）" subtitle="苏州 6 区 4 县市 Top 8">
          <div className={s.districtBars}>
            {DISTRICT_REVENUE.map((item) => (
              <div className={s.districtItem} key={item.district}>
                <span>{item.district}</span>
                <div className={s.districtTrack}><div className={s.districtFill} style={{ width: `${item.value / 160 * 100}%` }} /></div>
                <strong>{item.value}</strong>
              </div>
            ))}
          </div>
        </SparkPanel>

        <SparkPanel title="实时事件与告警" subtitle="今日 24 条">
          <div className={s.alertList}>
            {DASHBOARD_ALERTS.map((alert) => (
              <div className={s.alertItem} key={`${alert.time}-${alert.name}`}>
                <span className={s.alertTime}>{alert.time}</span>
                <div className={s.alertBody}><strong>{alert.name}</strong><p>{alert.text}</p></div>
              </div>
            ))}
          </div>
        </SparkPanel>
      </div>

      <SparkPanel title="今日营收 Top 6" subtitle="苏州全域门店实时排序">
        <div className={s.rankList}>
          {REVENUE_LEADERS.map((store) => (
            <div className={s.rankItem} key={store.rank}>
              <span className={s.rankNumber}>{store.rank}</span>
              <div><div className={s.rankName}>{store.name}</div><div className={s.rankDistrict}>{store.district}</div></div>
              <strong className={s.rankRevenue}>{store.revenue}</strong>
            </div>
          ))}
        </div>
      </SparkPanel>
    </div>
  );
}
