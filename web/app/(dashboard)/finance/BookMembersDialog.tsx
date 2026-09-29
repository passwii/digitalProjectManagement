"use client";

import { useEffect, useMemo, useState } from "react";
import { Confirm, Dialog } from "@/components/ui/Modal";
import Empty from "@/components/ui/Empty";
import { LoadFailed, LoadingBlock } from "@/components/ui/PageState";
import { useToast } from "@/components/ui/Toast";
import Select from "@/components/ui/Select";
import {
  errText,
  financeApi,
  metaApi,
  type FinanceBook,
  type FinanceBookMember,
  type FinanceRole,
} from "@/lib/api";
import { useAsyncData } from "@/lib/useAsyncData";

const FINANCE_ROLE_OPTIONS: { value: FinanceRole; label: string; description: string }[] = [
  { value: "finance_clerk", label: "制单会计", description: "录入、编辑并提交凭证" },
  { value: "finance_reviewer", label: "审核会计", description: "审核、驳回并过账凭证" },
  { value: "cashier", label: "出纳", description: "处理收付款和银行对账" },
  { value: "finance_manager", label: "财务主管", description: "执行财务主管可用的审批、结账及高风险操作" },
  { value: "finance_auditor", label: "审计员", description: "只读查看财务数据" },
];

function roleLabel(role: string) {
  return FINANCE_ROLE_OPTIONS.find((item) => item.value === role)?.label ?? `未识别角色（${role}）`;
}

function isFinanceRole(role: string): role is FinanceRole {
  return FINANCE_ROLE_OPTIONS.some((item) => item.value === role);
}

type MemberChange = "granted" | "role_changed" | "removed";

export default function BookMembersDialog({
  open,
  book,
  onClose,
  onChanged,
}: {
  open: boolean;
  book: FinanceBook | null;
  onClose: () => void;
  onChanged: (change: MemberChange) => void;
}) {
  const toast = useToast();
  const [keyword, setKeyword] = useState("");
  const [debouncedKeyword, setDebouncedKeyword] = useState("");
  const [userPage, setUserPage] = useState(1);
  const [selectedUserId, setSelectedUserId] = useState<number | null>(null);
  const [newRole, setNewRole] = useState<FinanceRole>("finance_clerk");
  const [draftRoles, setDraftRoles] = useState<Record<number, string>>({});
  const [removingMember, setRemovingMember] = useState<FinanceBookMember | null>(null);
  const [busyKey, setBusyKey] = useState("");

  const members = useAsyncData(
    (signal) => financeApi.members(book?.id ?? 0, signal),
    [open, book?.id],
    { enabled: open && !!book, resetOnDepChange: true },
  );
  const users = useAsyncData(
    (signal) => metaApi.searchUsers({ keyword: debouncedKeyword, status: "active", page: userPage, size: 20 }, signal),
    [open, book?.id, debouncedKeyword, userPage],
    { enabled: open && !!book, resetOnDepChange: true },
  );

  const memberIds = useMemo(
    () => new Set((members.data ?? []).map((member) => member.user_id)),
    [members.data],
  );
  const searchResults = users.data?.items ?? [];
  const userOptions = searchResults.filter((user) => !memberIds.has(user.id));
  const userPageCount = Math.max(1, Math.ceil((users.data?.total ?? 0) / (users.data?.size || 20)));

  function closeDialog() {
    if (busyKey) return;
    members.setData(null);
    users.setData(null);
    setKeyword("");
    setDebouncedKeyword("");
    setUserPage(1);
    setSelectedUserId(null);
    setDraftRoles({});
    setRemovingMember(null);
    onClose();
  }

  useEffect(() => {
    if (!open) return;
    setKeyword("");
    setDebouncedKeyword("");
    setUserPage(1);
    setSelectedUserId(null);
    setNewRole("finance_clerk");
    setDraftRoles({});
    setRemovingMember(null);
  }, [open, book?.id]);

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => setDebouncedKeyword(keyword.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [keyword, open]);

  useEffect(() => {
    if (!members.data) return;
    setDraftRoles(members.data.reduce<Record<number, string>>((result, member) => {
      result[member.user_id] = member.role;
      return result;
    }, {}));
  }, [members.data]);

  async function grantMember() {
    if (!book || selectedUserId === null) return;
    setBusyKey("grant");
    try {
      await financeApi.saveMember(book.id, selectedUserId, newRole);
      setSelectedUserId(null);
      setUserPage(1);
      onChanged("granted");
      members.reload();
      users.reload();
    } catch (error) {
      toast.err(errText(error));
    } finally {
      setBusyKey("");
    }
  }

  async function saveMemberRole(member: FinanceBookMember) {
    if (!book) return;
    const role = draftRoles[member.user_id] ?? member.role;
    if (!isFinanceRole(role) || role === member.role) return;
    setBusyKey(`save:${member.user_id}`);
    try {
      await financeApi.saveMember(book.id, member.user_id, role);
      onChanged("role_changed");
      members.reload();
    } catch (error) {
      toast.err(errText(error));
    } finally {
      setBusyKey("");
    }
  }

  async function removeSelectedMember() {
    if (!book || !removingMember) return;
    setBusyKey(`remove:${removingMember.user_id}`);
    try {
      await financeApi.removeMember(book.id, removingMember.user_id);
      setRemovingMember(null);
      onChanged("removed");
      members.reload();
      users.reload();
    } catch (error) {
      toast.err(errText(error));
    } finally {
      setBusyKey("");
    }
  }

  const selectedUser = userOptions.find((user) => user.id === selectedUserId) ?? null;
  const selectedRoleDescription = FINANCE_ROLE_OPTIONS.find((item) => item.value === newRole)?.description;

  return (
    <>
      <Dialog
        open={open}
        onClose={closeDialog}
        title={book ? `成员与权限 · ${book.name}（${book.code}）` : "成员与权限"}
        size="lg"
        maskClosable={!busyKey}
        footer={<button className="btn-ghost" onClick={closeDialog} disabled={!!busyKey}>关闭</button>}
      >
        <p className="tiny muted" style={{ marginTop: 0 }}>
          这里维护当前账套的财务授权。系统管理员始终拥有全局财务管理权限，不需要单独添加为账套成员。
        </p>

        <section className="card" style={{ marginBottom: 16 }}>
          <div className="section-head" style={{ marginTop: 0 }}>
            <div>
              <h3>新增账套成员</h3>
              <p>仅可选择启用账号；按账号或姓名搜索，每次添加一位成员。</p>
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 12, alignItems: "end" }}>
            <label className="toolbar-field">
              <span>搜索启用用户</span>
              <input
                value={keyword}
                onChange={(event) => { setKeyword(event.target.value); setUserPage(1); setSelectedUserId(null); }}
                placeholder="输入账号或姓名"
                aria-label="搜索启用用户"
                disabled={!!busyKey}
              />
            </label>
            <label className="toolbar-field">
              <span>选择用户</span>
              <Select
                value={selectedUserId == null ? "" : String(selectedUserId)}
                onChange={(value) => setSelectedUserId(value ? Number(value) : null)}
                aria-label="选择需要授权的用户"
                disabled={users.loading || userOptions.length === 0 || !!busyKey}
              >
                <option value="">
                  {users.loading ? "搜索中…" : userOptions.length ? "请选择用户" : searchResults.length ? "本页用户已全部授权" : "无匹配启用用户"}
                </option>
                {userOptions.map((user) => (
                  <option key={user.id} value={user.id}>{user.real_name} · {user.username}</option>
                ))}
              </Select>
            </label>
            <label className="toolbar-field">
              <span>财务角色</span>
              <Select value={newRole} onChange={(value) => setNewRole(value as FinanceRole)} disabled={!!busyKey}>
                {FINANCE_ROLE_OPTIONS.map((role) => <option key={role.value} value={role.value}>{role.label}</option>)}
              </Select>
            </label>
            <button className="btn-primary" onClick={() => void grantMember()} disabled={!book || !selectedUser || !members.data || members.loading || !!busyKey}>
              {busyKey === "grant" ? "授权中…" : "授予角色"}
            </button>
          </div>
          {users.data && userPageCount > 1 && (
            <div className="status-row" style={{ justifyContent: "flex-end", gap: 8, marginTop: 10 }}>
              <button className="btn-ghost btn-xs" onClick={() => { setUserPage((page) => Math.max(1, page - 1)); setSelectedUserId(null); }} disabled={userPage <= 1 || users.loading || !!busyKey}>上一页</button>
              <span className="tiny muted">第 {users.data.page} / {userPageCount} 页，共 {users.data.total} 位启用用户</span>
              <button className="btn-ghost btn-xs" onClick={() => { setUserPage((page) => Math.min(userPageCount, page + 1)); setSelectedUserId(null); }} disabled={userPage >= userPageCount || users.loading || !!busyKey}>下一页</button>
            </div>
          )}
          {selectedRoleDescription && <p className="tiny muted" style={{ marginBottom: 0 }}>{selectedRoleDescription}</p>}
          {users.error && <div style={{ marginTop: 12 }}><LoadFailed message={users.error} onRetry={users.reload} /></div>}
        </section>

        <div className="section-head">
          <div>
            <h3>当前成员</h3>
            <p>角色变更保存后立即生效；移除授权前会再次确认。</p>
          </div>
          <button className="btn-ghost btn-xs" onClick={members.reload} disabled={members.loading || !!busyKey}>刷新</button>
        </div>

        {members.firstLoad ? (
          <LoadingBlock kpis={0} label="加载账套成员…" />
        ) : members.error ? (
          <LoadFailed message={members.error} onRetry={members.reload} />
        ) : (members.data ?? []).length === 0 ? (
          <div className="card"><Empty title="当前账套还没有成员授权" hint="可在上方搜索启用用户并分配财务角色。" /></div>
        ) : (
          <div className="table-scroll">
            <table className="grid" aria-busy={members.loading}>
              <thead><tr><th>姓名</th><th>账号</th><th>财务角色</th><th className="no-print">操作</th></tr></thead>
              <tbody>
                {(members.data ?? []).map((member) => {
                  const role = draftRoles[member.user_id] ?? member.role;
                  const roleChanged = role !== member.role;
                  const rowBusy = busyKey === `save:${member.user_id}` || busyKey === `remove:${member.user_id}`;
                  return (
                    <tr key={member.user_id}>
                      <td>{member.real_name || member.username}</td>
                      <td className="mono tiny">{member.username}</td>
                      <td>
                        <Select
                          value={role}
                          aria-label={`${member.username}的财务角色`}
                          onChange={(value) => setDraftRoles((current) => ({ ...current, [member.user_id]: value as FinanceRole }))}
                          disabled={!!busyKey}
                        >
                          {!isFinanceRole(role) && <option value={role}>{roleLabel(role)}</option>}
                          {FINANCE_ROLE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                        </Select>
                      </td>
                      <td className="no-print">
                        <span className="table-actions">
                          <button className="btn-ghost btn-xs" onClick={() => void saveMemberRole(member)} disabled={!roleChanged || !isFinanceRole(role) || !!busyKey}>
                            {rowBusy && busyKey.startsWith("save:") ? "保存中…" : "保存角色"}
                          </button>
                          <button className="btn-danger-outline btn-xs" onClick={() => setRemovingMember(member)} disabled={!!busyKey}>
                            移除
                          </button>
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Dialog>

      <Confirm
        open={!!removingMember}
        title="移除账套成员授权？"
        text={removingMember && book
          ? `将移除「${removingMember.real_name || removingMember.username}（${removingMember.username}）」在「${book.name}（${book.code}）」的财务授权。该用户之后将无法通过此账套成员授权访问财务功能；若其为系统管理员，全局权限不受影响。`
          : undefined}
        okText="确认移除"
        danger
        loading={busyKey.startsWith("remove:")}
        onConfirm={() => void removeSelectedMember()}
        onCancel={() => setRemovingMember(null)}
      />
    </>
  );
}
