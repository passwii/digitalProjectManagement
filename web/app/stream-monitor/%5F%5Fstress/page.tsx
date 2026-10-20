import type { Metadata } from "next";
import { getStressData } from "@/lib/av/pageData";
import StressView from "@/components/av/pages/StressView";

export const metadata: Metadata = {
  title: "布局压力测试 · Stream Monitor",
  description: "极端值样本一次性渲染，用于布局回归（不进导航）",
  // 回归页不进搜索引擎，也不该被当成产品内容分享出去
  robots: { index: false, follow: false },
};

/**
 * `/stream-monitor/__stress`：布局压力测试页（不进导航）。
 *
 * 目录名为什么是 `%5F%5Fstress`：Next App Router 把 **下划线开头** 的文件夹当作
 * 「私有目录」（`_folder` 不参与路由），而本页的 URL 必须就是 `/stream-monitor/__stress`。
 * 官方给出的退出方式是 URL-encode 下划线：`%5F` 解码后仍是 `_`，路由却能正常生成。
 * `next build` 的路由表里会显示为 `/stream-monitor/__stress`（已验证）。
 */
export default async function StressPage() {
  const { core, extremes } = await getStressData();
  return <StressView core={core} extremes={extremes} />;
}
