"use client";
// 支出行的审批操作：显示条件与后端契约一致 —— 仅管理员（can_approve）且仅待审批支出。
// 非管理员看到的是明确的“待管理员审批”状态，而不是必然 403 的按钮。
import type { Expense } from "@/lib/api";

export type ExpenseActKind = "approve" | "reject" | "exception";
export interface ExpenseAct {
  kind: ExpenseActKind;
  expense: Expense;
}

export default function ExpenseActions({
  expense,
  canApprove,
  onAct,
}: {
  expense: Expense;
  canApprove: boolean;
  onAct: (act: ExpenseAct) => void;
}) {
  if (expense.status !== "pending") return null;

  if (!canApprove) {
    return (
      <span className="muted tiny" title="支出审批仅管理员可操作">
        待管理员审批
      </span>
    );
  }

  return (
    <span className="table-actions">
      <button className="btn-ghost btn-xs" onClick={() => onAct({ kind: "approve", expense })}>
        通过
      </button>
      <button className="btn-ghost btn-xs btn-danger-outline" onClick={() => onAct({ kind: "reject", expense })}>
        驳回
      </button>
      <button
        className="btn-ghost btn-xs btn-danger-outline"
        onClick={() => onAct({ kind: "exception", expense })}
      >
        特批放行
      </button>
    </span>
  );
}
