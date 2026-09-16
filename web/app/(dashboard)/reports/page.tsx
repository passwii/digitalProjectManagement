"use client";

import { useCallback, useEffect, useState } from "react";
import {
  errText, projectsApi, reportsApi,
  type CostRow, type Project, type Warnings,
} from "@/lib/api";
import { useMeta } from "@/lib/useMeta";
import { SUBJECTS, fmtMoney, fmtPct } from "@/lib/labels";
import Empty from "@/components/ui/Empty";
import ProgressBar from "@/components/ui/ProgressBar";
import Badge from "@/components/ui/Badge";

export default function ReportsPage() {
  const { depts, userName } = useMeta();
  const [projects, setProjects] = useState<Project[]>([]);
  const [rows, setRows] = useState<CostRow[]>([]);
  const [note, setNote] = useState("");
  const [warns, setWarns] = useState<Warnings | null>(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);

  const [byProject, setByProject] = useState("");
  const [byDept, setByDept] = useState("");
  const [bySubject, setBySubject] = useState("");
  const [byMonth, setByMonth] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const data = await projectsApi.list("?size=100");
        setProjects(data.items ?? []);
      } catch (e) {
        setErr(errText(e));
      }
    })();
  }, []);

  const query = useCallback(() => {
    const p = new URLSearchParams();
    if (byProject) p.set("project_id", byProject);
    if (byDept) p.set("dept_id", byDept);
    if (bySubject) p.set("subject", bySubject);
    if (byMonth) p.set("month", byMonth);
    return p.toString() ? `?${p.toString()}` : "";
  }, [byProject, byDept, bySubject, byMonth]);

  const load = useCallback(async () => {
    setLoading(true);
    setErr("");
    try {
      const [data, w] = await Promise.all([
        reportsApi.cost(query()),
        reportsApi.warnings().catch(() => null),
      ]);
      setRows(data.items ?? []);
      setNote(data.note ?? "");
      setWarns(w);
    } catch (e) {
      setErr(errText(e));
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => { load(); }, [load]);

  async function exportExcel() {
    setErr("");
    try {
      await reportsApi.exportCost(query());
    } catch (e) {
      setErr(errText(e));
    }
  }

  // 四维度汇总（前端按维度二次聚合，与页面同源数据，保证口径一致）
  const totalBudget = rows.reduce((s, r) => s + r.budget, 0);
  const totalSpent = rows.reduce((s, r) => s + r.spent, 0);
  const bySubjectRows = SUBJECTS.map((s) => {
    const rs = rows.filter((r) => r.subject === s);
    const b = rs.reduce((a, r) => a + r.budget, 0);
    const sp = rs.reduce((a, r) => a + r.spent, 0);
    return { subject: s, budget: b, spent: sp, rate: b ? sp / b : 0 };
  }).filter((r) => r.budget > 0 || r.spent > 0);
  const byDeptRows = depts
    .map((d) => {
      const rs = rows.filter((r) => r.dept_id === d.id);
      const b = rs.reduce((a, r) => a + r.budget, 0);
      const sp = rs.reduce((a, r) => a + r.spent, 0);
      return { dept: d.name, budget: b, spent: sp, rate: b ? sp / b : 0 };
    })
    .filter((r) => r.budget > 0 || r.spent > 0);

  return (
    <div>
      <div className="page-head">
        <h1>成本报表<span className="sub">项目 / 科目 / 部门 / 时间 四维度 · 管理口径</span></h1>
        <div className="actions no-print">
          <button className="btn-ghost" onClick={() => window.print()}>打印</button>
          <button className="btn-primary" style={{ width: "auto" }} onClick={exportExcel}>导出 Excel</button>
        </div>
      </div>

      <div className="card no-print" style={{ marginBottom: 12, padding: "10px 16px", display: "flex", gap: 12, flexWrap: "wrap" }}>
        <label style={{ display: "flex", alignItems: "center", gap: 6, margin: 0 }}>
          <span className="muted" style={{ fontSize: 13 }}>项目</span>
          <select style={{ width: 220 }} value={byProject} onChange={(e) => setByProject(e.target.value)}>
            <option value="">全部</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 6, margin: 0 }}>
          <span className="muted" style={{ fontSize: 13 }}>部门</span>
          <select style={{ width: 150 }} value={byDept} onChange={(e) => setByDept(e.target.value)}>
            <option value="">全部</option>
            {depts.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 6, margin: 0 }}>
          <span className="muted" style={{ fontSize: 13 }}>科目</span>
          <select style={{ width: 120 }} value={bySubject} onChange={(e) => setBySubject(e.target.value)}>
            <option value="">全部</option>
            {SUBJECTS.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 6, margin: 0 }}>
          <span className="muted" style={{ fontSize: 13 }}>月份</span>
          <input type="month" style={{ width: 150 }} value={byMonth} onChange={(e) => setByMonth(e.target.value)} />
        </label>
      </div>

      {err && <div className="err-banner">{err}</div>}

      <div className="kpi-row">
        <div className="kpi"><div className="k">预算合计</div><div className="v mono">{fmtMoney(totalBudget)}</div></div>
        <div className="kpi"><div className="k">已支出</div><div className="v mono">{fmtMoney(totalSpent)}</div></div>
        <div className="kpi"><div className="k">余额</div><div className="v mono">{fmtMoney(totalBudget - totalSpent)}</div></div>
        <div className="kpi"><div className="k">执行率</div><div className="v mono">{totalBudget ? fmtPct(totalSpent / totalBudget) : "-"}</div></div>
      </div>

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

      <h2 className="section-title">明细（项目 × 科目）</h2>
      {loading ? (
        <p className="muted">加载中…</p>
      ) : rows.length === 0 ? (
        <div className="card"><Empty title="暂无报表数据" hint="登记预算与支出后自动汇总。" /></div>
      ) : (
        <table className="grid">
          <thead><tr><th>项目编号</th><th>项目名称</th><th>科目</th><th className="num">预算</th><th className="num">已支出</th><th className="num">余额</th><th>执行率</th></tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={`${r.project_id}-${r.subject}-${i}`}>
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
      )}

      <div className="split" style={{ marginTop: 16 }}>
        <div>
          <h2 className="section-title">按科目汇总</h2>
          {bySubjectRows.length === 0 ? (
            <div className="card"><Empty title="暂无科目数据" hint="登记预算后按科目汇总。" /></div>
          ) : (
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
          )}
        </div>
        <div>
          <h2 className="section-title">按部门汇总</h2>
          {byDeptRows.length === 0 ? (
            <div className="card"><Empty title="暂无部门数据" hint="项目归属部门后按部门汇总。" /></div>
          ) : (
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
          )}
        </div>
      </div>

      <p className="tiny" style={{ marginTop: 12 }}>{note || "成本为项目管理口径，与财务账存在差异"}</p>
    </div>
  );
}
