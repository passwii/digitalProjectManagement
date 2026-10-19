/**
 * 各页面需要的「服务端聚合 → 客户端 props」投影。
 *
 * 三个目的：
 *   1. 首屏预算：只把页面用到的字段序列化进 RSC payload（`/av/overview` 远低于 1MB）；
 *   2. 口径集中：每个数字怎么算只在 view.ts / 本文件里写一次；
 *   3. 可测试：node:test 可以直接调用这些函数，对真实数据断言「数字来自 JSON」。
 *
 * ⚠️ 仅供 Server Component / node:test 使用（依赖 node:fs）。
 */
import {
  getAlarmById,
  getAlarmPage,
  getAlarmsByIds,
  getCore,
  getExtremes,
  getSpectra,
  getSpectrumByAlarm,
  getTranscriptByAlarm,
} from "./server";
import type { Alarm, DatasetCore, Device } from "./types";
import {
  alarmCard,
  algorithmMatrix,
  dailySeries,
  deviceStatusDistribution,
  gpuCards,
  heatmapDays,
  incidentRows,
  levelBreakdown,
  monitorChannels,
  overviewKpis,
  pointRanking,
  sceneCards,
  sceneDistribution,
  siteHealth,
  trendSeries,
  typeRanking,
  waveformOf,
  type AlarmCardModel,
} from "./view";
import {
  ALGORITHM_STATUS_LABEL,
  ALGORITHM_STATUS_TONE,
  DEVICE_STATUS_LABEL,
  levelMeta,
  sceneMeta,
  type AvTone,
} from "./labels";
import { toAbsolute } from "./time";
import type {
  AlarmViewProps,
  AudioSampleOption,
  AudioViewProps,
  CapabilityProps,
  DeviceRow,
  DeviceViewProps,
  EventDetail,
  EventRow,
  EventViewProps,
  MonitorProps,
  OverviewProps,
} from "./contracts";

function siteSceneName(core: DatasetCore, siteId: string): string {
  const site = core.sites.find((item) => item.id === siteId);
  return site ? sceneMeta(site.scene).fallbackName : "";
}

// ---------------------------------------------------------------------------
// 总览
// ---------------------------------------------------------------------------

export async function getOverviewData(): Promise<OverviewProps> {
  const core = await getCore();
  const firstPage = await getAlarmPage(null, 10);

  return {
    kpis: overviewKpis(core.kpi),
    trend: trendSeries(core.trends),
    // 「今日」= 锚点往前 720 分钟（自然日 00:00 起）
    todayTrend: trendSeries({
      ...core.trends,
      hourly: core.trends.hourly.filter((bucket) => bucket.window_start_offset_minutes < 720),
    }),
    daily: dailySeries(core.trends),
    heatmap: heatmapDays(core.trends),
    levels: levelBreakdown(core.kpi),
    todayAlarmsTotal: core.kpi.alarm_natural_day,
    scenes: sceneDistribution(core.kpi),
    gpu: {
      meta: {
        model: core.kpi.gpu.model,
        vramTotalGb: core.kpi.gpu.vram_total_gb,
        utilization: core.kpi.gpu.utilization_percent,
      },
      cards: gpuCards(core.kpi),
    },
    storage: {
      hotTotalTb: core.kpi.storage.hot_total_tb,
      hotUsedTb: core.kpi.storage.hot_used_tb,
      coldUsedTb: core.kpi.storage.cold_used_tb,
      unit: core.kpi.storage.unit,
    },
    firmware: core.kpi.firmware_distribution,
    types: typeRanking(core, 6),
    points: pointRanking(core, 6),
    recent: firstPage.alarms.slice(0, 10).map((alarm) => alarmCard(alarm, core)),
    alarmUnhandled: core.kpi.alarm_unhandled,
    anchorLabel: toAbsolute(0),
  };
}

// ---------------------------------------------------------------------------
// 实时监控
// ---------------------------------------------------------------------------

export async function getMonitorData(): Promise<MonitorProps> {
  const core = await getCore();
  const channels = monitorChannels(core.devices, 6).map((device) => ({
    id: device.id,
    room: device.point_room,
    siteName: core.sites.find((site) => site.id === device.site_id)?.name ?? device.site_id,
    sceneName: sceneScene(device, core),
    kind: device.kind,
    typeName: device.type_name,
    model: device.model,
    firmware: device.firmware,
    status: device.status,
    signal: device.signal,
    cpu: device.cpu_percent,
    storage: device.storage_percent,
    heartbeatOffsetMinutes: device.last_heartbeat_offset_minutes,
    waveform: waveformOf(device, 26),
  }));

  const gateways = core.devices
    .filter((device) => device.kind === "gateway")
    .map((device) => ({
      id: device.id,
      room: device.point_room,
      status: device.status,
      heartbeatOffsetMinutes: device.last_heartbeat_offset_minutes,
    }));

  return {
    channels,
    // 计数口径是「通道」而不是「全量设备」：这一页只渲染 6 路通道，
    // 标签上的数字必须和屏幕上的卡片数对得上，否则会被读成「有 268 路画面」。
    counts: {
      all: channels.length,
      audio: channels.filter((channel) => channel.kind === "audio").length,
      video: channels.filter((channel) => channel.kind === "video").length,
      offline: core.devices.filter((device) => device.status === "offline").length,
    },
    deviceTotal: core.devices.length,
    signalHealth: core.deviceStats.signal_health,
    models: core.deviceStats.by_model.map((row) => ({
      model: row.model,
      typeName: row.type_name,
      count: row.count,
    })),
    gateways,
  };
}

function sceneScene(device: Device, core: DatasetCore): string {
  const site = core.sites.find((item) => item.id === device.site_id);
  return site ? siteSceneName(core, site.id) : "";
}

// ---------------------------------------------------------------------------
// 告警中心
// ---------------------------------------------------------------------------

export async function getAlarmData(initialAlarmId: string | null = null): Promise<AlarmViewProps> {
  const core = await getCore();
  const firstPage = await getAlarmPage(null, 50);
  const initialAlarm = initialAlarmId ? await getAlarmById(initialAlarmId) : null;

  const incidentOf: Record<string, string> = {};
  for (const incident of core.incidents) {
    for (const alarmId of incident.alarm_ids) incidentOf[alarmId] = incident.id;
  }

  return {
    initialAlarms: firstPage.alarms,
    initialCursor: firstPage.next_cursor,
    index: core.alarmsIndex,
    total: core.alarmsIndex._meta.total,
    sites: core.sites.map((site) => ({
      id: site.id,
      name: site.name,
      scene: site.scene,
      sceneName: sceneMeta(site.scene).fallbackName,
    })),
    initialAlarm,
    unhandled: core.kpi.alarm_unhandled,
    unhandledBreakdown: core.kpi.alarm_unhandled_breakdown.map((row) => ({
      level: row.level,
      label: row.label,
      count: row.count,
      tone: levelMeta(row.level).tone,
    })),
    metrics: {
      avgResponse: core.kpi.avg_response_minutes,
      p50: core.kpi.response_p50_minutes,
      p90: core.kpi.response_p90_minutes,
      fpRate: core.kpi.false_positive_rate,
      total: core.kpi.alarm_total,
    },
    scripts: core.index.scripts.map((script) => ({
      id: script.id,
      title: script.title,
      alarmCount: script.alarm_count,
    })),
    incidentOf,
    userNames: Object.fromEntries(core.users.map((user) => [user.id, user.name])),
  };
}

// ---------------------------------------------------------------------------
// 事件中心
// ---------------------------------------------------------------------------

export async function getEventData(initialId: string | null = null): Promise<EventViewProps> {
  const core = await getCore();
  const rows: EventRow[] = incidentRows(core.incidents, core).map((row) => ({
    id: row.id,
    title: row.title,
    level: row.level,
    levelLabel: row.levelLabel,
    tone: row.tone,
    scene: row.scene,
    sceneName: row.sceneName,
    siteName: row.siteName,
    room: row.room,
    durationMinutes: row.durationMinutes,
    status: row.status,
    statusLabel: row.statusLabel,
    statusTone: row.statusTone,
    evidenceCount: row.evidenceCount,
    alarmCount: row.alarmCount,
    startedOffsetMinutes: row.startedOffsetMinutes,
    endedOffsetMinutes: row.endedOffsetMinutes,
  }));

  const users = new Map(core.users.map((user) => [user.id, user]));
  const selected =
    core.incidents.find((incident) => incident.id === initialId) ?? core.incidents[0] ?? null;

  let detail: EventDetail | null = null;
  if (selected) {
    const alarmList = await getAlarmsByIds(selected.alarm_ids);
    detail = {
      incident: selected,
      siteName: core.sites.find((site) => site.id === selected.site_id)?.name ?? selected.site_id,
      sceneName: sceneMeta(selected.scene).fallbackName,
      ownerName: users.get(selected.owner_id)?.name ?? selected.owner_id,
      alarms: alarmList.map((alarm) => ({
        id: alarm.id,
        title: alarm.title,
        level: alarm.level,
        levelLabel: alarm.level_label,
        offsetMinutes: alarm.ts_offset_minutes,
        typeName: alarm.type_name,
        audioSeconds: alarm.evidence.audio_seconds,
        videoClips: alarm.evidence.video_clips,
        spectrumId: alarm.evidence.spectrum_id,
      })),
    };
  }

  const open = core.incidents.filter((incident) => incident.status !== "closed").length;
  return {
    rows,
    detail,
    initialId: detail ? detail.incident.id : null,
    counts: { total: core.incidents.length, open, closed: core.incidents.length - open },
    userNames: Object.fromEntries(core.users.map((user) => [user.id, user.name])),
  };
}

// ---------------------------------------------------------------------------
// 设备管理
// ---------------------------------------------------------------------------

export async function getDeviceData(): Promise<DeviceViewProps> {
  const core = await getCore();
  const devices: DeviceRow[] = core.devices.map((device) => ({
    id: device.id,
    siteId: device.site_id,
    siteName: core.sites.find((site) => site.id === device.site_id)?.name ?? device.site_id,
    room: device.point_room,
    model: device.model,
    typeName: device.type_name,
    kind: device.kind,
    firmware: device.firmware,
    status: device.status,
    heartbeatOffsetMinutes: device.last_heartbeat_offset_minutes,
    uptimeDays: device.uptime_days,
    signal: device.signal,
    cpu: device.cpu_percent,
    storage: device.storage_percent,
    micSensitivityDbm: device.mic_sensitivity_dbm,
    selfCheck: {
      result: device.self_check.result,
      atOffsetMinutes: device.self_check.at_offset_minutes,
      items: device.self_check.items,
    },
    selfCheckHistory: device.self_check_history.slice(0, 2).map((record) => ({
      atOffsetMinutes: record.at_offset_minutes,
      result: record.result,
      items: record.items,
    })),
    otaRecords: device.ota_records.slice(0, 2).map((record) => ({
      id: record.id,
      fromVersion: record.from_version,
      toVersion: record.to_version,
      atOffsetMinutes: record.at_offset_minutes,
      status: record.status,
      trigger: record.trigger,
    })),
    // 24 个整点采样 → 12 个点（隔点取样）足够看趋势，也把 payload 砍半
    signalSeries: [...device.signal_series]
      .sort((a, b) => b.at_offset_minutes - a.at_offset_minutes)
      .flatMap((sample, index) =>
        index % 2 === 0
          ? [{ label: toAbsolute(sample.at_offset_minutes).slice(11), value: sample.rssi_dbm }]
          : [],
      ),
  }));

  return {
    devices,
    summary: {
      total: core.kpi.device_total,
      online: core.kpi.device_online,
      offline: core.kpi.device_offline,
      maintenance: core.kpi.device_maintenance,
      byStatus: deviceStatusDistribution(core).map((row) => ({ status: row.status, count: row.count })),
      bySite: siteHealth(core).map((site) => ({
        id: site.id,
        name: site.name,
        total: site.total,
        online: site.online,
        offline: site.offline,
        rate: site.rate,
      })),
      byModel: core.deviceStats.by_model.map((row) => ({
        model: row.model,
        typeName: row.type_name,
        count: row.count,
      })),
      ota: core.deviceStats.ota_summary,
      signalHealth: core.deviceStats.signal_health,
    },
  };
}

// ---------------------------------------------------------------------------
// 能力与场景
// ---------------------------------------------------------------------------

export async function getCapabilityData(): Promise<CapabilityProps> {
  const core = await getCore();
  const groups = algorithmMatrix(core.algorithms).map((group) => ({
    code: group.code,
    name: group.name,
    count: group.count,
    totalCalls: group.totalCalls,
    totalVram: group.totalVram,
    algorithms: group.algorithms.map((algorithm) => ({
      ...algorithm,
      statusLabel: ALGORITHM_STATUS_LABEL[algorithm.status],
      statusTone: ALGORITHM_STATUS_TONE[algorithm.status] as AvTone,
    })),
  }));

  const rules = core.rules;
  const chain = [
    {
      code: "01 / CAPTURE",
      title: "采集",
      detail: "拾音终端 · 全景摄像头 · 网关",
      count: core.kpi.device_total,
      unit: "台终端",
    },
    {
      code: "02 / AUDIO",
      title: "音频前端",
      detail: "降噪 · 抗混响 · 分贝检测 · 声源定位",
      count: groups.find((group) => group.code === "audio")?.count ?? 0,
      unit: "个音频算法",
    },
    {
      code: "03 / RECOGNIZE",
      title: "多模态识别",
      detail: "视觉 AI · 语音语义 · 关键词",
      count: (groups.find((group) => group.code === "vision")?.count ?? 0) + (groups.find((group) => group.code === "speech")?.count ?? 0),
      unit: "个识别算法",
    },
    {
      code: "04 / FUSION",
      title: "融合分级",
      detail: "大模型融合 · 置信度打分 · 自动定级",
      count: groups.find((group) => group.code === "llm")?.count ?? 0,
      unit: "个融合算法",
    },
    {
      code: "05 / RESPONSE",
      title: "处置联动",
      detail: "通知 · 派发 · 声光驱离 · 复核归档",
      count: rules.length,
      unit: "条检测规则",
    },
  ];

  return {
    scenes: sceneCards(core),
    groups,
    rules,
    chain,
    totals: {
      algorithms: core.algorithms.algorithms.length,
      callsToday: core.algorithms.algorithms.reduce((sum, algorithm) => sum + algorithm.calls_today, 0),
      avgLatency:
        core.algorithms.algorithms.reduce((sum, algorithm) => sum + algorithm.avg_latency_ms, 0) /
        Math.max(1, core.algorithms.algorithms.length),
      vram: core.algorithms.algorithms.reduce((sum, algorithm) => sum + algorithm.vram_gb, 0),
    },
  };
}

// ---------------------------------------------------------------------------
// 音频分析
// ---------------------------------------------------------------------------

export async function getAudioData(alarmId: string | null = null): Promise<AudioViewProps | null> {
  const core = await getCore();
  const spectra = await getSpectra();
  if (spectra.length === 0) return null;

  /**
   * 只在**完全没指定** alarmId 时才走默认兜底（第一段有转写的音频）。
   *
   * 显式传了 id 却查不到频谱时，绝不能顶替成别人的频谱 —— 那等于把另一条告警的
   * 音频证据挂在这条告警上（review 缺陷 3：14,366 条告警里有 14,354 条没有频谱，
   * 深链接 / 分享出去的 URL 都会命中）。这种情况返回 null，页面渲染已有的空态。
   */
  let target = alarmId;
  if (!target) {
    target = core.transcripts[0]?.alarm_id ?? spectra[0]?.alarm_id ?? null;
    if (!target) return null;
  }

  const spectrum = await getSpectrumByAlarm(target);
  if (!spectrum) return null;

  const alarm = await getAlarmById(target);
  if (!alarm) return null;
  const transcript = await getTranscriptByAlarm(target);

  const samples: AudioSampleOption[] = spectra.flatMap((item) =>
    item.alarm_id
      ? [{ alarmId: item.alarm_id, title: item.title, spectrumId: item.id, seconds: item.seconds }]
      : [],
  );

  return {
    alarm: {
      id: alarm.id,
      title: alarm.title,
      room: alarm.point_room,
      typeName: alarm.type_name,
      level: alarm.level,
      levelLabel: alarm.level_label,
    },
    spectrum,
    transcript,
    samples,
  };
}

// ---------------------------------------------------------------------------
// 压力测试
// ---------------------------------------------------------------------------

export async function getStressData() {
  const [core, extremes] = await Promise.all([getCore(), getExtremes()]);
  return { core, extremes };
}

/** 供 AC6 的「数字来自数据」守卫：返回本页所有数字字段，便于断言不含硬编码。 */
export async function getAlarmNumbers(): Promise<number[]> {
  const core = await getCore();
  return [
    core.kpi.alarm_total,
    core.kpi.alarm_natural_day,
    core.kpi.alarm_last_24h,
    core.kpi.device_total,
    core.alarmsIndex._meta.total,
  ];
}

