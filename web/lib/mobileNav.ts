/**
 * 手机端底部 Dock 的纯逻辑（BLF-1127 §3 / §7 + 决策 D1/D3）。
 *
 * 为什么单独成文件：Dock 的「恒 5 位、不随角色变形」是**契约**而不是渲染细节。
 * 做成不依赖 React / DOM 的纯函数，才能用 vitest 直接钉住
 * （`lib/mobileNav.vitest.test.ts`），而不是靠人眼看截图。
 *
 * 三条锁死的行为：
 *   · D1 「支出」位吸收 `/meta/me/menus` 的 `costs` + `reports`，标签写「支出」；
 *   · D3 管理与审批入口（contacts / approvals / admin）**不进 Dock**，只进「我的」抽屉；
 *       角色只影响「我的」位的待办红点与抽屉内容，Dock 位数不变；
 *   · §3 权限唯一入口仍是 `/meta/me/menus`：本文件不新增任何角色判断，
 *       只做「契约菜单 → 5 个位」的分组与信令推导。
 */

export type DockId = "dashboard" | "projects" | "progress" | "costs" | "mine";

/** `/meta/me/menus` 的一条菜单；只取 Dock 用得到的三个字段，测试可直接造数据 */
export interface MenuLike {
  key: string;
  label: string;
  href: string;
}

/** 一个 Dock 位：标签 / 落点 / 吸收的菜单，三者都固定（不随角色变形） */
export interface DockSlot {
  id: DockId;
  /** Dock 标签。固定文案，**不取**后端 label：D1 把「支出记录」收成「支出」 */
  label: string;
  /**
   * S1 落点。
   *
   * 抽屉（S3/D2）未落地前，点 Dock 先按桌面路由跳转，避免出现「点了没反应」的死键；
   * S3 之后这一位由抽屉接管，href 退化为无障碍回退与无 JS 时的可用路径。
   */
  href: string;
  /** 归属这一位的 `/meta/me/menus` key（工作台不在菜单契约里，故为空数组） */
  keys: string[];
  /** 归属这一位的桌面入口 href（含被合并的入口，S4 的抽屉模块卡直接消费） */
  hrefs: string[];
}

/**
 * 5 个 Dock 位 = 手机端导航的唯一事实来源（数组顺序即渲染顺序）。
 *
 * D1：「支出记录」是录入面、「支出报表」是同一业务对象的汇总面 —— 合并成 1 位，
 * 报表作为抽屉里的第二张卡进入（§3.1）。**路由键仍是 `costs`**，标签可改契约键不动。
 *
 * D3：「我的」吸收管理与审批入口 + 账号；非管理员在菜单契约里本就拿不到那三项，
 * 所以「我的」抽屉的内容由 `visible` 决定，Dock 位数恒为 5。
 */
export const DOCK_SLOTS: readonly DockSlot[] = [
  { id: "dashboard", label: "工作台", href: "/dashboard", keys: [], hrefs: ["/dashboard"] },
  { id: "projects", label: "项目", href: "/projects", keys: ["projects"], hrefs: ["/projects"] },
  { id: "progress", label: "进度", href: "/progress", keys: ["progress"], hrefs: ["/progress"] },
  { id: "costs", label: "支出", href: "/costs", keys: ["costs", "reports"], hrefs: ["/costs", "/reports"] },
  {
    id: "mine",
    label: "我的",
    // 桌面没有独立的「我的」页面：这一位在 S3 由抽屉（half 档）接管。
    // S1 先落到唯一存在的账号页，保证这一位不是死键。
    href: "/change-password",
    keys: ["contacts", "approvals", "admin"],
    hrefs: ["/contacts", "/approvals", "/admin"],
  },
];

/** Dock 位数：写进契约（§3 上限 5 位），测试直接断言不会变 */
export const DOCK_SIZE = DOCK_SLOTS.length;

export interface DockItem extends DockSlot {
  /**
   * 当前角色**实际可见**、且归属这一位的菜单（按 `keys` 过滤后的 `menus`）。
   *
   * 非管理员在「我的」位上拿到空数组 —— 这就是 D3 的实现：
   * 审批中心 / 系统管理 / 通讯录不会出现在 Dock 与「我的」抽屉里。
   */
  visible: MenuLike[];
  /** 待办红点：数字 = 待办条数，`true` = 数量未知的纯红点；`undefined` = 不显示 */
  badge?: number | true;
}

export interface DockMenuInput {
  /** `/meta/me/menus` 返回的可见菜单（不含恒可见的工作台） */
  menus: MenuLike[];
  /** 权限是否**已确认**（`useMenus().ready`）：未确认不发待办红点 */
  ready?: boolean;
  /**
   * 权限同步是否失败（`useMenus().error`）。
   * 失败时沿用现有降级策略：只保留参与性入口，**绝不猜测管理员身份**（§3.2）。
   */
  failed?: boolean;
  /** 是否可审批（`useMenus().canApprove`，当前契约下与 `is_admin` 同判定） */
  canApprove?: boolean;
  /**
   * 「我的」位的待办条数。已知时传数字（渲染成角标数字），省略则渲染纯红点。
   * S1 不新开统计接口，所以默认走纯红点；S4 需要数字时把这里接上即可。
   */
  pendingCount?: number;
}

/**
 * `/meta/me/menus` → 5 个 Dock 位。
 *
 * 恒返回 `DOCK_SIZE` 项（顺序同 `DOCK_SLOTS`），与角色、权限加载状态、菜单为空
 * 都无关 —— 权限只影响每项的 `visible` 与「我的」位的红点。
 */
export function buildDockItems({ menus, ready, failed, canApprove, pendingCount }: DockMenuInput): DockItem[] {
  // 菜单去重：同一 href 出现两次不该在抽屉里出现两张卡（layout 的桌面导航同款约束）
  const seen = new Set<string>();
  const visibleMenus = menus.filter((m) => {
    if (seen.has(m.href)) return false;
    seen.add(m.href);
    return true;
  });

  return DOCK_SLOTS.map((slot) => {
    const item: DockItem = {
      ...slot,
      visible: visibleMenus.filter((m) => slot.keys.includes(m.key)),
    };
    // D3：待办红点挂在「我的」位。权限未确认或同步失败时**不发**红点
    // （先亮后灭会是一次可见的错误值，且猜测管理员身份本来就违反 §3.2）。
    if (slot.id === "mine" && ready && !failed && canApprove) {
      item.badge = typeof pendingCount === "number" && pendingCount > 0 ? pendingCount : true;
    }
    return item;
  });
}

/** 桌面入口属于这一位（含子路由：`/projects/9` 属于「项目」） */
function isUnder(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(href + "/");
}

/**
 * 当前路径高亮哪一位；不属于任何位时返回 `null`（如 404 / 登录页）。
 *
 * 管理与审批页（`/approvals`、`/admin`、`/contacts`）归属「我的」位：
 * D3 规定它们只从「我的」抽屉进入，高亮也应当落在「我的」。
 */
export function dockIdForPath(pathname: string): DockId | null {
  for (const slot of DOCK_SLOTS) {
    if ([...slot.hrefs, slot.href].some((h) => isUnder(pathname, h))) return slot.id;
  }
  return null;
}
