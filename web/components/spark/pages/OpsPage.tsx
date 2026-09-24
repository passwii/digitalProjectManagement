"use client";

import { useMemo, useState } from "react";
import { OPS_METRICS, OPS_SLA, OPS_SUBSYSTEMS, OPS_TICKETS, type SparkTicket, type SparkTicketStatus } from "@/lib/spark/ops";
import { SparkBadge, SparkButton, SparkMetric, SparkPageHeader, SparkPanel, SparkTabs } from "../SparkUI";
import p from "../SparkPages.module.css";
import s from "./SecurityOpsPermission.module.css";

type TicketFilter = "全部" | "待派单" | "处理中" | "已解决/关闭";
const FILTERS: readonly { value: TicketFilter; label: string }[] = [
  { value: "全部", label: "全部" },
  { value: "待派单", label: "待派单" },
  { value: "处理中", label: "处理中" },
  { value: "已解决/关闭", label: "已解决/关闭" },
];
const statusTone: Record<SparkTicketStatus, "amber" | "cyan" | "green" | "slate"> = {
  "待派单": "amber", "处理中": "cyan", "已解决": "green", "已关闭": "slate",
};
const priorityClass: Record<string, string> = { P0: s.priority, P1: `${s.priority} ${s.priorityP1}`, P2: `${s.priority} ${s.priorityP2}`, P3: `${s.priority} ${s.priorityP3}` };

export default function OpsPage() {
  const [filter, setFilter] = useState<TicketFilter>("全部");
  const [tickets, setTickets] = useState<SparkTicket[]>(() => OPS_TICKETS.map((ticket) => ({ ...ticket })));
  const [expanded, setExpanded] = useState<string | null>(null);
  const [notice, setNotice] = useState(false);

  const visibleTickets = useMemo(() => tickets.filter((ticket) => {
    if (filter === "全部") return true;
    if (filter === "已解决/关闭") return ticket.status === "已解决" || ticket.status === "已关闭";
    return ticket.status === filter;
  }), [filter, tickets]);

  const progressTicket = (id: string, status: SparkTicketStatus) => {
    const nextStatus: SparkTicketStatus = status === "待派单" ? "处理中" : "已解决";
    setTickets((current) => current.map((ticket) => ticket.id === id ? { ...ticket, status: nextStatus, assignee: ticket.assignee === "待派单" ? "苏州现场组 · 演示指派" : ticket.assignee, sla: nextStatus === "已解决" ? "演示标记为已解决" : ticket.sla } : ticket));
  };

  const counts = {
    "全部": tickets.length,
    "待派单": tickets.filter((ticket) => ticket.status === "待派单").length,
    "处理中": tickets.filter((ticket) => ticket.status === "处理中").length,
    "已解决/关闭": tickets.filter((ticket) => ticket.status === "已解决" || ticket.status === "已关闭").length,
  };

  return (
    <div className={p.pageStack}>
      <SparkPageHeader
        title="运维工单与智能监控"
        subtitle="数据截至 2026-06-08 22:30 · 苏州全域统一工单中心"
        icon="ops"
        actions={<SparkButton variant="primary" onClick={() => setNotice(true)}>提交工单</SparkButton>}
      />
      {notice && <div className={s.inlineNotice} role="status">演示环境不会提交真实工单；当前列表仅使用本地 mock 数据。</div>}

      <div className={`${p.metricGrid} ${s.slaGrid}`}>
        {OPS_METRICS.map((metric) => <SparkMetric key={metric.label} {...metric} />)}
      </div>

      <SparkPanel title="六大子系统健康度" subtitle="各系统实时健康评分">
        <div className={s.subsystemGrid}>{OPS_SUBSYSTEMS.map((item) => <article className={s.subsystemCard} key={item.name}><span>{item.name}</span><strong>{item.score}</strong><small>{item.health}</small></article>)}</div>
      </SparkPanel>

      <SparkPanel title="工单中心" subtitle="按优先级、状态与剩余 SLA 跟进处理" action={<span className={p.muted} style={{ fontSize: 9 }}>苏州全域 · {tickets.length} 单</span>}>
        <div style={{ marginBottom: 12 }}>
          <SparkTabs items={FILTERS.map((item) => ({ ...item, label: `${item.label} (${counts[item.value]})` }))} value={filter} onChange={setFilter} label="工单状态筛选" />
        </div>
        {visibleTickets.length ? (
          <div className={s.ticketGrid}>
            {visibleTickets.map((ticket) => (
              <article className={s.ticketCard} key={ticket.id}>
                <div className={s.ticketHead}>
                  <div className={s.ticketTitle}><span className={priorityClass[ticket.priority]}>{ticket.priority}</span><h3>{ticket.title}</h3></div>
                  <SparkBadge tone={statusTone[ticket.status]}>{ticket.status}</SparkBadge>
                </div>
                <p className={s.ticketDescription}>{ticket.description}</p>
                <div className={s.ticketMeta}>
                  <span><strong>工单号：</strong>{ticket.id}</span><span><strong>门店：</strong>{ticket.store}</span>
                  <span><strong>分类：</strong>{ticket.category}</span><span><strong>负责人：</strong>{ticket.assignee}</span>
                  <span><strong>创建：</strong>{ticket.created}</span>
                </div>
                {expanded === ticket.id && <div className={s.ticketDetail}>处理说明：{ticket.description} 当前剩余 SLA：{ticket.sla}。</div>}
                <div className={s.ticketFoot}>
                  <span className={s.ticketSla}>{ticket.sla}</span>
                  <div className={s.ticketActions}>
                    {ticket.status === "待派单" && <SparkButton onClick={() => progressTicket(ticket.id, ticket.status)}>派单</SparkButton>}
                    {ticket.status === "处理中" && <SparkButton onClick={() => progressTicket(ticket.id, ticket.status)}>处理</SparkButton>}
                    <SparkButton variant="quiet" onClick={() => setExpanded((current) => current === ticket.id ? null : ticket.id)}>{expanded === ticket.id ? "收起" : "详情"}</SparkButton>
                  </div>
                </div>
              </article>
            ))}
          </div>
        ) : <div className={p.emptyState}>当前状态暂无工单</div>}
      </SparkPanel>

      <SparkPanel title="服务等级目标（SLA）" subtitle="按优先级监控响应时长与可用性">
        <div className={s.slaGrid}>{OPS_SLA.map((item) => <article className={s.slaCard} key={item.name}><span>{item.name}</span><strong>{item.value}</strong><small>{item.target}</small></article>)}</div>
      </SparkPanel>
    </div>
  );
}
