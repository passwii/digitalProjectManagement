import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "数科云办公",
    template: "%s · 数科云办公",
  },
  description: "数科云办公项目台账、进度、合同与支出一体化管理平台",
  // iOS standalone：从主屏幕启动时全屏（无 Safari 地址栏），状态栏透明盖在深色顶栏上。
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "数科云办公",
  },
};

/**
 * PWA 视口（BLF-1127/S6，契约 §6「viewport」行）。
 *
 * `viewportFit: "cover"` —— 圆角屏 / 刘海屏下页面铺满整个屏幕（包括刘海与
 * Home 指示条区域），留白由各外壳自己用 `env(safe-area-inset-*)` 消化
 *（Dock 见 MobileDock.module.css，顶栏见 globals.css 的 PWA 段）。
 * 不写这一行，`viewport-fit` 默认是 `auto`（= contain），safe-area 的 env()
 * 恒为 0，S6 的安全区适配整段失效。
 *
 * `themeColor` 与 manifest 的 `theme_color` 取同一值（#0F2742）：任务切换器
 * 与启动闪屏不出现两截颜色。
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#0F2742",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
