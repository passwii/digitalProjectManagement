"use client";

import { Suspense, useMemo, useState } from "react";
import { MonthPicker } from "@/components/ui/DatePicker";
import {
  buildQuery, errText, reportsApi,
  type CostRow, type Warnings,
} from "@/lib/api";
import { useAsyncData } from "@/lib/useAsyncData";
import { urlInt, useUrlState } from "@/lib/useUrlState";
import { useMeta } from "@/lib/useMeta";
import { EXPENSE_PEOPLE, fmtMoney } from "@/lib/labels";
import Empty from "@/components/ui/Empty";
import Pagination from "@/components/ui/Pagination";
import ProjectPicker from "@/components/ui/ProjectPicker";
import PageHeader from "@/components/ui/PageHeader";
import Select from "@/components/ui/Select";
import { CardItem, CardList, DesktopTable } from "@/components/ui/CardList";
import { LoadingBlock, LoadFailed } from "@/components/ui/PageState";
import ProgressBar from "@/components/ui/ProgressBar";
import CountUp from "@/components/motion/CountUp";
import MotionReveal from "@/components/motion/MotionReveal";
import { useActivity } from "@/lib/useActivity";

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
  const { beginActivity } = useActivity();

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
        reportsApi.warnings(signal).catch(() => null),
      ]);
      return { rows: report.items ?? [], warns: warns as Warnings | null };
    },
    [query],
    { resetOnDepChange: true },
  );

  const rows: CostRow[] = data?.rows ?? [];
  const warns = data?.warns ?? null;

  // 报表口径由后端一次性返回，明细在本地分页（页码/每页条数同样写入 URL）
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const safePage = Math.min(page, pages);
  const pageRows = view === "detail" ? rows.slice((safePage - 1) * size, safePage * size) : rows;

  const totalSpent = rows.reduce((s, r) => s + r.spent, 0);
  const peopleOptions = Array.from(new Set<string>([
    ...EXPENSE_PEOPLE,
    ...rows.map((r) => r.subject).filter(Boolean),
  ]));

  const byPersonRows = useMemo(
    () =>
      peopleOptions.map((s) => {
        const rs = rows.filter((r) => r.subject === s);
        const sp = rs.reduce((a, r) => a + r.spent, 0);
        return { subject: s, spent: sp, share: totalSpent ? sp / totalSpent : 0 };
      }).filter((r) => r.spent > 0),
    [peopleOptions, rows, totalSpent],
  );
  const byDeptRows = useMemo(
    () =>
      depts
        .map((d) => {
          const rs = rows.filter((r) => r.dept_id === d.id);
          const sp = rs.reduce((a, r) => a + r.spent, 0);
          return { dept: d.name, spent: sp, share: totalSpent ? sp / totalSpent : 0 };
        })
        .filter((r) => r.spent > 0),
    [depts, rows, totalSpent],
  );

  const hasFilter = !!(url.project_id || url.dept || url.subject || url.month);
  const scopeText = [
    url.subject ? `人员=${url.subject}` : "",
    url.month ? `月份=${url.month}` : "",
    view === "detail" ? "" : "汇总视图",
  ]
    .filter(Boolean)
    .join(" · ");

  async function exportExcel() {
    const finish = beginActivity({ label: "导出报表", scope: "form" });
    setExporting(true);
    setExportErr("");
    try {
      await reportsApi.exportCost(query);
    } catch (e) {
      setExportErr(errText(e));
    } finally {
      setExporting(false);
      finish();
    }
  }

  return (
    <div>
      <PageHeader
        title="支出报表"
        filters={
          <>
            <ProjectPicker
              value={url.project_id}
              onChange={(id) => setUrl({ project_id: id })}
              allOption
              allLabel="全部项目"
              placeholder="搜索项目名称 / 编号…"
              ariaLabel="按项目筛选报表"
              className="picker-grow filter-span-2 reports-project-filter"
            />
            <Select value={url.dept} onChange={(value) => setUrl({ dept: value })} aria-label="按部门筛选">
              <option value="">全部</option>
              {depts.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </Select>
            <Select value={url.subject} onChange={(value) => setUrl({ subject: value })} aria-label="按人员筛选">
              <option value="">全部</option>
              {peopleOptions.map((s) => <option key={s} value={s}>{s}</option>)}
            </Select>
            <MonthPicker size="toolbar" value={url.month} onChange={(v) => setUrl({ month: v })} ariaLabel="按月份筛选" />
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
          </>
        }
        actions={
          <>
            {VIEWS.map((v) => (
              <button
                key={v.code}
                className={view === v.code ? "btn-primary" : "btn-ghost"}
                aria-pressed={view === v.code}
                onClick={() => setUrl({ view: v.code }, { history: "push" })}
              >
                {v.label}
              </button>
            ))}
            <button className="btn-ghost" onClick={() => window.print()}>打印</button>
            <button className="btn-primary" disabled={exporting} onClick={exportExcel} aria-busy={exporting}>
              {exporting ? "导出中…" : "导出 Excel"}
            </button>
          </>
        }
      />

      {error && <LoadFailed message={error} onRetry={reload} />}
      {exportErr && <LoadFailed message={`导出失败：${exportErr}`} onRetry={exportExcel} />}

      <MotionReveal>
        <div className="kpi-row">
          <div className="kpi"><div className="k">支出总额</div><div className="v"><CountUp value={totalSpent} format={fmtMoney} /></div></div>
          <div className="kpi"><div className="k">涉及项目</div><div className="v"><CountUp value={new Set(rows.map((r) => r.project_id)).size} /></div></div>
          <div className="kpi"><div className="k">涉及人员</div><div className="v"><CountUp value={byPersonRows.length} /></div></div>
          <div className="kpi"><div className="k">明细条数</div><div className="v"><CountUp value={rows.length} /></div></div>
        </div>
      </MotionReveal>
      {warns && (warns.overdue_tasks.length + warns.stagnant_projects.length + (warns.followup_due?.length ?? 0) > 0) && (
        <MotionReveal>
          <div className="warn-banner">
            <b>预警</b>
            <span className="tiny" style={{ marginLeft: 8 }}>逾期任务 {warns.overdue_tasks.length} · 停滞项目 {warns.stagnant_projects.length} · 跟进到期 {warns.followup_due?.length ?? 0}</span>
            <ul style={{ margin: "6px 0 0", paddingLeft: 18, fontSize: 13 }}>
              {warns.stagnant_projects.slice(0, 3).map((s) => (
                <li key={s.project_id}>项目「{s.name}」已 {s.days_no_log} 天无进度填报</li>
              ))}
              {(warns.followup_due ?? []).slice(0, 3).map((f) => (
                <li key={f.followup_id}>跟进提醒到期：{f.content || "（无内容）"} · {userName(f.user_id)}</li>
              ))}
            </ul>
          </div>
        </MotionReveal>
      )}

      {view === "detail" ? (
        <MotionReveal>
          <h2 className="section-title">明细（项目 × 人员）</h2>
          {firstLoad ? (
            <LoadingBlock kpis={0} label="加载明细…" />
          ) : rows.length === 0 ? (
            <div className="card">
              <Empty
                title={hasFilter ? "当前筛选下暂无数据" : "暂无报表数据"}
                hint={hasFilter ? "换个筛选条件，或清除筛选。" : "登记项目支出后自动汇总。"}
              />
            </div>
          ) : (
            <>
              <CardList label="支出报表明细">
                {pageRows.map((r, i) => (
                  <CardItem
                    key={`${r.project_id}-${r.subject}-${(safePage - 1) * size + i}`}
                    title={r.project_name}
                    code={r.project_code}
                    fields={[
                      { label: "人员", value: r.subject || "未填写人员" },
                      { label: "支出金额", value: fmtMoney(r.spent), mono: true },
                      { label: "占比", value: <ProgressBar value={totalSpent ? r.spent / totalSpent * 100 : 0} /> },
                    ]}
                  />
                ))}
              </CardList>
              <DesktopTable>
                <table className="grid" aria-busy={loading}>
                  <thead><tr><th>项目编号</th><th>项目名称</th><th>人员</th><th className="num">支出金额</th><th>占比</th></tr></thead>
                  <tbody>
                    {pageRows.map((r, i) => (
                      <tr key={`${r.project_id}-${r.subject}-${(safePage - 1) * size + i}`}>
                        <td className="mono tiny">{r.project_code}</td>
                        <td><span className="ellipsis" title={r.project_name}>{r.project_name}</span></td>
                        <td>{r.subject || "未填写人员"}</td>
                        <td className="num">{fmtMoney(r.spent)}</td>
                        <td><ProgressBar value={totalSpent ? r.spent / totalSpent * 100 : 0} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </DesktopTable>
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
        </MotionReveal>
      ) : (
        <MotionReveal className="split" delay={0.04}>
          <div>
            <h2 className="section-title">按人员汇总</h2>
            {firstLoad ? (
              <LoadingBlock kpis={0} label="加载汇总…" />
            ) : byPersonRows.length === 0 ? (
              <div className="card"><Empty title="暂无人员支出" hint="登记支出后按人员汇总。" /></div>
            ) : (
              <>
              <CardList label="按人员汇总">
                {byPersonRows.map((r) => (
                  <CardItem key={r.subject} title={r.subject} fields={[
                    { label: "支出金额", value: fmtMoney(r.spent), mono: true },
                    { label: "占比", value: <ProgressBar value={r.share * 100} /> },
                  ]} />
                ))}
              </CardList>
              <DesktopTable>
                <table className="grid">
                  <thead><tr><th>人员</th><th className="num">支出金额</th><th>占比</th></tr></thead>
                  <tbody>
                    {byPersonRows.map((r) => (
                      <tr key={r.subject}>
                        <td>{r.subject}</td>
                        <td className="num">{fmtMoney(r.spent)}</td>
                        <td><ProgressBar value={r.share * 100} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </DesktopTable>
              </>
            )}
          </div>
          <div>
            <h2 className="section-title">按部门汇总</h2>
            {firstLoad ? (
              <LoadingBlock kpis={0} label="加载汇总…" />
            ) : byDeptRows.length === 0 ? (
              <div className="card"><Empty title="暂无部门数据" hint="项目归属部门后按部门汇总。" /></div>
            ) : (
              <>
              <CardList label="按部门汇总">
                {byDeptRows.map((r) => (
                  <CardItem key={r.dept} title={r.dept} fields={[
                    { label: "支出金额", value: fmtMoney(r.spent), mono: true },
                    { label: "占比", value: <ProgressBar value={r.share * 100} /> },
                  ]} />
                ))}
              </CardList>
              <DesktopTable>
                <table className="grid">
                  <thead><tr><th>部门</th><th className="num">支出金额</th><th>占比</th></tr></thead>
                  <tbody>
                    {byDeptRows.map((r) => (
                      <tr key={r.dept}>
                        <td>{r.dept}</td>
                        <td className="num">{fmtMoney(r.spent)}</td>
                        <td><ProgressBar value={r.share * 100} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </DesktopTable>
              </>
            )}
          </div>
        </MotionReveal>
      )}

    </div>
  );
}
