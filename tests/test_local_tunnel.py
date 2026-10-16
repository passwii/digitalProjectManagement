"""本地开发隧道（scripts/db_tunnel.sh）的契约与行为。

守两件事：
· 候选地址列表必须与 scripts/deploy_vps.py 的 VPS_HOSTS 同步——同一台机器、
  同两条链路，两边各写一份是为了各自能在自己的运行时里用，但不能漂。
· 探活后再建隧道：机房侧 v4 出现过「22 端口收 SYN、banner 永远不来」的半死状态，
  直接连就是干等然后失败。
"""

import os
import subprocess
import tempfile
import unittest
from pathlib import Path

from scripts.deploy_vps import VPS_HOSTS

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "db_tunnel.sh"
COMPOSE = ROOT / "docker-compose.local.yml"

STUB_SSH = """#!/bin/sh
echo "$*" >> "$SSH_CALLS"
last=""
for arg in "$@"; do last="$arg"; done
if [ "$last" = "true" ]; then
  # 探活调用：host 是倒数第二个参数
  prev=""
  for arg in "$@"; do
    if [ "$last_arg" = "$arg" ]; then break; fi
    prev="$last_arg"
    last_arg="$arg"
  done
  for reachable in $SSH_REACHABLE; do
    if [ "$prev" = "$reachable" ]; then exit 0; fi
  done
  exit 255
fi
# 建隧道调用：把 user@host 里的 host 记下来再按剧本退出
for arg in "$@"; do
  case "$arg" in
    *@*) echo "TARGET=${arg#*@}" >> "$SSH_CALLS" ;;
  esac
done
exit "${SSH_TUNNEL_EXIT:-0}"
"""


class DbTunnelHostListTest(unittest.TestCase):
    def test_candidate_list_stays_in_sync_with_deploy_script(self):
        text = SCRIPT.read_text()
        default = text.split("${VPS_SSH_HOSTS:-", 1)[1].split("}", 1)[0]

        self.assertEqual(default, " ".join(VPS_HOSTS), "隧道候选地址与部署脚本漂移了")
        for host in VPS_HOSTS:
            self.assertIn(host, default)

    def test_ipv4_still_comes_first(self):
        """顺序即优先级：v4 在前，v6 才是兜底。"""
        text = SCRIPT.read_text()

        self.assertLess(text.index(VPS_HOSTS[0]), text.index(VPS_HOSTS[1]))

    def test_is_a_posix_sh_script(self):
        self.assertTrue(SCRIPT.read_text().startswith("#!/bin/sh"))

    def test_supports_both_overrides(self):
        text = SCRIPT.read_text()

        self.assertIn("${VPS_SSH_HOST:-", text)
        self.assertIn("${VPS_SSH_HOSTS:-", text)
        self.assertIn("${VPS_SSH_USER:-", text)


class DbTunnelProbeTest(unittest.TestCase):
    def setUp(self):
        self.text = SCRIPT.read_text()

    def test_probes_before_opening_the_tunnel(self):
        probe = self.text.index('"$host" true')
        tunnel = self.text.index("exec ssh -N")

        self.assertLess(probe, tunnel, "必须先探活再建隧道")

    def test_probe_uses_the_same_criteria_as_the_deploy_script(self):
        """只看端口会漏掉 banner 不来的半死链路，必须是真握手。"""
        probe = self.text[self.text.index("if ssh") : self.text.index('"$host" true')]

        self.assertIn("BatchMode=yes", probe)
        self.assertIn("ConnectTimeout=", probe)

    def test_tunnel_keeps_forward_and_keepalive(self):
        for expected in (
            "-L 0.0.0.0:5432:127.0.0.1:5432",
            "ExitOnForwardFailure=yes",
            "ServerAliveInterval=15",
            "ServerAliveCountMax=3",
        ):
            self.assertIn(expected, self.text)

    def test_falls_back_to_the_first_host_when_nothing_answers(self):
        """全都不通时不能空转：先顶着，交给 restart 策略重试。"""
        self.assertIn('${HOSTS%% *}', self.text)


class DbTunnelShellTest(unittest.TestCase):
    """把脚本真的跑一遍（ssh 打桩），验证选路结果。"""

    def run_script(self, reachable="", **env_overrides):
        with tempfile.TemporaryDirectory() as tmp:
            bin_dir = Path(tmp) / "bin"
            bin_dir.mkdir()
            stub = bin_dir / "ssh"
            stub.write_text(STUB_SSH)
            stub.chmod(0o755)
            calls = Path(tmp) / "calls"
            calls.touch()

            env = {
                **os.environ,
                "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}",
                "SSH_CALLS": str(calls),
                "SSH_REACHABLE": reachable,
                **env_overrides,
            }
            result = subprocess.run(
                ["sh", str(SCRIPT)], capture_output=True, text=True, env=env, check=False
            )
            return result, calls.read_text()

    def test_prefers_ipv4_when_reachable(self):
        result, calls = self.run_script(reachable=VPS_HOSTS[0])

        self.assertIn(f"TARGET={VPS_HOSTS[0]}", calls)
        self.assertNotIn(f"TARGET={VPS_HOSTS[1]}", calls)
        self.assertEqual(result.returncode, 0)

    def test_falls_back_to_ipv6_when_ipv4_is_half_dead(self):
        """v4 探活失败 → 自动换 v6 建隧道。"""
        result, calls = self.run_script(reachable=VPS_HOSTS[1])

        self.assertIn(f"TARGET={VPS_HOSTS[1]}", calls)
        self.assertIn("隧道目标", result.stderr)
        self.assertEqual(result.returncode, 0)

    def test_explicit_host_skips_the_other_candidates(self):
        _, calls = self.run_script(reachable=VPS_HOSTS[1], VPS_SSH_HOST=VPS_HOSTS[0])

        self.assertIn(f"TARGET={VPS_HOSTS[0]}", calls)
        self.assertNotIn(VPS_HOSTS[1], calls)

    def test_uses_the_first_host_as_last_resort(self):
        """两条都不通：用第一个顶着，并以非零退出让 restart 策略接手。"""
        result, calls = self.run_script(reachable="", SSH_TUNNEL_EXIT="255")

        self.assertIn(f"TARGET={VPS_HOSTS[0]}", calls)
        self.assertIn("都握不上手", result.stderr)
        self.assertNotEqual(result.returncode, 0)

    def test_host_list_override_is_respected(self):
        _, calls = self.run_script(
            reachable="10.9.9.9", VPS_SSH_HOSTS="10.9.9.9 10.8.8.8"
        )

        self.assertIn("TARGET=10.9.9.9", calls)
        self.assertNotIn(VPS_HOSTS[0], calls)


class LocalComposeWiringTest(unittest.TestCase):
    def setUp(self):
        self.compose = COMPOSE.read_text()

    def test_runs_the_script_through_an_explicit_shell(self):
        """登录 shell 与脚本语义不一致会静默出错（悬空镜像回收踩过）。"""
        self.assertIn('command: ["sh", "/scripts/db_tunnel.sh"]', self.compose)

    def test_mounts_the_script_read_only(self):
        self.assertIn("./scripts/db_tunnel.sh:/scripts/db_tunnel.sh:ro", self.compose)

    def test_passes_the_overrides_through(self):
        for name in ("VPS_SSH_USER", "VPS_SSH_HOST", "VPS_SSH_HOSTS"):
            self.assertIn(f"{name}: \"${{{name}:-}}\"", self.compose)

    def test_keeps_the_healthcheck_and_restart_policy(self):
        self.assertIn("nc -z 127.0.0.1 5432", self.compose)
        self.assertIn("restart: unless-stopped", self.compose)


if __name__ == "__main__":
    unittest.main()
