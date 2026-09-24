export type SparkStatus = "营业中" | "高负载" | "维护中" | "离线";

export interface SparkStore {
  code: string;
  type: string;
  name: string;
  district: string;
  address: string;
  status: SparkStatus;
  manager: string;
  online: number;
  terminals: number;
  revenue: number;
  load: number;
  phone: string;
}

export interface SparkGpuNode {
  id: string;
  site: string;
  model: string;
  utilization: number;
  memory: string;
  temperature: number;
  power: number;
  sessions: number;
  latency: number;
}

export interface SparkRevenuePoint {
  hour: string;
  members: number;
  walkIn: number;
  hotel: number;
}
