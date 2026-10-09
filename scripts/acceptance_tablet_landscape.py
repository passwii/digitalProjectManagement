#!/usr/bin/env python3
"""Read-only browser layout acceptance for tablet landscape widths.

The authenticated shell and all GET/HEAD API requests use local layout-only
fixtures. No backend calls or business-data writes are made.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from playwright.sync_api import Browser, Page, Route, TimeoutError as PlaywrightTimeoutError, sync_playwright

FE_BASE = os.environ.get("FE_BASE", "http://127.0.0.1:3017").rstrip("/")
SHOT_DIR = Path(
    os.environ.get("SHOT_DIR")
    or "/private/var/folders/gh/f35cy9wx4fj0n5h3zbx8b9040000gn/T/opencode/tablet-landscape/shots"
)

VIEWPORTS = [(1180, 820), (1280, 800), (1366, 900), (1179, 820), (1367, 900), (390, 844), (1440, 900)]
TARGET_VIEWPORTS = {(1180, 820), (1280, 800), (1366, 900)}
TARGET_ROUTES = [
    "/dashboard", "/projects", "/progress", "/costs", "/approvals", "/opportunities",
    "/assets", "/finance", "/reports", "/contacts", "/partners", "/admin", "/changelog",
    "/spark/dashboard", "/spark/stores", "/spark/billing", "/spark/security", "/spark/ops", "/spark/permission",
]
REGRESSION_ROUTES = ["/dashboard", "/projects", "/approvals", "/finance", "/assets", "/reports", "/admin", "/spark/dashboard"]

ME = {
    "id": 7, "username": "13900000001", "real_name": "平板验收管理员", "status": "active", "dept_id": 1,
    "roles": [{"code": "admin", "name": "系统管理员"}], "must_change_pwd": False,
}
MENUS = {
    "roles": ["admin"], "is_admin": True, "can_approve": True, "can_finance": True,
    "menus": [
        {"key": "projects", "label": "项目台账", "href": "/projects"},
        {"key": "opportunities", "label": "商机管理", "href": "/opportunities"},
        {"key": "assets", "label": "资产管理", "href": "/assets"},
        {"key": "progress", "label": "进度跟踪", "href": "/progress"},
        {"key": "costs", "label": "支出记录", "href": "/costs"},
        {"key": "reports", "label": "支出报表", "href": "/reports"},
        {"key": "finance", "label": "财务管理", "href": "/finance"},
        {"key": "contacts", "label": "通讯录", "href": "/contacts"},
        {"key": "partners", "label": "友商管理", "href": "/partners"},
        {"key": "approvals", "label": "审批中心", "href": "/approvals"},
        {"key": "admin", "label": "系统管理", "href": "/admin"},
    ],
    "readonly": False, "demo_on": False, "can_toggle_demo": False,
}
INTERESTING_ELEMENTS = [
    "[data-console-shell='true']", "[data-shell='sidebar']", "[data-shell='topbar']", "[data-shell='dock']",
    "main#main-content", "[data-page-header='true']", ".page-head", "table.grid", ".table-scroll",
    "[data-list-viewport='true']", "[data-dashboard-page='true']", "[data-spark-page='true']", ".spark-root",
]


def routes_for_viewport(width: int) -> list[str]:
    return TARGET_ROUTES if 1180 <= width <= 1366 else REGRESSION_ROUTES


def has_page_overflow(document_width: int, viewport_width: int) -> bool:
    return document_width > viewport_width + 1


def rects_overlap(first: dict[str, float] | None, second: dict[str, float] | None, tolerance: float = 1.0) -> bool:
    if first is None or second is None:
        return False
    left_a, top_a = first.get("x", first.get("left", 0)), first.get("y", first.get("top", 0))
    right_a = first.get("right", left_a + first.get("width", first.get("w", 0)))
    bottom_a = first.get("bottom", top_a + first.get("height", first.get("h", 0)))
    left_b, top_b = second.get("x", second.get("left", 0)), second.get("y", second.get("top", 0))
    right_b = second.get("right", left_b + second.get("width", second.get("w", 0)))
    bottom_b = second.get("bottom", top_b + second.get("height", second.get("h", 0)))
    return left_a < right_b - tolerance and right_a > left_b + tolerance and top_a < bottom_b - tolerance and bottom_a > top_b + tolerance


def shell_expectation(width: int) -> tuple[str, str]:
    return ("dock", "sidebar") if width <= 767 else ("sidebar", "dock")


def _paged(items: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    rows = items or []
    return {"items": rows, "total": len(rows), "page": 1, "size": 20}


def _fixture_response(path: str, method: str) -> Any:
    if path.startswith("/api/v1/"):
        path = path[len("/api/v1"):]
    path = urlparse(path).path
    method = method.upper()
    if method not in {"GET", "HEAD", "OPTIONS"} or method == "HEAD":
        return {}
    if path.endswith("/auth/login"):
        return {"access_token": "tablet-layout-read-only", "refresh_token": "tablet-layout-read-only", "token_type": "bearer", "must_change_pwd": False}
    if path.endswith("/auth/me"):
        return ME
    if path.endswith("/meta/me/menus"):
        return MENUS
    if path.endswith("/meta/users/search"):
        return _paged()
    if path.endswith("/meta/users") or path.endswith("/meta/depts") or path.endswith("/meta/dicts"):
        return []
    if path.endswith("/notifications/count"):
        return {"unread": 0}
    if "/notifications" in path:
        return _paged()
    if path.endswith("/dashboard/summary"):
        kpi = {"my_projects": 0, "active_projects": 0, "overdue_tasks": 0, "my_overdue_tasks": 0,
               "near_milestones": 0, "stagnant_projects": 0, "total_budget": 0, "total_spent": 0,
               "total_rate": 0, "month_spent": 0, "month": "2026-09", "pending_approvals": 0,
               "unread_notifications": 0}
        return {"kpi": kpi, "trend": [], "by_subject": [], "health": []}
    if path.endswith("/dashboard/my-weekly"):
        return {"range": {"from": "2026-09-22", "to": "2026-09-28"}, "project_id": None, "progress_logs": [], "log_count": 0,
                "overdue": [], "due_soon": [], "projects": []}
    if path.endswith("/approvals/pending"):
        return {"project_filings": [], "budget_adjusts": [], "expenses": [], "total": 0, "totals": {"project_filings": 0, "budget_adjusts": 0, "expenses": 0}}
    if path in {"/admin/roles", "/admin/modules", "/admin/dicts"}:
        return []
    if path == "/admin/params":
        return {}
    if path in {"/admin/users", "/admin/logs"} or path.startswith("/admin/users?") or path.startswith("/admin/logs?"):
        return _paged()
    if path.endswith("/finance/books/recycle-bin/list"):
        return _paged()
    if "/finance/books" in path:
        return []
    if "/equipment-assets/overview" in path:
        return {"total": 0, "by_status": {}, "overdue": 0}
    if "/equipment-assets/statistics" in path:
        return {"by_category": [], "by_status": [], "by_month": [], "by_holder": []}
    if "/equipment-assets/categories" in path:
        return []
    if "/equipment-assets/" in path:
        return _paged()
    if "/reports/cost" in path:
        return _paged()
    if "/reports/warnings" in path:
        return {"overdue_tasks": [], "milestones": [], "stagnant_projects": [], "budget_warnings": [], "followup_due": []}
    if "/projects/owners" in path:
        return []
    if "/projects/options" in path:
        return _paged()
    if path.rstrip("/").endswith("/projects"):
        return _paged()
    if "/projects/" in path:
        return {}
    if "/opportunities" in path or "/partners" in path or "/contacts" in path:
        return _paged()
    if "/tasks" in path or "/budgets" in path or "/expenses" in path or "/progress" in path:
        return _paged()
    if "/admin/" in path:
        return _paged()
    if "/finance/" in path:
        return []
    return {}


class FixtureRouter:
    """Read-only API fixture router for empty-state layout assertions."""

    def __call__(self, route: Route) -> None:
        method = route.request.method.upper()
        if method not in {"GET", "HEAD", "OPTIONS"}:
            route.abort("blockedbyclient")
            return
        path = urlparse(route.request.url).path
        body = _fixture_response(path, method)
        route.fulfill(status=200, content_type="application/json", body=json.dumps(body, ensure_ascii=False))


def _is_spark(path: str) -> bool:
    return path.startswith("/spark/")


def route_main_visible(route: str, state: dict[str, Any]) -> bool:
    shell = state["shell"]
    element = shell.get("sparkMain") if _is_spark(route) else shell.get("main")
    viewport_width = state.get("viewport", {}).get("width")
    if viewport_width is None:
        return _visible(element)
    return shell_element_visible_in_viewport(element, viewport_width)


def page_title_within_viewport_passes(route: str, state: dict[str, Any]) -> bool:
    if _is_spark(route):
        return True
    title = state.get("pageTitle")
    if not title:
        return False
    rect = title.get("rect") or {}
    width = state.get("viewport", {}).get("width")
    return bool(
        width is not None
        and rect.get("width", 0) > 0
        and rect.get("x", rect.get("left", 0)) >= -1
        and rect.get("right", rect.get("x", 0) + rect.get("width", 0)) <= width + 1
    )


def tablet_filter_layout_valid(fields: list[dict[str, Any]]) -> bool:
    labels = [field["labelBox"] for field in fields if field.get("labelBox")]
    controls = [field["control"] for field in fields if field.get("control")]
    return not any(rects_overlap(label, control) for label in labels for control in controls)


def shell_element_visible_in_viewport(element: dict[str, Any] | None, width: int) -> bool:
    if not _visible(element):
        return False
    style = element.get("style") or {}
    if float(style.get("opacity", "1")) <= 0:
        return False
    rect = element["rect"]
    return rect.get("left", 0) >= -1 and rect["right"] >= -1 and rect.get("left", 0) <= width + 1


def topbar_within_viewport(topbar: dict[str, Any] | None, width: int) -> bool:
    return shell_element_visible_in_viewport(topbar, width) and topbar["rect"]["right"] <= width + 1


def internal_table_scroll_valid(table: dict[str, Any]) -> bool:
    frame_width = table.get("frameClientWidth")
    if frame_width is not None and table.get("tableScrollWidth", 0) <= frame_width + 1:
        return True
    frame = table.get("frame")
    return bool(
        frame
        and table.get("frameOverflowX") in {"auto", "scroll"}
        and table.get("frameScrollWidth", 0) >= table.get("tableScrollWidth", 0)
        and table.get("frameClientWidth", 0) < table.get("tableScrollWidth", 0)
    )


def _visible(element: dict[str, Any] | None) -> bool:
    if not element:
        return False
    rect, style = element.get("rect"), element.get("style") or {}
    return bool(rect and rect["width"] > 0 and rect["height"] > 0 and style.get("display") != "none" and style.get("visibility") != "hidden")


def measure_page(page: Page) -> dict[str, Any]:
    return page.evaluate(
        """(selectors) => {
          const rect = (element) => {
            if (!element) return null;
            const b = element.getBoundingClientRect();
            return { x: b.x, y: b.y, width: b.width, height: b.height, right: b.right, bottom: b.bottom, top: b.top, left: b.left };
          };
          const visible = (element) => {
            if (!element) return null;
            const style = getComputedStyle(element);
            return { rect: rect(element), style: { display: style.display, visibility: style.visibility, opacity: style.opacity } };
          };
          const elements = {};
          for (const selector of selectors) {
            elements[selector] = [...document.querySelectorAll(selector)].slice(0, 4).map((node) => ({
              text: (node.innerText || node.textContent || '').trim().slice(0, 120), rect: rect(node),
              scrollWidth: node.scrollWidth, clientWidth: node.clientWidth,
              className: typeof node.className === 'string' ? node.className : '', tagName: node.tagName,
            }));
          }
          const pageTitle = visible(document.querySelector('[data-page-title="true"]'));
          const overflowCandidates = [...document.querySelectorAll('body *')].filter((node) => node.scrollWidth > node.clientWidth + 1).slice(0, 20)
            .map((node) => ({ selector: node.tagName.toLowerCase() + (typeof node.className === 'string' && node.className.trim() ? '.' + node.className.trim().split(/\\s+/).join('.') : ''), scrollWidth: node.scrollWidth, clientWidth: node.clientWidth, rect: rect(node) }));
          const tables = [...document.querySelectorAll('table.grid')].slice(0, 8).map((table) => {
            const frame = table.closest('.table-scroll, [data-desktop-table-frame="true"]');
            return { table: rect(table), tableScrollWidth: table.scrollWidth, frame: rect(frame), frameClientWidth: frame?.clientWidth ?? null, frameScrollWidth: frame?.scrollWidth ?? null, frameOverflowX: frame ? getComputedStyle(frame).overflowX : null };
          });
          const filters = [...document.querySelectorAll('[data-page-header-filters="true"] > *, .asset-filters > *')].map((field) => {
            const root = field.matches('.toolbar-field') ? field : (field.querySelector('.toolbar-field') || field);
            const control = root.matches('input, select, button, [role="combobox"]')
              ? root : root.querySelector('input, select, button, [role="combobox"]');
            const label = root.querySelector(':scope > span');
            return { text: (field.innerText || '').trim().slice(0, 80), labelBox: rect(label), control: rect(control), field: rect(field) };
          });
          return {
            url: location.href, title: document.title,
            viewport: { width: innerWidth, height: innerHeight, documentWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth },
            shell: { sidebar: visible(document.querySelector('[data-shell="sidebar"]')), topbar: visible(document.querySelector('[data-shell="topbar"]')), dock: visible(document.querySelector('[data-shell="dock"]')), main: visible(document.querySelector('#main-content')), sparkMain: visible(document.querySelector('#spark-main')), pageHeader: visible(document.querySelector('[data-page-header="true"], .page-head')) },
            pageTitle, accountMenu: visible(document.querySelector('[role="menu"]')), tables, filters, overflowCandidates, elements,
          };
        }""", INTERESTING_ELEMENTS,
    )


def _emit(name: str, passed: bool, extra: str = "") -> bool:
    print(("PASS " if passed else "FAIL ") + name + (f" — {extra}" if extra else ""), flush=True)
    return passed


def is_local_fixture_origin(origin: str) -> bool:
    parsed = urlparse(origin)
    return parsed.scheme == "http" and parsed.hostname in {"localhost", "127.0.0.1"}


def is_fixture_api_request(method: str, url: str) -> bool:
    parsed = urlparse(url)
    safe_method = method.upper() in {"GET", "HEAD", "OPTIONS"}
    local_host = parsed.hostname in {"localhost", "127.0.0.1"}
    api_path = parsed.path == "/api/v1" or parsed.path.startswith("/api/v1/")
    return safe_method and local_host and api_path


def is_safe_fixture_browser_request(method: str, url: str, fe_base: str) -> bool:
    parsed = urlparse(url)
    frontend = urlparse(fe_base)
    if parsed.path.startswith("/api/"):
        return is_fixture_api_request(method, url)
    return method.upper() in {"GET", "HEAD", "OPTIONS"} and parsed.scheme == frontend.scheme == "http" and parsed.netloc == frontend.netloc


def _require_configuration() -> bool:
    if not is_local_fixture_origin(FE_BASE):
        print("安全限制：FE_BASE 必须是 localhost / 127.0.0.1 的 http URL。", file=sys.stderr)
        return False
    return True


def _enter_fixture_session(page: Page, context) -> bool:
    context.add_cookies([{"name": "pm_access_token", "value": "tablet-layout-read-only", "url": FE_BASE}])
    page.add_init_script("localStorage.setItem('pm_access_token', 'tablet-layout-read-only');")
    page.goto(f"{FE_BASE}/dashboard", wait_until="domcontentloaded", timeout=20_000)
    try:
        page.locator("#main-content").wait_for(state="visible", timeout=20_000)
    except PlaywrightTimeoutError:
        print("无法进入主业务工作面，请检查 FE_BASE 是否指向当前 worktree 的 Web 服务。", file=sys.stderr)
        return False
    return True


def _wait_for_route(page: Page, route: str) -> None:
    page.goto(f"{FE_BASE}{route}", wait_until="domcontentloaded", timeout=25_000)
    page.locator("#main-content, #spark-main").wait_for(state="visible", timeout=20_000)
    page.wait_for_timeout(100)


def _route_checks(page: Page, route: str, width: int, height: int) -> tuple[int, dict[str, Any]]:
    failures = 0
    try:
        _wait_for_route(page, route)
    except Exception as error:
        failures += 1
        _emit(f"{width}x{height} {route} 页面可达", False, f"{type(error).__name__}: {str(error)[:220]}")
        _save_failure(page, width, height, route)
        return failures, {"route": route, "error": str(error)}
    state = measure_page(page)
    prefix = f"{width}x{height} {route}"
    checks = [
        ("页面级无横向溢出", not has_page_overflow(state["viewport"]["documentWidth"], width), f"documentWidth={state['viewport']['documentWidth']} viewport={width}"),
        ("内容主区可见", route_main_visible(route, state), "主内容区域"),
    ]
    invalid_tables = [table for table in state.get("tables", []) if not internal_table_scroll_valid(table)]
    checks.append(("宽表格仅在自身容器内横向滚动", not invalid_tables, json.dumps(invalid_tables, ensure_ascii=False)[:240]))
    if not _is_spark(route):
        shown, hidden = shell_expectation(width)
        visible_pair = shell_element_visible_in_viewport(state["shell"].get(shown), width) and not _visible(state["shell"].get(hidden))
        checks.append(("业务侧栏可见且 Dock 隐藏" if shown == "sidebar" else "手机 Dock 可见且侧栏隐藏", visible_pair, "检查导航外壳可见性与视口交集"))
        checks.append(("顶栏可见且位于视口内", topbar_within_viewport(state["shell"].get("topbar"), width), "检查 topbar visibility/bounds"))
    if (width, height) == (1180, 820) and not _is_spark(route):
        checks.append(("顶栏标题不溢出视口", page_title_within_viewport_passes(route, state), "标题矩形/视口宽度"))
        checks.append(("筛选字段与控件不相交", tablet_filter_layout_valid(state["filters"]), json.dumps(state["filters"], ensure_ascii=False)[:240]))
    for label, passed, extra in checks:
        if not _emit(f"{prefix} {label}", passed, extra if not passed else ""):
            failures += 1
    if failures:
        _save_failure(page, width, height, route)
    return failures, state


def _save_failure(page: Page, width: int, height: int, route: str) -> None:
    SHOT_DIR.mkdir(parents=True, exist_ok=True)
    slug = route.strip("/").replace("/", "-") or "root"
    try:
        page.screenshot(path=str(SHOT_DIR / f"{width}x{height}-{slug}.png"), full_page=True, animations="disabled")
        (SHOT_DIR / f"{width}x{height}-{slug}.json").write_text(json.dumps(measure_page(page), ensure_ascii=False, indent=2))
    except Exception as error:
        print(f"截图失败 {width}x{height} {route}: {type(error).__name__}: {error}", file=sys.stderr)


def guarded_route(route: Route, fixture: FixtureRouter, fe_base: str) -> None:
    method, request_url = route.request.method, route.request.url
    parsed = urlparse(request_url)
    if parsed.path.startswith("/api/"):
        if is_fixture_api_request(method, request_url):
            fixture(route)
        else:
            route.abort("blockedbyclient")
    elif is_safe_fixture_browser_request(method, request_url, fe_base):
        route.continue_()
    else:
        route.abort("blockedbyclient")


def _run(browser: Browser) -> int:
    failures = 0
    context = browser.new_context(viewport={"width": 1180, "height": 820}, device_scale_factor=1)
    fixture = FixtureRouter()
    context.route("**/*", lambda route: guarded_route(route, fixture, FE_BASE))
    page = context.new_page()
    if not _enter_fixture_session(page, context):
        context.close()
        return 1
    for width, height in VIEWPORTS:
        page.set_viewport_size({"width": width, "height": height})
        for route in routes_for_viewport(width):
            route_failures, _ = _route_checks(page, route, width, height)
            failures += route_failures
        # 项目详情 Drawer 需要项目数据；本轮 fixture 只提供空态，避免将样例冒充业务记录。
    context.close()
    return failures


def main() -> int:
    if not _require_configuration():
        return 2
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(channel="chrome", headless=True)
            try:
                failures = _run(browser)
            finally:
                browser.close()
    except Exception as error:
        print(f"浏览器验收启动失败：{type(error).__name__}: {error}", file=sys.stderr)
        return 2
    if failures:
        print(f"平板横屏验收完成：{failures} 项失败；截图目录：{SHOT_DIR}", file=sys.stderr)
        return 1
    print("平板横屏验收完成：所有已执行项目通过。", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
