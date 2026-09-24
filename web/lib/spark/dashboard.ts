import type { SparkRevenuePoint } from "./types";

export const DASHBOARD_METRICS = [
  { label: "今日营收", value: "¥48.62", unit: "万", delta: "↗ +18.6%", detail: "同比上周日", tone: "cyan", icon: "billing" },
  { label: "在线用户", value: "3,486", unit: "人", delta: "↗ +12.4%", detail: "其中电竞酒店 486 人", tone: "violet", icon: "permission" },
  { label: "GPU 平均负载", value: "78.4", unit: "%", delta: "↗ +6.2%", detail: "晚高峰高峰段", tone: "amber", icon: "compute" },
  { label: "在线终端", value: "3,892", unit: "/4,624", delta: "↘ -1.8%", detail: "14 台维护中", tone: "green", icon: "dashboard" },
] as const;

export const DASHBOARD_REVENUE: SparkRevenuePoint[] = [
  { hour: "00", members: 3900, walkIn: 7600, hotel: 1300 },
  { hour: "02", members: 3600, walkIn: 7200, hotel: 1250 },
  { hour: "04", members: 3100, walkIn: 6900, hotel: 1180 },
  { hour: "06", members: 2800, walkIn: 7200, hotel: 1200 },
  { hour: "08", members: 3400, walkIn: 8500, hotel: 1500 },
  { hour: "10", members: 5700, walkIn: 12200, hotel: 2200 },
  { hour: "12", members: 9100, walkIn: 15800, hotel: 3300 },
  { hour: "14", members: 11500, walkIn: 18300, hotel: 4500 },
  { hour: "16", members: 15800, walkIn: 22100, hotel: 6000 },
  { hour: "18", members: 22400, walkIn: 28100, hotel: 7600 },
  { hour: "20", members: 26700, walkIn: 33300, hotel: 8800 },
  { hour: "22", members: 24800, walkIn: 31100, hotel: 8200 },
];

export const GPU_POOLS = [
  { name: "RTX 5090 池", used: 684, total: 800, tone: "cyan" },
  { name: "RTX 5080 池", used: 524, total: 720, tone: "violet" },
  { name: "RTX 4070 池", used: 412, total: 600, tone: "green" },
  { name: "云游戏共享池", used: 186, total: 380, tone: "amber" },
] as const;

export const DISTRICT_REVENUE = [
  { district: "姑苏区", value: 92 },
  { district: "园区", value: 151 },
  { district: "高新", value: 77 },
  { district: "吴中区", value: 66 },
  { district: "相城区", value: 47 },
  { district: "吴江区", value: 51 },
  { district: "昆山市", value: 59 },
  { district: "常熟市", value: 39 },
];

export const DASHBOARD_ALERTS = [
  { time: "22:14", name: "昆山金鹰旗舰店", text: "核心交换机光模块衰减 42%，已自动切冗余链路", tone: "rose" },
  { time: "21:48", name: "观前街旗舰店", text: "GPU-07 节点温度 87°C，启动液冷增压", tone: "amber" },
  { time: "21:22", name: "独墅湖高校店", text: "周末晚高峰并发 174，触发弹性扩容 +32 路", tone: "amber" },
  { time: "20:56", name: "李公堤湖景店", text: "电竞酒店满房率 100%，建议联动周边门店", tone: "cyan" },
  { time: "20:30", name: "相城元和中翔店", text: "市电瞬时中断 2.4s，UPS 接管，已通知工程", tone: "rose" },
  { time: "19:42", name: "苏州中心旗舰店", text: "完成《黑神话:悟空》新版本 P2P 分发 216 台", tone: "cyan" },
  { time: "18:15", name: "盛泽太古广场店", text: "到店客流环比 +34%，排队 12 人", tone: "amber" },
];

export const REVENUE_LEADERS = [
  { rank: 1, name: "苏州中心旗舰店", district: "苏州工业园区", revenue: "¥4.24万" },
  { rank: 2, name: "李公堤湖景店", district: "苏州工业园区", revenue: "¥3.13万" },
  { rank: 3, name: "狮山龙湖旗舰店", district: "高新区", revenue: "¥3.04万" },
  { rank: 4, name: "圆融时代店", district: "苏州工业园区", revenue: "¥2.98万" },
  { rank: 5, name: "昆山金鹰旗舰店", district: "昆山市", revenue: "¥2.87万" },
  { rank: 6, name: "观前街旗舰店", district: "姑苏区", revenue: "¥2.86万" },
];
