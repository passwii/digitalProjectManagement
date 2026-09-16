/**
 * 指标口径与文案单一来源（BLF-1093）。
 *
 * 工作台 / 报表 / 成本支出 / 项目档案都会展示「预算、已支出、余额、执行率、加权进度、健康度」，
 * 同一组数字在不同页面必须用**同一个名字和同一句口径说明**，否则管理者会按不同含义去读同一格数字。
 * 这里把标签、口径备注和健康度映射集中定义，各页面只引用不重写。
 */
import type { BadgeTone } from "@/components/ui/Badge";

/** 金额类指标（全站统一命名） */
export const MONEY_LABEL = {
  budget: "预算合计",
  spent: "已支出",
  balance: "可用余额",
  rate: "执行率",
} as const;

/** 进度类指标 */
export const PROGRESS_LABEL = {
  weighted: "加权进度",
} as const;

/**
 * 成本口径说明：已支出只计「已通过 / 特批通过」的支出（与后端 core.costs.PASS 一致），
 * 因此与财务账面天然有差异。所有展示成本数字的页面共用这一句。
 */
export const COST_SCOPE_NOTE = "成本为项目管理口径：已支出只统计「已通过 / 特批通过」，与财务账存在差异";

/** 工作台健康度：code → 文案，与报表/项目页共用同一套读法 */
export const HEALTH_LABEL: Record<string, string> = {
  ok: "正常",
  risk: "风险",
  bad: "异常",
  closed: "已关闭",
};

export const HEALTH_TONE: Record<string, BadgeTone> = {
  ok: "done",
  risk: "warn",
  bad: "danger",
  closed: "paused",
};

/**
 * 执行率是否已达预警线 / 是否超支，与后端 core.costs 的 warn（≥80%）与 over（>100%）一致。
 * 页面不再各写一份 0.8 / 1 的魔法数字。
 */
export const RATE_WARN = 0.8;
export const RATE_OVER = 1;

export function rateLevel(rate?: number | null): "over" | "warn" | "ok" {
  if (rate == null) return "ok";
  if (rate > RATE_OVER) return "over";
  if (rate >= RATE_WARN) return "warn";
  return "ok";
}

export function rateBadge(rate?: number | null): { status: string; tone: BadgeTone } | null {
  const lv = rateLevel(rate);
  if (lv === "over") return { status: "超支", tone: "danger" };
  if (lv === "warn") return { status: `≥${RATE_WARN * 100}% 预警`, tone: "warn" };
  return null;
}
