import type { SparkGpuNode } from "./types";

export const COMPUTE_LOAD = [
  { hour: "00", gpu: 30, network: 28 }, { hour: "01", gpu: 32, network: 29 },
  { hour: "02", gpu: 34, network: 31 }, { hour: "03", gpu: 36, network: 33 },
  { hour: "04", gpu: 39, network: 35 }, { hour: "05", gpu: 41, network: 37 },
  { hour: "06", gpu: 38, network: 35 }, { hour: "07", gpu: 48, network: 39 },
  { hour: "08", gpu: 50, network: 43 }, { hour: "09", gpu: 42, network: 41 },
  { hour: "10", gpu: 35, network: 33 }, { hour: "11", gpu: 31, network: 30 },
  { hour: "12", gpu: 60, network: 52 }, { hour: "13", gpu: 65, network: 54 },
  { hour: "14", gpu: 70, network: 57 }, { hour: "15", gpu: 76, network: 62 },
  { hour: "16", gpu: 82, network: 68 }, { hour: "17", gpu: 90, network: 72 },
  { hour: "18", gpu: 88, network: 71 }, { hour: "19", gpu: 84, network: 67 },
  { hour: "20", gpu: 80, network: 64 }, { hour: "21", gpu: 76, network: 60 },
  { hour: "22", gpu: 72, network: 57 }, { hour: "23", gpu: 68, network: 54 },
];

export const COMPUTE_NODES: SparkGpuNode[] = [
  { id: "SIP-GPU-A01", site: "园区国际科技园", model: "RTX 5090", utilization: 86, memory: "27/32GB", temperature: 74, power: 482, sessions: 42, latency: 12 },
  { id: "SIP-GPU-A02", site: "园区国际科技园", model: "RTX 5090", utilization: 72, memory: "24/32GB", temperature: 71, power: 448, sessions: 38, latency: 13 },
  { id: "SIP-GPU-B07", site: "园区国际科技园", model: "RTX 5080", utilization: 94, memory: "15/16GB", temperature: 82, power: 342, sessions: 46, latency: 14 },
  { id: "SND-GPU-C03", site: "高新区科技城", model: "RTX 5090", utilization: 68, memory: "22/32GB", temperature: 68, power: 420, sessions: 34, latency: 18 },
  { id: "SND-GPU-C11", site: "高新区科技城", model: "RTX 4070 Ti", utilization: 54, memory: "9/12GB", temperature: 65, power: 248, sessions: 28, latency: 20 },
  { id: "FH-GPU-D02", site: "吴江汾湖边缘节点", model: "RTX 5080", utilization: 78, memory: "13/16GB", temperature: 70, power: 318, sessions: 40, latency: 24 },
  { id: "FH-GPU-D09", site: "吴江汾湖边缘节点", model: "RTX 4070", utilization: 46, memory: "7/12GB", temperature: 62, power: 202, sessions: 22, latency: 26 },
  { id: "KS-GPU-E04", site: "昆山花桥边缘节点", model: "RTX 5090", utilization: 82, memory: "26/32GB", temperature: 73, power: 468, sessions: 44, latency: 16 },
];

export const SCHEDULING_STRATEGIES = [
  { name: "时延优先", description: "就近接入，自动选择同区边缘节点", icon: "⌁" },
  { name: "成本优先", description: "优先使用共享池与闲时算力", icon: "ϟ" },
  { name: "密度优先", description: "最大化单节点并发，适合赛事", icon: "▦" },
  { name: "智能均衡", description: "AI 综合时延/温度/成本决策", icon: "✧" },
] as const;

export const CLOUD_PACKAGES = [
  { tag: "入门", name: "轻享云机", model: "RTX 4070 等效", resolution: "1080P 144Hz", price: "¥ 3.5/时" },
  { tag: "热门", name: "电竞云机", model: "RTX 5080 等效", resolution: "2K 240Hz", price: "¥ 6.0/时" },
  { tag: "顶配", name: "旗舰云机", model: "RTX 5090 等效", resolution: "4K 120Hz", price: "¥ 9.5/时" },
  { tag: "赛事", name: "赛事专享", model: "独占 GPU + 专线", resolution: "2K 240Hz", price: "¥ 15/时" },
] as const;
