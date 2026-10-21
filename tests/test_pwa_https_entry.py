"""生产 HTTPS 入口契约（BLF-1400）。

守的是一件事：**PWA 能装成真应用**。

背景 —— 实测（Chrome 140，非 localhost 的 HTTP 源）：

    isSecureContext        = false
    navigator.serviceWorker = undefined   ← Chrome 直接把 SW API 屏蔽
    installability_errors  = not-from-secure-origin

Chrome 只在**安全上下文**里给 service worker API。没有安全上下文就没有 SW，
Chrome 拿不到 WebAPK（装机时要向 Google 的 minting 服务申请一个签名的 APK），
只能降级成「快捷方式」安装 —— 主屏幕图标右下角挂一个 **Chrome 徽标**，
而且装出来的不是真应用：没有应用抽屉入口、没有独立包名、站内链接被别的
应用点开会落回浏览器。

这类退化是**静默**的：站点能访问、图标能显示、Lighthouse 全绿，只有装机
方式不对。所以这里把「生产必须有 HTTPS 入口」「明文端口不能暴露公网」
写成断言，而不是靠人记得。

⚠️ 为什么用「读文件 + 断言文本」而不是真起容器：
    · 真起 compose 要构建镜像、跑迁移，几分钟起步，CI 跑不起；
    · 而且**要断言的恰恰是"配置成什么样"**，不是"跑起来是什么行为"；
    · 端到端行为由 scripts/acceptance_blf1127_mobile.py 在真浏览器里验。
"""

from __future__ import annotations

import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(relative: str) -> str:
    return (ROOT / relative).read_text(encoding="utf-8")


class PwaHttpsEntryTest(unittest.TestCase):
    """宿主机 Caddy 提供 HTTPS，web/api 容器明文端口只听回环。"""

    def test_prod_uses_the_host_caddy_without_claiming_public_ports(self):
        prod = read("docker-compose.prod.yml")

        self.assertIn("宿主机 Caddy", prod)
        self.assertNotIn("caddy:", prod)
        self.assertNotIn('"80:80"', prod)
        self.assertNotIn('"443:443"', prod)

    def test_web_and_api_ports_are_bound_by_a_variable(self):
        """web / api 的宿主机绑定地址必须**可被 prod 收回到回环**。

        为什么用变量而不是写死字面量：compose 合并多个文件时 ports 是
        **去重合并**，不是替换。两个文件写同一条插值表达式 → 合并后只有一条；
        写成不同的字面量 → base 的那条被**追加**在后面，最终 3001 同时绑
        0.0.0.0 与 127.0.0.1，公网照样能明文访问，修复静默失效。
        """
        base = read("docker-compose.yml")
        prod = read("docker-compose.prod.yml")

        self.assertIn('"${PM_HOST_BIND:-0.0.0.0}:3001:3001"', base)
        self.assertIn('"${PM_HOST_BIND:-0.0.0.0}:3001:3001"', prod)
        self.assertIn('"${API_PORT_BIND:-0.0.0.0}:8001:8001"', base)
        self.assertIn('"${API_PORT_BIND:-0.0.0.0}:8001:8001"', prod)

    def test_prod_never_binds_web_or_api_to_all_interfaces(self):
        """prod 里不允许出现裸的 "3001:3001" / "8001:8001"（= 全网可达）。

        只看 **YAML 的实际值**，不看注释：注释里为了说明历史经常要写出
        "以前是 3001:3001" 这类字样，那是叙述，不是配置。
        """
        prod = read("docker-compose.prod.yml")
        # 取每行去掉行首空白后的内容，再滤掉以 # 开头的注释行。
        code_lines = [
            line.strip()
            for line in prod.splitlines()
            if line.strip() and not line.strip().startswith("#")
        ]
        code = "\n".join(code_lines)

        for leaked in ('"3001:3001"', '"8001:8001"', "'3001:3001'", "'8001:8001'"):
            self.assertNotIn(
                leaked,
                code,
                f"prod 里出现了 {leaked}：那会让明文端口暴露公网，"
                "PWA 又会退化成带 Chrome 徽标的快捷方式",
            )

    def test_api_base_points_at_the_https_entry(self):
        """前端构建期编进去的 API 基址必须与访问入口同源。"""
        prod = read("docker-compose.prod.yml")

        self.assertIn("https://${PM_DOMAIN}", prod)

    def test_cors_origins_points_at_the_https_entry(self):
        """跨域白名单要写**对外的**源（浏览器发的 Origin 不长容器里的样子）。"""
        prod = read("docker-compose.prod.yml")

        self.assertIn("CORS_ORIGINS", prod)
        self.assertIn('"${CORS_ORIGINS:-https://${PM_DOMAIN}}"', prod)

    def test_deploy_script_rejects_insecure_bind_and_api_values(self):
        from scripts.deploy_vps import build_env_check_block

        block = build_env_check_block()
        self.assertIn('check_env "PM_HOST_BIND"', block)
        self.assertIn('check_env "API_PORT_BIND"', block)
        self.assertIn('check_env "NEXT_PUBLIC_API_BASE"', block)
        self.assertIn('check_env "CORS_ORIGINS"', block)
        self.assertIn("https://$domain/api/v1", block)
        self.assertIn('"$expected"', block)

    def test_deploy_script_refuses_to_deploy_without_https_prereqs(self):
        """部署前必须校验 HTTPS 前置条件（配错的后果是静默的）。"""
        from scripts.deploy_vps import (  # noqa: PLC0415
            REQUIRED_ENV_CHECKS,
            build_remote_script,
        )

        script = build_remote_script()
        for name, _ in REQUIRED_ENV_CHECKS:
            self.assertIn(f'check_env "{name}"', script)
        # 校验必须早于容器操作。
        self.assertLess(
            script.index('check_env "PM_DOMAIN"'),
            script.index("docker compose -f docker-compose.yml"),
        )


class PwaManifestContractTest(unittest.TestCase):
    """PWA 清单本身必须始终合规（这次的问题不在这里，但不能因此放松）。"""

    def test_all_three_manifests_declare_the_required_icons(self):
        """三份清单都要有 192 / 512 / maskable 三档图标。"""
        root_manifest = read("web/app/manifest.webmanifest/route.ts")
        shared_manifest = read("web/lib/pwaManifest.ts")
        middleware = read("web/middleware.ts")
        for path, source in (
            ("root manifest", root_manifest),
            ("shared site manifests", shared_manifest),
        ):
            self.assertIn("icon-192.png", source, f"{path} 缺 192 图标")
            self.assertIn("icon-512.png", source, f"{path} 缺 512 图标")
            self.assertIn("icon-512-maskable.png", source, f"{path} 缺 maskable 图标")
            self.assertIn('"maskable"', source, f"{path} 缺 maskable 用途声明")
        self.assertIn("SPARK_PWA_MANIFEST", middleware)
        self.assertIn("STREAM_MONITOR_PWA_MANIFEST", middleware)

    def test_site_manifests_are_served_by_middleware_not_public_files(self):
        """站点清单由 middleware 直接返回，避免动态 section 页面先匹配。"""
        middleware = read("web/middleware.ts")
        self.assertIn('pathname === "/spark/manifest.webmanifest"', middleware)
        self.assertIn('pathname === "/stream-monitor/manifest.webmanifest"', middleware)
        self.assertIn('"Content-Type": "application/manifest+json"', middleware)
        shared = read("web/lib/pwaManifest.ts")
        self.assertIn("export const SPARK_PWA_MANIFEST", shared)
        self.assertIn("export const STREAM_MONITOR_PWA_MANIFEST", shared)
        for site in ("spark", "stream-monitor"):
            public_copy = ROOT / f"web/public/{site}/manifest.webmanifest"
            self.assertFalse(public_copy.exists())

    def test_site_manifest_has_no_stale_route_handlers(self):
        """站点清单由 middleware 直接返回，不需要同级的 route handler。"""
        for site in ("spark", "stream-monitor"):
            route = ROOT / f"web/app/{site}/manifest.webmanifest/route.ts"
            self.assertFalse(route.exists(), f"站点清单不应留在动态页面目录：{route}")

    def test_manifest_urls_are_served_before_login_checks(self):
        """站点 manifest JSON 处理要早于鉴权，安装时无需先登录。"""
        middleware = read("web/middleware.ts")
        manifest_at = middleware.index('pathname === "/spark/manifest.webmanifest"')
        auth_at = middleware.index("const isPublic = PUBLIC_PATHS.some(")
        self.assertLess(manifest_at, auth_at)
        self.assertIn('headers: {', middleware[manifest_at:auth_at])
        self.assertIn('"Content-Type": "application/manifest+json"', middleware[manifest_at:auth_at])


    def test_no_public_manifest_collides_with_a_dynamic_route(self):
        """任何 `public/**/manifest.webmanifest` 都不能与同前缀的动态路由冲突。

        这是上面那条的推广：不只是这两个站点，将来谁再往 public/ 放清单，
        都会踩同一个坑。
        """
        public_root = ROOT / "web/public"
        if not public_root.exists():
            self.skipTest("public/ 不存在")
        for manifest in public_root.rglob("manifest.webmanifest"):
            relative = manifest.relative_to(ROOT / "web")
            # public/<site>/manifest.webmanifest → app/<site>/[section]
            parts = relative.relative_to("public").parts
            if len(parts) < 2:
                continue
            site = parts[0]
            dynamic = ROOT / f"web/app/{site}/[section]"
            self.assertFalse(
                dynamic.exists(),
                f"{relative} 会与 {dynamic.relative_to(ROOT)} 冲突："
                "动态路由优先于 public 静态文件，清单会 404",
            )

    def test_all_three_manifests_are_standalone(self):
        """display 必须独立于浏览器（standalone），否则地址栏一直在。"""
        root_manifest = read("web/app/manifest.webmanifest/route.ts")
        shared_manifest = read("web/lib/pwaManifest.ts")
        middleware = read("web/middleware.ts")
        self.assertIn('display: "standalone"', root_manifest)
        self.assertIn('display: "standalone"', shared_manifest)
        self.assertIn("SPARK_PWA_MANIFEST", middleware)
        self.assertIn("STREAM_MONITOR_PWA_MANIFEST", middleware)

    def test_service_worker_is_served_with_a_script_content_type(self):
        """sw.js 的 Content-Type 必须是 JS —— 否则 Chrome 不认它。"""
        sw = read("web/public/sw.js")
        # SW 必须有 fetch 事件处理器：Chrome 的可安装性判定要求它接管 fetch。
        self.assertIn('addEventListener("fetch"', sw)

    def test_middleware_allows_the_pwa_assets_through(self):
        """manifest / sw.js / 图标必须匿名可取，否则装不了。"""
        middleware = read("web/middleware.ts")
        public_block = middleware[
            middleware.index("const PUBLIC_PATHS") : middleware.index("];")
        ]

        for needed in ('"/icons"', '"/manifest.webmanifest"', '"/sw.js"'):
            self.assertIn(needed, public_block, f"middleware 的 PUBLIC_PATHS 缺 {needed}")

    def test_maskable_icon_is_fully_opaque(self):
        """maskable 图标必须**完全不透明**（24-bit、无 alpha 洞）。

        带 alpha 的 maskable 图标会被 Android 用系统自选的底色补上，
        颜色不可控；更糟的是部分 Chrome 版本会因此判定图标不合格，
        把装机降级成带 Chrome 徽标的快捷方式。
        """
        try:
            from PIL import Image
        except ImportError:
            self.skipTest("需要 Pillow 才能读 PNG 的 alpha 通道")

        icon_path = ROOT / "web/public/icons/icon-512-maskable.png"
        if not icon_path.exists():
            self.skipTest("图标产物不存在（先跑 scripts/gen_pwa_icons.py）")

        with Image.open(icon_path) as image:
            # 只看 alpha 通道的极值：min==255 即「每个像素都不透明」。
            # 用 getchannel + getextrema 而不是 getdata()：后者在 Pillow 12
            # 已废弃，且会把整张图展开成 26 万元素的列表 —— 极值足够回答问题。
            alpha_min, alpha_max = image.convert("RGBA").getchannel("A").getextrema()

        self.assertEqual(
            alpha_min,
            255,
            "maskable 图标存在非不透明像素：Android 补底色的颜色不可控，"
            "部分 Chrome 版本会因此把装机降级成带徽标的快捷方式",
        )
        self.assertEqual(alpha_max, 255)

    def test_any_icons_keep_transparent_corners(self):
        """purpose any 的图标**要**有透明圆角外（Android 才有自己的遮罩形状）。

        这跟 maskable 全不透明正好相反：any 图标按 favicon 那样做，
        圆角外透明，交给系统裁形状。
        """
        try:
            from PIL import Image
        except ImportError:
            self.skipTest("需要 Pillow 才能读 PNG 的 alpha 通道")

        icon_path = ROOT / "web/public/icons/icon-192.png"
        if not icon_path.exists():
            self.skipTest("图标产物不存在（先跑 scripts/gen_pwa_icons.py）")

        with Image.open(icon_path) as image:
            # 只读 alpha 通道（getchannel("A")），别去解包 RGBA 元组：
            # 静态分析器推不出 getpixel() 的返回类型，会把 corner[3] 报成
            # 「在 float 上取下标」。这里本来也只需要 alpha 一个通道。
            alpha = image.convert("RGBA").getchannel("A")
            width, height = alpha.size
            corners = [
                alpha.getpixel((0, 0)),
                alpha.getpixel((width - 1, 0)),
                alpha.getpixel((0, height - 1)),
                alpha.getpixel((width - 1, height - 1)),
            ]

        for corner in corners:
            self.assertEqual(
                corner,
                0,
                "purpose any 的图标四角应当透明（圆角外交给系统裁形状）",
            )


if __name__ == "__main__":
    unittest.main()
