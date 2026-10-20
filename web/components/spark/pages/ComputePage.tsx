"use client";

import { useState } from "react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { CLOUD_PACKAGES, COMPUTE_LOAD, COMPUTE_NODES, SCHEDULING_STRATEGIES } from "@/lib/spark/compute";
import { SparkBadge, SparkMetric, SparkPageHeader, SparkPanel, SparkProgress, SparkToggle } from "../SparkUI";
import p from "../SparkPages.module.css";
import s from "./DashboardStoreCompute.module.css";

type StrategyName = (typeof SCHEDULING_STRATEGIES)[number]["name"];

const chartTick = { fill: "#718096", fontSize: 9 };
const formatLatency = (value: number) => `${value} ms`;

export default function ComputePage() {
  const [strategy, setStrategy] = useState<StrategyName>("时延优先");
  const [elasticEnabled, setElasticEnabled] = useState(true);
  const [threshold, setThreshold] = useState(82);
  const [step, setStep] = useState(32);
  const [cooldown, setCooldown] = useState(60);

  return (
    <div className={p.pageStack}>
      <SparkPageHeader title="算力智能调度" subtitle="苏州 3 大边缘机房 + 4 个区县边缘节点 · GPU 资源池数据快照" icon="compute" status="AI 调度策略基线" />

      <div className={`${p.metricGrid} ${s.computeMetrics}`}>
        <SparkMetric label="GPU 平均负载" value="73" unit="%" detail="苏州算力池利用率" tone="cyan" icon="compute" />
        <SparkMetric label="平均端到端时延" value="18" unit="ms" detail="跨区调度目标 ≤ 30ms" tone="violet" icon="dashboard" />
        <SparkMetric label="活跃云机会话" value="294" unit="路" detail="8 个 GPU 节点在线" tone="green" icon="store" />
        <SparkMetric label="告警节点" value="1/8" detail="SIP-GPU-B07 温度偏高" tone="amber" icon="security" />
      </div>

      <SparkPanel title="苏州算力池 24h 负载" subtitle="GPU 利用率 & 网络吞吐基线" action={<SparkBadge tone="slate">24 小时基线</SparkBadge>}>
        <div className={`${p.chartBox} ${p.chartBoxTall}`}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={COMPUTE_LOAD} margin={{ top: 8, right: 8, bottom: 0, left: -20 }}>
              <CartesianGrid stroke="rgba(194,211,239,.08)" vertical={false} />
              <XAxis dataKey="hour" tick={chartTick} axisLine={{ stroke: "rgba(194,211,239,.1)" }} tickLine={false} />
              <YAxis domain={[0, 100]} ticks={[0, 25, 50, 75, 100]} tick={chartTick} axisLine={false} tickLine={false} width={42} tickFormatter={(value) => `${value}%`} />
              <Tooltip
                contentStyle={{ background: "#101724", border: "1px solid rgba(194,211,239,.16)", borderRadius: 7, color: "#dbe6f5", fontSize: 10 }}
                formatter={(value, name) => [`${value}%`, name === "gpu" ? "GPU 利用率" : "网络吞吐"]}
                labelFormatter={(value) => `${value}:00`}
              />
              <Line type="monotone" dataKey="gpu" name="GPU 利用率" stroke="#22d3ee" strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
              <Line type="monotone" dataKey="network" name="网络吞吐" stroke="#a855f7" strokeWidth={1.8} dot={false} activeDot={{ r: 4 }} />
            </LineChart>
          </ResponsiveContainer>
        </div>
        <div className={p.chartLegend}>
          <span className={p.legendItem}><i style={{ background: "#22d3ee" }} />GPU 利用率</span>
          <span className={p.legendItem}><i style={{ background: "#a855f7" }} />网络吞吐</span>
        </div>
      </SparkPanel>

      <SparkPanel title="智能调度策略" subtitle="根据门店位置、算力成本与会话密度分配边缘节点">
        <div className={s.strategyGrid}>
          {SCHEDULING_STRATEGIES.map((item) => (
            <button key={item.name} type="button" className={`${s.strategyButton} ${strategy === item.name ? s.strategySelected : ""}`} aria-pressed={strategy === item.name} onClick={() => setStrategy(item.name)}>
              <span className={s.strategyIcon} aria-hidden="true">{item.icon}</span>
              <span><strong>{item.name}</strong><small>{item.description}</small></span>
            </button>
          ))}
        </div>
      </SparkPanel>

      <SparkPanel title="弹性伸缩配置" subtitle="根据 GPU 利用率自动扩容，并在冷却窗口内合并调度">
        <div className={s.elasticList}>
          <div className={s.elasticRow}>
            <span className={s.elasticLabel}>自动弹性扩容</span>
            <span className={p.muted} style={{ fontSize: 9 }}>{elasticEnabled ? "已启用" : "已暂停"}</span>
            <SparkToggle label="自动弹性扩容" checked={elasticEnabled} onChange={setElasticEnabled} />
          </div>
          <label className={s.elasticRow}>
            <span className={s.elasticLabel}>扩容触发阈值（GPU 利用率）</span>
            <input className={s.rangeInput} type="range" min={50} max={98} value={threshold} onChange={(event) => setThreshold(Number(event.target.value))} aria-label="扩容触发阈值（GPU 利用率）" />
            <span className={s.elasticValue}>{threshold}%</span>
          </label>
          <label className={s.elasticRow}>
            <span className={s.elasticLabel}>单次扩容步长</span>
            <input className={s.rangeInput} type="range" min={8} max={64} step={8} value={step} onChange={(event) => setStep(Number(event.target.value))} aria-label="单次扩容步长" />
            <span className={s.elasticValue}>{step} 路</span>
          </label>
          <label className={s.elasticRow}>
            <span className={s.elasticLabel}>冷却时间（秒）</span>
            <input className={s.rangeInput} type="range" min={10} max={180} step={10} value={cooldown} onChange={(event) => setCooldown(Number(event.target.value))} aria-label="冷却时间（秒）" />
            <span className={s.elasticValue}>{cooldown}s</span>
          </label>
        </div>
      </SparkPanel>

      <SparkPanel title="GPU 节点状态" subtitle="8 个节点 · 资源与链路时延" action={<span className={p.muted} style={{ fontSize: 9 }}>当前策略：{strategy}</span>}>
        <div className={p.tableWrap}>
          <table className={p.dataTable}>
            <thead><tr><th>节点 ID / 机房</th><th>型号</th><th>GPU 利用率</th><th>显存</th><th>温度</th><th>功耗</th><th>会话</th><th>时延</th></tr></thead>
            <tbody>
              {COMPUTE_NODES.map((node) => (
                <tr key={node.id}>
                  <td><strong style={{ color: "#d3dfed", fontWeight: 520 }}>{node.id}</strong><div className={p.muted} style={{ marginTop: 3, fontSize: 8 }}>{node.site}</div></td>
                  <td>{node.model}</td>
                  <td style={{ minWidth: 112 }}><SparkProgress value={node.utilization} tone={node.utilization >= 90 ? "amber" : "cyan"} label={`${node.utilization}%`} /></td>
                  <td className={p.mono}>{node.memory}</td>
                  <td><SparkBadge tone={node.temperature >= 80 ? "amber" : "green"}>{node.temperature}°C</SparkBadge></td>
                  <td className={p.mono}>{node.power}W</td>
                  <td className={p.mono}>{node.sessions}</td>
                  <td className={p.mono}>{formatLatency(node.latency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SparkPanel>

      <SparkPanel title="云机套餐" subtitle="按算力规格提供不同画质与时长组合">
        <div className={s.packageGrid}>
          {CLOUD_PACKAGES.map((item) => (
            <article className={s.packageCard} key={item.name}>
              <SparkBadge tone={item.tag === "热门" ? "cyan" : item.tag === "赛事" ? "violet" : "slate"}>{item.tag}</SparkBadge>
              <strong>{item.name}</strong><p>{item.model}</p><small>{item.resolution}</small>
              <span className={s.packagePrice}>{item.price}</span>
            </article>
          ))}
        </div>
      </SparkPanel>
    </div>
  );
}
