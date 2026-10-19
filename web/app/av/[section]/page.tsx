import { Suspense } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AV_PAGES, isAvHiddenRoute, isAvSection } from "@/lib/av/navigation";
import { avPageForSection } from "@/lib/av/navigation";
import {
  getAlarmData,
  getCapabilityData,
  getDeviceData,
  getEventData,
  getMonitorData,
  getOverviewData,
} from "@/lib/av/pageData";
import OverviewView from "@/components/av/pages/OverviewView";
import MonitorView from "@/components/av/pages/MonitorView";
import AlarmView from "@/components/av/pages/AlarmView";
import EventView from "@/components/av/pages/EventView";
import DeviceView from "@/components/av/pages/DeviceView";
import CapabilityView from "@/components/av/pages/CapabilityView";

/**
 * `/av/[section]` 的 6 个视图。
 *
 * 全部是 Server Component：数据在服务端聚合完再交给视图，浏览器不为首屏再发一遍
 * JSON 请求（`/av/overview` 因此远低于 AC10 的 1MB 预算）。
 * 允许的 section 只有 `AV_PAGES` 里的 6 个，其余一律 404 —— 辅助页
 * （`/av/audio`、`/av/__stress`）是独立静态段，优先级高于本动态段。
 */

export function generateStaticParams() {
  return AV_PAGES.map((page) => ({ section: page.slug }));
}

export function generateMetadata({ params }: { params: { section: string } }): Metadata {
  const page = avPageForSection(params.section);
  if (!page) return { title: "智能音视频平台" };
  return { title: `${page.label} · 智能音视频平台`, description: page.summary };
}

export default async function AvSectionPage({ params }: { params: { section: string } }) {
  const { section } = params;
  if (isAvHiddenRoute(section) || !isAvSection(section)) notFound();

  switch (section) {
    case "overview":
      return <OverviewView {...(await getOverviewData())} />;
    case "monitor":
      return <MonitorView {...(await getMonitorData())} />;
    case "alarm":
      // AlarmView 用 useSearchParams 读全局搜索带过来的 ?q=；静态路由需要 Suspense 边界
      return (
        <Suspense fallback={null}>
          <AlarmView {...(await getAlarmData())} />
        </Suspense>
      );
    case "event":
      return <EventView {...(await getEventData())} />;
    case "device":
      return <DeviceView {...(await getDeviceData())} />;
    case "capability":
      return <CapabilityView {...(await getCapabilityData())} />;
  }
}
