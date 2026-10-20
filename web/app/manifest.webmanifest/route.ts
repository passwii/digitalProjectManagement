import { NextResponse } from "next/server";

/**
 * PWA 应用清单（BLF-1127/S6，契约 §6「manifest + icons」行）。
 *
 * `display: standalone` 是「装到桌面就是 App」的关键一行：从主屏幕启动时
 * 不带浏览器地址栏。`theme_color` 与根布局的 `viewport.themeColor` 取同一值
 * （#0F2742），启动闪屏与状态栏才不会出现两截颜色。
 *
 * PWA 图标（`public/icons/`，由脚本 `scripts/gen_pwa_icons.py` 生成，
 * 包含 SHZK、元素分隔线与中文品牌名；源设计见 `app/icon.svg`）：
 *   · 192 / 512（purpose any）—— 主屏幕图标与启动闪屏；
 *   · 512 maskable —— Android 自适应图标（全 bleed 底 + 中央安全区作画，
 *     系统遮罩不会裁掉字标与中文）；
 *   · 180 Apple touch icon —— iOS 添加到主屏幕使用（在 layout.tsx metadata.icons.apple 声明）；
 *   · `/icon.svg`（sizes any）—— 高分屏与未来尺寸的矢量兜底。
 *
 * shortcuts 指向 Dock 的两个最高频落点（工作台 / 待审批）：长按桌面图标
 * 直达。待审批是管理员入口 —— 非管理员点进去会落到既有的无权限页
 *（`NoAccess`），不会 403 白屏，所以 shortcuts 里保留它是安全的。
 *
 * ⚠️ 为什么是 `route.ts` 而不是 `app/manifest.ts`（BLF-1389 实测迁移）：
 * Next 的元数据合并里，**文件约定**（`app/manifest.ts`）会被写进
 * `staticFilesMetadata.manifest`，在 `mergeStaticMetadata` 里**无条件覆盖**
 * layout 显式写的 `metadata.manifest`（resolve-metadata.js 的 `if (manifest)`）。
 * 后果是：只要根目录还留着 `app/manifest.ts`，两个站点的
 * `<link rel="manifest">` 就永远指向根这一份 —— 站点自己的 manifest 形同虚设。
 *
 * 迁成 `route.ts` 之后，元数据只能由 `metadata.manifest` 显式声明，
 * 各 layout 才有话语权（根布局写 `/manifest.webmanifest`，两个站点布局写各自的）。
 * ⚠️ 迁 root manifest 的**同时**必须在根布局显式写 `metadata.manifest`：
 * `route.ts` 形式的 manifest **不会**被自动注入 `<head>`（实测根页面一条
 * manifest link 都没有），漏了这一步等于把根站点的安装能力一起弄丢。
 * 两者必须成对做。
 */
const manifest = {
  name: "数科云办公",
  short_name: "数科云办公",
  description: "数科云办公项目台账、进度、合同与支出一体化管理平台",
  lang: "zh-CN",
  start_url: "/dashboard",
  scope: "/",
  display: "standalone",
  orientation: "portrait",
  background_color: "#0F2742",
  theme_color: "#0F2742",
  icons: [
    {
      src: "/icons/icon-192.png",
      sizes: "192x192",
      type: "image/png",
      purpose: "any",
    },
    {
      src: "/icons/icon-512.png",
      sizes: "512x512",
      type: "image/png",
      purpose: "any",
    },
    {
      src: "/icons/icon-512-maskable.png",
      sizes: "512x512",
      type: "image/png",
      purpose: "maskable",
    },
    {
      src: "/icon.svg",
      sizes: "any",
      type: "image/svg+xml",
      purpose: "any",
    },
  ],
  shortcuts: [
    {
      name: "工作台",
      url: "/dashboard",
      icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }],
    },
    {
      name: "待审批",
      url: "/approvals",
      icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }],
    },
    // 两个独立站点的入口（BLF-1389）：长按主屏幕图标直达，不必先回工作台。
    {
      name: "云电竞管理平台",
      url: "/spark/dashboard",
      icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }],
    },
    {
      name: "智能音视频平台",
      url: "/stream-monitor/overview",
      icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }],
    },
  ],
};

export function GET() {
  return NextResponse.json(manifest, {
    headers: { "Content-Type": "application/manifest+json" },
  });
}
