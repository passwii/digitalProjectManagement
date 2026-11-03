import os
import re
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
    PRUNE_KEEP_SPARE,
    REQUIRED_ENV_CHECKS,
    SSH_PROBE_TIMEOUT,
    VPS_HOST_V4,
    VPS_HOST_V6,
    VPS_HOSTS,
    build_env_check_block,
    build_prune_block,
    build_remote_script as _build_remote_script,
    build_ssh_command,
    describe_host,
    main,
    probe_host,
    select_host,
    ssh_ready,
    tcp_port_open,
)

TEST_API_IMAGE = "ghcr.io/passwii/digitalprojectmanagement-api@sha256:" + "a" * 64
TEST_WEB_IMAGE = "ghcr.io/passwii/digitalprojectmanagement-web@sha256:" + "b" * 64
TEST_REVISION = "c" * 40


def build_remote_script(*args, **kwargs):
    kwargs.setdefault("api_image", TEST_API_IMAGE)
    kwargs.setdefault("web_image", TEST_WEB_IMAGE)
    kwargs.setdefault("expected_revision", TEST_REVISION)
    kwargs.setdefault("expected_domain", "pm.example.com")
    kwargs.setdefault("ghcr_username", "deploy-bot")
    return _build_remote_script(*args, **kwargs)


class DeployVpsScriptTest(unittest.TestCase):
    def test_remote_script_updates_main_and_rebuilds_production(self):
        script = build_remote_script()

        self.assertIn("cd /opt/pm", script)
        self.assertIn("git pull --ff-only origin main", script)
        compose = "docker compose -f docker-compose.yml -f docker-compose.prod.yml"
        self.assertIn(f"{compose} pull", script)
        self.assertIn(f"{compose} up -d --no-build --remove-orphans", script)
        self.assertNotIn(f"{compose} up -d --build", script)

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
        self.assertIn("docker compose -f a.yml up -d --no-build --remove-orphans", script)
        self.assertNotIn("opt/pm", script)

    def test_defaults_match_module_constants(self):
        # 顺序即优先级：v4 在前，v6 才是 fallback。
        self.assertEqual(VPS_HOSTS, (VPS_HOST_V4, VPS_HOST_V6))
        self.assertEqual(DEFAULT_APP_DIR, "/opt/pm")
        self.assertEqual(DEFAULT_BRANCH, "main")
        self.assertEqual(PRUNE_KEEP_SPARE, 1)
        self.assertEqual(
            DEFAULT_COMPOSE_FILES, ("docker-compose.yml", "docker-compose.prod.yml")
        )


class DeployVpsImmutableImageTest(unittest.TestCase):
    api_image = TEST_API_IMAGE
    web_image = TEST_WEB_IMAGE

    def test_remote_script_pulls_digest_images_without_building(self):
        script = build_remote_script(
            api_image=self.api_image,
            web_image=self.web_image,
            expected_revision="c" * 40,
            ghcr_username="deploy-bot",
        )
        commands = script_commands(script)
        compose = "docker compose -f docker-compose.yml -f docker-compose.prod.yml"

        self.assertIn(f"export API_IMAGE={self.api_image}", script)
        self.assertIn(f"export WEB_IMAGE={self.web_image}", script)
        login_option = "--pass" + "word-stdin"
        self.assertIn(f"docker login ghcr.io --username deploy-bot {login_option}", script)
        self.assertLess(
            _line_index(script, f"{compose} pull"),
            _line_index(script, f"{compose} up -d --no-build --remove-orphans"),
        )
        self.assertNotIn(f"{compose} up -d --build --remove-orphans", commands)
        self.assertIn('docker_config_dir="$(mktemp -d)"', script)
        self.assertIn('export DOCKER_CONFIG="$docker_config_dir"', script)
        self.assertIn("trap", script)
        self.assertNotIn("GHCR_TOKEN", script)

    def test_expected_revision_is_checked_after_pull_before_container_changes(self):
        script = build_remote_script(
            api_image=self.api_image,
            web_image=self.web_image,
            expected_revision="c" * 40,
            ghcr_username="deploy-bot",
        )
        pull_revision = _line_index(script, "git pull --ff-only origin main")
        check_revision = _line_index(script, "expected_revision=")
        pull_images = _line_index(
            script,
            "docker compose -f docker-compose.yml -f docker-compose.prod.yml pull",
        )

        self.assertLess(pull_revision, check_revision)
        self.assertLess(check_revision, pull_images)
        self.assertIn("部署中止：VPS 代码版本与本次镜像不一致", script)

    def test_revision_mismatch_stops_before_any_docker_command(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            app_dir = root / "app"
            bin_dir = root / "bin"
            app_dir.mkdir()
            bin_dir.mkdir()
            calls = root / "calls"
            (app_dir / ".env").write_text(
                "PM_DOMAIN=pm.example.com\n"
                "PM_HOST_BIND=127.0.0.1\n"
                "API_PORT_BIND=127.0.0.1\n"
                "NEXT_PUBLIC_API_BASE=https://pm.example.com/api/v1\n"
                "CORS_ORIGINS=https://pm.example.com\n",
                encoding="utf-8",
            )
            mismatched_revision = "d" * 40
            git_stub = bin_dir / "git"
            git_stub.write_text(
                f"""#!/usr/bin/env bash
echo "git $*" >> "{calls}"
if [[ "$1" == "rev-parse" && "$2" == "HEAD" ]]; then
  echo '{mismatched_revision}'
fi
""",
                encoding="utf-8",
            )
            docker_stub = bin_dir / "docker"
            docker_stub.write_text(
                f"""#!/usr/bin/env bash
echo "docker $*" >> "{calls}"
exit 99
""",
                encoding="utf-8",
            )
            git_stub.chmod(0o755)
            docker_stub.chmod(0o755)

            script_path = root / "deploy.sh"
            script_path.write_text(
                build_remote_script(
                    api_image=self.api_image,
                    web_image=self.web_image,
                    expected_revision=TEST_REVISION,
                    ghcr_username="deploy-bot",
                    app_dir=str(app_dir),
                ),
                encoding="utf-8",
            )
            env = {
                **os.environ,
                "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}",
            }
            result = subprocess.run(
                ["bash", str(script_path)],
                capture_output=True,
                text=True,
                env=env,
                check=False,
            )
            command_log = calls.read_text(encoding="utf-8")

        self.assertEqual(result.returncode, 1)
        self.assertIn("部署中止：VPS 代码版本与本次镜像不一致", result.stderr)
        self.assertNotIn("docker ", command_log)

    def test_domain_mismatch_stops_before_git_pull_or_docker(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            app_dir = root / "app"
            bin_dir = root / "bin"
            app_dir.mkdir()
            bin_dir.mkdir()
            calls = root / "calls"
            (app_dir / ".env").write_text(
                "PM_DOMAIN=pm.example.com\n"
                "PM_HOST_BIND=127.0.0.1\n"
                "API_PORT_BIND=127.0.0.1\n"
                "NEXT_PUBLIC_API_BASE=https://pm.example.com/api/v1\n"
                "CORS_ORIGINS=https://pm.example.com\n",
                encoding="utf-8",
            )
            git_stub = bin_dir / "git"
            git_stub.write_text(
                f"""#!/usr/bin/env bash
echo "git $*" >> "{calls}"
if [[ "$1" == "status" ]]; then exit 0; fi
exit 0
""",
                encoding="utf-8",
            )
            docker_stub = bin_dir / "docker"
            docker_stub.write_text(
                f"""#!/usr/bin/env bash
echo "docker $*" >> "{calls}"
exit 99
""",
                encoding="utf-8",
            )
            git_stub.chmod(0o755)
            docker_stub.chmod(0o755)

            script_path = root / "deploy.sh"
            script_path.write_text(
                build_remote_script(
                    api_image=self.api_image,
                    web_image=self.web_image,
                    expected_revision=TEST_REVISION,
                    expected_domain="oa.example.com",
                    ghcr_username="deploy-bot",
                    app_dir=str(app_dir),
                ),
                encoding="utf-8",
            )
            env = {
                **os.environ,
                "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}",
            }
            result = subprocess.run(
                ["bash", str(script_path)],
                capture_output=True,
                text=True,
                env=env,
                check=False,
            )
            command_log = calls.read_text(encoding="utf-8")

        self.assertEqual(result.returncode, 1)
        self.assertIn("部署中止：Actions PM_DOMAIN 与 VPS .env PM_DOMAIN 不一致", result.stderr)
        self.assertNotIn("git pull", command_log)
        self.assertNotIn("docker ", command_log)

    def test_rejects_invalid_image_digest_before_host_probe(self):
        with mock.patch.dict(
            os.environ,
            {"GHCR_TOKEN": "x" * 40, "GITHUB_ACTOR": "deploy-bot"},
        ), mock.patch("scripts.deploy_vps.select_host") as select_host:
            result = main(
                [
                    "--api-image",
                    "ghcr.io/passwii/api:latest",
                    "--web-image",
                    self.web_image,
                    "--expected-revision",
                    "c" * 40,
                ]
            )

        self.assertEqual(result, 2)
        select_host.assert_not_called()

    def test_rejects_images_from_different_projects_before_host_probe(self):
        with mock.patch.dict(
            os.environ,
            {"GHCR_TOKEN": "x" * 40, "GITHUB_ACTOR": "deploy-bot"},
        ), mock.patch("scripts.deploy_vps.select_host") as select_host:
            result = main(
                [
                    "--api-image",
                    self.api_image,
                    "--web-image",
                    "ghcr.io/another/project-web@sha256:" + "b" * 64,
                    "--expected-revision",
                    TEST_REVISION,
                ]
            )

        self.assertEqual(result, 2)
        select_host.assert_not_called()

    def test_requires_registry_token_before_host_probe(self):
        with mock.patch.dict(
            os.environ, {"GITHUB_ACTOR": "deploy-bot"}, clear=True
        ), mock.patch("scripts.deploy_vps.select_host") as select_host:
            result = main(
                [
                    "--api-image",
                    self.api_image,
                    "--web-image",
                    self.web_image,
                    "--expected-revision",
                    TEST_REVISION,
                    "--expected-domain",
                    "pm.example.com",
                ]
            )

        self.assertEqual(result, 2)
        select_host.assert_not_called()

    def test_registry_token_is_sent_to_ssh_stdin_not_remote_command(self):
        import io
        from contextlib import redirect_stdout

        token = "x" * 40
        with mock.patch.dict(
            os.environ,
            {"GHCR_TOKEN": token, "GITHUB_ACTOR": "deploy-bot"},
        ), mock.patch("scripts.deploy_vps.select_host", return_value=VPS_HOST_V6), mock.patch(
            "scripts.deploy_vps.subprocess.run",
            return_value=subprocess.CompletedProcess([], 0, "", ""),
        ) as run, redirect_stdout(io.StringIO()):
            result = main(
                [
                    "--api-image",
                    self.api_image,
                    "--web-image",
                    self.web_image,
                    "--expected-revision",
                    TEST_REVISION,
                    "--expected-domain",
                    "pm.example.com",
                ]
            )

        self.assertEqual(result, 0)
        self.assertNotIn(token, run.call_args.args[0][-1])
        self.assertEqual(run.call_args.kwargs["input"], token + "\n")
        self.assertTrue(run.call_args.kwargs["text"])


class DeployVpsWorkflowContractTest(unittest.TestCase):
    """The production workflow must stay behind main and use the guarded deployer."""

    workflow_path = ROOT / ".github" / "workflows" / "deploy-vps.yml"
    production_compose_path = ROOT / "docker-compose.prod.yml"

    def read_workflow(self) -> str:
        self.assertTrue(self.workflow_path.is_file(), "production deploy workflow is missing")
        return self.workflow_path.read_text(encoding="utf-8")

    def test_workflow_runs_only_for_main_updates_or_manual_dispatch(self):
        workflow = self.read_workflow()

        self.assertRegex(
            workflow,
            r"(?m)^on:\n  push:\n    branches: \[main\]\n  workflow_dispatch:\s*$",
        )
        self.assertNotRegex(workflow, r"(?m)^\s*pull_request:")
        self.assertIn('EVENT_REF" != "refs/heads/main"', workflow)

    def test_workflow_scopes_registry_permissions_per_job(self):
        workflow = self.read_workflow()

        self.assertIn("packages: write", workflow)
        self.assertIn("packages: read", workflow)
        self.assertIn("needs: [validate, build]", workflow)
        self.assertIn(
            "concurrency:\n  group: production-vps-deploy\n  cancel-in-progress: false",
            workflow,
        )
        self.assertIn("environment: production", workflow)
        self.assertIn("secrets.VPS_SSH_PRIVATE_KEY", workflow)
        self.assertIn("secrets.VPS_SSH_KNOWN_HOSTS", workflow)
        self.assertIn("StrictHostKeyChecking yes", workflow)
        self.assertIn("GHCR_TOKEN: ${{ secrets.GITHUB_TOKEN }}", workflow)
        self.assertIn("GHCR_USERNAME: ${{ github.actor }}", workflow)
        self.assertIn("!cancelled()", workflow)
        self.assertNotIn("always()", workflow)

    def test_workflow_builds_and_deploys_digest_pinned_images(self):
        workflow = self.read_workflow()

        self.assertIn("python3 scripts/deploy_vps.py", workflow)
        self.assertIn("steps.api.outputs.digest", workflow)
        self.assertIn("steps.web.outputs.digest", workflow)
        self.assertIn("needs.build.outputs.api_image", workflow)
        self.assertIn("needs.build.outputs.web_image", workflow)
        self.assertIn("--expected-revision", workflow)
        self.assertIn("--expected-domain", workflow)
        self.assertIn("pm_domain: ${{ steps.request.outputs.pm_domain }}", workflow)
        self.assertIn("PM_DOMAIN: ${{ vars.PM_DOMAIN }}", workflow)
        self.assertIn(
            "NEXT_PUBLIC_API_BASE=https://${{ needs.validate.outputs.pm_domain }}/api/v1",
            workflow,
        )
        self.assertIn("cache-to: type=gha", workflow)

    def test_manual_rollback_requires_both_local_ghcr_digest_inputs(self):
        workflow = self.read_workflow()

        self.assertIn("api_image:", workflow)
        self.assertIn("web_image:", workflow)
        self.assertIn("mode=rollback", workflow)
        self.assertIn("mode=build", workflow)
        self.assertIn("inputs.api_image", workflow)
        self.assertIn("inputs.web_image", workflow)
        self.assertIn("github.repository", workflow)

    def test_all_external_actions_are_pinned_to_commit_shas(self):
        workflow = self.read_workflow()
        actions = re.findall(r"(?m)^\s*uses:\s*[^@\s]+@([^\s#]+)", workflow)

        self.assertTrue(actions, "workflow must use pinned external actions")
        self.assertTrue(all(re.fullmatch(r"[0-9a-f]{40}", ref) for ref in actions), actions)

    def test_production_compose_requires_registry_images_and_disables_build(self):
        compose = self.production_compose_path.read_text(encoding="utf-8")

        self.assertIn('image: "${API_IMAGE:?API_IMAGE must be set}"', compose)
        self.assertIn('image: "${WEB_IMAGE:?WEB_IMAGE must be set}"', compose)
        self.assertEqual(compose.count("build: !reset null"), 2)


class ContainerImagesWorkflowContractTest(unittest.TestCase):
    workflow_path = ROOT / ".github" / "workflows" / "container-images.yml"

    def test_pull_request_builds_both_images_without_publishing_or_deploying(self):
        self.assertTrue(self.workflow_path.is_file(), "container image workflow is missing")
        workflow = self.workflow_path.read_text(encoding="utf-8")

        self.assertRegex(workflow, r"(?m)^on:\n  pull_request:")
        self.assertIn("docker/api.Dockerfile", workflow)
        self.assertIn("docker/web.Dockerfile", workflow)
        self.assertGreaterEqual(workflow.count("docker/build-push-action@"), 2)
        self.assertEqual(workflow.count("push: false"), 2)
        self.assertNotIn("packages: write", workflow)
        self.assertNotIn("VPS_SSH_PRIVATE_KEY", workflow)
        self.assertNotIn("scripts/deploy_vps.py", workflow)
        self.assertIn("NEXT_PUBLIC_API_BASE=https://build.invalid/api/v1", workflow)
        self.assertIn('"docker-compose.yml"', workflow)
        self.assertIn("config --format json", workflow)

    def test_all_external_actions_are_pinned_to_commit_shas(self):
        self.assertTrue(self.workflow_path.is_file(), "container image workflow is missing")
        workflow = self.workflow_path.read_text(encoding="utf-8")
        actions = re.findall(r"(?m)^\s*uses:\s*[^@\s]+@([^\s#]+)", workflow)

        self.assertTrue(actions, "workflow must use pinned external actions")
        self.assertTrue(all(re.fullmatch(r"[0-9a-f]{40}", ref) for ref in actions), actions)


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
    """部署收尾只回收本项目 GHCR 镜像，不碰其他栈或构建缓存。"""

    def test_lists_digest_images_from_only_the_api_and_web_repositories(self):
        script = build_remote_script()

        self.assertIn("docker image ls --digests --format", script)
        self.assertIn(
            "prune_repository_images ghcr.io/passwii/digitalprojectmanagement-api", script
        )
        self.assertIn(
            "prune_repository_images ghcr.io/passwii/digitalprojectmanagement-web", script
        )
        self.assertIn('docker image rm "$image"', script)
        self.assertIn('case "$image" in "$repo"@sha256:*)', script)

    def test_does_not_prune_vps_build_cache_or_other_stacks(self):
        commands = script_commands(build_remote_script())

        for forbidden in (
            "builder prune",
            "image prune",
            "system prune",
            "volume prune",
        ):
            self.assertFalse(
                [cmd for cmd in commands if forbidden in cmd], f"{forbidden}: {commands}"
            )

    def test_reclaim_runs_after_health_checks(self):
        script = build_remote_script()
        last_health = script.rindex("wait_for_health \"http://127.0.0.1:3001/\"")

        self.assertGreater(script.index("prune_repository_images"), last_health)

    def test_reclaim_failures_do_not_fail_a_healthy_deploy(self):
        script = build_remote_script()

        self.assertIn("警告：本项目镜像回收失败，本次部署不受影响", script)
        self.assertIn('docker image rm "$image" >/dev/null 2>&1', script)

    def test_reclaim_can_be_disabled_for_diagnostics(self):
        script = build_remote_script(prune_spare=None)

        self.assertNotIn("prune_repository_images", script)
        self.assertNotIn("docker image rm", script)
        self.assertIn("部署完成", script)

    def test_reports_disk_usage_without_making_it_a_deploy_gate(self):
        script = build_remote_script()

        self.assertIn("docker system df || printf", script)

    def test_current_and_previous_digests_are_protected(self):
        script = build_remote_script()

        self.assertIn('"$image" = "$keep_current"', script)
        self.assertIn('"$image" = "$keep_previous"', script)

    def test_zero_spares_still_protects_the_current_digest(self):
        script = build_remote_script(prune_spare=0)

        self.assertIn('"$image" = "$keep_current"', script)
        self.assertIn(
            "digitalprojectmanagement-api@sha256:" + "a" * 64 + " ''", script
        )
        self.assertIn(
            "digitalprojectmanagement-web@sha256:" + "b" * 64 + " ''", script
        )


class DeployVpsImageReclaimShellTest(unittest.TestCase):
    """把仓库范围镜像回收真跑一遍，并覆盖 Bash 与 VPS 登录 shell。"""

    api_repo = "ghcr.io/passwii/digitalprojectmanagement-api"
    web_repo = "ghcr.io/passwii/digitalprojectmanagement-web"
    current_api = api_repo + "@sha256:" + "a" * 64
    previous_api = api_repo + "@sha256:" + "b" * 64
    older_api = api_repo + "@sha256:" + "c" * 64
    current_web = web_repo + "@sha256:" + "d" * 64
    previous_web = web_repo + "@sha256:" + "e" * 64
    older_web = web_repo + "@sha256:" + "f" * 64

    def run_block(
        self,
        api_images: str = "",
        web_images: str = "",
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
                f"""#!/usr/bin/env bash

echo "docker $*" >> "{calls}"
if [ {docker_exit} -ne 0 ]; then
  echo "Cannot connect to the Docker daemon" >&2
  exit {docker_exit}
fi
case "$1 $2" in
  "image ls")
    case "$6" in
      "$API_REPO") printf '%s\\n' "$API_IMAGES" ;;
      "$WEB_REPO") printf '%s\\n' "$WEB_IMAGES" ;;
    esac
    ;;
  "image rm")
    if [ "{rm_conflict}" = "$3" ]; then echo "conflict" >&2; exit 1; fi
    echo "Untagged: $3"
    ;;
  "system df") echo "TYPE TOTAL" ;;
esac
"""
            )
            stub.chmod(0o755)

            script = Path(tmp) / "prune.sh"
            script.write_text(
                "set -euo pipefail\n"
                + build_prune_block(
                    keep_spare,
                    self.current_api,
                    self.current_web,
                    self.previous_api,
                    self.previous_web,
                )
                + "\n"
            )
            env = {
                **os.environ,
                "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}",
                "API_REPO": self.api_repo,
                "WEB_REPO": self.web_repo,
                "API_IMAGES": api_images,
                "WEB_IMAGES": web_images,
            }
            result = subprocess.run(
                [shell, str(script)],
                capture_output=True,
                text=True,
                env=env,
                check=False,
            )
            return result, calls.read_text() if calls.exists() else ""

    def test_keeps_current_and_previous_and_removes_only_older_images(self):
        result, calls = self.run_block(
            api_images="\n".join(
                (self.current_api, self.previous_api, self.older_api)
            ),
            web_images="\n".join(
                (self.current_web, self.previous_web, self.older_web)
            ),
        )

        self.assertEqual(result.returncode, 0)
        self.assertNotIn(f"image rm {self.current_api}", calls)
        self.assertNotIn(f"image rm {self.previous_api}", calls)
        self.assertIn(f"image rm {self.older_api}", calls)
        self.assertNotIn(f"image rm {self.current_web}", calls)
        self.assertNotIn(f"image rm {self.previous_web}", calls)
        self.assertIn(f"image rm {self.older_web}", calls)

    def test_has_the_same_line_by_line_behavior_under_login_shell(self):
        shells = installed_shells()
        self.assertIn("bash", shells)
        for shell in shells:
            with self.subTest(shell=shell):
                result, calls = self.run_block(
                    api_images="\n".join(
                        (self.current_api, self.previous_api, self.older_api)
                    ),
                    web_images="\n".join(
                        (self.current_web, self.previous_web, self.older_web)
                    ),
                    shell=shell,
                )
                self.assertEqual(result.returncode, 0)
                self.assertIn(f"image rm {self.older_api}", calls)
                self.assertIn(f"image rm {self.older_web}", calls)
                self.assertNotIn(f"image rm {self.current_api}", calls)

    def test_does_nothing_when_no_digest_images_exist(self):
        result, calls = self.run_block()

        self.assertEqual(result.returncode, 0)
        self.assertIn("没有本项目镜像需要回收", result.stdout)
        self.assertNotIn("image rm", calls)

    def test_zero_spares_removes_previous_but_keeps_current(self):
        _, calls = self.run_block(
            api_images="\n".join(
                (self.current_api, self.previous_api, self.older_api)
            ),
            web_images="\n".join(
                (self.current_web, self.previous_web, self.older_web)
            ),
            keep_spare=0,
        )

        self.assertNotIn(f"image rm {self.current_api}", calls)
        self.assertIn(f"image rm {self.previous_api}", calls)
        self.assertIn(f"image rm {self.older_api}", calls)
        self.assertNotIn(f"image rm {self.current_web}", calls)
        self.assertIn(f"image rm {self.previous_web}", calls)
        self.assertIn(f"image rm {self.older_web}", calls)

    def test_a_failing_delete_does_not_stop_other_image_cleanup(self):
        result, calls = self.run_block(
            api_images="\n".join(
                (self.current_api, self.previous_api, self.older_api)
            ),
            web_images="\n".join(
                (self.current_web, self.previous_web, self.older_web)
            ),
            rm_conflict=self.older_api,
        )

        self.assertEqual(result.returncode, 0)
        self.assertIn("回收失败，跳过", result.stderr)
        self.assertIn(f"image rm {self.older_web}", calls)

    def test_unavailable_docker_daemon_does_not_fail_completed_deploy(self):
        result, _ = self.run_block(docker_exit=1)

        self.assertEqual(result.returncode, 0)
        self.assertIn("读取镜像列表失败", result.stderr)
        self.assertNotIn("没有本项目镜像需要回收", result.stdout)


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

        with mock.patch.dict(
            os.environ, {"GHCR_TOKEN": "x" * 40, "GITHUB_ACTOR": "deploy-bot"}
        ), mock.patch(
            "scripts.deploy_vps.select_host", return_value=VPS_HOST_V6
        ) as picker, mock.patch("scripts.deploy_vps.subprocess.run") as run, redirect_stdout(
            io.StringIO()
        ):
            code = main(
                [
                    "--api-image",
                    TEST_API_IMAGE,
                    "--web-image",
                    TEST_WEB_IMAGE,
                    "--expected-revision",
                    TEST_REVISION,
                    "--expected-domain",
                    "pm.example.com",
                ]
            )

        self.assertEqual(code, 0)
        picker.assert_called_once_with(VPS_HOSTS)
        self.assertEqual(run.call_args[0][0][-2], f"root@{VPS_HOST_V6}")

    def test_explicit_host_skips_probing(self):
        import io
        from contextlib import redirect_stdout
        from unittest import mock

        with mock.patch.dict(
            os.environ, {"GHCR_TOKEN": "x" * 40, "GITHUB_ACTOR": "deploy-bot"}
        ), mock.patch("scripts.deploy_vps.select_host") as picker, mock.patch(
            "scripts.deploy_vps.subprocess.run"
        ), redirect_stdout(io.StringIO()):
            code = main(
                [
                    "--host",
                    VPS_HOST_V6,
                    "--api-image",
                    TEST_API_IMAGE,
                    "--web-image",
                    TEST_WEB_IMAGE,
                    "--expected-revision",
                    TEST_REVISION,
                    "--expected-domain",
                    "pm.example.com",
                ]
            )

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
        with mock.patch.dict(os.environ, {"GITHUB_ACTOR": "deploy-bot"}), redirect_stdout(buffer):
            code = main(
                [
                    "--dry-run",
                    "--api-image",
                    TEST_API_IMAGE,
                    "--web-image",
                    TEST_WEB_IMAGE,
                    "--expected-revision",
                    TEST_REVISION,
                    "--expected-domain",
                    "pm.example.com",
                ]
            )

        self.assertEqual(code, 0)
        output = buffer.getvalue()
        self.assertIn("git pull --ff-only origin main", output)
        # dry-run 只列候选、不探活：无网环境（CI）下也必须能跑。
        self.assertIn(VPS_HOST_V4, output)
        self.assertIn(VPS_HOST_V6, output)


if __name__ == "__main__":
    unittest.main()
