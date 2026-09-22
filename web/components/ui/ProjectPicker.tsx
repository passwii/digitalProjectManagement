"use client";
/**
 * 项目选择器（BLF-1095）：关键词分页搜索 + 最近使用，替代一次性拉取 100 条项目的下拉框。
 *
 * - 搜索走后端 `GET /projects?keyword=&page=&size=`（Stage 3 分页契约），不再一次性拉取全部项目
 * - 「最近使用」来自 localStorage，无匹配时可快速回切
 * - 加载中显示骨架、空结果显示空状态、失败可重试；切换关键词/页码期间不展示上一批结果
 * - 当前选中项目按 id 单独解析，解析完成前不显示任何旧项目名（避免误导）
 * - 键盘：↑/↓ 移动、Enter 选择、Esc 关闭；移动端弹层宽度自适应，不产生横向溢出
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_PAGE_SIZE, errText, HttpError, projectsApi, type ProjectOption } from "@/lib/api";
import { useAsyncData } from "@/lib/useAsyncData";
import { useDebouncedValue } from "@/lib/useDebouncedValue";
import {
  loadRecentProjects,
  RECENT_PROJECTS_STORAGE_KEY,
  reconcileValidatedRecentProjects,
  rememberProject,
  removeRecentProject,
  syncRecentProjects,
  type RecentProject,
} from "@/lib/recentProjects";
import st from "./ProjectPicker.module.css";

const PAGE_SIZE = DEFAULT_PAGE_SIZE;

interface OptionRow {
  id: number | null; // null = 「全部」
  code?: string;
  name: string;
  hint?: string;
  section?: string;
}

function isUnavailableProjectError(error: unknown) {
  return error instanceof HttpError && (error.status === 404 || error.status === 403);
}

export default function ProjectPicker({
  value,
  onChange,
  allOption,
  allLabel = "全部项目",
  placeholder = "搜索项目名称 / 编号 / 客户…",
  ariaLabel = "选择项目",
  disabled = false,
  className,
}: {
  /** 当前项目 id（字符串，"" = 未选择） */
  value: string;
  onChange: (id: string) => void;
  /** 是否提供「全部项目」选项（报表筛选用） */
  allOption?: boolean;
  allLabel?: string;
  placeholder?: string;
  ariaLabel?: string;
  disabled?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [keyword, setKeyword] = useState("");
  const debouncedKeyword = useDebouncedValue(keyword, 300);
  const [page, setPage] = useState(1);
  const [active, setActive] = useState(-1);
  const [recent, setRecent] = useState<RecentProject[]>([]);
  const [recentReady, setRecentReady] = useState(false);
  const recentRefreshRef = useRef<{ controller: AbortController; generation: number } | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // 上次请求用的关键词：关键词真正变化时与 page 同步归 1，避免
  // “新关键词 + 旧页码”额外渲染一帧/多发一次无用请求（BLF-1095 review）
  const lastKeywordRef = useRef(debouncedKeyword);
  if (lastKeywordRef.current !== debouncedKeyword) {
    lastKeywordRef.current = debouncedKeyword;
    if (page !== 1) setPage(1);
  }

  const refreshRecent = useCallback(() => {
    recentRefreshRef.current?.controller.abort();
    const controller = new AbortController();
    const generation = (recentRefreshRef.current?.generation ?? 0) + 1;
    recentRefreshRef.current = { controller, generation };
    const { signal } = controller;
    const stored = loadRecentProjects();
    setRecent(stored);
    if (stored.length === 0) {
      setRecentReady(true);
      return;
    }
    setRecentReady(false);

    void Promise.all(
      stored.map(async (project) => {
        try {
          const current = await projectsApi.get(project.id, signal);
          return { id: current.id, code: current.code, name: current.name };
        } catch (error) {
          // 软删除和失去可见权限都按「不可再选」处理；网络故障则保留本地项，
          // 避免一次临时断网把用户的最近使用记录误删。
          return isUnavailableProjectError(error) ? null : project;
        }
      }),
    ).then((valid) => {
      if (signal.aborted || recentRefreshRef.current?.generation !== generation) return;
      const validated = valid.filter((project): project is RecentProject => project !== null);
      const validatedIds = new Set(validated.map((project) => project.id));
      for (const project of stored) {
        if (!validatedIds.has(project.id)) removeRecentProject(project.id);
      }
      // 校验期间用户可能刚选中了一个新项目；以最新快照为准，不能被旧请求的结果覆盖。
      const next = reconcileValidatedRecentProjects(stored, loadRecentProjects(), validated);
      syncRecentProjects(next);
      setRecent(next);
      setRecentReady(true);
    });
  }, []);

  // 选择器可能常驻布局中：跨标签删除项目后，下一次打开前同步刷新快照。
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== RECENT_PROJECTS_STORAGE_KEY) return;
      if (open) {
        refreshRecent();
      } else {
        setRecent(loadRecentProjects());
        setRecentReady(false);
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [open, refreshRecent]);

  useEffect(() => {
    if (!open) return;
    refreshRecent();
    return () => recentRefreshRef.current?.controller.abort();
  }, [open, refreshRecent]);

  // 已选项目的展示名：先从最近使用命中（无请求），否则按 id 查询
  const [selected, setSelected] = useState<{ id: number; code: string; name: string } | null>(null);
  const [resolving, setResolving] = useState(false);
  const [resolveErr, setResolveErr] = useState("");

  useEffect(() => {
    setResolveErr("");
    if (!value) {
      setSelected(null);
      setResolving(false);
      return;
    }
    const id = Number(value);
    const cached = recentReady ? recent.find((r) => r.id === id) : undefined;
    if (cached) {
      setSelected({ id: cached.id, code: cached.code, name: cached.name });
      setResolving(false);
      return;
    }
    let alive = true;
    const controller = new AbortController();
    setSelected(null); // 解析完成前不展示上一个项目名
    setResolving(true);
    projectsApi
      .get(id, controller.signal)
      .then((p) => {
        if (!alive) return;
        setSelected({ id: p.id, code: p.code, name: p.name });
      })
      .catch((e) => {
        if (alive && !controller.signal.aborted) setResolveErr(errText(e));
      })
      .finally(() => {
        if (alive) setResolving(false);
      });
    return () => {
      alive = false;
      controller.abort();
    };
  }, [value, recent, recentReady]);

  const { data, loading, firstLoad, error, reload } = useAsyncData(
    (signal) =>
      projectsApi.options(
        { keyword: debouncedKeyword, page, size: PAGE_SIZE, sort: "-id" },
        signal,
      ),
    [debouncedKeyword, page, open],
    { enabled: open, resetOnDepChange: true },
  );

  const total = data?.total ?? 0;
  const items: ProjectOption[] = data?.items ?? [];
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // 关键词变化已在上方渲染期同步归 1（避免“新关键词 + 旧页码”的中间帧）

  // 结果页越界（如关键词收窄后）自动收敛到末页
  useEffect(() => {
    if (open && data && page > pages) setPage(pages);
  }, [open, data, page, pages]);

  const showRecent = !debouncedKeyword && page === 1 && recentReady && recent.length > 0;
  const rows: OptionRow[] = useMemo(() => {
    const list: OptionRow[] = [];
    if (allOption && !debouncedKeyword) list.push({ id: null, name: allLabel });
    if (showRecent) {
      for (const r of recent) list.push({ id: r.id, code: r.code, name: r.name, hint: "最近", section: "最近使用" });
    }
    for (const p of items) {
      list.push({
        id: p.id,
        code: p.code,
        name: p.name,
        hint: p.client,
        section: showRecent ? "搜索结果" : undefined,
      });
    }
    return list;
  }, [allOption, allLabel, debouncedKeyword, showRecent, recent, items]);

  useEffect(() => setActive(-1), [debouncedKeyword, page]);

  useEffect(() => {
    if (!open || active < 0) return;
    const row = rows[active];
    if (!row) return;
    document.getElementById(`project-option-${row.id ?? "all"}`)?.scrollIntoView({ block: "nearest" });
  }, [active, open, rows]);

  const close = useCallback((focusTrigger = false) => {
    setOpen(false);
    if (focusTrigger) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDocDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocDown);
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => {
      document.removeEventListener("mousedown", onDocDown);
      clearTimeout(t);
    };
  }, [open]);

  function pick(row: OptionRow) {
    if (row.id === null) {
      onChange("");
      close(true);
      return;
    }
    // 当前候选结果可能是在项目被删除前加载的；选中后先暂停本地快照直显，
    // 由下面的单项目请求确认仍可见后再展示，避免竞态下闪出已删除项目。
    setRecentReady(false);
    setRecent(rememberProject({ id: row.id, code: row.code ?? "", name: row.name }));
    onChange(String(row.id));
    setKeyword("");
    close(true);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.stopPropagation();
      close(true);
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (rows.length === 0) return;
      const delta = e.key === "ArrowDown" ? 1 : -1;
      setActive((cur) => {
        const next = cur + delta;
        if (next < 0) return rows.length - 1;
        if (next >= rows.length) return 0;
        return next;
      });
      return;
    }
    if (e.key === "Enter" && active >= 0 && rows[active]) {
      e.preventDefault();
      pick(rows[active]);
    }
  }

  const triggerLabel = value
    ? resolving
      ? "加载中…"
      : selected
        ? `${selected.code ? `${selected.code} ` : ""}${selected.name}`
        : resolveErr
          ? "项目加载失败"
          : `项目#${value}`
    : allOption
      ? allLabel
      : placeholder;

  return (
    <div className={`${st.picker}${className ? ` ${className}` : ""}`} ref={boxRef}>
      <button
        type="button"
        ref={triggerRef}
        className={st.trigger}
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        title={selected ? `${selected.code} ${selected.name}` : triggerLabel}
      >
        <span className={`${st.triggerText}${value && !selected && !resolving ? ` ${st.placeholder}` : ""}`}>
          {triggerLabel}
        </span>
        <span className={st.caret} aria-hidden="true">▾</span>
      </button>

      {open && (
        <div className={st.pop} role="dialog" aria-label="项目搜索" onKeyDown={onKeyDown}>
          <div className={st.search}>
            <input
              ref={inputRef}
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder={placeholder}
              aria-label="搜索项目关键词"
              role="combobox"
              aria-expanded="true"
              aria-controls="project-picker-options"
              aria-activedescendant={active >= 0 ? `project-option-${rows[active]?.id ?? "all"}` : undefined}
              autoComplete="off"
            />
          </div>

          {error ? (
            <div className={st.state}>
              <div className={st.stateErr} role="alert">{error}</div>
              <button type="button" className={st.retry} onClick={reload} aria-label="重新加载项目列表">重试</button>
            </div>
          ) : firstLoad ? (
            <div className={st.loading} role="status" aria-live="polite" aria-busy="true">
              <span className="sr-only">搜索项目…</span>
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="skel" style={{ height: 32, marginBottom: 8 }} />
              ))}
            </div>
          ) : rows.length === 0 ? (
            <div className={st.state}>
              没有匹配「{debouncedKeyword}」的项目
              <div className={st.stateHint}>换个名称 / 编号 / 客户关键词试试</div>
            </div>
          ) : (
            <ul
              className={st.list}
              id="project-picker-options"
              role="listbox"
              aria-label="项目候选"
            >
              {rows.map((row, i) => (
                <li key={row.id === null ? "__all__" : row.id}>
                  {row.section && rows[i - 1]?.section !== row.section && (
                    <div className={st.section} aria-hidden="true">{row.section}</div>
                  )}
                  <button
                    type="button"
                    role="option"
                    id={`project-option-${row.id ?? "all"}`}
                    aria-selected={row.id !== null && String(row.id) === value}
                    className={`${st.row}${i === active ? ` ${st.rowActive}` : ""}${row.id !== null && String(row.id) === value ? ` ${st.rowOn}` : ""}`}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => pick(row)}
                  >
                    <span className={st.rowName}>{row.name}</span>
                    <span className={st.rowMeta}>
                      {row.code && <span className="mono">{row.code}</span>}
                      {row.hint && <span className={st.rowHint}>{row.hint}</span>}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className={st.foot}>
            <span className={st.scope}>
              {debouncedKeyword ? `关键词「${debouncedKeyword}」· ` : ""}
              共 {total} 个项目 · 第 {page}/{pages} 页
            </span>
            <span className={st.footBtns}>
              <button type="button" className={st.page} disabled={loading || page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))} aria-label="项目上一页">
                上一页
              </button>
              <button type="button" className={st.page} disabled={loading || page >= pages} onClick={() => setPage((p) => p + 1)} aria-label="项目下一页">
                下一页
              </button>
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
