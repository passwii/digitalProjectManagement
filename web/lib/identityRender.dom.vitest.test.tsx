// @vitest-environment jsdom
/**
 * BLF-1125：刷新时头像/姓名短暂回退为「当前用户」的**真实渲染**回归测试。
 *
 * 为什么必须用真实 DOM 渲染而不是只测纯函数：本次的 bug 断在「渲染层把未确认
 * 状态渲染成了占位文案」这一步（`me?.real_name || "当前用户"`），纯函数测试
 * 测不到 JSX 里是否又有人把 `?? "默认值"` 写回去。这里把真实的 DashboardShell
 * 挂进 jsdom，断言各种异步阶段下**页面上出现的文字**。
 *
 * 覆盖三层：
 *   1. 首帧（水合）—— 等价于刷新时先画出的静态预渲染 HTML，绝不能有假名字；
 *   2. 水合后读到 localStorage 快照 —— 名字即刻就位（这正是修复后不闪的原因）；
 *   3. 快照缺失 + `/auth/me` 慢/失败 —— 保持骨架或中性文案，绝不插默认值。
 *
 * BLF-1141 起这里还覆盖「身份区搬到顶栏」的账号菜单：角色 / 权限文案整体退出外壳
 * （用户反馈为冗余信息），所以原本断言「普通用户 · 参与项目业务」「管理员 · 全局管理
 * 与审批」渲染出来的用例，反过来钉住它们**不再出现**。
 *
 * 用 vitest（`test:motion`）的原因与 `lib/modalFocus.dom.vitest.test.ts` 相同：
 * 这里需要 JSX + React 渲染 + jsdom。另外本文件自带一个 localStorage 替身，
 * 原因见下方 `installStorage` 的注释。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Suspense } from "react";

import { IDENTITY_STORAGE_KEY, serializeIdentitySnapshot } from "./identityCore";
// 生产代码的缓存重置入口（登出时也用它）：测试间必须重置，否则上一个用例留下的
// 未完成请求（如“接口永不返回”那几条）会霸占 meInflight，让后面的用例加载不出身份。
import { clearMetaCache } from "./useMeta";
import type { Me } from "./api";

/**
 * localStorage 替身。
 *
 * jsdom 确实提供 `window.localStorage`，但 Node 26 会装一个实验性的同名全局
 * （需要 `--localstorage-file`），其 getter 在测试环境里直接抛错 / 返回
 * undefined，导致 `localStorage.clear()` 都跑不了。这里显式装一个内存实现，
 * 让「token + 身份快照」的读写走真实的键值路径，而不是去 mock 掉被测代码。
 */
function installStorage() {
  const store = new Map<string, string>();
  // 只实现被测代码真正用到的三个方法，不伪造不需要的 Storage 成员
  const api = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  };
  Object.defineProperty(window, "localStorage", { configurable: true, value: api });
  return api;
}

/** 可控的后端替身：两个接口的返回时机由各用例决定 */
const pending: { me?: () => Promise<unknown>; menus?: () => Promise<unknown> } = {};

/**
 * 路由与登出接口的替身（BLF-1141 账号菜单要断言「点退出登录 → 清会话并回登录页」）。
 * 用 `vi.hoisted` 是因为 `vi.mock` 的工厂会提到 import 之前执行，拿不到普通变量。
 */
const mocks = vi.hoisted(() => ({
  logout: vi.fn(() => Promise.resolve({ ok: true })),
  push: vi.fn(),
  replace: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/dashboard",
  useRouter: () => ({ replace: mocks.replace, push: mocks.push }),
}));

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("./api")>("./api");
  return {
    ...actual,
    authApi: {
      ...actual.authApi,
      me: () => pending.me?.() ?? Promise.resolve(null as unknown as Me),
      // 真实实现会打后端；菜单用例里「退出登录」必须走替身，否则测试会真的发请求
      logout: () => mocks.logout(),
    },
    metaApi: {
      ...actual.metaApi,
      menus: () => pending.menus?.() ?? Promise.resolve(null),
    },
    // 顶栏 Bell 挂载就会拉未读数。必须挡住：本测试环境机器上可能真的跑着后端，
    // 真实请求拿到 401 会走 `clearSession()`，把 token 与身份快照一起清掉，
    // 后续断言就会看到一个「刚被登出」的页面（非确定性失败）。
    notificationsApi: {
      ...actual.notificationsApi,
      count: () => Promise.resolve({ unread: 0 }),
      list: () => Promise.resolve({ items: [], unread: 0, total: 0 }),
    },
  };
});

import DashboardShell from "../app/(dashboard)/layout";

/** 未被 vitest / React 接管的原始 console.error（下面的噪声过滤要把其它错误原样透出） */
const realConsoleError = console.error.bind(console);

const ME: Me = {
  id: 7,
  username: "13800000007",
  real_name: "张伟",
  status: "active",
  dept_id: null,
  roles: [{ code: "member", name: "项目成员" }],
  must_change_pwd: false,
};

const MENUS = {
  roles: ["member"],
  is_admin: false,
  can_approve: false,
  menus: [{ key: "projects", label: "项目台账", href: "/projects" }],
  readonly: false,
  demo_on: false,
  can_toggle_demo: false,
};

/** 模拟「上一次会话留下的痕迹」：token + 与 token 绑定的身份快照 */
function seedSession(me: Me = ME, token = "tok-1") {
  window.localStorage.setItem("pm_access_token", token);
  window.localStorage.setItem(IDENTITY_STORAGE_KEY, serializeIdentitySnapshot(me, token));
}

function mount() {
  return render(
    <Suspense fallback={null}>
      <DashboardShell>
        <div>页面内容</div>
      </DashboardShell>
    </Suspense>,
  );
}

/** 让所有已解决的 promise 与被动 effect 跑完 */
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  installStorage();
  clearMetaCache();
  pending.me = undefined;
  pending.menus = undefined;
  mocks.logout.mockClear();
  mocks.push.mockClear();
  mocks.replace.mockClear();
  // jsdom 不做真实页面跳转：点「修改密码」的 <a> 与 clearSession() 的 location.assign
  // 都会往 stderr 打 "Not implemented: navigation"。用例验证的是接口调用与路由 push，
  // 跳转本身不在这里验证 —— 只吞这一条已知噪声，其它 console.error 原样透出。
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    if (String(args[0]).includes("Not implemented: navigation")) return;
    realConsoleError(...args);
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("BLF-1125 刷新闪烁：各异步阶段都不能出现「当前用户」", () => {
  it("首帧（等价于刷新时先画出的静态 HTML）：渲染骨架，没有「当前用户」", () => {
    pending.me = () => new Promise(() => {});
    pending.menus = () => new Promise(() => {});

    const { container } = mount();

    expect(container.textContent).not.toContain("当前用户");
    // 身份区是骨架：占位块 + 给读屏的中性提示（侧栏与顶栏各一处）
    expect(container.querySelectorAll('[aria-hidden="true"]').length).toBeGreaterThan(0);
    expect(screen.getAllByText("身份加载中").length).toBeGreaterThan(0);
  });

  it("命中 localStorage 快照：名字立刻显示真名（不再先闪假名字）", async () => {
    seedSession();
    pending.me = () => new Promise(() => {}); // 接口故意不返回，验证姓名完全来自快照
    pending.menus = () => Promise.resolve(MENUS);

    const { container } = mount();
    await flush();

    expect(screen.getAllByText("张伟").length).toBeGreaterThan(0);
    expect(container.textContent).not.toContain("当前用户");
  });

  it("快照属于另一个账号（token 已变）：不显示别人的名字", async () => {
    seedSession(ME, "tok-OLD");
    window.localStorage.setItem("pm_access_token", "tok-NEW"); // 换了账号
    pending.me = () => new Promise(() => {});
    pending.menus = () => new Promise(() => {});

    const { container } = mount();
    await flush();

    expect(container.textContent).not.toContain("张伟");
    expect(container.textContent).not.toContain("当前用户");
  });

  it("无快照 + /auth/me 返回：姓名就位，全程无占位文案", async () => {
    window.localStorage.setItem("pm_access_token", "tok-1");
    pending.me = () => Promise.resolve(ME);
    pending.menus = () => Promise.resolve(MENUS);

    const { container } = mount();
    await waitFor(() => expect(screen.getAllByText("张伟").length).toBeGreaterThan(0));

    expect(container.textContent).not.toContain("当前用户");
  });

  it("写回快照：下次刷新首帧就有真名（修复的持久化部分）", async () => {
    window.localStorage.setItem("pm_access_token", "tok-1");
    pending.me = () => Promise.resolve(ME);
    pending.menus = () => Promise.resolve(MENUS);

    mount();
    await waitFor(() => expect(screen.getAllByText("张伟").length).toBeGreaterThan(0));

    const raw = window.localStorage.getItem(IDENTITY_STORAGE_KEY);
    expect(raw, "登录后必须写下身份快照，供下次刷新首帧使用").toBeTruthy();
    expect(raw).toContain("张伟");
  });

  it("无快照 + /auth/me 失败：如实说明未同步，而不是把骨架永远转下去", async () => {
    window.localStorage.setItem("pm_access_token", "tok-1");
    pending.me = () => Promise.reject(new Error("API 500: boom"));
    pending.menus = () => new Promise(() => {});

    const { container } = mount();
    await waitFor(() => expect(screen.getAllByText("身份信息未同步").length).toBeGreaterThan(0));

    expect(container.textContent).not.toContain("当前用户");
  });

  it("权限查询在飞时不猜角色：不出现「项目成员」/「管理员」断言", async () => {
    seedSession();
    pending.me = () => Promise.resolve(ME);
    pending.menus = () => new Promise(() => {}); // 权限永远不回来

    const { container } = mount();
    await flush();

    // 姓名已就位（来自快照），角色区必须是骨架：
    // 先写「项目成员」再改成「管理员」也是一次可见的错误值闪烁
    expect(screen.getAllByText("张伟").length).toBeGreaterThan(0);
    expect(container.textContent).not.toContain("管理员");
    expect(container.textContent).not.toContain("普通用户");
  });

  it("权限确认后也不再渲染角色行（BLF-1141：角色文案退出外壳）", async () => {
    seedSession();
    pending.me = () => Promise.resolve(ME);
    pending.menus = () => Promise.resolve(MENUS);

    const { container } = mount();
    await waitFor(() => expect(screen.getAllByText("张伟").length).toBeGreaterThan(0));

    expect(container.textContent).not.toContain("普通用户");
    expect(container.textContent).not.toContain("项目成员 · ");
    expect(container.textContent).not.toContain("当前用户");
  });

  it("管理员确认后也不显示管理员文案（不得先显示普通用户，也不再显示任何角色）", async () => {
    seedSession();
    pending.me = () => Promise.resolve(ME);
    pending.menus = () => Promise.resolve({ ...MENUS, is_admin: true, can_approve: true });

    const { container } = mount();
    await waitFor(() => expect(screen.getAllByText("张伟").length).toBeGreaterThan(0));

    expect(container.textContent).not.toContain("管理员");
    expect(container.textContent).not.toContain("全局管理与审批");
    expect(container.textContent).not.toContain("当前用户");
  });

  it("权限同步失败：提示失败并保留重试入口，不谎称管理员", async () => {
    seedSession();
    pending.me = () => Promise.resolve(ME);
    pending.menus = () => Promise.reject(new Error("API 500: boom"));

    const { container } = mount();
    // 侧栏角色行已随身份区一并移除（BLF-1141），失败提示现在只剩导航下方那条
    await waitFor(() => expect(screen.getAllByText(/权限信息加载失败/).length).toBeGreaterThan(0));
    expect(screen.getByText("重试")).toBeTruthy();
    expect(container.textContent).not.toContain("管理员");
    expect(container.textContent).not.toContain("当前用户");
  });
});

/**
 * BLF-1141：身份与账号操作从侧栏底部搬到顶栏右上角。
 *
 * 真实的 hover / focus / tap 行为只能用真实 DOM 渲染来钉：这些断言覆盖「菜单在什么
 * 条件下出现在 DOM 里」，而不是 CSS 怎么写 —— 关着的菜单**不渲染**（而不是靠
 * visibility 隐藏），所以「不在 Tab 序列里」这一条等价于「DOM 里没有 menuitem」。
 *
 * 延时关闭用真实计时器（waitFor 轮询）验证，不引入 fake timers：本文件其它用例都依赖
 * 真实的 promise/microtask 时序，混用两种计时器只会让失败变得难以复现。
 */
describe("BLF-1141 顶栏账号菜单（身份区已从侧栏搬走）", () => {
  /** 顶栏身份区容器：触发按钮与菜单的共同父节点，也就是 hover 的进出边界 */
  function chipWrap(): HTMLElement {
    return screen.getByRole("button", { name: /^账号菜单/ }).parentElement as HTMLElement;
  }

  /** 已确认身份的外壳（快照 + 两个接口都返回），菜单用例的公共前置 */
  async function mountSignedIn(admin = false) {
    seedSession();
    pending.me = () => Promise.resolve(ME);
    pending.menus = () => Promise.resolve(admin ? { ...MENUS, is_admin: true, can_approve: true } : MENUS);
    mount();
    await waitFor(() => expect(screen.getAllByText("张伟").length).toBeGreaterThan(0));
  }

  it("侧栏没有身份区或登出按钮，折叠开关在品牌区", async () => {
    await mountSignedIn();

    const sidebar = document.querySelector('[data-shell="sidebar"]') as HTMLElement;
    expect(sidebar, "桌面侧栏必须还在（删的是身份区，不是侧栏）").toBeTruthy();
    expect(sidebar.textContent).not.toContain("张伟");
    expect(sidebar.textContent).not.toContain("登出");
    expect(sidebar.textContent).not.toContain("管理员");
    const buttons = Array.from(sidebar.querySelectorAll("button"));
    expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual(["收起侧边栏"]);
    expect(sidebar.querySelector('[data-testid="sidebar-brand"]')?.contains(buttons[0])).toBe(true);
  });

  it("侧栏按钮位于品牌区并能切换展开状态", async () => {
    await mountSignedIn();

    const sidebar = document.querySelector('[data-shell="sidebar"]') as HTMLElement;
    const button = screen.getByRole("button", { name: "收起侧边栏" });
    expect(sidebar.querySelector('[data-testid="sidebar-brand"]')?.contains(button)).toBe(true);
    expect(button.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(button);
    expect(screen.getByRole("button", { name: "展开侧边栏" }).getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(screen.getByRole("button", { name: "展开侧边栏" }));
    expect(screen.getByRole("button", { name: "收起侧边栏" }).getAttribute("aria-expanded")).toBe("true");
  });

  it("菜单与顶栏 chip 都不再出现角色权限文案", async () => {
    await mountSignedIn(true);

    fireEvent.mouseEnter(chipWrap());
    expect(screen.getByRole("menu")).toBeTruthy();

    expect(document.body.textContent).not.toContain("全局管理与审批");
    expect(document.body.textContent).not.toContain("管理员");
    expect(document.body.textContent).not.toContain("项目成员");
  });

  it("hover 打开菜单，移出后延时关闭（跨 8px 间隙不会一抖动就闪）", async () => {
    await mountSignedIn();

    expect(screen.queryByRole("menu"), "默认不渲染菜单").toBeNull();
    fireEvent.mouseEnter(chipWrap());
    expect(screen.getByRole("menu")).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "修改密码" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "退出登录" })).toBeTruthy();

    fireEvent.mouseLeave(chipWrap());
    expect(screen.queryByRole("menu"), "移出后立刻关闭会闪，必须留出容错时间").toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it("按功能更新、修改密码、退出登录顺序显示账号操作", async () => {
    await mountSignedIn();

    fireEvent.mouseEnter(chipWrap());
    const items = screen.getAllByRole("menuitem");
    expect(items.map((item) => item.textContent?.replace(/\s+/g, "").trim())).toEqual([
      "功能更新",
      "修改密码",
      "退出登录",
    ]);
    expect(items[0].getAttribute("href")).toBe("/changelog");
  });

  it("键盘可达：焦点进入 chip 即打开，方向键移动，Esc 关闭并把焦点还给 chip", async () => {
    await mountSignedIn();

    const chip = screen.getByRole("button", { name: /^账号菜单/ });
    fireEvent.focus(chip);
    expect(chip.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("menu")).toBeTruthy();

    fireEvent.keyDown(chip, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "功能更新" }));
    fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "修改密码" }));
    fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "退出登录" }));

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(chip.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(chip);
  });

  it("触屏：tap（pointerdown → focus → click）能打开，不会被 focus 抢先开后立刻关掉", async () => {
    await mountSignedIn();

    const chip = screen.getByRole("button", { name: /^账号菜单/ });
    fireEvent.pointerDown(chip);
    fireEvent.focus(chip);
    fireEvent.click(chip);
    expect(screen.getByRole("menu")).toBeTruthy();

    fireEvent.click(chip); // 再点一次收起
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("关闭状态下菜单项不在 DOM 里（不会留在 Tab 序列）", async () => {
    await mountSignedIn();

    expect(document.querySelectorAll('[role="menuitem"]').length).toBe(0);
    expect(chipWrap().querySelector('[role="menu"]')).toBeNull();
  });

  it("「修改密码」指向 /change-password，点击后菜单收起", async () => {
    await mountSignedIn();

    fireEvent.mouseEnter(chipWrap());
    const link = screen.getByRole("menuitem", { name: "修改密码" });
    expect(link.getAttribute("href")).toBe("/change-password");

    fireEvent.click(link);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("「退出登录」调用登出接口并回到登录页", async () => {
    await mountSignedIn();

    fireEvent.mouseEnter(chipWrap());
    fireEvent.click(screen.getByRole("menuitem", { name: "退出登录" }));

    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/login"));
    expect(mocks.logout).toHaveBeenCalled();
  });

  it("身份未确认时 chip 是骨架（无占位文字），但账号操作仍然可达", () => {
    pending.me = () => new Promise(() => {});
    pending.menus = () => new Promise(() => {});

    const { container } = mount();
    expect(container.textContent).not.toContain("当前用户");
    expect(screen.getAllByText("身份加载中").length).toBeGreaterThan(0);

    fireEvent.mouseEnter(chipWrap());
    expect(screen.getByRole("menu")).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "退出登录" })).toBeTruthy();
  });
});
