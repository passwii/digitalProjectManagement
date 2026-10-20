import type { Metadata } from "next";
import Script from "next/script";
import { getCore } from "@/lib/av/server";
import AvShell from "@/components/av/AvShell";
import MotionProvider from "@/components/motion/MotionProvider";
import AvMotionProvider from "@/components/av/motion/AvMotionProvider";
import { AV_MOTION_BOOTSTRAP_SCRIPT } from "@/lib/av/motion";

export const metadata: Metadata = {
  title: "智能音视频平台",
  description: "音频与视频融合感知的全场景智能安防平台",
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
