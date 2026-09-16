"use client";
/**
 * 审批意见回收（BLF-1093）。
 *
 * 申请人在自己的业务页（成本支出 / 进度跟进）必须能看到「为什么被驳回、谁在什么时候决定」，
 * 而不是只看到一个红色「已驳回」。来源按优先级取：
 *
 * 1. 业务对象自身携带的审批意见字段（Stage 4A 起后端会返回 `reason` / `decision_note` 等）；
 * 2. 该对象的审批通知正文（`type === "approval"` 且 `ref_type`/`ref_id` 命中）——
 *    审批决策时后端会把意见写进通知，所以即使业务对象还没带该字段，申请人也看得到。
 *
 * 只在需要时拉一次有界列表（最近 50 条），并做 id 索引；失败静默降级为「无意见」，
 * 不因为通知接口不可用而挡住支出/任务本身的展示。
 */
import { useMemo } from "react";
import { notificationsApi, type Notification } from "./api";
import { useAsyncData } from "./useAsyncData";

export interface ApprovalNote {
  text: string;
  at: string | null;
  read: boolean;
}

/**
 * 业务对象上可能携带审批意见的字段名（兼容 Stage 4A 前后两套契约）。
 *
 * ⚠️ 不要收录 `note`：支出/预算自身的「说明」就叫 note，那会把业务说明误当成审批意见。
 */
const NOTE_FIELDS = [
  "reason",
  "decision_note",
  "reject_reason",
  "approval_note",
  "approved_note",
] as const;

/** 从业务对象里取审批意见：只在字段确实存在且非空时采用 */
export function noteFromObject(obj: unknown): string {
  if (!obj || typeof obj !== "object") return "";
  const rec = obj as Record<string, unknown>;
  for (const f of NOTE_FIELDS) {
    const v = rec[f];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

function keyOf(refType: string, refId: number | null | undefined): string {
  return `${refType}:${refId ?? ""}`;
}

/** 最近通知条数上界：审批意见只关心最近的决策，不必无界拉取 */
const NOTE_WINDOW = 50;

export function useApprovalNotes() {
  const { data } = useAsyncData(
    async (signal) => {
      const r = await notificationsApi.list(`?size=${NOTE_WINDOW}`, signal);
      return r.items ?? [];
    },
    [],
  );

  const notes = useMemo(() => {
    const map = new Map<string, ApprovalNote>();
    for (const n of (data ?? []) as Notification[]) {
      if (n.type !== "approval") continue;
      const text = (n.body || "").trim();
      if (!text) continue;
      const k = keyOf(n.ref_type, n.ref_id);
      // 列表按时间倒序，第一条即最新决策意见
      if (!map.has(k)) map.set(k, { text, at: n.created_at, read: n.read });
    }
    return map;
  }, [data]);

  /** 取某个业务对象的审批意见：优先对象自带字段，其次审批通知正文 */
  const noteFor = (
    refType: string,
    refId: number | null | undefined,
    obj?: unknown,
  ): ApprovalNote | null => {
    const own = noteFromObject(obj);
    if (own) return { text: own, at: null, read: true };
    return notes.get(keyOf(refType, refId)) ?? null;
  };

  /** 该业务对象的审批意见是否尚未读（用于「新意见」提示） */
  const hasUnread = (refType: string, refId: number | null | undefined) => {
    const n = notes.get(keyOf(refType, refId));
    return !!n && !n.read;
  };

  return { noteFor, hasUnread, notes };
}
