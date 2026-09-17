"use client";
// 列表分页统一组件：页码/每页条数通过单次 onChange 上报，
// 并在组件内部保证「每页条数变化 → 回到第 1 页」「总数变小 → 页码收敛到末页」
// 等边界行为一致（BLF-1095）。服务端 size 上限默认 100。
import { useEffect, useRef } from "react";
import st from "./Pagination.module.css";

export interface PaginationChange {
  page: number;
  size: number;
}

export const DEFAULT_SIZE_OPTIONS = [20, 50, 100];

export default function Pagination({
  page,
  size,
  total,
  onChange,
  sizeOptions = DEFAULT_SIZE_OPTIONS,
  maxSize = 100,
  loading = false,
  scopeText,
  ariaLabel = "列表分页",
}: {
  page: number;
  size: number;
  total: number;
  onChange: (next: PaginationChange) => void;
  sizeOptions?: number[];
  maxSize?: number;
  loading?: boolean;
  /** 当前范围说明，如「关键词「改造」· 状态=进行中」 */
  scopeText?: string;
  ariaLabel?: string;
}) {
  const pages = Math.max(1, Math.ceil(total / Math.max(size, 1)));
  const safePage = Math.min(Math.max(page, 1), pages);
  const from = total === 0 ? 0 : (safePage - 1) * size + 1;
  const to = Math.min(safePage * size, total);

  const options = Array.from(new Set([...sizeOptions, size]))
    .filter((s) => s > 0 && s <= Math.max(maxSize, size))
    .sort((a, b) => a - b);

  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // 边界收敛：请求越界页码（或总数变小导致当前页失效）时回到合法页码
  useEffect(() => {
    if (page !== safePage) onChangeRef.current({ page: safePage, size });
  }, [page, safePage, size]);

  const showSize = options.length > 1 && total > options[0];

  return (
    <nav className={st.wrap} aria-label={ariaLabel} aria-busy={loading}>
      <span className={st.info}>
        共 <b className="mono">{total}</b> 条，当前 <span className="mono">{from}-{to}</span>
        {scopeText && <span className={st.scope}>· {scopeText}</span>}
        {loading && <span className={st.busy}>更新中…</span>}
      </span>
      <div className={st.right}>
        {showSize && (
          <select
            className={st.size}
            value={size}
            onChange={(e) => onChange({ page: 1, size: Number(e.target.value) })}
            aria-label="每页条数"
          >
            {options.map((s) => (
              <option key={s} value={s}>{s} 条/页</option>
            ))}
          </select>
        )}
        <button
          type="button"
          className={st.btn}
          disabled={loading || safePage <= 1}
          onClick={() => onChange({ page: 1, size })}
          aria-label="首页"
          title="首页"
        >
          «
        </button>
        <button
          type="button"
          className={st.btn}
          disabled={loading || safePage <= 1}
          onClick={() => onChange({ page: safePage - 1, size })}
          aria-label="上一页"
        >
          上一页
        </button>
        <span className={st.page}>
          <span className="mono">{safePage}</span> / <span className="mono">{pages}</span>
        </span>
        <button
          type="button"
          className={st.btn}
          disabled={loading || safePage >= pages}
          onClick={() => onChange({ page: safePage + 1, size })}
          aria-label="下一页"
        >
          下一页
        </button>
        <button
          type="button"
          className={st.btn}
          disabled={loading || safePage >= pages}
          onClick={() => onChange({ page: pages, size })}
          aria-label="末页"
          title="末页"
        >
          »
        </button>
      </div>
    </nav>
  );
}
