"use client";

import { Suspense, useState } from "react";
import {
  adminApi, buildQuery, errText, projectsApi, unwrapPaged,
  type AdminUser, type AuditLog, type DictItem, type RecycleBinItem,
} from "@/lib/api";
import { useAsyncData } from "@/lib/useAsyncData";
import { urlInt, useUrlState, useUrlText } from "@/lib/useUrlState";
import { useMeta, useMenus } from "@/lib/useMeta";
import { fmtDateTime } from "@/lib/labels";
import Badge from "@/components/ui/Badge";
import Empty from "@/components/ui/Empty";
import Pagination from "@/components/ui/Pagination";
import { LoadingBlock, LoadFailed, NoAccess } from "@/components/ui/PageState";
import { Confirm, Drawer } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import DictDialog from "./DictDialog";
import ParamDialog, { PARAM_LABELS } from "./ParamDialog";
import UserDialog from "./UserDialog";

const TABS = ["用户", "角色", "字典", "参数", "日志", "回收站"] as const;
type Tab = (typeof TABS)[number];

interface RoleItem {
  id: number;
  code: string;
  name: string;
}

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
  // 系统管理属于管理与审批面：非管理员不拉取数据（避免整页 403 报错），并给出明确说明
  const { isAdmin, loading: permsLoading, error: permsError, reload } = useMenus();

  if (permsLoading) return <LoadingBlock kpis={0} />;
  if (permsError) return <LoadFailed message={permsError} onRetry={reload} />;
  if (!isAdmin) {
    return (
      <div>
        <div className="page-head">
          <h1>系统管理<span className="sub">管理员全局管理</span></h1>
        </div>
        <NoAccess
          title="系统管理仅管理员可用"
          hint={
            <>
              当前账号不属于管理员，无法查看用户、角色、字典、参数、审计日志与回收站。
              <br />
              需要调整权限或恢复项目时，请联系管理员处理。
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
  const roles = useAsyncData(
    (signal) => adminApi.roles(signal),
    [],
    { enabled: tab === "用户" || tab === "角色" },
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
  const roleItems: RoleItem[] = roles.data ?? [];
  const dictItems: DictItem[] = dicts.data ?? [];
  const paramItems = params.data ?? {};
  const logItems: AuditLog[] = logs.data?.items ?? [];

  const active = { 用户: users, 角色: roles, 字典: dicts, 参数: params, 日志: logs, 回收站: bin }[tab];

  const [userOpen, setUserOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<AdminUser | null>(null);
  const [dictOpen, setDictOpen] = useState(false);
  const [paramEdit, setParamEdit] = useState<{ key: string; value: string } | null>(null);
  const [confirm, setConfirm] = useState<{ title: string; text?: string; danger?: boolean; run: () => Promise<void> } | null>(null);

  return (
    <div>
      <div className="page-head">
        <h1>系统管理<span className="sub">用户 / 角色 / 字典 / 参数 / 日志</span></h1>
        <div className="actions no-print">
          {tab === "用户" && (
            <button className="btn-primary" style={{ width: "auto" }} onClick={() => { setEditingUser(null); setUserOpen(true); }}>
              + 新增用户
            </button>
          )}
          {tab === "字典" && (
            <button className="btn-primary" style={{ width: "auto" }} onClick={() => setDictOpen(true)}>+ 字典项</button>
          )}
        </div>
      </div>

      {active.error && <LoadFailed message={active.error} onRetry={active.reload} />}

      <div className="tabs">
        {TABS.map((t) => (
          <button
            key={t}
            className={tab === t ? "active" : ""}
            aria-current={tab === t ? "page" : undefined}
            onClick={() => setUrl({ tab: t }, { history: "push" })}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === "用户" && (
        users.firstLoad ? (
          <LoadingBlock kpis={0} label="加载用户…" />
        ) : userItems.length === 0 ? (
          <div className="card"><Empty title="暂无用户" hint="新增用户后可分配角色。" /></div>
        ) : (
          <>
            <div className="table-scroll">
              <table className="grid" aria-busy={users.loading}>
                <thead><tr><th>手机号</th><th>姓名</th><th>部门</th><th>角色</th><th>状态</th><th className="no-print" /></tr></thead>
                <tbody>
                  {userItems.map((u) => (
                    <tr key={u.id} className="clickable-row" onClick={() => { setEditingUser(u); setUserOpen(true); }}>
                      <td className="mono tiny">{u.username}</td>
                      <td>{u.real_name}</td>
                      <td className="muted">{deptName(u.dept_id)}</td>
                      <td>{u.roles.map((r) => r.name).join(" / ") || "-"}</td>
                      <td>
                        <Badge
                          status={u.status === "active" ? "启用" : u.status === "locked" ? "锁定" : "停用"}
                          tone={u.status === "active" ? "done" : u.status === "locked" ? "warn" : "paused"}
                        />
                      </td>
                      <td className="no-print" onClick={(e) => e.stopPropagation()}>
                        <span style={{ display: "inline-flex", gap: 6 }}>
                          <button className="btn-ghost" style={{ height: 26, lineHeight: "24px", padding: "0 8px", fontSize: 12 }}
                            onClick={() => { setEditingUser(u); setUserOpen(true); }}>
                            编辑
                          </button>
                          <button
                            className="btn-ghost"
                            style={{ height: 26, lineHeight: "24px", padding: "0 8px", fontSize: 12, color: u.status === "active" ? "var(--danger)" : undefined, borderColor: u.status === "active" ? "var(--line-danger)" : undefined }}
                            onClick={() =>
                              setConfirm({
                                title: u.status === "active" ? `停用用户「${u.username}」？` : `启用用户「${u.username}」？`,
                                danger: u.status === "active",
                                text: u.status === "active" ? "停用后该账号无法登录，已登录会话不受影响。" : "启用后该账号可正常登录。",
                                run: async () => {
                                  await adminApi.updateUser(u.id, { status: u.status === "active" ? "disabled" : "active" });
                                  toast.ok("用户状态已更新");
                                  users.reload();
                                },
                              })
                            }
                          >
                            {u.status === "active" ? "停用" : "启用"}
                          </button>
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
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

      {tab === "角色" && (
        roles.firstLoad ? (
          <LoadingBlock kpis={0} label="加载角色…" />
        ) : (
          <div className="table-scroll">
            <table className="grid">
              <thead><tr><th>角色码</th><th>角色名称</th></tr></thead>
              <tbody>
                {roleItems.map((r) => <tr key={r.code}><td className="mono tiny">{r.code}</td><td>{r.name}</td></tr>)}
              </tbody>
            </table>
          </div>
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
          <div className="table-scroll">
            <table className="grid">
              <thead><tr><th>参数</th><th>当前值</th><th>说明</th><th className="no-print" /></tr></thead>
              <tbody>
                {Object.entries(paramItems).map(([k, v]) => (
                  <tr key={k}>
                    <td>{PARAM_LABELS[k] ?? k}<div className="tiny mono">{k}</div></td>
                    <td className="mono">{v}</td>
                    <td className="muted tiny">{k === "expense_approval_on" ? "1=支出需审批" : k === "budget_approval_on" ? "1=预算调整需审批" : ""}</td>
                    <td className="no-print">
                      <button className="btn-ghost" style={{ height: 26, lineHeight: "24px", padding: "0 8px", fontSize: 12 }}
                        onClick={() => setParamEdit({ key: k, value: v })}>
                        编辑
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}

      {tab === "日志" && (
        <>
          <div className="card no-print" style={{ marginBottom: 12, padding: "10px 16px" }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8, margin: 0, flexWrap: "wrap" }}>
              <span className="muted" style={{ fontSize: 13 }}>按动作筛选</span>
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
              <div className="table-scroll">
                <table className="grid" aria-busy={logs.loading}>
                  <thead><tr><th>时间</th><th>操作人</th><th>动作</th><th>对象</th><th>详情</th><th>IP</th></tr></thead>
                  <tbody>
                    {logItems.map((l) => (
                      <tr key={l.id} className="clickable-row" onClick={() => setLogDetail(l)}>
                        <td className="mono tiny">{fmtDateTime(l.created_at)}</td>
                        <td>用户#{l.user_id ?? "-"}</td>
                        <td className="mono tiny">{l.action}</td>
                        <td className="mono tiny">{l.resource}{l.resource_id ? `#${l.resource_id}` : ""}</td>
                        <td><span className="ellipsis" title={l.detail}>{l.detail || "-"}</span></td>
                        <td className="mono tiny">{l.ip || "-"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
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
          <div className="table-scroll">
            <table className="grid" aria-busy={bin.loading}>
              <thead><tr><th>编号</th><th>名称</th><th>原状态</th><th>删除时间</th><th className="no-print" /></tr></thead>
              <tbody>
                {binItems.map((p) => (
                  <tr key={p.id}>
                    <td className="mono tiny">{p.code}</td>
                    <td><span className="ellipsis" title={p.name}>{p.name}</span></td>
                    <td>{p.status}</td>
                    <td className="mono tiny">{fmtDateTime(p.deleted_at)}</td>
                    <td className="no-print">
                      <button
                        className="btn-ghost"
                        style={{ height: 26, lineHeight: "24px", padding: "0 8px", fontSize: 12 }}
                        onClick={() =>
                          setConfirm({
                            title: `恢复项目「${p.name}」？`,
                            text: "恢复后项目重新出现在台账列表。",
                            run: async () => {
                              await projectsApi.restore(p.id);
                              toast.ok("项目已恢复");
                              bin.reload();
                            },
                          })
                        }
                      >
                        恢复
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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

      <UserDialog
        open={userOpen}
        onClose={() => setUserOpen(false)}
        user={editingUser}
        roles={roleItems}
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
            <div><dt>操作人</dt><dd>用户#{logDetail.user_id ?? "-"}</dd></div>
            <div><dt>动作</dt><dd className="mono">{logDetail.action}</dd></div>
            <div><dt>资源</dt><dd className="mono">{logDetail.resource}{logDetail.resource_id ? `#${logDetail.resource_id}` : ""}</dd></div>
            <div><dt>IP</dt><dd className="mono">{logDetail.ip || "-"}</dd></div>
            <div><dt>详情</dt><dd>{logDetail.detail || "-"}</dd></div>
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
