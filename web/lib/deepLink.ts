"use client";
/**
 * 通知深链定位（BLF-1093）。
 *
 * 通知上带有 `ref_type` / `ref_id` / `project_id` 三件套，点击后必须落到**具体业务对象**，
 * 而不是把用户丢回模块首页自己找。这里集中放三件事：
 *
 * 1. 目标参数的读写（`?task=12` / `?milestone=3` / `?expense=8` / `?followup=5` / `?adjust=2`）；
 * 2. 「目标不在当前页」时的上界定位：用一次 size=100 的查询算出它落在第几页，
 *    再让页面跳到那一页——查询次数有上界，不会因为目标不存在而无限翻页；
 * 3. 行高亮 + 滚动入视口，以及「目标已不存在」的统一文案。
 */
import { useEffect, useRef } from "react";
import type { Paged } from "./api";

/** URL 里的定位参数名（与通知 ref_type 一一对应） */
export const TARGET_KEY = {
  task: "task",
  milestone: "milestone",
  expense: "expense",
  followup: "followup",
  adjust: "adjust",
} as const;

export type TargetKey = (typeof TARGET_KEY)[keyof typeof TARGET_KEY];

/**
 * 定位查询的窗口大小。目标可能落在任意一页，用服务端上界（100）一次拿到，
 * 在窗口内找得到就跳到它的真实页码；找不到即可判定「已不存在或超出窗口」。
 */
export const LOCATE_PAGE_SIZE = 100;

/** 解析 URL 中的定位参数为正整数 id；空/非法 → 0（表示无定位） */
export function parseTarget(value?: string | null): number {
  if (value === null || value === undefined || value === "") return 0;
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const i = Math.trunc(n);
  return i > 0 ? i : 0;
}

/** 行是否命中当前定位目标 */
export function isTargetRow(id: number, target: number): boolean {
  return target > 0 && id === target;
}

/**
 * 在「定位窗口」里查找目标，返回它所在的页码（按目标页大小换算）。
 *
 * @param fetchWindow 拉取窗口（page=1, size=LOCATE_PAGE_SIZE）
 * @param target      目标 id
 * @param pageSize    当前页大小（用于把窗口下标换算成页码）
 * @returns 页码；`null` 表示窗口内没有这个目标
 */
export async function locateTargetPage(
  fetchWindow: (page: number, size: number) => Promise<Paged<{ id: number }>>,
  target: number,
  pageSize: number,
): Promise<number | null> {
  if (!target || pageSize < 1) return null;
  const win = await fetchWindow(1, Math.max(pageSize, LOCATE_PAGE_SIZE));
  const idx = win.items.findIndex((x) => x.id === target);
  if (idx < 0) return null;
  return Math.floor(idx / pageSize) + 1;
}

/** 目标不存在时的统一说明（区分「被删除」与「无权限」，避免用户以为系统坏了） */
export function missingTargetText(label: string, total: number): string {
  return total === 0
    ? `该${label}可能已被删除，或您已不在可见范围内。`
    : `该${label}不在可见范围内（已检查最近 ${LOCATE_PAGE_SIZE} 条，共 ${total} 条），可能已被删除。`;
}

/**
 * 命中行滚动入视口并聚焦，保证键盘用户也能看见定位结果。
 * 只在目标变化时执行一次，避免每次重渲染都抢滚动位置。
 */
export function useTargetScroll(target: number, ready: boolean) {
  const doneRef = useRef(0);
  useEffect(() => {
    if (!target || !ready || doneRef.current === target) return;
    const el = document.querySelector<HTMLElement>(`[data-target-id="${target}"]`);
    if (!el) return;
    doneRef.current = target;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    // 行本身不可聚焦，交给其中的操作按钮，键盘用户 Tab 时能立刻到达定位行
    el.querySelector<HTMLElement>("button, a, input, select")?.focus({ preventScroll: true });
  }, [target, ready]);
}

/** 给命中行加上统一的高亮类名（配合 globals.css 的 .row-target） */
export function rowClass(base: string | undefined, hit: boolean): string {
  return [base, hit ? "row-target" : ""].filter(Boolean).join(" ");
}
