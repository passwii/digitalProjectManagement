"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { DeviceStatus } from "@/lib/av/types";
import {
  compactAge,
  DEVICE_STATUS_LABEL,
  DEVICE_STATUS_TONE,
  formatCount,
  formatGb,
  formatPercent,
  type AvTone,
} from "@/lib/av/labels";
import { toAbsolute, toRelative } from "@/lib/av/time";
import { AvEmpty, AvKV, AvLegend, AvPageHeader, AvPanel, AvStatusBadge } from "@/components/av/AvUI";
import {
  AvDonut,
  AvHorizontalBarChart,
  AvMultiTrendChart,
  AvSignalChart,
  AvStackedBarChart,
  seriesTone,
  type ChartSeriesSpec,
} from "@/components/av/AvCharts";
import { seriesToneFor, toneVar } from "@/lib/av/tone";
import { attentionAgeText } from "@/lib/av/view";
import { AV_CHART_HEIGHT } from "@/lib/av/chartHeights";
import {
  DEVICE_STREAM_FRAMES,
  DEVICE_STREAM_TICK_SECONDS,
  deviceFrameAt,
  deviceStreamBase,
  rateAxisDomain,
} from "@/lib/av/deviceStream";
import { percentTicks } from "@/lib/av/chartAxis";
import AvGlyph from "@/components/av/AvGlyph";
import AvTabs from "@/components/av/AvTabs";
import AvCounter from "@/components/av/motion/AvCounter";
import { closeDialogWithMotion, openDialogWithMotion } from "@/components/av/motion/AvDialog";
import { staggerProps } from "@/components/av/motion/AvMotion";
import { useAvMotion } from "@/components/av/motion/AvMotionProvider";
import s from "./AvPages.module.css";
import type { DeviceRow, DeviceViewProps } from "@/lib/av/contracts";

const PAGE = 24;

/**
 * 三档状态系列：颜色走语义 tone（在线=success / 离线=danger / 维护中=warning），
 * 与状态徽标、环形图同一套映射 —— 站点堆叠柱如果改用 `series-*`，
 * 同一屏里「离线」会出现两种颜色。
 */
const SITE_STATUS_SERIES: ChartSeriesSpec[] = [
  { key: "online", label: DEVICE_STATUS_LABEL.online, tone: DEVICE_STATUS_TONE.online },
  { key: "offline", label: DEVICE_STATUS_LABEL.offline, tone: DEVICE_STATUS_TONE.offline },
  { key: "maintenance", label: DEVICE_STATUS_LABEL.maintenance, tone: DEVICE_STATUS_TONE.maintenance },
];

/** 站点柱状图上的第二视觉：在线率折线。系列色与三条站点折线互不冲突。 */
const SITE_RATE_SERIES = { key: "rate", label: "在线率", tone: seriesTone(1) } as const;

const metricTone = (tone: AvTone) => ({ "--metric-tone": toneVar(tone) }) as React.CSSProperties;

export default function DeviceView({ devices, summary }: DeviceViewProps) {
  const [statusFilter, setStatusFilter] = useState<"all" | DeviceStatus>("all");
  const [kindFilter, setKindFilter] = useState<"all" | "audio" | "video">("all");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const { enabled: motionEnabled } = useAvMotion();

  /**
   * 演示帧：每 `DEVICE_STREAM_TICK_SECONDS` 秒推进一格（0 = 静态基准帧）。
   *
   * `enabled` 同时挡掉 `?static=1` 与 prefers-reduced-motion —— 两者都要求整页冻结，
   * 否则连拍三张截图的数字会不一样（Stage 8 的 MD5 比对会红）。
   * 冻结时 `tick` 恒为 0，也就是服务端口径的基准帧，不做任何抖动。
   *
   * 注意这里是**运行期**开关，不是初始化参数：`AvMotionProvider` 订阅了系统的
   * `prefers-reduced-motion` change 事件，站内跳到 `?static=1` 也会经 `popstate` 把
   * `frozen` 打开。所以冻结分支必须把 `tick` 拨回 0 —— 只清定时器的话页面会冻在
   * 某一合成帧上（「在线 130」），Stage 8 先看动态页再客户端跳静态页截图就不是基准帧。
   */
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!motionEnabled) {
      setTick(0);
      return;
    }
    const timer = window.setInterval(() => {
      setTick((value) => (value + 1) % (DEVICE_STREAM_FRAMES + 1));
    }, DEVICE_STREAM_TICK_SECONDS * 1000);
    return () => window.clearInterval(timer);
  }, [motionEnabled]);

  // 基准帧只在 props 变化时重算（扫一遍全量设备），之后每帧都是纯增量
  const streamBase = useMemo(() => deviceStreamBase(devices, summary), [devices, summary]);
  const frame = useMemo(() => deviceFrameAt(streamBase, tick), [streamBase, tick]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return devices.filter((device) => {
      if (statusFilter !== "all" && device.status !== statusFilter) return false;
      if (kindFilter !== "all" && device.kind !== kindFilter) return false;
      if (!needle) return true;
      return (
        device.id.toLowerCase().includes(needle) ||
        device.room.toLowerCase().includes(needle) ||
        device.siteName.toLowerCase().includes(needle) ||
        device.model.toLowerCase().includes(needle)
      );
    });
  }, [devices, statusFilter, kindFilter, query]);

  const paged = filtered.slice(0, page * PAGE);
  const selected = selectedId ? devices.find((device) => device.id === selectedId) ?? null : null;

  const openDevice = (device: DeviceRow) => {
    setSelectedId(device.id);
    openDialogWithMotion(dialogRef.current);
    document.documentElement.dataset.avDialog = "open";
  };
  /**
   * 关闭设备抽屉：先播退场（quick），再 close()。
   * 原生 dialog.close() 是同步的，直接调会把退场动画吃掉（见 motion/AvDialog.ts）。
   */
  const closeDevice = () => {
    closeDialogWithMotion(dialogRef.current, () => {
      delete document.documentElement.dataset.avDialog;
      setSelectedId(null);
    });
  };

  /*
   * 筛选 Tab 的计数读**服务端快照**（`summary`），不跟演示帧走。
   *
   * 为什么这一块是个例外：Tab 是筛选控件，它给出的数字必须等于点下去筛出来的行数。
   * 台账行读 `devices`（服务端快照），面板副标题「筛选出 N 台」也读快照 ——
   * 计数若跟帧走，切到「在线」Tab 会出现「在线 130 / 筛选出 129 台 / 129 行」。
   * 图表 / 状态格 / 环图才是演示层（聚合层推进、明细层不动）。
   */
  const statusTabs = [
    { value: "all" as const, label: "全部", count: summary.total },
    ...summary.byStatus.map((row) => ({
      value: row.status,
      label: DEVICE_STATUS_LABEL[row.status],
      count: row.count,
    })),
  ];

  const donut = frame.byStatus.map((row) => ({
    status: row.status,
    label: DEVICE_STATUS_LABEL[row.status],
    value: row.count,
    tone: DEVICE_STATUS_TONE[row.status] as AvTone,
  }));

  /** 站点堆叠柱：台数三段 + 在线率（第二视觉）。悬停卡片补「在线 x/y」。 */
  const siteRows = frame.sites.map((site) => ({
    label: site.name,
    online: site.online,
    offline: site.offline,
    maintenance: site.maintenance,
    total: site.total,
    rate: site.rate,
  }));

  /**
   * 三条站点在线率曲线：颜色按序号取 `series-1..3`，互不相同。
   * 用 `seriesToneFor(index)` 而不是 `seriesTone((index + 1) as 1 | 2 | 3)`：
   * 后者在站点数 > 3 时会骗过类型检查（断言说 1|2|3，实际能到 4），取模版本不会。
   */
  const siteTrendSeries: ChartSeriesSpec[] = frame.sites.map((site, index) => ({
    key: site.id,
    label: site.name,
    tone: seriesToneFor(index),
    // 三条都铺面积会糊成一片（一条线的填充会盖住下面两条），只留描边
    fill: "none",
  }));

  const trendDomain = rateAxisDomain(frame);

  const attention = devices
    .filter((device) => device.status !== "online")
    .sort((a, b) => b.heartbeatOffsetMinutes - a.heartbeatOffsetMinutes);

  const onlineRate = formatPercent((frame.totals.online / Math.max(1, frame.totals.total)) * 100);

  return (
    <div className={s.page} data-av-page="device" data-device-frame={frame.tick}>
      <AvPageHeader
        route="/stream-monitor/device"
        title="设备管理"
        subtitle="设备台账、在线率与离线清单"
        aside={
          <span className={s.headerChip}>
            OTA {frame.ota.success}/{frame.ota.total} 成功
          </span>
        }
      />

      <div className={s.statusGrid}>
        <div className={s.statusCell} style={metricTone("signal")}>
          <span>设备总数</span>
          <strong>
            <AvCounter value={formatCount(frame.totals.total)} />
          </strong>
          <small>覆盖 {frame.sites.length} 个站点</small>
        </div>
        <div className={s.statusCell} style={metricTone("success")}>
          <span>在线</span>
          <strong>
            <AvCounter value={formatCount(frame.totals.online)} />
          </strong>
          <small>{onlineRate} 在线率</small>
        </div>
        <div className={s.statusCell} style={metricTone("danger")}>
          <span>离线</span>
          <strong>
            <AvCounter value={formatCount(frame.totals.offline)} />
          </strong>
          <small>需现场核查</small>
        </div>
        <div className={s.statusCell} style={metricTone("warning")}>
          <span>维护中</span>
          <strong>
            <AvCounter value={formatCount(frame.totals.maintenance)} />
          </strong>
          <small>计划内停机</small>
        </div>
      </div>

      <div className={s.gridTwo}>
        <AvPanel
          title="站点在线情况"
          subtitle={`${frame.sites.length} 个站点 · 在线 / 离线 / 维护中构成，折线为在线率`}
          icon="overview"
          meta={`每 ${DEVICE_STREAM_TICK_SECONDS} 秒刷新`}
          motionKey="device-sites"
        >
          <AvStackedBarChart
            data={siteRows}
            series={SITE_STATUS_SERIES}
            rate={SITE_RATE_SERIES}
            height={AV_CHART_HEIGHT.lg}
            label="站点在线情况堆叠柱状图，折线为各站点在线率"
            footnote={(row) => `在线 ${row.online}/${row.total} · ${row.rate}%`}
          />
          <div className={s.chartFoot}>
            <AvLegend
              items={[
                ...SITE_STATUS_SERIES.map((item) => ({ label: item.label, tone: item.tone })),
                { label: SITE_RATE_SERIES.label, tone: SITE_RATE_SERIES.tone },
              ]}
            />
            <span className={s.chartFootChips}>
              {frame.sites.map((site) => (
                <span key={site.id} className={s.tagChip} data-device-site={site.id}>
                  {site.name} {site.online}/{site.total}
                </span>
              ))}
            </span>
          </div>
          <div className={s.firmwareRow}>
            <span className={s.softNote}>信号健康</span>
            <span className={s.tagChip}>平均 {summary.signalHealth.avg.toFixed(1)}</span>
            <span className={s.tagChip}>P10 {summary.signalHealth.p10}</span>
            <span className={s.tagChip}>P50 {summary.signalHealth.p50}</span>
            <span className={s.tagChip}>P90 {summary.signalHealth.p90}</span>
          </div>
        </AvPanel>

        <AvPanel
          title="状态分布"
          subtitle="全量设备当前状态"
          icon="device"
          meta={`${frame.byStatus.length} 种状态`}
          motionKey="device-status"
        >
          <AvDonut
            data={donut.map((row) => ({ label: row.label, value: row.value, tone: row.tone }))}
            centerValue={formatCount(frame.totals.total)}
            centerLabel="设备总数"
            centerTone={seriesTone(1)}
            height={AV_CHART_HEIGHT.md}
            label="设备状态分布环形图"
          />
          <AvLegend
            items={donut.map((row) => ({ label: row.label, value: formatCount(row.value), tone: row.tone }))}
          />
        </AvPanel>
      </div>

      <div className={s.gridTwo}>
        <AvPanel
          title="近 24 小时在线率趋势"
          subtitle={`每 2 小时一个采样点 · 末端为当前值（每 ${DEVICE_STREAM_TICK_SECONDS} 秒刷新）`}
          icon="event"
          meta={`${frame.sites.length} 个站点`}
          motionKey="device-trend"
        >
          <AvMultiTrendChart
            data={frame.trend}
            series={siteTrendSeries}
            height={AV_CHART_HEIGHT.lg}
            label="近 24 小时各站点在线率趋势图"
            unit="%"
            domain={trendDomain}
            ticks={percentTicks(trendDomain)}
          />
          <div className={s.chartFoot}>
            <AvLegend
              items={frame.sites.map((site, index) => ({
                label: site.name,
                value: formatPercent(site.rate),
                tone: seriesToneFor(index),
              }))}
            />
            <span className={s.softNote}>按最近心跳回推，最新一点为当前在线率</span>
          </div>
        </AvPanel>

        <AvPanel
          title="型号构成"
          subtitle={`${summary.byModel.length} 种型号 · 按台数排序`}
          icon="chip"
          meta={`${formatCount(summary.total)} 台`}
          motionKey="device-models"
        >
          <AvHorizontalBarChart
            data={summary.byModel.map((model) => ({
              label: `${model.typeName} · ${model.model}`,
              value: model.count,
            }))}
            valueLabel="台数"
            height={AV_CHART_HEIGHT.lg}
            label="设备型号构成横向柱状图"
          />
          <div className={s.chartFoot}>
            <span className={s.softNote}>
              合计 {formatCount(summary.byModel.reduce((sum, model) => sum + model.count, 0))} 台 · 覆盖{" "}
              {summary.byModel.length} 种型号
            </span>
          </div>
        </AvPanel>
      </div>

      <div className={s.splitWide}>
        <AvPanel
          title="设备台账"
          subtitle={`筛选出 ${formatCount(filtered.length)} 台 · 已显示 ${formatCount(paged.length)} 台`}
          icon="device"
          motionKey="device-table"
        >
          <div className={s.deviceFilters}>
            <AvTabs items={statusTabs} value={statusFilter} onChange={setStatusFilter} ariaLabel="设备状态筛选" />
            <AvTabs
              items={[
                { value: "all" as const, label: "全部类型" },
                { value: "audio" as const, label: "音频" },
                { value: "video" as const, label: "视频" },
              ]}
              value={kindFilter}
              onChange={setKindFilter}
              ariaLabel="设备类型筛选"
            />
            <label className={s.alarmSearch}>
              <AvGlyph name="search" size={14} />
              <input
                type="search"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setPage(1);
                }}
                placeholder="搜索设备编号、点位、型号"
                aria-label="搜索设备"
              />
            </label>
          </div>

          {paged.length === 0 ? (
            <div style={{ marginTop: 10 }}>
              <AvEmpty title="没有匹配的设备" hint="清空搜索或切换状态筛选。" />
            </div>
          ) : (
            <div className={s.tableWrapper} style={{ marginTop: 8 }}>
              <table className={s.table}>
                <thead>
                  <tr>
                    <th>设备编号</th>
                    <th>点位</th>
                    <th>型号</th>
                    <th>类型</th>
                    <th>状态</th>
                    <th className={s.num}>信号</th>
                    <th className={s.num}>CPU</th>
                    <th className={s.num}>存储</th>
                    <th className={s.num}>心跳</th>
                  </tr>
                </thead>
                <tbody>
                  {paged.map((device, index) => (
                    <tr
                      key={device.id}
                      className={`${s.eventTableRow} ${staggerProps(index, paged.length, motionEnabled).className}`}
                      style={staggerProps(index, paged.length, motionEnabled).style}
                      onClick={() => openDevice(device)}
                    >
                      <td className={s.mono}>
                        <button type="button" className={s.tableButton} onClick={() => openDevice(device)}>
                          {device.id}
                        </button>
                      </td>
                      <td title={device.room}>{device.room}</td>
                      <td className={s.mono}>{device.model}</td>
                      <td className={s.nowrap}>{device.typeName}</td>
                      <td>
                        <AvStatusBadge tone={DEVICE_STATUS_TONE[device.status] as AvTone}>
                          {DEVICE_STATUS_LABEL[device.status]}
                        </AvStatusBadge>
                      </td>
                      <td className={s.num}>{device.signal}</td>
                      <td className={s.num}>{device.cpu}%</td>
                      <td className={s.num}>{device.storage}%</td>
                      <td className={s.num}>{compactAge(device.heartbeatOffsetMinutes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className={s.alarmFoot}>
            <span className={s.softNote}>
              共 {formatCount(filtered.length)} 台 · 每页 {PAGE} 台
            </span>
            {paged.length < filtered.length ? (
              <button type="button" className={s.ghostButton} onClick={() => setPage((value) => value + 1)}>
                显示更多
              </button>
            ) : (
              <span className={s.softNote}>已显示全部</span>
            )}
          </div>
        </AvPanel>

        <div className={s.railStack}>
          <AvPanel
            title="离线与维护清单"
            subtitle="离线 / 维护中设备，按最近心跳倒序"
            icon="alarm"
            meta={<span style={metricTone("danger")}>{`${attention.length} 台`}</span>}
            motionKey="device-attention"
          >
            {attention.length === 0 ? (
              <AvEmpty title="全部设备在线" hint="没有需要现场核查的设备。" />
            ) : (
              <ul className={s.attentionList}>
                {attention.slice(0, 10).map((device) => (
                  <li key={device.id} className={s.attentionItem}>
                    <div className={s.attentionTop}>
                      <strong title={device.room}>{device.room}</strong>
                      <AvStatusBadge tone={DEVICE_STATUS_TONE[device.status] as AvTone}>
                        {DEVICE_STATUS_LABEL[device.status]}
                      </AvStatusBadge>
                    </div>
                    <span className={s.attentionMeta}>
                      <span>{device.id}</span>
                      <span>{attentionAgeText({ status: device.status, last_heartbeat_offset_minutes: device.heartbeatOffsetMinutes })}</span>
                      <span>固件 {device.firmware}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </AvPanel>

          <AvPanel
            title="OTA 升级"
            subtitle={`近 180 天固件升级结果 · ${formatCount(frame.ota.total)} 次任务`}
            icon="capability"
            meta={<span style={metricTone("success")}>{formatPercent(frame.ota.rate)}</span>}
            motionKey="device-ota"
          >
            <AvDonut
              data={[
                { label: "成功", value: frame.ota.success, tone: "success" },
                { label: "失败", value: frame.ota.failed, tone: "danger" },
              ]}
              centerValue={formatPercent(frame.ota.rate)}
              centerLabel="成功率"
              centerTone="success"
              height={AV_CHART_HEIGHT.sm}
              label="OTA 升级成功率环形图"
            />
            <div className={s.railRow} style={metricTone("signal")}>
              <span>升级任务</span>
              <strong>
                <AvCounter value={formatCount(frame.ota.total)} />
              </strong>
            </div>
            <div className={s.railRow} style={metricTone("success")}>
              <span>成功</span>
              <strong>
                <AvCounter value={formatCount(frame.ota.success)} />
              </strong>
            </div>
            <div className={s.railRow} style={metricTone("danger")}>
              <span>失败</span>
              <strong>
                <AvCounter value={formatCount(frame.ota.failed)} />
              </strong>
            </div>
            <div className={s.railRow} style={metricTone("success")}>
              <span>成功率</span>
              <strong>{formatPercent(frame.ota.rate)}</strong>
            </div>
          </AvPanel>
        </div>
      </div>

      <dialog
        ref={dialogRef}
        className={s.dialog}
        aria-label={selected ? `设备详情 ${selected.id}` : "设备详情"}
        onCancel={(event) => {
          event.preventDefault();
          closeDevice();
        }}
        onClose={() => setSelectedId(null)}
        onClick={(event) => {
          if (event.target === dialogRef.current) closeDevice();
        }}
      >
        {selected && <DeviceDetail device={selected} onClose={closeDevice} />}
      </dialog>
    </div>
  );
}

function DeviceDetail({ device, onClose }: { device: DeviceRow; onClose: () => void }) {
  const offline = device.status === "offline";
  return (
    <>
      <div className={s.dialogHead}>
        <div className={s.dialogHeadMain}>
          <div className={s.dialogTitle}>
            <AvStatusBadge tone={DEVICE_STATUS_TONE[device.status] as AvTone}>
              {DEVICE_STATUS_LABEL[device.status]}
            </AvStatusBadge>
            <span className={s.softNote}>{device.id}</span>
          </div>
          <h2>{device.room}</h2>
        </div>
        <button type="button" className={s.dialogClose} onClick={onClose} aria-label="关闭设备详情">
          ✕
        </button>
      </div>
      <div className={s.dialogBody}>
        <div className={s.dialogSection}>
          <h3 className={s.dialogSectionTitle}>台账</h3>
          <AvKV
            rows={[
              { label: "站点", value: device.siteName },
              { label: "型号", value: `${device.typeName} · ${device.model}` },
              { label: "固件", value: device.firmware },
              { label: "最近心跳", value: `${toAbsolute(device.heartbeatOffsetMinutes)}（${toRelative(device.heartbeatOffsetMinutes)}）` },
              { label: "在线时长", value: `${formatCount(device.uptimeDays)} 天` },
              { label: "信号质量", value: offline ? "离线" : `${device.signal} / 100` },
              { label: "CPU / 存储", value: `${device.cpu}% / ${device.storage}%` },
              { label: "麦克风灵敏度", value: device.micSensitivityDbm == null ? "—" : `${device.micSensitivityDbm} dBm` },
            ]}
          />
        </div>

        <div className={s.dialogSection}>
          <h3 className={s.dialogSectionTitle}>信号强度（近 24 小时）</h3>
          {offline ? (
            <AvEmpty title="设备离线" hint="离线设备暂无信号强度曲线。" />
          ) : (
            <AvSignalChart data={device.signalSeries} label={`${device.id} 信号强度曲线`} />
          )}
        </div>

        <div className={s.dialogSection}>
          <h3 className={s.dialogSectionTitle}>自检</h3>
          <AvKV
            rows={[
              { label: "最近自检", value: `${toAbsolute(device.selfCheck.atOffsetMinutes)} · ${device.selfCheck.result}` },
              { label: "检查项", value: device.selfCheck.items.join(" · ") || "—" },
              ...device.selfCheckHistory.slice(0, 2).map((record, index) => ({
                label: `历史 ${index + 1}`,
                value: `${toAbsolute(record.atOffsetMinutes)} · ${record.result} · ${record.items.join(" · ")}`,
              })),
            ]}
          />
        </div>

        <div className={s.dialogSection}>
          <h3 className={s.dialogSectionTitle}>OTA 记录</h3>
          {device.otaRecords.length === 0 ? (
            <p className={s.softNote}>无升级记录。</p>
          ) : (
            <AvKV
              rows={device.otaRecords.slice(0, 3).map((record) => ({
                label: record.id,
                value: `${record.fromVersion} → ${record.toVersion} · ${record.status === "success" ? "成功" : "失败"} · ${record.trigger} · ${toAbsolute(record.atOffsetMinutes)}`,
              }))}
            />
          )}
        </div>

        <p className={s.softNote}>设备存储占用 {formatGb((device.storage / 100) * 64)} / 64 GB（按 64GB 容量估算）</p>
      </div>
    </>
  );
}
