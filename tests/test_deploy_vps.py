import os
import shutil
import socket
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def script_commands(script: str) -> list[str]:
    """只留会被真正执行的命令行——注释里提到某类命令不算数。"""
    return [
        line.strip()
        for line in script.splitlines()
        if line.strip() and not line.strip().startswith("#")
    ]


def installed_shells() -> list[str]:
    """本机装了哪些 shell。

    部署脚本由服务器上的登录 shell 执行，zsh 与 bash 在词分割上不一致（实测
    害过一次静默失效），所以回收片段的测试要按实际存在的 shell 各跑一遍，
    而不是假定 bash。
    """
    return [shell for shell in ("bash", "zsh") if shutil.which(shell)]

def _line_index(script: str, needle: str) -> int:
    """子串**首次出现所在的行号**（0 起）。

    为什么不用 str.index：远端脚本的注释里也会提到 `git pull --ff-only`，
    `index()` 会命中注释里的那一处，断言「校验早于拉代码」就变成了
    「校验早于一句注释」——恒真且毫无意义。这里只认**代码行**：
    去掉行首空白后以 needle 开头。
    """
    for number, line in enumerate(script.splitlines()):
        if line.strip().startswith(needle):
            return number
    raise AssertionError(f"脚本里找不到以 {needle!r} 开头的代码行")


from scripts.deploy_vps import (  # noqa: E402
    DEFAULT_APP_DIR,
    DEFAULT_BRANCH,
    DEFAULT_COMPOSE_FILES,
    PRUNE_BUILD_CACHE_UNTIL,
    PRUNE_KEEP_SPARE,
    REQUIRED_ENV_CHECKS,
    SSH_PROBE_TIMEOUT,
    VPS_HOST_V4,
    VPS_HOST_V6,
    VPS_HOSTS,
    build_env_check_block,
    build_prune_block,
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

    def test_never_touches_database_volumes(self):
        """pm-pg-data / pm-staging-data 是本机唯一的真数据，回收动作不许靠近。"""
        commands = script_commands(build_remote_script())

        self.assertFalse([cmd for cmd in commands if "volume" in cmd], commands)
        self.assertFalse([cmd for cmd in commands if "system prune" in cmd])

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
        self.assertEqual(PRUNE_BUILD_CACHE_UNTIL, "24h")
        self.assertEqual(PRUNE_KEEP_SPARE, 1)
        self.assertEqual(
            DEFAULT_COMPOSE_FILES, ("docker-compose.yml", "docker-compose.prod.yml")
        )


class DeployVpsHttpsPrereqTest(unittest.TestCase):
    """HTTPS 前置校验（BLF-1400）。

    背景：PWA 只能装在**安全上下文**里。实测（Chrome 140，非 localhost 的
    HTTP 源）：isSecureContext=false、navigator.serviceWorker=undefined、
    installability_errors=not-from-secure-origin。没有安全上下文就没有 SW，
    Chrome 拿不到 WebAPK，只能降级成「快捷方式」安装 —— 主屏幕图标右下角
    挂一个 Chrome 徽标，而且装出来的不是真应用。

    这些配错的后果是**静默**的：部署成功、站点能访问、图标能显示，只有装机
    方式不对。所以必须在部署前就拦。
    """

    def test_checks_the_three_https_prerequisites(self):
        script = build_remote_script()

        for name, _ in REQUIRED_ENV_CHECKS:
            self.assertIn(f'check_env "{name}"', script)

    def test_check_happens_before_touching_containers(self):
        """校验必须在 `docker compose up` 之前 —— 顺序反了就失去意义。"""
        script = build_remote_script()

        self.assertLess(
            _line_index(script, "check_env \"PM_DOMAIN\""),
            _line_index(script, "docker compose -f docker-compose.yml"),
            "HTTPS 前置校验必须早于容器操作",
        )

    def test_check_happens_before_pulling_code(self):
        """缺配置就别急着拉代码、起容器。"""
        script = build_remote_script()

        self.assertLess(
            _line_index(script, "check_env \"PM_DOMAIN\""),
            _line_index(script, "git pull --ff-only origin main"),
            "HTTPS 前置校验必须早于拉代码",
        )

    def test_missing_value_aborts_the_deploy(self):
        block = build_env_check_block()

        self.assertIn("exit 1", block)
        self.assertIn("缺少", block)

    def test_check_block_is_valid_bash_and_aborts_when_a_value_is_missing(self):
        """真跑一遍：缺项必须以非零码退出（而不是只打印一句提示）。"""
        with tempfile.TemporaryDirectory() as tmp:
            env_path = os.path.join(tmp, ".env")
            script_path = os.path.join(tmp, "check.sh")
            with open(script_path, "w", encoding="utf-8") as handle:
                handle.write(
                    "#!/usr/bin/env bash\nset -euo pipefail\n" + build_env_check_block()
                )
            with open(env_path, "w", encoding="utf-8") as handle:
                handle.write("PM_HOST_BIND=127.0.0.1\nAPI_PORT_BIND=127.0.0.1\n")

            result = subprocess.run(
                ["bash", script_path],
                cwd=tmp,
                capture_output=True,
                text=True,
            )

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("PM_DOMAIN", result.stderr)

    def test_check_block_passes_when_all_values_are_present(self):
        with tempfile.TemporaryDirectory() as tmp:
            env_path = os.path.join(tmp, ".env")
            script_path = os.path.join(tmp, "check.sh")
            with open(script_path, "w", encoding="utf-8") as handle:
                handle.write(
                    "#!/usr/bin/env bash\nset -euo pipefail\n" + build_env_check_block()
                )
            with open(env_path, "w", encoding="utf-8") as handle:
                handle.write(
                    "PM_DOMAIN=pm.example.com\n"
                    "PM_HOST_BIND=127.0.0.1\n"
                    "API_PORT_BIND=127.0.0.1\n"
                    "NEXT_PUBLIC_API_BASE=https://pm.example.com/api/v1\n"
                    "CORS_ORIGINS=https://pm.example.com\n"
                )

            result = subprocess.run(
                ["bash", script_path],
                cwd=tmp,
                capture_output=True,
                text=True,
            )

            self.assertEqual(result.returncode, 0, result.stderr)


class DeployVpsImageReclaimTest(unittest.TestCase):
    """部署收尾要回收悬空镜像；但绝不能碰到别人的栈和 volume。"""

    def test_reclaims_dangling_images(self):
        script = build_remote_script()

        self.assertIn("docker images -f dangling=true -q", script)
        self.assertIn('docker image rm "$id"', script)

    def test_reclaims_only_old_build_cache(self):
        """构建缓存不随镜像 tag 回收，但最近一次构建要留给下次部署复用。"""
        script = build_remote_script()

        self.assertIn('docker builder prune -f --filter "until=24h"', script)
        commands = script_commands(script)
        prunes = [cmd for cmd in commands if "builder prune" in cmd]
        self.assertEqual(len(prunes), 1, prunes)
        self.assertIn('docker builder prune -f --filter "until=24h"', prunes[0])

    def test_build_cache_reclaim_runs_after_health_checks(self):
        script = build_remote_script()
        last_health = script.rindex("wait_for_health \"http://127.0.0.1:3001/\"")

        self.assertGreater(script.index("prune_stale_build_cache"), last_health)

    def test_build_cache_reclaim_failure_cannot_fail_the_deploy(self):
        script = build_remote_script()

        self.assertIn(
            "prune_stale_build_cache || printf '警告：构建缓存回收出错，本次部署不受影响",
            script,
        )

    def test_build_cache_reclaim_can_be_skipped_with_image_reclaim(self):
        script = build_remote_script(prune_spare=None)

        self.assertNotIn("builder prune", script)

    def test_never_prunes_tagged_images_or_volumes(self):
        """本机还跑着 pm-staging / new-api / cliproxyapi / nezha，-a 会误伤。"""
        commands = script_commands(build_remote_script())

        for forbidden in ("prune -a", "prune --all", "system prune", "volume prune"):
            self.assertFalse(
                [cmd for cmd in commands if forbidden in cmd], f"{forbidden}: {commands}"
            )
        # 只允许动 `dangling=true` 的镜像，一个 tag 都不许点名删。
        removals = [cmd for cmd in commands if "image rm" in cmd]
        self.assertEqual(len(removals), 1, commands)
        self.assertIn('docker image rm "$id"', removals[0])
        self.assertIn("$id", removals[0])

    def test_reclaim_happens_only_after_health_checks_pass(self):
        """先确认新版本能服务，再去回收旧镜像。"""
        script = build_remote_script()
        last_health = script.rindex("wait_for_health \"http://127.0.0.1:3001/\"")

        self.assertGreater(script.index("prune_dangling_images"), last_health)
        self.assertGreater(script.index("docker image rm"), last_health)

    def test_keeps_one_spare_image_for_rollback(self):
        script = build_remote_script()

        self.assertIn('[ "$n" -le 1 ]', script)
        self.assertIn("保留上一版镜像备回滚", script)

    def test_keeps_nothing_when_spare_is_zero(self):
        script = build_remote_script(prune_spare=0)

        self.assertIn('[ "$n" -le 0 ]', script)

    def test_reclaim_failure_cannot_fail_the_deploy(self):
        """收尾动作出错时不能让一个已经健康的部署返回非零。"""
        script = build_remote_script()

        self.assertIn(
            "prune_dangling_images || printf '警告：镜像回收出错，本次部署不受影响", script
        )
        self.assertIn("docker image rm \"$id\" >/dev/null 2>&1", script)

    def test_reclaim_can_be_skipped(self):
        script = build_remote_script(prune_spare=None)

        self.assertNotIn("prune_dangling_images", script)
        self.assertNotIn("docker image rm", script)
        self.assertIn("部署完成", script)

    def test_reports_disk_usage_after_reclaim(self):
        script = build_remote_script()

        self.assertIn("docker system df", script)

    def test_disk_report_cannot_fail_the_deploy(self):
        """`docker system df` 曾经裸跑，把已健康的部署改成了非零退出。"""
        script = build_remote_script()

        self.assertIn("docker system df || printf", script)

    def test_reclaim_is_guarded_against_an_empty_dangling_list(self):
        """没有悬空镜像时 `docker image rm` 不能拿到空参数。"""
        script = build_remote_script()

        self.assertIn('if [ -z "$ids" ]', script)


class DeployVpsImageReclaimShellTest(unittest.TestCase):
    """把回收片段真的跑一遍（docker 打桩）。

    两个只能靠真跑拦住的回归：
    · 退出码：`docker system df` 曾把整段收尾变成非零退出，于是一个已经完全
      健康的部署会被报成失败；
    · shell 语义：部署脚本由服务器上的登录 shell 执行（这台机器是 zsh），而
      `for id in $ids` 在 zsh 下不做词分割——循环只跑一次、$id 是整段多行
      字符串，一个镜像都删不掉，日志却看着像「保留了一版」。本地只有 bash
      时这个问题永远不出现，所以下面按 bash / zsh 各跑一遍。
    """

    def run_block(
        self,
        dangling: str = "",
        keep_spare: int = PRUNE_KEEP_SPARE,
        docker_exit: int = 0,
        rm_conflict: str = "",
        shell: str = "bash",
    ) -> tuple[subprocess.CompletedProcess, str]:
        with tempfile.TemporaryDirectory() as tmp:
            bin_dir = Path(tmp) / "bin"
            bin_dir.mkdir()
            calls = Path(tmp) / "calls"
            stub = bin_dir / "docker"
            stub.write_text(
                f'''#!/usr/bin/env bash

echo "docker $*" >> "{calls}"
if [ {docker_exit} -ne 0 ]; then
  echo "Cannot connect to the Docker daemon" >&2
  exit {docker_exit}
fi
case "$1 $2" in
  "images -f")
    if [ -n "{dangling}" ]; then printf '%s\\n' {dangling}; fi
    ;;
  "image rm")
    if [ "{rm_conflict}" = "$3" ]; then echo "conflict" >&2; exit 1; fi
    echo "Untagged: $3"
    ;;
  "system df") echo "TYPE TOTAL" ;;
esac
'''
            )
            stub.chmod(0o755)

            script = Path(tmp) / "prune.sh"
            script.write_text(
                "set -euo pipefail\n" + build_prune_block(keep_spare) + "\n"
            )
            env = {**os.environ, "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}"}
            result = subprocess.run(
                [shell, str(script)],
                capture_output=True,
                text=True,
                env=env,
                check=False,
            )
            return result, calls.read_text() if calls.exists() else ""

    def test_keeps_the_newest_and_reclaims_the_rest(self):
        result, calls = self.run_block(dangling="aaaa1111 bbbb2222 cccc3333")

        self.assertEqual(result.returncode, 0)
        self.assertIn("保留上一版镜像备回滚：aaaa1111", result.stdout)
        self.assertNotIn("image rm aaaa1111", calls)
        self.assertIn("image rm bbbb2222", calls)
        self.assertIn("image rm cccc3333", calls)

    def test_reclaims_the_same_way_under_the_login_shell(self):
        """部署脚本由服务器登录 shell 执行，行为必须与 bash 完全一致。

        zsh 不对未加引号的参数展开做词分割，`for id in $ids` 会静默退化成
        「只迭代一次」——所以这里逐行读的写法要两个 shell 都验。
        """
        shells = installed_shells()
        self.assertIn("bash", shells)
        for shell in shells:
            with self.subTest(shell=shell):
                result, calls = self.run_block(
                    dangling="aaaa1111 bbbb2222 cccc3333", shell=shell
                )

                self.assertEqual(result.returncode, 0)
                self.assertIn("保留上一版镜像备回滚：aaaa1111", result.stdout)
                self.assertNotIn("image rm aaaa1111", calls)
                self.assertIn("image rm bbbb2222", calls)
                self.assertIn("image rm cccc3333", calls)
                self.assertNotIn("aaaa1111 bbbb2222", result.stdout)

    def test_does_nothing_without_dangling_images(self):
        result, calls = self.run_block()

        self.assertEqual(result.returncode, 0)
        self.assertIn("没有悬空镜像可回收", result.stdout)
        self.assertNotIn("image rm", calls)

    def test_clears_everything_when_spare_is_zero(self):
        _, calls = self.run_block(dangling="aaaa1111 bbbb2222", keep_spare=0)

        self.assertIn("image rm aaaa1111", calls)
        self.assertIn("image rm bbbb2222", calls)

    def test_a_failing_delete_does_not_stop_the_rest(self):
        result, calls = self.run_block(
            dangling="aaaa1111 bbbb2222 cccc3333", rm_conflict="bbbb2222"
        )

        self.assertEqual(result.returncode, 0)
        self.assertIn("回收失败，跳过", result.stderr)
        self.assertIn("image rm cccc3333", calls)

    def test_a_dead_docker_daemon_still_exits_zero(self):
        """docker 完全连不上时，部署已经成功了，收尾不许改它的退出码。"""
        result, _ = self.run_block(docker_exit=1)

        self.assertEqual(result.returncode, 0)
        self.assertIn("读取悬空镜像列表失败", result.stderr)
        self.assertNotIn("没有悬空镜像可回收", result.stdout)


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
