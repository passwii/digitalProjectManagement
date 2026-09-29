import unittest

from scripts.acceptance_tablet_landscape import (
    REGRESSION_ROUTES,
    TARGET_ROUTES,
    VIEWPORTS,
    FixtureRouter,
    _fixture_response,
    guarded_route,
    has_page_overflow,
    is_fixture_api_request,
    is_local_fixture_origin,
    is_safe_fixture_browser_request,
    internal_table_scroll_valid,
    topbar_within_viewport,
    page_header_overlap_passes,
    rects_overlap,
    route_main_visible,
    routes_for_viewport,
    shell_expectation,
    tablet_filter_layout_valid,
)


class TabletLandscapeAcceptanceHelpersTest(unittest.TestCase):
    def test_target_viewports_are_css_pixel_sizes_in_plan_order(self):
        self.assertEqual(VIEWPORTS, [(1180, 820), (1280, 800), (1366, 900), (1179, 820), (1367, 900), (390, 844), (1440, 900)])

    def test_target_viewports_cover_all_primary_and_spark_routes(self):
        self.assertEqual(TARGET_ROUTES, [
            "/dashboard", "/projects", "/progress", "/costs", "/approvals", "/opportunities",
            "/assets", "/finance", "/reports", "/contacts", "/partners", "/admin", "/changelog",
            "/spark/dashboard", "/spark/stores", "/spark/billing", "/spark/security", "/spark/ops", "/spark/permission",
        ])

    def test_boundary_and_regression_sizes_use_only_representative_routes(self):
        self.assertEqual(routes_for_viewport(1180), TARGET_ROUTES)
        self.assertEqual(routes_for_viewport(1366), TARGET_ROUTES)
        self.assertEqual(REGRESSION_ROUTES, ["/dashboard", "/projects", "/approvals", "/finance", "/assets", "/reports", "/admin", "/spark/dashboard"])
        for width in (1179, 1367, 390, 1440):
            with self.subTest(width=width):
                self.assertEqual(routes_for_viewport(width), REGRESSION_ROUTES)

    def test_navigation_shell_expectation_respects_mobile_boundary(self):
        self.assertEqual(shell_expectation(767), ("dock", "sidebar"))
        self.assertEqual(shell_expectation(768), ("sidebar", "dock"))
        self.assertEqual(shell_expectation(1180), ("sidebar", "dock"))

    def test_local_fixture_origin_allows_only_loopback_http_origins(self):
        self.assertTrue(is_local_fixture_origin("http://localhost:3021"))
        self.assertTrue(is_local_fixture_origin("http://127.0.0.1:3021/path"))
        for origin in ("https://localhost", "http://example.com", "http://192.168.1.2:3021", "not a url"):
            with self.subTest(origin=origin):
                self.assertFalse(is_local_fixture_origin(origin))

    def test_browser_fixture_router_only_allows_safe_local_api_requests(self):
        self.assertTrue(is_fixture_api_request("GET", "http://localhost:8001/api/v1/projects?page=1"))
        self.assertTrue(is_fixture_api_request("OPTIONS", "http://127.0.0.1:8017/api/v1/projects"))
        for method, url in (
            ("POST", "http://localhost:8001/api/v1/projects"),
            ("GET", "http://api.example.com/api/v1/projects"),
            ("GET", "http://localhost:8001/other/path"),
        ):
            with self.subTest(method=method, url=url):
                self.assertFalse(is_fixture_api_request(method, url))

    def test_browser_fixture_context_blocks_api_urls_outside_loopback(self):
        fe_base = "http://localhost:3021"
        self.assertTrue(is_safe_fixture_browser_request("GET", fe_base + "/projects", fe_base))
        self.assertTrue(is_safe_fixture_browser_request("GET", "http://127.0.0.1:8001/api/v1/projects", fe_base))
        self.assertFalse(is_safe_fixture_browser_request("GET", "http://example.com/api/v1/projects", fe_base))
        self.assertFalse(is_safe_fixture_browser_request("GET", "https://localhost/projects", fe_base))
        self.assertFalse(is_safe_fixture_browser_request("POST", fe_base + "/api/v1/projects", fe_base))

    def test_topbar_must_be_effectively_visible_and_fit_within_viewport(self):
        visible = {"display": "block", "visibility": "visible", "opacity": "1"}
        self.assertTrue(topbar_within_viewport({"rect": {"width": 100, "height": 40, "left": 0, "right": 1180}, "style": visible}, 1180))
        self.assertFalse(topbar_within_viewport({"rect": {"width": 0, "height": 0, "left": 0, "right": 0}, "style": {"display": "none"}}, 1180))
        self.assertFalse(topbar_within_viewport({"rect": {"width": 100, "height": 40, "left": 0, "right": 1182}, "style": visible}, 1180))
        self.assertFalse(topbar_within_viewport({"rect": {"width": 100, "height": 40, "left": -101, "right": -1}, "style": visible}, 1180))
        self.assertFalse(topbar_within_viewport({"rect": {"width": 100, "height": 40, "left": 0, "right": 100}, "style": {**visible, "opacity": "0"}}, 1180))

    def test_wide_table_requires_its_own_scroll_frame(self):
        wide_table = {"tableScrollWidth": 1400, "frameClientWidth": 1100, "frameScrollWidth": 1400, "frame": {"width": 1100}, "frameOverflowX": "auto"}
        fitting_table = {"tableScrollWidth": 1000, "frameClientWidth": 1100, "frameScrollWidth": 1000, "frame": {"width": 1100}, "frameOverflowX": "auto"}
        no_scroll_frame = {"tableScrollWidth": 1400, "frameClientWidth": None, "frameScrollWidth": None, "frame": None, "frameOverflowX": None}
        self.assertTrue(internal_table_scroll_valid(wide_table))
        self.assertTrue(internal_table_scroll_valid(fitting_table))
        self.assertFalse(internal_table_scroll_valid(no_scroll_frame))

    def test_fixture_router_aborts_unsafe_browser_requests(self):
        class Request:
            def __init__(self, method: str, url: str): self.method, self.url = method, url
        class Route:
            def __init__(self, method: str, url: str): self.request = Request(method, url); self.action = None
            def abort(self, reason: str): self.action = ("abort", reason)
            def continue_(self): self.action = ("continue",)
            def fulfill(self, **kwargs): self.action = ("fulfill", kwargs)
        fe_base = "http://localhost:3021"
        for method, url, expected in (
            ("GET", fe_base + "/_next/static/app.js", "continue"),
            ("GET", "http://127.0.0.1:8001/api/v1/projects", "fulfill"),
            ("GET", "http://localhost:8001/api/v2/projects", "abort"),
            ("POST", "http://localhost:8001/api/v1/projects", "abort"),
            ("GET", "http://example.com/api/v1/projects", "abort"),
            ("POST", fe_base + "/anything", "abort"),
        ):
            with self.subTest(method=method, url=url):
                route = Route(method, url)
                guarded_route(route, FixtureRouter(), fe_base)
                self.assertEqual(route.action[0], expected)

    def test_root_horizontal_overflow_uses_one_pixel_tolerance(self):
        self.assertFalse(has_page_overflow(1181, 1180))
        self.assertFalse(has_page_overflow(1180, 1180))
        self.assertTrue(has_page_overflow(1182, 1180))

    def test_fixtures_cover_shell_and_common_empty_data_shapes(self):
        self.assertEqual(_fixture_response("/api/v1/auth/me", "GET")["id"], 7)
        self.assertTrue(_fixture_response("/api/v1/meta/me/menus", "GET")["is_admin"])
        self.assertEqual(_fixture_response("/api/v1/finance/books", "GET"), [])

    def test_layout_fixtures_do_not_invent_business_project_rows(self):
        self.assertEqual(_fixture_response("/api/v1/projects", "GET")["items"], [])
        self.assertEqual(_fixture_response("/api/v1/dashboard/summary", "GET")["health"], [])
        self.assertEqual(_fixture_response("/api/v1/projects/7001", "GET"), {})

    def test_admin_read_fixtures_match_endpoint_shapes_and_block_all_writes(self):
        fixtures = FixtureRouter()
        array_endpoints = ("/api/v1/admin/roles", "/api/v1/admin/modules", "/api/v1/admin/dicts")
        for path in array_endpoints:
            with self.subTest(path=path):
                self.assertEqual(_fixture_response(path, "GET"), [])
        self.assertEqual(_fixture_response("/api/v1/admin/params", "GET"), {})
        self.assertEqual(_fixture_response("/api/v1/admin/params?scope=all", "GET"), {})
        for path in ("/api/v1/admin/users", "/api/v1/admin/logs"):
            with self.subTest(path=path):
                self.assertEqual(_fixture_response(path, "GET"), {"items": [], "total": 0, "page": 1, "size": 20})
        class Route:
            class Request:
                def __init__(self, method: str): self.method = method
            def __init__(self, method: str): self.request = self.Request(method); self.action = None
            def abort(self, reason: str): self.action = ("abort", reason)
            def fulfill(self, **kwargs): self.action = ("fulfill", kwargs)
        for method in ("POST", "PUT", "PATCH", "DELETE"):
            route = Route(method)
            fixtures(route)
            with self.subTest(method=method):
                self.assertEqual(route.action, ("abort", "blockedbyclient"))

    def test_fixtures_never_forward_or_write_business_data(self):
        for path in ("/api/v1/projects", "/api/v1/expenses", "/api/v1/finance/books"):
            with self.subTest(path=path):
                for method in ("POST", "PUT", "PATCH", "DELETE"):
                    self.assertEqual(_fixture_response(path, method), {})

    def test_main_region_is_checked_for_each_shell(self):
        self.assertTrue(route_main_visible("/projects", {"shell": {"main": {"rect": {"width": 1, "height": 1}, "style": {}}}}))
        self.assertTrue(route_main_visible("/spark/dashboard", {"shell": {"sparkMain": {"rect": {"width": 1, "height": 1}, "style": {}}}}))
        self.assertFalse(route_main_visible("/spark/dashboard", {"shell": {"main": None, "sparkMain": None}}))

    def test_title_overlap_is_checked_only_when_page_header_exists(self):
        self.assertTrue(page_header_overlap_passes("/projects", {"titlePrimaryOverlap": False, "shell": {"pageHeader": True}}))
        self.assertFalse(page_header_overlap_passes("/projects", {"titlePrimaryOverlap": True, "shell": {"pageHeader": True}}))
        self.assertTrue(page_header_overlap_passes("/projects", {"titlePrimaryOverlap": None, "shell": {"pageHeader": None}}))
        self.assertTrue(page_header_overlap_passes("/spark/dashboard", {"titlePrimaryOverlap": True, "shell": {"pageHeader": True}}))

    def test_page_header_flex_copies_finance_filter_and_controls_into_first_row(self):
        stylesheet = __import__("pathlib").Path("web/components/ui/PageHeader.module.css").read_text()
        self.assertIn("grid-template-columns: minmax(0, 1fr) auto", stylesheet)
        self.assertIn(".titleWrap", stylesheet)
        self.assertIn(".filters", stylesheet)
        self.assertIn("grid-row: 2", stylesheet)
        self.assertIn(".actions", stylesheet)

    def test_tablet_page_header_styles_nested_custom_select_and_project_picker_buttons(self):
        stylesheet = __import__("pathlib").Path("web/components/ui/PageHeader.module.css").read_text()
        self.assertIn('.filters :global([data-select-root="true"] > button)', stylesheet)
        self.assertIn('.filters :global(.picker-grow > button)', stylesheet)
        self.assertGreaterEqual(stylesheet.count("min-height: 44px"), 3)

    def test_tablet_filter_layout_requires_non_overlapping_controls(self):
        self.assertFalse(tablet_filter_layout_valid([
            {"label": "当前账套", "labelBox": {"x": 376, "y": 120, "right": 425, "bottom": 138}, "control": {"x": 436, "y": 112, "right": 481, "bottom": 150}},
            {"label": "账套提示", "labelBox": {"x": 436, "y": 120, "right": 845, "bottom": 138}},
        ]))
        self.assertTrue(tablet_filter_layout_valid([
            {"label": "当前账套", "labelBox": {"x": 280, "y": 112, "right": 328, "bottom": 130}, "control": {"x": 280, "y": 136, "right": 520, "bottom": 174}},
            {"label": "账套提示", "labelBox": {"x": 536, "y": 140, "right": 880, "bottom": 158}},
        ]))

    def test_intersecting_rectangles_are_detected_with_tolerance(self):
        self.assertTrue(rects_overlap({"x": 0, "y": 0, "right": 40, "bottom": 20}, {"x": 38, "y": 10, "right": 80, "bottom": 30}))
        self.assertFalse(rects_overlap({"x": 0, "y": 0, "right": 40, "bottom": 20}, {"x": 41, "y": 0, "right": 80, "bottom": 20}))
        self.assertFalse(rects_overlap(None, {"x": 0, "y": 0, "right": 1, "bottom": 1}))


if __name__ == "__main__":
    unittest.main()
