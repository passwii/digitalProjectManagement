"use client";

import { Suspense, useCallback, useState } from "react";
import {
  DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, approvalsApi, buildQuery, errText, expensesApi,
  projectsApi, reportsApi, unwrapPaged, type Expense, type Project,
} from "@/lib/api";
import { useAsyncData } from "@/lib/useAsyncData";
import { urlInt, useUrlState } from "@/lib/useUrlState";
import { useProjectsProbe } from "@/lib/useProjects";
import { useMenus } from "@/lib/useMeta";
import { useApprovalNotes } from "@/lib/useApprovalNotes";
import { TARGET_KEY, isTargetRow, parseTarget, rowClass, useTargetScroll } from "@/lib/deepLink";
import { EXPENSE_STATUS, expenseStatusLabel, expenseTone, fmtDate, fmtMoney } from "@/lib/labels";
import Badge from "@/components/ui/Badge";
import Empty from "@/components/ui/Empty";
import Pagination from "@/components/ui/Pagination";
import ProjectPicker from "@/components/ui/ProjectPicker";
import { LoadingBlock, LoadFailed } from "@/components/ui/PageState";
import ProgressBar from "@/components/ui/ProgressBar";
import { Confirm, Dialog } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import PageHeading from "@/components/ui/PageHeading";
import ExpenseActions, { type ExpenseAct } from "./ExpenseActions";
import ExpenseDialog from "./ExpenseDialog";

const URL_DEFAULTS = {
  project_id: "",
  status: "",
  page: "1",
  size: String(DEFAULT_PAGE_SIZE),
  [TARGET_KEY.expense]: "",
};

export default function CostsPage() {
  return (
    <Suspense fallback={<LoadingBlock kpis={0} label="加载支出…" />}>
      <CostsInner />
    </Suspense>
  );
}

function CostsInner() {
  const [url, setUrl] = useUrlState(URL_DEFAULTS, { pageKey: "page" });
  const pid = Number(url.project_id || 0);
  const page = urlInt(url.page, 1);
  const size = urlInt(url.size, DEFAULT_PAGE_SIZE, { max: MAX_PAGE_SIZE });
  const target = parseTarget(url[TARGET_KEY.expense]);
  const { canApprove } = useMenus();
  const { noteFor } = useApprovalNotes();
  const toast = useToast();
  const { hasProjects, probing, probeError, reloadProbe } = useProjectsProbe();
  const [expenseOpen, setExpenseOpen] = useState(false);
  const [resubmitOf, setResubmitOf] = useState<Expense | null>(null);
  const [reasonOf, setReasonOf] = useState<Expense | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<{
    title: string;
    text?: string;
    danger?: boolean;
    okText?: string;
    withReason?: { label: string; placeholder: string; required: string };
    run: (reason: string) => Promise<void>;
  } | null>(null);
  const [confirmReason, setConfirmReason] = useState("");
  const [confirmReasonErr, setConfirmReasonErr] = useState("");

  const { data, loading, firstLoad, error, reload } = useAsyncData(
    async (signal) => {
      const [p, rows, pending, report] = await Promise.all([
        projectsApi.get(pid),
        expensesApi.list(buildQuery({ project_id: pid, status: url.status, page, size, sort: "-exp_date" }), signal),
        expensesApi.list(buildQuery({ project_id: pid, status: "pending", page: 1, size: 1 }), signal),
        reportsApi.cost(buildQuery({ project_id: pid }), signal),
      ]);
      const paged = unwrapPaged<Expense>(rows);
      const pendingPage = unwrapPaged<Expense>(pending);
      return {
        project: p as Project,
        expenses: paged.items,
        total: paged.total,
        pendingTotal: pendingPage.total,
        spent: (report.items ?? []).reduce((sum, row) => sum + (row.spent || 0), 0),
      };
    },
    [pid, page, size, url.status],
    { enabled: !!pid, resetOnDepChange: true },
  );

  const expenses = data?.expenses ?? [];
  const total = data?.total ?? 0;
  const pendingTotal = data?.pendingTotal ?? 0;
  const project = data?.project ?? null;
  const spent = data?.spent ?? 0;
  const budget = project?.budget_total ?? 0;
  const rate = budget > 0 ? spent / budget : 0;
  useTargetScroll(target, !firstLoad && expenses.some((x) => isTargetRow(x.id, target)));

  const onExpenseAct = useCallback(({ kind, expense }: ExpenseAct) => {
    const run = async (reason: string) => {
      if (kind === "approve") {
        await expensesApi.approve(expense.id);
        toast.ok("已审批通过");
      } else if (kind === "reject") {
        await approvalsApi.decide("expense", expense.id, false, reason || "不符合报销要求");
        toast.ok("已驳回，经办人可在支出列表查看意见");
      } else {
        await approvalsApi.exception(expense.id, reason || "超预算特批");
        toast.ok("已特批放行");
      }
      reload();
    };
    setConfirmReason("");
    setConfirmReasonErr("");
    setConfirm(
      kind === "approve"
        ? { title: `审批通过支出 ${fmtMoney(expense.amount)} 元？`, okText: "通过", run: () => run("") }
        : kind === "reject"
        ? {
            title: `驳回支出 ${fmtMoney(expense.amount)} 元？`,
            danger: true,
            okText: "确认驳回",
            withReason: { label: "审批意见", placeholder: "说明驳回原因", required: "请填写驳回原因" },
            run: (reason) => run(reason),
          }
        : {
            title: `特批放行 ${fmtMoney(expense.amount)} 元？`,
            danger: true,
            okText: "确认特批",
            withReason: { label: "特批理由", placeholder: "说明特批原因", required: "请填写特批理由" },
            run: (reason) => run(reason),
          },
    );
  }, [reload, toast]);

  if (probing) return <LoadingBlock kpis={0} label="加载项目范围…" />;
  if (probeError) return <LoadFailed message={probeError} onRetry={reloadProbe} />;

  return (
    <div>
      <PageHeading
        title="支出记录"
        description="按项目登记支出，查看预算执行情况和审批状态。"
        actions={
          <button
            className="btn-primary"
            disabled={!pid}
            title={pid ? "登记一笔项目支出" : "请先选择项目"}
            onClick={() => { setResubmitOf(null); setExpenseOpen(true); }}
          >
            + 支出
          </button>
        }
      />

      <div className="toolbar-card">
        <label className="toolbar-field">
          <span>项目</span>
          <ProjectPicker
            value={url.project_id}
            onChange={(id) => setUrl({ project_id: id, status: "", page: "1", [TARGET_KEY.expense]: "" }, { history: "push" })}
            ariaLabel="选择项目"
            placeholder="搜索项目名称或编号"
            className="picker-grow"
          />
        </label>
      </div>

      {error && <LoadFailed message={error} onRetry={reload} />}

      {!hasProjects ? (
        <div className="card"><Empty title="暂无可参与的项目" hint="项目创建或加入后，可登记关联支出。" /></div>
      ) : !pid ? (
        <div className="card"><Empty title="请先选择项目" hint="选择项目后查看并登记支出。" /></div>
      ) : firstLoad ? (
        <LoadingBlock kpis={3} label="加载支出数据…" />
      ) : (
        <>
          <div className="kpi-row">
            <div className="kpi">
              <div className="k">项目预算</div>
              <div className="v mono">{fmtMoney(budget)}</div>
              <div className="kpi-foot">来自项目档案</div>
            </div>
            <div className="kpi">
              <div className="k">累计支出</div>
              <div className="v mono">{fmtMoney(spent)}</div>
              <div className="kpi-foot">仅统计项目关联支出</div>
            </div>
            <div className="kpi">
              <div className="k">预算余额</div>
              <div className="v mono">{fmtMoney(budget - spent)}</div>
              <ProgressBar value={Math.min(rate * 100, 100)} tone={rate >= 0.8 ? "warn" : "brand"} />
            </div>
            <div className="kpi">
              <div className="k">待审批</div>
              <div className="v mono">{pendingTotal}</div>
              <div className="kpi-foot">管理员审批后计入正式支出</div>
            </div>
          </div>

          <div className="section-head">
            <div>
              <h2>支出明细</h2>
            </div>
            <select
              aria-label="按支出状态筛选"
              value={url.status}
              onChange={(e) => setUrl({ status: e.target.value }, { history: "push" })}
            >
              <option value="">全部状态</option>
              {Object.entries(EXPENSE_STATUS).map(([code, label]) => (
                <option key={code} value={code}>{label}</option>
              ))}
            </select>
          </div>

          {expenses.length === 0 ? (
            <div className="card">
              <Empty title={url.status ? "该状态下暂无支出" : "暂无支出"} hint="点击右上角「+ 支出」开始登记。" />
            </div>
          ) : (
            <>
              <div className="table-scroll">
                <table className="grid" aria-busy={loading}>
                  <thead>
                    <tr><th>支出日期</th><th>人员</th><th className="num">支出金额</th><th>费用说明</th><th>状态</th><th className="no-print" /></tr>
                  </thead>
                  <tbody>
                    {expenses.map((x) => {
                      return (
                        <tr key={x.id} data-target-id={x.id} className={rowClass(undefined, isTargetRow(x.id, target))}>
                          <td className="mono tiny">{fmtDate(x.exp_date)}</td>
                          <td>{x.subject}</td>
                          <td className="num">{fmtMoney(x.amount)}</td>
                          <td><span className="ellipsis" title={x.note}>{x.note || "-"}</span></td>
                          <td>
                            <Badge status={expenseStatusLabel(x.status)} tone={expenseTone(x.status)} />
                            {x.status === "rejected" && (
                              <button className="linklike note-link" onClick={() => setReasonOf(x)}>
                                查看审批意见
                              </button>
                            )}
                          </td>
                          <td className="no-print">
                            <span className="table-actions">
                              {x.status === "rejected" && (
                                <button className="btn-ghost btn-xs" onClick={() => { setResubmitOf(x); setExpenseOpen(true); }}>
                                  重新提交
                                </button>
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
                total={total}
                loading={loading}
                ariaLabel="支出记录分页"
                onChange={(next) => setUrl({ page: String(next.page), size: String(next.size) })}
              />
            </>
          )}
        </>
      )}

      <ExpenseDialog
        open={expenseOpen}
        onClose={() => setExpenseOpen(false)}
        projectId={pid}
        resubmitOf={resubmitOf}
        onSaved={(msg, warn) => {
          if (warn) toast.ok(`${msg}，已接近项目预算警戒线`);
          else toast.ok(msg);
          reload();
        }}
      />

      <Dialog
        open={!!reasonOf}
        onClose={() => setReasonOf(null)}
        size="sm"
        title="审批意见"
        footer={<button className="btn-primary" onClick={() => setReasonOf(null)}>知道了</button>}
      >
        <div className="notice-panel">
          <span className="notice-label">驳回原因</span>
          <p>{reasonOf?.decision_reason || noteFor("expense", reasonOf?.id ?? 0, reasonOf)?.text || "暂无审批意见"}</p>
        </div>
      </Dialog>

      <Confirm
        open={!!confirm}
        danger={confirm?.danger}
        loading={busy}
        title={confirm?.title ?? ""}
        text={confirm?.text}
        okText={confirm?.okText}
        onConfirm={async () => {
          if (!confirm) return;
          const value = confirmReason.trim();
          if (confirm.withReason && !value) {
            setConfirmReasonErr(confirm.withReason.required);
            return;
          }
          setBusy(true);
          try {
            await confirm.run(value);
            setConfirm(null);
            setConfirmReason("");
            setConfirmReasonErr("");
          } catch (e) {
            toast.err(errText(e));
          } finally {
            setBusy(false);
          }
        }}
        onCancel={() => { setConfirm(null); setConfirmReason(""); setConfirmReasonErr(""); }}
      >
        {confirm?.withReason && (
          <label className="field" style={{ marginTop: 12 }}>
            <span className="field-label">{confirm.withReason.label}<b className="field-req">*</b></span>
            <textarea
              rows={3}
              value={confirmReason}
              onChange={(e) => { setConfirmReason(e.target.value); setConfirmReasonErr(""); }}
              placeholder={confirm.withReason.placeholder}
            />
            {confirmReasonErr && <span className="field-err">{confirmReasonErr}</span>}
          </label>
        )}
      </Confirm>
    </div>
  );
}
