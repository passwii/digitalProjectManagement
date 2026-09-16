"use client";

import { useCallback, useEffect, useState } from "react";
import {
  adminApi, errText, projectsApi,
  type AdminUser, type AuditLog, type DictItem,
} from "@/lib/api";
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
const LOG_SIZE = 20;

interface BinItem {
  id: number;
  code: string;
  name: string;
  status: string;
  deleted_at: string | null;
}

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
  return <AdminInner />;
}

function AdminInner() {
  const { deptName } = useMeta();
  const toast = useToast();

  const [tab, setTab] = useState<Tab>("用户");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  const [users, setUsers] = useState<AdminUser[]>([]);
  const [roles, setRoles] = useState<{ id: number; code: string; name: string }[]>([]);
  const [dicts, setDicts] = useState<DictItem[]>([]);
  const [params, setParams] = useState<Record<string, string>>({});
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [logTotal, setLogTotal] = useState(0);
  const [logPage, setLogPage] = useState(1);
  const [logAction, setLogAction] = useState("");
  const [logDetail, setLogDetail] = useState<AuditLog | null>(null);
  const [bin, setBin] = useState<BinItem[]>([]);

  const [userOpen, setUserOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<AdminUser | null>(null);
  const [dictOpen, setDictOpen] = useState(false);
  const [paramEdit, setParamEdit] = useState<{ key: string; value: string } | null>(null);
  const [confirm, setConfirm] = useState<{ title: string; text?: string; danger?: boolean; run: () => Promise<void> } | null>(null);

  const load = useCallback(async () => {
    setErr("");
    setLoading(true);
    try {
      if (tab === "用户") {
        const [u, r] = await Promise.all([adminApi.users(1, 100), adminApi.roles()]);
        setUsers(u.items ?? []);
        setRoles(r);
      } else if (tab === "角色") {
        setRoles(await adminApi.roles());
      } else if (tab === "字典") {
        setDicts(await adminApi.dicts());
      } else if (tab === "参数") {
        setParams(await adminApi.params());
      } else if (tab === "回收站") {
        setBin(await projectsApi.recycleBin());
      } else {
        const q = new URLSearchParams({ page: String(logPage), size: String(LOG_SIZE) });
        if (logAction.trim()) q.set("action", logAction.trim());
        const data = await adminApi.logs(`?${q.toString()}`);
        setLogs(data.items ?? []);
        setLogTotal(data.total ?? 0);
      }
    } catch (e) {
      setErr(errText(e));
    } finally {
      setLoading(false);
    }
  }, [tab, logPage, logAction]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => setLogPage(1), [logAction]);

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

      {err && <div className="err-banner">{err}</div>}

      <div className="tabs">
        {TABS.map((t) => <button key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>{t}</button>)}
      </div>

      {loading ? (
        <LoadingBlock kpis={0} label="加载管理数据…" />
      ) : (
        <>

      {tab === "用户" && (
        users.length === 0 ? (
          <div className="card"><Empty title="暂无用户" hint="新增用户后可分配角色。" /></div>
        ) : (
          <table className="grid">
            <thead><tr><th>账号</th><th>姓名</th><th>部门</th><th>角色</th><th>状态</th><th className="no-print" /></tr></thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} style={{ cursor: "pointer" }} onClick={() => { setEditingUser(u); setUserOpen(true); }}>
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
                              await load();
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
        )
      )}

      {tab === "角色" && (
        <table className="grid">
          <thead><tr><th>角色码</th><th>角色名称</th></tr></thead>
          <tbody>
            {roles.map((r) => <tr key={r.code}><td className="mono tiny">{r.code}</td><td>{r.name}</td></tr>)}
          </tbody>
        </table>
      )}

      {tab === "字典" && (
        dicts.length === 0 ? (
          <div className="card"><Empty title="暂无字典" hint="项目类型、优先级、科目等枚举可在此维护。" /></div>
        ) : (
          <table className="grid">
            <thead><tr><th>类型</th><th>编码</th><th>显示名</th></tr></thead>
            <tbody>
              {dicts.map((d, i) => (
                <tr key={`${d.type}-${d.code}-${i}`}>
                  <td className="mono tiny">{d.type}</td>
                  <td className="mono tiny">{d.code}</td>
                  <td>{d.label}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      )}

      {tab === "参数" && (
        <table className="grid">
          <thead><tr><th>参数</th><th>当前值</th><th>说明</th><th className="no-print" /></tr></thead>
          <tbody>
            {Object.entries(params).map(([k, v]) => (
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
      )}

      {tab === "日志" && (
        <>
          <div className="card no-print" style={{ marginBottom: 12, padding: "10px 16px" }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8, margin: 0 }}>
              <span className="muted" style={{ fontSize: 13 }}>按动作筛选</span>
              <input style={{ width: 240 }} value={logAction} onChange={(e) => setLogAction(e.target.value)} placeholder="如 login / create_project" />
            </label>
          </div>
          {logs.length === 0 ? (
            <div className="card"><Empty title="暂无日志" hint="登录、数据变更、审批等关键操作会自动记录。" /></div>
          ) : (
            <>
              <table className="grid">
                <thead><tr><th>时间</th><th>操作人</th><th>动作</th><th>对象</th><th>详情</th><th>IP</th></tr></thead>
                <tbody>
                  {logs.map((l) => (
                    <tr key={l.id} style={{ cursor: "pointer" }} onClick={() => setLogDetail(l)}>
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
              <Pagination page={logPage} size={LOG_SIZE} total={logTotal} onChange={setLogPage} />
            </>
          )}
        </>
      )}

      {tab === "回收站" && (
        bin.length === 0 ? (
          <div className="card"><Empty title="回收站为空" hint="删除的项目会进入这里，可恢复。" /></div>
        ) : (
          <table className="grid">
            <thead><tr><th>编号</th><th>名称</th><th>原状态</th><th>删除时间</th><th className="no-print" /></tr></thead>
            <tbody>
              {bin.map((p) => (
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
                            await load();
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
        )
      )}

        </>
      )}

      <UserDialog
        open={userOpen}
        onClose={() => setUserOpen(false)}
        user={editingUser}
        roles={roles}
        onSaved={(isNew) => { toast.ok(isNew ? "用户已创建" : "用户已保存"); load(); }}
      />

      <DictDialog open={dictOpen} onClose={() => setDictOpen(false)} onSaved={() => { toast.ok("字典项已新增"); load(); }} />

      <ParamDialog
        open={!!paramEdit}
        onClose={() => setParamEdit(null)}
        paramKey={paramEdit?.key ?? ""}
        value={paramEdit?.value ?? ""}
        onSaved={() => { toast.ok("系统参数已保存，立即生效"); load(); }}
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
