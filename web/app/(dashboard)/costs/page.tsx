"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  budgetsApi, errText, expensesApi, projectsApi, unwrapList,
  type Budget, type Expense, type Project,
} from "@/lib/api";
import { useMeta } from "@/lib/useMeta";
import { expenseStatusLabel, expenseTone, fmtDate, fmtMoney, fmtPct } from "@/lib/labels";
import Badge from "@/components/ui/Badge";
import Empty from "@/components/ui/Empty";
import ProgressBar from "@/components/ui/ProgressBar";
import { Confirm } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import BudgetDialog from "./BudgetDialog";
import ExpenseDialog from "./ExpenseDialog";

export default function CostsPage() {
  return (
    <Suspense fallback={<p className="muted">加载中…</p>}>
      <CostsInner />
    </Suspense>
  );
}

function CostsInner() {
  const sp = useSearchParams();
  const { userName } = useMeta();
  const toast = useToast();

  const [projects, setProjects] = useState<Project[]>([]);
  const [pid, setPid] = useState<string>(sp.get("project_id") ?? "");
  const [budgets, setBudgets] = useState<Budget[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const [budgetOpen, setBudgetOpen] = useState(false);
  const [editingBudget, setEditingBudget] = useState<Budget | null>(null);
  const [expenseOpen, setExpenseOpen] = useState(false);
  const [confirm, setConfirm] = useState<{
    title: string;
    text?: string;
    danger?: boolean;
    okText?: string;
    run: () => Promise<void>;
  } | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const data = await projectsApi.list("?size=100");
        setProjects(data.items ?? []);
        if (!pid && data.items?.length) setPid(String(data.items[0].id));
      } catch (e) {
        setErr(errText(e));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const load = useCallback(async () => {
    if (!pid) return;
    setErr("");
    try {
      const [b, x] = await Promise.all([
        budgetsApi.list(Number(pid)),
        expensesApi.list(`?project_id=${pid}`),
      ]);
      setBudgets(b);
      setExpenses(unwrapList(x));
    } catch (e) {
      setErr(errText(e));
    }
  }, [pid]);

  useEffect(() => { load(); }, [load]);

  const totalBudget = budgets.reduce((s, b) => s + b.amount, 0);
  const totalSpent = budgets.reduce((s, b) => s + b.spent, 0);
  const totalRate = totalBudget ? totalSpent / totalBudget : 0;
  const pending = expenses.filter((x) => x.status === "pending");

  return (
    <div>
      <div className="page-head">
        <h1>成本支出<span className="sub">执行率 = 已支出 / 预算 · 80% 预警 · 超预算拦截</span></h1>
        <div className="actions no-print">
          <button className="btn-ghost" onClick={() => { setEditingBudget(null); setBudgetOpen(true); }}>+ 预算</button>
          <button className="btn-primary" style={{ width: "auto" }} onClick={() => setExpenseOpen(true)}>+ 支出</button>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 12, padding: "10px 16px", display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
        <label style={{ display: "flex", alignItems: "center", gap: 8, margin: 0 }}>
          <span className="muted" style={{ fontSize: 13 }}>项目</span>
          <select style={{ width: 260 }} value={pid} onChange={(e) => setPid(e.target.value)} aria-label="选择项目">
            <option value="">请选择项目</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.code} {p.name}</option>)}
          </select>
        </label>
      </div>

      <div className="kpi-row">
        <div className="kpi"><div className="k">预算合计</div><div className="v mono">{fmtMoney(totalBudget)}</div></div>
        <div className="kpi"><div className="k">已支出</div><div className="v mono">{fmtMoney(totalSpent)}</div></div>
        <div className="kpi"><div className="k">可用余额</div><div className="v mono">{fmtMoney(totalBudget - totalSpent)}</div></div>
        <div className="kpi"><div className="k">执行率</div><div className="v mono">{fmtPct(totalRate)}</div><ProgressBar value={totalRate * 100} /></div>
      </div>

      {err && <div className="err-banner">{err}</div>}

      <h2 className="section-title">预算执行</h2>
      {budgets.length === 0 ? (
        <div className="card"><Empty title="暂无预算" hint="先为项目按科目登记预算。" /></div>
      ) : (
        <table className="grid" style={{ marginBottom: 16 }}>
          <thead><tr><th>科目</th><th>预算期间</th><th className="num">预算</th><th className="num">已支出</th><th className="num">余额</th><th>执行率</th><th className="no-print" /></tr></thead>
          <tbody>
            {budgets.map((b) => (
              <tr key={b.id}>
                <td>{b.subject}</td>
                <td className="mono tiny">{fmtDate(b.period_start)} ~ {fmtDate(b.period_end)}</td>
                <td className="num">{fmtMoney(b.amount)}</td>
                <td className="num">{fmtMoney(b.spent)}</td>
                <td className="num" style={b.balance < 0 ? { color: "var(--danger)" } : undefined}>{fmtMoney(b.balance)}</td>
                <td>
                  <ProgressBar value={b.rate * 100} />{" "}
                  {b.rate > 1 ? <Badge status="超支" tone="danger" /> : b.warn ? <Badge status="≥80%预警" tone="warn" /> : null}
                </td>
                <td className="no-print">
                  <button
                    className="btn-ghost"
                    style={{ height: 26, lineHeight: "24px", padding: "0 8px", fontSize: 12 }}
                    onClick={() => { setEditingBudget(b); setBudgetOpen(true); }}
                  >
                    调整
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2 className="section-title">支出记录{pending.length > 0 && <span className="sub mono">{pending.length} 待审批</span>}</h2>
      {expenses.length === 0 ? (
        <div className="card"><Empty title="暂无支出" hint="登记支出后计入执行率（审批通过口径）。" /></div>
      ) : (
        <table className="grid">
          <thead><tr><th>日期</th><th>科目</th><th className="num">金额</th><th>说明</th><th>经办人</th><th>状态</th><th className="no-print" /></tr></thead>
          <tbody>
            {expenses.map((x) => (
              <tr key={x.id}>
                <td className="mono tiny">{fmtDate(x.exp_date)}</td>
                <td>{x.subject}</td>
                <td className="num">{fmtMoney(x.amount)}</td>
                <td><span className="ellipsis" title={x.note}>{x.note || "-"}</span></td>
                <td>{userName(x.by_id)}</td>
                <td><Badge status={expenseStatusLabel(x.status)} tone={expenseTone(x.status)} /></td>
                <td className="no-print">
                  {x.status === "pending" && (
                    <span style={{ display: "inline-flex", gap: 6 }}>
                      <button
                        className="btn-ghost"
                        style={{ height: 26, lineHeight: "24px", padding: "0 8px", fontSize: 12 }}
                        onClick={() =>
                          setConfirm({
                            title: `审批通过支出 ${fmtMoney(x.amount)} 元？`,
                            text: "通过后该金额计入预算执行。",
                            okText: "通过",
                            run: async () => {
                              await expensesApi.approve(x.id);
                              toast.ok("已审批通过");
                              await load();
                            },
                          })
                        }
                      >
                        通过
                      </button>
                      <button
                        className="btn-ghost"
                        style={{ height: 26, lineHeight: "24px", padding: "0 8px", fontSize: 12 }}
                        onClick={() =>
                          setConfirm({
                            title: `驳回支出 ${fmtMoney(x.amount)} 元？`,
                            danger: true,
                            text: "驳回后经办人可修改后重新提交。",
                            okText: "驳回",
                            run: async () => {
                              await expensesApi.reject(x.id, "页面驳回");
                              toast.ok("已驳回");
                              await load();
                            },
                          })
                        }
                      >
                        驳回
                      </button>
                      <button
                        className="btn-ghost"
                        style={{ height: 26, lineHeight: "24px", padding: "0 8px", fontSize: 12, color: "var(--danger)", borderColor: "var(--line-danger)" }}
                        onClick={() =>
                          setConfirm({
                            title: `特批放行 ${fmtMoney(x.amount)} 元？`,
                            danger: true,
                            text: "特批将绕过预算上限计入执行，操作会写入审计日志。",
                            okText: "确认特批",
                            run: async () => {
                              await expensesApi.exception(x.id, "超预算特批");
                              toast.ok("已特批放行");
                              await load();
                            },
                          })
                        }
                      >
                        特批放行
                      </button>
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <BudgetDialog
        open={budgetOpen}
        onClose={() => setBudgetOpen(false)}
        projectId={Number(pid)}
        budget={editingBudget}
        onSaved={(isAdjust) => {
          toast.ok(isAdjust ? "预算调整申请已提交" : "预算已登记");
          load();
        }}
      />

      <ExpenseDialog
        open={expenseOpen}
        onClose={() => setExpenseOpen(false)}
        projectId={Number(pid)}
        onSaved={(msg, warn) => {
          if (warn) toast.info(msg + "（已达 80% 预警线）");
          else toast.ok(msg);
          load();
        }}
      />

      <Confirm
        open={!!confirm}
        danger={confirm?.danger}
        loading={busy}
        title={confirm?.title ?? ""}
        text={confirm?.text}
        okText={confirm?.okText ?? "确认"}
        onConfirm={async () => {
          if (!confirm) return;
          setBusy(true);
          try {
            await confirm.run();
          } catch (e) {
            toast.err(errText(e));
          } finally {
            setBusy(false);
            setConfirm(null);
          }
        }}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}
