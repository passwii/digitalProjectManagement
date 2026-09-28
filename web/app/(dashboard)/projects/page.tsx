"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { errText, projectsApi, type Project } from "@/lib/api";
import { useAsyncData } from "@/lib/useAsyncData";
import { urlInt, useUrlState, useUrlText } from "@/lib/useUrlState";
import {
  buildYearOptions,
  parseYearParam,
  yearToCodeFilter,
} from "@/lib/projectYear";
import { buildProjectListQuery } from "@/lib/projectFilters";
import { removeRecentProject } from "@/lib/recentProjects";
import { useMeta, useMenus } from "@/lib/useMeta";
import {
  CONTRACT_STATUS,
  PROJECT_FLOW,
  PROJECT_OWNERS,
  PROJECT_STATUS,
  fmtMoney,
  contractStatusLabel,
  projectStatusLabel,
  projectTone,
} from "@/lib/labels";
import Badge from "@/components/ui/Badge";
import Avatar from "@/components/ui/Avatar";
import Empty from "@/components/ui/Empty";
import Pagination from "@/components/ui/Pagination";
import { LoadingBlock, LoadFailed } from "@/components/ui/PageState";
import { Confirm, Drawer } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import { ListPageLayout } from "@/components/ui/ListPageLayout";
import PageHeader from "@/components/ui/PageHeader";
import MotionReveal from "@/components/motion/MotionReveal";
import ProjectFormDialog from "./ProjectFormDialog";
import { ProjectDeleteDialogs } from "./ProjectDeleteDialogs";
import { ProjectsListContent } from "./ProjectsListContent";

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

// 项目编号倒序：按业务编号而非数据库主键排列
const DEFAULT_SORT = "-code";

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
  const { userName } = useMeta();
  // 删除（软删除）与解归档仅管理员：显示条件取后端菜单契约
  const { isAdmin, demoOn } = useMenus();
  const toast = useToast();

  const [url, setUrl] = useUrlState(URL_DEFAULTS, { pageKey: "page" });
  const page = urlInt(url.page, 1);
  const size = SIZE_OPTIONS.includes(Number(url.size))
    ? Number(url.size)
    : SIZE_OPTIONS[0];
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

  // 负责人筛选项：取台账实际出现的姓名（服务端有界）。接口不可用（后端未升级/暂时失败）时
  // 退回建档负责人名单，保证下拉不空 —— 两者都是姓名口径，`?owner=` 过滤照常生效。
  const { data: ownerRows, reload: reloadOwners } = useAsyncData(
    (signal) => projectsApi.owners(signal),
    [],
  );
  const ownerOptions = ownerRows ?? PROJECT_OWNERS.map((name) => ({ name, count: 0 }));

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Project | null>(null);
  const [detail, setDetail] = useState<Project | null>(null);
  const [confirmFlow, setConfirmFlow] = useState<{
    p: Project;
    to: string;
  } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Project | null>(null);
  // 软删除两步确认：1 = 说明影响；2 = 最终确认后才真正执行
  const [deleteStep, setDeleteStep] = useState<1 | 2 | null>(null);
  const [busy, setBusy] = useState(false);

  const statusOptions = Object.entries(PROJECT_STATUS).map(([code, label]) => ({
    code,
    label,
  }));
  const DESTRUCTIVE = new Set(["cancelled", "archived", "done"]);
  const hasFilter = !!(url.q || url.status || url.owner || year);
  const scopeText = [
    url.q ? `关键词「${url.q}」` : "",
    url.status ? `状态=${PROJECT_STATUS[url.status] ?? url.status}` : "",
    url.owner ? `负责人=${url.owner}` : "",
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

  /** 打开软删除流程（列表行 / 详情抽屉 / 编辑弹窗三个入口共用）：从第一步确认开始 */
  function requestDelete(p: Project) {
    setDeleteTarget(p);
    setDeleteStep(1);
  }

  function closeDelete() {
    setDeleteTarget(null);
    setDeleteStep(null);
  }

  /** 第二步确认后真正执行软删除；成功后刷新列表并清理「最近项目」缓存 */
  async function confirmDelete() {
    if (!deleteTarget) return;
    setBusy(true);
    try {
      await projectsApi.remove(deleteTarget.id);
      removeRecentProject(deleteTarget.id);
      toast.ok("项目已移入回收站（系统管理 → 回收站可恢复）");
      reload();
    } catch (e) {
      toast.err(errText(e));
    } finally {
      setBusy(false);
      closeDelete();
    }
  }

  const toolbar = (
    <PageHeader
      title="项目台账"
      filters={
        <>
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
            {statusOptions.map((s) => (
              <option key={s.code} value={s.code}>
                {s.label}
              </option>
            ))}
          </select>
          <select
            value={url.owner}
            onChange={(e) => setUrl({ owner: e.target.value })}
            aria-label="按负责人筛选"
            title="按负责人姓名筛选（与列表里显示的负责人一致）"
          >
            <option value="">全部负责人</option>
            {/* URL 里的历史值（如旧链接的账号 id）不在选项里时也要显示出来，避免“静默丢失筛选” */}
            {url.owner && !ownerOptions.some((o) => o.name === url.owner) && (
              <option value={url.owner}>{url.owner}（当前筛选）</option>
            )}
            {ownerOptions.map((o) => (
              <option key={o.name} value={o.name}>
                {o.count > 0 ? `${o.name}（${o.count}）` : o.name}
              </option>
            ))}
          </select>
          <select
            value={year}
            onChange={(e) => setUrl({ year: e.target.value })}
            aria-label="按年度筛选"
          >
            <option value="">全部年份</option>
            {yearOptions.map((y) => (
              <option key={y} value={y}>
                {y}年
              </option>
            ))}
          </select>
          {hasFilter && (
            <button
              type="button"
              className="btn-ghost"
              style={{ height: 32, lineHeight: "30px", width: "auto" }}
              onClick={() =>
                setUrl({ q: "", status: "", owner: "", year: "" })
              }
            >
              清除筛选
            </button>
          )}
        </>
      }
      actions={
        <button
          className="btn-primary"
          title="创建一个新的项目档案"
          onClick={() => {
            setEditing(null);
            setFormOpen(true);
          }}
        >
          + 新建项目
        </button>
      }
    />
  );

  const notice = demoOn ? (
    <MotionReveal>
      <div
        className="warn-banner"
        style={{
          background: "var(--brand-soft)",
          borderColor: "var(--line-blue)",
          color: "var(--brand)",
        }}
      >
        当前正在显示<b>演示数据</b>
        （工作台与报表统计同样包含），关闭开关即可全站隐藏。
      </div>
    </MotionReveal>
  ) : undefined;

  return (
    <ListPageLayout toolbar={toolbar} notice={notice}>

      {error && <LoadFailed message={error} onRetry={reload} />}

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
        <ProjectsListContent
          items={items}
          page={page}
          size={size}
          total={total}
          loading={loading}
          scopeText={scopeText}
          onPageChange={(next) =>
            setUrl(
              { page: String(next.page), size: String(next.size) },
              { history: next.page === page ? "replace" : "push" },
            )
          }
          onSelect={setDetail}
          onEdit={(project) => {
            setEditing(project);
            setFormOpen(true);
          }}
          canDelete={isAdmin}
          onDelete={requestDelete}
          ownerText={ownerText}
        />
      )}

      {/* 新建 / 编辑弹窗 */}
      <ProjectFormDialog
        open={formOpen}
        onClose={() => setFormOpen(false)}
        project={editing}
        onRequestDelete={
          editing && isAdmin
            ? () => {
                setFormOpen(false);
                requestDelete(editing);
              }
            : undefined
        }
        onSaved={(saved, isNew) => {
          toast.ok(
            isNew
              ? `项目已创建：${saved.code}`
              : "项目信息已保存（变更已留痕）",
          );
          setFormOpen(false);
          setDetail((d) => (d && d.id === saved.id ? saved : d));
          reload();
          reloadOwners(); // 负责人可能变了：同步刷新筛选项与计数
        }}
      />

      {/* 行详情抽屉 */}
      <Drawer
        open={!!detail}
        onClose={() => setDetail(null)}
        width={520}
        title={
          detail ? (
            <span
              className="ellipsis"
              style={{ maxWidth: 340, display: "inline-block" }}
              title={detail.name}
            >
              {detail.name}
            </span>
          ) : (
            ""
          )
        }
        footer={
          detail && (
            <>
              <button
                className="btn-ghost"
                onClick={() => {
                  setEditing(detail);
                  setFormOpen(true);
                }}
              >
                编辑
              </button>
              {isAdmin && (
                <button
                  className="btn-ghost danger-link"
                  onClick={() => {
                    requestDelete(detail);
                    setDetail(null);
                  }}
                >
                  删除项目
                </button>
              )}
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
              <div>
                <dt>项目编号</dt>
                <dd className="mono">{detail.code}</dd>
              </div>
              <div>
                <dt>项目负责人</dt>
                <dd>{ownerText(detail)}</dd>
              </div>
              <div>
                <dt>客户 / 委托方</dt>
                <dd>{detail.client || "-"}</dd>
              </div>
              <div>
                <dt>合同状态</dt>
                <dd>
                  {detail.contract_status
                    ? contractStatusLabel(detail.contract_status)
                    : "-"}
                </dd>
              </div>
              <div>
                <dt>合同金额</dt>
                <dd className="mono">{fmtMoney(detail.budget_total)} 元</dd>
              </div>
              <div>
                <dt>客户联系人</dt>
                <dd>{detail.client_contact || "-"}</dd>
              </div>
              <div>
                <dt>联系方式</dt>
                <dd>{detail.client_phone || "-"}</dd>
              </div>
              <div>
                <dt>项目简介</dt>
                <dd>{detail.description || "-"}</dd>
              </div>
            </dl>

            {(() => {
              // 解归档（archived → doing）仅管理员可操作，非管理员不展示必然 403 的按钮
              const flow = (PROJECT_FLOW[detail.status] ?? []).filter(
                (to) =>
                  !(detail.status === "archived" && to === "doing" && !isAdmin),
              );
              if (flow.length === 0) {
                return detail.status === "archived" && !isAdmin ? (
                  <div
                    className="muted"
                    style={{ fontSize: 12, marginTop: 16 }}
                  >
                    项目已归档且为只读，解除归档需管理员操作。
                  </div>
                ) : null;
              }
              return (
                <div style={{ marginTop: 16 }}>
                  <div
                    className="muted"
                    style={{ fontSize: 12, marginBottom: 8 }}
                  >
                    状态流转（操作留痕）
                  </div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {flow.map((to) =>
                      DESTRUCTIVE.has(to) ? (
                        <button
                          key={to}
                          className="btn-ghost"
                          onClick={() => setConfirmFlow({ p: detail, to })}
                        >
                          → {projectStatusLabel(to)}
                        </button>
                      ) : (
                        <button
                          key={to}
                          className="btn-ghost"
                          disabled={busy}
                          onClick={() => changeStatus(detail, to)}
                        >
                          → {projectStatusLabel(to)}
                        </button>
                      ),
                    )}
                  </div>
                  {detail.status === "archived" && !isAdmin && (
                    <div
                      className="muted"
                      style={{ fontSize: 12, marginTop: 8 }}
                    >
                      解除归档需管理员操作。
                    </div>
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
              项目 <b>{confirmFlow.p.name}</b>（
              <span className="mono">{confirmFlow.p.code}</span>）
              {confirmFlow.to === "archived"
                ? " 将归档为只读，需管理员才能解除归档。"
                : confirmFlow.to === "cancelled"
                  ? " 取消后不可再流转（终态）。"
                  : " 完成后可归档。"}
            </>
          )
        }
        okText="确认流转"
        onConfirm={() =>
          confirmFlow && changeStatus(confirmFlow.p, confirmFlow.to)
        }
        onCancel={() => setConfirmFlow(null)}
      />

      {/* 软删除两步确认：第一步说明影响，第二步最终确认后执行 */}
      <ProjectDeleteDialogs
        target={deleteTarget}
        step={deleteStep}
        busy={busy}
        onNextStep={() => setDeleteStep(2)}
        onConfirm={confirmDelete}
        onCancel={closeDelete}
      />
    </ListPageLayout>
  );
}
