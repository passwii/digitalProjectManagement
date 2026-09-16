// 枚举中文映射与格式化工具（与 api/seed.py DICTS、后端状态码对齐）
import type { BadgeTone } from "@/components/ui/Badge";

export const PROJECT_STATUS: Record<string, string> = {
  draft: "草稿",
  pending: "待立项审批",
  filed: "已立项",
  doing: "进行中",
  paused: "暂停",
  done: "已完成",
  archived: "已归档",
  cancelled: "已取消",
};

/** 状态机：当前状态可流转到的下一状态（与 api/routers/projects.py TRANSITIONS 一致） */
export const PROJECT_FLOW: Record<string, string[]> = {
  draft: ["pending", "filed", "cancelled"],
  pending: ["filed", "cancelled"],
  filed: ["doing", "cancelled"],
  doing: ["paused", "done"],
  paused: ["doing", "done"],
  done: ["archived"],
  archived: ["doing"],
  cancelled: [],
};

export const TASK_STATUS: Record<string, string> = {
  todo: "未开始",
  doing: "进行中",
  done: "已完成",
  paused: "暂停",
};

export const EXPENSE_STATUS: Record<string, string> = {
  pending: "待审批",
  approved: "已通过",
  rejected: "已驳回",
  exception: "特批通过",
};

export const TASK_STATUS_ORDER = ["todo", "doing", "paused", "done"];

export const SUBJECTS = ["人工", "采购", "外包", "差旅", "其他"];

export const FOLLOWUP_METHODS = ["电话", "会议", "现场", "邮件", "其他"];

export const PRIORITIES = ["高", "中", "低"];

export const PROJECT_TYPES = ["研发", "实施", "咨询", "工程"];

export function projectStatusLabel(code: string): string {
  return PROJECT_STATUS[code] ?? code ?? "-";
}

export function taskStatusLabel(code: string): string {
  return TASK_STATUS[code] ?? code ?? "-";
}

export function expenseStatusLabel(code: string): string {
  return EXPENSE_STATUS[code] ?? code ?? "-";
}

export function projectTone(code: string): BadgeTone {
  switch (code) {
    case "done":
    case "archived":
      return "done";
    case "doing":
    case "filed":
      return "doing";
    case "pending":
      return "warn";
    case "paused":
    case "draft":
      return "paused";
    case "cancelled":
      return "danger";
    default:
      return "todo";
  }
}

export function taskTone(code: string, overdue = false): BadgeTone {
  if (overdue) return "danger";
  switch (code) {
    case "done":
      return "done";
    case "doing":
      return "doing";
    case "paused":
      return "paused";
    default:
      return "todo";
  }
}

export function expenseTone(code: string): BadgeTone {
  switch (code) {
    case "approved":
    case "exception":
      return "done";
    case "rejected":
      return "danger";
    case "pending":
      return "warn";
    default:
      return "todo";
  }
}

export const fmtMoney = (n?: number | null) =>
  n == null ? "-" : n.toLocaleString("zh-CN", { maximumFractionDigits: 2 });

export const fmtPct = (r?: number | null) =>
  r == null ? "-" : `${(r * 100).toFixed(1)}%`;

export const fmtDate = (s?: string | null) => (s ? s.slice(0, 10) : "-");

export const fmtDateTime = (s?: string | null) =>
  s ? s.replace("T", " ").slice(0, 16) : "-";

export const todayISO = () => new Date().toISOString().slice(0, 10);

export function isOverdueTask(t: { plan_end: string | null; progress: number; status: string }): boolean {
  if (!t.plan_end || t.status === "done" || (t.progress ?? 0) >= 100) return false;
  return t.plan_end < todayISO();
}
