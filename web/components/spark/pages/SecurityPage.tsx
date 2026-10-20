"use client";

import { useState } from "react";
import { SECURITY_AUDIT_LOGS, SECURITY_DISASTER_RECOVERY, SECURITY_ENCRYPTION, SECURITY_METRICS, SECURITY_POLICIES, REGULATORY_CONNECTIONS } from "@/lib/spark/security";
import { SparkBadge, SparkButton, SparkMetric, SparkPageHeader, SparkPanel, SparkToggle } from "../SparkUI";
import p from "../SparkPages.module.css";
import s from "./SecurityOpsPermission.module.css";

const resultTone = (result: string) => result === "通过" ? "green" : result === "告警" ? "amber" : "rose";

export default function SecurityPage() {
  const [policies, setPolicies] = useState(() => Object.fromEntries(SECURITY_POLICIES.map((policy) => [policy.id, policy.enabled])) as Record<string, boolean>);
  const [scanComplete, setScanComplete] = useState(false);

  return (
    <div className={p.pageStack}>
      <SparkPageHeader
        title="安全合规与审计"
        subtitle="数据截至 2026-06-08 22:30 · 符合《网络安全法》《数据安全法》《个人信息保护法》"
        icon="security"
        actions={<SparkButton variant="primary" onClick={() => setScanComplete(true)}>一键合规巡检</SparkButton>}
      />
      {scanComplete && <div className={s.inlineNotice} role="status">巡检结果仅在当前页面内展示：综合安全评分 96.8 / 100（取自数据快照），未修改任何外部系统。</div>}

      <div className={`${p.metricGrid} ${s.slaGrid}`}>
        {SECURITY_METRICS.map((metric) => <SparkMetric key={metric.label} {...metric} />)}
      </div>

      <div className={s.policyGrid}>
        {SECURITY_POLICIES.map((policy) => (
          <article className={s.policyCard} key={policy.id}>
            <div className={s.policyHeader}>
              <div>
                <h2 className={s.policyTitle}>{policy.title}</h2>
                <p className={s.policyText}>{policy.description}</p>
                <p className={s.policyDetail}>{policy.detail}</p>
              </div>
              <SparkToggle
                label={policy.title}
                checked={Boolean(policies[policy.id])}
                onChange={(value) => setPolicies((current) => ({ ...current, [policy.id]: value }))}
              />
            </div>
          </article>
        ))}
      </div>

      <SparkPanel title="行为审计日志" subtitle="登录 / 消费 / 操作 / 内容访问 · 留存 180 天" action={<SparkBadge tone="cyan">上链存证 24,680 条</SparkBadge>}>
        <div className={p.tableWrap}>
          <table className={p.dataTable}>
            <thead><tr><th>时间</th><th>门店</th><th>用户</th><th>行为</th><th>对象</th><th>IP</th><th>结果</th></tr></thead>
            <tbody>{SECURITY_AUDIT_LOGS.map((row) => (
              <tr key={`${row.time}-${row.action}`}>
                <td className={p.mono}>{row.time}</td><td>{row.store}</td><td>{row.user}</td><td>{row.action}</td><td>{row.target}</td><td className={p.mono}>{row.ip}</td>
                <td><SparkBadge tone={resultTone(row.result)}>{row.result}</SparkBadge></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </SparkPanel>

      <SparkPanel title="数据加密体系" subtitle="传输、存储与审计数据的分层保护">
        <div className={s.cryptoGrid}>{SECURITY_ENCRYPTION.map((item) => <article className={s.cryptoCard} key={item.title}><span>{item.title}</span><strong>{item.value}</strong></article>)}</div>
      </SparkPanel>

      <SparkPanel title="备份与容灾" subtitle="双活架构与周期性恢复验证">
        <div className={s.recoveryGrid}>{SECURITY_DISASTER_RECOVERY.map((item) => <article className={s.recoveryCard} key={item.title}><span>{item.title}</span><strong>{item.value}</strong></article>)}</div>
        <p className={s.recoveryNote}>最近一次灾备演练：2026-05-28 · RTO 实测 3 分 42 秒</p>
      </SparkPanel>

      <SparkPanel title="苏州监管平台对接" subtitle="监管数据按业务类型同步与上报 · 下列记录取自数据快照">
        <div className={s.regulatorGrid}>{REGULATORY_CONNECTIONS.map((item) => <article className={s.regulatorCard} key={item.name}><SparkBadge tone="green">已对接</SparkBadge><h3 style={{ marginTop: 8 }}>{item.name}</h3><p>{item.scope}</p><small>{item.sync}</small></article>)}</div>
      </SparkPanel>
    </div>
  );
}
