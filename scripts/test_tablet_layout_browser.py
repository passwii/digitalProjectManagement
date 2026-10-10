import json
import tempfile
import unittest
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright

from scripts.acceptance_tablet_landscape import FE_BASE, _fixture_response, has_page_overflow, internal_table_scroll_valid, is_fixture_api_request, is_local_fixture_origin, is_safe_fixture_browser_request, tablet_filter_layout_valid


FINANCE_BOOK = {
    "id": 81,
    "code": "TABLET",
    "name": "平板验收账套",
    "base_currency": "CNY",
    "currencies": ["CNY"],
    "status": "active",
}
PROJECT = {
    "id": 7001,
    "code": "PJ-2026-001",
    "name": "苏州园区智慧交通协同平台",
    "type": "软件开发",
    "dept_id": 1,
    "owner_id": 7,
    "owner_name": "平板验收管理员",
    "member_ids": [7],
    "plan_start": "2026-01-15",
    "plan_end": "2026-12-31",
    "budget_total": 2_860_000,
    "priority": "high",
    "client": "苏州工业园区管理委员会",
    "client_contact": "项目办",
    "client_phone": "0512-60000001",
    "description": "只用于隔离浏览器内的平板布局视觉测试，不写入业务系统。",
    "contract_status": "signed",
    "status": "in_progress",
    "progress": 68,
}
TABLET_USER_FIXTURE = {
    "id": 7, "username": "13900000001", "real_name": "平板验收管理员", "status": "active", "dept_id": 1,
    "roles": [{"code": "admin", "name": "系统管理员"}], "must_change_pwd": False,
}
TABLET_MENUS_FIXTURE = {
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
DASHBOARD_DATA = {
    "kpi": {
        "my_projects": 1,
        "active_projects": 1,
        "overdue_tasks": 2,
        "my_overdue_tasks": 1,
        "near_milestones": 2,
        "stagnant_projects": 0,
        "total_budget": 2_860_000,
        "total_spent": 1_624_000,
        "total_rate": 56.8,
        "month_spent": 246_000,
        "month": "2026-09",
        "pending_approvals": 2,
        "unread_notifications": 0,
    },
    "trend": [
        {"month": "2026-04", "spent": 126_000},
        {"month": "2026-05", "spent": 188_000},
        {"month": "2026-06", "spent": 164_000},
        {"month": "2026-07", "spent": 221_000},
        {"month": "2026-08", "spent": 205_000},
        {"month": "2026-09", "spent": 246_000},
    ],
    "by_subject": [
        {"subject": "设备采购", "budget": 980_000, "spent": 712_000},
        {"subject": "系统集成", "budget": 740_000, "spent": 426_000},
        {"subject": "实施服务", "budget": 510_000, "spent": 296_000},
        {"subject": "软件许可", "budget": 360_000, "spent": 121_000},
    ],
    "health": [{
        "id": 7001,
        "code": PROJECT["code"],
        "name": PROJECT["name"],
        "status": "in_progress",
        "priority": "high",
        "owner_id": 7,
        "progress": 68,
        "plan_end": PROJECT["plan_end"],
        "budget": PROJECT["budget_total"],
        "spent": 1_624_000,
        "rate": 56.8,
        "overdue_tasks": 2,
        "stagnant_days": 0,
        "health": "risk",
    }],
}
WEEKLY_DATA = {
    "range": {"from": "2026-09-22", "to": "2026-09-28"},
    "project_id": None,
    "progress_logs": [],
    "log_count": 0,
    "overdue": [],
    "due_soon": [],
    "projects": [{"id": 7001, "code": PROJECT["code"], "name": PROJECT["name"], "status": PROJECT["status"], "progress": 68}],
}
SPARK_ROUTES = ["/spark/dashboard", "/spark/stores", "/spark/compute", "/spark/billing", "/spark/content", "/spark/security", "/spark/ops", "/spark/permission"]
TABLET_VIEWPORTS = [(1180, 820), (1280, 800), (1366, 900)]


class TabletLandscapeBrowserTest(unittest.TestCase):
    def setUp(self):
        if not is_local_fixture_origin(FE_BASE):
            raise unittest.SkipTest("安全限制：FE_BASE 必须是 localhost / 127.0.0.1 的 http URL。")
        self.playwright = sync_playwright().start()
        self.browser = self.playwright.chromium.launch(channel="chrome", headless=True)
        self.context = self.browser.new_context(viewport={"width": 1180, "height": 820}, device_scale_factor=1)
        self.context.add_cookies([{"name": "pm_access_token", "value": "tablet-layout-read-only", "url": FE_BASE}])
        self.context.add_init_script("localStorage.setItem('pm_access_token', 'tablet-layout-read-only');")
        self.dashboard_data = False

        def fixture(route):
            request_url = urlparse(route.request.url)
            if request_url.path.startswith("/api/"):
                if not is_fixture_api_request(route.request.method, route.request.url):
                    route.abort("blockedbyclient")
                    return
            elif not is_safe_fixture_browser_request(route.request.method, route.request.url, FE_BASE):
                route.abort("blockedbyclient")
                return
            path = request_url.path
            if not path.startswith("/api/"):
                route.continue_()
                return
            if path.startswith("/api/v1/"):
                path = path[len("/api/v1"):]
            else:
                path = path[len("/api"):]
            response = _fixture_response(path, route.request.method)
            if path.endswith("/auth/me"):
                response = TABLET_USER_FIXTURE
            elif path.endswith("/meta/me/menus"):
                response = TABLET_MENUS_FIXTURE
            elif path.endswith("/admin/roles"):
                response = [{"id": 1, "code": "admin", "name": "系统管理员"}]
            elif path.endswith("/admin/modules"):
                response = [{"key": "projects", "label": "项目台账"}]
            elif path.endswith("/admin/params"):
                response = {}
            elif path.endswith("/admin/dicts"):
                response = []
            elif path.endswith("/finance/books"):
                response = [FINANCE_BOOK]
            elif path.rstrip("/").endswith("/projects"):
                response = {"items": [PROJECT], "total": 1, "page": 1, "size": 20}
            elif path.endswith("/projects/owners"):
                response = []
            elif path.endswith("/dashboard/summary") and self.dashboard_data:
                response = DASHBOARD_DATA
            elif path.endswith("/dashboard/my-weekly") and self.dashboard_data:
                response = WEEKLY_DATA
            route.fulfill(status=200, content_type="application/json", body=json.dumps(response, ensure_ascii=False))

        self.context.route("**/*", fixture)
        self.page = self.context.new_page()
        self.page.on("console", lambda message: print(f"[browser:{message.type}] {message.text}") if message.type == "error" else None)
        self.page.on("pageerror", lambda error: print(f"[browser:pageerror] {error}"))

    def tearDown(self):
        self.context.close()
        self.browser.close()
        self.playwright.stop()

    def _open(self, path: str, width: int, height: int, require_page_header: bool = True):
        self.page.set_viewport_size({"width": width, "height": height})
        self.page.goto(f"{FE_BASE}{path}", wait_until="domcontentloaded", timeout=20_000)
        self.page.locator("#main-content").wait_for(state="visible", timeout=15_000)
        if require_page_header:
            self.page.locator('[data-page-header="true"]').wait_for(state="visible", timeout=10_000)
        self.page.wait_for_timeout(100)

    def test_projects_and_finance_tablet_headers_keep_title_in_viewport_and_filters_below_actions(self):
        for route in ("/projects", "/finance"):
            with self.subTest(route=route):
                self._open(route, 1180, 820)
                result = self.page.evaluate(
                    """() => {
                      const header = document.querySelector('[data-page-header="true"]');
                      const box = (e) => { if (!e) return null; const r=e.getBoundingClientRect(); return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height}; };
                      const actions = header.querySelector('[data-page-header-actions="true"]');
                      const title = document.querySelector('[data-page-title="true"]');
                      const filters = header.querySelector('[data-page-header-filters="true"]');
                      return {header:box(header),title:box(title),actions:box(actions),filters:box(filters),viewportWidth:innerWidth};
                    }"""
                )
                self.assertIsNotNone(result["title"], json.dumps(result, ensure_ascii=False))
                self.assertGreater(result["title"]["width"], 0, json.dumps(result, ensure_ascii=False))
                self.assertGreaterEqual(result["title"]["x"], -1, json.dumps(result, ensure_ascii=False))
                self.assertLessEqual(result["title"]["right"], result["viewportWidth"] + 1, json.dumps(result, ensure_ascii=False))
                self.assertGreaterEqual(result["filters"]["y"], result["actions"]["bottom"] - 1, json.dumps(result, ensure_ascii=False))

    def test_finance_header_filter_label_does_not_overlap_select_at_tablet_width(self):
        self._open("/finance", 1180, 820)
        measurements = self.page.evaluate(
            """() => {
              const fields = [...document.querySelectorAll('[data-page-header-filters="true"] > *')];
              const box = (element) => {
                if (!element) return null;
                const r = element.getBoundingClientRect();
                return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
              };
              return fields.map((field) => {
                const root = field.matches('.toolbar-field') ? field : field.querySelector('.toolbar-field') || field;
                return { text: (field.innerText || '').trim(), labelBox: box(root.querySelector(':scope > span')),
                  control: box(root.querySelector('input, select, button, [role="combobox"]')) };
              });
            }"""
        )
        self.assertTrue(measurements, "Finance PageHeader 应包含账套筛选")
        self.assertTrue(tablet_filter_layout_valid(measurements), json.dumps(measurements, ensure_ascii=False, indent=2))
        header = self.page.locator('[data-page-header="true"]')
        self.assertLessEqual(header.evaluate("e => e.scrollWidth"), header.evaluate("e => e.clientWidth") + 1)

    def test_tablet_header_controls_meet_touch_height_target(self):
        undersized = []
        for route in ("/projects", "/finance", "/reports", "/progress"):
            self._open(route, 1180, 820)
            controls = self.page.locator('[data-page-header="true"] button, [data-page-header="true"] a, [data-page-header="true"] input, [data-page-header="true"] select').evaluate_all(
                "nodes => nodes.filter(e => {const r=e.getBoundingClientRect(),s=getComputedStyle(e);return s.display!=='none'&&r.width>0&&r.height>0}).map(e=>({tag:e.tagName,text:(e.innerText||e.getAttribute('aria-label')||'').trim(),height:e.getBoundingClientRect().height}))"
            )
            undersized.extend({"route": route, **control} for control in controls if control["height"] < 43.5)
        self.assertFalse(undersized, json.dumps(undersized, ensure_ascii=False, indent=2))

    def test_project_table_actions_are_touch_reachable_without_hover(self):
        self._open("/projects", 1180, 820)
        self.page.locator(".project-table tbody tr:first-child").wait_for(state="visible", timeout=10_000)
        actions = self.page.locator(".project-table tbody tr:first-child .table-actions button").evaluate_all(
            "nodes => nodes.map(e => ({text:e.innerText.trim(), height:e.getBoundingClientRect().height, opacity:getComputedStyle(e).opacity, visible:e.getBoundingClientRect().width>0 && e.getBoundingClientRect().height>0}))"
        )
        self.assertTrue(actions, "带只读项目 fixture 的项目表格应显示行内操作")
        self.assertTrue(all(action["visible"] and action["opacity"] == "1" and action["height"] >= 43.5 for action in actions), json.dumps(actions, ensure_ascii=False))

    def test_project_table_drawer_stays_inside_page_viewport(self):
        self._open("/projects", 1180, 820)
        row = self.page.locator(".project-table tbody tr:first-child")
        row.wait_for(state="visible", timeout=10_000)
        row.click()
        self.page.get_by_role("dialog").wait_for(state="visible", timeout=5_000)
        self.page.wait_for_function("""() => {const e=document.querySelector('[role="dialog"]');if(!e)return false;const m=new DOMMatrix(getComputedStyle(e).transform);return Math.abs(m.m41)<0.1 && Math.abs(m.m42)<0.1}""", timeout=5_000)
        geometry = self.page.evaluate(
            """() => {
              const d=document.querySelector('[role="dialog"]');
              const r=d.getBoundingClientRect();
              return {documentWidth:document.documentElement.scrollWidth,viewportWidth:innerWidth,
                drawer:{x:r.x,right:r.right,width:r.width},bodyOverflow:getComputedStyle(document.documentElement).overflowX};
            }"""
        )
        self.assertLessEqual(geometry["documentWidth"], geometry["viewportWidth"] + 1, json.dumps(geometry, ensure_ascii=False))
        self.assertGreaterEqual(geometry["drawer"]["x"], 0, json.dumps(geometry, ensure_ascii=False))
        self.assertLessEqual(geometry["drawer"]["right"], geometry["viewportWidth"] + 1, json.dumps(geometry, ensure_ascii=False))

    def test_header_layout_does_not_leak_across_existing_and_tablet_breakpoints(self):
        for width in (767, 768, 900, 901, 1179, 1180, 1366, 1367):
            with self.subTest(width=width):
                self._open("/finance", width, 820)
                value = self.page.evaluate(
                    """() => {
                      const h=document.querySelector('[data-page-header="true"]');
                      const title=document.querySelector('[data-page-title="true"]');
                      const actions=h.querySelector('[data-page-header-actions="true"]');
                      const b=e=>{if(!e)return null;const r=e.getBoundingClientRect();return{x:r.x,y:r.y,right:r.right,bottom:r.bottom,w:r.width,h:r.height}};
                      return {header:b(h),title:b(title),actions:b(actions),docW:document.documentElement.scrollWidth,innerWidth};
                    }"""
                )
                self.assertLessEqual(value["docW"], width + 1, json.dumps(value, ensure_ascii=False))
                self.assertIsNotNone(value["title"], json.dumps(value, ensure_ascii=False))
                self.assertGreater(value["title"]["w"], 0, json.dumps(value, ensure_ascii=False))
                self.assertLessEqual(value["title"]["right"], width + 1, json.dumps(value, ensure_ascii=False))
                self.assertLessEqual(value["actions"]["right"], width + 1, json.dumps(value, ensure_ascii=False))

    def test_dashboard_content_grid_fit_and_snapshot(self):
        self.dashboard_data = True
        destination = Path(tempfile.gettempdir()) / "tablet-landscape-dashboard"
        destination.mkdir(parents=True, exist_ok=True)
        for width, height in ((1180, 820), (1280, 800), (1366, 900)):
            with self.subTest(width=width):
                self._open("/dashboard", width, height)
                metrics = self.page.evaluate(
                    """() => {
                      const box=e=>{if(!e)return null;const r=e.getBoundingClientRect();return{x:r.x,y:r.y,right:r.right,bottom:r.bottom,w:r.width,h:r.height}};
                      const children=s=>{const p=document.querySelector(s);return p?[...p.children].map(box):[]};
                      const style=s=>{const e=document.querySelector(s);return e?getComputedStyle(e).gridTemplateColumns:null};
                      return {innerWidth,documentWidth:document.documentElement.scrollWidth,readout:children('[class*=readoutRail]'),command:children('[class*=commandGrid]'),pulse:children('[class*=pulseGrid]'),readoutColumns:style('[class*=readoutRail]'),commandColumns:style('[class*=commandGrid]'),pulseColumns:style('[class*=pulseGrid]')};
                    }"""
                )
                self.assertFalse(has_page_overflow(metrics["documentWidth"], width), json.dumps(metrics, ensure_ascii=False))
                for name in ("readout", "command", "pulse"):
                    boxes = metrics[name]
                    for i, first in enumerate(boxes):
                        for second in boxes[i + 1:]:
                            separate_rows = first["bottom"] <= second["y"] + 1 or second["bottom"] <= first["y"] + 1
                            separate_columns = first["right"] <= second["x"] + 1 or second["right"] <= first["x"] + 1
                            self.assertTrue(separate_rows or separate_columns, f"{name} children overlap at {width}px: {metrics}")
                self.page.screenshot(path=str(destination / f"{width}x{height}.png"), full_page=False, animations="disabled")

    def test_project_and_finance_dialogs_fit_tablet_width_without_page_overflow(self):
        cases = (("/projects", "+ 新建项目"), ("/finance", "+ 新建账套"))
        for route, action_name in cases:
            for width, height in TABLET_VIEWPORTS:
                with self.subTest(route=route, width=width):
                    self._open(route, width, height)
                    self.page.wait_for_function("() => document.readyState === 'complete'", timeout=10_000)
                    self.page.get_by_role("button", name=action_name).click()
                    dialog = self.page.get_by_role("dialog")
                    dialog.wait_for(state="visible", timeout=5_000)
                    self.page.wait_for_function("""() => {const e=document.querySelector('[role="dialog"]');if(!e)return false;const r=e.getBoundingClientRect(),m=new DOMMatrix(getComputedStyle(e).transform);return Math.abs(m.m41)<0.1 && Math.abs(m.m42)<0.1 && r.width>0}""", timeout=5_000)
                    geometry = self.page.evaluate(
                        """() => {
                          const e=document.querySelector('[role="dialog"]'),r=e.getBoundingClientRect();
                          return {documentWidth:document.documentElement.scrollWidth,innerWidth,
                            panel:{x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height},
                            viewport:{width:innerWidth,height:innerHeight}};
                        }"""
                    )
                    self.assertLessEqual(geometry["documentWidth"], width + 1, json.dumps(geometry, ensure_ascii=False))
                    self.assertGreaterEqual(geometry["panel"]["x"], -1, json.dumps(geometry, ensure_ascii=False))
                    self.assertLessEqual(geometry["panel"]["right"], width + 1, json.dumps(geometry, ensure_ascii=False))
                    self.assertLessEqual(geometry["panel"]["width"], width + 1, json.dumps(geometry, ensure_ascii=False))
                    self.page.keyboard.press("Escape")
                    dialog.wait_for(state="hidden", timeout=5_000)

    def test_finance_workbench_tabs_fit_tablet_width(self):
        labels = ["账套概览", "基础设置", "凭证", "项目支出入账", "应收应付", "出纳与对账", "固定资产", "账簿与报表", "期末结账"]
        for label in labels:
            with self.subTest(tab=label):
                self._open("/finance", 1180, 820)
                self.page.get_by_role("tab", name=label).click(timeout=5_000)
                self.assertEqual(self.page.get_by_role("tab", name=label).get_attribute("aria-selected"), "true")
                dimensions = self.page.evaluate("({documentWidth:document.documentElement.scrollWidth,innerWidth,bodyWidth:document.body.scrollWidth})")
                self.assertLessEqual(dimensions["documentWidth"], 1181, json.dumps({"tab": label, **dimensions}, ensure_ascii=False))
                self.assertLessEqual(dimensions["bodyWidth"], 1181, json.dumps({"tab": label, **dimensions}, ensure_ascii=False))

    def test_other_business_routes_render_readonly_in_tablet_width(self):
        routes = ["/progress", "/costs", "/approvals", "/opportunities", "/assets", "/reports", "/contacts", "/partners", "/admin", "/changelog"]
        for width, height in TABLET_VIEWPORTS:
            for route in routes:
                with self.subTest(width=width, route=route):
                    # /assets 总览态无 header 是有意的；PageHeader 仅在有筛选项或操作时渲染。
                    self._open(route, width, height, require_page_header=route not in {"/changelog", "/admin", "/assets"})
                    state = self.page.evaluate(
                        """() => ({width:innerWidth,documentWidth:document.documentElement.scrollWidth,
                          sidebar:getComputedStyle(document.querySelector('[data-shell="sidebar"]')).display,
                          main:document.querySelector('#main-content')?.getBoundingClientRect().width||0,
                          header:document.querySelector('[data-page-header="true"]')?.getBoundingClientRect().width||0})"""
                    )
                    self.assertFalse(has_page_overflow(state["documentWidth"], width), json.dumps({"route":route,**state}, ensure_ascii=False))
                    self.assertGreater(state["main"], 0, json.dumps({"route":route,**state}, ensure_ascii=False))
                    self.assertNotEqual(state["sidebar"], "none", json.dumps({"route":route,**state}, ensure_ascii=False))

    def test_tablet_list_and_dashboard_preserve_light_dark_and_reduced_motion(self):
        self._open("/projects", 1180, 820)
        projects = self.page.evaluate(
            """() => {
              const root=document.documentElement;
              const table=document.querySelector('table.grid');
              const frame=table?.closest('.table-scroll,[data-desktop-table-frame="true"]');
              return {theme:root.dataset.theme,background:getComputedStyle(root).backgroundColor,
                documentWidth:root.scrollWidth,tableWidth:table?.getBoundingClientRect().width||0,
                tableScrollWidth:table?.scrollWidth||0,frame:frame?{width:frame.getBoundingClientRect().width}:null,
                frameClientWidth:frame?.clientWidth??null,frameScrollWidth:frame?.scrollWidth??null,
                frameOverflowX:frame?getComputedStyle(frame).overflowX:null};
            }"""
        )
        self.assertLessEqual(projects["documentWidth"], 1181, json.dumps(projects, ensure_ascii=False))
        self.assertTrue(internal_table_scroll_valid({key: projects[key] for key in ("tableScrollWidth", "frame", "frameClientWidth", "frameScrollWidth", "frameOverflowX")}), json.dumps(projects, ensure_ascii=False))
        self.assertTrue(projects["background"])
        self.page.evaluate("localStorage.setItem('shuzhi-theme-mode','light')")
        self.page.reload(wait_until="domcontentloaded")
        self.page.locator("#main-content").wait_for(state="visible", timeout=15_000)
        light = self.page.evaluate("({theme:document.documentElement.dataset.theme,background:getComputedStyle(document.documentElement).backgroundColor,documentWidth:document.documentElement.scrollWidth})")
        self.assertEqual(light["theme"], "light")
        self.assertLessEqual(light["documentWidth"], 1181, json.dumps(light, ensure_ascii=False))
        self.page.emulate_media(reduced_motion="reduce")
        self.dashboard_data = True
        self._open("/dashboard", 1180, 820)
        reduced = self.page.evaluate("({theme:document.documentElement.dataset.theme,reduced:matchMedia('(prefers-reduced-motion: reduce)').matches,documentWidth:document.documentElement.scrollWidth})")
        self.assertTrue(reduced["reduced"])
        self.assertLessEqual(reduced["documentWidth"], 1181, json.dumps(reduced, ensure_ascii=False))

    def test_spark_dense_pages_fit_tablet_landscape_widths(self):
        output = Path(tempfile.gettempdir()) / "tablet-landscape-spark"
        output.mkdir(parents=True, exist_ok=True)
        for width, height in TABLET_VIEWPORTS:
            self.page.set_viewport_size({"width": width, "height": height})
            for route in SPARK_ROUTES:
                with self.subTest(width=width, route=route):
                    self.page.goto(f"{FE_BASE}{route}", wait_until="domcontentloaded", timeout=20_000)
                    self.page.locator("#spark-main").wait_for(state="visible", timeout=15_000)
                    geometry = self.page.evaluate(
                        """() => {
                          const rect=e=>{if(!e)return null;const r=e.getBoundingClientRect();return{x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height}};
                          const main=document.querySelector('#spark-main'),topbar=document.querySelector('header'),root=document.querySelector('main');
                          const grids=[...document.querySelectorAll('[class*=metricGrid],[class*=splitGrid],[class*=balancedGrid],[class*=threeGrid],[class*=fourGrid],[class*=fiveGrid]')]
                            .map(grid=>({rect:rect(grid),children:[...grid.children].map(rect)}));
                          const tables=[...document.querySelectorAll('table[class*=dataTable]')].map(table=>{
                            const frame=table.closest('[class*=tableWrap]');
                            return {tableScrollWidth:table.scrollWidth,frame:rect(frame),frameClientWidth:frame?.clientWidth??null,
                              frameScrollWidth:frame?.scrollWidth??null,frameOverflowX:frame?getComputedStyle(frame).overflowX:null};
                          });
                          const farthest=[main,topbar,root].filter(Boolean).map(rect).filter(Boolean).reduce((m,r)=>Math.max(m,r.right),0);
                          return {innerWidth,documentWidth:document.documentElement.scrollWidth,farthest,sidebar:rect(document.querySelector('aside')),main:rect(main),topbar:rect(topbar),grids,tables};
                        }"""
                    )
                    self.assertFalse(has_page_overflow(geometry["documentWidth"], width), json.dumps(geometry, ensure_ascii=False))
                    self.assertLessEqual(geometry["farthest"], width + 1, json.dumps(geometry, ensure_ascii=False))
                    self.assertTrue(geometry["sidebar"] and geometry["main"])
                    for table in geometry["tables"]:
                        self.assertTrue(internal_table_scroll_valid(table), f"Spark table overflow must stay in its tableWrap: {width}px {route}: {geometry}")
                    for grid in geometry["grids"]:
                        for i, first in enumerate(grid["children"]):
                            for second in grid["children"][i + 1:]:
                                separated = first["right"] <= second["x"] + 1 or second["right"] <= first["x"] + 1 or first["bottom"] <= second["y"] + 1 or second["bottom"] <= first["y"] + 1
                                self.assertTrue(separated, f"Spark grid overlaps at {width}px ({route}): {geometry}")
                    self.page.screenshot(path=str(output / f"{width}x{height}-{route.strip('/').replace('/', '-')}.png"), full_page=False, animations="disabled")


if __name__ == "__main__":
    unittest.main()
