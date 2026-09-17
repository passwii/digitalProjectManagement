import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from scripts.deploy_vps import build_remote_script  # noqa: E402


class DeployVpsScriptTest(unittest.TestCase):
    def test_remote_script_updates_main_and_rebuilds_production(self):
        script = build_remote_script()

        self.assertIn("cd /opt/pm", script)
        self.assertIn("git pull --ff-only origin main", script)
        self.assertIn(
            "docker compose -f docker-compose.yml -f docker-compose.prod.yml "
            "up -d --build --remove-orphans",
            script,
        )
        self.assertIn("curl -fsS http://127.0.0.1:8001/health", script)
        self.assertNotIn("pg_dump", script)
        self.assertNotIn("/var/backups", script)


if __name__ == "__main__":
    unittest.main()
