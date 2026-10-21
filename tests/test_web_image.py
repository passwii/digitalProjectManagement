"""生产 web 镜像的产物契约。

这些断言看着琐碎，但守的是一个很贵的失败模式：standalone 产物少搬一样东西，
镜像照样能构建成功、容器照样能起来，然后在浏览器里白屏或 404。实测把
955MB 压到 162MB 靠的正是「只搬 standalone + static + public」这三件套，
所以这三条 COPY 谁删了都得在这里响。
"""

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DOCKERFILE = ROOT / "docker" / "web.Dockerfile"
NEXT_CONFIG = ROOT / "web" / "next.config.mjs"


class WebImageBuildTest(unittest.TestCase):
    def setUp(self):
        self.dockerfile = DOCKERFILE.read_text()
        # 只看真正生效的指令：注释里提到某个命令不算数（之前就被自己绊过一次）。
        self.directives = "\n".join(
            line
            for line in self.dockerfile.splitlines()
            if line.strip() and not line.lstrip().startswith("#")
        )

    def test_build_is_multi_stage(self):
        """单段构建会把 devDependencies 和 .next/cache 一起打进运行镜像。"""
        stages = re.findall(
            r"^FROM (\S+)(?: AS (\S+))?$", self.directives, re.MULTILINE
        )

        self.assertEqual([name for _, name in stages], ["builder", "runner"])
        self.assertEqual(len({image for image, _ in stages}), 1, "两段用同一个基础镜像")

    def test_runner_copies_the_three_standalone_pieces(self):
        for piece in (".next/standalone", ".next/static", "public"):
            self.assertIn(
                f"--from=builder /app/{piece}", self.directives, f"漏搬 {piece}"
            )

    def test_runner_never_copies_the_build_cache(self):
        """`.next/cache` 在生产镜像里是 214MB 的死重。"""
        self.assertNotIn("/app/.next/cache", self.directives)
        self.assertNotIn("COPY --from=builder /app /app", self.directives)

    def test_runner_starts_the_standalone_server(self):
        self.assertIn('CMD ["node", "server.js"]', self.directives)
        self.assertNotIn("next start", self.directives)

    def test_runner_listens_wildcard_and_uses_the_forwarded_host(self):
        """监听保持全网卡，代理重定向使用请求 Host（BLF-1400）。"""
        self.assertIn("ENV PORT=3001", self.directives)
        self.assertIn('ENV HOSTNAME=""', self.directives)
        next_config = NEXT_CONFIG.read_text()
        self.assertIn("trustHostHeader: true", next_config)

    def test_runner_does_not_need_root(self):
        self.assertIn("USER node", self.directives)
        self.assertEqual(self.directives.count("--chown=node:node"), 3)

    def test_next_config_only_emits_standalone_when_asked(self):
        """`next start` 与 standalone 不兼容，所以这个开关不能写死。

        本地 docker-compose.local.yml 的 web 走 `npm run build && npm run start`，
        写死会让本地开发也推上不受支持的组合。
        """
        config = NEXT_CONFIG.read_text()

        self.assertIn("NEXT_BUILD_STANDALONE", config)
        self.assertIn('? "standalone" : undefined', config)
        self.assertNotIn('output: "standalone"', config)

    def test_builder_turns_the_standalone_switch_on(self):
        """两边必须一起改：漏了开关，COPY .next/standalone 会直接构建失败。"""
        self.assertIn("ENV NEXT_BUILD_STANDALONE=1", self.directives)

    def test_builder_stage_installs_before_copying_sources(self):
        """依赖层要能在源码变动时命中缓存，否则每轮构建都重新 npm ci。"""
        npm_ci = self.directives.index("RUN npm ci")
        copy_sources = self.directives.index("COPY web ./")

        self.assertLess(npm_ci, copy_sources)


if __name__ == "__main__":
    unittest.main()
