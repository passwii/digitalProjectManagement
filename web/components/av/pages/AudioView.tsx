"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Spectrum, Transcript } from "@/lib/av/types";
import { formatCount, formatPercent, formatSeconds, levelMeta, transcriptLanguageLabel, type AvTone } from "@/lib/av/labels";
import { useTheme } from "@/components/theme/ThemeProvider";
import { parseCssColor, spectrumPixels } from "@/lib/av/color";
import { AvKV, AvLevelBadge, AvPageHeader, AvPanel } from "@/components/av/AvUI";
import { usePlayhead } from "@/components/av/motion/AvMotion";
import type { AudioViewProps } from "@/lib/av/contracts";
import s from "./AvPages.module.css";

const SPEAKER_TONES: AvTone[] = ["signal", "violet", "warning", "success", "neutral"];

/**
 * base64 → 字节数组。
 *
 * 刻意不用 `window.atob`：波形是**服务端渲染**的（首屏就该有形状），而 atob 只在
 * 浏览器里存在；用它会渲染出一条空白框，等 hydration 才补上。这里是一个不依赖
 * 运行时的小解码器，服务端与客户端走同一条路径。
 */
const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function decodeBase64(value: string): Uint8Array {
  const clean = value.replace(/[^A-Za-z0-9+/]/g, "");
  const length = Math.floor((clean.length * 3) / 4);
  const bytes = new Uint8Array(length);
  let buffer = 0;
  let bits = 0;
  let offset = 0;
  for (const char of clean) {
    const index = BASE64_ALPHABET.indexOf(char);
    if (index < 0) continue;
    buffer = (buffer << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[offset] = (buffer >> bits) & 0xff;
      offset += 1;
    }
  }
  return bytes.subarray(0, offset);
}

/**
 * 频谱热力图用 canvas：96 × 480 = 46,080 个格子，逐个渲染成 DOM 会直接卡死页面。
 * 这不是「图表」（recharts 的折线/柱状），而是一张二维矩阵图，canvas 是正确工具。
 * 颜色在运行时从 --av-signal 读取（不写死 hex），主题切换时重绘。
 */
export function Spectrogram({ spectrum }: { spectrum: Spectrum }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // 同 useAvPalette：必须依赖「已落主题」，否则点切换时读到的是上一套令牌，
  // 频谱会一直保持旧配色直到刷新。
  const { appliedTheme } = useTheme();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const bytes = decodeBase64(spectrum.data);
    if (!bytes.length) return;
    canvas.width = spectrum.cols;
    canvas.height = spectrum.bins;
    const context = canvas.getContext("2d");
    if (!context) return;
    const styles = getComputedStyle(document.documentElement);
    // 浅色主题下 --av-surface 可能是 `#fff`（3 位缩写）；解析失败时宁可降级为透明底，
    // 也不能退回某个主题的写死色（review 缺陷 2）。
    const signal = parseCssColor(styles.getPropertyValue("--av-signal"));
    const surface = parseCssColor(styles.getPropertyValue("--av-surface"));
    if (!signal) return;
    const image = context.createImageData(spectrum.cols, spectrum.bins);
    image.data.set(spectrumPixels(bytes, spectrum.bins, spectrum.cols, signal, surface));
    context.putImageData(image, 0, 0);
  }, [spectrum, appliedTheme]);

  return (
    <canvas
      ref={canvasRef}
      className={s.spectrogram}
      role="img"
      aria-label={`频谱图：${spectrum.bins} 个频段 × ${spectrum.cols} 帧，共 ${spectrum.seconds} 秒`}
    />
  );
}

function Waveform({ spectrum }: { spectrum: Spectrum }) {
  const points = useMemo(() => {
    const min = decodeBase64(spectrum.waveform.min);
    const max = decodeBase64(spectrum.waveform.max);
    const mid = spectrum.waveform.mid;
    if (!min.length) return { upper: "", lower: "" };
    const step = Math.max(1, Math.floor(min.length / 420));
    const upper: string[] = [];
    const lower: string[] = [];
    for (let index = 0; index < min.length; index += step) {
      const x = (index / (min.length - 1)) * 1000;
      // uint8 → 以 mid 为中心的正负偏移，映射到 0..100 的 SVG 坐标
      // min / max 两条包络分别向上、向下画，才是真实的波形包络而不是单边锯齿
      const low = min[index] ?? mid;
      const high = max[index] ?? mid;
      upper.push(`${x.toFixed(1)},${(50 - ((high - mid) / 128) * 46).toFixed(1)}`);
      lower.push(`${x.toFixed(1)},${(50 - ((low - mid) / 128) * 46).toFixed(1)}`);
    }
    return { upper: upper.join(" "), lower: lower.join(" ") };
  }, [spectrum]);

  return (
    <svg className={s.waveSvg} viewBox="0 0 1000 100" preserveAspectRatio="none" role="img" aria-label="波形包络">
      <polyline points={points.upper} />
      <polyline points={points.lower} />
    </svg>
  );
}

export default function AudioView({ alarm, spectrum, transcript, samples }: AudioViewProps) {
  /**
   * 播放游标的位置（秒）与「当前句」。
   *
   * 位置只写进 DOM（rAF 直接 transform），**不进 state** —— 每帧 setState 会让
   * 整个页面（含 46,080 格的频谱与 30 多条转写）重渲染，60fps 直接没戏。
   * 只有跨越句子边界时才 setState 换高亮，大约每 2~4 秒一次。
   */
  const [playing, setPlaying] = useState(false);
  const [activeSegment, setActiveSegment] = useState(-1);
  const activeRef = useRef(-1);
  // useMemo 固定引用：它进 syncSegment 的 useCallback 依赖，每次渲染换新数组
  // 会让回调重生、进而在播放时反复重建 rAF 循环
  const segments = useMemo(() => transcript?.segments ?? [], [transcript]);

  const syncSegment = useCallback(
    (seconds: number) => {
      const index = segments.findIndex((segment) => seconds >= segment.start && seconds < segment.end);
      const next = index === -1 && seconds >= (segments.at(-1)?.end ?? 0) ? segments.length - 1 : index;
      if (next !== activeRef.current) {
        activeRef.current = next;
        setActiveSegment(next);
      }
    },
    [segments],
  );

  // 没有音频文件（mock 数据只有频谱矩阵），游标以「1 倍速走完 spectrum.seconds」演示
  const { barRef: playheadRef, reset: resetPlayhead } = usePlayhead(spectrum.seconds, playing, syncSegment);

  const togglePlay = () => {
    // 播完 / 停在末尾后再点播放：从头开始（游标 + 当前句一起归零）
    if (!playing && activeRef.current >= segments.length - 1) {
      activeRef.current = -1;
      setActiveSegment(-1);
      resetPlayhead();
    }
    setPlaying((value) => !value);
  };

  const speakerById = useMemo(
    () => new Map((transcript?.speakers ?? []).map((speaker) => [speaker.id, speaker])),
    [transcript],
  );
  const profileLabel: Record<string, string> = {
    bullying: "欺凌言语",
    quarrel: "高声争吵",
    scream: "哭喊 / 呼救",
    glass: "玻璃破碎",
    speech: "正常对话",
    noise: "环境噪声",
  };

  return (
    <div className={s.page} data-av-page="audio">
      <AvPageHeader
        route="/stream-monitor/audio"
        title="音频分析"
        aside={
          <div className={s.audioPicker}>
            {samples.slice(0, 4).map((sample) => (
              <Link
                key={sample.alarmId}
                href={`/stream-monitor/audio?alarm=${sample.alarmId}`}
                className={s.audioPick}
                aria-current={sample.alarmId === alarm.id}
              >
                {sample.alarmId}
              </Link>
            ))}
          </div>
        }
      />

      <AvPanel
        title={alarm.title}
        subtitle={`${alarm.room} · ${alarm.typeName}`}
        icon="monitor"
        meta={`${formatSeconds(spectrum.seconds)} · ${formatCount(spectrum.bins)} 个频段`}
        motionKey="audio-meta"
      >
        <div className={s.dialogTitle} style={{ marginBottom: 10 }}>
          <AvLevelBadge level={alarm.level} label={alarm.levelLabel} />
          <span className={s.softNote}>{alarm.id}</span>
          <span className={s.tagChip}>{profileLabel[spectrum.profile] ?? spectrum.profile}</span>
          <span className={s.tagChip}>{spectrum.id}</span>
        </div>
        <div className={s.audioMeta}>
          <span>时长 <b>{formatSeconds(spectrum.seconds)}</b></span>
          <span>采样列 <b>{spectrum.cols}</b></span>
          <span>频段 <b>{spectrum.bins}</b></span>
          <span>频率分辨率 <b>{spectrum.binHz} Hz</b></span>
          <span>帧间隔 <b>{spectrum.colMs} ms</b></span>
          <span>峰值点 <b>{spectrum.peaks.length}</b></span>
          {transcript && <span>关键词命中 <b>{transcript.keyword_hits.length}</b></span>}
        </div>
      </AvPanel>

      <div className={s.splitWide}>
        <AvPanel
          title="频谱图"
          icon="wave"
          meta={`${spectrum.colMs}ms / 帧`}
          motionKey="audio-spectrogram"
        >
          {/*
            频谱单独包一层：::after 遮罩从下往上收（slow）做「擦除式揭示」。
            游标是这一层里的独立 span，位置由 rAF 写 transform —— 不重绘 canvas。
          */}
          <div className={s.spectroWrap}>
            <Spectrogram spectrum={spectrum} />
            <span ref={playheadRef} className={s.playhead} aria-hidden="true" />
          </div>
          <div className={s.playRow}>
            <button
              type="button"
              className={s.ghostButton}
              onClick={togglePlay}
              aria-pressed={playing}
              aria-label={playing ? "暂停频谱游标" : "播放频谱游标"}
            >
              {playing ? "暂停" : "播放"}
            </button>
            {/* 诚实说明保留（站点确实没有音频文件），实现细节（rAF / CSS transition /
                base64 解码方式）不上屏 —— 那是给维护者的话，不是给访客的。 */}
            <span className={s.softNote}>
              当前仅提供频谱与转写文本，未包含音频文件；游标按 1 倍速走完 {formatSeconds(spectrum.seconds)}。
            </span>
          </div>
          <div style={{ marginTop: 10 }}>
            <Waveform spectrum={spectrum} />
          </div>
        </AvPanel>

        <div className={s.railStack}>
          <AvPanel title="频谱画像" icon="chip" motionKey="audio-facts">
            <AvKV
              rows={[
                { label: "画像", value: profileLabel[spectrum.profile] ?? spectrum.profile },
                { label: "级别", value: `${levelMeta(alarm.level as 1 | 2 | 3 | 4).label}` },
                { label: "证据", value: `音频 ${formatSeconds(spectrum.seconds)}` },
                {
                  label: "峰值",
                  value: spectrum.peaks
                    .slice(0, 3)
                    .map((peak) => `${formatPercent(peak.amplitude * 100, 0)} @ ${(peak.at_ms / 1000).toFixed(1)}s`)
                    .join(" · "),
                },
              ]}
            />
          </AvPanel>

          {transcript && (
            <AvPanel
              title="转写与关键词"
              subtitle={`${transcriptLanguageLabel(transcript.language)} · ${transcript.speakers.length} 位说话人`}
              icon="event"
              meta={`${transcript.segments.length} 句`}
              motionKey="audio-transcript"
            >
              <ul className={s.keywordList} style={{ marginBottom: 10 }}>
                {transcript.keyword_hits.map((keyword) => (
                  <li key={keyword} className={s.keywordChip}>{keyword}</li>
                ))}
              </ul>
              <ul className={s.transcript}>
                {transcript.segments.map((segment, index) => {
                  const speaker = segment.speaker ? speakerById.get(segment.speaker) : null;
                  const tone = speaker ? SPEAKER_TONES[speaker.index % SPEAKER_TONES.length] : "neutral";
                  return (
                    <li
                      key={`${segment.start}-${index}`}
                      className={s.transcriptLine}
                      data-motion="transcript-line"
                      data-motion-index={index}
                      data-active={activeSegment === index ? "true" : undefined}
                    >
                      <span className={s.transcriptTime}>{(segment.start).toFixed(1)}s</span>
                      <span className={s.speaker} style={{ "--speaker": `var(--av-tone-${tone})` } as React.CSSProperties}>
                        <i aria-hidden="true" />
                        {speaker?.label ?? "环境音"}
                      </span>
                      <span className={s.transcriptText}>
                        {segment.highlight.length === 0
                          ? segment.text
                          : renderHighlighted(segment.text, segment.highlight.map((item) => item.word))}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </AvPanel>
          )}
        </div>
      </div>
    </div>
  );
}

/** 把命中关键词包成高亮，保持原句字符顺序（不重排、不丢标点）。 */
function renderHighlighted(text: string, words: string[]) {
  if (words.length === 0) return text;
  const escaped = words
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (escaped.length === 0) return text;
  const parts = text.split(new RegExp(`(${escaped.join("|")})`, "g"));
  return parts.map((part, index) =>
    words.includes(part) ? (
      <mark key={`${part}-${index}`} className={s.highlight}>{part}</mark>
    ) : (
      <span key={`text-${index}`}>{part}</span>
    ),
  );
}
