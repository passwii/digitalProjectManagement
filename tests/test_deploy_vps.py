import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from scripts.deploy_vps import (  # noqa: E402
    DEFAULT_APP_DIR,
    DEFAULT_BRANCH,
    DEFAULT_COMPOSE_FILES,
    build_remote_script,
    build_ssh_command,
    main,
)


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

    def test_backup_stays_out_of_deploy(self):
        """备份由 backup_db.sh 单独负责（cron/launchd），部署脚本不重复做。"""
        script = build_remote_script()

        self.assertNotIn("pg_dump", script)
        self.assertNotIn("/var/backups", script)

    def test_reports_deployed_commit(self):
        """部署后必须能回答「线上现在跑的是哪个版本」。"""
        script = build_remote_script()

        self.assertIn("git rev-parse --short HEAD", script)

    def test_refuses_to_deploy_dirty_worktree(self):
        """/opt/pm 被手改过就停下，避免 --ff-only 失败在看不懂的地方。"""
        script = build_remote_script()

        self.assertIn("git status --porcelain", script)

    def test_waits_for_api_health_instead_of_curling_once(self):
        """容器启动 ≠ 服务可用：entrypoint 还要跑迁移和 seed。"""
        script = build_remote_script()

        self.assertIn("wait_for_health", script)
        self.assertIn("http://127.0.0.1:8001/health", script)

    def test_checks_web_health_too(self):
        """只探 API 会让 web 构建坏掉也报「部署完成」。"""
        script = build_remote_script()

        self.assertIn("http://127.0.0.1:3001/", script)

    def test_dumps_api_logs_when_health_never_passes(self):
        script = build_remote_script()

        self.assertIn("logs --tail", script)

    def test_parameters_are_configurable(self):
        script = build_remote_script(
            app_dir="/srv/pm",
            branch="release",
            compose_files=("a.yml",),
        )

        self.assertIn("cd /srv/pm", script)
        self.assertIn("git pull --ff-only origin release", script)
        self.assertIn("docker compose -f a.yml up -d --build --remove-orphans", script)
        self.assertNotIn("opt/pm", script)

    def test_defaults_match_module_constants(self):
        self.assertEqual(DEFAULT_APP_DIR, "/opt/pm")
        self.assertEqual(DEFAULT_BRANCH, "main")
        self.assertEqual(
            DEFAULT_COMPOSE_FILES, ("docker-compose.yml", "docker-compose.prod.yml")
        )


class DeployVpsCommandTest(unittest.TestCase):
    def test_ssh_command_uses_batch_mode_and_keepalive(self):
        command = build_ssh_command("root@example.com", build_remote_script())

        self.assertEqual(command[0], "ssh")
        # 选项在 target 之前，target 之后紧跟要执行的脚本
        self.assertEqual(command[command.index("root@example.com") + 1], build_remote_script())
        self.assertIn("BatchMode=yes", command)
        self.assertIn("ConnectTimeout=20", command)
        self.assertIn("ServerAliveInterval=15", command)

    def test_dry_run_prints_script_without_executing(self):
        import io
        from contextlib import redirect_stdout

        buffer = io.StringIO()
        with redirect_stdout(buffer):
            code = main(["--dry-run"])

        self.assertEqual(code, 0)
        self.assertIn("git pull --ff-only origin main", buffer.getvalue())


if __name__ == "__main__":
    unittest.main()
