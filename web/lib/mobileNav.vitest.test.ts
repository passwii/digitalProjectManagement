import { describe, expect, it } from "vitest";
import { DOCK_SIZE, DOCK_SLOTS, buildDockItems, dockIdForPath, type MenuLike } from "./mobileNav";

/**
 * Dock 的契约测试（BLF-1127 §3 / §7 + 决策 D1/D3）。
 *
 * 这个文件存在的唯一理由：Dock 的「恒 5 位、不随角色变形」是**契约**，靠人眼看截图
 * 验不出来（管理员恰好也是 5 位，渲染少一位时截图上看不出差别）。所以把菜单分组、
 * 红点信令、路径高亮都钉在纯函数上。
 */

/** `/meta/me/menus` 的后端契约（api/routers/meta.py）：4 项参与性入口 + 管理员的 5 项 */
const USER_MENUS: MenuLike[] = [
  { key: "projects", label: "项目台账", href: "/projects" },
  { key: "assets", label: "资产管理", href: "/assets" },
  { key: "reports", label: "支出报表", href: "/reports" },
];

const ADMIN_MENUS: MenuLike[] = [
  ...USER_MENUS,
  { key: "contacts", label: "通讯录", href: "/contacts" },
  { key: "partners", label: "我的友商", href: "/partners" },
  { key: "approvals", label: "审批中心", href: "/approvals" },
  { key: "finance", label: "财务管理", href: "/finance" },
  { key: "admin", label: "系统管理", href: "/admin" },
];

describe("Dock 位定义（§3）", () => {
  it("恒定 5 位，顺序即渲染顺序", () => {
    expect(DOCK_SIZE).toBe(5);
    expect(DOCK_SLOTS.map((s) => s.id)).toEqual(["dashboard", "projects", "assets", "reports", "mine"]);
  });

  it("标签固定为工作台 / 项目 / 资产 / 报表 / 我的", () => {
    expect(DOCK_SLOTS.map((s) => s.label)).toEqual(["工作台", "项目", "资产", "报表", "我的"]);
  });

  it("资产与报表各自占位，并落到对应页面", () => {
    expect(DOCK_SLOTS.find((s) => s.id === "assets")).toMatchObject({ href: "/assets", keys: ["assets"] });
    expect(DOCK_SLOTS.find((s) => s.id === "reports")).toMatchObject({ href: "/reports", keys: ["reports"] });
  });
});

describe("buildDockItems（§3 + D1/D3）", () => {
  it("非管理员：5 位，管理与审批入口一个都不出现", () => {
    const items = buildDockItems({ menus: USER_MENUS, ready: true, canApprove: false });
    expect(items).toHaveLength(5);
    // D3：审批中心 / 系统管理 / 通讯录不进 Dock
    expect(items.flatMap((i) => i.visible.map((v) => v.key)))
      .not.toContain("approvals");
    expect(items.find((i) => i.id === "mine")!.visible).toEqual([]);
  });

  it("管理员：Dock 仍是 5 位（不随角色变形），四个管理入口只落到「我的」位", () => {
    const items = buildDockItems({ menus: ADMIN_MENUS, ready: true, canApprove: true });
    expect(items).toHaveLength(5);
    expect(items.find((i) => i.id === "mine")!.visible.map((v) => v.key)).toEqual(["contacts", "partners", "approvals", "finance", "admin"]);
  });

  it("资产与报表位分别只包含对应菜单，不合并支出录入路由", () => {
    const items = buildDockItems({ menus: USER_MENUS, ready: true });
    expect(items.find((i) => i.id === "assets")!.visible.map((v) => v.key)).toEqual(["assets"]);
    expect(items.find((i) => i.id === "reports")!.visible.map((v) => v.key)).toEqual(["reports"]);
    expect(items.flatMap((i) => i.hrefs)).not.toContain("/costs");
    expect(items.flatMap((i) => i.hrefs)).not.toContain("/progress");
  });

  it("菜单为空也返回 5 位（禁用不了导航，权限未知不是「没有导航」）", () => {
    expect(buildDockItems({ menus: [] })).toHaveLength(5);
    expect(buildDockItems({ menus: [] }).map((i) => i.id)).toEqual(DOCK_SLOTS.map((s) => s.id));
  });

  it("同一 href 出现两次只留一条（抽屉里不该出现两张同落点的卡）", () => {
    const dup = [...USER_MENUS, { key: "assets", label: "资产管理", href: "/assets" }];
    const items = buildDockItems({ menus: dup, ready: true });
    expect(items.find((i) => i.id === "assets")!.visible).toHaveLength(1);
  });

  it("D3：待办红点挂在「我的」位，且只在权限已确认、未失败、可审批时出现", () => {
    const admin = buildDockItems({ menus: ADMIN_MENUS, ready: true, canApprove: true });
    const dot = admin.filter((i) => i.badge !== undefined);
    expect(dot.map((i) => i.id)).toEqual(["mine"]);
    // S1 不新开统计接口：数量未知 → 纯红点
    expect(admin.find((i) => i.id === "mine")!.badge).toBe(true);
  });

  it("D3：权限未确认（ready=false）或同步失败时不发红点（绝不猜管理员）", () => {
    expect(buildDockItems({ menus: ADMIN_MENUS, ready: false, canApprove: true }).find((i) => i.id === "mine")!.badge)
      .toBeUndefined();
    expect(buildDockItems({ menus: ADMIN_MENUS, ready: true, failed: true, canApprove: true }).find((i) => i.id === "mine")!.badge)
      .toBeUndefined();
    // 权限同步失败时菜单会退化成基础入口，但绝不能因此亮出一个待办红点
    expect(buildDockItems({ menus: USER_MENUS, ready: true, failed: true, canApprove: false }).find((i) => i.id === "mine")!.badge)
      .toBeUndefined();
  });

  it("知道待办条数时渲染数字；知道是 0 条时什么都不显示", () => {
    const withCount = buildDockItems({ menus: ADMIN_MENUS, ready: true, canApprove: true, pendingCount: 7 });
    expect(withCount.find((i) => i.id === "mine")!.badge).toBe(7);
    const zero = buildDockItems({ menus: ADMIN_MENUS, ready: true, canApprove: true, pendingCount: 0 });
    expect(zero.find((i) => i.id === "mine")!.badge).toBeUndefined();
  });
});

describe("dockIdForPath（当前位高亮）", () => {
  it("直接命中每个位", () => {
    expect(dockIdForPath("/dashboard")).toBe("dashboard");
    expect(dockIdForPath("/projects")).toBe("projects");
    expect(dockIdForPath("/assets")).toBe("assets");
    expect(dockIdForPath("/reports")).toBe("reports");
  });

  it("子路由归属所属位（详情页也要高亮住的位，否则进详情就没有「我在哪」）", () => {
    expect(dockIdForPath("/projects/9")).toBe("projects");
    expect(dockIdForPath("/dashboard/x")).toBe("dashboard");
  });

  it("原有的进度与支出页不占 Dock 位", () => {
    expect(dockIdForPath("/progress")).toBeNull();
    expect(dockIdForPath("/costs")).toBeNull();
  });

  it("D3：管理 / 审批 / 通讯录 / 友商页高亮「我的」（它们只从「我的」抽屉进入）", () => {
    expect(dockIdForPath("/approvals")).toBe("mine");
    expect(dockIdForPath("/finance")).toBe("mine");
    expect(dockIdForPath("/admin")).toBe("mine");
    expect(dockIdForPath("/contacts")).toBe("mine");
    expect(dockIdForPath("/partners")).toBe("mine");
    expect(dockIdForPath("/change-password")).toBe("mine");
  });

  it("不属于任何位时返回 null（登录页 / 未知路径不高亮假入口）", () => {
    expect(dockIdForPath("/login")).toBeNull();
    expect(dockIdForPath("/")).toBeNull();
    expect(dockIdForPath("/nope")).toBeNull();
    // 前缀相似但不是子路由：/projects-old 不该被当成 /projects
    expect(dockIdForPath("/projects-old")).toBeNull();
  });
});
