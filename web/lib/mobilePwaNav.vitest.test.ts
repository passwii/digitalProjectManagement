import { describe, expect, it } from "vitest";
import type { ShellNavItem } from "./globalNav";
import {
  MOBILE_DOCK_SLOT_COUNT,
  buildMobileDockModel,
  buildMobileHomeCards,
} from "./mobilePwaNav";

/**
 * 手机 dock / 首页入口卡的权限投影契约。
 *
 * 这里不依赖 React：菜单是权限投影，dock 必须从同一份 navItems 派生，
 * 不能靠截图或 DOM 顺序验证「有没有凭空多出一个审批中心」。
 */

function item(href: string, label: string): ShellNavItem {
  return { href, label };
}

const USER_MENUS: ShellNavItem[] = [
  item("/dashboard", "工作台"),
  item("/projects", "项目台账"),
  item("/assets", "资产管理"),
  item("/reports", "支出报表"),
  item("/progress", "进度跟踪"),
  item("/costs", "支出记录"),
];

const ADMIN_MENUS: ShellNavItem[] = [
  ...USER_MENUS,
  item("/opportunities", "商机管理"),
  item("/approvals", "审批中心"),
  item("/contacts", "通讯录"),
  item("/partners", "我的友商"),
  item("/finance", "财务管理"),
  item("/admin", "系统管理"),
  item("/spark", "云电竞管理平台"),
  item("/stream-monitor", "智能音视频平台"),
];

describe("buildMobileDockModel：六槽与权限投影", () => {
  it("完整权限：五个主入口 + 更多，顺序与草稿一致", () => {
    const model = buildMobileDockModel(ADMIN_MENUS, "/dashboard");

    expect(MOBILE_DOCK_SLOT_COUNT).toBe(6);
    expect(model.slots).toHaveLength(6);
    expect(model.slots.map((slot) => slot.label)).toEqual([
      "工作台",
      "项目台账",
      "进度跟踪",
      "支出记录",
      "审批中心",
      "更多",
    ]);
    expect(model.slots.at(-1)?.kind).toBe("more");
    expect(model.slots.at(-1)?.id).toBe("more");
  });

  it("没有审批权限：不凭空渲染审批中心，槽位来自真实 navItems", () => {
    const model = buildMobileDockModel(USER_MENUS, "/projects");
    const labels = model.slots.map((slot) => slot.label);

    expect(labels).not.toContain("审批中心");
    expect(labels).toEqual(["工作台", "项目台账", "进度跟踪", "支出记录", "资产管理", "更多"]);
    expect(model.overflow.map((entry) => entry.href)).not.toContain("/approvals");
    expect(model.overflow.map((entry) => entry.href)).not.toContain("/projects");
  });

  it("权限为空也不伪造业务入口：至少保留恒定的「更多」", () => {
    const model = buildMobileDockModel([], "/dashboard");
    expect(model.slots.map((slot) => slot.label)).toEqual(["更多"]);
  });

  it("「更多」sheet 的溢出项完全来自输入导航，且排除已占主入口的项", () => {
    const model = buildMobileDockModel(ADMIN_MENUS, "/dashboard");
    const overflowHrefs = model.overflow.map((entry) => entry.href);
    const primaryHrefs = model.slots
      .filter((slot) => slot.kind === "link")
      .map((slot) => slot.href);

    expect(overflowHrefs).toEqual([
      "/assets",
      "/reports",
      "/opportunities",
      "/contacts",
      "/partners",
      "/finance",
      "/admin",
      "/spark",
      "/stream-monitor",
    ]);
    for (const href of primaryHrefs) {
      expect(overflowHrefs).not.toContain(href);
    }
  });
});

describe("buildMobileDockModel：当前项高亮", () => {
  it("子路由命中所在主入口", () => {
    const model = buildMobileDockModel(ADMIN_MENUS, "/projects/42");
    expect(model.activeInOverflow).toBe(false);
    expect(model.activeIndex).toBe(1);
    expect(model.slots[model.activeIndex].label).toBe("项目台账");
  });

  it("溢出层页面高亮「更多」而不是任何主入口", () => {
    const model = buildMobileDockModel(ADMIN_MENUS, "/contacts");
    expect(model.activeInOverflow).toBe(true);
    expect(model.activeIndex).toBe(model.slots.length - 1);
    expect(model.slots[model.activeIndex].id).toBe("more");
  });

  it("未知路径不点亮假入口", () => {
    const model = buildMobileDockModel(ADMIN_MENUS, "/nope");
    expect(model.activeIndex).toBe(-1);
    expect(model.activeInOverflow).toBe(false);
  });
});

describe("buildMobileHomeCards：四张入口卡按权限过滤", () => {
  it("完整权限取草稿顺序的前四张", () => {
    expect(buildMobileHomeCards(ADMIN_MENUS).map((card) => card.title)).toEqual([
      "统一台账",
      "进度留痕",
      "支出归集",
      "审批协同",
    ]);
  });

  it("缺审批权限时用下一张真实入口补位，而不是展示必然 403 的审批卡", () => {
    const cards = buildMobileHomeCards(USER_MENUS);
    expect(cards.map((card) => card.title)).toEqual([
      "统一台账",
      "进度留痕",
      "支出归集",
      "资产台账",
    ]);
    expect(cards.map((card) => card.href)).not.toContain("/approvals");
  });

  it("最多四张，且只包含 navItems 里真实存在的 href", () => {
    const cards = buildMobileHomeCards(ADMIN_MENUS);
    expect(cards).toHaveLength(4);
    const available = new Set(ADMIN_MENUS.map((entry) => entry.href));
    for (const card of cards) expect(available.has(card.href)).toBe(true);
  });
});
