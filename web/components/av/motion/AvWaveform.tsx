import type { CSSProperties } from "react";
import s from "./AvMotion.module.css";

/**
 * 参数化音频波形（Stage 3 / BLF-1425）。
 *
 * 为什么不是「一段动画复制 6 份」：如果所有卡片共用同一个 keyframes + 同一组
 * delay，6 张卡会**同相位**起伏 —— 远看像一条被复制了 6 次的贴图，动效反而
 * 暴露了「这是假的」。这里把「柱高 / 周期 / 相位」都做成参数的派生值：
 *
 *   seed    每张卡的种子（MonitorView 用通道 id 的稳定哈希）；
 *   phase   相位（0–1 个周期），决定动画从哪一帧开始；
 *   speed   周期倍率：`animation-duration = calc(var(--av-dur-breathe) * speed)`；
 *   bars    柱数；
 *   state   online 才起伏；offline 压平、变灰、不挂任何动画变量。
 *
 * 三条实现约束：
 *   · **时长只能来自令牌**：周期用 `--av-dur-breathe`（3s）乘倍率，模块 CSS 里
 *     不出现毫秒字面量（`motion.vitest.test.ts` 的源码守卫会扫）；
 *   · **只动 transform**：柱子高度是最终值（inline height），动画只做 `scaleY`，
 *     不会触发 layout（`.wave` 固定 54px，`avLayoutTokens` 同行等高的前提）；
 *   · **服务端可渲染**：所有派生值只依赖 props，没有 hook / 随机数，SSR 与
 *     `?static=1` 截图的 DOM 完全一致（连拍 3 次 MD5 相同）。
 */

/** 32 位整数哈希：把任意字符串 / 序号压成稳定种子（不用 Math.random，保证 SSR 一致）。 */
export function waveformSeed(key: string, salt = 0): number {
  let hash = 2166136261 ^ salt;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** seed + 第 n 个数 → [0,1) 的确定性伪随机（mulberry32 的单步版）。 */
function unit(seed: number, salt: number): number {
  let value = (seed + Math.imul(salt + 1, 0x9e3779b9)) >>> 0;
  value = Math.imul(value ^ (value >>> 15), value | 1);
  value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
  return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export interface AvWaveformProps {
  /** 卡片种子：同一页每张卡不同，决定柱高抖动、周期与相位。 */
  seed: number;
  /** 相位（0–1 个周期）。缺省从 seed 派生。 */
  phase?: number;
  /** 周期倍率（相对 `--av-dur-breathe`）。缺省从 seed 派生到 0.72–1.44。 */
  speed?: number;
  /** 柱数。 */
  bars?: number;
  /** 离线态：扁平、灰、静止。 */
  state?: "online" | "offline";
  /** 真实波形（0–1，来自 `waveformOf()`）；只作为柱高的基准，不参与动画。 */
  values?: readonly number[];
  className?: string;
}

export default function AvWaveform({
  seed,
  phase,
  speed,
  bars = 26,
  state = "online",
  values,
  className,
}: AvWaveformProps) {
  const offline = state === "offline";
  const count = Math.max(1, Math.round(bars));
  const resolvedSpeed = clamp(speed ?? 0.72 + unit(seed, 3) * 0.72, 0.4, 2.4);
  const resolvedPhase = clamp(phase ?? unit(seed, 11), 0, 0.999);

  const items = Array.from({ length: count }, (_, index) => {
    const base = values && values.length > 0 ? values[index % values.length] : 0.4;
    const jitter = 0.82 + unit(seed, index + 29) * 0.36;
    // 离线：统一压到最低一根（和 waveformOf 的 0 哨兵同一口径），不再做抖动
    const height = offline ? 0.08 : clamp(base * jitter, 0.12, 1);
    // 相位 + 柱级偏移（0–1.6 个周期），全部以「周期倍率」为单位交给 CSS
    const delay = offline ? 0 : clamp(resolvedPhase + unit(seed, index + 101) * 0.8, 0, 2.4);
    return { height, delay };
  });

  const wrapperStyle = { "--av-wave-speed": String(resolvedSpeed) } as CSSProperties;

  return (
    <div
      className={`${s.wave} ${className ?? ""}`}
      data-waveform=""
      data-wave-seed={seed}
      data-wave-speed={String(resolvedSpeed)}
      data-wave-phase={String(resolvedPhase)}
      data-state={offline ? "offline" : "online"}
      data-bars={count}
      style={wrapperStyle}
      aria-hidden="true"
    >
      {items.map((item, index) => (
        <span
          key={index}
          className={offline ? s.waveBarIdle : s.waveBar}
          data-wave-bar={index}
          style={
            offline
              ? { height: `${Math.round(item.height * 100)}%` }
              : ({
                  height: `${Math.round(item.height * 100)}%`,
                  "--av-wave-delay": item.delay.toFixed(3),
                } as CSSProperties)
          }
        />
      ))}
    </div>
  );
}
