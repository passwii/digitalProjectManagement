import type { MetadataRoute } from "next";

/**
 * PWA 应用清单（BLF-1127/S6，契约 §6「manifest + icons」行）。
 *
 * `display: standalone` 是「装到桌面就是 App」的关键一行：从主屏幕启动时
 * 不带浏览器地址栏。`theme_color` 与根布局的 `viewport.themeColor` 取同一值
 *（#0F2742），启动闪屏与状态栏才不会出现两截颜色。
 *
 * 图标三件套（`public/icons/`，由脚本 `scripts/gen_pwa_icons.py` 生成，
 * 源设计见 `app/icon.svg`）：
 *   · 192 / 512（purpose any）—— 主屏幕图标与启动闪屏；
 *   · 512 maskable —— Android 自适应图标（全 bleed 底 + 中央安全区作画，
 *     系统遮罩不会裁掉字母）；
 *   · `/icon.svg`（sizes any）—— 高分屏与未来尺寸的矢量兜底。
 *
 * shortcuts 指向 Dock 的两个最高频落点（工作台 / 待审批）：长按桌面图标
 * 直达。待审批是管理员入口 —— 非管理员点进去会落到既有的无权限页
 *（`NoAccess`），不会 403 白屏，所以 shortcuts 里保留它是安全的。
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
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
    ],
  };
}
