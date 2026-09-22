const RESOURCE_LABELS: Record<string, string> = {
  auth: "认证",
  projects: "项目",
  attachments: "附件",
  followups: "跟进事项",
  tasks: "任务",
  milestones: "里程碑",
  progress_logs: "进度日志",
  contact_profiles: "联系人",
  partners: "友商",
  partner_contracts: "友商业绩合同",
  opportunities: "商机",
  budgets: "预算",
  budget_adjusts: "预算调整",
  expenses: "支出",
  vouchers: "凭证",
  voucher: "凭证",
  voucher_template: "凭证模板",
  cash_transaction: "现金流水",
  fixed_asset: "固定资产",
  fixed_assets: "固定资产",
  arap_transactions: "往来交易",
  bank_statements: "银行流水",
  bank_statement: "银行流水",
  accounting_period: "会计期间",
  account_book: "账套",
  account_book_members: "账套成员",
  account: "会计科目",
  account_auxiliary: "科目辅助核算",
  auxiliary_item: "辅助核算项",
  users: "用户",
  dicts: "字典",
  sys_params: "系统参数",
  audit_logs: "审计日志",
};

const ACTION_LABELS: Record<string, string> = {
  login: "登录",
  login_fail: "登录失败",
  logout: "登出",
  change_password: "修改密码",
  create_user: "创建用户",
  update_user: "更新用户",
  toggle_demo_data: "切换演示数据",
  create_dict: "创建字典项",
  set_params: "更新系统参数",
  export_logs: "导出审计日志",
  create_project: "创建项目",
  update_project: "更新项目",
  project_status: "变更项目状态",
  upload_attachment: "上传附件",
  download_attachment: "下载附件",
  delete_attachment: "删除附件",
  set_members: "调整项目成员",
  delete_project: "删除项目",
  restore_project: "恢复项目",
  create_followup: "创建跟进事项",
  update_followup: "更新跟进事项",
  handle_followup_remind: "处理跟进提醒",
  delete_followup: "删除跟进事项",
  confirm_progress: "确认项目进度",
  create_task: "创建任务",
  update_task: "更新任务",
  delete_task: "删除任务",
  report_progress: "填报进度",
  import_tasks: "导入任务",
  create_milestone: "创建里程碑",
  update_milestone: "更新里程碑",
  delete_milestone: "删除里程碑",
  create_contact: "创建联系人",
  update_contact: "更新联系人",
  upload_contact_attachment: "上传联系人附件",
  download_contact_attachment: "下载联系人附件",
  delete_contact_attachment: "删除联系人附件",
  create_partner: "创建友商",
  update_partner: "更新友商",
  delete_partner: "删除友商",
  create_partner_contract: "创建友商业绩合同",
  update_partner_contract: "更新友商业绩合同",
  delete_partner_contract: "删除友商业绩合同",
  upload_partner_attachment: "上传友商附件",
  download_partner_attachment: "下载友商附件",
  delete_partner_attachment: "删除友商附件",
  create_opportunity: "创建商机",
  update_opportunity: "更新商机",
  delete_opportunity: "删除商机",
  create_budget: "创建预算",
  adjust_budget: "调整预算",
  approve_adjust: "审核预算调整",
  approve_filing: "审核项目立项",
  decide_adjust: "审批预算调整",
  decide_expense: "审批支出",
  exception_expense: "特批支出",
  create_expense: "创建支出",
  approve_expense: "通过支出审批",
  reject_expense: "驳回支出审批",
  resubmit_expense: "重新提交支出",
  upload_expense_voucher: "上传支出凭证",
  download_expense_voucher: "下载支出凭证",
  delete_expense_voucher: "删除支出凭证",
  create_cash_transaction: "创建现金流水",
  create_fixed_asset: "创建固定资产",
  create_arap: "创建往来交易",
  apply_arap: "核销往来交易",
  depreciate_fixed_assets: "计提固定资产折旧",
  import_bank_statements: "导入银行流水",
  match_bank_statement: "匹配银行流水",
  import_vouchers: "导入凭证",
  export_vouchers: "导出凭证",
  upsert_finance_member: "更新账套成员",
  remove_finance_member: "移除账套成员",
  reverse_close: "反结账",
};

const GENERIC_ACTIONS: Record<string, string> = {
  create: "创建",
  update: "更新",
  delete: "删除",
  submit: "提交",
  approve: "审核通过",
  reject: "驳回",
  post: "过账",
  void: "作废",
  reverse: "冲销",
  close: "结账",
};

const DETAIL_KEY_LABELS: Record<string, string> = {
  project: "项目",
  task: "任务",
  voucher: "凭证",
  period: "期间",
  book: "账套",
  role: "角色",
  category: "分类",
  state: "状态",
  reason: "原因",
  count: "数量",
  created: "已创建",
  amount: "金额",
  active: "启用状态",
  tasks: "任务数",
  snapshot: "进度快照",
  demo_data_on: "演示数据",
};

const DETAIL_FIELD_LABELS: Record<string, string> = {
  username: "登录账号",
  real_name: "姓名",
  dept_id: "部门",
  password: "密码",
  status: "状态",
  roles: "角色",
  role: "角色",
  name: "名称",
  code: "编码",
  label: "显示名",
  value: "值",
  budget_total: "预算总额",
  member_ids: "项目成员",
};

const STATUS_LABELS: Record<string, string> = {
  draft: "草稿",
  pending: "待审批",
  filed: "已立项",
  doing: "进行中",
  paused: "暂停",
  done: "已完成",
  archived: "已归档",
  cancelled: "已取消",
  approved: "已通过",
  rejected: "已驳回",
  exception: "特批通过",
  active: "启用",
  disabled: "停用",
  open: "开启",
  closed: "关闭",
};

const BUSINESS_VALUE_ACTIONS = new Set([
  "create_project",
  "create_user",
  "create_contact",
  "update_contact",
  "create_partner",
  "update_partner",
  "create_opportunity",
  "update_opportunity",
  "create_milestone",
  "delete_milestone",
  "create_task",
  "delete_task",
  "delete_project",
  "restore_project",
  "upload_attachment",
  "download_attachment",
  "delete_attachment",
  "upload_contact_attachment",
  "download_contact_attachment",
  "delete_contact_attachment",
  "upload_partner_attachment",
  "download_partner_attachment",
  "delete_partner_attachment",
  "upload_expense_voucher",
  "download_expense_voucher",
  "delete_expense_voucher",
]);

function clean(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function statusLabel(value: string): string {
  return STATUS_LABELS[value] ?? value;
}

function valueLabel(key: string, value: string): string {
  if (key === "active" || key === "demo_data_on") {
    return value === "1" || value.toLowerCase() === "true" ? "已开启" : "已关闭";
  }
  if (key === "status" || key === "state") return statusLabel(value);
  return value;
}

function formatPairs(detail: string): string | null {
  const parts = detail.split(",").map((part) => part.trim()).filter(Boolean);
  if (!parts.length || !parts.every((part) => /^[a-z_]+\s*=/.test(part))) return null;

  return parts
    .map((part) => {
      const separator = part.indexOf("=");
      const key = part.slice(0, separator).trim();
      const value = part.slice(separator + 1).trim();
      const label = DETAIL_KEY_LABELS[key];
      return label ? `${label}：${valueLabel(key, value)}` : null;
    })
    .filter((part): part is string => Boolean(part))
    .join("；") || null;
}

function formatFieldList(detail: string): string | null {
  if (!/^\[.*\]$/.test(detail)) return null;
  const fields = [...detail.matchAll(/['"]([^'"]+)['"]/g)]
    .map((match) => DETAIL_FIELD_LABELS[match[1]] ?? match[1]);
  return fields.length ? `更新字段：${fields.join("、")}` : null;
}

function formatTransition(detail: string, action: string): string | null {
  const match = detail.match(/^(?:(snapshot)\s+)?([^\s]+)->([^\s]+)(?:\s+(.+))?$/);
  if (!match) return null;
  const [, prefix, from, to, reason] = match;
  const head = prefix ? "进度快照：" : "";
  const isStatusChange = action === "project_status" || action.includes("status");
  const valueHead = isStatusChange ? "状态" : "值";
  const text = `${head}原${valueHead}：${statusLabel(from)} → 新${valueHead}：${statusLabel(to)}`;
  return reason ? `${text}；${reason}` : text;
}

export function auditResourceLabel(resource: string): string {
  const raw = clean(resource);
  return raw ? RESOURCE_LABELS[raw] ?? "其他资源" : "其他资源";
}

export function auditActionLabel(action: string, resource = ""): string {
  const rawAction = clean(action);
  if (ACTION_LABELS[rawAction]) return ACTION_LABELS[rawAction];
  const generic = GENERIC_ACTIONS[rawAction];
  if (generic) return `${generic}${auditResourceLabel(resource)}`;
  return "其他操作";
}

export function auditResourceDisplay(resource: string, resourceId?: string | null): string {
  const label = auditResourceLabel(resource);
  const id = clean(resourceId);
  return id ? `${label} #${id}` : label;
}

export function auditDetailLabel(action: string, resource: string, detail: string): string {
  const raw = clean(detail);
  if (!raw) return "操作详情已记录";

  const transition = formatTransition(raw, clean(action));
  if (transition) return transition;

  const pairs = formatPairs(raw);
  if (pairs) return pairs;

  const fields = formatFieldList(raw);
  if (fields) return fields;

  if (raw === "demo_data_on=1") return "演示数据：已开启";
  if (raw === "demo_data_on=0") return "演示数据：已关闭";
  if (raw === "delete draft voucher") return "删除草稿凭证";
  if (raw.startsWith("approve ")) return `审核通过：${raw.slice("approve ".length)}`;
  if (raw.startsWith("reject ")) return `驳回：${raw.slice("reject ".length)}`;
  if (raw.endsWith(" auto")) return `${raw.slice(0, -5).trim()}；自动生效`;
  if (/[\u3400-\u9fff]/.test(raw) || BUSINESS_VALUE_ACTIONS.has(clean(action))) return raw;

  return "操作详情已记录";
}
