import type { Metadata } from "next";
import { getAudioData } from "@/lib/av/pageData";
import AudioView from "@/components/av/pages/AudioView";
import { AvEmpty, AvPageHeader } from "@/components/av/AvUI";

export const metadata: Metadata = {
  title: "音频分析 · 智能音视频平台",
  description: "告警音频的频谱分析与说话人转写",
};

/**
 * `/stream-monitor/audio?alarm=AL-00042`：音频分析（不进导航）。
 *
 * 频谱整包 638KB，只在真正进入这一页时才读（`getAudioData` 内部 `getSpectra()`），
 * 绝不放进首屏。
 *
 * 空态分两种，文案必须不同 —— 否则用户会以为「这条告警没有音频」而不是「你给的 id
 * 不对」：
 *   · 没带 `alarm` 参数且数据集里一段频谱都没有；
 *   · 显式带了 `alarm`，但这条告警没有落盘频谱（或 id 不存在）。
 * 第二种**绝不能**顶替成别人的频谱（review 缺陷 3）。
 */
export default async function AudioPage({ searchParams }: { searchParams: { alarm?: string } }) {
  const requested = searchParams.alarm?.trim() || null;
  const data = await getAudioData(requested);

  if (!data) {
    return (
      <div style={{ display: "grid", gap: 12 }}>
        <AvPageHeader
          route="/stream-monitor/audio"
          title="音频分析"
        />
        {requested ? (
          <AvEmpty
            title={`${requested} 没有可分析的音频`}
            hint="这条告警没有落盘频谱（或编号不存在）。请从告警详情里的「音频分析」入口进入有音频证据的告警。"
          />
        ) : (
          <AvEmpty title="没有可分析的音频" hint="当前没有带频谱的告警。" />
        )}
      </div>
    );
  }

  return <AudioView {...data} />;
}
