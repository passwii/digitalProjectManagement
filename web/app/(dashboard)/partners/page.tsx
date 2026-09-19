"use client";

import { Suspense, useEffect, useState } from "react";
import {
  buildQuery,
  errText,
  metaApi,
  partnersApi,
  type DictItem,
  type Partner,
} from "@/lib/api";
import { useAsyncData } from "@/lib/useAsyncData";
import { urlInt, useUrlState, useUrlText } from "@/lib/useUrlState";
import { useMenus } from "@/lib/useMeta";
import { fmtDateTime } from "@/lib/labels";
import Badge from "@/components/ui/Badge";
import Empty from "@/components/ui/Empty";
import Pagination from "@/components/ui/Pagination";
import { LoadingBlock, LoadFailed } from "@/components/ui/PageState";
import PageActions from "@/components/ui/PageActions";
import TableToolbar from "@/components/ui/TableToolbar";
import { Confirm } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import PartnerDrawer from "./PartnerDrawer";

const SIZE_OPTIONS = [20, 50, 100];
const URL_DEFAULTS = {
  q: "",
  partner_type: "",
  page: "1",
  size: "20",
};

export default function PartnersPage() {
  return (
    <Suspense fallback={<LoadingBlock kpis={0} label="加载我的友商…" />}>
      <PartnersInner />
    </Suspense>
  );
}

function PartnersInner() {
  const toast = useToast();
  const {
    isAdmin,
    loading: menuLoading,
    error: menuError,
    reload: reloadMenus,
  } = useMenus();
  const [url, setUrl] = useUrlState(URL_DEFAULTS, { pageKey: "page" });
  const page = urlInt(url.page, 1);
  const size = SIZE_OPTIONS.includes(Number(url.size)) ? Number(url.size) : SIZE_OPTIONS[0];
  const [qDraft, setQDraft] = useUrlText(url.q, (next) => setUrl({ q: next }));
  const [selected, setSelected] = useState<number | "new" | null>(null);
  const [deleting, setDeleting] = useState<Partner | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [typeOptions, setTypeOptions] = useState<DictItem[]>([]);

  // 友商类型选项（后端字典可配，见 api/seed.py）：筛选与抽屉共用同一份
  useEffect(() => {
    if (!isAdmin) return;
    let alive = true;
    metaApi.dicts("partner_type").then((rows) => {
      if (alive) setTypeOptions(rows);
    }).catch(() => {
      if (alive) setTypeOptions([]);
    });
    return () => {
      alive = false;
    };
  }, [isAdmin]);

  const { data, loading, firstLoad, error, reload } = useAsyncData(
    (signal) =>
      partnersApi.list(
        buildQuery({
          page,
          size,
          keyword: url.q.trim(),
          partner_type: url.partner_type,
        }),
        signal,
      ),
    [page, size, url.q, url.partner_type, isAdmin],
    { enabled: isAdmin, resetOnDepChange: true },
  );

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const hasFilter = !!(url.q || url.partner_type);
  const scopeText = [
    url.q ? `关键词「${url.q}」` : "",
    url.partner_type ? `类型=${url.partner_type}` : "",
  ].filter(Boolean).join(" · ");

  async function confirmDelete() {
    if (!deleting) return;
    setDeleteBusy(true);
    try {
      await partnersApi.remove(deleting.id);
      toast.ok(`友商「${deleting.name}」已删除`);
      if (selected === deleting.id) setSelected(null);
      setDeleting(null);
      reload();
    } catch (e) {
      toast.err(errText(e));
    } finally {
      setDeleteBusy(false);
    }
  }

  if (menuLoading) {
    return (
      <div>
        <div className="skel skel-title" />
        <LoadingBlock kpis={0} label="校验访问权限…" />
      </div>
    );
  }
  if (menuError) return <LoadFailed message={menuError} onRetry={reloadMenus} />;
  if (!isAdmin) {
    return (
      <div className="card">
        <Empty title="仅管理员可访问我的友商" hint="友商基本信息、人员、业绩合同与资质附件不对普通账号开放。" />
      </div>
    );
  }

  return (
    <div>
      <PageActions
        title="我的友商"
        actions={
          <button
            className="btn-primary"
            onClick={() => setSelected("new")}
            title="新建友商档案"
          >
            + 新建友商
          </button>
        }
      />

      {error && <LoadFailed message={error} onRetry={reload} />}

      <TableToolbar>
        <input
          value={qDraft}
          onChange={(e) => setQDraft(e.target.value)}
          placeholder="搜索友商名称 / 联系人 / 电话…"
          aria-label="搜索友商"
        />
        <select
          value={url.partner_type}
          onChange={(e) => setUrl({ partner_type: e.target.value })}
          aria-label="按友商类型筛选"
        >
          <option value="">全部类型</option>
          {typeOptions.map((item) => (
            <option key={item.code} value={item.label}>{item.label}</option>
          ))}
        </select>
        {hasFilter && (
          <button
            type="button"
            className="btn-ghost"
            style={{ width: "auto" }}
            onClick={() => setUrl({ q: "", partner_type: "" })}
          >
            清除筛选
          </button>
        )}
      </TableToolbar>

      {firstLoad ? (
        <LoadingBlock kpis={0} label="加载我的友商…" />
      ) : items.length === 0 ? (
        <div className="card">
          <Empty
            title={hasFilter ? "没有匹配的友商" : "暂无友商档案"}
            hint={hasFilter ? "调整筛选条件后重试。" : "点击右上角「新建友商」开始建档。"}
          />
        </div>
      ) : (
        <>
          <div className="table-scroll">
            <table
              className="grid"
              aria-busy={loading}
              style={{ minWidth: 1080, tableLayout: "fixed" }}
            >
              <colgroup>
                <col style={{ width: 200 }} />
                <col style={{ width: 120 }} />
                <col style={{ width: 120 }} />
                <col style={{ width: 150 }} />
                <col style={{ width: 80 }} />
                <col style={{ width: 80 }} />
                <col style={{ width: 80 }} />
                <col style={{ width: 160 }} />
                <col style={{ width: 110 }} />
              </colgroup>
              <thead>
                <tr>
                  <th>友商名称</th>
                  <th>类型</th>
                  <th>联系人</th>
                  <th>联系电话</th>
                  <th>人员数</th>
                  <th>业绩数</th>
                  <th>附件数</th>
                  <th>更新时间</th>
                  <th className="no-print" />
                </tr>
              </thead>
              <tbody>
                {items.map((row) => (
                  <tr
                    key={row.id}
                    className="clickable-row"
                    onClick={() => setSelected(row.id)}
                    title="点击编辑友商档案"
                  >
                    <td><span className="ellipsis" title={row.name}><b>{row.name}</b></span></td>
                    <td>
                      {row.partner_type ? (
                        <Badge status={row.partner_type} tone="doing" />
                      ) : (
                        <span className="tiny">未设置</span>
                      )}
                    </td>
                    <td><span className="ellipsis" title={row.contact_name}>{row.contact_name || "-"}</span></td>
                    <td className="mono">{row.phone || "-"}</td>
                    <td className="num">{row.member_count ?? row.members?.length ?? 0}</td>
                    <td className="num">{row.contract_count ?? row.contracts?.length ?? 0}</td>
                    <td className="num">{row.attachment_count}</td>
                    <td className="mono tiny">{fmtDateTime(row.updated_at)}</td>
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
                      <button
                        type="button"
                        className="btn-ghost btn-xs danger-link"
                        onClick={(e) => {
                          e.stopPropagation();
                          setDeleting(row);
                        }}
                      >
                        删除
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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

      <PartnerDrawer
        partnerId={selected}
        typeOptions={typeOptions}
        onClose={() => setSelected(null)}
        onSaved={() => reload()}
      />

      <Confirm
        open={!!deleting}
        title={`删除友商「${deleting?.name ?? ""}」？`}
        text="人员、业绩合同与全部附件会一并删除，且不可恢复。如需保留请先下载附件备份。"
        danger
        loading={deleteBusy}
        okText="确认删除"
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}
