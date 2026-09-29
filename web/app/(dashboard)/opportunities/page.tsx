"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { errText, opportunitiesApi, type Opportunity } from "@/lib/api";
import { useAsyncData } from "@/lib/useAsyncData";
import { urlInt, useUrlState, useUrlText } from "@/lib/useUrlState";
import { fmtMoney } from "@/lib/labels";
import Badge, { type BadgeTone } from "@/components/ui/Badge";
import Empty from "@/components/ui/Empty";
import Pagination, { type PaginationChange } from "@/components/ui/Pagination";
import { LoadingBlock, LoadFailed } from "@/components/ui/PageState";
import { Confirm, Drawer } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import { CardItem, CardList } from "@/components/ui/CardList";
import { DesktopTableFrame, ListPageLayout, ListViewport } from "@/components/ui/ListPageLayout";
import PageHeader from "@/components/ui/PageHeader";
import Select from "@/components/ui/Select";
import MotionReveal from "@/components/motion/MotionReveal";
import { useMenus } from "@/lib/useMeta";

const SIZE_OPTIONS = [15, 50, 100];
const URL_DEFAULTS = { q: "", stage: "", page: "1", size: "15" };

const STAGES: Record<string, string> = {
  new: "新建",
  qualified: "已确认",
  proposal: "方案报价",
  negotiation: "商务谈判",
  won: "已赢单",
  lost: "已输单",
};

const STAGE_TONES: Record<string, BadgeTone> = {
  new: "todo",
  qualified: "doing",
  proposal: "doing",
  negotiation: "warn",
  won: "done",
  lost: "danger",
};

type Draft = {
  code: string;
  name: string;
  client: string;
  owner_name: string;
  budget_total: string;
  stage: string;
  expected_close: string;
  description: string;
};

const EMPTY_DRAFT: Draft = {
  code: "",
  name: "",
  client: "",
  owner_name: "",
  budget_total: "0",
  stage: "new",
  expected_close: "",
  description: "",
};

function stageLabel(stage: string): string {
  return STAGES[stage] ?? (stage || "新建");
}

function stageTone(stage: string): BadgeTone {
  return STAGE_TONES[stage] ?? "todo";
}

function draftFrom(item: Opportunity | null): Draft {
  if (!item) return EMPTY_DRAFT;
  return {
    code: item.code,
    name: item.name,
    client: item.client,
    owner_name: item.owner_name,
    budget_total: String(item.budget_total ?? 0),
    stage: item.stage,
    expected_close: item.expected_close ?? "",
    description: item.description,
  };
}

export default function OpportunitiesPage() {
  return (
    <Suspense
      fallback={
        <div>
          <div className="skel skel-title" />
          <LoadingBlock kpis={0} label="加载商机管理…" />
        </div>
      }
    >
      <OpportunitiesInner />
    </Suspense>
  );
}

function OpportunitiesInner() {
  const toast = useToast();
  const { isAdmin } = useMenus();
  const [url, setUrl] = useUrlState(URL_DEFAULTS, { pageKey: "page" });
  const page = urlInt(url.page, 1);
  const size = SIZE_OPTIONS.includes(Number(url.size)) ? Number(url.size) : SIZE_OPTIONS[0];
  const [qDraft, setQDraft] = useUrlText(url.q, (next) => setUrl({ q: next }));
  const { data, loading, firstLoad, error, reload } = useAsyncData(
    (signal) =>
      opportunitiesApi.list(
        {
          keyword: url.q.trim(),
          stage: url.stage,
          page,
          size,
          sort: "-id",
        },
        signal,
      ),
    [page, size, url.q, url.stage],
    { resetOnDepChange: true },
  );
  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const [editor, setEditor] = useState<Opportunity | null | "new">(null);
  const [deleteTarget, setDeleteTarget] = useState<Opportunity | null>(null);
  const [busy, setBusy] = useState(false);
  const hasFilter = Boolean(url.q || url.stage);
  const scopeText = [url.q ? `关键词「${url.q}」` : "", url.stage ? `阶段=${stageLabel(url.stage)}` : ""]
    .filter(Boolean)
    .join(" · ");
  const stageOptions = useMemo(() => Object.entries(STAGES), []);

  const toolbar = (
    <PageHeader
      title="商机管理"
      filters={
        <>
          <input
            value={qDraft}
            onChange={(event) => setQDraft(event.target.value)}
            placeholder="搜索名称 / 编号 / 客户…"
            aria-label="搜索商机"
          />
          <Select
            value={url.stage}
            onChange={(value) => setUrl({ stage: value })}
            aria-label="按商机阶段筛选"
          >
            <option value="">全部阶段</option>
            {stageOptions.map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </Select>
          {hasFilter && (
            <button type="button" className="btn-ghost" style={{ height: 32, lineHeight: "30px", width: "auto" }} onClick={() => setUrl({ q: "", stage: "" })}>
              清除筛选
            </button>
          )}
        </>
      }
      actions={
        <button className="btn-primary" title="创建一个新的商机档案" onClick={() => setEditor("new")}>
          + 新建商机
        </button>
      }
    />
  );

  async function remove(item: Opportunity) {
    setBusy(true);
    try {
      await opportunitiesApi.remove(item.id);
      toast.ok(`商机「${item.name}」已删除`);
      reload();
    } catch (e) {
      toast.err(errText(e));
    } finally {
      setBusy(false);
      setDeleteTarget(null);
    }
  }

  return (
    <ListPageLayout toolbar={toolbar}>
      {error && <LoadFailed message={error} onRetry={reload} />}
      {firstLoad ? (
        <LoadingBlock kpis={0} label="加载商机管理…" />
      ) : items.length === 0 ? (
        <div className="card">
          <Empty title={hasFilter ? "没有匹配的商机" : "暂无商机"} hint={hasFilter ? "换个筛选条件，或清除筛选后重试。" : "点击右上角新建第一个商机。"} />
        </div>
      ) : (
        <ListViewport
          pagination={
            <Pagination
              page={page}
              size={size}
              total={total}
              loading={loading}
              sizeOptions={SIZE_OPTIONS}
              scopeText={scopeText}
              ariaLabel="商机管理分页"
              onChange={(next: PaginationChange) => setUrl({ page: String(next.page), size: String(next.size) }, { history: next.page === page ? "replace" : "push" })}
            />
          }
        >
          <MotionReveal delay={0.08}>
            <CardList label="商机管理">
              {items.map((item) => (
                <CardItem
                  key={item.id}
                  title={<span className="ellipsis" title={item.name}>{item.name}</span>}
                  code={item.code}
                  badges={<Badge status={stageLabel(item.stage)} tone={stageTone(item.stage)} />}
                  fields={[
                    { label: "负责人", value: item.owner_name || "-" },
                    { label: "客户", value: <span className="ellipsis" title={item.client}>{item.client || "-"}</span> },
                    { label: "预计金额", value: `${fmtMoney(item.budget_total)} 元`, mono: true },
                  ]}
                  actions={
                    <>
                      <button type="button" className="btn-ghost btn-xs" onClick={() => setEditor(item)}>编辑</button>
                      {isAdmin && <button type="button" className="btn-ghost btn-xs danger-link" onClick={() => setDeleteTarget(item)}>删除</button>}
                    </>
                  }
                />
              ))}
            </CardList>
            <DesktopTableFrame>
              <table className="grid project-table" aria-busy={loading}>
                <colgroup>
                  <col style={{ width: 150 }} /><col style={{ width: 250 }} /><col style={{ width: 150 }} />
                  <col style={{ width: 180 }} /><col style={{ width: 130 }} /><col style={{ width: 130 }} /><col style={{ width: 130 }} />
                </colgroup>
                <thead><tr><th>编号</th><th>名称</th><th>负责人</th><th>客户</th><th className="num">预计金额（元）</th><th>阶段</th><th className="no-print">操作</th></tr></thead>
                <tbody>
                  {items.map((item) => (
                    <tr key={item.id}>
                      <td className="mono project-code">{item.code}</td>
                      <td><span className="ellipsis" title={item.name}>{item.name}</span></td>
                      <td>{item.owner_name || "-"}</td>
                      <td className="muted"><span className="ellipsis" title={item.client}>{item.client || "-"}</span></td>
                      <td className="num">{fmtMoney(item.budget_total)}</td>
                      <td><Badge status={stageLabel(item.stage)} tone={stageTone(item.stage)} /></td>
                      <td className="no-print"><span className="table-actions"><button className="btn-ghost btn-xs" onClick={() => setEditor(item)}>编辑</button>{isAdmin && <button className="btn-ghost btn-xs danger-link" onClick={() => setDeleteTarget(item)}>删除</button>}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </DesktopTableFrame>
          </MotionReveal>
        </ListViewport>
      )}

      <OpportunityDrawer
        open={editor !== null}
        opportunity={editor === "new" ? null : editor}
        onClose={() => setEditor(null)}
        onSaved={(saved, isNew) => {
          toast.ok(isNew ? `商机已创建：${saved.code}` : "商机信息已保存");
          setEditor(null);
          reload();
        }}
      />
      <Confirm
        open={!!deleteTarget}
        danger
        loading={busy}
        title={`删除商机「${deleteTarget?.name ?? ""}」？`}
        text="商机将从列表中移除。"
        okText="确认删除"
        onConfirm={() => deleteTarget && remove(deleteTarget)}
        onCancel={() => setDeleteTarget(null)}
      />
    </ListPageLayout>
  );
}

function OpportunityDrawer({
  open,
  opportunity,
  onClose,
  onSaved,
}: {
  open: boolean;
  opportunity: Opportunity | null;
  onClose: () => void;
  onSaved: (item: Opportunity, isNew: boolean) => void;
}) {
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  useEffect(() => {
    if (open) setDraft(draftFrom(opportunity));
  }, [open, opportunity]);

  function setField<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  async function save() {
    if (!draft.name.trim()) {
      toast.err("商机名称不能为空");
      return;
    }
    const body = {
      code: draft.code.trim(),
      name: draft.name.trim(),
      client: draft.client.trim(),
      owner_name: draft.owner_name.trim(),
      budget_total: Number(draft.budget_total || 0),
      stage: draft.stage,
      expected_close: draft.expected_close || null,
      description: draft.description,
    };
    if (!Number.isFinite(body.budget_total) || body.budget_total < 0) {
      toast.err("预计金额必须是大于等于 0 的数字");
      return;
    }
    setSaving(true);
    try {
      const isNew = !opportunity;
      const saved = isNew ? await opportunitiesApi.create(body) : await opportunitiesApi.update(opportunity.id, body);
      onSaved(saved, isNew);
    } catch (e) {
      toast.err(errText(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width={520}
      title={opportunity ? `编辑商机 · ${opportunity.name}` : "新建商机"}
      footer={<><button className="btn-ghost" onClick={onClose}>取消</button><button className="btn-primary" disabled={saving} onClick={save}>{saving ? "保存中…" : "保存商机"}</button></>}
    >
      <div className="form-grid">
        <label><span>商机编号</span><input value={draft.code} onChange={(e) => setField("code", e.target.value)} placeholder="留空自动生成 OPP-年份-序号" /></label>
        <label><span>商机名称 <b className="required">*</b></span><input autoFocus value={draft.name} onChange={(e) => setField("name", e.target.value)} /></label>
        <label><span>客户</span><input value={draft.client} onChange={(e) => setField("client", e.target.value)} /></label>
        <label><span>负责人</span><input value={draft.owner_name} onChange={(e) => setField("owner_name", e.target.value)} /></label>
        <label><span>预计金额（元）</span><input type="number" min="0" step="0.01" value={draft.budget_total} onChange={(e) => setField("budget_total", e.target.value)} /></label>
        <label><span>商机阶段</span><Select value={draft.stage} onChange={(value) => setField("stage", value)}>{Object.entries(STAGES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select></label>
        <label><span>预计签约日期</span><input type="date" value={draft.expected_close} onChange={(e) => setField("expected_close", e.target.value)} /></label>
        <label className="full"><span>备注</span><textarea rows={5} value={draft.description} onChange={(e) => setField("description", e.target.value)} /></label>
      </div>
    </Drawer>
  );
}
