export type SparkTicketStatus = "待派单" | "处理中" | "已解决" | "已关闭";

export interface SparkTicket {
  id: string;
  priority: "P0" | "P1" | "P2" | "P3";
  title: string;
  description: string;
  status: SparkTicketStatus;
  store: string;
  category: string;
  assignee: string;
  created: string;
  sla: string;
}

export const OPS_METRICS = [
  { label: "今日工单总数", value: "8", unit: "单", tone: "cyan", icon: "ops" },
  { label: "待派单", value: "2", unit: "单", tone: "amber", icon: "ops" },
  { label: "处理中", value: "3", unit: "单", tone: "violet", icon: "ops" },
  { label: "按时解决率", value: "98.6", unit: "%", tone: "green", icon: "dashboard" },
] as const;

export const OPS_SUBSYSTEMS = [
  { name: "算力调度系统", score: 96, health: "优秀" },
  { name: "云边端基础设施", score: 98, health: "优秀" },
  { name: "计费收银系统", score: 94, health: "优秀" },
  { name: "内容分发与赛事", score: 92, health: "良好" },
  { name: "安全合规系统", score: 99, health: "优秀" },
  { name: "网络与电力", score: 90, health: "良好" },
] as const;

export const OPS_TICKETS: SparkTicket[] = [
  { id: "TK20260608024", priority: "P0", title: "核心交换机光模块衰减，链路冗余切换", description: "光模块接收功率 -28dBm，已自动切至备用链路，需现场更换。", status: "处理中", store: "昆山金鹰旗舰店", category: "网络故障", assignee: "苏州网络组 · 高启明", created: "22:14", sla: "剩余 18 分钟" },
  { id: "TK20260608023", priority: "P1", title: "GPU-07 节点温度过高 87°C", description: "液冷流量偏低，已启动增压，需排查冷板。", status: "处理中", store: "观前街旗舰店", category: "硬件告警", assignee: "IDC 运维 · 宋知远", created: "21:48", sla: "剩余 1 小时 42 分" },
  { id: "TK20260608022", priority: "P1", title: "市电瞬时中断，UPS 已接管", description: "市电中断 2.4 秒后恢复，UPS 供电正常，建议排查市电稳定性。", status: "待派单", store: "相城元和中翔店", category: "电力故障", assignee: "待派单", created: "20:30", sla: "剩余 2 小时" },
  { id: "TK20260608021", priority: "P2", title: "收银台打印机卡纸无法出票", description: "热敏打印机进纸异常，已尝试重启。", status: "处理中", store: "石路中心店", category: "外设故障", assignee: "苏州现场组 · 何一凡", created: "20:12", sla: "剩余 3 小时" },
  { id: "TK20260608020", priority: "P2", title: "电竞酒店房态系统不同步", description: "OTA 平台与前台 PMS 房态延迟约 5 分钟。", status: "待派单", store: "李公堤湖景店", category: "软件异常", assignee: "待派单", created: "19:24", sla: "剩余 4 小时" },
  { id: "TK20260608019", priority: "P3", title: "瘦终端 B-031 开机无显示", description: "DP 线材松动，重新插拔后恢复。", status: "已解决", store: "相城天虹旗舰店", category: "终端故障", assignee: "苏州现场组 · 唐佳", created: "16:08", sla: "已按时解决" },
  { id: "TK20260608018", priority: "P3", title: "游戏《APEX》更新包分发慢", description: "边缘节点缓存未命中，手动预热后恢复。", status: "已解决", store: "吴江万象汇店", category: "内容分发", assignee: "内容运维 · 方景", created: "14:36", sla: "已按时解决" },
  { id: "TK20260608017", priority: "P2", title: "会员积分对账差异", description: "营销活动积分规则配置错误，已修正并补发。", status: "已关闭", store: "常熟方塔街旗舰店", category: "计费异常", assignee: "计费组 · 孟雪", created: "11:20", sla: "已关闭" },
];

export const OPS_SLA = [
  { name: "P0 响应时长", value: "< 5 分钟", target: "目标 5 分钟" },
  { name: "P1 响应时长", value: "12 分钟", target: "目标 30 分钟" },
  { name: "P2 解决时长", value: "2.6 小时", target: "目标 4 小时" },
  { name: "月度可用性", value: "99.98%", target: "目标 99.9%" },
] as const;
