"use client";

import { useMemo, useState, type FormEvent } from "react";
import Select from "@/components/ui/Select";
import { PERMISSION_AUDIT_LOGS, PERMISSION_MEMBERS, PERMISSION_MODULES, PERMISSION_ROLES, ROLE_PERMISSION_MATRIX, type SparkMember, type SparkRoleName } from "@/lib/spark/permission";
import { SparkBadge, SparkButton, SparkPageHeader, SparkPanel, SparkTabs } from "../SparkUI";
import p from "../SparkPages.module.css";
import s from "./SecurityOpsPermission.module.css";

type PermissionTab = "成员管理" | "角色权限" | "操作日志";
const PERMISSION_TABS: readonly { value: PermissionTab; label: string }[] = [
  { value: "成员管理", label: "成员管理" }, { value: "角色权限", label: "角色权限" }, { value: "操作日志", label: "操作日志" },
];
const ROLE_FILTERS = ["全部", ...PERMISSION_ROLES.map((role) => role.name)] as const;

export default function PermissionPage() {
  const [activeTab, setActiveTab] = useState<PermissionTab>("成员管理");
  const [selectedRole, setSelectedRole] = useState<SparkRoleName>("区域总监（苏州）");
  const [filterRole, setFilterRole] = useState<(typeof ROLE_FILTERS)[number]>("全部");
  const [query, setQuery] = useState("");
  const [members, setMembers] = useState<SparkMember[]>(() => PERMISSION_MEMBERS.map((member) => ({ ...member })));
  const [addOpen, setAddOpen] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftRole, setDraftRole] = useState<SparkRoleName>("门店店长");
  const [draftStore, setDraftStore] = useState("");
  const [notice, setNotice] = useState("");

  const visibleMembers = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
    return members.filter((member) => {
      const roleMatches = filterRole === "全部" || member.role === filterRole;
      const searchable = `${member.name} ${member.email} ${member.store} ${member.phone} ${member.id}`.toLocaleLowerCase("zh-CN");
      return roleMatches && (!normalizedQuery || searchable.includes(normalizedQuery));
    });
  }, [filterRole, members, query]);

  const handleAddMember = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = draftName.trim();
    if (!name) return;
    const nextNumber = members.length + 1;
    const member = {
      id: `U${String(nextNumber).padStart(3, "0")}`,
      name,
      email: `${name.toLocaleLowerCase("zh-CN").replace(/\s+/g, ".")}@yunqi-sports.cn`,
      role: draftRole,
      store: draftStore.trim() || "苏州总部",
      phone: "138****6616",
      lastLogin: "尚未登录",
      enabled: true,
    };
    setMembers((current) => [...current, member]);
    setAddOpen(false);
    setDraftName("");
    setDraftStore("");
    setNotice(`已在当前会话中添加 ${name}；刷新页面后会恢复原始成员列表。`);
  };

  return (
    <div className={p.pageStack}>
      <SparkPageHeader
        title="权限管理（RBAC）"
        subtitle={`苏州团队 · 8 个角色 · ${members.length} 名成员 · 最小权限原则`}
        icon="permission"
        actions={<SparkButton variant="primary" onClick={() => { setNotice(""); setAddOpen(true); }}>添加成员</SparkButton>}
      />
      {notice && <div className={s.inlineNotice} role="status">{notice}</div>}

      <SparkTabs items={PERMISSION_TABS} value={activeTab} onChange={setActiveTab} label="权限管理分区" />

      {activeTab === "成员管理" && (
        <SparkPanel title="成员管理" subtitle="按姓名、门店、联系方式或角色查找成员">
          <div className={s.memberTools}>
            <input className={p.searchInput} aria-label="搜索姓名、门店或手机号" placeholder="搜索姓名 / 门店 / 手机号" value={query} onChange={(event) => setQuery(event.target.value)} />
            <div className={p.filterRow} aria-label="按角色筛选">
              {ROLE_FILTERS.map((role) => (
                <button key={role} type="button" className={`${p.filterButton} ${filterRole === role ? p.filterSelected : ""}`} aria-pressed={filterRole === role} onClick={() => setFilterRole(role)}>{role}</button>
              ))}
            </div>
            <span className={p.muted} style={{ fontSize: 9 }}>显示 {visibleMembers.length} / {members.length} 名成员</span>
          </div>
          <div className={p.tableWrap} style={{ marginTop: 12 }}>
            <table className={p.dataTable}>
              <thead><tr><th>成员</th><th>角色</th><th>所属门店</th><th>联系方式</th><th>最近登录</th><th>状态</th><th>操作</th></tr></thead>
              <tbody>{visibleMembers.map((member) => (
                <tr key={member.id}>
                  <td><strong style={{ color: "#d5e0ef", fontWeight: 550 }}>{member.name}</strong><div className={p.muted} style={{ marginTop: 3, fontSize: 8 }}>{member.id} · {member.email}</div></td>
                  <td>{member.role}</td><td>{member.store}</td><td className={p.mono}>{member.phone}</td><td className={p.mono}>{member.lastLogin}</td>
                  <td><SparkBadge tone={member.enabled ? "green" : "slate"}>{member.enabled ? "启用" : "已停用"}</SparkBadge></td>
                  <td><SparkButton variant="quiet" onClick={() => setMembers((current) => current.map((item) => item.id === member.id ? { ...item, enabled: !item.enabled } : item))}>{member.enabled ? "停用" : "启用"}</SparkButton></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
          {!visibleMembers.length && <div className={p.emptyState}>没有符合当前搜索和角色条件的成员</div>}
        </SparkPanel>
      )}

      {activeTab === "角色权限" && (
        <>
          <div className={s.roleGrid}>
            {PERMISSION_ROLES.map((role) => (
              <button className={`${s.roleCard} ${selectedRole === role.name ? s.roleCardActive : ""}`} type="button" key={role.name} aria-pressed={selectedRole === role.name} onClick={() => setSelectedRole(role.name)}>
                <strong>{role.name}</strong><p>{role.description}</p><small>{role.members} 名成员</small>
              </button>
            ))}
          </div>
          <SparkPanel title={`权限矩阵 · ${selectedRole}`} subtitle="按模块展示当前角色的查看、编辑与审批权限">
            <div className={s.matrix} role="table" aria-label={`${selectedRole}权限矩阵`}>
              <div className={`${s.matrixRow} ${s.matrixHeader}`} role="row"><span role="columnheader">管理模块</span><span role="columnheader">权限</span><span role="columnheader">数据范围</span><span role="columnheader">访问控制</span></div>
              {PERMISSION_MODULES.map((module) => {
                const permission = ROLE_PERMISSION_MATRIX[selectedRole][module];
                return <div className={s.matrixRow} role="row" key={module}><span role="cell">{module}</span><span className={permission === "—" ? s.matrixNone : s.matrixValue} role="cell">{permission}</span><span role="cell">{permission === "—" ? "—" : selectedRole === "超级管理员" ? "全域" : selectedRole === "门店店长" ? "所属门店" : "授权区域"}</span><span className={permission === "—" ? s.matrixNone : s.matrixValue} role="cell">{permission === "—" ? "禁止" : "已授权"}</span></div>;
              })}
            </div>
          </SparkPanel>
        </>
      )}

      {activeTab === "操作日志" && (
        <SparkPanel title="登录与敏感操作日志" subtitle="记录成员登录、审批、配置修改与安全拦截">
          <div className={s.permissionLogs}>
            {PERMISSION_AUDIT_LOGS.map((log) => (
              <div className={s.permissionLog} key={`${log.time}-${log.user}`}>
                <time>{log.time}</time><strong>{log.user}</strong><span>{log.action}</span><small>{log.location}</small><SparkBadge tone={log.result === "成功" ? "green" : "rose"}>{log.result}</SparkBadge>
              </div>
            ))}
          </div>
        </SparkPanel>
      )}

      {addOpen && (
        <div className={s.modalBackdrop} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setAddOpen(false); }}>
          <section className={s.modal} role="dialog" aria-modal="true" aria-labelledby="spark-add-member-title">
            <h2 id="spark-add-member-title">添加成员</h2>
            <form className={s.modalForm} onSubmit={handleAddMember}>
              <label>成员姓名<input autoFocus value={draftName} onChange={(event) => setDraftName(event.target.value)} placeholder="请输入成员姓名" required /></label>
              <label>角色<Select className={p.sparkSelect} surface="spark" value={draftRole} onChange={(value) => setDraftRole(value as SparkRoleName)} aria-label="角色">{PERMISSION_ROLES.map((role) => <option key={role.name} value={role.name}>{role.name}</option>)}</Select></label>
              <label>所属门店 / 团队<input value={draftStore} onChange={(event) => setDraftStore(event.target.value)} placeholder="默认：苏州总部" /></label>
              <div className={s.modalActions}><SparkButton onClick={() => setAddOpen(false)}>取消</SparkButton><SparkButton type="submit" variant="primary">添加到成员列表</SparkButton></div>
            </form>
          </section>
        </div>
      )}
    </div>
  );
}
