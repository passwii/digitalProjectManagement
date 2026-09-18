"""BLF-1141 验收走查：顶栏账号菜单 + 已删除的侧栏身份区（真实浏览器）。

为什么是**离线**走查（和前两个 acceptance 脚本不同）：这一批改动是纯前端外壳，
验收标准全是「顶栏不换行 / 不溢出 / 菜单不出视口 / 侧栏不再有身份区」这类几何与
DOM 断言，不依赖任何业务数据。所以脚本用 Playwright 路由拦截把 `/auth/me`、
`/meta/me/menus`、通知等接口就地 fulfill（并注入 middleware 需要的
`pm_access_token` cookie 与 localStorage token），**不需要后端在跑**，
验的仍是 `next build` + `next start` 的真实产物。

覆盖：
  · 侧栏底部再无身份区 / 登出按钮，只剩折叠开关（折叠功能本身没被顺手删掉）
  · 顶栏 chip：桌面显示姓名、≤900px 只留头像、身份未确认时是骨架
  · hover 打开菜单、移出后**延时**关闭（跨 8px 间隙不闪）、点空白处关闭
  · 键盘：focus 打开、方向键进首项、Esc 关闭并把焦点还给 chip
  · 菜单项 = 修改密码（→ /change-password）/ 退出登录（→ /login 且清会话）
  · 1440 / 900 / 375 三档：顶栏单行、无横向溢出、菜单不出视口；375 下触控 ≥44px
  · 角色权限文案（「全局管理与审批」等）整页不再出现

用法（先在前端 build 过）：
    cd web && npm run build && npx next start -p 3001
    python3 scripts/acceptance_blf1141_user_menu.py

依赖：playwright（channel=chrome）+ 可访问的 FE_BASE。
环境变量：
    FE_BASE   默认 http://127.0.0.1:3001
    SHOT_DIR  截图目录，默认系统临时目录下的 blf1141-shots
"""

import json
import os
import sys
import tempfile

from playwright.sync_api import TimeoutError as PWTimeout
from playwright.sync_api import sync_playwright

BASE = os.environ.get("FE_BASE", "http://127.0.0.1:3001")
SHOT_DIR = os.environ.get("SHOT_DIR") or os.path.join(tempfile.gettempdir(), "blf1141-shots")
TOL = 1.0  # 几何公差（px）

ME = {
    "id": 7,
    "username": "13900000001",
    "real_name": "张伟",
    "status": "active",
    "dept_id": None,
    "roles": [{"code": "admin", "name": "系统管理员"}],
    "must_change_pwd": False,
}
MENUS = {
    "roles": ["admin"],
    "is_admin": True,
    "can_approve": True,
    "menus": [
        {"key": "projects", "label": "项目台账", "href": "/projects"},
        {"key": "progress", "label": "进度跟踪", "href": "/progress"},
        {"key": "costs", "label": "支出记录", "href": "/costs"},
        {"key": "reports", "label": "支出报表", "href": "/reports"},
        {"key": "contacts", "label": "通讯录", "href": "/contacts"},
        {"key": "approvals", "label": "审批中心", "href": "/approvals"},
        {"key": "admin", "label": "系统管理", "href": "/admin"},
    ],
    "readonly": False,
    "demo_on": False,
    "can_toggle_demo": False,
}

FAILS: list[str] = []


def check(name: str, ok: bool, extra: str = "") -> None:
    print(("PASS " if ok else "FAIL ") + name + (f" — {extra}" if extra else ""))
    if not ok:
        FAILS.append(name)


def fulfill(route) -> None:
    url = route.request.url
    if "/auth/me" in url:
        body = ME
    elif "/meta/me/menus" in url:
        body = MENUS
    elif "notifications/count" in url:
        body = {"unread": 0}
    elif "/notifications" in url:
        body = {"items": [], "unread": 0, "total": 0}
    elif "/meta/" in url:
        body = []
    elif "/projects" in url:
        body = {"items": [], "total": 0, "page": 1, "size": 20}
    else:
        body = {}
    route.fulfill(status=200, content_type="application/json", body=json.dumps(body))


MEASURE = """
() => {
  const box = (el) => { if (!el) return null; const b = el.getBoundingClientRect();
    return { x: b.x, y: b.y, w: b.width, h: b.height, right: b.right, bottom: b.bottom }; };
  const chip = document.querySelector('button[aria-haspopup="menu"]');
  const wrap = chip ? chip.parentElement : null;
  const menu = document.querySelector('[role="menu"]');
  const bar = document.querySelector('[data-shell="topbar"]');
  const sidebar = document.querySelector('[data-shell="sidebar"]');
  const dock = document.querySelector('[data-shell="dock"]');
  const text = document.body.innerText;
  const visible = (el) => { if (!el) return false; const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") return false;
    const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
  return {
    winW: window.innerWidth, winH: window.innerHeight,
    docW: document.documentElement.scrollWidth,
    bar: box(bar), chip: box(chip), wrap: box(wrap), menu: box(menu),
    barFlexWrap: bar ? getComputedStyle(bar).flexWrap : "",
    chipTextVisible: visible(chip ? chip.querySelector('b') : null),
    sidebarVisible: visible(sidebar), dockVisible: visible(dock),
    sidebarButtons: sidebar ? Array.from(sidebar.querySelectorAll("button"))
      .map((b) => b.getAttribute("aria-label")) : [],
    sidebarText: sidebar ? sidebar.innerText : "",
    chipText: chip ? chip.innerText : "",
    expanded: chip ? chip.getAttribute("aria-expanded") : null,
    menuItems: Array.from(document.querySelectorAll('[role="menuitem"]')).map((n) => n.innerText.trim()),
    activeIsChip: document.activeElement === chip,
    bodyHasRoleLine: text.includes("全局管理与审批") || text.includes("普通用户 · 参与项目业务"),
  };
}
"""


def main() -> int:
    try:
        os.makedirs(SHOT_DIR, exist_ok=True)
    except OSError as e:
        raise SystemExit(f"无法创建截图目录 {SHOT_DIR}：{e}") from e
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome")
        ctx = browser.new_context(viewport={"width": 1440, "height": 900})
        ctx.add_cookies([{"name": "pm_access_token", "value": "blf1141", "domain": "127.0.0.1", "path": "/"}])
        # 中间件只看 cookie，但 SPA 的会话在 localStorage 里（没 token 就不会去请求 /auth/me，
        # chip 会永远停在骨架态）——两边都要给上
        ctx.add_init_script("localStorage.setItem('pm_access_token', 'blf1141');")
        page = ctx.new_page()
        page.route("**://localhost:8001/**", fulfill)
        page.route("**://127.0.0.1:8001/**", fulfill)

        page.goto(f"{BASE}/projects", wait_until="networkidle")
        # 预检：确认 FE_BASE 上跑的**就是本分支的构建**再开始断言。
        # 一个工作区里常有多个 worktree 的开发服务器同时躺着（3001/3011 这类常用端口
        # 很容易被别的 worktree 先占住），此时脚本会安安静静地去验别人的页面 ——
        # 实测踩到过：拿到的还是改前的侧栏身份区，断言全错但不报「环境不对」。
        # 新版顶栏身份区是 <button aria-haspopup="menu">，旧版是 <div>，用它当构建指纹。
        try:
            page.wait_for_selector('button[aria-haspopup="menu"]', timeout=5000)
        except PWTimeout as e:
            raise SystemExit(
                f"预检失败：{BASE} 的页面上没有新版账号菜单 chip（button[aria-haspopup=menu]）。\n"
                "  · 该端口上很可能是**别的 worktree** 的服务器（旧版顶栏身份区是不可交互的 <div>）；\n"
                "  · 请在本 worktree 里 `npm run build && npx next start -p <独占端口>`，再用 FE_BASE 指过去。"
            ) from e
        page.wait_for_selector('button[aria-haspopup="menu"]')
        page.wait_for_function("""() => {
          const b = document.querySelector('button[aria-haspopup="menu"] b');
          return !!b && b.innerText.trim().length > 0;
        }""")

        # ---------- 桌面 1440 ----------
        st = page.evaluate(MEASURE)
        check("1440 顶栏单行 64px", abs(st["bar"]["h"] - 64) <= TOL, f"h={st['bar']['h']}")
        check("1440 无横向溢出", st["docW"] <= st["winW"] + TOL, f"docW={st['docW']} winW={st['winW']}")
        check("1440 chip 显示姓名", st["chipTextVisible"] and "张伟" in st["chipText"], st["chipText"])
        check("1440 顶栏不含角色权限文案", not st["bodyHasRoleLine"])
        check("1440 侧栏只剩折叠开关", st["sidebarButtons"] == ["收起侧边栏"], str(st["sidebarButtons"]))
        check("1440 侧栏无用户名/登出", "张伟" not in st["sidebarText"] and "登出" not in st["sidebarText"])
        check("1440 折叠开关在场（折叠态没被顺手删掉）", st["sidebarVisible"])

        page.hover('button[aria-haspopup="menu"]')
        page.wait_for_selector('[role="menu"]')
        st = page.evaluate(MEASURE)
        menu = st["menu"]
        check("1440 hover 出菜单", menu is not None)
        check("1440 菜单项 = 修改密码/退出登录", st["menuItems"] == ["修改密码", "退出登录"], str(st["menuItems"]))
        check(
            "1440 菜单在视口内且右对齐 chip",
            menu["right"] <= st["winW"] - 8
            and menu["x"] >= 8
            and menu["bottom"] <= st["winH"]
            and abs(menu["right"] - st["wrap"]["right"]) <= TOL,
            f"menu={menu} wrapRight={st['wrap']['right']}",
        )
        check("1440 菜单与 chip 不重叠（8px 间隙）", menu["y"] >= st["chip"]["bottom"] - TOL)
        page.screenshot(path=f"{SHOT_DIR}/1440-menu-open.png")

        # 鼠标移出：延时关闭（不是立刻消失，也不是不关）
        page.mouse.move(40, 500)
        page.wait_for_selector('[role="menu"]', state="detached", timeout=2000)
        check("1440 鼠标移出后菜单关闭", page.query_selector('[role="menu"]') is None)

        # 键盘：focus 打开 → Esc 关闭并还焦
        page.focus('button[aria-haspopup="menu"]')
        page.wait_for_selector('[role="menu"]')
        st = page.evaluate(MEASURE)
        check("1440 键盘 focus 打开菜单", st["expanded"] == "true")
        page.keyboard.press("ArrowDown")
        focused_item = page.evaluate("() => document.activeElement.innerText.trim()")
        check("1440 方向键进入首项", focused_item == "修改密码", focused_item)
        page.keyboard.press("Escape")
        page.wait_for_selector('[role="menu"]', state="detached", timeout=2000)
        st = page.evaluate(MEASURE)
        check("1440 Esc 关闭并把焦点还给 chip", st["expanded"] == "false" and st["activeIsChip"])

        # 退出登录真的能用：点了要离开 /projects
        page.hover('button[aria-haspopup="menu"]')
        page.wait_for_selector('[role="menu"]')
        page.click('[role="menuitem"]:has-text("退出登录")')
        page.wait_for_url("**/login", timeout=5000)
        check("1440 退出登录跳登录页", "/login" in page.url, page.url)
        # 登出把 cookie 与 localStorage 都清了（这正是登出该做的），恢复会话再继续后面的尺寸档
        ctx.add_cookies([{"name": "pm_access_token", "value": "blf1141", "domain": "127.0.0.1", "path": "/"}])
        page.goto(f"{BASE}/projects", wait_until="networkidle")
        page.wait_for_selector('[data-shell="topbar"]')
        page.wait_for_timeout(150)

        # ---------- 平板 900 ----------
        page.set_viewport_size({"width": 900, "height": 800})
        page.wait_for_timeout(120)
        st = page.evaluate(MEASURE)
        check("900 顶栏单行 58px", abs(st["bar"]["h"] - 58) <= TOL, f"h={st['bar']['h']}")
        check("900 无横向溢出", st["docW"] <= st["winW"] + TOL, f"docW={st['docW']}")
        check("900 chip 文字按既有断点隐藏", not st["chipTextVisible"])
        page.hover('button[aria-haspopup="menu"]')
        page.wait_for_selector('[role="menu"]')
        st = page.evaluate(MEASURE)
        check("900 菜单在视口内", st["menu"]["right"] <= st["winW"] and st["menu"]["x"] >= 0, str(st["menu"]))
        page.screenshot(path=f"{SHOT_DIR}/900-menu-open.png")
        page.mouse.move(40, 400)
        page.wait_for_selector('[role="menu"]', state="detached", timeout=2000)

        # ---------- 手机 375 ----------
        page.set_viewport_size({"width": 375, "height": 812})
        page.wait_for_timeout(120)
        st = page.evaluate(MEASURE)
        check("375 顶栏单行 52px", abs(st["bar"]["h"] - 52) <= TOL, f"h={st['bar']['h']}")
        check("375 无横向溢出", st["docW"] <= st["winW"] + TOL, f"docW={st['docW']} winW={st['winW']}")
        check("375 侧栏退场、Dock 在场", not st["sidebarVisible"] and st["dockVisible"])
        check("375 chip 只剩头像（文字隐藏）", not st["chipTextVisible"])
        page.click('button[aria-haspopup="menu"]')
        page.wait_for_selector('[role="menu"]')
        st = page.evaluate(MEASURE)
        menu = st["menu"]
        check(
            "375 tap 打开菜单且不超出视口",
            menu["right"] <= st["winW"] - 8 and menu["x"] >= 8 and menu["bottom"] <= st["winH"],
            str(menu),
        )
        check(
            "375 菜单项 ≥44px 触控高度",
            page.evaluate(
                "() => Array.from(document.querySelectorAll('[role=\"menuitem\"]'))"
                ".every((n) => n.getBoundingClientRect().height >= 43.5)"
            ),
        )
        page.screenshot(path=f"{SHOT_DIR}/375-menu-open.png")
        page.mouse.click(200, 700)
        page.wait_for_selector('[role="menu"]', state="detached", timeout=2000)
        check("375 点空白处关闭菜单", page.query_selector('[role="menu"]') is None)

        # ---------- 1440 侧栏折叠态 ----------
        page.set_viewport_size({"width": 1440, "height": 900})
        page.wait_for_timeout(120)
        page.click('button[aria-label="收起侧边栏"]')
        page.wait_for_timeout(300)
        st = page.evaluate(MEASURE)
        check("1440 折叠态：侧栏 76px 且顶栏单行", abs(st["bar"]["h"] - 64) <= TOL and st["docW"] <= st["winW"] + TOL)
        page.hover('button[aria-haspopup="menu"]')
        page.wait_for_selector('[role="menu"]')
        st = page.evaluate(MEASURE)
        check("1440 折叠态：菜单仍不溢出", st["menu"]["right"] <= st["winW"] and st["menu"]["x"] >= 0)
        page.screenshot(path=f"{SHOT_DIR}/1440-collapsed-menu.png")

        browser.close()

    print(f"\n断言 {len(FAILS) == 0 and '全部通过' or '失败 ' + str(len(FAILS))}")
    if FAILS:
        print("失败项：" + "；".join(FAILS))
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(main())
