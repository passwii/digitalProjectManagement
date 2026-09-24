export const PERMISSION_ROLES = [
  { name: "超级管理员", description: "拥有全部模块权限，仅总部核心成员", members: 1 },
  { name: "区域总监（苏州）", description: "负责苏州片区多家门店的经营与审批", members: 4 },
  { name: "门店店长", description: "本门店人员、设备、营销、报表管理", members: 3 },
  { name: "运维工程师", description: "算力、网络、终端的监控与故障处理", members: 2 },
  { name: "财务专员", description: "收银对账、发票、分账与成本分析", members: 1 },
  { name: "内容运营", description: "游戏上架、赛事组织、内容审核", members: 1 },
  { name: "安全审计员", description: "日志审计、策略配置、监管对接", members: 1 },
  { name: "前台收银", description: "收银开卡、充值、商品销售", members: 2 },
] as const;

export type SparkRoleName = (typeof PERMISSION_ROLES)[number]["name"];

export interface SparkMember {
  id: string;
  name: string;
  email: string;
  role: SparkRoleName;
  store: string;
  phone: string;
  lastLogin: string;
  enabled: boolean;
}

export const PERMISSION_MODULES = ["运营总览", "门店管理", "算力调度", "计费收银", "内容赛事", "安全合规", "运维工单", "监管对接"] as const;

export const ROLE_PERMISSION_MATRIX: Record<SparkRoleName, Record<(typeof PERMISSION_MODULES)[number], string>> = {
  "超级管理员": { "运营总览": "审批", "门店管理": "审批", "算力调度": "审批", "计费收银": "审批", "内容赛事": "审批", "安全合规": "审批", "运维工单": "审批", "监管对接": "审批" },
  "区域总监（苏州）": { "运营总览": "审批", "门店管理": "审批", "算力调度": "编辑", "计费收银": "审批", "内容赛事": "编辑", "安全合规": "查看", "运维工单": "编辑", "监管对接": "查看" },
  "门店店长": { "运营总览": "查看", "门店管理": "编辑", "算力调度": "查看", "计费收银": "编辑", "内容赛事": "编辑", "安全合规": "查看", "运维工单": "查看", "监管对接": "—" },
  "运维工程师": { "运营总览": "查看", "门店管理": "查看", "算力调度": "编辑", "计费收银": "—", "内容赛事": "查看", "安全合规": "查看", "运维工单": "编辑", "监管对接": "—" },
  "财务专员": { "运营总览": "查看", "门店管理": "查看", "算力调度": "—", "计费收银": "编辑", "内容赛事": "—", "安全合规": "查看", "运维工单": "查看", "监管对接": "查看" },
  "内容运营": { "运营总览": "查看", "门店管理": "查看", "算力调度": "—", "计费收银": "—", "内容赛事": "编辑", "安全合规": "查看", "运维工单": "查看", "监管对接": "—" },
  "安全审计员": { "运营总览": "查看", "门店管理": "查看", "算力调度": "查看", "计费收银": "查看", "内容赛事": "查看", "安全合规": "编辑", "运维工单": "查看", "监管对接": "编辑" },
  "前台收银": { "运营总览": "—", "门店管理": "查看", "算力调度": "—", "计费收银": "编辑", "内容赛事": "—", "安全合规": "—", "运维工单": "—", "监管对接": "—" },
};

export const PERMISSION_MEMBERS: SparkMember[] = [
  { id: "U001", name: "陆景明", email: "lu.jm@nebulacloud.cn", role: "超级管理员", store: "苏州总部", phone: "138****6601", lastLogin: "2026-06-08 22:18", enabled: true },
  { id: "U002", name: "陈景舟", email: "chen.jz@nebulacloud.cn", role: "区域总监（苏州）", store: "姑苏区 / 吴中区", phone: "138****6602", lastLogin: "2026-06-08 21:42", enabled: true },
  { id: "U003", name: "韩沐辰", email: "han.mc@nebulacloud.cn", role: "区域总监（苏州）", store: "工业园区 / 昆山", phone: "138****6603", lastLogin: "2026-06-08 22:05", enabled: true },
  { id: "U004", name: "秦朗", email: "qin.l@nebulacloud.cn", role: "区域总监（苏州）", store: "高新区 / 相城", phone: "138****6604", lastLogin: "2026-06-08 20:26", enabled: true },
  { id: "U005", name: "卢思远", email: "lu.sy@nebulacloud.cn", role: "区域总监（苏州）", store: "吴江 / 常熟 / 张家港 / 太仓", phone: "138****6605", lastLogin: "2026-06-08 19:48", enabled: true },
  { id: "U006", name: "顾云舟", email: "gu.yz@nebulacloud.cn", role: "门店店长", store: "李公堤湖景店", phone: "138****6606", lastLogin: "2026-06-08 22:12", enabled: true },
  { id: "U007", name: "江慕白", email: "jiang.mb@nebulacloud.cn", role: "门店店长", store: "昆山金鹰旗舰店", phone: "138****6607", lastLogin: "2026-06-08 22:25", enabled: true },
  { id: "U008", name: "高启明", email: "gao.qm@nebulacloud.cn", role: "运维工程师", store: "苏州总部 · 网络组", phone: "138****6608", lastLogin: "2026-06-08 22:20", enabled: true },
  { id: "U009", name: "宋知远", email: "song.zy@nebulacloud.cn", role: "运维工程师", store: "苏州 IDC", phone: "138****6609", lastLogin: "2026-06-08 21:50", enabled: true },
  { id: "U010", name: "孟雪", email: "meng.x@nebulacloud.cn", role: "财务专员", store: "苏州总部 · 财务", phone: "138****6610", lastLogin: "2026-06-08 18:22", enabled: true },
  { id: "U011", name: "方景", email: "fang.j@nebulacloud.cn", role: "内容运营", store: "苏州总部 · 内容", phone: "138****6611", lastLogin: "2026-06-08 20:08", enabled: true },
  { id: "U012", name: "钟予安", email: "zhong.ya@nebulacloud.cn", role: "安全审计员", store: "苏州总部 · 安全", phone: "138****6612", lastLogin: "2026-06-08 22:28", enabled: true },
  { id: "U013", name: "赵子昂", email: "zhao.za@nebulacloud.cn", role: "门店店长", store: "石路中心店", phone: "138****6613", lastLogin: "2026-06-08 19:36", enabled: true },
  { id: "U014", name: "何一凡", email: "he.yf@nebulacloud.cn", role: "前台收银", store: "石路中心店", phone: "138****6614", lastLogin: "2026-06-08 20:30", enabled: true },
  { id: "U015", name: "周予安", email: "zhou.ya2@nebulacloud.cn", role: "前台收银", store: "独墅湖高校店", phone: "138****6615", lastLogin: "2026-06-08 21:18", enabled: false },
];

export const PERMISSION_AUDIT_LOGS = [
  { time: "22:28:14", user: "钟予安", action: "登录控制台", location: "苏州 · 180.114.**.**", result: "成功" },
  { time: "22:25:02", user: "江慕白", action: "退款审批 ¥186", location: "昆山 · 117.86.**.**", result: "成功" },
  { time: "22:20:18", user: "高启明", action: "修改核心交换机配置", location: "苏州总部 · 10.0.1.18", result: "成功" },
  { time: "22:18:42", user: "陆景明", action: "导出苏州全域财务报表", location: "苏州总部 · 10.0.1.12", result: "成功" },
  { time: "21:42:08", user: "陈景舟", action: "调整观前街店计费规则", location: "姑苏 · 180.114.**.**", result: "成功" },
  { time: "20:18:24", user: "未知账号", action: "尝试登录 admin", location: "境外 IP", result: "已阻断" },
  { time: "18:22:16", user: "孟雪", action: "开具电子发票 186 张", location: "苏州总部 · 10.0.1.24", result: "成功" },
] as const;
