import type { Metadata, Viewport } from "next";
import { STREAM_MONITOR_SITE } from "@/lib/siteIdentity";
import Script from "next/script";
import { getCore } from "@/lib/av/server";
import AvShell from "@/components/av/AvShell";
import MotionProvider from "@/components/motion/MotionProvider";
import AvMotionProvider from "@/components/av/motion/AvMotionProvider";
import { AV_MOTION_BOOTSTRAP_SCRIPT } from "@/lib/av/motion";

export const metadata: Metadata = {
  title: "智能音视频平台",
  description: "音频与视频融合感知的全场景智能安防平台",
  /**
   * 站点自己的 PWA 清单（BLF-1389）。
   *
   * 为什么必须显式写：Next 的元数据合并里，**文件约定**形式的根 manifest
   * （`app/manifest.ts`）会无条件覆盖 layout 写的 `metadata.manifest`。
   * 根 manifest 已迁到 `app/manifest.webmanifest/route.ts`，元数据话语权才回到
   * 各 layout 手里 —— 少了这一行，从主屏幕启动智能音视频平台时装的仍是
   * 「数科云办公」，状态栏与启动闪屏都是主工作台的深蓝。
   */
  manifest: "/stream-monitor/manifest.webmanifest",
  // iOS standalone：状态栏透明盖在站点顶栏上。
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "智能音视频平台",
  },
};

/**
 * 站点视口（BLF-1389）。
 *
 * `themeColor` 跟着站点自己的深浅双主题走：站点是**深浅两套**配色
 * （`--bg` 深色 #07131f / 浅色 #f1f5f7），所以用 `media` 描述符分别给一份，
 * 而不是像主工作台那样只给一个固定值 —— 固定值在浅色主题下会让状态栏
 * 与页面顶色对不上（深蓝状态栏 + 浅灰页面）。
 *
 * ⚠️ manifest 的 `theme_color` 只能是**一个**值（规范如此），那里取深色
 * （站点默认主题），与 `public/stream-monitor/manifest.webmanifest` 同值。
 *
 * `viewportFit: "cover"`：刘海 / 圆角屏下铺满，安全区由
 * `AvShell.module.css` 的 `env(safe-area-inset-*)` 消化。
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: STREAM_MONITOR_SITE.themeColor },
    { media: "(prefers-color-scheme: light)", color: STREAM_MONITOR_SITE.lightThemeColor },
  ],
};

/**
 * stream monitor 根布局（`/stream-monitor`）。
 *
 * 站点对外品牌是中文「智能音视频平台」（BLF-1397），URL 仍保留英文前缀
 * `/stream-monitor` —— 路径是稳定契约，品牌名不是。
 *
 * 刻意**不进** `(dashboard)` 的鉴权壳：`/stream-monitor` 与 `/spark` 一样是纯演示入口，
 * middleware 已把它放进 PUBLIC_PATHS。壳层只读一次 core 里的品牌与在线率，
 * 页面各自的聚合在 `app/stream-monitor/[section]/page.tsx` 里按需取，避免整站共用一份大 payload。
 *
 * 动效层（Stage 3）：
 *   · `MotionProvider` 复用主工作台已有的 LazyMotion + 页面加载进度（不重造）；
 *   · `AvMotionProvider` 在它内部补站点自己的 `domMax`（layoutId 需要）与
 *     「减少动效 / ?static=1」两个开关；
 *   · 第一行的内联脚本必须留在 `<body>` 最前面：`?static=1` 要在**首帧之前**
 *     把 `data-av-motion="off"` 挂到 <html> 上，否则录屏 / 截图会先录进一段入场动画
 *     （等 React 水合再关就已经晚了）。
 */
export default async function AvLayout({ children }: { children: React.ReactNode }) {
  const core = await getCore();

  return (
    <>
      {/*
        首帧前挂 `data-av-motion` 的脚本。
        用 `next/script`（beforeInteractive）而不是手写 <script>：手写的话服务端会把
        `"` 转义成 `&quot;`、`&&` 转义成 `&amp;&amp;`，客户端渲染的却是原始文本，
        hydrate 时 React 直接报「Text content did not match」（#425）；
        `next/script` 两端都走同一套序列化，且会在首次绘制前执行。
        这是根布局里 themeBootstrapScript 的同款做法。
      */}
      <Script id="av-motion-bootstrap" strategy="beforeInteractive">
        {AV_MOTION_BOOTSTRAP_SCRIPT}
      </Script>
      <MotionProvider>
        <AvMotionProvider>
          <AvShell
            orgName={core.org.name}
            version={core.org.version}
            onlineRate={core.kpi.online_rate}
            deviceOnline={core.kpi.device_online}
            deviceTotal={core.kpi.device_total}
          >
            {children}
          </AvShell>
        </AvMotionProvider>
      </MotionProvider>
    </>
  );
}
