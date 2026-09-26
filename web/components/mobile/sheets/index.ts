"use client";

// Dock 位 id → 单档入口面板内容的映射。五位分组和权限继续沿用 D1/D3。
//
// 三条契约钉在这里：
//   · D1：`costs` 位渲染 `ExpensesSheet` —— 「支出记录 + 支出报表」是同一业务对象
//     的录入面与汇总面，报表作为抽屉里的第二张卡进入，不占第二个 Dock 位；
//   · D3：管理与审批入口只出现在「我的」抽屉里（`MineSheet` 消费 `item.visible`），
//     Dock 位数恒为 5 —— 本文件不做任何角色判断，只做映射。

import type { ComponentType } from "react";
import type { DockId, DockItem } from "@/lib/mobileNav";
import DashboardSheet from "./DashboardSheet";
import ExpensesSheet from "./ExpensesSheet";
import MineSheet from "./MineSheet";
import ProgressSheet from "./ProgressSheet";
import ProjectsSheet from "./ProjectsSheet";

/** 面板内容组件的公共 props：选中收起 + 这一位的 Dock 信息与权限状态 */
export interface SheetContentProps {
  /** 点卡片进模块时先收起抽屉（抽屉是导航的第二入口，进了模块就不该留在屏上） */
  onSelect: () => void;
  /** 这一位的 Dock 信息（含按 `keys` 过滤后的 `visible` 菜单，D3 消费它） */
  item: DockItem;
  /** 权限是否已确认（`useMenus().ready`）：未确认不渲染管理与审批入口 */
  ready: boolean;
  /** 权限同步是否失败（`useMenus().error`）：失败走降级，不猜测管理员身份 */
  failed: boolean;
  /** 是否可审批（`useMenus().canApprove`，当前契约下与 `is_admin` 同判定） */
  canApprove: boolean;
  /** 权限重试（`useMenus().reload`）：降级行的「重试」按钮用 */
  onReloadMenus?: () => void;
}

/** 抽屉头：标题取 Dock 位 label（`MobileDock` 传），这里只给定副标题与头部动作 */
export const SHEET_META: Record<
  DockId,
  { subtitle: string; action?: { label: string; href: string } }
> = {
  dashboard: {
    subtitle: "快捷跳转卡",
    action: { label: "进入工作台", href: "/dashboard" },
  },
  projects: {
    subtitle: "状态筛选与最近项目",
    action: { label: "进入台账", href: "/projects" },
  },
  progress: {
    subtitle: "待填报 · 逾期 · 临近里程碑",
    action: { label: "进入跟踪", href: "/progress" },
  },
  costs: {
    subtitle: "支出记录 + 支出报表（同一业务对象）",
    action: { label: "进入支出记录", href: "/costs" },
  },
  mine: { subtitle: "账号与管理入口" },
};

/** Dock 位 id → Sheet 组件（D1：`costs` 位渲染 `ExpensesSheet`，同时吸收 `reports`） */
export const SHEET_CONTENT: Record<DockId, ComponentType<SheetContentProps>> = {
  dashboard: DashboardSheet,
  projects: ProjectsSheet,
  progress: ProgressSheet,
  costs: ExpensesSheet,
  mine: MineSheet,
};
