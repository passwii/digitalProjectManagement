import unittest


from scripts.load_test_readonly import (
    build_scenarios,
    build_virtual_user_scenarios,
    parse_duration,
    percentile,
)


class ReadonlyLoadTestHelpersTest(unittest.TestCase):
    def test_parse_duration_supports_seconds_minutes_and_hours(self):
        self.assertEqual(parse_duration("30s"), 30.0)
        self.assertEqual(parse_duration("2m"), 120.0)
        self.assertEqual(parse_duration("1h"), 3600.0)

    def test_percentile_uses_sorted_samples(self):
        self.assertEqual(percentile([0.4, 0.1, 0.3, 0.2], 50), 0.3)
        self.assertEqual(percentile([0.4, 0.1, 0.3, 0.2], 95), 0.4)

    def test_scenarios_are_read_only_and_use_project_id(self):
        scenarios = build_scenarios(42, include_admin=True)
        paths = [path for _name, path in scenarios]

        self.assertTrue(paths)
        self.assertTrue(all(path.startswith("/") for path in paths))
        self.assertIn("/projects/42", paths)
        self.assertIn("/projects/42/progress", paths)
        self.assertIn("/tasks?project_id=42&page=1&size=20&sort=-plan_end", paths)
        self.assertTrue(all(path.split("?")[0] for path in paths))
        self.assertIn("/approvals/pending?limit=50", paths)
        self.assertTrue(all(path != "/auth/login" for path in paths))

    def test_virtual_user_flow_reuses_the_same_readonly_page_sequence(self):
        self.assertEqual(
            build_virtual_user_scenarios(42),
            build_scenarios(42),
        )


if __name__ == "__main__":
    unittest.main()
