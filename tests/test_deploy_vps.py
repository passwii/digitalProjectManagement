import socket
import subprocess
import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from scripts.deploy_vps import (  # noqa: E402
    DEFAULT_APP_DIR,
    DEFAULT_BRANCH,
    DEFAULT_COMPOSE_FILES,
    SSH_PROBE_TIMEOUT,
    VPS_HOST_V4,
    VPS_HOST_V6,
    VPS_HOSTS,
    build_remote_script,
    build_ssh_command,
    describe_host,
    main,
    probe_host,
    select_host,
    ssh_ready,
    tcp_port_open,
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
        # 顺序即优先级：v4 在前，v6 才是 fallback。
        self.assertEqual(VPS_HOSTS, (VPS_HOST_V4, VPS_HOST_V6))
        self.assertEqual(DEFAULT_APP_DIR, "/opt/pm")
        self.assertEqual(DEFAULT_BRANCH, "main")
        self.assertEqual(
            DEFAULT_COMPOSE_FILES, ("docker-compose.yml", "docker-compose.prod.yml")
        )


class DeployVpsLinkFallbackTest(unittest.TestCase):
    """机房侧 v4 整段不通时，部署要自己改走 v6，而不是等人换地址。"""

    def test_ipv4_is_preferred_when_reachable(self):
        probes = []

        def probe(host):
            probes.append(host)
            return True, ""

        picked = select_host(VPS_HOSTS, probe=probe, log=lambda _: None)

        self.assertEqual(picked, VPS_HOST_V4)
        self.assertEqual(probes, [VPS_HOST_V4], "v4 通了就不该再探 v6")

    def test_falls_back_to_ipv6_when_ipv4_is_down(self):
        probes = []

        def probe(host):
            probes.append(host)
            return (host == VPS_HOST_V6, "8 秒内连不上 22 端口")

        picked = select_host(VPS_HOSTS, probe=probe, log=lambda _: None)

        self.assertEqual(picked, VPS_HOST_V6)
        self.assertEqual(probes, [VPS_HOST_V4, VPS_HOST_V6])

    def test_falls_back_when_port_is_open_but_ssh_never_greets(self):
        """真实故障形态：v4 的 22 端口收 SYN，banner 却永远不来。

        只看 TCP 会把这种半死链路判成可用，然后在真正部署时才炸。
        """
        with mock.patch("scripts.deploy_vps.tcp_port_open", return_value=True), mock.patch(
            "scripts.deploy_vps.ssh_ready",
            side_effect=lambda host, timeout: (
                (False, "Connection timed out during banner exchange")
                if VPS_HOST_V4 in host
                else (True, "")
            ),
        ):
            picked = select_host(VPS_HOSTS, log=lambda _: None)

        self.assertEqual(picked, VPS_HOST_V6)

    def test_probe_reports_the_banner_timeout_as_the_reason(self):
        with mock.patch("scripts.deploy_vps.tcp_port_open", return_value=True), mock.patch(
            "scripts.deploy_vps.ssh_ready",
            return_value=(False, "Connection timed out during banner exchange"),
        ):
            ok, reason = probe_host(VPS_HOST_V4)

        self.assertFalse(ok)
        self.assertIn("banner", reason)

    def test_probe_skips_the_handshake_when_the_port_is_closed(self):
        with mock.patch("scripts.deploy_vps.tcp_port_open", return_value=False), mock.patch(
            "scripts.deploy_vps.ssh_ready"
        ) as handshake:
            ok, reason = probe_host(VPS_HOST_V4)

        self.assertFalse(ok)
        self.assertIn("22", reason)
        handshake.assert_not_called()

    def test_ssh_ready_accepts_a_successful_handshake(self):
        with mock.patch(
            "scripts.deploy_vps.subprocess.run",
            return_value=subprocess.CompletedProcess([], 0, "", ""),
        ) as run:
            ok, reason = ssh_ready(f"root@{VPS_HOST_V6}")

        self.assertTrue(ok)
        self.assertEqual(reason, "")
        command = run.call_args[0][0]
        self.assertEqual(command[-1], "true")
        self.assertIn("BatchMode=yes", command)
        self.assertIn(f"ConnectTimeout={SSH_PROBE_TIMEOUT}", command)
        self.assertEqual(command[-2], f"root@{VPS_HOST_V6}")

    def test_ssh_ready_surfaces_the_last_stderr_line(self):
        stderr = "Warning: Permanently added\nssh: connect to host x port 22: timed out\n"
        with mock.patch(
            "scripts.deploy_vps.subprocess.run",
            return_value=subprocess.CompletedProcess([], 255, "", stderr),
        ):
            ok, reason = ssh_ready(f"root@{VPS_HOST_V4}")

        self.assertFalse(ok)
        self.assertEqual(reason, "ssh: connect to host x port 22: timed out")

    def test_ssh_ready_gives_up_on_a_hung_handshake(self):
        with mock.patch(
            "scripts.deploy_vps.subprocess.run",
            side_effect=subprocess.TimeoutExpired(["ssh"], SSH_PROBE_TIMEOUT),
        ):
            ok, reason = ssh_ready(f"root@{VPS_HOST_V4}")

        self.assertFalse(ok)
        self.assertIn("握手", reason)

    def test_tcp_probe_talks_to_a_real_socket(self):
        """探活的语义靠真 socket 验一次：监听中算通，关掉的算不通。"""
        listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)
        open_port = listener.getsockname()[1]
        try:
            self.assertTrue(tcp_port_open("127.0.0.1", open_port, timeout=2))
        finally:
            listener.close()

        self.assertFalse(tcp_port_open("127.0.0.1", open_port, timeout=2))

    def test_reports_none_when_both_links_are_down(self):
        picked = select_host(VPS_HOSTS, probe=lambda _: (False, "不通"), log=lambda _: None)

        self.assertIsNone(picked)

    def test_announces_which_link_won(self):
        messages = []
        select_host(
            VPS_HOSTS,
            probe=lambda host: (host == VPS_HOST_V6, "banner 超时"),
            log=messages.append,
        )

        self.assertIn("IPv4", messages[0])
        self.assertIn("banner 超时", messages[0], "失败原因要进日志，否则无从排查")
        self.assertIn("IPv6", messages[-1])

    def test_ipv6_target_is_not_bracketed(self):
        """`root@[::1]` 会被 ssh 当主机名解析失败，known_hosts 里也是裸地址。"""
        host = select_host((VPS_HOST_V6,), probe=lambda _: (True, ""), log=lambda _: None)
        command = build_ssh_command(f"root@{host}", build_remote_script())
        target = command[-2]

        self.assertEqual(target, f"root@{VPS_HOST_V6}")
        self.assertNotIn("[", target)

    def test_picks_ipv6_through_main(self):
        """main 必须真的用 select_host 的结果，而不是写死常量。"""
        import io
        from contextlib import redirect_stdout
        from unittest import mock

        with mock.patch(
            "scripts.deploy_vps.select_host", return_value=VPS_HOST_V6
        ) as picker, mock.patch("scripts.deploy_vps.subprocess.run") as run, redirect_stdout(
            io.StringIO()
        ):
            code = main([])

        self.assertEqual(code, 0)
        picker.assert_called_once_with(VPS_HOSTS)
        self.assertEqual(run.call_args[0][0][-2], f"root@{VPS_HOST_V6}")

    def test_explicit_host_skips_probing(self):
        import io
        from contextlib import redirect_stdout
        from unittest import mock

        with mock.patch("scripts.deploy_vps.select_host") as picker, mock.patch(
            "scripts.deploy_vps.subprocess.run"
        ), redirect_stdout(io.StringIO()):
            code = main(["--host", VPS_HOST_V6])

        self.assertEqual(code, 0)
        picker.assert_not_called()

    def test_fails_when_no_link_is_reachable(self):
        import io
        from contextlib import redirect_stderr, redirect_stdout
        from unittest import mock

        with mock.patch(
            "scripts.deploy_vps.select_host", return_value=None
        ), mock.patch("scripts.deploy_vps.subprocess.run") as run, redirect_stdout(
            io.StringIO()
        ), redirect_stderr(io.StringIO()):
            code = main([])

        self.assertEqual(code, 2)
        run.assert_not_called()

    def test_describe_host_labels_the_address_family(self):
        self.assertEqual(describe_host(VPS_HOST_V4), f"{VPS_HOST_V4} (IPv4)")
        self.assertEqual(describe_host(VPS_HOST_V6), f"{VPS_HOST_V6} (IPv6)")


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
        output = buffer.getvalue()
        self.assertIn("git pull --ff-only origin main", output)
        # dry-run 只列候选、不探活：无网环境（CI）下也必须能跑。
        self.assertIn(VPS_HOST_V4, output)
        self.assertIn(VPS_HOST_V6, output)


if __name__ == "__main__":
    unittest.main()
