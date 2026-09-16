"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  approvalsApi, errText,
  type PendingAdjust, type PendingApprovals, type PendingExpense, type PendingFilings,
} from "@/lib/api";
import { parseTarget, rowClass, useTargetScroll } from "@/lib/deepLink";
import { useMeta, useMenus } from "@/lib/useMeta";
import { fmtDate, fmtMoney } from "@/lib/labels";
import Empty from "@/components/ui/Empty";
import { LoadingBlock, LoadFailed, NoAccess } from "@/components/ui/PageState";
import { Confirm } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";

type Decision = {
  kind: string;
  id: number;
  approve: boolean;
  exception?: boolean;
  title: string;
  text?: string;
};

export default function ApprovalsPage() {
  // 审批中心属于管理与审批面：非管理员不拉取数据，也不会看到必然 403 的按钮
  const { isAdmin, loading: permsLoading, error: permsError, reload } = useMenus();

  if (permsLoading) return <LoadingBlock kpis={4} />;
  if (permsError) return <LoadFailed message={permsError} onRetry={reload} />;
  if (!isAdmin) {
    return (
      <div>
        <div className="page-head">
          <h1>审批中心<span className="sub">管理员全局管理与审批</span></h1>
        </div>
        <NoAccess
          title="审批中心仅管理员可用"
          hint={
            <>
              当前账号不属于管理员，无法查看或处理立项、预算调整与支出审批。
              <br />
              项目负责人与项目成员仍可在项目台账、进度跟进、成本支出中继续参与业务，审批结果会通过通知告知您。
            </>
          }
          extra={<Link className="btn-ghost" href="/costs">前往成本支出</Link>}
        />
      </div>
    );
  }
  return (
    <Suspense fallback={<LoadingBlock kpis={4} />}>
      <ApprovalsInner />
    </Suspense>
  );
}

function ApprovalsInner() {
  const sp = useSearchParams();
  // 通知深链定位：立项按项目 id，预算调整/支出按各自单据 id
  const filingTarget = parseTarget(sp.get("filing"));
  const adjustTarget = parseTarget(sp.get("adjust"));
  const expenseTarget = parseTarget(sp.get("expense"));

  const { userName } = useMeta();
  const toast = useToast();
  const [data, setData] = useState<PendingApprovals | null>(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);
  const [decision, setDecision] = useState<Decision | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    const id = ++loadSeq.current;
    const first = data === null;
    if (first) setLoading(true);
    setErr("");
    try {
      const r = await approvalsApi.pending();
      if (loadSeq.current !== id) return;
      setData(r);
    } catch (e) {
      if (loadSeq.current !== id) return;
      setErr(errText(e));
    } finally {
      if (loadSeq.current === id) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { load(); }, [load]);

  // 命中行滚动入视口（通知点进来时直接看到那一条待办）
  useTargetScroll(filingTarget || adjustTarget || expenseTarget, !loading && !!data);

  async function submitDecision() {
    if (!decision) return;
    setBusy(true);
    try {
      if (decision.exception) {
        await approvalsApi.exception(decision.id, reason || "超预算特批");
      } else {
        await approvalsApi.decide(decision.kind, decision.id, decision.approve, reason);
      }
      toast.ok(decision.exception ? "已特批放行" : decision.approve ? "已通过" : "已驳回");
      await load();
    } catch (e) {
      toast.err(errText(e));
    } finally {
      setBusy(false);
      setDecision(null);
      setReason("");
    }
  }

  const d = data;
  // Stage 3A：`totals` 是三类**真实总数**（不截断）；旧后端（无 totals）时退回 `total` 兼容字段。
  const totals = d?.totals;
  const perCategory = totals
    ? [totals.project_filings, totals.budget_adjusts, totals.expenses]
    : [d?.project_filings.length ?? 0, d?.budget_adjusts.length ?? 0, d?.expenses.length ?? 0];
  const grandTotal = totals ? perCategory.reduce((s, n) => s + n, 0) : d?.total ?? 0;
  const shownCount = d ? d.project_filings.length + d.budget_adjusts.length + d.expenses.length : 0;
  const hiddenCount = d ? Math.max(0, grandTotal - shownCount) : 0;
  const nothing = d && grandTotal === 0;

  // 定位参数指向的待办是否在当前可见范围内：不在就说明原因，别让管理员对着整页待办自己找
  const targetRows = [
    filingTarget && !d?.project_filings.some((p) => p.id === filingTarget) ? filingTarget : 0,
    adjustTarget && !d?.budget_adjusts.some((a) => a.id === adjustTarget) ? adjustTarget : 0,
    expenseTarget && !d?.expenses.some((e) => e.id === expenseTarget) ? expenseTarget : 0,
  ].filter(Boolean);
  const missedTarget = !loading && !!d && targetRows.length > 0;

  return (
    <div>
      <div className="page-head">
        <h1>
          审批中心
          <span className="sub">管理员全局管理与审批 · 立项 / 预算调整 / 支出 统一待办</span>
        </h1>
        <div className="actions no-print">
          <button className="btn-ghost" onClick={load} disabled={loading}>
            {loading ? "刷新中…" : "刷新"}
          </button>
        </div>
      </div>

      {err && <div className="err-banner" role="alert">{err}</div>}
      {notice && (
        <div className="warn-banner" role="status" style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ flex: 1, minWidth: 200 }}>{notice}</span>
          <button type="button" className="btn-ghost" onClick={() => setNotice("")}>关闭</button>
        </div>
      )}
      {missedTarget && (
        <div className="warn-banner" role="alert" style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ flex: 1, minWidth: 200 }}>
            通知指向的待办（#{targetRows.join("、#")}）已不在待审批列表中：可能刚被处理，或已超过单次展示上限。
          </span>
          <button type="button" className="btn-ghost" onClick={() => { setNotice("已按当前待办列表重新加载。"); load(); }}>
            重新加载
          </button>
        </div>
      )}

      {loading ? (
        <LoadingBlock kpis={4} />
      ) : nothing ? (
        <div className="card">
          <Empty title="没有待处理事项" hint="立项、预算调整、支出审批通过后会自动出现在这里。" />
        </div>
      ) : (
        <>
          <div className="kpi-row">
            <div className="kpi"><div className="k">待处理总数</div><div className="v mono">{grandTotal}</div></div>
            <div className="kpi"><div className="k">立项审批</div><div className="v mono">{perCategory[0]}</div></div>
            <div className="kpi"><div className="k">预算调整</div><div className="v mono">{perCategory[1]}</div></div>
            <div className="kpi"><div className="k">支出审批</div><div className="v mono">{perCategory[2]}</div></div>
          </div>

          {hiddenCount > 0 && (
            <div className="muted tiny" role="status" style={{ marginBottom: 8 }}>
              还有 {hiddenCount} 条待办未展示（每类最多显示前 {d?.limit ?? 200} 条，处理后可用「刷新」继续）
            </div>
          )}

          {!totals && shownCount > 0 && (
            <div className="muted tiny" role="status" style={{ marginBottom: 8 }}>
              当前后端未返回各类待办真实总数，上方数字为已加载条数。
            </div>
          )}

          {(d?.project_filings.length ?? 0) > 0 && (
            <>
              <h2 className="section-title">立项审批</h2>
              <div className="table-scroll">
                <table className="grid" style={{ marginBottom: 16 }} aria-busy={loading}>
                  <thead>
                    <tr><th>编号</th><th>项目名称</th><th>负责人</th><th className="num">预算</th><th>计划期</th><th className="no-print" /></tr>
                  </thead>
                  <tbody>
                    {d!.project_filings.map((p: PendingFilings) => {
                      const hit = p.id === filingTarget;
                      return (
                        <tr key={p.id} data-target-id={p.id} className={rowClass(undefined, hit)}>
                          <td className="mono tiny">{p.code}</td>
                          <td>
                            <Link href={`/projects/${p.project_id}`}>{p.name}</Link>
                            {hit && <span className="tiny"> · 来自通知</span>}
                          </td>
                          <td>{userName(p.owner_id)}</td>
                          <td className="num">{fmtMoney(p.budget_total)}</td>
                          <td className="mono tiny">{fmtDate(p.plan_start)} ~ {fmtDate(p.plan_end)}</td>
                          <td className="no-print">
                            <span style={{ display: "inline-flex", gap: 6 }}>
                              <button
                                className="btn-ghost"
                                style={{ height: 26, lineHeight: "24px", padding: "0 8px", fontSize: 12 }}
                                disabled={!p.can_decide}
                                title={p.can_decide ? undefined : "仅管理员可审批"}
                                onClick={() => setDecision({ kind: "project_filing", id: p.project_id, approve: true, title: `通过立项「${p.name}」？`, text: "通过后项目状态变为「已立项」，可开始排期。" })}
                              >
                                通过
                              </button>
                              <button
                                className="btn-ghost"
                                style={{ height: 26, lineHeight: "24px", padding: "0 8px", fontSize: 12, color: "var(--danger)", borderColor: "var(--line-danger)" }}
                                disabled={!p.can_decide}
                                onClick={() => setDecision({ kind: "project_filing", id: p.project_id, approve: false, title: `驳回立项「${p.name}」？`, text: "驳回后项目状态变为「已取消」（终态）。" })}
                              >
                                驳回
                              </button>
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {(d?.budget_adjusts.length ?? 0) > 0 && (
            <>
              <h2 className="section-title">预算调整</h2>
              <div className="table-scroll">
                <table className="grid" style={{ marginBottom: 16 }} aria-busy={loading}>
                  <thead>
                    <tr><th>项目</th><th>科目</th><th className="num">原预算</th><th className="num">调整后</th><th>申请人</th><th>理由</th><th className="no-print" /></tr>
                  </thead>
                  <tbody>
                    {d!.budget_adjusts.map((a: PendingAdjust) => {
                      const hit = a.id === adjustTarget;
                      return (
                        <tr key={a.id} data-target-id={a.id} className={rowClass(undefined, hit)}>
                          <td><span className="ellipsis" title={a.project_name}>{a.project_name}</span>{hit && <span className="tiny"> · 来自通知</span>}</td>
                          <td>{a.subject}</td>
                          <td className="num">{fmtMoney(a.old_amount)}</td>
                          <td className="num mono">{fmtMoney(a.new_amount)}</td>
                          <td>{userName(a.by_id)}</td>
                          <td className="muted">{a.reason || "-"}</td>
                          <td className="no-print">
                            <span style={{ display: "inline-flex", gap: 6 }}>
                              <button
                                className="btn-ghost"
                                style={{ height: 26, lineHeight: "24px", padding: "0 8px", fontSize: 12 }}
                                disabled={!a.can_decide}
                                title={a.can_decide ? undefined : "仅管理员可审批"}
                                onClick={() => setDecision({ kind: "budget_adjust", id: a.id, approve: true, title: `通过预算调整（${a.subject}）？`, text: `${fmtMoney(a.old_amount)} → ${fmtMoney(a.new_amount)}，通过后立即生效并留痕。` })}
                              >
                                通过
                              </button>
                              <button
                                className="btn-ghost"
                                style={{ height: 26, lineHeight: "24px", padding: "0 8px", fontSize: 12, color: "var(--danger)", borderColor: "var(--line-danger)" }}
                                disabled={!a.can_decide}
                                onClick={() => setDecision({ kind: "budget_adjust", id: a.id, approve: false, title: "驳回预算调整？", text: "预算金额保持不变，申请人可在成本页看到您的审批意见。" })}
                              >
                                驳回
                              </button>
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {(d?.expenses.length ?? 0) > 0 && (
            <>
              <h2 className="section-title">支出审批</h2>
              <div className="table-scroll">
                <table className="grid" aria-busy={loading}>
                  <thead>
                    <tr><th>项目</th><th>人员</th><th className="num">金额</th><th>日期</th><th>说明</th><th>经办人</th><th className="no-print" /></tr>
                  </thead>
                  <tbody>
                    {d!.expenses.map((e: PendingExpense) => {
                      const hit = e.id === expenseTarget;
                      return (
                        <tr key={e.id} data-target-id={e.id} className={rowClass(undefined, hit)}>
                          <td><span className="ellipsis" title={e.project_name}>{e.project_name}</span>{hit && <span className="tiny"> · 来自通知</span>}</td>
                          <td>{e.subject}</td>
                          <td className="num mono">{fmtMoney(e.amount)}</td>
                          <td className="mono tiny">{fmtDate(e.exp_date)}</td>
                          <td className="muted"><span className="ellipsis" title={e.note}>{e.note || "-"}</span></td>
                          <td>{userName(e.by_id)}</td>
                          <td className="no-print">
                            <span style={{ display: "inline-flex", gap: 6 }}>
                              <button
                                className="btn-ghost"
                                style={{ height: 26, lineHeight: "24px", padding: "0 8px", fontSize: 12 }}
                                disabled={!e.can_decide}
                                title={e.can_decide ? undefined : "仅管理员可审批"}
                                onClick={() => setDecision({ kind: "expense", id: e.id, approve: true, title: `通过支出 ${fmtMoney(e.amount)} 元？`, text: "通过后计入预算执行。" })}
                              >
                                通过
                              </button>
                              <button
                                className="btn-ghost"
                                style={{ height: 26, lineHeight: "24px", padding: "0 8px", fontSize: 12 }}
                                disabled={!e.can_decide}
                                onClick={() => setDecision({ kind: "expense", id: e.id, approve: false, title: "驳回该支出？", text: "经办人可在成本页看到您的审批意见，并修改后重新提交。" })}
                              >
                                驳回
                              </button>
                              <button
                                className="btn-ghost"
                                style={{ height: 26, lineHeight: "24px", padding: "0 8px", fontSize: 12, color: "var(--danger)", borderColor: "var(--line-danger)" }}
                                disabled={!e.can_decide}
                                onClick={() => setDecision({ kind: "expense", id: e.id, approve: true, exception: true, title: `特批放行 ${fmtMoney(e.amount)} 元？`, text: "特批将绕过预算上限计入执行，操作写入审计日志。" })}
                              >
                                特批放行
                              </button>
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}

      <Confirm
        open={!!decision}
        danger={!decision?.approve || !!decision?.exception}
        loading={busy}
        title={decision?.title ?? ""}
        text={
          <>
            {decision?.text}
            <div style={{ marginTop: 10 }}>
              <label className="field" style={{ fontSize: 13, color: "var(--ink-2)" }}>
                <span className="field-label">审批意见（可选）</span>
                <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="填写的意见会通知申请人" />
              </label>
            </div>
          </>
        }
        okText={decision?.exception ? "确认特批" : decision?.approve ? "确认通过" : "确认驳回"}
        onConfirm={submitDecision}
        onCancel={() => { setDecision(null); setReason(""); }}
      />
    </div>
  );
}
