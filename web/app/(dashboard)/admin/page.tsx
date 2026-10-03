"use client";

import { Suspense, useState } from "react";
import {
  adminApi, buildQuery, errText, projectsApi, unwrapPaged,
  type AdminUser, type AuditLog, type DictItem, type ModuleItem, type RecycleBinItem,
} from "@/lib/api";
import { useAsyncData } from "@/lib/useAsyncData";
import { urlInt, useUrlState, useUrlText } from "@/lib/useUrlState";
import { useMeta, useMenus } from "@/lib/useMeta";
import { fmtDateTime, projectStatusLabel } from "@/lib/labels";
import Badge from "@/components/ui/Badge";
import Empty from "@/components/ui/Empty";
import Pagination from "@/components/ui/Pagination";
import { LoadingBlock, LoadFailed, NoAccess } from "@/components/ui/PageState";
import { Confirm, Drawer } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import PageHeader from "@/components/ui/PageHeader";
import { CardItem, CardList, DesktopTable } from "@/components/ui/CardList";
import MotionTabs from "@/components/motion/MotionTabs";
import { useActivity } from "@/lib/useActivity";
import {
  auditActionLabel,
  auditDetailLabel,
  auditResourceDisplay,
} from "@/lib/auditLogLabels";
import DictDialog from "./DictDialog";
import ParamDialog, { PARAM_LABELS } from "./ParamDialog";
import UserDialog from "./UserDialog";

const TABS = ["用户", "字典", "参数", "日志", "回收站"] as const;
type Tab = (typeof TABS)[number];

// 当前页签 / 日志筛选与分页 / 用户分页写入 URL（BLF-1095）
const URL_DEFAULTS = {
  tab: "用户",
  logq: "",
  logpage: "1",
  logsize: "20",
  upage: "1",
  usize: "20",
  binpage: "1",
  binsize: "20",
};

export default function AdminPage() {
  // 系统管理不是可分配模块，只对后端确认的超级管理员身份开放。
  const { isSuperAdmin, loading: permsLoading, error: permsError, reload } = useMenus();
  const canManage = isSuperAdmin;

  if (permsLoading) return <LoadingBlock kpis={0} />;
  if (permsError) return <LoadFailed message={permsError} onRetry={reload} />;
  if (!canManage) {
    return (
      <div>
        <NoAccess
          title="仅限超级管理员"
          hint={
            <>
              当前账号不是超级管理员，无法查看用户、字典、参数、审计日志与回收站。
              <br />
              需要调整权限或恢复项目时，请联系超级管理员。
            </>
          }
        />
      </div>
    );
  }
  return (
    <Suspense
      fallback={
        <div>
          <div className="skel skel-title" />
          <LoadingBlock kpis={0} label="加载管理数据…" />
        </div>
      }
    >
      <AdminInner />
    </Suspense>
  );
}

function AdminInner() {
  const { deptName } = useMeta();
  const toast = useToast();
  const { beginActivity } = useActivity();
  const [url, setUrl] = useUrlState(URL_DEFAULTS, { pageKey: false });
  const tab: Tab = (TABS.find((t) => t === url.tab) ?? "用户") as Tab;
  const userPage = urlInt(url.upage, 1);
  const userSize = urlInt(url.usize, 20, { max: 100 });
  const logPage = urlInt(url.logpage, 1);
  const logSize = urlInt(url.logsize, 20, { max: 100 });
  const binPage = urlInt(url.binpage, 1);
  const binSize = urlInt(url.binsize, 20, { max: 100 });
  const [logDraft, setLogDraft] = useUrlText(url.logq, (next) =>
    setUrl({ logq: next, logpage: "1" }),
  );

  const [busy, setBusy] = useState(false);
  const [logDetail, setLogDetail] = useState<AuditLog | null>(null);

  // 每个页签独立取数：切页签才会请求对应接口
  const users = useAsyncData(
    (signal) => adminApi.users(userPage, userSize, signal),
    [userPage, userSize],
    { enabled: tab === "用户", resetOnDepChange: true },
  );
  // 功能模块目录（Stage 5）：用户弹窗按它渲染可分配模块并回填勾选
  const modules = useAsyncData(
    (signal) => adminApi.modules(signal),
    [],
    { enabled: tab === "用户" },
  );
  const dicts = useAsyncData(
    (signal) => adminApi.dicts("", signal),
    [],
    { enabled: tab === "字典" },
  );
  const params = useAsyncData((signal) => adminApi.params(signal), [], { enabled: tab === "参数" });
  const logs = useAsyncData(
    (signal) =>
      adminApi.logs(
        buildQuery({ page: logPage, size: logSize, action: url.logq.trim() }),
        signal,
      ),
    [logPage, logSize, url.logq],
    { enabled: tab === "日志", resetOnDepChange: true },
  );
  // 回收站：Stage 3A 起一律回分页信封，默认按删除时间倒序
  const bin = useAsyncData(
    (signal) =>
      projectsApi.recycleBin(
        buildQuery({ page: binPage, size: binSize, sort: "-deleted_at" }),
        signal,
      ),
    [binPage, binSize],
    { enabled: tab === "回收站", resetOnDepChange: true },
  );
  const binPageData = unwrapPaged<RecycleBinItem>(bin.data);
  const binItems: RecycleBinItem[] = binPageData.items;
  const binTotal = binPageData.total;

  const userItems: AdminUser[] = users.data?.items ?? [];
  const moduleItems: ModuleItem[] = modules.data ?? [];
  const moduleLabel = new Map(moduleItems.map((m) => [m.key, m.label]));
  const dictItems: DictItem[] = dicts.data ?? [];
  const paramItems = params.data ?? {};
  const logItems: AuditLog[] = logs.data?.items ?? [];

  const active = { 用户: users, 字典: dicts, 参数: params, 日志: logs, 回收站: bin }[tab];

  const [userOpen, setUserOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<AdminUser | null>(null);
  const [dictOpen, setDictOpen] = useState(false);
  const [paramEdit, setParamEdit] = useState<{ key: string; value: string } | null>(null);
  const [confirm, setConfirm] = useState<{ title: string; text?: string; danger?: boolean; run: () => Promise<void> } | null>(null);

  function toggleUser(u: AdminUser) {
    setConfirm({
      title: u.status === "active" ? `停用用户「${u.username}」？` : `启用用户「${u.username}」？`,
      danger: u.status === "active",
      text: u.status === "active" ? "停用后该账号无法登录，已登录会话不受影响。" : "启用后该账号可正常登录。",
      run: async () => {
        await adminApi.updateUser(u.id, { status: u.status === "active" ? "disabled" : "active" });
        toast.ok("用户状态已更新");
        users.reload();
      },
    });
  }

  function userActions(u: AdminUser) {
    return <>
      <button className="btn-ghost btn-xs" onClick={() => { setEditingUser(u); setUserOpen(true); }}>编辑</button>
      {!u.is_super_admin && (
        <button className={`btn-ghost btn-xs ${u.status === "active" ? "btn-danger-outline" : ""}`} onClick={() => toggleUser(u)}>
          {u.status === "active" ? "停用" : "启用"}
        </button>
      )}
    </>;
  }

  function restoreProject(p: RecycleBinItem) {
    setConfirm({
      title: `恢复项目「${p.name}」？`,
      text: "恢复后项目重新出现在台账列表。",
      run: async () => {
        await projectsApi.restore(p.id);
        toast.ok("项目已恢复");
        bin.reload();
      },
    });
  }

  // 主操作随页签变化；没有主操作的页签（参数 / 日志 / 回收站）不传，
  // 避免又留一条空白操作行（BLF-1140）
  const pageActions =
    tab === "用户" ? (
      <button className="btn-primary" onClick={() => { setEditingUser(null); setUserOpen(true); }}>
        + 新增用户
      </button>
    ) : tab === "字典" ? (
      <button className="btn-primary" onClick={() => setDictOpen(true)}>+ 字典项</button>
    ) : null;

  return (
    <div>
      <PageHeader title="系统管理" actions={pageActions} />

      {active.error && <LoadFailed message={active.error} onRetry={active.reload} />}

      <MotionTabs
        items={TABS.map((item) => ({ id: item, label: item }))}
        active={tab}
        onChange={(next) => setUrl({ tab: next }, { history: "push" })}
      >

      {tab === "用户" && (
        users.firstLoad ? (
          <LoadingBlock kpis={0} label="加载用户…" />
        ) : userItems.length === 0 ? (
          <div className="card"><Empty title="暂无用户" hint="新增用户后可分配功能模块。" /></div>
        ) : (
          <>
            <CardList label="系统用户">
              {userItems.map((u) => (
                <CardItem
                  key={u.id}
                  title={u.real_name || u.username}
                  code={u.username}
                  badges={<Badge status={u.status === "active" ? "启用" : u.status === "locked" ? "锁定" : "停用"} tone={u.status === "active" ? "done" : u.status === "locked" ? "warn" : "paused"} />}
                  fields={[
                    { label: "部门", value: deptName(u.dept_id) },
                    { label: "身份", value: u.is_super_admin ? <Badge status="超级管理员" /> : "普通用户" },
                    { label: "模块", value: u.modules.length === 0 ? "-" : u.modules.map((k) => moduleLabel.get(k) ?? k).join(" / ") },
                  ]}
                  onSelect={() => { setEditingUser(u); setUserOpen(true); }}
                  actions={userActions(u)}
                />
              ))}
            </CardList>
            <DesktopTable>
              <table className="grid" aria-busy={users.loading}>
                <thead><tr><th>手机号</th><th>姓名</th><th>部门</th><th>身份</th><th>模块</th><th>状态</th><th className="no-print" /></tr></thead>
                <tbody>
                  {userItems.map((u) => (
                    <tr key={u.id} className="clickable-row" onClick={() => { setEditingUser(u); setUserOpen(true); }}>
                      <td className="mono tiny">{u.username}</td>
                      <td>{u.real_name}</td>
                      <td className="muted">{deptName(u.dept_id)}</td>
                      <td>{u.is_super_admin ? <Badge status="超级管理员" /> : "普通用户"}</td>
                      <td className="muted tiny">{u.modules.length === 0 ? "-" : u.modules.map((k) => moduleLabel.get(k) ?? k).join(" / ")}</td>
                      <td>
                        <Badge
                          status={u.status === "active" ? "启用" : u.status === "locked" ? "锁定" : "停用"}
                          tone={u.status === "active" ? "done" : u.status === "locked" ? "warn" : "paused"}
                        />
                      </td>
                      <td className="no-print" onClick={(e) => e.stopPropagation()}><span className="table-actions">{userActions(u)}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </DesktopTable>
            <Pagination
              page={userPage}
              size={userSize}
              total={users.data?.total ?? userItems.length}
              loading={users.loading}
              ariaLabel="用户列表分页"
              onChange={(next) => setUrl({ upage: String(next.page), usize: String(next.size) })}
            />
          </>
        )
      )}

      {tab === "字典" && (
        dicts.firstLoad ? (
          <LoadingBlock kpis={0} label="加载字典…" />
        ) : dictItems.length === 0 ? (
          <div className="card"><Empty title="暂无字典" hint="系统枚举可在此维护。" /></div>
        ) : (
          <div className="table-scroll">
            <table className="grid">
              <thead><tr><th>类型</th><th>编码</th><th>显示名</th></tr></thead>
              <tbody>
                {dictItems.map((d, i) => (
                  <tr key={`${d.type}-${d.code}-${i}`}>
                    <td className="mono tiny">{d.type}</td>
                    <td className="mono tiny">{d.code}</td>
                    <td>{d.label}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}

      {tab === "参数" && (
        params.firstLoad ? (
          <LoadingBlock kpis={0} label="加载参数…" />
        ) : (
          <>
          <CardList label="系统参数">
            {Object.entries(paramItems).map(([k, v]) => (
              <CardItem
                key={k}
                title={PARAM_LABELS[k] ?? k}
                code={k}
                fields={[
                  { label: "当前值", value: v, mono: true },
                  { label: "说明", value: k === "expense_approval_on" ? "1=支出需审批" : k === "budget_approval_on" ? "1=预算调整需审批" : "-" },
                ]}
                actions={<button className="btn-ghost btn-xs" onClick={() => setParamEdit({ key: k, value: v })}>编辑</button>}
              />
            ))}
          </CardList>
          <DesktopTable>
            <table className="grid">
              <thead><tr><th>参数</th><th>当前值</th><th>说明</th><th className="no-print" /></tr></thead>
              <tbody>
                {Object.entries(paramItems).map(([k, v]) => (
                  <tr key={k}>
                    <td>{PARAM_LABELS[k] ?? k}<div className="tiny mono">{k}</div></td>
                    <td className="mono">{v}</td>
                    <td className="muted tiny">{k === "expense_approval_on" ? "1=支出需审批" : k === "budget_approval_on" ? "1=预算调整需审批" : ""}</td>
                    <td className="no-print">
                      <button className="btn-ghost btn-xs"
                        onClick={() => setParamEdit({ key: k, value: v })}>
                        编辑
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </DesktopTable>
          </>
        )
      )}

      {tab === "日志" && (
        <>
          <div className="toolbar-card no-print" style={{ display: "flex", flexWrap: "wrap" }}>
            <label className="toolbar-field grow">
              <span>按动作筛选</span>
              <input style={{ width: 240, maxWidth: "100%" }} value={logDraft} onChange={(e) => setLogDraft(e.target.value)} placeholder="如 login / create_project" aria-label="按动作筛选日志" />
            </label>
          </div>
          {logs.firstLoad ? (
            <LoadingBlock kpis={0} label="加载审计日志…" />
          ) : logItems.length === 0 ? (
            <div className="card">
              <Empty
                title={url.logq ? "没有匹配的日志" : "暂无日志"}
                hint={url.logq ? "换个动作关键词，或清空筛选。" : "登录、数据变更、审批等关键操作会自动记录。"}
              />
            </div>
          ) : (
            <>
              <CardList label="审计日志">
                {logItems.map((l) => (
                  <CardItem
                    key={l.id}
                    title={auditActionLabel(l.action, l.resource)}
                    code={fmtDateTime(l.created_at)}
                    fields={[
                      { label: "操作人", value: l.operator_name },
                      { label: "对象", value: auditResourceDisplay(l.resource, l.resource_id) },
                      { label: "详情", value: auditDetailLabel(l.action, l.resource, l.detail) },
                      { label: "IP", value: l.ip || "-", mono: true },
                    ]}
                    onSelect={() => setLogDetail(l)}
                  />
                ))}
              </CardList>
              <DesktopTable>
                <table className="grid" aria-busy={logs.loading}>
                  <thead><tr><th>时间</th><th>操作人</th><th>动作</th><th>对象</th><th>详情</th><th>IP</th></tr></thead>
                  <tbody>
                    {logItems.map((l) => (
                      <tr key={l.id} className="clickable-row" onClick={() => setLogDetail(l)}>
                        <td className="mono tiny">{fmtDateTime(l.created_at)}</td>
                        <td>{l.operator_name}</td>
                        <td className="tiny">{auditActionLabel(l.action, l.resource)}</td>
                        <td className="tiny">{auditResourceDisplay(l.resource, l.resource_id)}</td>
                        <td>
                          <span
                            className="ellipsis"
                            title={auditDetailLabel(l.action, l.resource, l.detail)}
                          >
                            {auditDetailLabel(l.action, l.resource, l.detail)}
                          </span>
                        </td>
                        <td className="mono tiny">{l.ip || "-"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </DesktopTable>
              <Pagination
                page={logPage}
                size={logSize}
                total={logs.data?.total ?? logItems.length}
                loading={logs.loading}
                scopeText={url.logq ? `动作含「${url.logq}」` : undefined}
                ariaLabel="审计日志分页"
                onChange={(next) => setUrl({ logpage: String(next.page), logsize: String(next.size) })}
              />
            </>
          )}
        </>
      )}

      {tab === "回收站" && (
        bin.firstLoad ? (
          <LoadingBlock kpis={0} label="加载回收站…" />
        ) : binItems.length === 0 ? (
          <div className="card"><Empty title="回收站为空" hint="删除的项目会进入这里，可恢复。" /></div>
        ) : (
          <>
          <CardList label="项目回收站">
            {binItems.map((p) => (
              <CardItem
                key={p.id}
                title={p.name}
                code={p.code}
                fields={[
                  { label: "原状态", value: projectStatusLabel(p.status) },
                  { label: "删除时间", value: fmtDateTime(p.deleted_at), mono: true },
                ]}
                actions={<button className="btn-ghost btn-xs" onClick={() => restoreProject(p)}>恢复项目</button>}
              />
            ))}
          </CardList>
          <DesktopTable>
            <table className="grid" aria-busy={bin.loading}>
              <thead><tr><th>编号</th><th>名称</th><th>原状态</th><th>删除时间</th><th className="no-print" /></tr></thead>
              <tbody>
                {binItems.map((p) => (
                  <tr key={p.id}>
                    <td className="mono tiny">{p.code}</td>
                    <td><span className="ellipsis" title={p.name}>{p.name}</span></td>
                    <td>{projectStatusLabel(p.status)}</td>
                    <td className="mono tiny">{fmtDateTime(p.deleted_at)}</td>
                    <td className="no-print">
                      <button className="btn-ghost btn-xs" onClick={() => restoreProject(p)}>
                        恢复
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </DesktopTable>
          <Pagination
            page={binPage}
            size={binSize}
            total={binTotal}
            loading={bin.loading}
            ariaLabel="回收站分页"
            onChange={(next) => setUrl({ binpage: String(next.page), binsize: String(next.size) })}
          />
          </>
        )
      )}
      </MotionTabs>

      <UserDialog
        open={userOpen}
        onClose={() => setUserOpen(false)}
        user={editingUser}
        modules={moduleItems}
        onSaved={(isNew) => { toast.ok(isNew ? "用户已创建" : "用户已保存"); users.reload(); }}
      />

      <DictDialog open={dictOpen} onClose={() => setDictOpen(false)} onSaved={() => { toast.ok("字典项已新增"); dicts.reload(); }} />

      <ParamDialog
        open={!!paramEdit}
        onClose={() => setParamEdit(null)}
        paramKey={paramEdit?.key ?? ""}
        value={paramEdit?.value ?? ""}
        onSaved={() => { toast.ok("系统参数已保存，立即生效"); params.reload(); }}
      />

      <Drawer
        open={!!logDetail}
        onClose={() => setLogDetail(null)}
        width={460}
        title="审计日志详情"
      >
        {logDetail && (
          <dl className="kv one">
            <div><dt>时间</dt><dd className="mono">{fmtDateTime(logDetail.created_at)}</dd></div>
            <div><dt>操作人</dt><dd>{logDetail.operator_name}</dd></div>
            <div><dt>动作</dt><dd>{auditActionLabel(logDetail.action, logDetail.resource)}</dd></div>
            <div><dt>资源</dt><dd>{auditResourceDisplay(logDetail.resource, logDetail.resource_id)}</dd></div>
            <div><dt>IP</dt><dd className="mono">{logDetail.ip || "-"}</dd></div>
            <div><dt>详情</dt><dd>{auditDetailLabel(logDetail.action, logDetail.resource, logDetail.detail)}</dd></div>
          </dl>
        )}
      </Drawer>

      <Confirm
        open={!!confirm}
        danger={confirm?.danger}
        loading={busy}
        title={confirm?.title ?? ""}
        text={confirm?.text}
        okText="确认"
        onConfirm={async () => {
          if (!confirm) return;
          const finish = beginActivity({ label: "更新系统配置", scope: "form" });
          setBusy(true);
          try {
            await confirm.run();
          } catch (e) {
            toast.err(errText(e));
          } finally {
            setBusy(false);
            setConfirm(null);
            finish();
          }
        }}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}
