"use client";

import { Suspense, useMemo, useState } from "react";
import {
  buildQuery, errText, reportsApi,
  type CostRow, type Warnings,
} from "@/lib/api";
import { useAsyncData } from "@/lib/useAsyncData";
import { urlInt, useUrlState } from "@/lib/useUrlState";
import { useMeta } from "@/lib/useMeta";
import { SUBJECTS, fmtMoney, fmtPct } from "@/lib/labels";
import { COST_SCOPE_NOTE, MONEY_LABEL } from "@/lib/kpi";
import Empty from "@/components/ui/Empty";
import Pagination from "@/components/ui/Pagination";
import ProjectPicker from "@/components/ui/ProjectPicker";
import { LoadingBlock, LoadFailed } from "@/components/ui/PageState";
import ProgressBar from "@/components/ui/ProgressBar";
import Badge from "@/components/ui/Badge";

type View = "detail" | "summary";

const VIEWS: { code: View; label: string }[] = [
  { code: "detail", label: "明细" },
  { code: "summary", label: "汇总" },
];

// 筛选 / 视图模式 / 分页写入 URL（BLF-1095）
const URL_DEFAULTS = {
  project_id: "",
  dept: "",
  subject: "",
  month: "",
  view: "detail",
  page: "1",
  size: "20",
};

export default function ReportsPage() {
  return (
    <Suspense
      fallback={
        <div>
          <div className="skel skel-title" />
          <LoadingBlock label="加载报表…" />
        </div>
      }
    >
      <ReportsInner />
    </Suspense>
  );
}

function ReportsInner() {
  const { depts, userName } = useMeta();
  const [url, setUrl] = useUrlState(URL_DEFAULTS, { pageKey: "page" });
  const view: View = url.view === "summary" ? "summary" : "detail";
  const page = urlInt(url.page, 1);
  const size = urlInt(url.size, 20, { max: 100 });
  const [exporting, setExporting] = useState(false);
  const [exportErr, setExportErr] = useState("");

  const query = useMemo(
    () =>
      buildQuery({
        project_id: url.project_id,
        dept_id: url.dept,
        subject: url.subject,
        month: url.month,
      }),
    [url.project_id, url.dept, url.subject, url.month],
  );

  const { data, loading, firstLoad, error, reload } = useAsyncData(
    async (signal) => {
      const [report, warns] = await Promise.all([
        reportsApi.cost(query, signal),
        reportsApi.warnings().catch(() => null),
      ]);
      return { rows: report.items ?? [], note: report.note ?? "", warns: warns as Warnings | null };
    },
    [query],
    { resetOnDepChange: true },
  );

  const rows: CostRow[] = data?.rows ?? [];
  const warns = data?.warns ?? null;
  const note = data?.note ?? "";

  // 报表口径由后端一次性返回，明细在本地分页（页码/每页条数同样写入 URL）
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const safePage = Math.min(page, pages);
  const pageRows = view === "detail" ? rows.slice((safePage - 1) * size, safePage * size) : rows;

  const totalBudget = rows.reduce((s, r) => s + r.budget, 0);
  const totalSpent = rows.reduce((s, r) => s + r.spent, 0);

  const bySubjectRows = useMemo(
    () =>
      SUBJECTS.map((s) => {
        const rs = rows.filter((r) => r.subject === s);
        const b = rs.reduce((a, r) => a + r.budget, 0);
        const sp = rs.reduce((a, r) => a + r.spent, 0);
        return { subject: s, budget: b, spent: sp, rate: b ? sp / b : 0 };
      }).filter((r) => r.budget > 0 || r.spent > 0),
    [rows],
  );
  const byDeptRows = useMemo(
    () =>
      depts
        .map((d) => {
          const rs = rows.filter((r) => r.dept_id === d.id);
          const b = rs.reduce((a, r) => a + r.budget, 0);
          const sp = rs.reduce((a, r) => a + r.spent, 0);
          return { dept: d.name, budget: b, spent: sp, rate: b ? sp / b : 0 };
        })
        .filter((r) => r.budget > 0 || r.spent > 0),
    [depts, rows],
  );

  const hasFilter = !!(url.project_id || url.dept || url.subject || url.month);
  const scopeText = [
    url.subject ? `科目=${url.subject}` : "",
    url.month ? `月份=${url.month}` : "",
    view === "detail" ? "" : "汇总视图",
  ]
    .filter(Boolean)
    .join(" · ");

  async function exportExcel() {
    setExporting(true);
    setExportErr("");
    try {
      await reportsApi.exportCost(query);
    } catch (e) {
      setExportErr(errText(e));
    } finally {
      setExporting(false);
    }
  }

  return (
    <div>
      <div className="page-head">
        <h1>成本报表<span className="sub">项目 / 科目 / 部门 / 时间 四维度 · 管理口径</span></h1>
        <div className="actions no-print">
          {VIEWS.map((v) => (
            <button
              key={v.code}
              className={view === v.code ? "btn-primary" : "btn-ghost"}
              style={view === v.code ? { width: "auto" } : undefined}
              aria-pressed={view === v.code}
              onClick={() => setUrl({ view: v.code }, { history: "push" })}
            >
              {v.label}
            </button>
          ))}
          <button className="btn-ghost" onClick={() => window.print()}>打印</button>
          <button className="btn-primary" style={{ width: "auto" }} disabled={exporting} onClick={exportExcel}>
            {exporting ? "导出中…" : "导出 Excel"}
          </button>
        </div>
      </div>

      <div className="card no-print" style={{ marginBottom: 12, padding: "10px 16px", display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
        <label style={{ display: "flex", alignItems: "center", gap: 6, margin: 0, flex: "0 1 300px", minWidth: 0 }}>
          <span className="muted" style={{ fontSize: 13, flex: "none" }}>项目</span>
          <ProjectPicker
            value={url.project_id}
            onChange={(id) => setUrl({ project_id: id })}
            allOption
            allLabel="全部项目"
            placeholder="搜索项目名称 / 编号…"
            ariaLabel="按项目筛选报表"
            className="picker-grow"
          />
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 6, margin: 0 }}>
          <span className="muted" style={{ fontSize: 13 }}>部门</span>
          <select style={{ width: 150 }} value={url.dept} onChange={(e) => setUrl({ dept: e.target.value })} aria-label="按部门筛选">
            <option value="">全部</option>
            {depts.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 6, margin: 0 }}>
          <span className="muted" style={{ fontSize: 13 }}>科目</span>
          <select style={{ width: 120 }} value={url.subject} onChange={(e) => setUrl({ subject: e.target.value })} aria-label="按科目筛选">
            <option value="">全部</option>
            {SUBJECTS.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 6, margin: 0 }}>
          <span className="muted" style={{ fontSize: 13 }}>月份</span>
          <input type="month" style={{ width: 150 }} value={url.month} onChange={(e) => setUrl({ month: e.target.value })} aria-label="按月份筛选" />
        </label>
        {hasFilter && (
          <button
            type="button"
            className="btn-ghost"
            style={{ height: 32, width: "auto" }}
            onClick={() => setUrl({ project_id: "", dept: "", subject: "", month: "" })}
          >
            清除筛选
          </button>
        )}
      </div>

      {error && <LoadFailed message={error} onRetry={reload} />}
      {exportErr && <LoadFailed message={`导出失败：${exportErr}`} onRetry={exportExcel} />}

      <div className="kpi-row">
        <div className="kpi"><div className="k">{MONEY_LABEL.budget}</div><div className="v mono">{fmtMoney(totalBudget)}</div></div>
        <div className="kpi"><div className="k">{MONEY_LABEL.spent}</div><div className="v mono">{fmtMoney(totalSpent)}</div></div>
        <div className="kpi"><div className="k">{MONEY_LABEL.balance}</div><div className="v mono">{fmtMoney(totalBudget - totalSpent)}</div></div>
        <div className="kpi"><div className="k">{MONEY_LABEL.rate}</div><div className="v mono">{totalBudget ? fmtPct(totalSpent / totalBudget) : "-"}</div></div>
      </div>
      <p className="muted tiny" style={{ marginTop: -4, marginBottom: 12 }}>
        {COST_SCOPE_NOTE}；卡片数字对应下方当前筛选范围。
      </p>

      {warns && (warns.overdue_tasks.length + warns.stagnant_projects.length + warns.budget_warnings.length + (warns.followup_due?.length ?? 0) > 0) && (
        <div className="warn-banner">
          <b>预警</b>
          <span className="tiny" style={{ marginLeft: 8 }}>逾期任务 {warns.overdue_tasks.length} · 停滞项目 {warns.stagnant_projects.length} · 预算预警 {warns.budget_warnings.length} · 跟进到期 {warns.followup_due?.length ?? 0}</span>
          <ul style={{ margin: "6px 0 0", paddingLeft: 18, fontSize: 13 }}>
            {warns.budget_warnings.slice(0, 5).map((b) => (
              <li key={`${b.project_id}-${b.subject}`}>
                项目#{b.project_id} {b.subject} 执行率 <span className="mono">{fmtPct(b.rate)}</span> {b.over ? <Badge status="超支" tone="danger" /> : <Badge status="≥80%" tone="warn" />}
              </li>
            ))}
            {warns.stagnant_projects.slice(0, 3).map((s) => (
              <li key={s.project_id}>项目「{s.name}」已 {s.days_no_log} 天无进度填报</li>
            ))}
            {(warns.followup_due ?? []).slice(0, 3).map((f) => (
              <li key={f.followup_id}>跟进提醒到期：{f.content || "（无内容）"} · {userName(f.user_id)}</li>
            ))}
          </ul>
        </div>
      )}

      {view === "detail" ? (
        <>
          <h2 className="section-title">明细（项目 × 科目）</h2>
          {firstLoad ? (
            <LoadingBlock kpis={0} label="加载明细…" />
          ) : rows.length === 0 ? (
            <div className="card">
              <Empty
                title={hasFilter ? "当前筛选下暂无数据" : "暂无报表数据"}
                hint={hasFilter ? "换个筛选条件，或清除筛选。" : "登记预算与支出后自动汇总。"}
              />
            </div>
          ) : (
            <>
              <div className="table-scroll">
                <table className="grid" aria-busy={loading}>
                  <thead><tr><th>项目编号</th><th>项目名称</th><th>科目</th><th className="num">预算</th><th className="num">已支出</th><th className="num">余额</th><th>执行率</th></tr></thead>
                  <tbody>
                    {pageRows.map((r, i) => (
                      <tr key={`${r.project_id}-${r.subject}-${(safePage - 1) * size + i}`}>
                        <td className="mono tiny">{r.project_code}</td>
                        <td><span className="ellipsis" title={r.project_name}>{r.project_name}</span></td>
                        <td>{r.subject || "未分类"}</td>
                        <td className="num">{fmtMoney(r.budget)}</td>
                        <td className="num">{fmtMoney(r.spent)}</td>
                        <td className="num" style={r.balance < 0 ? { color: "var(--danger)" } : undefined}>{fmtMoney(r.balance)}</td>
                        <td><ProgressBar value={r.rate * 100} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pagination
                page={safePage}
                size={size}
                total={rows.length}
                loading={loading}
                scopeText={scopeText}
                ariaLabel="报表明细分页"
                onChange={(next) => setUrl({ page: String(next.page), size: String(next.size) })}
              />
            </>
          )}
        </>
      ) : (
        <div className="split" style={{ marginTop: 16 }}>
          <div>
            <h2 className="section-title">按科目汇总</h2>
            {firstLoad ? (
              <LoadingBlock kpis={0} label="加载汇总…" />
            ) : bySubjectRows.length === 0 ? (
              <div className="card"><Empty title="暂无科目数据" hint="登记预算后按科目汇总。" /></div>
            ) : (
              <div className="table-scroll">
                <table className="grid">
                  <thead><tr><th>科目</th><th className="num">预算</th><th className="num">已支出</th><th>执行率</th></tr></thead>
                  <tbody>
                    {bySubjectRows.map((r) => (
                      <tr key={r.subject}>
                        <td>{r.subject}</td>
                        <td className="num">{fmtMoney(r.budget)}</td>
                        <td className="num">{fmtMoney(r.spent)}</td>
                        <td><ProgressBar value={r.rate * 100} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          <div>
            <h2 className="section-title">按部门汇总</h2>
            {firstLoad ? (
              <LoadingBlock kpis={0} label="加载汇总…" />
            ) : byDeptRows.length === 0 ? (
              <div className="card"><Empty title="暂无部门数据" hint="项目归属部门后按部门汇总。" /></div>
            ) : (
              <div className="table-scroll">
                <table className="grid">
                  <thead><tr><th>部门</th><th className="num">预算</th><th className="num">已支出</th><th>执行率</th></tr></thead>
                  <tbody>
                    {byDeptRows.map((r) => (
                      <tr key={r.dept}>
                        <td>{r.dept}</td>
                        <td className="num">{fmtMoney(r.budget)}</td>
                        <td className="num">{fmtMoney(r.spent)}</td>
                        <td><ProgressBar value={r.rate * 100} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      <p className="tiny" style={{ marginTop: 12 }}>{note || COST_SCOPE_NOTE}</p>
    </div>
  );
}
