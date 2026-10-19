"use client";

import { useMemo, useRef, useState } from "react";
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
import { AvBar, AvEmpty, AvKV, AvLegend, AvPageHeader, AvPanel, AvStatusBadge } from "@/components/av/AvUI";
import { AvDonut, AvSignalChart } from "@/components/av/AvCharts";
import { attentionAgeText } from "@/lib/av/view";
import AvGlyph from "@/components/av/AvGlyph";
import AvTabs from "@/components/av/AvTabs";
import { closeDialogWithMotion, openDialogWithMotion } from "@/components/av/motion/AvDialog";
import { staggerProps } from "@/components/av/motion/AvMotion";
import { useAvMotion } from "@/components/av/motion/AvMotionProvider";
import s from "./AvPages.module.css";
import type { DeviceRow, DeviceViewProps } from "@/lib/av/contracts";

const PAGE = 24;

export default function DeviceView({ devices, summary }: DeviceViewProps) {
  const [statusFilter, setStatusFilter] = useState<"all" | DeviceStatus>("all");
  const [kindFilter, setKindFilter] = useState<"all" | "audio" | "video">("all");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const { enabled: motionEnabled } = useAvMotion();

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

  const statusTabs = [
    { value: "all" as const, label: "全部", count: summary.total },
    ...summary.byStatus.map((row) => ({
      value: row.status,
      label: DEVICE_STATUS_LABEL[row.status],
      count: row.count,
    })),
  ];

  const donut = summary.byStatus.map((row) => ({
    status: row.status,
    label: DEVICE_STATUS_LABEL[row.status],
    value: row.count,
    tone: DEVICE_STATUS_TONE[row.status] as AvTone,
  }));
  const modelTotal = Math.max(1, ...summary.byModel.map((model) => model.count));
  const attention = devices
    .filter((device) => device.status !== "online")
    .sort((a, b) => b.heartbeatOffsetMinutes - a.heartbeatOffsetMinutes);

  return (
    <div className={s.page} data-av-page="device">
      <AvPageHeader
        route="/stream-monitor/device"
        title="设备管理"
        subtitle="设备台账、在线率与离线清单。离线时长来自最近心跳偏移；固件与自检历史来自设备画像字段。"
        aside={<span className={s.anchorChip}>OTA {summary.ota.success}/{summary.ota.total} 成功</span>}
      />

      <div className={s.statusGrid}>
        <div className={s.statusCell}>
          <span>设备总数</span>
          <strong>{formatCount(summary.total)}</strong>
          <small>覆盖 {summary.bySite.length} 个站点</small>
        </div>
        <div className={s.statusCell}>
          <span>在线</span>
          <strong>{formatCount(summary.online)}</strong>
          <small>{formatPercent((summary.online / Math.max(1, summary.total)) * 100)} 在线率</small>
        </div>
        <div className={s.statusCell}>
          <span>离线</span>
          <strong>{formatCount(summary.offline)}</strong>
          <small>需现场核查</small>
        </div>
        <div className={s.statusCell}>
          <span>维护中</span>
          <strong>{formatCount(summary.maintenance)}</strong>
          <small>计划内停机</small>
        </div>
      </div>

      <div className={s.gridTwo}>
        <AvPanel title="状态分布" subtitle="全量设备当前状态" icon="device" meta={`${summary.byStatus.length} 种状态`} motionKey="device-status">
          <AvDonut
            data={donut.map((row) => ({ label: row.label, value: row.value, tone: row.tone }))}
            centerValue={formatCount(summary.total)}
            centerLabel="设备总数"
            height={176}
            label="设备状态分布环形图"
          />
          <AvLegend
            items={donut.map((row) => ({ label: row.label, value: formatCount(row.value), tone: row.tone }))}
          />
        </AvPanel>

        <AvPanel title="站点在线情况" subtitle="按站点统计在线 / 离线" icon="overview" motionKey="device-sites">
          <div className={s.typeList}>
            {summary.bySite.map((site) => (
              <AvBar
                key={site.id}
                label={site.name}
                value={site.online}
                max={site.total}
                tone={site.rate >= 95 ? "success" : "warning"}
                detail={`${site.online}/${site.total} · ${formatPercent(site.rate)}`}
              />
            ))}
          </div>
          <div className={s.firmwareRow}>
            <span className={s.softNote}>信号健康</span>
            <span className={s.tagChip}>平均 {summary.signalHealth.avg.toFixed(1)}</span>
            <span className={s.tagChip}>P10 {summary.signalHealth.p10}</span>
            <span className={s.tagChip}>P50 {summary.signalHealth.p50}</span>
            <span className={s.tagChip}>P90 {summary.signalHealth.p90}</span>
          </div>
        </AvPanel>
      </div>

      <div className={s.splitWide}>
        <AvPanel
          title="设备台账"
          subtitle={`筛选出 ${formatCount(filtered.length)} 台 · 已显示 ${formatCount(paged.length)} 台`}
          icon="device"
          meta="点击行查看设备详情"
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
            meta={`${attention.length} 台`}
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

          <AvPanel title="型号构成" subtitle="按型号统计台数" icon="chip" meta={`${summary.byModel.length} 种`} motionKey="device-models">
            <div className={s.typeList}>
              {summary.byModel.map((model) => (
                <AvBar
                  key={model.model}
                  label={`${model.typeName} · ${model.model}`}
                  value={model.count}
                  max={modelTotal}
                  tone="signal"
                  detail={`${formatCount(model.count)} 台`}
                />
              ))}
            </div>
          </AvPanel>

          <AvPanel title="OTA 升级" subtitle="近 180 天固件升级结果" icon="capability" motionKey="device-ota">
            <div className={s.railRow}>
              <span>升级任务</span>
              <strong>{formatCount(summary.ota.total)}</strong>
            </div>
            <div className={s.railRow}>
              <span>成功</span>
              <strong>{formatCount(summary.ota.success)}</strong>
            </div>
            <div className={s.railRow}>
              <span>失败</span>
              <strong>{formatCount(summary.ota.failed)}</strong>
            </div>
            <div className={s.railRow}>
              <span>成功率</span>
              <strong>{formatPercent((summary.ota.success / Math.max(1, summary.ota.total)) * 100)}</strong>
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
              { label: "信号质量", value: offline ? "离线（0 哨兵）" : `${device.signal} / 100` },
              { label: "CPU / 存储", value: `${device.cpu}% / ${device.storage}%` },
              { label: "麦克风灵敏度", value: device.micSensitivityDbm == null ? "—" : `${device.micSensitivityDbm} dBm` },
            ]}
          />
        </div>

        <div className={s.dialogSection}>
          <h3 className={s.dialogSectionTitle}>信号强度（近 24 小时）</h3>
          {offline ? (
            <AvEmpty title="设备离线" hint="离线设备的 RSSI 统一为 0 哨兵，不绘制曲线。" />
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

        <p className={s.softNote}>设备存储占用 {formatGb((device.storage / 100) * 64)} / 64 GB（按 64GB 容量估算，仅演示）</p>
      </div>
    </>
  );
}
