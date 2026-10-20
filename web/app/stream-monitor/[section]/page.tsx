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
 * `/stream-monitor/[section]` 的 6 个视图。
 *
 * 全部是 Server Component：数据在服务端聚合完再交给视图，浏览器不为首屏再发一遍
 * JSON 请求（`/stream-monitor/overview` 因此远低于 AC10 的 1MB 预算）。
 * 允许的 section 只有 `AV_PAGES` 里的 6 个，其余一律 404 —— 辅助页
 * （`/stream-monitor/audio`、`/stream-monitor/__stress`）是独立静态段，优先级高于本动态段。
 */

export function generateStaticParams() {
  return AV_PAGES.map((page) => ({ section: page.slug }));
}

export function generateMetadata({ params }: { params: { section: string } }): Metadata {
  const page = avPageForSection(params.section);
  if (!page) return { title: "Stream Monitor" };
  return { title: `${page.label} · Stream Monitor`, description: page.summary };
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
      // 注意：不要把整个 AlarmView 包进 Suspense（它内部已用一个极小客户端组件
      // 隔离 useSearchParams），否则首屏 50 条会退化成纯客户端渲染。
      return <AlarmView {...(await getAlarmData())} />;
    case "event":
      return <EventView {...(await getEventData())} />;
    case "device":
      return <DeviceView {...(await getDeviceData())} />;
    case "capability":
      return <CapabilityView {...(await getCapabilityData())} />;
  }
}
