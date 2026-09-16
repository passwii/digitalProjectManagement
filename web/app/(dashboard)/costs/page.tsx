"use client";

import { Suspense, useCallback, useMemo, useState } from "react";
import {
  budgetsApi, buildQuery, errText, expensesApi, unwrapPaged,
  type Budget, type Expense,
} from "@/lib/api";
import { useAsyncData } from "@/lib/useAsyncData";
import { urlInt, useUrlState } from "@/lib/useUrlState";
import { useProjectsProbe } from "@/lib/useProjects";
import { useMeta, useMenus } from "@/lib/useMeta";
import { EXPENSE_STATUS, expenseStatusLabel, expenseTone, fmtDate, fmtMoney, fmtPct } from "@/lib/labels";
import Badge from "@/components/ui/Badge";
import Empty from "@/components/ui/Empty";
import Pagination from "@/components/ui/Pagination";
import ProjectPicker from "@/components/ui/ProjectPicker";
import { LoadingBlock, LoadFailed } from "@/components/ui/PageState";
import ProgressBar from "@/components/ui/ProgressBar";
import { Confirm } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import BudgetDialog from "./BudgetDialog";
import ExpenseActions, { type ExpenseAct } from "./ExpenseActions";
import ExpenseDialog from "./ExpenseDialog";

// 当前项目 / 支出筛选 / 分页写入 URL（BLF-1095）
const URL_DEFAULTS = { project_id: "", status: "", page: "1", size: "20" };

export default function CostsPage() {
  return (
    <Suspense
      fallback={
        <div>
          <div className="skel skel-title" />
          <LoadingBlock kpis={0} label="加载成本页…" />
        </div>
      }
    >
      <CostsInner />
    </Suspense>
  );
}

function CostsInner() {
  const [url, setUrl] = useUrlState(URL_DEFAULTS, { pageKey: "page" });
  const pid = url.project_id;
  const page = urlInt(url.page, 1);
  const size = urlInt(url.size, 20, { max: 100 });

  const { userName } = useMeta();
  const { canApprove } = useMenus();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  // 是否有可参与项目：只探测 1 条，不再拉取 100 条项目判断存在性
  const { hasProjects, probing, probeError, reloadProbe } = useProjectsProbe();

  const { data, loading, firstLoad, error, reload } = useAsyncData(
    async (signal) => {
      const [b, x] = await Promise.all([
        budgetsApi.list(Number(pid), signal),
        // page/size 先按 Stage 3 契约下发；后端仍返回裸数组时前端本地切片，双向兼容
        expensesApi.list(buildQuery({ project_id: pid, page, size }), signal),
      ]);
      const paged = unwrapPaged<Expense>(x);
      return { budgets: b, expenses: paged.items, serverPaged: paged.paged, serverTotal: paged.total };
    },
    [pid, page, size],
    { enabled: !!pid, resetOnDepChange: true },
  );

  const budgets: Budget[] = data?.budgets ?? [];
  const allExpenses: Expense[] = data?.expenses ?? [];

  // 支出筛选：后端支持则服务端过滤，否则前端过滤后再分页
  const filtered = useMemo(
    () => (url.status ? allExpenses.filter((x) => x.status === url.status) : allExpenses),
    [allExpenses, url.status],
  );
  const serverPaged = !!data?.serverPaged;
  const expenses = serverPaged ? filtered : filtered.slice((page - 1) * size, page * size);
  const expTotal = serverPaged
    ? url.status
      ? filtered.length
      : data?.serverTotal ?? filtered.length
    : filtered.length;

  const totalBudget = budgets.reduce((s, b) => s + b.amount, 0);
  const totalSpent = budgets.reduce((s, b) => s + b.spent, 0);
  const totalRate = totalBudget ? totalSpent / totalBudget : 0;
  const pending = allExpenses.filter((x) => x.status === "pending");

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

  /** 支出审批：确认弹层 + 调用管理员接口（按钮仅在 canApprove 时渲染） */
  const onExpenseAct = useCallback(({ kind, expense }: ExpenseAct) => {
    const amount = fmtMoney(expense.amount);
    const run = async () => {
      if (kind === "approve") {
        await expensesApi.approve(expense.id);
        toast.ok("已审批通过");
      } else if (kind === "reject") {
        await expensesApi.reject(expense.id, "页面驳回");
        toast.ok("已驳回");
      } else {
        await expensesApi.exception(expense.id, "超预算特批");
        toast.ok("已特批放行");
      }
      reload();
    };
    setConfirm(
      kind === "approve"
        ? { title: `审批通过支出 ${amount} 元？`, text: "通过后该金额计入预算执行。", okText: "通过", run }
        : kind === "reject"
        ? { title: `驳回支出 ${amount} 元？`, text: "驳回后经办人可修改后重新提交。", danger: true, okText: "驳回", run }
        : { title: `特批放行 ${amount} 元？`, text: "特批将绕过预算上限计入执行，操作会写入审计日志。", danger: true, okText: "确认特批", run }
    );
  }, [reload, toast]);

  const scopeText = [url.status ? `状态=${EXPENSE_STATUS[url.status] ?? url.status}` : ""]
    .filter(Boolean)
    .join(" · ");

  // 项目范围探测中：先出骨架，避免“暂无可参与项目”误闪
  if (probing) return <LoadingBlock kpis={0} label="加载项目范围…" />;

  // 探测失败：给出可重试的失败态
  if (probeError) return <LoadFailed message={probeError} onRetry={reloadProbe} />;

  // 无任何可参与项目：给出可理解的空状态，而不是空表格与无效按钮
  if (!hasProjects) {
    return (
      <div>
        <div className="page-head">
          <h1>成本支出<span className="sub">执行率 = 已支出 / 预算 · 80% 预警 · 超预算拦截</span></h1>
        </div>
        <div className="card">
          <Empty title="暂无可参与的项目" hint="您还没有负责或参与的项目，暂时无法登记预算与支出。" />
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="page-head">
        <h1>成本支出<span className="sub">执行率 = 已支出 / 预算 · 80% 预警 · 超预算拦截</span></h1>
        <div className="actions no-print">
          <button
            className="btn-ghost"
            disabled={!pid}
            title={pid ? "登记预算" : "请先选择项目"}
            onClick={() => { setEditingBudget(null); setBudgetOpen(true); }}
          >
            + 预算
          </button>
          <button
            className="btn-primary"
            style={{ width: "auto" }}
            disabled={!pid}
            title={pid ? "登记支出" : "请先选择项目"}
            onClick={() => setExpenseOpen(true)}
          >
            + 支出
          </button>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 12, padding: "10px 16px", display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
        <label style={{ display: "flex", alignItems: "center", gap: 8, margin: 0, flex: "0 1 340px", minWidth: 0 }}>
          <span className="muted" style={{ fontSize: 13, flex: "none" }}>项目</span>
          <ProjectPicker
            value={pid}
            onChange={(id) => setUrl({ project_id: id, status: "" }, { history: "push" })}
            ariaLabel="选择项目"
            placeholder="搜索名称 / 编号 / 客户…"
            className="picker-grow"
          />
        </label>
      </div>

      {error && <LoadFailed message={error} onRetry={reload} />}

      {!pid ? (
        <div className="card">
          <Empty
            title="请先选择项目"
            hint="用上方项目选择器按关键词检索项目（项目数超过一页也可选），链接会带上 project_id。"
          />
        </div>
      ) : firstLoad ? (
        <LoadingBlock kpis={0} label="加载成本数据…" />
      ) : (
        <>
          <div className="kpi-row">
            <div className="kpi"><div className="k">预算合计</div><div className="v mono">{fmtMoney(totalBudget)}</div></div>
            <div className="kpi"><div className="k">已支出</div><div className="v mono">{fmtMoney(totalSpent)}</div></div>
            <div className="kpi"><div className="k">可用余额</div><div className="v mono">{fmtMoney(totalBudget - totalSpent)}</div></div>
            <div className="kpi"><div className="k">执行率</div><div className="v mono">{fmtPct(totalRate)}</div><ProgressBar value={totalRate * 100} /></div>
          </div>

          <h2 className="section-title">预算执行</h2>
          {budgets.length === 0 ? (
            <div className="card"><Empty title="暂无预算" hint="先为项目按科目登记预算。" /></div>
          ) : (
            <div className="table-scroll">
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
            </div>
          )}

          <h2 className="section-title">支出记录{pending.length > 0 && <span className="sub mono">{pending.length} 待审批</span>}</h2>

          <div className="card no-print" style={{ marginBottom: 12, padding: "8px 12px", display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8, margin: 0 }}>
              <span className="muted" style={{ fontSize: 13 }}>状态筛选</span>
              <select
                style={{ width: 160 }}
                value={url.status}
                onChange={(e) => setUrl({ status: e.target.value })}
                aria-label="按支出状态筛选"
              >
                <option value="">全部状态</option>
                {Object.entries(EXPENSE_STATUS).map(([code, label]) => (
                  <option key={code} value={code}>{label}</option>
                ))}
              </select>
            </label>
            {url.status && (
              <button type="button" className="btn-ghost" style={{ height: 32, width: "auto" }} onClick={() => setUrl({ status: "" })}>
                清除筛选
              </button>
            )}
          </div>

          {expenses.length === 0 ? (
            <div className="card">
              <Empty
                title={url.status ? "该状态下暂无支出" : "暂无支出"}
                hint={url.status ? "换个状态筛选试试。" : "登记支出后计入执行率（审批通过口径）。"}
              />
            </div>
          ) : (
            <>
              <div className="table-scroll">
                <table className="grid" aria-busy={loading}>
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
                          <ExpenseActions expense={x} canApprove={canApprove} onAct={onExpenseAct} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pagination
                page={page}
                size={size}
                total={expTotal}
                loading={loading}
                scopeText={scopeText}
                ariaLabel="支出记录分页"
                onChange={(next) => setUrl({ page: String(next.page), size: String(next.size) })}
              />
            </>
          )}
        </>
      )}

      <BudgetDialog
        open={budgetOpen}
        onClose={() => setBudgetOpen(false)}
        projectId={Number(pid)}
        budget={editingBudget}
        onSaved={(isAdjust) => {
          toast.ok(isAdjust ? "预算调整申请已提交" : "预算已登记");
          reload();
        }}
      />

      <ExpenseDialog
        open={expenseOpen}
        onClose={() => setExpenseOpen(false)}
        projectId={Number(pid)}
        onSaved={(msg, warn) => {
          if (warn) toast.info(msg + "（已达 80% 预警线）");
          else toast.ok(msg);
          reload();
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
