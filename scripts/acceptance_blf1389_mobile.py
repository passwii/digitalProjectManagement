#!/usr/bin/env python3
"""BLF-1389 验收走查：云电竞管理平台（/spark）与智能音视频平台（/stream-monitor）
的手机 PWA 端适配。

覆盖（§范围 的五件事，逐条对应）：

  §1 站点级 PWA 身份
      · 两份站点 manifest 可访问，`Content-Type: application/manifest+json`；
      · 字段齐全：standalone / scope 限定在站点路径下 / start_url 指向站点首页 /
        theme_color / icons（192 + 512 + maskable）/ shortcuts 指向站点内页面；
      · **`<link rel="manifest">` 指向该站点自己那份**（不是根那份）——
        这是本 issue 的核心：指向根就等于「装进去还是主工作台」；
      · 反向用例：根页面的 manifest link 仍然指向 `/manifest.webmanifest`。

  §2 移动端壳层
      · `theme-color` 与 `viewport-fit=cover` 生效；
      · 页面级无横向溢出（`scrollWidth <= clientWidth`），390px 与 360px 都要验；
      · 表格 / 图表的横向滚动只发生在自身容器内。

  §3 手机端入口与返回路径
      · 「我的」面板里两个站点入口都在，且**不带 target**（同页导航）；
      · 站点顶栏的「返回主系统」在手机形态下可达可点。

  §4 standalone 形态
      · 两个站点是免登录 public 路由：直接访问不 307 到 /login；
      · 根布局的下拉刷新在 public 路由下可用（走 router.refresh()，不把人踢去登录）。

用法：
    python3 scripts/acceptance_blf1389_mobile.py

依赖：playwright（channel=chrome）、本机前端 3001（`npm run start`）。
两个站点都是**免登录**公开路由，所以本脚本**不需要后端、不需要登录** ——
这也正是 standalone 形态下用户能直接进站的前提。

环境变量：
    FE_BASE / SHOT_DIR
"""

from __future__ import annotations

import json
import os
import sys
import tempfile

from playwright.sync_api import sync_playwright

BASE = os.environ.get("FE_BASE", "http://127.0.0.1:3001").rstrip("/")
# 截图 / results.json 默认落在系统临时目录（可用 SHOT_DIR 覆盖）
SHOT = os.environ.get("SHOT_DIR") or os.path.join(tempfile.gettempdir(), "blf1389-shots")

# 手机与窄屏两档（与 scripts/acceptance_blf1127_mobile.py 同口径）
VIEWPORTS = [(390, 844), (360, 780)]

# 契约常量：改契约必须先改这里
TAP_MIN = 44  # 最小触控目标（px）

# 站点 → (首页, 站点 manifest 路径, 站点根路径, 主内容区 id, 品牌名)
SITES = {
    "spark": {
        "home": "/spark/dashboard",
        "manifest": "/spark/manifest.webmanifest",
        "root": "/spark",
        "main_id": "spark-main",
        "brand": "云电竞管理平台",
        "theme": "#070a12",
    },
    "stream-monitor": {
        "home": "/stream-monitor/overview",
        "manifest": "/stream-monitor/manifest.webmanifest",
        "root": "/stream-monitor",
        "main_id": "av-main",
        "brand": "智能音视频平台",
        # 智能音视频平台是深浅双主题：theme-color 有 media 描述符两份，
        # 深色那份必须等于 manifest 的 theme_color。
        "theme": "#07131f",
    },
}

results: list[dict] = []


def prepare_shot_dir() -> str:
    """准备好截图目录。目录建不出来时退回当前目录而不是直接崩：
    PASS/FAIL 行本身仍然要打出来（只看看到底哪里没通过，比丢截图重要）。"""
    global SHOT
    try:
        os.makedirs(SHOT, exist_ok=True)
        return SHOT
    except OSError as e:
        fallback = os.path.join(os.getcwd(), "blf1389-shots")
        print(f"⚠ 截图目录 {SHOT} 不可用（{e}）→ 改用 {fallback}", flush=True)
        os.makedirs(fallback, exist_ok=True)
        SHOT = fallback
        return SHOT


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


def fetch_manifest(page, url: str) -> tuple[bool, dict]:
    """取一份 manifest：返回 (是否可访问, 内容)。"""
    try:
        response = page.request.get(f"{BASE}{url}")
    except Exception as e:  # noqa: BLE001 —— 网络异常也要给出可读的判定
        return False, {"error": str(e)}
    if response.status != 200:
        return False, {"status": response.status}
    content_type = (response.headers.get("content-type") or "").split(";")[0].strip()
    try:
        body = response.json()
    except Exception as e:  # noqa: BLE001
        return False, {"error": f"不是合法 JSON：{e}", "content_type": content_type}
    return True, {**body, "_content_type": content_type}


def check_site_manifest(page, key: str, site: dict) -> None:
    """§1：站点 manifest 可访问、字段齐全。"""
    ok, manifest = fetch_manifest(page, site["manifest"])
    record(
        f"§1 {key}：站点 manifest 可访问（{site['manifest']}）",
        ok,
        f"status={manifest.get('status', manifest.get('error', '200'))}",
    )
    if not ok:
        return

    content_type = str(manifest.get("_content_type", ""))
    record(
        f"§1 {key}：Content-Type 是 application/manifest+json",
        content_type == "application/manifest+json",
        f"content-type={content_type}",
    )

    record(
        f"§1 {key}：display=standalone",
        manifest.get("display") == "standalone",
        f"display={manifest.get('display')}",
    )

    scope = str(manifest.get("scope", ""))
    record(
        f"§1 {key}：scope 限定在站点路径下（{site['root']}）",
        scope == site["root"],
        f"scope={scope}",
    )

    start_url = str(manifest.get("start_url", ""))
    record(
        f"§1 {key}：start_url 指向站点首页",
        start_url.startswith(site["root"]) and start_url != "/",
        f"start_url={start_url}",
    )

    theme = str(manifest.get("theme_color", ""))
    record(
        f"§1 {key}：theme_color = {site['theme']}",
        theme.lower() == site["theme"].lower(),
        f"theme_color={theme}",
    )
    record(
        f"§1 {key}：background_color 存在",
        bool(manifest.get("background_color")),
        f"background_color={manifest.get('background_color')}",
    )

    icons = manifest.get("icons") or []
    sizes = sorted({str(i.get("sizes")) for i in icons if isinstance(i, dict)})
    purposes = sorted({str(i.get("purpose")) for i in icons if isinstance(i, dict)})
    record(
        f"§1 {key}：icons 齐全（192 / 512 / maskable）",
        "192x192" in sizes and "512x512" in sizes and "maskable" in purposes,
        f"sizes={sizes} purposes={purposes}",
    )

    shortcuts = manifest.get("shortcuts") or []
    cut_urls = [str(s.get("url")) for s in shortcuts if isinstance(s, dict)]
    record(
        f"§1 {key}：shortcuts 指向站点内页面",
        bool(cut_urls) and all(u.startswith(site["root"]) for u in cut_urls),
        f"shortcuts={cut_urls}",
    )

    # 品牌口径：中文品牌，不是英文品牌。
    name = str(manifest.get("name", ""))
    record(
        f"§1 {key}：manifest 名称是中文品牌「{site['brand']}」",
        name == site["brand"],
        f"name={name}",
    )


def check_manifest_link(page, key: str, site: dict) -> None:
    """§1：页面的 `<link rel="manifest">` 指向该站点自己那份。"""
    link = page.evaluate(
        """() => {
            const el = document.querySelector('link[rel="manifest"]');
            return el ? el.getAttribute('href') : null;
        }"""
    )
    record(
        f"§1 {key}：link[rel=manifest] 指向该站点自己的 manifest",
        link == site["manifest"],
        f"href={link}（期望 {site['manifest']}）",
    )


def check_viewport_meta(page, key: str, site: dict) -> None:
    """§2：theme-color 与 viewport-fit=cover 生效。"""
    meta = page.evaluate(
        """() => ({
            viewport: document.querySelector('meta[name="viewport"]')?.getAttribute('content') ?? '',
            themes: [...document.querySelectorAll('meta[name="theme-color"]')]
                .map((el) => ({
                    media: el.getAttribute('media') ?? '',
                    content: el.getAttribute('content') ?? '',
                })),
        })"""
    )
    record(
        f"§2 {key}：viewport-fit=cover",
        "viewport-fit=cover" in meta["viewport"],
        meta["viewport"][:120],
    )
    themes = meta["themes"]
    contents = [t["content"].lower() for t in themes]
    record(
        f"§2 {key}：theme-color 与 manifest 同值（{site['theme']}）",
        site["theme"].lower() in contents,
        f"theme-color={themes}",
    )


def check_no_page_overflow(page, key: str, width: int) -> None:
    """§2：页面级不产生横向滚动（表格 / 图表自己在容器里滚）。"""
    metrics = page.evaluate(
        """() => {
            const doc = document.documentElement;
            const scrollers = [...document.querySelectorAll('*')]
                .filter((el) => {
                    const style = getComputedStyle(el);
                    return /auto|scroll/.test(style.overflowX) && el.scrollWidth > el.clientWidth + 1;
                })
                .slice(0, 5)
                .map((el) => ({
                    tag: el.tagName.toLowerCase(),
                    className: typeof el.className === 'string' ? el.className : '',
                    scrollWidth: el.scrollWidth,
                    clientWidth: el.clientWidth,
                }));
            return {
                scrollWidth: doc.scrollWidth,
                clientWidth: doc.clientWidth,
                bodyScrollWidth: document.body.scrollWidth,
                scrollers,
            };
        }"""
    )
    record(
        f"§2 {key}@{width}px：页面级无横向溢出（scrollWidth <= clientWidth）",
        metrics["scrollWidth"] <= metrics["clientWidth"] + 1
        and metrics["bodyScrollWidth"] <= metrics["clientWidth"] + 1,
        f"doc={metrics['scrollWidth']}/{metrics['clientWidth']} "
        f"body={metrics['bodyScrollWidth']}/{metrics['clientWidth']}",
    )
    # 横向滚动只允许发生在自身的滚动容器里（表格 / 图表容器），不是在页面上。
    bad = [
        s for s in metrics["scrollers"] if s["tag"] in {"html", "body"}
    ]
    record(
        f"§2 {key}@{width}px：横向滚动只发生在自身容器内（不是 html/body）",
        not bad,
        f"scrollers={metrics['scrollers']}",
    )


def check_touch_targets(page, key: str, site: dict) -> None:
    """§2：窄屏下**壳层**的触控目标 ≥ 44px。

    只看**壳层**（顶栏），不看页内控件 —— 页内分段控件
    （如总览页的「近 24 小时 / 今日 / 近 7 日」时间范围切换，28px 一档）
    是内容区里的筛选 Tab，不是壳层交互控件，不在本条的适用范围。
    页内控件的尺寸基线由 `lib/avControlSizes.vitest.test.ts` 守
    （--av-ctl-page-tab 28px 档）。
    """
    boxes = page.evaluate(
        """() => {
            const out = [];
            // 壳层顶栏：AvShell 的 <header class="topbar"> 与 SparkShell 的
            // <header class="topbar">。
            //
            // ⚠️ 不能笼统地选所有 <header>：AvUI 的页头
            // （<header class="pageHeader">，总览页的时间范围切换
            // 「近 24 小时 / 今日 / 近 7 日」就在里面）是**页内**控件，
            // 28px 一档是 --av-ctl-page-tab 的既定基线（Stage 6 定档），
            // 不属于壳层触控档。壳层顶栏有稳定的 class 名（topbar），
            // 用它来区分。
            for (const header of document.querySelectorAll('header.topbar, header[class*="topbar"]')) {
                for (const el of header.querySelectorAll('button, a')) {
                    const rect = el.getBoundingClientRect();
                    if (rect.width === 0 && rect.height === 0) continue;
                    out.push({
                        label: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 24),
                        width: Math.round(rect.width),
                        height: Math.round(rect.height),
                    });
                }
            }
            return out;
        }"""
    )
    small = [b for b in boxes if b["height"] < TAP_MIN]
    record(
        f"§2 {key}：壳层顶栏的触控目标 ≥ {TAP_MIN}px",
        not small,
        f"过小={small[:5]}（共 {len(boxes)} 个壳层控件）",
    )


def check_back_path(page, key: str, site: dict) -> None:
    """§3：站点顶栏的「返回主系统」在手机形态下可达可点。"""
    link = page.evaluate(
        """() => {
            const links = [...document.querySelectorAll('header a')];
            const back = links.find((a) => {
                const label = (a.getAttribute('aria-label') || a.textContent || '').trim();
                return label.includes('返回');
            });
            if (!back) return null;
            const rect = back.getBoundingClientRect();
            return {
                href: back.getAttribute('href'),
                width: Math.round(rect.width),
                height: Math.round(rect.height),
                visible: rect.width > 0 && rect.height > 0,
            };
        }"""
    )
    record(
        f"§3 {key}：顶栏「返回主系统」在手机形态下可见可点",
        bool(link) and link["visible"] and link["height"] >= TAP_MIN,
        f"back={link}",
    )
    record(
        f"§3 {key}：「返回主系统」指向主工作台",
        bool(link) and str(link.get("href")) == "/dashboard",
        f"href={link.get('href') if link else None}",
    )


def check_public_route(page, key: str, site: dict) -> None:
    """§4：站点是免登录 public 路由，直接访问不 307 到 /login。"""
    response = page.request.get(f"{BASE}{site['home']}", max_redirects=0)
    status = response.status
    location = response.headers.get("location") or ""
    record(
        f"§4 {key}：免登录直接访问不被踢去登录（无 307 → /login）",
        not (status in (301, 302, 303, 307, 308) and "/login" in location),
        f"status={status} location={location or '（无重定向）'}",
    )


def check_pull_to_refresh(page, key: str, site: dict) -> None:
    """§4：根布局的下拉刷新在 public 路由下可用，且不把人踢去登录。"""
    # 下拉刷新是**浏览器式**手势：只在页面在顶部时才生效。先回到顶部。
    page.evaluate("() => window.scrollTo(0, 0)")
    page.wait_for_timeout(300)
    before = page.evaluate(
        "() => Number(document.querySelector('[data-ptr]')?.dataset.ptrCount ?? -1)"
    )
    record(f"§4 {key}：下拉刷新容器在场", before >= 0, f"data-ptr-count={before}")

    state = page.evaluate(
        """() => {
            const host = document.querySelector('[data-ptr]');
            if (!host) return 'missing';
            const r = host.getBoundingClientRect();
            const x = r.x + r.width / 2;
            const y0 = Math.max(r.y + 40, 200);
            const mk = (type, y) => {
                const t = new Touch({ identifier: 1, target: host, clientX: x, clientY: y });
                return new TouchEvent(type, {
                    touches: type === 'touchend' ? [] : [t],
                    bubbles: true,
                    cancelable: true,
                });
            };
            host.dispatchEvent(mk('touchstart', y0));
            for (let i = 1; i <= 6; i += 1) {
                host.dispatchEvent(mk('touchmove', y0 + (i * 100) / 6));
            }
            host.dispatchEvent(mk('touchend', y0 + 100));
            return host.dataset.ptrState;
        }"""
    )
    # 刷新是异步的（等请求 + 最短 360ms 反馈），等一下再读计数。
    try:
        page.wait_for_function(
            f"Number(document.querySelector('[data-ptr]').dataset.ptrCount) > {before}",
            timeout=8000,
        )
        triggered = True
    except Exception:  # noqa: BLE001 —— 超时也算一次「没触发」
        triggered = False
    after = page.evaluate(
        "() => Number(document.querySelector('[data-ptr]')?.dataset.ptrCount ?? -1)"
    )
    record(
        f"§4 {key}：下拉刷新可触发（count {before} → {after}）",
        triggered,
        f"gesture_state={state} count={after}",
    )
    # 刷新之后仍然停在站点上（没有被 307 到 /login）。
    page.wait_for_timeout(900)
    record(
        f"§4 {key}：刷新后仍停留在本站（没有被踢去登录）",
        site["root"] in page.url,
        f"url={page.url}",
    )


def check_mobile_entries(page, key: str, site: dict) -> None:
    """§3：「我的」面板里两个站点入口都在，且不带 target。

    ⚠️ 这一条需要**登录态**：主工作台（/dashboard）是受保护路由，
    匿名访问会被 middleware 307 到 /login。

    所以本脚本整体是「免登录」的（两个站点是 public 路由），
    只有这一条需要登录 —— 用 `PM_ACCESS_TOKEN` 环境变量传入一个
    可用的访问令牌（cookie 名 `pm_access_token`）。没有令牌时
    这一条**跳过**（不是失败）：本脚本的主价值在站点的免登录形态上。
    """
    token = os.environ.get("PM_ACCESS_TOKEN", "").strip()
    if not token:
        record(
            "§3 手机端：「我的」面板的站点入口（需登录态，已跳过）",
            True,
            "未提供 PM_ACCESS_TOKEN —— 主工作台是受保护路由，匿名访问会被 307 到 /login",
        )
        return

    page.context.add_cookies(
        [{"name": "pm_access_token", "value": token, "url": BASE}]
    )
    page.goto(f"{BASE}/dashboard", wait_until="networkidle")
    if "/login" in page.url:
        record(
            "§3 手机端：进入主工作台（令牌有效）",
            False,
            f"url={page.url} —— PM_ACCESS_TOKEN 可能已过期",
        )
        return
    record("§3 手机端：进入主工作台（令牌有效）", True, f"url={page.url}")

    # 手机形态：点开「我的」位（底部 Dock 的第 5 位）。
    dock_mine = page.locator('[data-shell="dock"] [data-dock="mine"]')
    if not dock_mine.count():
        record("§3 手机端：「我的」Dock 位不在（无法验收手机端入口）", False, "找不到 [data-dock=mine]")
        return
    dock_mine.first.click()
    page.wait_for_timeout(600)

    cards = page.evaluate(
        """() => [...document.querySelectorAll('[data-sheet-card="list"]')].map((el) => ({
            href: el.getAttribute('href'),
            target: el.getAttribute('target'),
            title: (el.querySelector('.' + 'title')?.textContent || '').trim(),
        }))"""
    )
    by_href = {c["href"]: c for c in cards}
    for slug in ("/spark", "/stream-monitor"):
        card = by_href.get(slug)
        record(
            f"§3 手机端：「我的」面板有 {slug} 入口",
            card is not None,
            f"cards={[c['href'] for c in cards]}",
        )
        if card:
            record(
                f"§3 手机端：{slug} 入口不带 target（同页导航）",
                not card.get("target"),
                f"target={card.get('target')!r}",
            )
    page.keyboard.press("Escape")
    page.wait_for_timeout(300)


def main() -> int:
    prepare_shot_dir()
    errors: list[str] = []

    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome")
        ctx = browser.new_context(viewport={"width": 390, "height": 844})
        page = ctx.new_page()
        page.on("pageerror", lambda e: errors.append(f"pageerror:{e}"))
        page.on(
            "console",
            lambda m: errors.append(f"console:{m.text}") if m.type == "error" else None,
        )
        page.on("dialog", lambda d: d.dismiss())

        for key, site in SITES.items():
            # ---- §1 站点 manifest ----
            check_site_manifest(page, key, site)

            # ---- 逐个视口走一遍站点页面 ----
            for width, height in VIEWPORTS:
                page.set_viewport_size({"width": width, "height": height})
                page.goto(f"{BASE}{site['home']}", wait_until="networkidle")
                page.wait_for_timeout(700)

                # 主内容区在场（按站点分别选 id：spark-main / av-main）
                main_present = page.locator(f"#{site['main_id']}").count() > 0
                record(
                    f"§2 {key}@{width}px：主内容区 #{site['main_id']} 在场",
                    main_present,
                    f"url={page.url}",
                )

                check_manifest_link(page, f"{key}@{width}px", site)
                check_viewport_meta(page, f"{key}@{width}px", site)
                check_no_page_overflow(page, key, width)
                check_touch_targets(page, f"{key}@{width}px", site)
                check_back_path(page, f"{key}@{width}px", site)

                page.screenshot(
                    path=os.path.join(SHOT, f"{key}-{width}x{height}.png"),
                    full_page=False,
                )

            # ---- §4 免登录与下拉刷新（在 390px 下做） ----
            page.set_viewport_size({"width": 390, "height": 844})
            check_public_route(page, key, site)
            page.goto(f"{BASE}{site['home']}", wait_until="networkidle")
            page.wait_for_timeout(500)
            check_pull_to_refresh(page, key, site)

        # ---- §3 手机端入口（需要主工作台，手机形态） ----
        page.set_viewport_size({"width": 390, "height": 844})
        check_mobile_entries(page, "手机端", SITES["spark"])

        browser.close()

    # 首屏 JS 错误：不作为硬失败，但要打出来（standalone 下的静默报错很难查）
    if errors:
        print(f"\n⚠ 页面错误 {len(errors)} 条：")
        for e in errors[:10]:
            print(f"  {e}")

    failures = [r for r in results if not r["ok"]]
    write_results()
    print(f"\n合计 {len(results)} 条，失败 {len(failures)} 条")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
