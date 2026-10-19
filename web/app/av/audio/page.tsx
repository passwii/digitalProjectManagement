import type { Metadata } from "next";
import { getAudioData } from "@/lib/av/pageData";
import AudioView from "@/components/av/pages/AudioView";
import { AvEmpty, AvPageHeader } from "@/components/av/AvUI";

export const metadata: Metadata = {
  title: "音频分析 · 智能音视频平台",
  description: "频谱矩阵与说话人转写（不进主导航，从告警详情进入）",
};

/**
 * `/av/audio?alarm=AL-00042`：音频分析（不进导航）。
 *
 * 频谱整包 638KB，只在真正进入这一页时才读（`getAudioData` 内部 `getSpectra()`），
 * 绝不放进首屏。没有 `alarm` 参数时退到第一段「有转写」的音频。
 */
export default async function AudioPage({ searchParams }: { searchParams: { alarm?: string } }) {
  const data = await getAudioData(searchParams.alarm ?? null);

  if (!data) {
    return (
      <div style={{ display: "grid", gap: 12 }}>
        <AvPageHeader
          route="/av/audio"
          title="音频分析"
          subtitle="频谱与转写"
        />
        <AvEmpty title="没有可分析的音频" hint="数据集里没有带频谱的告警，或该告警的音频没有落盘。" />
      </div>
    );
  }

  return <AudioView {...data} />;
}
