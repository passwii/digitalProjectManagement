/**
 * 事件列表分页（纯函数，node:test 直接钉住边界）。
 *
 * 为什么是「切片分页」而不是 `/alarm` 那套游标分页：
 *   · 事件总数只有 300 量级，而且页面已经拿到了全部行的投影（要按性质 / 状态 / 场景
 *     三层筛选，游标分页会让「筛选后第 3 页」变成一个服务端查询）；
 *   · 需求要的是「翻页能到末页」，页码可跳转，切片分页天然满足。
 *
 * 三条不变量（单测覆盖）：
 *   1. page 永远被 clamp 在 [1, pageCount]，筛选把行数筛少了不会停在空页；
 *   2. 每页条数 ≤ size，首屏因此 ≤ 20 行（验收：首屏行数 ≤ 20）；
 *   3. pageCount 至少为 1（空结果也要渲染「第 1 / 1 页」而不是「第 1 / 0 页」）。
 */
export const EVENT_PAGE_SIZE = 20;

export interface EventPage<T> {
  /** 本页的行 */
  items: T[];
  /** 1-based，已 clamp */
  page: number;
  pageCount: number;
  total: number;
  /** 本页覆盖的区间，1-based 闭区间；空结果时 null */
  range: { from: number; to: number } | null;
}

export function paginate<T>(rows: readonly T[], page: number, size: number = EVENT_PAGE_SIZE): EventPage<T> {
  // 非法每页条数（0 / 负数 / NaN）回落默认值：否则 0 会让整页变空，负数会切出反向区间
  const requested = Math.floor(size);
  const pageSize = Number.isFinite(requested) && requested >= 1 ? requested : EVENT_PAGE_SIZE;
  const total = rows.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(1, Math.floor(page) || 1), pageCount);
  const start = (safePage - 1) * pageSize;
  const end = Math.min(start + pageSize, total);
  return {
    items: rows.slice(start, end),
    page: safePage,
    pageCount,
    total,
    range: total === 0 ? null : { from: start + 1, to: end },
  };
}

/** 页码条：首页 / 末页 / 当前页前后 span 页，中间用 "gap" 省略 */
export type PagerItem = number | "gap";

export function pagerItems(page: number, pageCount: number, span = 1): PagerItem[] {
  const current = Math.min(Math.max(1, page), Math.max(1, pageCount));
  const pages = new Set<number>([1, pageCount]);
  for (let p = current - span; p <= current + span; p++) {
    if (p >= 1 && p <= pageCount) pages.add(p);
  }
  const sorted = Array.from(pages).sort((a, b) => a - b);
  const out: PagerItem[] = [];
  for (const p of sorted) {
    const prev = out[out.length - 1];
    if (typeof prev === "number" && p - prev > 1) out.push("gap");
    out.push(p);
  }
  return out;
}
