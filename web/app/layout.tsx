import type { Metadata, Viewport } from "next";
import Script from "next/script";
import InstallPrompt from "@/components/pwa/InstallPrompt";
import PullToRefresh from "@/components/mobile/PullToRefresh";
import ThemeProvider, { themeBootstrapScript } from "@/components/theme/ThemeProvider";
import { PageRefreshProvider } from "@/lib/pageRefresh";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "数科云办公",
    template: "%s · 数科云办公",
  },
  description: "数科云办公项目台账、进度、合同与支出一体化管理平台",
  // 站点图标（BLF-1360）。
  //
  // ⚠️ 这里必须把 `icon` 一并写全，不能只写 `apple`。Next 的元数据合并逻辑是：
  // 文件约定图标（`app/icon.svg`）只在 metadata **没有** `icons` 字段时才会被
  // 合进 `<head>`（见 next/dist/lib/metadata/resolve-metadata.js 的
  // `leafSegmentStaticIcons` 分支）。只写 `icons.apple` 会把整个 `icons` 变成
  // 真值，于是 `app/icon.svg` 被静默丢弃 —— 标签页只剩浏览器默认的地球图标。
  //
  // 顺带补上 PNG：Safari / 老 Firefox 不支持 SVG favicon，只给 `icon.svg`
  // 它们同样显示地球。PNG 与 manifest 的 192/512 是同一批产物。
  icons: {
    icon: [
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      { url: "/icon.svg", sizes: "any", type: "image/svg+xml" },
    ],
    apple: "/icons/apple-touch-icon.png",
  },
  // iOS standalone：从主屏幕启动时全屏（无 Safari 地址栏），状态栏透明盖在深色顶栏上。
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "数科云办公",
  },
  /**
   * PWA 清单（BLF-1389）。
   *
   * ⚠️ 这一行**必须**写，且必须与「把根 manifest 从 `app/manifest.ts` 迁到
   * `app/manifest.webmanifest/route.ts`」**成对做**：
   *
   * Next 的元数据合并里，文件约定形式的 manifest（`app/manifest.ts`）会被写进
   * `staticFilesMetadata.manifest`，在 `mergeStaticMetadata` 里**无条件覆盖**
   * layout 显式写的 `metadata.manifest` —— 那样的话，两个站点的
   * `<link rel="manifest">` 永远指向根这一份，站点自己的 PWA 身份形同虚设。
   *
   * 迁成 `route.ts` 之后，元数据只由 `metadata.manifest` 说了算；但
   * `route.ts` 形式**不会**被自动注入 `<head>`（实测：漏写这一行时根页面
   * 一条 manifest link 都没有），所以根布局必须自己显式声明。
   */
  manifest: "/manifest.webmanifest",
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
    <html lang="zh-CN" suppressHydrationWarning>
      <body>
        <Script id="theme-bootstrap" strategy="beforeInteractive">
          {themeBootstrapScript}
        </Script>
        <ThemeProvider>
          <PageRefreshProvider>
            {children}
            <PullToRefresh />
          </PageRefreshProvider>
          <InstallPrompt />
        </ThemeProvider>
      </body>
    </html>
  );
}
