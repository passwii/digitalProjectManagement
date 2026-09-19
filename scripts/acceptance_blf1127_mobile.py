"""BLF-1127 验收走查：S1 手机壳基座（5 位底部 Dock + 767px 双外壳 CSS 切换）
+ S3 三态抽屉（peek / half / full + 手势，D2）。

契约：docs/superpowers/specs/2026-09-18-mobile-pwa-navigation-design.md §3 / §4 / §7 + 决策 D1–D3。
和 `acceptance_blf1093.py` 一样是**真浏览器 + 真后端**：不 mock 菜单接口，登录后
直接读 `/meta/me/menus` 真实返回，验的是「权限唯一入口 + 5 位 Dock」这一对约束。

覆盖：
  · Dock 恒 5 位、标签顺序 工作台/项目/进度/支出/我的（D1：不是「费用」）
  · 几何：贴底、满宽、含安全区、单点触控 ≥44×44、390px 与 360px 无横向溢出
  · D3：管理员「我的」位有红点且 Dock 仍 5 位；非管理员看不到审批/管理/通讯录
  · 壳切换：≥768px 显示侧栏隐藏 Dock，≤767px 反之
  · 「纯 CSS 切换、无首帧错误外壳」：**关掉 JS** 再断言一次（此时只有 CSS 能决定可见性）
  · 不回归：桌面 1440px 下 table.grid 仍在、Dock 不在场
  · S3/D2：点 5 个 Dock 位都开 peek 且不跳页；再点当前位收起；half/full 降回 peek
  · S3/§4 三档几何：peek ≤236px 无遮罩 / half 56% 有遮罩 / full 留白 ≥40px 且贴底
  · S3 手势：上拖升档、下甩 ≥96px 降档 / 关闭、点遮罩关闭、列表滚动优先（不抢手势）
  · S3/aa11y：模态档焦点陷阱、Esc 降档 / 关闭、关闭后焦点回到触发的 Dock 位、
    关闭中的抽屉不在命中链上（残留元素不得拦截点击）

用法：
    python3 scripts/acceptance_blf1127_mobile.py

依赖：playwright（channel=chrome）、本机后端 8001、前端 3001。

账号：浏览器登录表单只接受 **11 位手机号**（会把非数字字符直接删掉），而
`scripts/seed_mock.py` 的 demo_admin / zhangwei 是字母账号——它们在界面上永远登不进去。
所以本脚本先走**公开的管理员 API** 开两个保留号段的手机号账号（139 0000 0001 管理员 /
139 0000 0002 普通成员），再用它们登录。已验证过的账号会被直接复用（幂等）。
取 token 用的是 `api/seed.py` 的初始管理员，只用来开户，不改它的密码。

环境变量：
    FE_BASE / API_BASE / SHOT_DIR
    PM_SEED_USER / PM_SEED_PWD        开户用的管理员（默认 15796280534 / admin123456）
    PM_ADMIN_PHONE / PM_ADMIN_PWD     管理员手机号账号（默认 13900000001 / Blf1129demo）
    PM_MEMBER_PHONE / PM_MEMBER_PWD   非管理员手机号账号（默认 13900000002 / Blf1129demo）
"""

from __future__ import annotations

import json
import os
import re
import sys
import tempfile

import playwright.sync_api as pw
from playwright.sync_api import APIRequestContext, sync_playwright

BASE = os.environ.get("FE_BASE", "http://127.0.0.1:3001")
API = os.environ.get("API_BASE", "http://127.0.0.1:8001/api/v1")
# 截图 / results.json 默认落在系统临时目录（可用 SHOT_DIR 覆盖）；
# 用 tempfile.gettempdir() 而不是写死 /tmp，Windows 与受限沙箱上都能用。
SHOT = os.environ.get("SHOT_DIR") or os.path.join(
    tempfile.gettempdir(), "blf1127-shots"
)
SEED_USER = os.environ.get("PM_SEED_USER", "15796280534")
SEED_PWD = os.environ.get("PM_SEED_PWD", "admin123456")
ADMIN_PHONE = os.environ.get("PM_ADMIN_PHONE", "13900000001")
ADMIN_PWD = os.environ.get("PM_ADMIN_PWD", "Blf1129demo")
MEMBER_PHONE = os.environ.get("PM_MEMBER_PHONE", "13900000002")
MEMBER_PWD = os.environ.get("PM_MEMBER_PWD", "Blf1129demo")
# /admin/users 建出来的账号带 must_change_pwd，脚本自己走一次强制改密把它落定。
# 这是**保留号段的验收夹具密码**，不是密钥：与 scripts/seed_mock.py 的
# DEMO_PASSWORD、api/seed.py 的 admin123456 同一性质（可用环境变量覆盖）。
TMP_PWD = os.environ.get("PM_PROVISION_TMP_PWD") or "Blf1129tmp"

# 只允许 http(s)：API_BASE 是外部输入。API 末尾的斜杠是必须的的——
# playwright 的 base_url 遇以斜杠开头的 path 会直接替掉 base 的路径段（实测会打到 404）。
if not API.startswith(("http://", "https://")):
    raise SystemExit(f"API_BASE 必须是 http(s) URL，当前为 {API!r}")
API_BASE = API.rstrip("/") + "/"

# 契约常量：§7 的令牌与 §3 的 5 个位（写死在这里，改契约必须先改这里）
DOCK_H = 58
APPBAR_H = 52
DOCK_IDS = ["dashboard", "projects", "progress", "costs", "mine"]
DOCK_LABELS = ["工作台", "项目", "进度", "支出", "我的"]
ADMIN_ONLY_LABELS = ["审批中心", "系统管理", "通讯录"]

# S3 契约常量（§4）：三档几何与手势阈值写死在走查里，改契约必须先改这里
PEEK_MAX = 236  # peek 高度上限（px）
PEEK_RADIUS = 18  # 顶部圆角 --m-sheet-r
HALF_RATIO = 0.56  # half = 56% 视口高
FULL_TOP_MIN = 40  # full 顶部留白下限（不遮状态栏）
SWIPE_DOWN = 96  # 下甩阈值：降档 / 关闭
SWIPE_UP = 56  # 上拖阈值：升档
SHEET_TOPMOST_HIT = "dock"  # 关闭后命中链应落在 Dock 上（而不是残留的抽屉）


def prepare_shot_dir() -> str:
    """准备好截图目录。目录建不出来时退回当前目录而不是直接崩：
    PASS/FAIL 行本身仍然要打出来（只看看到底哪里没通过，比丢截图重要）。"""
    global SHOT
    try:
        os.makedirs(SHOT, exist_ok=True)
        return SHOT
    except OSError as e:
        fallback = os.path.join(os.getcwd(), "blf1127-shots")
        print(f"⚠ 截图目录 {SHOT} 不可用（{e}）→ 改用 {fallback}", flush=True)
        os.makedirs(fallback, exist_ok=True)
        SHOT = fallback
        return SHOT


results: list[dict] = []


def record(name: str, ok: bool, detail: str = "") -> None:
    results.append({"name": name, "ok": bool(ok), "detail": detail})
    print(
        f"{'PASS' if ok else 'FAIL'}  {name}{' — ' + detail if detail else ''}",
        flush=True,
    )


def write_results() -> None:
    """写 results.json（诊断产物）。写不进去只提示，不改判定——
    退出码由内存里的 PASS/FAIL 决定，不被一个落盘失败翻掉。"""
    path = os.path.join(SHOT, "results.json")
    try:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(results, f, ensure_ascii=False, indent=2)
    except OSError as e:
        print(f"⚠ 无法写入 {path}（{e}）；以终端输出为准", flush=True)


def login(page, user: str, pwd: str) -> bool:
    """走真实登录表单（不塞 localStorage：cookie 由登录流程自己写，才能过 middleware）"""
    page.goto(f"{BASE}/login", wait_until="networkidle")
    page.fill('form input:not([type="password"])', user)
    page.fill('form input[type="password"]', pwd)
    page.click('form button[type="submit"]')
    try:
        page.wait_for_url(lambda u: "/login" not in u, timeout=20000)
        return True
    except pw.TimeoutError:
        return False


def api(
    req: APIRequestContext,
    method: str,
    path: str,
    token: str | None = None,
    body: dict | None = None,
):
    """直连后端 API（开户 + 登录状态查询用；不走 curl，也不碰数据库）

    用 playwright 自带的 APIRequestContext 而不是 urllib：不必自己处理 JSON、
    与浏览器同一套依赖，且不用为了 scheme 校验去手写 urlopen 包装。
    """
    headers = {"Authorization": f"Bearer {token}"} if token else None
    r = req.fetch(
        path.lstrip("/"),
        method=method,
        data=body if body is not None else None,
        headers=headers,
    )
    # 按 content-type 判断而不是 try/except：FastAPI 成功与 HTTPException 都回
    # application/json，只有网关 / 代理层的 HTML 错误页才不是——那种情况原样回文本，
    # 比抛一个 JSON 解析异常更好定位。
    ctype = r.headers.get("content-type", "")
    payload = r.json() if "json" in ctype.lower() else (r.text() or "")[:200]
    return r.status, payload


def auth_token(req: APIRequestContext, username: str, password: str):
    """API 登录（后端不校验手机号格式，校验只在前端表单）：→ (token, must_change_pwd)"""
    status, body = api(
        req, "POST", "/auth/login", body={"username": username, "password": password}
    )
    if status == 200 and isinstance(body, dict):
        return body.get("access_token"), bool(body.get("must_change_pwd"))
    return None, False


def ensure_account(
    req: APIRequestContext,
    seed_token: str,
    phone: str,
    pwd: str,
    real_name: str,
    role: str,
):
    """确保存在一个可**在界面上登录**的手机号账号（幂等）。

    为什么需要它：前端登录表单把非数字字符直接删掉并按 /^1\\d{10}$/ 校验，
    seed 出来的字母账号在真实表单里登不进去，而手机壳验收必须在真表单里登录。
    开户走公开的管理员 API（不直接改库）；建出来的账号带 must_change_pwd，
    所以再走一次自助改密把密码定下来（auth 的既有契约，不是绕路）。
    """
    # 已经落定过：直接用
    token, must_change = auth_token(req, phone, pwd)
    if token and not must_change:
        return True, "已存在（复用）"

    detail = ""
    if not token:
        # 新号或临时密码阶段：用临时密码登录（/admin/users 的初始密码口径）
        token, must_change = auth_token(req, phone, TMP_PWD)
        if not token:
            status, resp = api(
                req,
                "POST",
                "/admin/users",
                token=seed_token,
                body={
                    "username": phone,
                    "password": TMP_PWD,
                    "real_name": real_name,
                    "roles": [role],
                },
            )
            detail = f"创建 {status}"
            if status != 200:
                return False, f"开户失败 {status}: {resp}"
            token, must_change = auth_token(req, phone, TMP_PWD)
            if not token:
                return False, "开户后仍无法登录"
    if must_change:
        status, resp = api(
            req,
            "POST",
            "/auth/change-password",
            token=token,
            body={"old_password": TMP_PWD, "new_password": pwd},
        )
        if status != 200:
            return False, f"强制改密失败 {status}: {resp}"
        detail = (detail + "，" if detail else "") + "已改密"
    token, must_change = auth_token(req, phone, pwd)
    return bool(token and not must_change), detail or "已验证"


def ensure_accounts(req: APIRequestContext) -> tuple[bool, str]:
    """两个账号一起准备：管理员（D3 红点）与非管理员（D3 隐藏管理入口）"""
    seed_token, _ = auth_token(req, SEED_USER, SEED_PWD)
    if not seed_token:
        return False, f"开户管理员 {SEED_USER} 登录失败（api/seed.py 的初始管理员？）"
    ok_a, det_a = ensure_account(
        req, seed_token, ADMIN_PHONE, ADMIN_PWD, "验收管理员", "admin"
    )
    ok_m, det_m = ensure_account(
        req, seed_token, MEMBER_PHONE, MEMBER_PWD, "验收成员", "member"
    )
    return (
        ok_a and ok_m,
        f"管理员 {ADMIN_PHONE}:{det_a}；非管理员 {MEMBER_PHONE}:{det_m}",
    )


def dock_boxes(page) -> list[dict]:
    """5 个 Dock 位的几何（用 data-dock 而不是文案定位：文案是可改的契约表面）"""
    return page.evaluate(
        """() => Array.from(document.querySelectorAll('[data-shell="dock"] [data-dock]')).map((el) => {
            const r = el.getBoundingClientRect();
            return { id: el.dataset.dock, label: el.querySelector('span:last-child')?.textContent?.trim() ?? '',
                     x: r.x, y: r.y, width: r.width, height: r.height,
                     current: el.getAttribute('aria-current') };
        })"""
    )


def shell_state(page) -> dict:
    """当前可见外壳 + 关键几何，全部从计算样式取（不读 class 名，CSS Modules 会哈希）"""
    return page.evaluate(
        """() => {
            const vis = (sel) => {
                const el = document.querySelector(sel);
                if (!el) return null;
                const cs = getComputedStyle(el);
                const r = el.getBoundingClientRect();
                return { display: cs.display, w: r.width, h: r.height, x: r.x, y: r.y };
            };
            return {
                dock: vis('[data-shell="dock"]'),
                sidebar: vis('[data-shell="sidebar"]'),
                topbar: vis('[data-shell="topbar"]'),
                vw: window.innerWidth, vh: window.innerHeight,
                overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            };
        }"""
    )


def sheet_state(page) -> dict | None:
    """抽屉的当前档位与几何（S3）。

    全部走 data-* 契约表面：`data-sheet` 的值就是当前档位（peek / half / full），
    `data-sheet-scrim` / `data-sheet-card` 同理 —— CSS Modules 的类名是哈希的，
    不能拿来当断言接口。面板不在 DOM 时返回 None（关闭后应如此）。
    """
    return page.evaluate(
        """() => {
            const panel = document.querySelector('[data-sheet]');
            if (!panel) return null;
            const r = panel.getBoundingClientRect();
            const cs = getComputedStyle(panel);
            const root = document.querySelector('[data-sheet-root]');
            const scrim = document.querySelector('[data-sheet-scrim]');
            const body = panel.querySelector('[data-sheet-body]');
            const br = body.getBoundingClientRect();
            const dock = document.querySelector('[data-shell="dock"]');
            const cards = Array.from(panel.querySelectorAll('[data-sheet-card]')).map((el) => {
                const cr = el.getBoundingClientRect();
                return { variant: el.dataset.sheetCard,
                         title: el.querySelector('span span')?.textContent?.trim() ?? '',
                         y: cr.y, bottom: cr.bottom, h: cr.height, w: cr.width };
            });
            return {
                stop: panel.dataset.sheet,
                open: panel.dataset.open,
                dragging: panel.dataset.dragging,
                x: r.x, y: r.y, w: r.width, h: r.height, bottom: r.bottom,
                radius: parseFloat(cs.borderTopLeftRadius),
                transform: cs.transform,
                transformY: cs.transform === "none" ? 0 : new DOMMatrixReadOnly(cs.transform).m42,
                role: panel.getAttribute('role'),
                ariaModal: panel.getAttribute('aria-modal'),
                scrimOn: scrim ? scrim.dataset.on : null,
                scrimOpacity: scrim ? Number(getComputedStyle(scrim).opacity) : null,
                scrimPE: scrim ? getComputedStyle(scrim).pointerEvents : null,
                rootZ: root ? Number(getComputedStyle(root).zIndex) || 0 : 0,
                rootPE: root ? getComputedStyle(root).pointerEvents : null,
                bodyScrollTop: body.scrollTop,
                bodyScrollable: body.scrollHeight > body.clientHeight + 1,
                bodyScrollH: body.scrollHeight,
                bodyClientH: body.clientHeight,
                cards: cards,
                dockH: dock ? dock.getBoundingClientRect().height : 0,
                vw: window.innerWidth, vh: window.innerHeight,
                focusInSheet: panel.contains(document.activeElement),
                focused: document.activeElement
                    ? (document.activeElement.dataset?.dock || document.activeElement.tagName)
                    : null,
            };
        }"""
    )


def sheet_present(page) -> dict:
    """当前抽屉状态，且**必须在场**（S3）。

    断言里对 `sheet_state()` 直接下标会在面板缺席时炸成一片 173 行的类型错误，
    真正的信息只有「上一步没把抽屉打开」。这里早失败：面板不在场就直接抛，
    错误信息指向场景而不是下标。
    """
    st = sheet_state(page)
    if st is None:
        raise AssertionError("抽屉不在场：上一步的交互没有把它打开")
    return st


def sheet_drag(page, dy: int, target: str = "grip", steps: int = 8) -> None:
    """在抽屉上做一次纵向拖拽（S3 手势）。

    `target="grip"` 从把手起手（用户手势的标准抓握区，也是 half / full 档下
    唯一该接手势的地方）；`target="body"` 从列表面板起手 —— 用来验
    「列表滚到顶部才允许整体拖拽」那道门。

    走 Pointer Events（抽屉的手势实现）：Playwright 的 mouse 会派发
    pointerdown / pointermove / pointerup，面板用 setPointerCapture 收后续事件。
    """
    selector = (
        "[data-sheet] [data-sheet-grip]"
        if target == "grip"
        else "[data-sheet] [data-sheet-body]"
    )
    box = page.locator(selector).bounding_box()
    assert box is not None, (
        f"抽屉的 {selector} 不在场，无法拖拽（上一步没把面板打开？）"
    )
    # body 从左侧 8px 起手：那是面板的内边距带，不属于任何卡片 ——
    # 免得拖拽结束时在卡片上补一发 click 把页面导航走
    x = box["x"] + (box["width"] / 2 if target == "grip" else 8)
    y = box["y"] + min(40.0, box["height"] / 2)
    page.mouse.move(x, y)
    page.mouse.down()
    page.wait_for_timeout(60)
    page.mouse.move(x, y + dy, steps=steps)
    page.wait_for_timeout(60)
    page.mouse.up()
    # 换档动画 260ms + 余量：几何断言不能掉在动画中间
    page.wait_for_timeout(420)


def main() -> int:
    errors: list[str] = []
    prepare_shot_dir()

    with sync_playwright() as p:
        # 账号必须先落定：前端登录表单只认 11 位手机号（见 ensure_account 注释）
        req = p.request.new_context(base_url=API_BASE)
        acc_ok, acc_detail = ensure_accounts(req)
        record("验收账号就位（管理员 + 非管理员手机号账号）", acc_ok, acc_detail)
        # req 不在这里 dispose：后面还要用它验 Dock 5 个落点的 RSC payload（同一个连接池）
        if not acc_ok:
            req.dispose()
            write_results()
            return 1

        browser = p.chromium.launch(channel="chrome")

        # ============ 管理员 + 390px：Dock 的几何与内容 ============
        ctx = browser.new_context(viewport={"width": 390, "height": 844})
        page = ctx.new_page()
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on(
            "console",
            lambda m: errors.append(f"console:{m.text}") if m.type == "error" else None,
        )
        page.on("dialog", lambda d: d.dismiss())

        ok = login(page, ADMIN_PHONE, ADMIN_PWD)
        record(f"登录（管理员 {ADMIN_PHONE}）", ok, page.url)
        if not ok:
            browser.close()
            print("登录失败，后续断言无法进行")
            return 1
        page.wait_for_selector('[data-shell="dock"]', timeout=15000)
        page.goto(f"{BASE}/dashboard", wait_until="networkidle")
        page.wait_for_timeout(900)

        st = shell_state(page)
        dock = st["dock"]
        record(
            "390px：Dock 在场且侧栏退场",
            bool(dock)
            and dock["display"] != "none"
            and st["sidebar"]["display"] == "none",
            f"dock.display={dock['display']} sidebar.display={st['sidebar']['display']}",
        )

        bottom_gap = round(st["vh"] - (dock["y"] + dock["h"]), 1)
        record(
            "Dock 贴底且满宽",
            abs(bottom_gap) <= 1
            and abs(dock["x"]) <= 1
            and abs(dock["w"] - st["vw"]) <= 1,
            f"底边留白={bottom_gap}px x={dock['x']} 宽={dock['w']} 视口={st['vw']}",
        )
        record(
            f"Dock 高度 = {DOCK_H}px（+ 安全区，桌面 Chrome 安全区为 0）",
            DOCK_H <= dock["h"] <= DOCK_H + 40,
            f"实测 {dock['h']}px",
        )

        tabs = dock_boxes(page)
        record("Dock 恒 5 位", len(tabs) == 5, f"{len(tabs)} 位")
        record(
            "Dock 位顺序 = 契约顺序（dashboard/projects/progress/costs/mine）",
            [t["id"] for t in tabs] == DOCK_IDS,
            " / ".join(t["id"] for t in tabs),
        )
        record(
            "标签顺序 = 工作台 / 项目 / 进度 / 支出 / 我的（D1）",
            [t["label"] for t in tabs] == DOCK_LABELS,
            " / ".join(t["label"] for t in tabs),
        )
        record(
            "D1：第 4 位是「支出」，不是「费用」",
            "费用" not in [t["label"] for t in tabs] and tabs[3]["label"] == "支出",
            f"第 4 位={tabs[3]['label']}",
        )

        min_w = min(t["width"] for t in tabs)
        min_h = min(t["height"] for t in tabs)
        record(
            "单点触控 ≥44×44",
            min_w >= 44 and min_h >= 44,
            f"最小 {round(min_w, 1)}×{round(min_h, 1)}",
        )

        record(
            "当前位高亮且只有一位",
            sum(1 for t in tabs if t["current"] == "page") == 1
            and [t["id"] for t in tabs if t["current"] == "page"] == ["dashboard"],
            f"aria-current=page 落在 {[t['id'] for t in tabs if t['current'] == 'page']}",
        )

        # 溢出只按**外壳**判定，不按整页：工作台的「本月支出」卡是一张未包滚动容器的
        # table.grid，本身就是 443px 宽（390px 下溢出 67px），是 S1 之前的既有问题，
        # 不属于本 stage 的范围（§4.2/D4 的表格卡片流只覆盖项目台账与审批中心）。
        # 所以这里拆成两条互相制约的断言：
        #   · 外壳元素全部落在视口内；
        #   · 在**内容本身不溢出**的页面上整页也确实不溢出。
        shell_fits = page.evaluate(
            """() => {const vw = document.documentElement.clientWidth;
                      return ['[data-shell=\"topbar\"]', '[data-shell=\"dock\"]'].every((sel) => {
                          const el = document.querySelector(sel);
                          if (!el) return false;
                          const r = el.getBoundingClientRect();
                          return r.left >= -1 && r.right <= vw + 1;
                      });}"""
        )
        record(
            "390px：外壳元素（顶栏 / Dock）都在视口内",
            shell_fits,
            f"顶栏 right={round(st['topbar']['x'] + st['topbar']['w'], 1)} dock right={round(dock['x'] + dock['w'], 1)}",
        )
        topbar_h = st["topbar"]["h"] if st["topbar"] else 0
        record(
            f"手机顶栏高度 = {APPBAR_H}px（--m-appbar-h）",
            abs(topbar_h - APPBAR_H) <= 1,
            f"实测 {topbar_h}px",
        )
        page.screenshot(path=f"{SHOT}/01-dock-390-admin.png")

        # D3：管理员红点 + 管理入口不进 Dock
        badge = page.locator('[data-shell="dock"] [data-badge]')
        record(
            "D3：管理员「我的」位出现待办红点",
            badge.count() == 1
            and page.locator(
                '[data-shell="dock"] [data-dock="mine"] [data-badge]'
            ).count()
            == 1,
            f"红点 {badge.count()} 个",
        )
        dock_text = " ".join(page.locator('[data-shell="dock"]').inner_text().split())
        record(
            "D3：审批中心 / 系统管理 / 通讯录不出现在 Dock",
            all(x not in dock_text for x in ADMIN_ONLY_LABELS),
            dock_text,
        )

        # 桌面外壳（此刻被 CSS 隐藏）里仍然有这三个入口 —— 证明「不进 Dock」不是把菜单删了
        side_text = " ".join(
            page.locator('[data-shell="sidebar"]').inner_text().split()
        )
        record(
            "D3 反证：三个管理入口仍在侧栏（隐藏外壳），只是不进 Dock",
            all(x in side_text for x in ADMIN_ONLY_LABELS),
            side_text[:90],
        )

        # 高亮跟随路由（D1：/reports 也落在「支出」位）
        page.goto(f"{BASE}/reports", wait_until="networkidle")
        page.wait_for_timeout(600)
        tabs = dock_boxes(page)
        record(
            "D1：/reports 高亮「支出」位",
            [t["id"] for t in tabs if t["current"] == "page"] == ["costs"],
            f"{[t['id'] for t in tabs if t['current'] == 'page']}",
        )

        # ============ 360px 窄屏 ============
        page.goto(f"{BASE}/dashboard", wait_until="networkidle")
        page.set_viewport_size({"width": 360, "height": 780})
        page.wait_for_timeout(600)
        st360 = shell_state(page)
        tabs360 = dock_boxes(page)
        record(
            "360px：Dock 仍 5 位且满宽贴底",
            len(tabs360) == 5
            and abs(st360["dock"]["w"] - st360["vw"]) <= 1
            and abs(st360["vh"] - (st360["dock"]["y"] + st360["dock"]["h"])) <= 1,
            f"宽={st360['dock']['w']} 视口={st360['vw']}",
        )
        labels_fit = page.evaluate(
            """() => Array.from(document.querySelectorAll('[data-shell="dock"] [data-dock] span:last-child'))
                       .every((el) => el.scrollWidth <= el.clientWidth + 1)"""
        )
        record("360px：Dock 标签不溢出不截断", labels_fit)
        page.screenshot(path=f"{SHOT}/02-dock-360-admin.png")

        # 外壳零贡献对照组：在同一页上把 Dock 关掉再量一次整页溢出，两者必须完全一致
        # ——「外壳不引入横向溢出」这句话的可验证形式，而不是拿一个既有的内容溢出去卡外壳。
        ov_with = page.evaluate(
            "() => document.documentElement.scrollWidth - document.documentElement.clientWidth"
        )
        page.add_style_tag(content='[data-shell="dock"]{display:none !important}')
        page.wait_for_timeout(400)
        ov_without = page.evaluate(
            "() => document.documentElement.scrollWidth - document.documentElement.clientWidth"
        )
        record(
            "360px：Dock 对整页横向溢出零贡献（隐藏前后溢出量相同）",
            ov_with == ov_without,
            f"有 Dock={ov_with}px / 无 Dock={ov_without}px",
        )

        # 内容本身装得下的页面（支出录入，已经过卡片化前的窄屏适配）：整页必须为 0
        page.goto(f"{BASE}/costs", wait_until="networkidle")
        page.wait_for_timeout(1500)
        for w in (390, 360):
            page.set_viewport_size({"width": w, "height": 800})
            page.wait_for_timeout(500)
            ov = page.evaluate(
                "() => document.documentElement.scrollWidth - document.documentElement.clientWidth"
            )
            record(
                f"{w}px：内容装得下的页面（/costs）整页无横向溢出",
                ov <= 2,
                f"横向溢出 {ov}px",
            )

        # ============ 固定 Dock 不能盖住既有弹层（S3/S4 的抽屉会同在底部，先钉住） ============
        admin_token, _ = auth_token(req, ADMIN_PHONE, ADMIN_PWD)
        _, proj = api(req, "GET", "/projects/options?page=1&size=1", token=admin_token)
        proj_id = None
        if isinstance(proj, dict):
            items = proj.get("items") or []
            if items and isinstance(items[0], dict):
                proj_id = items[0].get("id")
        page.set_viewport_size({"width": 390, "height": 844})
        page.goto(f"{BASE}/costs?project_id={proj_id}", wait_until="networkidle")
        page.wait_for_timeout(1800)
        page.locator('button:has-text("+ 支出")').first.click()
        page.wait_for_timeout(1000)
        modal = page.evaluate(
            """() => {const dlg = document.querySelector('[role="dialog"]');
                      if (!dlg) return { ok: false, why: '弹层没打开' };
                      const dock = document.querySelector('[data-shell="dock"]');
                      const dz = Number(getComputedStyle(dock).zIndex) || 0;
                      // 遮罩层（弹层外层）才是与 Dock 比层级的那一层
                      let ov = dlg, z = Number(getComputedStyle(ov).zIndex) || 0;
                      while (ov.parentElement) { ov = ov.parentElement;
                          const pz = Number(getComputedStyle(ov).zIndex) || 0;
                          if (pz > z) z = pz; }
                      const covered = Array.from(dlg.querySelectorAll('button')).filter((el) => {
                          const r = el.getBoundingClientRect();
                          if (r.width === 0) return false;
                          const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
                          return !(top && (el === top || el.contains(top)));
                      });
                      return { ok: z > dz && covered.length === 0, why: `弹层 z=${z} > Dock z=${dz}，被挡住的按钮 ${covered.length} 个` };}"""
        )
        record(
            "390px：弹层在主操作区不被固定 Dock 遮挡",
            bool(proj_id) and modal["ok"],
            modal["why"] if proj_id else "取不到项目样本，弹层未验证",
        )
        page.keyboard.press("Escape")
        page.wait_for_timeout(400)

        # ============ S3：三态抽屉（peek / half / full + 手势，D2） ============
        # 契约：§4（三档几何 + 手势语义）+ D2（点 Dock 不跳页、再点当前位降档、不做长按）。
        # 定位一律走 data-* 契约表面（data-sheet / data-sheet-scrim / data-sheet-card…），
        # 不读 CSS Modules 的哈希类名。
        page.set_viewport_size({"width": 390, "height": 844})
        page.goto(f"{BASE}/projects", wait_until="networkidle")
        page.wait_for_timeout(1500)

        # ---- D2：点 5 个 Dock 位都开 peek，且都不跳页 ----
        opened_ids: list[str] = []
        for dock_id in DOCK_IDS:
            url_before = page.url
            page.click(f'[data-shell="dock"] [data-dock="{dock_id}"]')
            page.wait_for_timeout(450)
            st = sheet_present(page)
            ok = (
                st is not None
                and st["open"] == "true"
                and st["stop"] == "peek"
                and page.url == url_before
            )
            record(
                f"S3/D2：点「{dock_id}」位开 peek 且不跳页",
                ok,
                f"档位={st['stop'] if st else '无面板'} URL={'未变' if page.url == url_before else page.url}",
            )
            if ok:
                opened_ids.append(dock_id)
            # 再点当前位 → peek 收起（D2：不存在点了没反应的死键）
            page.click(f'[data-shell="dock"] [data-dock="{dock_id}"]')
            page.wait_for_timeout(450)
        record(
            "S3/D2：5 个 Dock 位都能开 peek",
            len(opened_ids) == 5,
            " / ".join(opened_ids) or "一个都没开",
        )

        # 关闭后：面板已退场，且不在命中链上（残留元素不得拦截点击）
        closed_state = sheet_state(page)
        closed_hit = page.evaluate(
            """() => {const el = document.querySelector('[data-shell="dock"] [data-dock="projects"]');
                      const r = el.getBoundingClientRect();
                      const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
                      return { onDock: !!top?.closest('[data-shell="dock"]'), inSheet: !!top?.closest('[data-sheet]') };}"""
        )
        record(
            "再点当前位：peek 收起（面板已退场且不在命中链上）",
            closed_state is None and closed_hit["onDock"] and not closed_hit["inSheet"],
            f"面板={'已退场' if closed_state is None else closed_state['open']} / 命中={'Dock' if closed_hit['onDock'] else '非 Dock'}",
        )

        # ---- peek 几何（§4 表）+ 非模态语义 ----
        page.click('[data-shell="dock"] [data-dock="projects"]')
        page.wait_for_timeout(500)
        peek = sheet_present(page)
        dock_z = page.evaluate(
            "() => Number(getComputedStyle(document.querySelector('[data-shell=\"dock\"]')).zIndex) || 0"
        )
        body_overflow = page.evaluate("() => document.body.style.overflow")

        record(
            f"peek 高度 ≤{PEEK_MAX}px（契约上限）",
            peek["h"] <= PEEK_MAX,
            f"实测 {round(peek['h'], 1)}px",
        )
        record(
            "peek 无遮罩（opacity=0 且不放行命中，页面照常可点）",
            peek["scrimOn"] == "false"
            and peek["scrimOpacity"] == 0
            and peek["scrimPE"] == "none",
            f"data-on={peek['scrimOn']} opacity={peek['scrimOpacity']} pointer-events={peek['scrimPE']}",
        )
        record(
            "peek 贴底、满宽、顶部圆角 = --m-sheet-r(18px)",
            abs(peek["bottom"] - peek["vh"]) <= 1
            and abs(peek["w"] - peek["vw"]) <= 1
            and abs(peek["radius"] - PEEK_RADIUS) <= 1,
            f"底={round(peek['bottom'], 1)}/{peek['vh']} 宽={peek['w']}/{peek['vw']} 圆角={peek['radius']}",
        )
        first_card = peek["cards"][0] if peek["cards"] else None
        record(
            "peek 首张卡片完整可见，且不落在「Dock 带」里（内容不被 Dock 盖住）",
            first_card is not None
            and first_card["bottom"] <= peek["bottom"] - peek["dockH"] + 1
            and first_card["h"] >= 44,
            f"卡底={round(first_card['bottom'], 1) if first_card else None} "
            f"面板底={round(peek['bottom'], 1)} Dock 带={round(peek['dockH'])}px",
        )
        record(
            "peek 是非模态档（aria-modal=false 且不锁页面滚动）",
            peek["ariaModal"] == "false"
            and peek["role"] == "dialog"
            and body_overflow != "hidden",
            f"aria-modal={peek['ariaModal']} body.overflow={body_overflow or '(空)'}",
        )
        record(
            "打开抽屉时焦点落在面板内（焦点陷阱 / 归还的前提）",
            peek["focusInSheet"],
            f"activeElement={peek['focused']}",
        )
        record(
            f"抽屉层级低于 Dock（{peek['rootZ']} < {dock_z}）：遮罩不盖 Dock",
            peek["rootZ"] < dock_z,
            f"sheet z={peek['rootZ']} dock z={dock_z}（再点当前位降档就靠这条）",
        )
        page.screenshot(path=f"{SHOT}/06-sheet-peek.png")

        # ---- aa11y：Esc 收起 + 焦点回到触发的 Dock 位 ----
        page.keyboard.press("Escape")
        page.wait_for_timeout(600)
        focused_after = page.evaluate(
            "() => document.activeElement?.dataset?.dock || document.activeElement?.tagName || null"
        )
        record(
            "Esc：peek 收起，且焦点回到触发的 Dock 位（projects）",
            sheet_state(page) is None and focused_after == "projects",
            f"面板={'已退场' if sheet_state(page) is None else '仍在场'} activeElement={focused_after}",
        )

        # ---- 手势：上拖 peek → half → full ----
        page.click('[data-shell="dock"] [data-dock="projects"]')
        page.wait_for_timeout(500)
        peek_state = sheet_present(page)
        peek_titles = [c["title"] for c in peek_state["cards"]]
        sheet_drag(page, -(SWIPE_UP + 80))  # 上拖 136px：越过 56px 阈值
        half = sheet_present(page)
        record(
            "上拖 >56px：peek → half", half["stop"] == "half", f"档位={half['stop']}"
        )
        record(
            "half 高度 = 56% 视口（±2px）",
            abs(half["h"] - half["vh"] * HALF_RATIO) <= 2,
            f"实测 {round(half['h'], 1)}px / 期望 {round(half['vh'] * HALF_RATIO, 1)}px",
        )
        record(
            "half 有遮罩，且遮罩可接收点击（pointer-events 已恢复）",
            half["scrimOn"] == "true" and half["scrimPE"] == "auto",
            f"data-on={half['scrimOn']} pointer-events={half['scrimPE']}",
        )
        record(
            "half 比 peek 高（确实升了一档）",
            half["y"] < peek_state["y"],
            f"面板顶 {round(peek_state['y'], 1)} → {round(half['y'], 1)}",
        )
        record(
            "换档不换内容：peek 与 half 是同一批卡片、只换形态（preview → list）",
            [c["title"] for c in half["cards"]] == peek_titles
            and {c["variant"] for c in half["cards"]} == {"list"},
            f"卡片 {peek_titles} / 形态 {[c['variant'] for c in half['cards']]}",
        )
        record(
            "half 是模态档（aria-modal=true）",
            half["ariaModal"] == "true",
            f"aria-modal={half['ariaModal']}",
        )
        page.screenshot(path=f"{SHOT}/07-sheet-half.png")

        # ---- aa11y：half（模态）焦点陷阱生效 ----
        trapped = True
        for _ in range(8):
            page.keyboard.press("Tab")
            if not page.evaluate(
                "() => !!document.querySelector('[data-sheet]')?.contains(document.activeElement)"
            ):
                trapped = False
                break
        record("half（模态档）焦点陷阱生效：Tab 循环不逃出面板", trapped)

        sheet_drag(page, -(SWIPE_UP + 80))
        full = sheet_present(page)
        record(
            "上拖 >56px：half → full", full["stop"] == "full", f"档位={full['stop']}"
        )
        record(
            f"full 不遮状态栏（顶部留白 ≥{FULL_TOP_MIN}px）",
            full["y"] >= FULL_TOP_MIN,
            f"顶部留白 {round(full['y'], 1)}px",
        )
        record(
            "full 贴底且整屏（高度 ≥ 视口 - 60px）",
            abs(full["bottom"] - full["vh"]) <= 1 and full["h"] >= full["vh"] - 60,
            f"底={round(full['bottom'], 1)}/{full['vh']} 高={round(full['h'], 1)}",
        )
        page.screenshot(path=f"{SHOT}/08-sheet-full.png")

        # ---- 手势：下甩 ≥96px 逐档降 ----
        sheet_drag(page, SWIPE_DOWN + 44)
        record(
            "下甩 >96px：full → half",
            sheet_present(page)["stop"] == "half",
            f"档位={sheet_present(page)['stop']}",
        )
        sheet_drag(page, SWIPE_DOWN + 44)
        record(
            "下甩 >96px：half → peek",
            sheet_present(page)["stop"] == "peek",
            f"档位={sheet_present(page)['stop']}",
        )
        sheet_drag(page, SWIPE_DOWN + 44)
        st = sheet_state(page)
        record(
            "下甩 >96px：peek → 关闭（面板退场）",
            st is None or st["open"] == "false",
            f"面板={'已退场' if st is None else st['open']}",
        )

        # ---- 点遮罩关闭（§4） ----
        page.click('[data-shell="dock"] [data-dock="projects"]')
        page.wait_for_timeout(500)
        sheet_drag(page, -(SWIPE_UP + 80))  # 升到 half（有遮罩）
        page.mouse.click(peek_state["vw"] / 2, 120)  # 屏幕上部 = 遮罩
        page.wait_for_timeout(600)
        st = sheet_state(page)
        record(
            "点遮罩关闭抽屉",
            st is None or st["open"] == "false",
            f"面板={'已退场' if st is None else st['open']}",
        )

        # ---- D2：再点当前位，half 降回 peek（不是收起） ----
        page.click('[data-shell="dock"] [data-dock="projects"]')
        page.wait_for_timeout(500)
        sheet_drag(page, -(SWIPE_UP + 80))
        record(
            "前置：先升到 half",
            sheet_present(page)["stop"] == "half",
            f"档位={sheet_present(page)['stop']}",
        )
        page.click('[data-shell="dock"] [data-dock="projects"]')
        page.wait_for_timeout(500)
        st = sheet_present(page)
        record(
            "D2：再点当前位（half）→ 降回 peek 而不是关闭（无死键）",
            st is not None and st["open"] == "true" and st["stop"] == "peek",
            f"档位={st['stop'] if st else '已退场'} open={st['open'] if st else None}",
        )
        record(
            "降回 peek 后遮罩关闭",
            st is not None and st["scrimOn"] == "false" and st["scrimPE"] == "none",
            f"data-on={st['scrimOn'] if st else None} pointer-events={st['scrimPE'] if st else None}",
        )

        # ---- aa11y：Esc 降档（half → peek，而不是关闭）+ peek 不锁 Tab ----
        sheet_drag(page, -(SWIPE_UP + 80))  # peek → half
        page.keyboard.press("Escape")
        page.wait_for_timeout(500)
        st = sheet_present(page)
        record(
            "Esc：half → peek（降一档，不是关闭）",
            st is not None and st["open"] == "true" and st["stop"] == "peek",
            f"档位={st['stop'] if st else '已退场'}",
        )
        page.keyboard.press("Shift+Tab")
        page.wait_for_timeout(250)
        left_panel = page.evaluate(
            "() => !document.querySelector('[data-sheet]')?.contains(document.activeElement)"
        )
        record(
            "peek 非模态：Shift+Tab 能离开面板（不把键盘用户关在无遮罩面板里）",
            bool(left_panel),
            f"activeElement={page.evaluate('() => document.activeElement?.dataset?.dock || document.activeElement?.tagName')}",
        )
        page.keyboard.press("Escape")
        page.wait_for_timeout(500)

        # ---- D2：不做长按手势（按住 700ms 松手仍停在 peek） ----
        long_box = page.locator(
            '[data-shell="dock"] [data-dock="costs"]'
        ).bounding_box()
        assert long_box is not None, "Dock 的「支出」位取不到几何，长按断言无法进行"
        page.mouse.move(
            long_box["x"] + long_box["width"] / 2,
            long_box["y"] + long_box["height"] / 2,
        )
        page.mouse.down()
        page.wait_for_timeout(700)
        page.mouse.up()
        page.wait_for_timeout(500)
        st = sheet_present(page)
        record(
            "D2：不做长按手势（按住 700ms 松手仍停在 peek，不进 half/full）",
            st is not None and st["stop"] == "peek",
            f"档位={st['stop'] if st else '已退场'}",
        )
        page.keyboard.press("Escape")
        page.wait_for_timeout(500)

        # ---- §4「抽屉内列表滚到顶部时才允许整体拖拽」 ----
        # 用短屏（390×420）与卡片最多的「我的」位：half 档下列表必定高于容器，
        # 才能真的验「列表滚过了就先滚列表」；正向 + 反向各一条，证明门不是堵死的墙。
        page.set_viewport_size({"width": 390, "height": 420})
        page.wait_for_timeout(400)
        page.click('[data-shell="dock"] [data-dock="mine"]')
        page.wait_for_timeout(500)
        sheet_drag(page, -(SWIPE_UP + 70))  # peek → half
        st = sheet_present(page)
        record(
            "前置：half 档下列表可滚动（内容高于容器）",
            st["stop"] == "half" and st["bodyScrollable"],
            f"档位={st['stop']} scrollHeight={st['bodyScrollH']} > clientHeight={st['bodyClientH']}:"
            f" {st['bodyScrollable']}",
        )
        page.evaluate(
            "() => { document.querySelector('[data-sheet-body]').scrollTop = 60; }"
        )
        page.wait_for_timeout(200)
        sheet_drag(page, -150, target="body")
        st = sheet_present(page)
        # 判定只看「整体拖拽有没有被启动」：档位没变 + 面板没位移。
        # （拖拽过程中列表自身会不会被浏览器带着滚（命中测试 / 选择自动滚）与门无关，
        #   所以 scrollTop 只写进 detail，不当断言条件。）
        record(
            "列表已滚过顶部：从列表上拖不动抽屉（滚动优先，不抢手势）",
            st["stop"] == "half" and st["transformY"] == 0,
            f"档位={st['stop']} 面板位移={st['transformY']}px scrollTop 60 → {st['bodyScrollTop']}",
        )
        page.evaluate(
            "() => { document.querySelector('[data-sheet-body]').scrollTop = 0; }"
        )
        page.wait_for_timeout(200)
        sheet_drag(page, -150, target="body")
        st = sheet_present(page)
        record(
            "反向对照：列表回到顶部后，同一手势能升档（half → full）",
            st["stop"] == "full",
            f"档位={st['stop']}",
        )

        # 收尾：降回 peek 再关闭（后续 section 依赖「抽屉不在场」）
        page.keyboard.press("Escape")
        page.wait_for_timeout(400)
        page.keyboard.press("Escape")
        page.wait_for_timeout(500)
        page.set_viewport_size({"width": 390, "height": 844})
        page.wait_for_timeout(400)

        # ---- 不回归：桌面端不渲染该组件；抽屉对横向溢出零贡献 ----
        page.set_viewport_size({"width": 1440, "height": 900})
        page.goto(f"{BASE}/projects", wait_until="networkidle")
        page.wait_for_timeout(1500)
        desk = page.evaluate(
            """() => ({ root: document.querySelectorAll('[data-sheet-root]').length,
                        panel: document.querySelectorAll('[data-sheet]').length,
                        dock: getComputedStyle(document.querySelector('[data-shell="dock"]')).display })"""
        )
        record(
            "1440px：抽屉组件不渲染（root / panel 都不在 DOM 里）",
            desk["root"] == 0 and desk["panel"] == 0 and desk["dock"] == "none",
            f"root={desk['root']} panel={desk['panel']} dock.display={desk['dock']}",
        )

        page.set_viewport_size({"width": 390, "height": 844})
        page.goto(f"{BASE}/costs", wait_until="networkidle")
        page.wait_for_timeout(1500)
        ov_closed = page.evaluate(
            "() => document.documentElement.scrollWidth - document.documentElement.clientWidth"
        )
        page.click('[data-shell="dock"] [data-dock="costs"]')
        page.wait_for_timeout(500)
        sheet_drag(page, -(SWIPE_UP + 80))  # half
        sheet_drag(page, -(SWIPE_UP + 80))  # full
        st = sheet_present(page)
        ov_open = page.evaluate(
            "() => document.documentElement.scrollWidth - document.documentElement.clientWidth"
        )
        record(
            "抽屉开到 full：整页仍无横向溢出（对溢出零贡献）",
            st["stop"] == "full" and ov_open <= 2 and ov_open == ov_closed,
            f"关闭时={ov_closed}px 打开时={ov_open}px",
        )
        page.keyboard.press("Escape")
        page.wait_for_timeout(400)
        page.keyboard.press("Escape")
        page.wait_for_timeout(600)

        # ============ 壳切换：767 / 768 两档 ============
        page.set_viewport_size({"width": 768, "height": 900})
        page.wait_for_timeout(500)
        st768 = shell_state(page)
        record(
            "768px：侧栏在场、Dock 退场",
            st768["sidebar"]["display"] != "none"
            and st768["dock"]["display"] == "none",
            f"sidebar={st768['sidebar']['display']} dock={st768['dock']['display']}",
        )

        page.set_viewport_size({"width": 767, "height": 900})
        page.wait_for_timeout(500)
        st767 = shell_state(page)
        record(
            "767px：Dock 在场、侧栏退场",
            st767["dock"]["display"] != "none"
            and st767["sidebar"]["display"] == "none",
            f"dock={st767['dock']['display']} sidebar={st767['sidebar']['display']}",
        )
        page.screenshot(path=f"{SHOT}/03-shell-767-vs-768.png")

        # ============ 纯 CSS 切换：关掉 JS 再验一次（首帧不可能出现错误外壳） ============
        state_path = f"{SHOT}/auth-state.json"
        ctx.storage_state(path=state_path)
        nojs = browser.new_context(
            viewport={"width": 390, "height": 844},
            storage_state=state_path,
            java_script_enabled=False,
        )
        npage = nojs.new_page()
        npage.goto(f"{BASE}/dashboard", wait_until="domcontentloaded")
        html = npage.content()
        njs = shell_state(npage)
        record(
            "无 JS：服务端 HTML 同时含两套外壳（切换只能是 CSS）",
            'data-shell="dock"' in html and 'data-shell="sidebar"' in html,
        )
        record(
            "无 JS @390px：可见外壳只有 Dock（首帧不会闪桌面侧栏）",
            njs["dock"]["display"] != "none" and njs["sidebar"]["display"] == "none",
            f"dock={njs['dock']['display']} sidebar={njs['sidebar']['display']}",
        )
        ntab = npage.evaluate(
            "() => document.querySelectorAll('[data-shell=\\'dock\\'] [data-dock]').length"
        )
        record(
            "无 JS @390px：Dock 仍渲染 5 位（不依赖客户端权限数据）",
            ntab == 5,
            f"{ntab} 位",
        )
        npage.set_viewport_size({"width": 1024, "height": 900})
        njs_desk = shell_state(npage)
        record(
            "无 JS @1024px：可见外壳只有侧栏",
            njs_desk["sidebar"]["display"] != "none"
            and njs_desk["dock"]["display"] == "none",
            f"sidebar={njs_desk['sidebar']['display']} dock={njs_desk['dock']['display']}",
        )
        nojs.close()

        # ============ 桌面不回归（1440px） ============
        page.set_viewport_size({"width": 1440, "height": 900})
        page.goto(f"{BASE}/projects", wait_until="networkidle")
        page.wait_for_timeout(1800)
        st_desk = shell_state(page)
        record(
            "1440px：侧栏在场、Dock 不在场",
            st_desk["sidebar"]["display"] != "none"
            and st_desk["dock"]["display"] == "none",
            f"sidebar={st_desk['sidebar']['display']} dock={st_desk['dock']['display']}",
        )
        record(
            "桌面项目台账仍是 table.grid（未改桌面表格）",
            page.locator("table.grid").count() > 0,
        )
        page.screenshot(path=f"{SHOT}/04-desktop-1440-projects.png")

        # ============ 5 个 Dock 落点都是真实路由（无死键） ============
        # 直接拿 RSC payload：Link 的客户端导航与预取走的就是这条路径，200 才算落点真的可用。
        # 这也是下面「控制台噪声」过滤的**正向对照**：RSC 真的坏掉时这里的断言会先红。
        cookies = {c.get("name", ""): c.get("value", "") for c in ctx.cookies(BASE)}
        token_cookie = cookies.get("pm_access_token", "")
        rsc_bad = []
        for dock_id, href in [
            ("dashboard", "/dashboard"),
            ("projects", "/projects"),
            ("progress", "/progress"),
            ("costs", "/costs"),
            ("mine", "/change-password"),
        ]:
            # 必须是前端地址（req 的 base_url 是后端 API）；带 RSC 头的带参请求就是
            # Next Link 客户端导航 / 预取走的那条路径。
            r = req.get(
                f"{BASE}{href}?_rsc=acceptance",
                headers={"RSC": "1", "Cookie": f"pm_access_token={token_cookie}"},
            )
            if r.status != 200:
                rsc_bad.append(f"{dock_id}({href})={r.status}")
        record(
            "Dock 5 个落点都可导航（RSC payload 全 200，无死键）",
            len(rsc_bad) == 0,
            ", ".join(rsc_bad)
            or "/dashboard /projects /progress /costs /change-password",
        )

        # ============ 非管理员：Dock 5 位、无红点、无管理入口 ============
        ctx2 = browser.new_context(viewport={"width": 390, "height": 844})
        page2 = ctx2.new_page()
        page2.on("pageerror", lambda e: errors.append(str(e)))
        page2.on(
            "console",
            lambda m: errors.append(f"console:{m.text}") if m.type == "error" else None,
        )
        ok2 = login(page2, MEMBER_PHONE, MEMBER_PWD)
        record(f"登录（非管理员 {MEMBER_PHONE}）", ok2, page2.url)
        if ok2:
            page2.wait_for_selector('[data-shell="dock"]', timeout=15000)
            page2.goto(f"{BASE}/dashboard", wait_until="networkidle")
            page2.wait_for_timeout(1200)
            tabs2 = dock_boxes(page2)
            record(
                "非管理员：Dock 仍恒 5 位（角色不改位数）",
                [t["id"] for t in tabs2] == DOCK_IDS
                and [t["label"] for t in tabs2] == DOCK_LABELS,
                " / ".join(t["label"] for t in tabs2),
            )
            record(
                "D3：非管理员「我的」位没有红点",
                page2.locator('[data-shell="dock"] [data-badge]').count() == 0,
            )
            txt2 = " ".join(page2.locator('[data-shell="dock"]').inner_text().split())
            record(
                "D3：非管理员 Dock 里看不到审批中心 / 系统管理 / 通讯录",
                all(x not in txt2 for x in ADMIN_ONLY_LABELS),
                txt2,
            )
            side2 = " ".join(
                page2.locator('[data-shell="sidebar"]').inner_text().split()
            )
            record(
                "§3.2：非管理员侧栏同样没有这三个入口（权限唯一入口未变）",
                all(x not in side2 for x in ADMIN_ONLY_LABELS),
                side2[:90],
            )
            page2.screenshot(path=f"{SHOT}/05-dock-390-nonadmin.png")
        ctx2.close()

        # 只把「真实的功能性 JS 异常」计为失败：
        #   · favicon 与业务 4xx（本走查自身会触发的权限接口）；
        #   · Next 的 "Failed to fetch RSC payload … Falling back to browser navigation"——
        #     它是脚本自己连续 goto / 改视口时把**在途预取**打断后的自愈回退，不是页面故障：
        #     上面「Dock 5 个落点 RSC 全 200」就是这条过滤的正向对照。
        noise = re.compile(
            r"favicon|status of (400|401|403|404)|Failed to fetch RSC payload"
        )
        real_errors = [e for e in errors if not noise.search(e)]
        record(
            "运行时无功能性 JS 异常",
            len(real_errors) == 0,
            " || ".join(real_errors[:3])[:250],
        )

        req.dispose()
        browser.close()

    failed = [r for r in results if not r["ok"]]
    print(f"\n===== {len(results) - len(failed)}/{len(results)} 通过 =====")
    if failed:
        print("失败：" + "; ".join(f["name"] for f in failed))
    write_results()
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
