"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { errText, projectsApi, type Project } from "@/lib/api";
import { useAsyncData } from "@/lib/useAsyncData";
import { urlInt, useUrlState, useUrlText } from "@/lib/useUrlState";
import { buildYearOptions, parseYearParam, yearToCodeFilter } from "@/lib/projectYear";
import { buildProjectListQuery } from "@/lib/projectFilters";
import { useMeta, useMenus } from "@/lib/useMeta";
import {
  PROJECT_FLOW, PROJECT_STATUS, fmtMoney,
  projectStatusLabel, projectTone,
} from "@/lib/labels";
import Badge from "@/components/ui/Badge";
import Avatar from "@/components/ui/Avatar";
import Empty from "@/components/ui/Empty";
import Pagination from "@/components/ui/Pagination";
import { LoadingBlock, LoadFailed } from "@/components/ui/PageState";
import TableToolbar from "@/components/ui/TableToolbar";
import { Confirm, Drawer } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import PageActions from "@/components/ui/PageActions";
import ProgressBar from "@/components/ui/ProgressBar";
import { CardItem, CardList, DesktopTable } from "@/components/ui/CardList";
import MotionReveal from "@/components/motion/MotionReveal";
import ProjectFormDialog from "./ProjectFormDialog";

const SIZE_OPTIONS = [15, 50, 100];

// 筛选 / 分页 / 每页条数写入 URL：刷新、复制链接、前进后退都能恢复同一视图（BLF-1095）
// year 为裸年份（"2026"/""），发往后端时转成 code 模糊值（BLF-1149）
const URL_DEFAULTS = {
  q: "",
  status: "",
  owner: "",
  year: "",
  page: "1",
  size: "15",
};

// 列表默认倒序：后端默认即 -id（PROJECT_SORTS 白名单），前端显式锁定该契约（BLF-1149）
const DEFAULT_SORT = "-id";

export default function ProjectsPage() {
  return (
    <Suspense
      fallback={
        <div>
          <div className="skel skel-title" />
          <LoadingBlock kpis={0} label="加载项目台账…" />
        </div>
      }
    >
      <ProjectsInner />
    </Suspense>
  );
}

function ProjectsInner() {
  const { users, userName } = useMeta();
  // 删除（软删除）与解归档仅管理员：显示条件取后端菜单契约
  const { isAdmin, demoOn } = useMenus();
  const toast = useToast();

  const [url, setUrl] = useUrlState(URL_DEFAULTS, { pageKey: "page" });
  const page = urlInt(url.page, 1);
  const size = SIZE_OPTIONS.includes(Number(url.size)) ? Number(url.size) : SIZE_OPTIONS[0];
  const year = parseYearParam(url.year);
  const yearOptions = buildYearOptions(Date.now(), year);
  const [qDraft, setQDraft] = useUrlText(url.q, (next) => setUrl({ q: next }));

  const { data, loading, firstLoad, error, reload } = useAsyncData(
    (signal) =>
      projectsApi.list(
        buildProjectListQuery({
          page,
          size,
          sort: DEFAULT_SORT,
          keyword: url.q.trim(),
          status: url.status,
          owner: url.owner,
          code: yearToCodeFilter(year),
        }),
        signal,
      ),
    [page, size, url.q, url.status, url.owner, year],
    { resetOnDepChange: true },
  );

  const items: Project[] = data?.items ?? [];
  const total = data?.total ?? 0;

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Project | null>(null);
  const [detail, setDetail] = useState<Project | null>(null);
  const [confirmFlow, setConfirmFlow] = useState<{ p: Project; to: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Project | null>(null);
  const [busy, setBusy] = useState(false);

  const statusOptions = Object.entries(PROJECT_STATUS).map(([code, label]) => ({ code, label }));
  const DESTRUCTIVE = new Set(["cancelled", "archived", "done"]);
  const hasFilter = !!(url.q || url.status || url.owner || year);
  const scopeText = [
    url.q ? `关键词「${url.q}」` : "",
    url.status ? `状态=${PROJECT_STATUS[url.status] ?? url.status}` : "",
    url.owner ? `负责人=${userName(Number(url.owner))}` : "",
    year ? `${year}年` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const ownerText = (p: Project) => p.owner_name || userName(p.owner_id);

  async function changeStatus(p: Project, to: string) {
    setBusy(true);
    try {
      const updated = await projectsApi.status(p.id, to, "页面流转");
      toast.ok(`已流转为「${projectStatusLabel(updated.status)}」`);
      setDetail((d) => (d?.id === updated.id ? updated : d));
      reload();
    } catch (e) {
      toast.err(errText(e));
    } finally {
      setBusy(false);
      setConfirmFlow(null);
    }
  }

  return (
    <div>
      <PageActions
        title="项目台账"
        actions={
          <button
            className="btn-primary"
            title="创建一个新的项目档案"
            onClick={() => { setEditing(null); setFormOpen(true); }}
          >
            + 新建项目
          </button>
        }
      />

      {demoOn && (
        <MotionReveal>
        <div
          className="warn-banner"
          style={{ background: "var(--brand-soft)", borderColor: "var(--line-blue)", color: "var(--brand)" }}
        >
          当前正在显示<b>演示数据</b>（工作台与报表统计同样包含），关闭开关即可全站隐藏。
        </div>
        </MotionReveal>
      )}

      {error && <LoadFailed message={error} onRetry={reload} />}

      <MotionReveal delay={0.04}>
      <TableToolbar>
        <input
          value={qDraft}
          onChange={(e) => setQDraft(e.target.value)}
          placeholder="搜索名称 / 编号 / 客户…"
          aria-label="搜索项目"
        />
        <select
          value={url.status}
          onChange={(e) => setUrl({ status: e.target.value })}
          aria-label="按状态筛选"
        >
          <option value="">全部状态</option>
          {statusOptions.map((s) => <option key={s.code} value={s.code}>{s.label}</option>)}
        </select>
        <select
          value={url.owner}
          onChange={(e) => setUrl({ owner: e.target.value })}
          aria-label="按负责人筛选"
        >
          <option value="">全部负责人</option>
          {users.map((u) => <option key={u.id} value={u.id}>{u.real_name}</option>)}
        </select>
        <select
          value={year}
          onChange={(e) => setUrl({ year: e.target.value })}
          aria-label="按年度筛选"
        >
          <option value="">全部年份</option>
          {yearOptions.map((y) => <option key={y} value={y}>{y}年</option>)}
        </select>
        {hasFilter && (
          <button
            type="button"
            className="btn-ghost"
            style={{ height: 32, lineHeight: "30px", width: "auto" }}
            onClick={() => setUrl({ q: "", status: "", owner: "", year: "" })}
          >
            清除筛选
          </button>
        )}
      </TableToolbar>
      </MotionReveal>

      {firstLoad ? (
        <LoadingBlock kpis={0} label="加载项目台账…" />
      ) : items.length === 0 ? (
        <div className="card">
          <Empty
            title={hasFilter ? "没有匹配的项目" : "暂无项目"}
            hint={
              hasFilter
                ? "换个筛选条件，或清除筛选后重试。"
                : "点击右上角新建第一个项目。"
            }
          />
        </div>
      ) : (
        <MotionReveal delay={0.08}>
          {/* D4：手机端卡片流 —— 同一份数据，纯 CSS 在 767px 与下表切换（见 CardList） */}
          <CardList label="项目台账">
            {items.map((p) => (
              <CardItem
                key={p.id}
                title={
                  <span className="ellipsis" title={p.name}>
                    {p.name}
                  </span>
                }
                code={p.code}
                badges={
                  <>
                    <Badge
                      status={projectStatusLabel(p.status)}
                      tone={projectTone(p.status)}
                    />
                    <Badge
                      status={p.contract_status || "未登记"}
                      tone={p.contract_status === "已签订" ? "done" : "todo"}
                    />
                  </>
                }
                fields={[
                  {
                    label: "负责人",
                    value: (
                      <span className="inline-person">
                        <Avatar name={ownerText(p)} size={22} />
                        {ownerText(p)}
                      </span>
                    ),
                  },
                  {
                    label: "客户",
                    value: (
                      <span className="ellipsis" title={p.client}>
                        {p.client || "-"}
                      </span>
                    ),
                  },
                  {
                    label: "预算",
                    value: `${fmtMoney(p.budget_total)} 元`,
                    mono: true,
                  },
                  {
                    label: "进度",
                    value: <ProgressBar value={p.progress ?? 0} />,
                  },
                ]}
                actions={
                  <>
                    <button
                      type="button"
                      className="btn-ghost btn-xs"
                      onClick={() => {
                        setEditing(p);
                        setFormOpen(true);
                      }}
                    >
                      编辑
                    </button>
                    {isAdmin && !["doing", "filed"].includes(p.status) && (
                      <button
                        type="button"
                        className="btn-ghost btn-xs btn-danger-outline"
                        onClick={() => setDeleteTarget(p)}
                      >
                        删除
                      </button>
                    )}
                  </>
                }
                onSelect={() => setDetail(p)}
              />
            ))}
          </CardList>
          <DesktopTable>
            <table className="grid project-table" aria-busy={loading}>
              <colgroup>
                <col style={{ width: 104 }} />
                <col style={{ width: 250 }} />
                <col style={{ width: 104 }} />
                <col style={{ width: 150 }} />
                <col style={{ width: 84 }} />
                <col style={{ width: 110 }} />
                <col style={{ width: 70 }} />
                <col style={{ width: 84 }} />
                <col style={{ width: 110 }} />
              </colgroup>
              <thead>
                <tr>
                  <th>编号</th>
                  <th>名称</th>
                  <th>负责人</th>
                  <th>客户</th>
                  <th>合同</th>
                  <th className="num">合同金额（元）</th>
                  <th className="num">进度</th>
                  <th>状态</th>
                  <th className="no-print" />
                </tr>
              </thead>
              <tbody>
                {items.map((p) => (
                  <tr
                    key={p.id}
                    className="clickable-row"
                    onClick={() => setDetail(p)}
                    title="点击查看详情"
                  >
                    <td className="mono tiny">{p.code}</td>
                    <td>
                      <span className="ellipsis" title={p.name}>{p.name}</span>{" "}
                    </td>
                    <td>
                      <span className="inline-person">
                        <Avatar name={ownerText(p)} size={22} />{ownerText(p)}
                      </span>
                    </td>
                    <td className="muted"><span className="ellipsis" title={p.client}>{p.client || "-"}</span></td>
                    <td><Badge status={p.contract_status || "未登记"} tone={p.contract_status === "已签订" ? "done" : "todo"} /></td>
                    <td className="num">{fmtMoney(p.budget_total)}</td>
                    <td className="num">{p.progress ?? 0}%</td>
                    <td><Badge status={projectStatusLabel(p.status)} tone={projectTone(p.status)} /></td>
                    <td className="no-print">
                      <span className="table-actions">
                        <button
                          className="btn-ghost btn-xs"
                          onClick={(e) => { e.stopPropagation(); setEditing(p); setFormOpen(true); }}
                        >
                          编辑
                        </button>
                        {isAdmin && !["doing", "filed"].includes(p.status) && (
                          <button
                            className="btn-ghost btn-xs btn-danger-outline"
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
          </DesktopTable>
          <Pagination
            page={page}
            size={size}
            total={total}
            loading={loading}
            sizeOptions={SIZE_OPTIONS}
            scopeText={scopeText}
            ariaLabel="项目台账分页"
            onChange={(next) =>
              setUrl(
                { page: String(next.page), size: String(next.size) },
                { history: next.page === page ? "replace" : "push" },
              )
            }
          />
        </MotionReveal>
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
          reload();
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
              <Link className="btn-primary" href={`/projects/${detail.id}`}>
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
              <div><dt>项目负责人</dt><dd>{ownerText(detail)}</dd></div>
              <div><dt>客户 / 委托方</dt><dd>{detail.client || "-"}</dd></div>
              <div><dt>合同状态</dt><dd>{detail.contract_status || "-"}</dd></div>
              <div><dt>前向合同（甲方）</dt><dd>{detail.forward_contract || "-"}</dd></div>
              <div><dt>后向合同（乙方）</dt><dd>{detail.backward_contract || "-"}</dd></div>
              <div><dt>合同金额</dt><dd className="mono">{fmtMoney(detail.budget_total)} 元</dd></div>
              <div><dt>客户联系人</dt><dd>{detail.client_contact || "-"}</dd></div>
              <div><dt>联系方式</dt><dd>{detail.client_phone || "-"}</dd></div>
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

      {/* 危险流转二次确认 */}
      <Confirm
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
            reload();
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
