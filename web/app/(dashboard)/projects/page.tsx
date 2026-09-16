"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { errText, projectsApi, type Project } from "@/lib/api";
import { useMeta, useMenus } from "@/lib/useMeta";
import {
  PROJECT_FLOW, PROJECT_STATUS, fmtDate, fmtMoney,
  projectStatusLabel, projectTone,
} from "@/lib/labels";
import Badge from "@/components/ui/Badge";
import Avatar from "@/components/ui/Avatar";
import Empty from "@/components/ui/Empty";
import Pagination from "@/components/ui/Pagination";
import TableToolbar from "@/components/ui/TableToolbar";
import ProgressBar from "@/components/ui/ProgressBar";
import { Confirm, Drawer } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import ProjectFormDialog from "./ProjectFormDialog";

const SIZE = 20;

export default function ProjectsPage() {
  const { users, depts, userName, deptName } = useMeta();
  // 删除（软删除）与解归档仅管理员：显示条件取后端菜单契约
  const { isAdmin } = useMenus();
  const toast = useToast();

  const [items, setItems] = useState<Project[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [ownerId, setOwnerId] = useState("");

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Project | null>(null);
  const [detail, setDetail] = useState<Project | null>(null);
  const [confirmFlow, setConfirmFlow] = useState<{ p: Project; to: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Project | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setErr("");
    const params = new URLSearchParams({ page: String(page), size: String(SIZE) });
    if (q.trim()) params.set("keyword", q.trim());
    if (status) params.set("status", status);
    if (ownerId) params.set("owner_id", ownerId);
    try {
      const data = await projectsApi.list(`?${params.toString()}`);
      setItems(data.items ?? []);
      setTotal(data.total ?? 0);
    } catch (e) {
      setErr(errText(e));
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [page, q, status, ownerId]);

  useEffect(() => {
    const t = setTimeout(load, 200);
    return () => clearTimeout(t);
  }, [load]);

  useEffect(() => setPage(1), [q, status, ownerId]);

  const statusOptions = Object.entries(PROJECT_STATUS).map(([code, label]) => ({ code, label }));
  const DESTRUCTIVE = new Set(["cancelled", "archived", "done"]);

  async function changeStatus(p: Project, to: string) {
    setBusy(true);
    try {
      const updated = await projectsApi.status(p.id, to, "页面流转");
      toast.ok(`已流转为「${projectStatusLabel(updated.status)}」`);
      setDetail((d) => (d?.id === updated.id ? updated : d));
      await load();
    } catch (e) {
      toast.err(errText(e));
    } finally {
      setBusy(false);
      setConfirmFlow(null);
    }
  }

  return (
    <div>
      <div className="page-head">
        <h1>
          项目台账
          <span className="sub mono">{total} 个项目</span>
        </h1>
        <div className="actions">
          <button
            className="btn-primary"
            style={{ width: "auto" }}
            onClick={() => { setEditing(null); setFormOpen(true); }}
          >
            + 新建项目
          </button>
        </div>
      </div>

      {err && <div className="err-banner">{err}</div>}

      <TableToolbar>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索名称 / 编号 / 客户…" aria-label="搜索项目" />
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="按状态筛选">
          <option value="">全部状态</option>
          {statusOptions.map((s) => <option key={s.code} value={s.code}>{s.label}</option>)}
        </select>
        <select value={ownerId} onChange={(e) => setOwnerId(e.target.value)} aria-label="按负责人筛选">
          <option value="">全部负责人</option>
          {users.map((u) => <option key={u.id} value={u.id}>{u.real_name}</option>)}
        </select>
      </TableToolbar>

      {loading ? (
        <p className="muted">加载中…</p>
      ) : items.length === 0 ? (
        <div className="card"><Empty title="暂无项目" hint="换个筛选条件，或新建第一个项目。" /></div>
      ) : (
        <>
          <table className="grid">
            <thead>
              <tr>
                <th>编号</th>
                <th>名称</th>
                <th>状态</th>
                <th>负责人</th>
                <th>部门</th>
                <th>计划期</th>
                <th className="num">预算（元）</th>
                <th className="num">进度</th>
                <th className="no-print" />
              </tr>
            </thead>
            <tbody>
              {items.map((p) => (
                <tr
                  key={p.id}
                  onClick={() => setDetail(p)}
                  style={{ cursor: "pointer" }}
                  title="点击查看详情"
                >
                  <td className="mono tiny">{p.code}</td>
                  <td>
                    <span className="ellipsis" title={p.name}>{p.name}</span>{" "}
                    {p.snippet && (
                      <span
                        className="tiny snippet"
                        title="关键词命中位置"
                        dangerouslySetInnerHTML={{ __html: p.snippet }}
                      />
                    )}
                    <span className="row-actions" onClick={(e) => e.stopPropagation()}>
                      <button onClick={() => setDetail(p)}>详情</button>
                      <button onClick={() => { setEditing(p); setFormOpen(true); }}>编辑</button>
                      <Link href={`/progress?project_id=${p.id}`}>进度</Link>
                      <Link href={`/costs?project_id=${p.id}`}>成本</Link>
                    </span>
                  </td>
                  <td><Badge status={projectStatusLabel(p.status)} tone={projectTone(p.status)} /></td>
                  <td>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                      <Avatar name={userName(p.owner_id)} size={22} />{userName(p.owner_id)}
                    </span>
                  </td>
                  <td className="muted">{deptName(p.dept_id)}</td>
                  <td className="mono tiny">{fmtDate(p.plan_start)} ~ {fmtDate(p.plan_end)}</td>
                  <td className="num">{fmtMoney(p.budget_total)}</td>
                  <td className="num">{p.progress ?? 0}%</td>
                  <td className="no-print">
                    <span style={{ display: "inline-flex", gap: 6 }}>
                      <button
                        className="btn-ghost"
                        style={{ height: 26, lineHeight: "24px", padding: "0 8px", fontSize: 12 }}
                        onClick={(e) => { e.stopPropagation(); setEditing(p); setFormOpen(true); }}
                      >
                        编辑
                      </button>
                      {isAdmin && !["doing", "filed"].includes(p.status) && (
                        <button
                          className="btn-ghost"
                          style={{ height: 26, lineHeight: "24px", padding: "0 8px", fontSize: 12, color: "var(--danger)", borderColor: "var(--line-danger)" }}
                          onClick={(e) => {
                            e.stopPropagation();
                            setDeleteTarget(p);
                          }}
                        >
                          删除
                        </button>
                      )}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pagination page={page} size={SIZE} total={total} onChange={setPage} />
        </>
      )}

      {/* 新建 / 编辑弹窗 */}
      <ProjectFormDialog
        open={formOpen}
        onClose={() => setFormOpen(false)}
        project={editing}
        onSaved={(saved, isNew) => {
          toast.ok(isNew ? `项目已创建：${saved.code}` : "项目信息已保存（变更已留痕）");
          setFormOpen(false);
          setDetail((d) => (d && d.id === saved.id ? saved : d));
          load();
        }}
      />

      {/* 行详情抽屉 */}
      <Drawer
        open={!!detail}
        onClose={() => setDetail(null)}
        width={520}
        title={
          detail ? (
            <span className="ellipsis" style={{ maxWidth: 340, display: "inline-block" }} title={detail.name}>
              {detail.name}
            </span>
          ) : ""
        }
        footer={
          detail && (
            <>
              <button className="btn-ghost" onClick={() => { setEditing(detail); setFormOpen(true); }}>编辑</button>
              <Link className="btn-primary" href={`/projects/${detail.id}`} style={{ display: "inline-flex", alignItems: "center", padding: "0 16px" }}>
                打开完整档案
              </Link>
            </>
          )
        }
      >
        {detail && (
          <>
            <dl className="kv one">
              <div><dt>项目编号</dt><dd className="mono">{detail.code}</dd></div>
              <div><dt>状态</dt><dd><Badge status={projectStatusLabel(detail.status)} tone={projectTone(detail.status)} /></dd></div>
              <div><dt>加权进度</dt><dd><ProgressBar value={detail.progress ?? 0} tone="brand" /></dd></div>
              <div><dt>项目类型 / 优先级</dt><dd>{detail.type || "-"} · {detail.priority}</dd></div>
              <div><dt>所属部门</dt><dd>{deptName(detail.dept_id)}</dd></div>
              <div><dt>项目负责人</dt><dd>{userName(detail.owner_id)}</dd></div>
              <div><dt>客户 / 委托方</dt><dd>{detail.client || "-"}</dd></div>
              <div><dt>计划起止</dt><dd className="mono">{fmtDate(detail.plan_start)} ~ {fmtDate(detail.plan_end)}</dd></div>
              <div><dt>预算总额</dt><dd className="mono">{fmtMoney(detail.budget_total)} 元</dd></div>
              <div><dt>项目成员</dt><dd>{detail.member_ids.map((m) => userName(m)).join("、") || "-"}</dd></div>
              <div><dt>项目简介</dt><dd>{detail.description || "-"}</dd></div>
            </dl>

            {(() => {
              // 解归档（archived → doing）仅管理员可操作，非管理员不展示必然 403 的按钮
              const flow = (PROJECT_FLOW[detail.status] ?? []).filter(
                (to) => !(detail.status === "archived" && to === "doing" && !isAdmin)
              );
              if (flow.length === 0) {
                return detail.status === "archived" && !isAdmin ? (
                  <div className="muted" style={{ fontSize: 12, marginTop: 16 }}>
                    项目已归档且为只读，解除归档需管理员操作。
                  </div>
                ) : null;
              }
              return (
                <div style={{ marginTop: 16 }}>
                  <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>状态流转（操作留痕）</div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {flow.map((to) =>
                      DESTRUCTIVE.has(to) ? (
                        <button key={to} className="btn-ghost" onClick={() => setConfirmFlow({ p: detail, to })}>
                          → {projectStatusLabel(to)}
                        </button>
                      ) : (
                        <button key={to} className="btn-ghost" disabled={busy} onClick={() => changeStatus(detail, to)}>
                          → {projectStatusLabel(to)}
                        </button>
                      )
                    )}
                  </div>
                  {detail.status === "archived" && !isAdmin && (
                    <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>解除归档需管理员操作。</div>
                  )}
                </div>
              );
            })()}
          </>
        )}
      </Drawer>

      {/* 危险流转二次确认 */}      <Confirm
        open={!!confirmFlow}
        danger
        loading={busy}
        title={`确认流转为「${confirmFlow ? projectStatusLabel(confirmFlow.to) : ""}」？`}
        text={
          confirmFlow && (
            <>
              项目 <b>{confirmFlow.p.name}</b>（<span className="mono">{confirmFlow.p.code}</span>）
              {confirmFlow.to === "archived"
                ? " 将归档为只读，需管理员才能解除归档。"
                : confirmFlow.to === "cancelled"
                ? " 取消后不可再流转（终态）。"
                : " 完成后可归档。"}
            </>
          )
        }
        okText="确认流转"
        onConfirm={() => confirmFlow && changeStatus(confirmFlow.p, confirmFlow.to)}
        onCancel={() => setConfirmFlow(null)}
      />

      {/* 软删除二次确认 */}
      <Confirm
        open={!!deleteTarget}
        danger
        loading={busy}
        title={`删除项目「${deleteTarget?.name ?? ""}」？`}
        text="项目将移入回收站（仅管理员可恢复），关联的任务、支出、附件保留。"
        okText="移入回收站"
        onConfirm={async () => {
          if (!deleteTarget) return;
          setBusy(true);
          try {
            await projectsApi.remove(deleteTarget.id);
            toast.ok("项目已移入回收站（系统管理 → 回收站可恢复）");
            await load();
          } catch (e) {
            toast.err(errText(e));
          } finally {
            setBusy(false);
            setDeleteTarget(null);
          }
        }}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
