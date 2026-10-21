import type { Metadata, Viewport } from "next";
import SparkShell from "@/components/spark/SparkShell";

export const metadata: Metadata = {
  title: { absolute: "云电竞管理平台" },
  description: "云电竞管理平台：运营、门店、算力与安全管理",
  /**
   * 站点自己的 PWA 清单（BLF-1389）。
   *
   * 为什么必须显式写：Next 的元数据合并里，**文件约定**形式的根 manifest
   * （`app/manifest.ts`）会无条件覆盖 layout 写的 `metadata.manifest`。
   * 根 manifest 已迁到 `app/manifest.webmanifest/route.ts`，元数据话语权才回到
   * 各 layout 手里 —— 少了这一行，从主屏幕启动云电竞管理平台时装的仍是
   * 「数科云办公」，状态栏与启动闪屏都是主工作台的深蓝。
   */
  manifest: "/spark/manifest.webmanifest",
  // iOS standalone：状态栏透明盖在站点自己的深色顶栏上。
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "云电竞管理平台",
  },
};

/**
 * 站点视口（BLF-1389）。
 *
 * `themeColor` 取站点自己的底色（#070a12，与 `app/spark/manifest.webmanifest/route.ts`
 * 的 `theme_color` / `background_color` 同值），与主工作台的 #0F2742 区分开 ——
 * standalone 启动时状态栏色与页面顶色才对得上，不出现两截颜色。
 *
 * `viewportFit: "cover"`：刘海 / 圆角屏下铺满，安全区由
 * `SparkShell.module.css` 的 `env(safe-area-inset-*)` 消化。
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#070a12",
};

export default function SparkLayout({ children }: { children: React.ReactNode }) {
  return <SparkShell>{children}</SparkShell>;
}
