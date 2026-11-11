import type { ReactNode } from "react";
import {
  canonicalNavHref,
  navItemMatchesPath,
  splitNav,
  type ShellNavItem,
} from "./globalNav";

/**
 * 手机 PWA 底座导航的纯逻辑（已确认草稿 docs/prototypes/mobile-pwa）。
 *
 * 与桌面药丸共用同一份 `navItems`（而 `navItems` 又来自 `/meta/me/menus`），
 * 这里只做「同一份权限投影 → 手机 dock / 更多 sheet / 首页入口卡」的投影，
 * **不新增任何角色判断，也不写死菜单**：
 *   · dock 的五个常驻位来自 `splitNav().primary`（缺位时按既有补位规则补齐）；
 *   · 第六位恒为「更多」；
 *   · 「更多」sheet 的溢出项就是 `splitNav().overflow`；
 *   · 首页四张入口卡按同一份 `navItems` 过滤后取前四张。
 *
 * 做成不依赖 React/DOM 的纯函数，方便 vitest 直接钉住权限投影与高亮口径。
 */

/** 手机 dock 的槽位总数（5 个主入口 + 更多）。 */
export const MOBILE_DOCK_SLOT_COUNT = 6;

/** 「更多」按钮在 dock 里的固定标签。 */
export const MOBILE_DOCK_MORE_LABEL = "更多";

/** 首页入口卡的可选来源。顺序即展示优先级；没有权限的项自动跳过。 */
export interface MobileHomeCardDef {
  href: string;
  index: string;
  title: string;
  note: string;
}

export const MOBILE_HOME_CARD_DEFS: readonly MobileHomeCardDef[] = [
  { href: "/projects", index: "01", title: "统一台账", note: "项目与客户关系对齐" },
  { href: "/progress", index: "02", title: "进度留痕", note: "每个里程碑可追溯" },
  { href: "/costs", index: "03", title: "支出归集", note: "票据与预算同屏" },
  { href: "/approvals", index: "04", title: "审批协同", note: "待办集中处理" },
  { href: "/opportunities", index: "05", title: "商机管理", note: "线索与商机推进" },
  { href: "/assets", index: "06", title: "资产台账", note: "设备与领用记录" },
  { href: "/reports", index: "07", title: "支出报表", note: "预算与支出核对" },
  { href: "/contacts", index: "08", title: "通讯录", note: "项目成员与外部联系人" },
  { href: "/spark", index: "09", title: "云电竞平台", note: "运营与算力调度" },
  { href: "/stream-monitor", index: "10", title: "智能音视频", note: "多模态感知与告警" },
];

/** dock 里的一个槽位：普通链接或「更多」。 */
export interface MobileDockSlot {
  /** 稳定 key：链接槽用规范化 href，更多槽固定为 `more`。 */
  id: string;
  label: string;
  kind: "link" | "more";
  href?: string;
  icon?: ReactNode;
}

export interface MobileDockModel {
  /** 渲染顺序：最多 5 个主入口 + 恒定的「更多」。 */
  slots: MobileDockSlot[];
  /** 「更多」sheet 的溢出项（保持 `navItems` 输入顺序）。 */
  overflow: ShellNavItem[];
  /** 当前路径落在溢出层：高亮「更多」而不是任何主入口。 */
  activeInOverflow: boolean;
  /** 液态胶囊应该落在哪个槽位；-1 表示没有匹配项。 */
  activeIndex: number;
}

/**
 * 把共享导航投影成手机 dock。
 *
 * 不假设用户一定有五个主入口：权限菜单为空时主入口会少于五个，但「更多」
 * 永远存在——宁可少一个槽，也不凭空渲染一个必然 403 的入口。
 */
export function buildMobileDockModel(
  items: readonly ShellNavItem[],
  activeHref: string,
): MobileDockModel {
  const { primary, overflow, activeInOverflow } = splitNav(items, activeHref);
  const slots: MobileDockSlot[] = primary.map((item) => ({
    id: canonicalNavHref(item.href),
    label: item.label,
    kind: "link",
    href: item.href,
    icon: item.icon,
  }));

  // 第六槽恒为「更多」：即使 overflow 为空也保留，保证手机端永远有账号与设置入口。
  slots.push({ id: "more", label: MOBILE_DOCK_MORE_LABEL, kind: "more" });

  let activeIndex = -1;
  if (activeInOverflow) {
    activeIndex = slots.length - 1;
  } else {
    activeIndex = primary.findIndex((item) => navItemMatchesPath(item.href, activeHref));
  }

  return { slots, overflow, activeInOverflow, activeIndex };
}

/**
 * 首页入口卡：只展示当前权限投影里真实存在的入口，最多四张。
 *
 * 不展示任何业务统计值——手机首页只回答「我是谁、这里能去哪」。
 */
export function buildMobileHomeCards(items: readonly ShellNavItem[]): MobileHomeCardDef[] {
  const available = new Set(items.map((item) => canonicalNavHref(item.href)));
  return MOBILE_HOME_CARD_DEFS.filter((card) => available.has(card.href)).slice(0, 4);
}
