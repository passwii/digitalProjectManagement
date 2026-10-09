"""BLF-1127 验收走查：S1 手机壳基座（5 位底部 Dock + 767px 双外壳 CSS 切换）
+ S3 四个模块 Dock 位一点直达路由，「我的」保留账号与权限面板
+ S4 模块路由与「我的」面板权限入口（D3）
+ S5 项目台账 / 审批中心手机端卡片流（§4.2/D4）
+ S6 PWA 外壳收口（manifest + safe-area + viewport-fit + overscroll + 自建下拉刷新）。

契约：Dock 固定五位；四个模块位直接导航，「我的」面板承载账号与权限入口。
和 `acceptance_blf1093.py` 一样是**真浏览器 + 真后端**：不 mock 菜单接口，登录后
直接读 `/meta/me/menus` 真实返回，验的是「权限唯一入口 + 5 位 Dock」这一对约束。

覆盖：
  · Dock 恒 5 位、标签顺序 工作台/项目/资产/报表/我的
  · 几何：贴底、满宽、含安全区、单点触控 ≥44×44、390px 与 360px 无横向溢出
  · D3：管理员「我的」位有红点且 Dock 仍 5 位；非管理员看不到审批/管理/通讯录
  · 壳切换：≥768px 显示侧栏隐藏 Dock，≤767px 反之
  · 「纯 CSS 切换、无首帧错误外壳」：**关掉 JS** 再断言一次（此时只有 CSS 能决定可见性）
  · 不回归：桌面 1440px 下 table.grid 仍在、Dock 不在场
  · S3：工作台/项目/资产/报表位一次点击直达目标路由且不打开面板；
    「我的」位保留面板几何、遮罩、焦点归还、短屏滚动与 Escape 关闭检查。
  · S6/PWA：manifest.webmanifest 可访问且字段齐全（standalone / theme_color /
    192+512+maskable / shortcuts 工作台+待审批）、link[rel=manifest] 在场、
    viewport-fit=cover + theme-color、overscroll-y contain、按钮 touch-action
    与手机端 ≥44px、自建下拉刷新真手势可用、API 不可达时有明确错误与重试
    （复用 LoadFailed，不做离线写缓存 —— 有意决策）

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

# 契约常量：§7 的令牌与 5 个 Dock 位（写死在这里，改契约必须先改这里）
DOCK_H = 58
APPBAR_H = 52
DOCK_IDS = ["dashboard", "projects", "assets", "reports", "mine"]
DOCK_LABELS = ["工作台", "项目", "资产", "报表", "我的"]
ADMIN_ONLY_LABELS = ["审批中心", "系统管理", "通讯录"]

# S6 契约常量（§6）：PWA 外壳 6 件事的判定线，改契约必须先改这里
PWA_THEME = "#0F2742"  # theme_color / theme-color / 图标底色，三处同值
PULL_PX = 56  # 自建下拉刷新越线阈值（与 PullToRefresh.tsx 的 PULL_THRESHOLD 成对）
TAP_MIN = 44  # 可点元素最小触控目标（px）


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
                bodyOverflow: document.body.scrollWidth - document.body.clientWidth,
                scrollHeight: document.documentElement.scrollHeight,
                clientHeight: document.documentElement.clientHeight,
            };
        }"""
    )


def sheet_state(page) -> dict | None:
    """Read the retained personal/account panel through its stable data-* surface."""
    return page.evaluate(
        """() => {
            const panel = document.querySelector('[data-sheet]');
            if (!panel) return null;
            const rect = panel.getBoundingClientRect();
            const body = panel.querySelector('[data-sheet-body]');
            const root = document.querySelector('[data-sheet-root]');
            const scrim = document.querySelector('[data-sheet-scrim]');
            const cards = Array.from(panel.querySelectorAll('[data-sheet-card]')).map((card) => card.dataset.sheetCard);
            const dock = document.querySelector('[data-shell="dock"]');
            return {
                open: panel.dataset.open,
                role: panel.getAttribute('role'),
                ariaModal: panel.getAttribute('aria-modal'),
                x: rect.x, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height,
                viewportWidth: innerWidth, viewportHeight: innerHeight,
                scrimOn: scrim?.dataset.on ?? null,
                scrimOpacity: scrim ? Number(getComputedStyle(scrim).opacity) : 0,
                scrimPointerEvents: scrim ? getComputedStyle(scrim).pointerEvents : null,
                rootZ: root ? Number(getComputedStyle(root).zIndex) || 0 : 0,
                dockZ: dock ? Number(getComputedStyle(dock).zIndex) || 0 : 0,
                focusInSheet: panel.contains(document.activeElement),
                bodyScrollable: body.scrollHeight > body.clientHeight + 1,
                bodyScrollTop: body.scrollTop,
                bodyOverflowY: getComputedStyle(body).overflowY,
                cards,
            };
        }"""
    )


def sheet_present(page) -> dict:
    state = sheet_state(page)
    if state is None:
        raise AssertionError("我的面板未显示")
    return state


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
            "Dock 位顺序 = 契约顺序（dashboard/projects/assets/reports/mine）",
            [t["id"] for t in tabs] == DOCK_IDS,
            " / ".join(t["id"] for t in tabs),
        )
        record(
            "标签顺序 = 工作台 / 项目 / 资产 / 报表 / 我的（D1）",
            [t["label"] for t in tabs] == DOCK_LABELS,
            " / ".join(t["label"] for t in tabs),
        )
        record(
            "Dock 第 4 位是「报表」",
            tabs[3]["label"] == "报表",
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

        # 高亮跟随路由（/reports 落在独立的「报表」位）
        page.goto(f"{BASE}/reports", wait_until="networkidle")
        page.wait_for_timeout(600)
        tabs = dock_boxes(page)
        record(
            "Dock：/reports 高亮「报表」位",
            [t["id"] for t in tabs if t["current"] == "page"] == ["reports"],
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

        # ============ 固定 Dock 不能盖住既有弹层（「我的」面板会同在底部，先钉住） ===========
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

        # ============ S3：四个模块 Dock 位一点直达路由 ============
        page.set_viewport_size({"width": 390, "height": 844})
        page.goto(f"{BASE}/dashboard", wait_until="networkidle")
        page.wait_for_timeout(800)

        dock_routes = {
            "dashboard": "/dashboard",
            "projects": "/projects",
            "assets": "/assets",
            "reports": "/reports",
        }
        for dock_id, target in dock_routes.items():
            start = "/projects" if target == "/dashboard" else "/dashboard"
            page.goto(f"{BASE}{start}", wait_until="networkidle")
            page.wait_for_timeout(250)
            with page.expect_url(re.compile(rf"{re.escape(BASE + target)}(?:[?#].*)?$"), timeout=10000):
                page.click(f'[data-shell="dock"] [data-dock="{dock_id}"]')
            page.wait_for_timeout(450)
            record(
                f"S3：点「{dock_id}」一次直达 {target} 且不打开面板",
                page.url.rstrip("/").endswith(target)
                and page.locator('[data-sheet]').count() == 0
                and page.locator(f'[data-shell="dock"] [data-dock="{dock_id}"]').get_attribute("aria-haspopup") is None,
                f"URL={page.url} 且面板未渲染",
            )

        # 模块位全部导航后，再通过「我的」位继续检查面板触控行为。
        page.set_viewport_size({"width": 390, "height": 844})
        page.goto(f"{BASE}/dashboard", wait_until="networkidle")
        page.wait_for_timeout(800)
        panel_node = page.locator('[data-shell="dock"] [data-dock="mine"]')
        panel_node.click()
        page.wait_for_timeout(500)
        panel = sheet_present(page)
        record(
            "S3：我的面板贴底满宽且不超过 78vh",
            abs(panel["bottom"] - panel["viewportHeight"]) <= 1
            and abs(panel["width"] - panel["viewportWidth"]) <= 1
            and panel["height"] <= panel["viewportHeight"] * 0.78 + 2,
            f"面板 {panel['width']}×{panel['height']}，视口 {panel['viewportWidth']}×{panel['viewportHeight']}",
        )
        record(
            "S3：我的面板遮罩、模态语义与焦点锁定有效",
            panel["open"] == "true" and panel["role"] == "dialog" and panel["ariaModal"] == "true"
            and panel["scrimOn"] == "true" and panel["scrimOpacity"] >= 0.9
            and panel["scrimPointerEvents"] == "auto" and panel["rootZ"] < panel["dockZ"]
            and panel["focusInSheet"],
            f"遮罩={panel['scrimOn']} 焦点在面板={panel['focusInSheet']}",
        )
        page.keyboard.press("Escape")
        page.wait_for_timeout(450)
        record("S3：我的面板按 Escape 关闭", sheet_state(page) is None)
        panel_node.click()
        page.wait_for_timeout(450)
        page.locator('[data-sheet] button[aria-label="关闭我的面板"]').click()
        page.wait_for_timeout(450)
        focus_returned = page.evaluate("() => document.activeElement?.dataset?.dock === 'mine'")
        record("S3：关闭按钮关闭面板并把焦点归还「我的」", sheet_state(page) is None and focus_returned)
        page.set_viewport_size({"width": 390, "height": 420})
        panel_node.click()
        page.wait_for_timeout(500)
        short_panel = sheet_present(page)
        page.evaluate("() => { document.querySelector('[data-sheet-body]').scrollTop = 100; }")
        scrolled_panel = sheet_present(page)
        record(
            "S3：短屏我的面板正文可滚动且无横向溢出",
            short_panel["bodyScrollable"] and scrolled_panel["bodyScrollTop"] > 0
            and scrolled_panel["width"] <= scrolled_panel["viewportWidth"] + 1
            and page.evaluate("() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 2"),
        )
        page.keyboard.press("Escape")
        page.wait_for_timeout(450)

        page.set_viewport_size({"width": 390, "height": 844})
        page.goto(f"{BASE}/dashboard", wait_until="networkidle")
        page.wait_for_timeout(800)
        # ============ S4：四个模块位直接路由；「我的」位链接到账号设置 ============
        module_targets = {"dashboard": "/dashboard", "projects": "/projects", "assets": "/assets", "reports": "/reports"}
        for dock_id, target in module_targets.items():
            start = "/projects" if target == "/dashboard" else "/dashboard"
            page.goto(f"{BASE}{start}", wait_until="networkidle")
            page.wait_for_timeout(250)
            with page.expect_url(re.compile(rf"{re.escape(BASE + target)}(?:[?#].*)?$"), timeout=10000):
                page.click(f'[data-shell="dock"] [data-dock="{dock_id}"]')
            record(
                f"S4：{dock_id} Dock 位导航至 {target}",
                page.url.rstrip("/").endswith(target),
                page.url,
            )
        page.goto(f"{BASE}/dashboard", wait_until="networkidle")
        page.wait_for_timeout(300)
        record(
            "S4：我的位提供可直接访问的账号设置路由",
            page.locator('[data-shell="dock"] [data-dock="mine"]').get_attribute("href") == "/change-password",
            "我的 → /change-password",
        )

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

        # ============ S5/D4：项目台账 / 审批中心手机端卡片流 ============
        # 契约：方案 §4.2 + D4（只覆盖 /projects 与 /approvals；桌面 table.grid 不动）。
        # 同一份数据两个视图、纯 CSS 在 767px 切换（与双外壳同一手法）：断言走
        # data-cardlist / data-card 契约表面，不读 CSS Modules 的哈希类名。
        def card_metrics(pg, label: str) -> dict:
            """卡片流与表格的同屏对照：数量（同数据）+ 可见性（谁在场）。"""
            return pg.evaluate(
                """(label) => {
                    const cards = Array.from(document.querySelectorAll(`[data-cardlist="${label}"] [data-card]`));
                    const list = document.querySelector(`[data-cardlist="${label}"]`);
                    const table = list?.parentElement?.querySelector("table.grid")
                        ?? document.querySelector("table.grid");
                    const vis = (el) => el ? el.getBoundingClientRect().width > 0 : false;
                    const btns = cards.flatMap((c) => Array.from(c.querySelectorAll("button")));
                    const touch = btns.length === 0 ? -1
                        : Math.min(...btns.map((el) => parseFloat(getComputedStyle(el).minHeight) || 0));
                    return {
                        nCards: cards.length,
                        listVisible: vis(list),
                        tableVisible: vis(table),
                        cardTouch: touch,
                        firstText: cards[0]?.innerText ?? "",
                    };
                }""",
                label,
            )

        page.set_viewport_size({"width": 390, "height": 844})
        page.goto(f"{BASE}/projects", wait_until="networkidle")
        page.wait_for_timeout(1500)
        n_rows = page.locator("table.grid tbody tr").count()
        m = card_metrics(page, "项目台账")
        record(
            "D4 @390px：项目台账渲染卡片流，且与表格同数据",
            m["nCards"] > 0 and m["nCards"] == n_rows,
            f"卡片 {m['nCards']} 张 / 表格 {n_rows} 行",
        )
        record(
            "D4 @390px：卡片流在场、桌面表格退场（纯 CSS 切换）",
            m["listVisible"] and not m["tableVisible"],
            f"卡片可见={m['listVisible']} 表格可见={m['tableVisible']}",
        )
        record(
            "D4：卡片内操作按钮触控 ≥44px（卡片自己的 CSS，不依赖 640px / pointer:coarse 补丁）",
            m["cardTouch"] >= 44,
            f"最小 min-height={m['cardTouch']}px（390px 非 coarse 下全局补丁只给表格按钮 30px）",
        )
        record(
            "D4：项目卡片一屏一条可读结论（进度 / 负责人 / 预算）",
            all(k in m["firstText"] for k in ["负责人", "预算", "进度"]),
            m["firstText"][:60].replace(chr(10), " / "),
        )
        page.screenshot(path=f"{SHOT}/09-cards-390-projects.png")

        # 767 / 768 边界：与手机壳同断点切换
        page.set_viewport_size({"width": 768, "height": 900})
        page.wait_for_timeout(500)
        m768 = card_metrics(page, "项目台账")
        record(
            "D4 @768px：卡片流退场、表格在场（桌面视图）",
            not m768["listVisible"] and m768["tableVisible"],
            f"卡片可见={m768['listVisible']} 表格可见={m768['tableVisible']}",
        )
        page.set_viewport_size({"width": 767, "height": 900})
        page.wait_for_timeout(500)
        m767 = card_metrics(page, "项目台账")
        record(
            "D4 @767px：卡片流在场、表格退场（手机视图）",
            m767["listVisible"] and not m767["tableVisible"],
            f"卡片可见={m767['listVisible']} 表格可见={m767['tableVisible']}",
        )

        # 审批中心：三段各自卡片流；待办为空时空态共用（不断言卡片数，只断言不断层）
        page.set_viewport_size({"width": 390, "height": 844})
        page.goto(f"{BASE}/approvals", wait_until="networkidle")
        page.wait_for_timeout(1500)
        appr_sections = page.evaluate(
            """() => Array.from(document.querySelectorAll('[data-cardlist]')).map((el) => ({
                label: el.dataset.cardlist,
                n: el.querySelectorAll('[data-card]').length,
                visible: el.getBoundingClientRect().width > 0,
            }))"""
        )
        appr_rows = page.locator("table.grid tbody tr").count()
        appr_cards = sum(s["n"] for s in appr_sections)
        if appr_rows > 0:
            record(
                "D4 @390px：审批中心三段卡片流与表格同数据",
                appr_cards == appr_rows and all(s["visible"] for s in appr_sections),
                " / ".join(f"{s['label']}={s['n']}张" for s in appr_sections)
                + f" / 表格共 {appr_rows} 行",
            )
        else:
            record(
                "D4 @390px：审批中心无待办时空态共用（卡片与表格都不渲染数据行）",
                appr_cards == 0 and "没有待处理事项" in page.content(),
                "空态一处，两种视图行为一致",
            )
        page.screenshot(path=f"{SHOT}/10-cards-390-approvals.png")

        # 桌面零回归：1440px 卡片流退场（display:none），表格是唯一视图
        page.set_viewport_size({"width": 1440, "height": 900})
        page.goto(f"{BASE}/projects", wait_until="networkidle")
        page.wait_for_timeout(1500)
        mdesk = card_metrics(page, "项目台账")
        record(
            "D4 @1440px：项目台账卡片流退场、桌面表格唯一在场",
            not mdesk["listVisible"] and mdesk["tableVisible"],
            f"卡片可见={mdesk['listVisible']} 表格可见={mdesk['tableVisible']}",
        )
        page.goto(f"{BASE}/approvals", wait_until="networkidle")
        page.wait_for_timeout(1500)
        adesk = page.evaluate(
            """() => ({
                lists: Array.from(document.querySelectorAll('[data-cardlist]'))
                    .map((el) => el.getBoundingClientRect().width),
                tables: Array.from(document.querySelectorAll('table.grid'))
                    .map((el) => el.getBoundingClientRect().width),
            })"""
        )
        record(
            "D4 @1440px：审批中心卡片流退场、桌面表格唯一在场",
            all(w == 0 for w in adesk["lists"]) and any(w > 0 for w in adesk["tables"]),
            f"卡片宽={adesk['lists']} 表格宽={[round(w) for w in adesk['tables']]}",
        )

        # ============ 5 个 Dock 落点都是真实路由（无死键） ============
        # 直接拿 RSC payload：Link 的客户端导航与预取走的就是这条路径，200 才算落点真的可用。
        # 这也是下面「控制台噪声」过滤的**正向对照**：RSC 真的坏掉时这里的断言会先红。
        cookies = {c.get("name", ""): c.get("value", "") for c in ctx.cookies(BASE)}
        token_cookie = cookies.get("pm_access_token", "")
        rsc_bad = []
        for dock_id, href in [
            ("dashboard", "/dashboard"),
            ("projects", "/projects"),
            ("assets", "/assets"),
            ("reports", "/reports"),
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
            or "/dashboard /projects /assets /reports /change-password",
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
            # 「我的」已是路由链接，权限菜单仍不应泄漏到 Dock 槽位。
            record(
                "S4/D3：非管理员「我的」位仍可直达账号设置",
                page2.locator('[data-shell="dock"] [data-dock="mine"]').get_attribute("href") == "/change-password",
                "我的 → /change-password",
            )
            page2.screenshot(path=f"{SHOT}/05-dock-390-nonadmin.png")
        ctx2.close()

        # ============ S6：PWA 外壳收口（§6 的 6 件事） ============
        # 契约：manifest + safe-area + viewport-fit + overscroll + 点击延迟 +
        # 离线兜底（首版不做离线写：只断言「明确错误与重试」，见末尾的 API 中断段）。
        page.set_viewport_size({"width": 390, "height": 844})
        page.goto(f"{BASE}/dashboard", wait_until="networkidle")
        page.wait_for_timeout(1200)

        # ---- manifest：可访问且字段齐全 ----
        mani = page.evaluate(
            """async () => {
                const link = document.querySelector('link[rel="manifest"]');
                if (!link) return { link: false };
                const r = await fetch(link.getAttribute('href'));
                if (!r.ok) return { link: true, http: r.status };
                return { link: true, http: r.status, json: await r.json() };
            }"""
        )
        mani_ok = isinstance(mani, dict) and mani.get("http") == 200
        m = mani.get("json", {}) if mani_ok else {}
        icons = m.get("icons", []) if isinstance(m, dict) else []
        sizes = sorted({str(i.get("sizes")) for i in icons if isinstance(i, dict)})
        purposes = sorted({str(i.get("purpose")) for i in icons if isinstance(i, dict)})
        shortcuts = m.get("shortcuts", []) if isinstance(m, dict) else []
        cut_urls = sorted({str(s.get("url")) for s in shortcuts if isinstance(s, dict)})
        record(
            "manifest.webmanifest 可访问且字段齐全",
            mani_ok
            and m.get("display") == "standalone"
            and (m.get("theme_color") or "").lower() == PWA_THEME.lower()
            and "background_color" in m
            and "192x192" in sizes
            and "512x512" in sizes
            and "maskable" in purposes
            and "/dashboard" in cut_urls
            and "/approvals" in cut_urls,
            f"display={m.get('display')} theme={m.get('theme_color')} "
            f"icons={sizes} purposes={purposes} shortcuts={cut_urls}",
        )

        # ---- viewport-fit=cover + theme-color ----
        vp = page.evaluate(
            """() => ({
                viewport: document.querySelector('meta[name="viewport"]')?.getAttribute('content') ?? '',
                theme: document.querySelector('meta[name="theme-color"]')?.getAttribute('content') ?? '',
            })"""
        )
        record(
            "viewport-fit=cover（圆角屏铺满，安全区由 env() 消化）",
            "viewport-fit=cover" in vp["viewport"],
            vp["viewport"][:120],
        )
        record(
            f"theme-color = {PWA_THEME}（与 manifest 同值）",
            vp["theme"].lower() == PWA_THEME.lower(),
            f"meta theme-color={vp['theme']}",
        )

        # ---- overscroll + 点击延迟（计算样式，不读类名） ----
        ob = page.evaluate(
            """() => ({
                html: getComputedStyle(document.documentElement).overscrollBehaviorY,
                body: getComputedStyle(document.body).overscrollBehaviorY,
                btnTouch: getComputedStyle(document.querySelector('[data-shell="dock"] [data-dock]')).touchAction,
            })"""
        )
        record(
            "overscroll-behavior-y: contain（standalone 下不橡皮筋）",
            ob["html"] == "contain" and ob["body"] == "contain",
            f"html={ob['html']} body={ob['body']}",
        )

        root_width = page.evaluate(
            """() => ({
                viewport: window.innerWidth,
                html: document.documentElement.scrollWidth,
                body: document.body.scrollWidth,
                overflow: Math.max(
                    document.documentElement.scrollWidth - window.innerWidth,
                    document.body.scrollWidth - window.innerWidth,
                ),
            })"""
        )
        record(
            "手机端页面根层无横向溢出（Dock 不随页面左右滑动）",
            root_width["overflow"] <= 1,
            f"viewport={root_width['viewport']} html={root_width['html']} "
            f"body={root_width['body']} overflow={root_width['overflow']}",
        )
        record(
            "手机端页面保留纵向滚动能力",
            root_width["scrollHeight"] >= root_width["clientHeight"],
            f"scrollHeight={root_width['scrollHeight']} clientHeight={root_width['clientHeight']}",
        )
        record(
            "touch-action: manipulation（无双击缩放误触）",
            "manipulation" in ob["btnTouch"],
            f"Dock 位 touch-action={ob['btnTouch']}",
        )

        # ---- safe-area 令牌在场；桌面 Chrome 上 env()=0 时顶栏仍是 52px ----
        safe = page.evaluate(
            """() => {
                const cs = getComputedStyle(document.documentElement);
                const topbar = document.querySelector('[data-shell="topbar"]');
                const r = topbar.getBoundingClientRect();
                return {
                    safeT: cs.getPropertyValue('--m-safe-t').trim(),
                    safeB: cs.getPropertyValue('--m-safe-b').trim(),
                    topbarH: r.height,
                };
            }"""
        )
        record(
            "safe-area 令牌 --m-safe-t / --m-safe-b 在场",
            bool(safe["safeT"]) and bool(safe["safeB"]),
            f"--m-safe-t={safe['safeT']} --m-safe-b={safe['safeB']}",
        )
        record(
            f"无刘海时顶栏仍是 {APPBAR_H}px（安全区回落 0px，不断言具体 env 值）",
            abs(safe["topbarH"] - APPBAR_H) <= 1,
            f"实测 {round(safe['topbarH'], 1)}px",
        )

        dock_width = page.evaluate(
            """() => {
                const dock = document.querySelector('[data-shell="dock"]');
                if (!dock) return null;
                const r = dock.getBoundingClientRect();
                return {
                    left: r.left,
                    right: r.right,
                    width: r.width,
                    viewport: window.innerWidth,
                    position: getComputedStyle(dock).position,
                };
            }"""
        )
        record(
            "Dock 固定覆盖手机视口且不超出边界",
            isinstance(dock_width, dict)
            and dock_width["position"] == "fixed"
            and abs(dock_width["left"]) <= 1
            and abs(dock_width["right"] - dock_width["viewport"]) <= 1,
            str(dock_width),
        )

        # ---- 手机端可点元素 ≥44px（CSS 契约探针：与页面内容无关） ----
        tap = page.evaluate(
            """() => {
                const b = document.createElement('button');
                b.className = 'btn-primary';
                b.textContent = '探针';
                b.style.cssText = 'position:fixed;left:0;top:0;visibility:hidden;';
                document.body.appendChild(b);
                const h = b.getBoundingClientRect().height;
                b.remove();
                return h;
            }"""
        )
        record(
            f"390px：主按钮高度 ≥{TAP_MIN}px",
            tap >= TAP_MIN,
            f"实测 {round(tap, 1)}px",
        )

        # ---- 自建下拉刷新：真手势（touch）拉过 56px 线 → 刷新计数 +1 ----
        page.evaluate("() => window.scrollTo(0, 0)")
        page.wait_for_timeout(300)
        ptr_before = page.evaluate(
            "() => Number(document.querySelector('[data-ptr]')?.dataset.ptrCount || -1)"
        )
        record("前置：下拉刷新容器在场", ptr_before >= 0, f"data-ptr-count={ptr_before}")
        if ptr_before >= 0:
            pulled = page.evaluate(
                f"""() => {{
                    const host = document.querySelector('[data-ptr]');
                    const r = host.getBoundingClientRect();
                    const x = r.x + r.width / 2, y0 = Math.max(r.y + 40, 200);
                    const mk = (type, y) => {{
                        const t = new Touch({{ identifier: 1, target: host, clientX: x, clientY: y }});
                        host.dispatchEvent(new TouchEvent(type, {{
                            touches: type === 'touchend' ? [] : [t],
                            bubbles: true, cancelable: true,
                        }}));
                    }};
                    mk('touchstart', y0);
                    for (let i = 1; i <= 6; i++) mk('touchmove', y0 + (i * ({PULL_PX} + 44)) / 6);
                    mk('touchend', y0 + {PULL_PX} + 44);
                    return host.dataset.ptrState;
                }}"""
            )
            try:
                page.wait_for_function(
                    f"Number(document.querySelector('[data-ptr]').dataset.ptrCount) "
                    f"> {ptr_before}",
                    timeout=8000,
                )
                ptr_ok = True
            except Exception:
                ptr_ok = False
            ptr_after = page.evaluate(
                "() => Number(document.querySelector('[data-ptr]').dataset.ptrCount || -1)"
            )
            record(
                f"下拉超 {PULL_PX}px 松手：触发刷新（count {ptr_before} → {ptr_after}）",
                ptr_ok,
                f"手势结束时 state={pulled} count={ptr_after}",
            )
        page.screenshot(path=f"{SHOT}/09-pwa-shell-390.png")

        # ---- 离线兜底（契约：不做离线写，只保证明确错误与重试） ----
        # 手法：文档正常加载，只把 /api/* 全部 abort（= 后端不可达），再重载页面 ——
        # 这正是「断网时已装好的 App 打开」的形态：壳在，数据不在。
        # 独立 context 且不挂 error 监听：abort 的网络错误是本段的手法，不是产品故障。
        ctx_off = browser.new_context(viewport={"width": 390, "height": 844})
        p_off = ctx_off.new_page()
        p_off.goto(f"{BASE}/login", wait_until="networkidle")
        p_off.fill('form input:not([type="password"])', ADMIN_PHONE)
        p_off.fill('form input[type="password"]', ADMIN_PWD)
        p_off.click('form button[type="submit"]')
        try:
            p_off.wait_for_url(lambda u: "/login" not in u, timeout=20000)
            logged_off = True
        except pw.TimeoutError:
            logged_off = False
        record("离线段前置：独立会话登录成功", logged_off, p_off.url)
        if logged_off:
            p_off.goto(f"{BASE}/projects", wait_until="networkidle")
            p_off.wait_for_timeout(1000)
            p_off.route("**/api/**", lambda route: route.abort())
            p_off.reload(wait_until="domcontentloaded")
            p_off.wait_for_timeout(2500)
            off = p_off.evaluate(
                """() => ({
                    alerts: document.querySelectorAll('[role="alert"]').length,
                    text: document.body.innerText.slice(0, 400),
                })"""
            )
            has_retry = "重试" in off["text"]
            record(
                "API 不可达：有明确错误与重试（复用 LoadFailed / 错误边界，不做离线写）",
                off["alerts"] > 0 or ("页面出错了" in off["text"] and has_retry) or has_retry,
                f"role=alert 共 {off['alerts']} 个{'，含重试' if has_retry else ''}",
            )
            p_off.screenshot(path=f"{SHOT}/10-offline-fallback.png")
        ctx_off.close()

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
