"use client";

import { Suspense, useState } from "react";
import {
  buildQuery,
  contactsApi,
  type Contact,
} from "@/lib/api";
import { useAsyncData } from "@/lib/useAsyncData";
import { urlInt, useUrlState, useUrlText } from "@/lib/useUrlState";
import { useMenus, useMeta } from "@/lib/useMeta";
import Avatar from "@/components/ui/Avatar";
import Badge from "@/components/ui/Badge";
import Empty from "@/components/ui/Empty";
import Pagination from "@/components/ui/Pagination";
import { LoadingBlock, LoadFailed } from "@/components/ui/PageState";
import PageHeader from "@/components/ui/PageHeader";
import Select from "@/components/ui/Select";
import { CardItem, CardList, DesktopTable } from "@/components/ui/CardList";
import ContactDrawer from "./ContactDrawer";

const SIZE_OPTIONS = [20, 50, 100];
const URL_DEFAULTS = {
  q: "",
  dept: "",
  employment_status: "",
  page: "1",
  size: "20",
};

const EMPLOYMENT_STATUS: Record<string, string> = {
  active: "在职",
  probation: "试用",
  leave: "离职",
};

export default function ContactsPage() {
  return (
    <Suspense fallback={<LoadingBlock kpis={0} label="加载通讯录…" />}>
      <ContactsInner />
    </Suspense>
  );
}

function ContactsInner() {
  const { depts } = useMeta();
  const {
    hasModule,
    loading: menuLoading,
    error: menuError,
    reload: reloadMenus,
  } = useMenus();
  const canRead = hasModule("contacts");
  const [url, setUrl] = useUrlState(URL_DEFAULTS, { pageKey: "page" });
  const page = urlInt(url.page, 1);
  const size = SIZE_OPTIONS.includes(Number(url.size)) ? Number(url.size) : SIZE_OPTIONS[0];
  const [qDraft, setQDraft] = useUrlText(url.q, (next) => setUrl({ q: next }));
  const [selected, setSelected] = useState<number | "new" | null>(null);

  const { data, loading, firstLoad, error, reload } = useAsyncData(
    (signal) =>
      contactsApi.list(
        buildQuery({
          page,
          size,
          keyword: url.q.trim(),
          dept_id: url.dept,
          employment_status: url.employment_status,
        }),
        signal,
      ),
    [page, size, url.q, url.dept, url.employment_status, canRead],
    { enabled: canRead, resetOnDepChange: true },
  );

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const hasFilter = !!(url.q || url.dept || url.employment_status);
  const scopeText = [
    url.q ? `关键词「${url.q}」` : "",
    url.dept ? `部门=${depts.find((item) => String(item.id) === url.dept)?.name ?? url.dept}` : "",
    url.employment_status ? `任职状态=${EMPLOYMENT_STATUS[url.employment_status] ?? url.employment_status}` : "",
  ].filter(Boolean).join(" · ");

  if (menuLoading) {
    return (
      <div>
        <div className="skel skel-title" />
        <LoadingBlock kpis={0} label="校验访问权限…" />
      </div>
    );
  }
  if (menuError) return <LoadFailed message={menuError} onRetry={reloadMenus} />;
  if (!canRead) {
    return (
      <div className="card">
        <Empty title="未分配通讯录模块" hint="身份证、学历、证书和合同附件仅对已分配通讯录模块的账号开放。" />
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="通讯录"
        filters={
          <>
            <input
              value={qDraft}
              onChange={(e) => setQDraft(e.target.value)}
              placeholder="搜索姓名 / 联系电话 / 工号 / 岗位…"
              aria-label="搜索通讯录"
            />
            <Select value={url.dept} onChange={(value) => setUrl({ dept: value })} aria-label="按部门筛选">
              <option value="">全部部门</option>
              {depts.map((dept) => <option key={dept.id} value={dept.id}>{dept.name}</option>)}
            </Select>
            <Select
              value={url.employment_status}
              onChange={(value) => setUrl({ employment_status: value })}
              aria-label="按任职状态筛选"
            >
              <option value="">全部任职状态</option>
              {Object.entries(EMPLOYMENT_STATUS).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </Select>
            {hasFilter && (
              <button
                type="button"
                className="btn-ghost"
                style={{ width: "auto" }}
                onClick={() => setUrl({ q: "", dept: "", employment_status: "" })}
              >
                清除筛选
              </button>
            )}
          </>
        }
        actions={
          <button
            className="btn-primary"
            onClick={() => setSelected("new")}
            title="新建通讯录人员"
          >
            + 新建人员
          </button>
        }
      />

      {error && <LoadFailed message={error} onRetry={reload} />}

      {firstLoad ? (
        <LoadingBlock kpis={0} label="加载通讯录…" />
      ) : items.length === 0 ? (
        <div className="card">
          <Empty
            title={hasFilter ? "没有匹配的人员" : "暂无可维护账号"}
            hint={hasFilter ? "调整筛选条件后重试。" : "先在系统管理中创建登录账号。"}
          />
        </div>
      ) : (
        <>
          <CardList label="通讯录人员">
            {items.map((row) => (
              <CardItem
                key={row.id}
                title={row.real_name || row.username}
                code={row.employee_no}
                badges={<Badge status={EMPLOYMENT_STATUS[row.employment_status] || row.employment_status} tone={row.employment_status === "leave" ? "paused" : "doing"} />}
                fields={[
                  { label: "联系电话", value: row.mobile || "-", mono: true },
                  { label: "部门", value: row.dept_name || "-" },
                  { label: "岗位", value: row.position || "-" },
                  { label: "用工类型", value: row.employment_type || "-" },
                  { label: "入职日期", value: row.hire_date || "-", mono: true },
                  { label: "账号", value: row.has_account ? (row.account_status === "active" ? "已关联" : "已停用") : "无登录账号" },
                ]}
                onSelect={() => setSelected(row.id)}
                actions={<button type="button" className="btn-ghost btn-xs" onClick={() => setSelected(row.id)}>编辑档案</button>}
              />
            ))}
          </CardList>
          <DesktopTable>
            {/*
              列宽固定 + 单元格不折行：每列都保证「最起码宽度」（工号至少完整显示 SHZK-002），
              窄屏（笔记本/平板）由 .table-scroll 横向滚动，而不是把内容折成两行。
              列宽合计 = .contacts-table 的 min-width，改列请同步（见 web/app/globals.css）。
            */}
            <table className="grid contacts-table" aria-busy={loading}>
              <colgroup>
                <col style={{ width: 160 }} />
                <col style={{ width: 130 }} />
                <col style={{ width: 120 }} />
                <col style={{ width: 150 }} />
                <col style={{ width: 150 }} />
                <col style={{ width: 100 }} />
                <col style={{ width: 100 }} />
                <col style={{ width: 112 }} />
                <col style={{ width: 104 }} />
                <col style={{ width: 84 }} />
              </colgroup>
              <thead>
                <tr>
                  <th>姓名</th>
                  <th>联系电话</th>
                  <th>工号</th>
                  <th>部门</th>
                  <th>岗位</th>
                  <th>用工类型</th>
                  <th>任职状态</th>
                  <th>入职日期</th>
                  <th>账号状态</th>
                  <th className="no-print" />
                </tr>
              </thead>
              <tbody>
                {items.map((row) => (
                  <tr
                    key={row.id}
                    className="clickable-row"
                    onClick={() => setSelected(row.id)}
                    title="点击编辑人员档案"
                  >
                    <td title={row.real_name || row.username}>
                      <span className="inline-person">
                        <Avatar name={row.real_name || row.username} size={24} />
                        <span>
                          <b>{row.real_name || row.username}</b>
                          {row.has_account && row.account_status !== "active" && (
                            <span className="tiny" style={{ display: "block" }}>账号已停用</span>
                          )}
                          {!row.has_account && (
                            <span className="tiny" style={{ display: "block" }}>无登录账号</span>
                          )}
                        </span>
                      </span>
                    </td>
                    <td className="mono">{row.mobile || "-"}</td>
                    <td className="mono" title={row.employee_no || ""}>{row.employee_no || "-"}</td>
                    <td title={row.dept_name || ""}>{row.dept_name || "-"}</td>
                    <td title={row.position || ""}>{row.position || "-"}</td>
                    <td>{row.employment_type || "-"}</td>
                    <td>
                      <Badge
                        status={EMPLOYMENT_STATUS[row.employment_status] || row.employment_status}
                        tone={row.employment_status === "leave" ? "paused" : "doing"}
                      />
                    </td>
                    <td className="mono">{row.hire_date || "-"}</td>
                    <td>
                      <Badge
                        status={row.has_account ? "已关联账号" : "无账号"}
                        tone={row.has_account ? "done" : "paused"}
                      />
                    </td>
                    <td className="no-print">
                      <button
                        type="button"
                        className="btn-ghost btn-xs"
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelected(row.id);
                        }}
                      >
                        编辑
                      </button>
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
            scopeText={scopeText}
            sizeOptions={SIZE_OPTIONS}
            onChange={(next) => setUrl({ page: String(next.page), size: String(next.size) })}
          />
        </>
      )}

      <ContactDrawer
        contactId={selected}
        onClose={() => setSelected(null)}
        onSaved={() => reload()}
      />
    </div>
  );
}
