import type { Metadata } from "next";
import { getCore } from "@/lib/av/server";
import AvShell from "@/components/av/AvShell";

export const metadata: Metadata = {
  title: "智能音视频平台",
  description: "多模态融合感知 · 全场景智能安防演示站（本地 mock 数据）",
};

/**
 * AV 演示站根布局。
 *
 * 刻意**不进** `(dashboard)` 的鉴权壳：`/av` 与 `/spark` 一样是纯演示入口，
 * middleware 已把它放进 PUBLIC_PATHS。壳层只读一次 core 里的品牌与在线率，
 * 页面各自的聚合在 `/av/[section]/page.tsx` 里按需取，避免整站共用一份大 payload。
 */
export default async function AvLayout({ children }: { children: React.ReactNode }) {
  const core = await getCore();

  return (
    <AvShell
      orgName={core.org.name}
      version={core.org.version}
      onlineRate={core.kpi.online_rate}
      deviceOnline={core.kpi.device_online}
      deviceTotal={core.kpi.device_total}
    >
      {children}
    </AvShell>
  );
}
