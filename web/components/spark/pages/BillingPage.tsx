"use client";

import { useState } from "react";
import Select from "@/components/ui/Select";
import {
  BILLING_CAMPAIGNS,
  BILLING_MEMBER_TIERS,
  BILLING_MEMBERS,
  BILLING_METRICS,
  BILLING_PAYMENT_CHANNELS,
  BILLING_RECHARGE_AMOUNTS,
  BILLING_REVENUE_DAYS,
  BILLING_REVENUE_SERIES,
  BILLING_RULES,
  BILLING_STORES,
  BILLING_TABS,
  CASHIER_METHODS,
  CASHIER_TYPES,
} from "@/lib/spark/billing";
import type { BillingTab } from "@/lib/spark/billing";
import { SparkBadge, SparkMetric, SparkPageHeader, SparkPanel, SparkTabs } from "../SparkUI";
import p from "../SparkPages.module.css";
import s from "./BillingContent.module.css";

const amountBonuses: Record<number, number> = { 100: 5, 200: 20, 500: 80, 1000: 220 };

function RevenueChart() {
  return (
    <div className={s.chartScroll}>
      <svg className={s.revenueChart} viewBox="0 0 850 250" role="img" aria-label="近 7 日会员、散客、电竞酒店营收趋势图，单位元">
        <defs>
          <linearGradient id="billing-member-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="#22d3ee" stopOpacity=".22" /><stop offset="100%" stopColor="#22d3ee" stopOpacity=".015" /></linearGradient>
          <linearGradient id="billing-walkin-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="#a855f7" stopOpacity=".2" /><stop offset="100%" stopColor="#a855f7" stopOpacity=".01" /></linearGradient>
          <linearGradient id="billing-hotel-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="#34d399" stopOpacity=".2" /><stop offset="100%" stopColor="#34d399" stopOpacity=".01" /></linearGradient>
        </defs>
        {[13, 66, 119, 172, 225].map((y, index) => (
          <g key={y}>
            <line x1="65" x2="819" y1={y} y2={y} stroke="rgba(194,211,239,.09)" />
            <text x="56" y={y + 3} textAnchor="end" fill="#718096" fontSize="9">{(4 - index) * 250000 === 1000000 ? "1000000" : ((4 - index) * 250000).toString()}</text>
          </g>
        ))}
        {BILLING_REVENUE_SERIES.map((series) => (
          <g key={series.label}>
            <path d={series.area} fill={series.fill} />
            <path d={series.path} fill="none" stroke={series.color} strokeWidth="1.2" />
          </g>
        ))}
        {BILLING_REVENUE_DAYS.map((day, index) => (
          <text key={day} x={65 + index * 125.667} y="241" textAnchor="middle" fill="#718096" fontSize="9">{day}</text>
        ))}
      </svg>
    </div>
  );
}

function PaymentChannels() {
  const radius = 46;
  const circumference = 2 * Math.PI * radius;
  let consumed = 0;

  return (
    <div className={s.paymentLayout}>
      <svg className={s.paymentDonut} viewBox="0 0 120 120" role="img" aria-label="支付渠道占比">
        <circle cx="60" cy="60" r={radius} fill="none" stroke="rgba(194,211,239,.08)" strokeWidth="16" />
        {BILLING_PAYMENT_CHANNELS.map((channel) => {
          const segment = (channel.value / 100) * circumference;
          const offset = consumed;
          consumed += segment;
          return (
            <circle
              key={channel.name}
              cx="60"
              cy="60"
              r={radius}
              fill="none"
              stroke={channel.color}
              strokeWidth="16"
              strokeDasharray={`${segment} ${circumference - segment}`}
              strokeDashoffset={-offset}
              transform="rotate(-90 60 60)"
            />
          );
        })}
        <text x="60" y="57" textAnchor="middle" fill="#dce6f5" fontSize="10">支付渠道</text>
        <text x="60" y="72" textAnchor="middle" fill="#748197" fontSize="8">占比</text>
      </svg>
      <ul className={s.channelLegend}>
        {BILLING_PAYMENT_CHANNELS.map((channel) => (
          <li key={channel.name}>
            <span className={s.channelName}><i style={{ background: channel.color }} />{channel.name}</span>
            <strong>{channel.value}%</strong>
          </li>
        ))}
      </ul>
    </div>
  );
}

function BillingOverview() {
  return (
    <>
      <div className={p.metricGrid}>
        {BILLING_METRICS.map((metric) => <SparkMetric key={metric.label} {...metric} />)}
      </div>

      <div className={s.billingOverviewGrid}>
        <SparkPanel title="近 7 日营收构成" subtitle="会员 / 散客 / 电竞酒店（元）">
          <RevenueChart />
          <div className={p.chartLegend}>
            {BILLING_REVENUE_SERIES.map((series) => <span className={p.legendItem} key={series.label}><i style={{ background: series.color }} />{series.label}</span>)}
          </div>
        </SparkPanel>
        <SparkPanel title="支付渠道占比">
          <PaymentChannels />
        </SparkPanel>
      </div>

      <SparkPanel title="差异化计费规则">
        <div className={p.tableWrap}>
          <table className={`${p.dataTable} ${s.rulesTable}`}>
            <thead><tr><th>时段</th><th>时间</th><th>散客价</th><th>会员价</th><th>包厢价</th></tr></thead>
            <tbody>{BILLING_RULES.map((rule) => (
              <tr key={rule.period}>
                <td>{rule.period}</td><td className={p.mono}>{rule.time}</td>
                <td>{rule.walkIn}</td><td className={s.memberPrice}>{rule.member}</td><td className={s.roomPrice}>{rule.privateRoom}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </SparkPanel>
    </>
  );
}

function CashierTab() {
  const [store, setStore] = useState<string>(BILLING_STORES[0]);
  const [chargeType, setChargeType] = useState<string>(CASHIER_TYPES[0]);
  const [amount, setAmount] = useState(30);
  const [payment, setPayment] = useState<string>(CASHIER_METHODS[0]);
  const [rechargeAmount, setRechargeAmount] = useState<number>(200);
  const [cashierNotice, setCashierNotice] = useState("");
  const [rechargeNotice, setRechargeNotice] = useState("");
  const bonus = amountBonuses[rechargeAmount] ?? 0;

  return (
    <div className={s.cashierGrid}>
      <SparkPanel title="快速收银" subtitle="苏州全域统一收银 · 结算结果在当前页面内生效">
        <div className={s.formStack}>
          <label className={s.fieldLabel}>所属门店
            <Select className={p.sparkSelect} surface="spark" value={store} onChange={setStore} aria-label="所属门店">
              {BILLING_STORES.map((name) => <option key={name} value={name}>{name}</option>)}
            </Select>
          </label>
          <fieldset className={s.fieldset}>
            <legend>收银类型</legend>
            <div className={p.filterRow}>
              {CASHIER_TYPES.map((type) => <button key={type} type="button" className={`${p.filterButton} ${chargeType === type ? p.filterSelected : ""}`} aria-pressed={chargeType === type} onClick={() => setChargeType(type)}>{type}</button>)}
            </div>
          </fieldset>
          <label className={s.fieldLabel}>应收金额
            <span className={s.amountField}><span>¥</span><input type="number" min="0" step="1" value={amount} onChange={(event) => setAmount(Math.max(0, Number(event.target.value)))} aria-label="应收金额" /></span>
          </label>
          <fieldset className={s.fieldset}>
            <legend>支付方式</legend>
            <div className={p.filterRow}>
              {CASHIER_METHODS.map((method) => <button key={method} type="button" className={`${p.filterButton} ${payment === method ? p.filterSelected : ""}`} aria-pressed={payment === method} onClick={() => setPayment(method)}>{method}</button>)}
            </div>
          </fieldset>
          <button type="button" className={s.confirmButton} onClick={() => setCashierNotice(`已确认收银：${store} · ${chargeType} · ${payment} · ¥${amount}`)}>确认收银 ¥{amount}</button>
          {cashierNotice && <p className={s.localNotice} role="status">{cashierNotice}</p>}
        </div>
      </SparkPanel>

      <SparkPanel title="会员充值" subtitle="充值成功后赠送金额计入当前账户余额">
        <div className={s.rechargeAmounts}>
          {BILLING_RECHARGE_AMOUNTS.map((value) => <button key={value} type="button" className={`${p.filterButton} ${rechargeAmount === value ? p.filterSelected : ""}`} aria-pressed={rechargeAmount === value} onClick={() => setRechargeAmount(value)}>¥{value}</button>)}
        </div>
        <div className={s.tierOfferList}>
          {BILLING_MEMBER_TIERS.map((tier) => <div className={s.tierOffer} key={tier.name}><strong>{tier.name}</strong><span>{tier.discount}</span><small>{tier.recharge}</small></div>)}
        </div>
        <button type="button" className={s.confirmButton} onClick={() => setRechargeNotice(`充值成功：实付 ¥${rechargeAmount}，赠送 ¥${bonus}，余额入账 ¥${rechargeAmount + bonus}`)}>立即充值 ¥{rechargeAmount}</button>
        {rechargeNotice && <p className={s.localNotice} role="status">{rechargeNotice}</p>}
      </SparkPanel>
    </div>
  );
}

function MemberTab() {
  return (
    <>
      <div className={`${p.fourGrid} ${s.memberTierGrid}`}>
        {BILLING_MEMBER_TIERS.map((tier, index) => (
          <SparkMetric key={tier.name} label={tier.name} value={tier.count} unit="人" detail={`${tier.discount} · ${tier.recharge}`} tone={(["slate", "cyan", "amber", "violet"] as const)[index]} icon="permission" />
        ))}
      </div>
      <SparkPanel title="会员列表" subtitle="苏州全域会员档案">
        <div className={p.tableWrap}>
          <table className={`${p.dataTable} ${s.membersTable}`}>
            <thead><tr><th>会员号</th><th>姓名</th><th>手机号</th><th>等级</th><th>余额</th><th>积分</th><th>累计时长</th><th>常用门店</th></tr></thead>
            <tbody>{BILLING_MEMBERS.map((member) => (
              <tr key={member.id}>
                <td className={p.mono}>{member.id}</td><td>{member.name}</td><td className={p.mono}>{member.phone}</td>
                <td><SparkBadge tone={member.tier === "钻石会员" ? "violet" : member.tier === "黄金会员" ? "amber" : "cyan"}>{member.tier}</SparkBadge></td>
                <td className={p.mono}>¥{member.balance}</td><td className={p.mono}>{member.points}</td><td className={p.mono}>{member.hours}</td><td>{member.store}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </SparkPanel>
    </>
  );
}

function MarketingTab() {
  return (
    <SparkPanel title="营销活动" subtitle="会员储值与门店优惠文案">
      <div className={s.campaignGrid}>
        {BILLING_CAMPAIGNS.map((campaign, index) => (
          <article className={s.campaignCard} key={campaign.name}>
            <div className={s.campaignTop}><SparkBadge tone={(["cyan", "violet", "amber", "green"] as const)[index]}>{campaign.kind}</SparkBadge><span>活动优惠</span></div>
            <h3>{campaign.name}</h3>
            <strong>{campaign.offer}</strong>
          </article>
        ))}
      </div>
    </SparkPanel>
  );
}

export default function BillingPage() {
  const [tab, setTab] = useState<BillingTab>("overview");

  return (
    <div className={p.pageStack}>
      <SparkPageHeader title="计费收银与会员营销" subtitle="数据截至 2026-06-08 22:30 · 苏州全域统一收银" icon="billing" status="苏州全域统一收银" />
      <div className={s.tabsRow}><SparkTabs items={BILLING_TABS} value={tab} onChange={setTab} label="计费模块" /></div>
      {tab === "overview" && <BillingOverview />}
      {tab === "cashier" && <CashierTab />}
      {tab === "members" && <MemberTab />}
      {tab === "marketing" && <MarketingTab />}
    </div>
  );
}
