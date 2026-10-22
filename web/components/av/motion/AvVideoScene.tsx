import type { CSSProperties } from "react";
import s from "./AvMotion.module.css";
import { formatTimecode } from "@/lib/av/timecode";
import {
  VIDEO_CODEC_LINE,
  VIDEO_DETECTION_LABEL,
  VIDEO_NO_SIGNAL_LABEL,
  VIDEO_REGION_LABEL,
  type AvDetectionClass,
} from "@/lib/av/labels";

/**
 * 合成监控画面（Stage 3 / BLF-1425）。
 *
 * 演示站没有真实视频流，也**不允许**往 `public/` 塞视频 / 图片资源，所以这一层
 * 用纯 CSS + SVG 之外的几个绝对定位盒子合成「一眼像监控」的画面：
 *
 *   · 网格底 + 轻噪点：静态网格 + 一层半透明噪点（transform 平移，不动 background）；
 *   · 扫描线：上下缓慢扫过（`avScanDrop`），只动 transform；
 *   · 2–3 个检测框：错峰出现、轻微漂移，标签与置信度来自 props（按 seed 微调位置）；
 *   · ROI 高亮：虚线框 + 内部呼吸，表示「正在分析的区域」；
 *   · 右下时间码：与 LIVE 块同源（父级只跑一个 1s 定时器，两处显示同一个帧号）。
 *
 * 颜色全部是 `--av-series-*` / `--av-*` 令牌；离线通道 `data-scene="offline"` 时
 * 所有动画被 CSS 显式关掉（不依赖全局开关，单卡离线也要静止）：扫描线 / 检测框 /
 * ROI 直接不渲染，噪点换成**没有 animation 的** `.videoNoiseIdle`。为什么离线还留
 * 噪点：冻结帧的颗粒感是「这路信号还活着、只是没人动」的视觉线索，但它必须是静的。
 */

export interface AvVideoBox {
  /** 检测类别：机器可读值，展示时经 `VIDEO_DETECTION_LABEL` 映射成中文。 */
  label: AvDetectionClass;
  /** 置信度 0–1。 */
  confidence: number;
  /** 框的位置与尺寸（百分比，相对画面）。 */
  x: number;
  y: number;
  width: number;
  height: number;
  /** 出现相位（0–1.5 个周期），同一张卡里的框必须错开。 */
  phase: number;
  /** 颜色令牌序号：1 / 4 / 8（青 / 品红 / 水绿）。 */
  tone: 1 | 4 | 8;
}

/** 按 seed 生成 3 个检测框：位置与相位都不同，但完全确定性（SSR 与截图一致）。 */
export function videoBoxesOf(seed: number): AvVideoBox[] {
  const jitter = (salt: number) => {
    let value = (seed + Math.imul(salt + 1, 0x85ebca6b)) >>> 0;
    value = Math.imul(value ^ (value >>> 13), 0xc2b2ae35);
    return ((value ^ (value >>> 16)) >>> 0) / 4294967296;
  };
  /*
   * 三个框各有自己的「窝」：左上 6–34% 是 LIVE 徽标与 ROI 的位置，检测框必须
   * 避开（否则标签会压住时间码）。位置只在预设点附近 ±2–4% 抖动，保证同一张
   * 卡里的框不会叠成一团、不同卡的框也不会完全一样。
   */
  type BoxPreset = Omit<AvVideoBox, "phase">;
  const presets: BoxPreset[] = [
    { label: "person", confidence: 0.96, tone: 1, x: 38, y: 34, width: 18, height: 36 },
    { label: "person", confidence: 0.88, tone: 8, x: 60, y: 22, width: 15, height: 30 },
    { label: "vehicle", confidence: 0.79, tone: 4, x: 52, y: 58, width: 20, height: 30 },
  ];
  return presets.map((preset, index) => ({
    ...preset,
    confidence: Math.min(0.99, preset.confidence - jitter(index + 7) * 0.08),
    x: preset.x + (jitter(index + 1) - 0.5) * 8,
    y: preset.y + (jitter(index + 2) - 0.5) * 6,
    width: preset.width + (jitter(index + 3) - 0.5) * 4,
    height: preset.height + (jitter(index + 4) - 0.5) * 4,
    phase: index * 0.42 + jitter(index + 5) * 0.3,
  }));
}

export default function AvVideoScene({
  seed,
  frame,
  state = "online",
  codec = VIDEO_CODEC_LINE,
}: {
  seed: number;
  frame: number;
  state?: "online" | "offline" | "maintenance";
  codec?: string;
}) {
  const offline = state !== "online";
  const boxes = offline ? [] : videoBoxesOf(seed);

  return (
    <div
      className={s.videoScene}
      data-scene={offline ? "offline" : "online"}
      data-video-seed={seed}
      data-video-frame={frame}
      data-video-motion={offline ? "off" : "on"}
      aria-hidden="true"
    >
      <span className={s.videoGrid} />
      {/* 噪点：在线抖（avNoiseShift），离线是冻结帧 —— 换一个不带 animation 的类 */}
      <span
        className={offline ? s.videoNoiseIdle : s.videoNoise}
        data-video-noise={offline ? "off" : "on"}
      />
      {!offline && <span className={s.videoScan} />}
      {!offline && (
        <span
          className={s.videoRoi}
          style={{ "--av-roi-delay": (0.15 + (seed % 7) / 20).toFixed(3) } as CSSProperties}
        >
          {VIDEO_REGION_LABEL}
        </span>
      )}
      {boxes.map((box, index) => (
        <span
          key={`${box.label}-${index}`}
          className={s.videoBox}
          data-tone={box.tone}
          style={
            {
              left: `${box.x}%`,
              top: `${box.y}%`,
              width: `${box.width}%`,
              height: `${box.height}%`,
              "--av-box-phase": box.phase.toFixed(3),
            } as CSSProperties
          }
        >
          <span className={s.videoBoxLabel}>
            {VIDEO_DETECTION_LABEL[box.label]} {Math.round(box.confidence * 100)}%
          </span>
        </span>
      ))}
      <span className={s.videoMeta}>{offline ? VIDEO_NO_SIGNAL_LABEL : codec}</span>
      <span className={s.videoClock}>{offline ? "--:--:--" : formatTimecode(frame)}</span>
    </div>
  );
}
