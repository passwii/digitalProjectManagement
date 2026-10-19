import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getAlarmData, getEventData } from "@/lib/av/pageData";
import { getAlarmById, getIncidentById } from "@/lib/av/server";
import AlarmView from "@/components/av/pages/AlarmView";
import EventView from "@/components/av/pages/EventView";

/**
 * 深链接：`/stream-monitor/alarm/AL-00042` 与 `/stream-monitor/event/EV-20160714`。
 *
 * 两个页面共用一条动态路由（`[section]/[id]`），因为除告警 / 事件之外的 section
 * 没有详情语义，直接 404；比再开两个平行目录更不容易和 `[section]` 抢路由。
 *
 * 刷新时由服务端按 id 定位：告警走 `getAlarmById`（首次请求会建一次全量 id 索引，
 * 进程内缓存），事件直接从核心数据里找。定位失败返回 404，不静默落回列表。
 */

export function generateMetadata({ params }: { params: { section: string; id: string } }): Metadata {
  const label = params.section === "alarm" ? "告警详情" : params.section === "event" ? "事件详情" : "Stream Monitor";
  return { title: `${decodeURIComponent(params.id)} · ${label}` };
}

export default async function AvDetailPage({ params }: { params: { section: string; id: string } }) {
  /**
   * 这里不是「二次解码」：Next 14 只对 unreserved 字符做归一化（`%41 → "A"`、
   * `%2D → "-"`），`%20 / %25 / 非 ASCII` 会**原样**留在 `params.id` 里，
   * 由页面负责解码一次。告警 / 事件 id 都是 `AL-00042` / `EV-2026xxxx` 形态，
   * 实际不会出现需要编码的字符；保留解码是为了不让 `%20` 这类输入变成 404。
   */
  const id = decodeURIComponent(params.id);

  if (params.section === "alarm") {
    const alarm = await getAlarmById(id);
    if (!alarm) notFound();
    return <AlarmView {...(await getAlarmData(id))} />;
  }

  if (params.section === "event") {
    const incident = await getIncidentById(id);
    if (!incident) notFound();
    return <EventView {...(await getEventData(id))} />;
  }

  notFound();
}
