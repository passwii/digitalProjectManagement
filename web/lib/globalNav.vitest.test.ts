import { describe, expect, it } from "vitest";
import {
  FALLBACK_NAV_HREFS,
  PRIMARY_NAV_HREFS,
  canonicalNavHref,
  dedupeNavItems,
  findActiveNavItem,
  navItemMatchesPath,
  splitNav,
  type ShellNavItem,
} from "./globalNav";

const item = (href: string, extra: Partial<ShellNavItem> = {}): ShellNavItem => ({
  href,
  label: href,
  ...extra,
});

const FIVE_PRIMARY: ShellNavItem[] = [
  item("/dashboard"),
  item("/projects"),
  item("/progress"),
  item("/costs"),
  item("/approvals"),
];

function hrefs(items: ShellNavItem[]): string[] {
  return items.map((navItem) => navItem.href);
}

describe("splitNav：五个主入口固定", () => {
  it("主入口按固定顺序排列，与输入顺序无关", () => {
    const shuffled = [
      item("/approvals"),
      item("/costs"),
      item("/progress"),
      item("/projects"),
      item("/dashboard"),
      item("/contacts"),
    ];

    const { primary, overflow } = splitNav(shuffled, "/dashboard");

    expect(hrefs(primary)).toEqual([...PRIMARY_NAV_HREFS]);
    expect(hrefs(overflow)).toEqual(["/contacts"]);
  });

  it("药丸最多五个入口，非主入口全部进「更多」且保持输入顺序", () => {
    const { primary, overflow } = splitNav(
      [
        item("/assets"),
        ...FIVE_PRIMARY,
        item("/contacts"),
        item("/reports"),
        item("/admin"),
      ],
      "/dashboard",
    );

    expect(primary).toHaveLength(5);
    expect(hrefs(primary)).toEqual([...PRIMARY_NAV_HREFS]);
    expect(hrefs(overflow)).toEqual(["/assets", "/contacts", "/reports", "/admin"]);
  });

  it("既没有主入口也没有补位候选时药丸为空，「更多」承接全部入口", () => {
    const { primary, overflow, activeInOverflow } = splitNav(
      [item("/admin"), item("/changelog")],
      "/admin",
    );

    expect(primary).toEqual([]);
    expect(hrefs(overflow)).toEqual(["/admin", "/changelog"]);
    expect(activeInOverflow).toBe(true);
  });
});

describe("splitNav：缺位补位", () => {
  it("缺失的主入口按补位名单顺序补齐，已有主入口的相对顺序不变", () => {
    const { primary, overflow } = splitNav(
      [
        item("/dashboard"),
        item("/projects"),
        item("/costs"),
        item("/approvals"),
        item("/assets"),
        item("/contacts"),
        item("/reports"),
      ],
      "/dashboard",
    );

    // /progress 缺位 → 补位名单里第一个可用项 /contacts 补到药丸末尾
    expect(hrefs(primary)).toEqual([
      "/dashboard",
      "/projects",
      "/costs",
      "/approvals",
      "/contacts",
    ]);
    expect(hrefs(overflow)).toEqual(["/assets", "/reports"]);
  });

  it("补位严格按 /contacts /opportunities /assets /reports 的顺序取", () => {
    const { primary } = splitNav(
      [
        item("/dashboard"),
        item("/reports"),
        item("/assets"),
        item("/opportunities"),
        item("/contacts"),
      ],
      "/dashboard",
    );

    expect(hrefs(primary)).toEqual([
      "/dashboard",
      "/contacts",
      "/opportunities",
      "/assets",
      "/reports",
    ]);
  });

  it("补位用满五个位置后，其余补位候选留在溢出层", () => {
    // 只给两个主入口，补位名单四项：补满第五位即停，剩余项不得丢。
    const { primary, overflow } = splitNav(
      [
        item("/dashboard"),
        item("/projects"),
        item("/contacts"),
        item("/opportunities"),
        item("/assets"),
        item("/reports"),
      ],
      "/dashboard",
    );

    expect(hrefs(primary)).toEqual([
      "/dashboard",
      "/projects",
      "/contacts",
      "/opportunities",
      "/assets",
    ]);
    expect(hrefs(overflow)).toEqual(["/reports"]);
  });

  it("补位候选也不存在时，药丸可以不足五个（不凭空造入口）", () => {
    const { primary, overflow } = splitNav(
      [item("/dashboard"), item("/reports"), item("/admin")],
      "/dashboard",
    );

    // 只有 /dashboard 与 /reports 是真实入口，药丸就是两个。
    expect(hrefs(primary)).toEqual(["/dashboard", "/reports"]);
    expect(hrefs(overflow)).toEqual(["/admin"]);
  });

  it("补位优先级与需求一致：通讯录 → 商机 → 资产 → 报表", () => {
    expect([...FALLBACK_NAV_HREFS]).toEqual([
      "/contacts",
      "/opportunities",
      "/assets",
      "/reports",
    ]);
  });
});

describe("splitNav：独立站点永远不补位", () => {
  it("external 项不进入药丸，即使它的 href 在补位名单里", () => {
    const { primary, overflow } = splitNav(
      [
        item("/dashboard"),
        item("/projects"),
        item("/progress"),
        item("/costs"),
        // /approvals 缺失，但补位候选 /contacts 是独立站点
        item("/contacts", { external: true, target: "spark-platform" }),
        item("/spark", { external: true, target: "_blank" }),
      ],
      "/dashboard",
    );

    expect(hrefs(primary)).toEqual(["/dashboard", "/projects", "/progress", "/costs"]);
    expect(hrefs(overflow)).toEqual(["/contacts", "/spark"]);
    expect(overflow.every((navItem) => navItem.external === true)).toBe(true);
  });

  it("独立站点始终留在「更多」，不会被当成主入口", () => {
    const { primary, overflow } = splitNav(
      [...FIVE_PRIMARY, item("/spark", { external: true }), item("/stream-monitor", { external: true })],
      "/spark",
    );

    expect(hrefs(primary)).toEqual([...PRIMARY_NAV_HREFS]);
    expect(hrefs(overflow)).toEqual(["/spark", "/stream-monitor"]);
  });
});

describe("splitNav：去重", () => {
  it("同一 href 只保留第一项，重复项不占药丸也不进「更多」", () => {
    const { primary, overflow } = splitNav(
      [
        item("/dashboard", { label: "工作台" }),
        item("/projects"),
        item("/projects", { label: "重复的项目台账" }),
        item("/progress"),
        item("/costs"),
        item("/approvals"),
        item("/contacts"),
        item("/contacts", { label: "重复的通讯录" }),
      ],
      "/dashboard",
    );

    expect(hrefs(primary)).toEqual([...PRIMARY_NAV_HREFS]);
    expect(hrefs(overflow)).toEqual(["/contacts"]);
    expect(primary[0].label).toBe("工作台");
  });

  it("query / hash / 末尾斜杠视为同一个 href", () => {
    const unique = dedupeNavItems([
      item("/projects?tab=active"),
      item("/projects/"),
      item("/projects#top"),
      item("/costs"),
    ]);

    expect(hrefs(unique)).toEqual(["/projects?tab=active", "/costs"]);
    expect(canonicalNavHref("/projects/?tab=1#x")).toBe("/projects");
  });

  it("根路径与空串归一化后不会互相重复", () => {
    expect(canonicalNavHref("/")).toBe("/");
    expect(canonicalNavHref("")).toBe("/");
    expect(hrefs(dedupeNavItems([item("/"), item("")]))).toEqual(["/"]);
  });
});

describe("splitNav：activeInOverflow", () => {
  it("当前路径在溢出层时为 true", () => {
    const { activeInOverflow } = splitNav([...FIVE_PRIMARY, item("/contacts")], "/contacts");

    expect(activeInOverflow).toBe(true);
  });

  it("子路由也算命中溢出层", () => {
    const { activeInOverflow } = splitNav(
      [...FIVE_PRIMARY, item("/admin")],
      "/admin/users",
    );

    expect(activeInOverflow).toBe(true);
  });

  it("当前路径在主入口时不为 true", () => {
    const { activeInOverflow } = splitNav([...FIVE_PRIMARY, item("/contacts")], "/projects/42");

    expect(activeInOverflow).toBe(false);
  });

  it("无匹配路径时不为 true，也不会误命中相邻前缀", () => {
    expect(splitNav([...FIVE_PRIMARY, item("/contacts")], "/unknown").activeInOverflow).toBe(false);
    expect(splitNav([...FIVE_PRIMARY, item("/contacts")], "/project").activeInOverflow).toBe(false);
  });
});

describe("navItemMatchesPath", () => {
  it("精确命中与子路径命中", () => {
    expect(navItemMatchesPath("/projects", "/projects")).toBe(true);
    expect(navItemMatchesPath("/projects", "/projects/42")).toBe(true);
    expect(navItemMatchesPath("/projects/", "/projects/42?tab=1")).toBe(true);
  });

  it("相邻前缀不误命中", () => {
    expect(navItemMatchesPath("/project", "/projects")).toBe(false);
    expect(navItemMatchesPath("/project", "/projects/42")).toBe(false);
    expect(navItemMatchesPath("/projects", "/projects-archive")).toBe(false);
  });

  it("根路径命中所有路径", () => {
    expect(navItemMatchesPath("/", "/dashboard")).toBe(true);
  });
});

describe("findActiveNavItem", () => {
  it("嵌套前缀取最长匹配，不让更短的项抢走当前页", () => {
    const found = findActiveNavItem(
      [item("/finance"), item("/finance/settings"), item("/dashboard")],
      "/finance/settings/approvals",
    );

    expect(found?.href).toBe("/finance/settings");
  });

  it("没有命中时返回 undefined", () => {
    expect(findActiveNavItem([item("/dashboard")], "/unknown")).toBeUndefined();
  });

  it("匹配保持原有对象引用，便于调用方判等", () => {
    const settings = item("/finance/settings");
    const found = findActiveNavItem([item("/finance"), settings], "/finance/settings");

    expect(found).toBe(settings);
  });
});
