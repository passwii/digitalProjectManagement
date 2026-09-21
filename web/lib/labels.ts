// 枚举中文映射与格式化工具（与 api/seed.py DICTS、后端状态码对齐）
import type { BadgeTone } from "../components/ui/Badge";

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

export const PROJECT_OWNERS = [
  "张爱杰", "张玉军", "段佳奕", "段佳雷", "李智",
  "朱成龙", "张涛", "田孝通", "李润康", "薛凡",
] as const;

export const EXPENSE_PEOPLE = PROJECT_OWNERS;
export const CONTRACT_STATUSES = ["已签订", "未签订"] as const;

/** 合同状态同时兼容历史接口可能返回的英文值；提交时仍使用后端约定的原始值。 */
export const CONTRACT_STATUS: Record<string, string> = {
  signed: "已签订",
  contracted: "已签订",
  unsigned: "未签订",
  uncontracted: "未签订",
  已签订: "已签订",
  未签订: "未签订",
};

/** 变更留痕里的字段名映射，避免把后端字段名直接暴露给用户。 */
export const PROJECT_CHANGE_FIELD_LABELS: Record<string, string> = {
  code: "项目编号",
  name: "项目名称",
  type: "项目类型",
  dept_id: "所属部门",
  owner_id: "负责人编号",
  owner_name: "项目负责人",
  plan_start: "计划开始日期",
  plan_end: "计划结束日期",
  budget_total: "合同金额",
  priority: "优先级",
  client: "客户 / 委托方",
  client_contact: "客户联系人",
  client_phone: "联系方式",
  description: "项目简介",
  contract_status: "合同状态",
  status: "项目状态",
  member_ids: "项目成员",
  members: "项目成员",
  progress_snapshot: "进度快照",
};
export const FOLLOWUP_METHODS = ["电话", "会议", "现场", "邮件", "其他"];

export const PRIORITIES = ["高", "中", "低"];

export const PROJECT_TYPES = ["研发", "实施", "咨询", "工程"];

export function projectStatusLabel(code: string | null | undefined): string {
  const raw = typeof code === "string" ? code.trim() : "";
  return raw ? (PROJECT_STATUS[raw] ?? raw) : "-";
}

export function contractStatusLabel(code: string | null | undefined): string {
  const raw = typeof code === "string" ? code.trim() : "";
  return raw ? (CONTRACT_STATUS[raw] ?? raw) : "-";
}

export function isKnownContractStatus(code: string | null | undefined): boolean {
  const raw = typeof code === "string" ? code.trim() : "";
  return raw in CONTRACT_STATUS;
}

/** 变更记录字段名的展示文案；未知字段保留原值，便于追溯新接口字段。 */
export function projectChangeFieldLabel(
  field: string | null | undefined,
): string {
  const raw = field?.trim();
  if (!raw) return "未知字段";
  return PROJECT_CHANGE_FIELD_LABELS[raw] ?? raw;
}

/**
 * 变更记录值的展示文案。
 * 仅转换展示层状态值，不修改 ProjectChange 的原始响应，也不影响后续请求参数。
 */
export function projectChangeValueLabel(
  field: string | null | undefined,
  value: string | null | undefined,
): string {
  if (value == null || value.trim() === "") return "空";
  const rawField = field?.trim();
  if (rawField === "status") return projectStatusLabel(value);
  if (rawField === "contract_status") return contractStatusLabel(value);
  return value;
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
