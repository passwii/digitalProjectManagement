"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, approvalsApi, budgetsApi, buildQuery, errText, expensesApi,
  reportsApi, unwrapPaged, type Budget, type Expense,
} from "@/lib/api";
import { useAsyncData } from "@/lib/useAsyncData";
import { urlInt, useUrlState } from "@/lib/useUrlState";
import { useProjectsProbe } from "@/lib/useProjects";
import { useMeta, useMenus } from "@/lib/useMeta";
import { useApprovalNotes } from "@/lib/useApprovalNotes";
import { TARGET_KEY, isTargetRow, parseTarget, rowClass, useTargetScroll } from "@/lib/deepLink";
import {
  COST_SCOPE_NOTE, MONEY_LABEL, RATE_WARN, rateBadge,
} from "@/lib/kpi";
import { EXPENSE_STATUS, expenseStatusLabel, expenseTone, fmtDate, fmtDateTime, fmtMoney, fmtPct } from "@/lib/labels";
import Badge from "@/components/ui/Badge";
import Empty from "@/components/ui/Empty";
import Pagination from "@/components/ui/Pagination";
import ProjectPicker from "@/components/ui/ProjectPicker";
import { LoadingBlock, LoadFailed } from "@/components/ui/PageState";
import ProgressBar from "@/components/ui/ProgressBar";
import { Confirm, Dialog } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import BudgetDialog from "./BudgetDialog";
import ExpenseActions, { type ExpenseAct } from "./ExpenseActions";
import ExpenseDialog from "./ExpenseDialog";

// 当前项目 / 支出筛选与分页 / 预算分页 / 通知定位目标写入 URL（BLF-1095 / BLF-1093）
const URL_DEFAULTS = {
  project_id: "",
  status: "",
  page: "1",
  size: "20",
  bpage: "1",
  bsize: "20",
  [TARGET_KEY.expense]: "",
};

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
  const expenseTarget = parseTarget(url[TARGET_KEY.expense]);
  const page = urlInt(url.page, 1);
  const size = urlInt(url.size, DEFAULT_PAGE_SIZE, { max: MAX_PAGE_SIZE });
  const bpage = urlInt(url.bpage, 1);
  const bsize = urlInt(url.bsize, DEFAULT_PAGE_SIZE, { max: MAX_PAGE_SIZE });

  const { userName } = useMeta();
  const { canApprove } = useMenus();
  const { noteFor, hasUnread } = useApprovalNotes();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  // 驳回原因查看弹层
  const [reasonOf, setReasonOf] = useState<Expense | null>(null);
  // 重新提交：以被驳回的单据为模板预填（后端不新增状态表，重提即新建一条待审批单）
  const [resubmitOf, setResubmitOf] = useState<Expense | null>(null);
  // 是否有可参与项目：只探测 1 条，不再拉取 100 条项目判断存在性
  const { hasProjects, probing, probeError, reloadProbe } = useProjectsProbe();

  const { data, loading, firstLoad, error, reload } = useAsyncData(
    async (signal) => {
      const [b, x, p, r] = await Promise.all([
        // Stage 3A：一律回分页信封（用 unwrapPaged 兼容旧裸数组）
        budgetsApi.list(Number(pid), { page: bpage, size: bsize }, signal),
        // 状态筛选**必须进请求参数**：只有服务端过滤才能给出正确的 total 与页码
        expensesApi.list(buildQuery({ project_id: pid, status: url.status, page, size }), signal),
        // 待审批数：单独取服务端总数，避免只统计当前页 / 当前筛选
        expensesApi.list(buildQuery({ project_id: pid, status: "pending", page: 1, size: 1 }), signal),
        // KPI 口径：服务端按项目×科目聚合，不受预算分页截断影响
        reportsApi.cost(buildQuery({ project_id: pid }), signal),
      ]);
      const paged = unwrapPaged<Expense>(x);
      const budgetPage = unwrapPaged<Budget>(b);
      const pendingPage = unwrapPaged<Expense>(p);
      const rows = r.items ?? [];
      return {
        budgets: budgetPage.items,
        budgetsTotal: budgetPage.total,
        expenses: paged.items,
        serverTotal: paged.total,
        // 待审批总数：优先服务端 total；旧后端回裸数组时退回当页条数
        pendingTotal: pendingPage.paged ? pendingPage.total : pendingPage.items.length,
        kpiBudget: rows.reduce((s, row) => s + row.budget, 0),
        kpiSpent: rows.reduce((s, row) => s + row.spent, 0),
      };
    },
    [pid, page, size, bpage, bsize, url.status],
    { enabled: !!pid, resetOnDepChange: true },
  );

  const budgets: Budget[] = data?.budgets ?? [];
  const budgetsTotal = data?.budgetsTotal ?? budgets.length;
  // 支出列表即服务端结果，不再在当页本地过滤
  const expenses: Expense[] = data?.expenses ?? [];
  const expTotal = data?.serverTotal ?? 0;

  // KPI 与报表同口径（服务端项目×科目聚合，不受预算分页截断影响）
  const totalBudget = data?.kpiBudget ?? 0;
  const totalSpent = data?.kpiSpent ?? 0;
  const totalRate = totalBudget ? totalSpent / totalBudget : 0;
  // 待审批总数：服务端 status=pending 的 total（旧后端回裸数组时退回当页计数）
  const pendingTotal = data?.pendingTotal ?? 0;

  // 定位命中行滚动入视口
  const hitAny = expenses.some((x) => isTargetRow(x.id, expenseTarget));
  useTargetScroll(expenseTarget, !firstLoad && hitAny);

  // 切换项目后丢弃上一个项目的定位参数（首次进入时不清，否则深链会被自己抹掉）
  const prevPidRef = useRef(pid);
  useEffect(() => {
    if (prevPidRef.current === pid) return;
    prevPidRef.current = pid;
    if (expenseTarget) setUrl({ [TARGET_KEY.expense]: "" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pid]);

  const [budgetOpen, setBudgetOpen] = useState(false);
  const [editingBudget, setEditingBudget] = useState<Budget | null>(null);
  const [expenseOpen, setExpenseOpen] = useState(false);
  const [confirm, setConfirm] = useState<{
    title: string;
    text?: string;
    danger?: boolean;
    okText?: string;
    /** 需要管理员填写理由的危险操作（驳回 / 特批）：意见会展示给申请人或写入审计 */
    withReason?: { label: string; placeholder: string; required: string };
    run: (reason: string) => Promise<void>;
  } | null>(null);
  const [confirmReason, setConfirmReason] = useState("");
  const [confirmReasonErr, setConfirmReasonErr] = useState("");

  /**
   * 支出审批：确认弹层 + 调用管理员接口（按钮仅在 canApprove 时渲染）。
   *
   * 端点选择（都是既有后端能力，不动业务规则）：
   * · 驳回 / 特批 → 走审批中心的决策端点。它与 `/expenses/{id}/reject` 的状态迁移完全一致，
   *   但**会把审批意见写成申请人可见的通知**（`ref_type=expense`，body=意见）；
   *   `/expenses/{id}/reject` 只把理由写进审计日志，申请人在自己的页面上看不到原因。
   * · 通过 → 仍走 `/expenses/{id}/approve`，因为它带「超预算需先调预算或特批」的前置拦截，
   *   审批中心端点没有这一层，换过去会放宽业务规则。
   */
  const onExpenseAct = useCallback(({ kind, expense }: ExpenseAct) => {
    const amount = fmtMoney(expense.amount);
    const run = async (reason: string) => {
      if (kind === "approve") {
        await expensesApi.approve(expense.id);
        toast.ok("已审批通过");
      } else if (kind === "reject") {
        await approvalsApi.decide("expense", expense.id, false, reason || "不符合报销要求");
        toast.ok("已驳回，经办人在成本页可看到该意见");
      } else {
        await approvalsApi.exception(expense.id, reason || "超预算特批");
        toast.ok("已特批放行");
      }
      reload();
    };
    setConfirm(
      kind === "approve"
        ? { title: `审批通过支出 ${amount} 元？`, text: "通过后该金额计入预算执行。", okText: "通过", run: () => run("") }
        : kind === "reject"
        ? {
            title: `驳回支出 ${amount} 元？`,
            text: "驳回后经办人可在成本页看到您的审批意见，并修改后重新提交。",
            danger: true,
            okText: "确认驳回",
            withReason: { label: "审批意见", placeholder: "说明驳回原因，申请人可据此修改", required: "请填写驳回原因，申请人需要知道如何修改" },
            run: (reason: string) => run(reason),
          }
        : {
            title: `特批放行 ${amount} 元？`,
            text: "特批将绕过预算上限计入执行，操作会写入审计日志。",
            danger: true,
            okText: "确认特批",
            withReason: { label: "特批理由", placeholder: "如：客户紧急追加，已口头报备", required: "请填写特批理由，该理由会写入审计日志" },
            run: (reason: string) => run(reason),
          }
    );
  }, [reload, toast]);

  const scopeText = [url.status ? `状态=${EXPENSE_STATUS[url.status] ?? url.status}` : ""]
    .filter(Boolean)
    .join(" · ");

  // 预算表分页说明（KPI 为服务端聚合口径，与本页行数无关）
  const budgetScopeText = budgetsTotal > budgets.length ? "KPI 为服务端全量口径" : undefined;

  // 项目范围探测中：先出骨架，避免“暂无可参与项目”误闪
  if (probing) return <LoadingBlock kpis={0} label="加载项目范围…" />;

  // 探测失败：给出可重试的失败态
  if (probeError) return <LoadFailed message={probeError} onRetry={reloadProbe} />;

  // 无任何可参与项目：给出可理解的空状态，而不是空表格与无效按钮
  if (!hasProjects) {
    return (
      <div>
        <div className="page-head">
          <h1>成本支出<span className="sub">执行率 = 已支出 / 预算 · {RATE_WARN * 100}% 预警 · 超预算拦截</span></h1>
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
        <h1>成本支出<span className="sub">执行率 = 已支出 / 预算 · {RATE_WARN * 100}% 预警 · 超预算拦截</span></h1>
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
            onClick={() => { setResubmitOf(null); setExpenseOpen(true); }}
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
            onChange={(id) => setUrl({ project_id: id, status: "", page: 1, bpage: 1 }, { history: "push" })}
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
            <div className="kpi"><div className="k">{MONEY_LABEL.budget}</div><div className="v mono">{fmtMoney(totalBudget)}</div></div>
            <div className="kpi"><div className="k">{MONEY_LABEL.spent}</div><div className="v mono">{fmtMoney(totalSpent)}</div></div>
            <div className="kpi"><div className="k">{MONEY_LABEL.balance}</div><div className="v mono">{fmtMoney(totalBudget - totalSpent)}</div></div>
            <div className="kpi">
              <div className="k">{MONEY_LABEL.rate}</div>
              <div className="v mono">{fmtPct(totalRate)}</div>
              <ProgressBar value={totalRate * 100} />
            </div>
          </div>
          <p className="muted tiny" style={{ marginTop: -4, marginBottom: 12 }}>
            {COST_SCOPE_NOTE}；本页四个数字由服务端按项目×科目聚合（全量口径，与下方列表分页无关）。
          </p>

          <h2 className="section-title">预算执行</h2>
          {budgets.length === 0 ? (
            <div className="card"><Empty title="暂无预算" hint="先为项目按科目登记预算。" /></div>
          ) : (
            <div className="table-scroll">
              <table className="grid" style={{ marginBottom: 16 }}>
                <thead><tr><th>科目</th><th>预算期间</th><th className="num">预算</th><th className="num">已支出</th><th className="num">余额</th><th>执行率</th><th className="no-print" /></tr></thead>
                <tbody>
                  {budgets.map((b) => {
                    const rb = rateBadge(b.rate);
                    return (
                      <tr key={b.id}>
                        <td>{b.subject}</td>
                        <td className="mono tiny">{fmtDate(b.period_start)} ~ {fmtDate(b.period_end)}</td>
                        <td className="num">{fmtMoney(b.amount)}</td>
                        <td className="num">{fmtMoney(b.spent)}</td>
                        <td className="num" style={b.balance < 0 ? { color: "var(--danger)" } : undefined}>{fmtMoney(b.balance)}</td>
                        <td>
                          <ProgressBar value={b.rate * 100} />{" "}
                          {rb ? <Badge status={rb.status} tone={rb.tone} /> : null}
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
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {budgetsTotal > 0 && (
            <Pagination
              page={bpage}
              size={bsize}
              total={budgetsTotal}
              loading={loading}
              scopeText={budgetScopeText}
              ariaLabel="预算执行分页"
              onChange={(next) =>
                setUrl(
                  { bpage: String(next.page), bsize: String(next.size) },
                  { history: next.page === bpage ? "replace" : "push" },
                )
              }
            />
          )}

          <h2 className="section-title">支出记录{pendingTotal > 0 && <span className="sub mono">{pendingTotal} 待审批</span>}</h2>

          <div className="card no-print" style={{ marginBottom: 12, padding: "8px 12px", display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8, margin: 0 }}>
              <span className="muted" style={{ fontSize: 13 }}>状态筛选</span>
              <select
                style={{ width: 160 }}
                value={url.status}
                // 离散筛选：push 进历史（后退可回到上一个筛选）；pageKey 自动把 page 归 1
                onChange={(e) => setUrl({ status: e.target.value }, { history: "push" })}
                aria-label="按支出状态筛选"
              >
                <option value="">全部状态</option>
                {Object.entries(EXPENSE_STATUS).map(([code, label]) => (
                  <option key={code} value={code}>{label}</option>
                ))}
              </select>
            </label>
            {url.status && (
              <button type="button" className="btn-ghost" style={{ height: 32, width: "auto" }} onClick={() => setUrl({ status: "" }, { history: "push" })}>
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
                    {expenses.map((x) => {
                      const hit = isTargetRow(x.id, expenseTarget);
                      const note = x.status === "rejected" ? noteFor("expense", x.id, x) : null;
                      const unreadNote = hasUnread("expense", x.id);
                      return (
                        <tr key={x.id} data-target-id={x.id} className={rowClass(undefined, hit)}>
                          <td className="mono tiny">{fmtDate(x.exp_date)}</td>
                          <td>{x.subject}</td>
                          <td className="num">{fmtMoney(x.amount)}</td>
                          <td>
                            <span className="ellipsis" title={x.note}>{x.note || "-"}</span>
                            {/* 驳回原因直接挂在行上：申请人不必再找管理员问为什么 */}
                            {note && (
                              <div className="tiny" style={{ color: "var(--danger)" }}>
                                驳回原因：{note.text}
                                {note.at && <span className="muted"> · {fmtDateTime(note.at)}</span>}
                              </div>
                            )}
                            {hit && <div className="tiny">· 来自通知</div>}
                          </td>
                          <td>{userName(x.by_id)}</td>
                          <td>
                            <Badge status={expenseStatusLabel(x.status)} tone={expenseTone(x.status)} />
                            {unreadNote && <span className="chip danger" style={{ marginLeft: 6 }}>新意见</span>}
                          </td>
                          <td className="no-print">
                            <span style={{ display: "inline-flex", gap: 6, flexWrap: "wrap" }}>
                              {x.status === "rejected" && (
                                <>
                                  <button
                                    className="btn-ghost"
                                    style={{ height: 26, lineHeight: "24px", padding: "0 8px", fontSize: 12 }}
                                    onClick={() => setReasonOf(x)}
                                  >
                                    查看原因
                                  </button>
                                  <button
                                    className="btn-ghost"
                                    style={{ height: 26, lineHeight: "24px", padding: "0 8px", fontSize: 12, color: "var(--brand)", borderColor: "var(--line-blue)" }}
                                    onClick={() => { setResubmitOf(x); setExpenseOpen(true); }}
                                  >
                                    修改后重新提交
                                  </button>
                                </>
                              )}
                              <ExpenseActions expense={x} canApprove={canApprove} onAct={onExpenseAct} />
                            </span>
                          </td>
                        </tr>
                      );
                    })}
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
                onChange={(next) =>
                  setUrl(
                    { page: String(next.page), size: String(next.size) },
                    { history: next.page === page ? "replace" : "push" },
                  )
                }
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
        onClose={() => { setExpenseOpen(false); setResubmitOf(null); }}
        projectId={Number(pid)}
        resubmitOf={resubmitOf}
        onSaved={(msg, warn) => {
          if (warn) toast.info(msg + `（已达 ${RATE_WARN * 100}% 预警线）`);
          else toast.ok(msg);
          setResubmitOf(null);
          reload();
        }}
      />

      {/* 驳回原因：集中展示申请人需要的全部上下文（意见、决策时间、原单信息） */}
      <Dialog
        open={!!reasonOf}
        onClose={() => setReasonOf(null)}
        title={`驳回原因 · ${reasonOf?.subject ?? ""}`}
        footer={
          <>
            <button className="btn-ghost" onClick={() => setReasonOf(null)}>关闭</button>
            <button
              className="btn-primary"
              onClick={() => { const x = reasonOf; setReasonOf(null); if (x) { setResubmitOf(x); setExpenseOpen(true); } }}
            >
              修改后重新提交
            </button>
          </>
        }
      >
        {reasonOf && (
          <div className="form-grid one">
            <div className="kv one">
              <div><dt>金额</dt><dd className="mono">{fmtMoney(reasonOf.amount)} 元</dd></div>
              <div><dt>支出日期</dt><dd className="mono">{fmtDate(reasonOf.exp_date)}</dd></div>
              <div><dt>费用说明</dt><dd>{reasonOf.note || "-"}</dd></div>
            </div>
            {(() => {
              const n = noteFor("expense", reasonOf.id, reasonOf);
              return n ? (
                <div>
                  <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>审批意见</div>
                  <div className="err-banner" style={{ marginBottom: 0 }}>{n.text}</div>
                  {n.at && <p className="tiny">决策时间：{fmtDateTime(n.at)}</p>}
                </div>
              ) : (
                <p className="muted tiny" style={{ marginBottom: 0 }}>
                  未找到审批意见。可修改单据内容后重新提交，新的审批结果会通过通知告知您。
                </p>
              );
            })()}
            <p className="tiny" style={{ marginBottom: 0 }}>
              重新提交会新建一条「待审批」支出，原驳回记录保留以便追溯。
            </p>
          </div>
        )}
      </Dialog>

      <Confirm
        open={!!confirm}
        danger={confirm?.danger}
        loading={busy}
        title={confirm?.title ?? ""}
        text={
          <>
            {confirm?.text}
            {confirm?.withReason && (
              <div style={{ marginTop: 10 }}>
                <label className="field" style={{ fontSize: 13, color: "var(--ink-2)" }}>
                  <span className="field-label">
                    {confirm.withReason.label}
                    <b className="field-req" aria-hidden>*</b>
                  </span>
                  <input
                    value={confirmReason}
                    aria-invalid={!!confirmReasonErr}
                    onChange={(e) => { setConfirmReason(e.target.value); setConfirmReasonErr(""); }}
                    placeholder={confirm.withReason.placeholder}
                  />
                  {confirmReasonErr && <span className="field-err" role="alert">{confirmReasonErr}</span>}
                </label>
              </div>
            )}
          </>
        }
        okText={confirm?.okText ?? "确认"}
        onConfirm={async () => {
          if (!confirm) return;
          // 必填理由未填：就地报错，不把用户丢回列表重来
          if (confirm.withReason && !confirmReason.trim()) {
            setConfirmReasonErr(confirm.withReason.required);
            return;
          }
          setBusy(true);
          try {
            await confirm.run(confirmReason.trim());
          } catch (e) {
            // 失败时保留理由输入，用户可以直接重试
            toast.err(errText(e));
            return;
          } finally {
            setBusy(false);
          }
          setConfirm(null);
          setConfirmReason("");
          setConfirmReasonErr("");
        }}
        onCancel={() => { setConfirm(null); setConfirmReason(""); setConfirmReasonErr(""); }}
      />
    </div>
  );
}
