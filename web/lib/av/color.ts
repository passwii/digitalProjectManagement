/**
 * canvas 用色工具（纯函数，node:test 可测）。
 *
 * 为什么要自己解析颜色：
 *   canvas 的 `fillStyle` / `ImageData` 只吃具体 RGB，`var(--x)` 无效，所以频谱图必须在
 *   运行时读 `getComputedStyle(...).getPropertyValue("--av-signal")`。而浏览器对自定义属性
 *   的 computed value **不做统一规范化**：浅色主题下 `--av-surface` 可能就是 `#fff`
 *   （3 位缩写），深色是 `#0d1d2c`。原来的 `hexToRgb` 只认 6 位，遇到 `#fff` 直接回落到
 *   一个写死的深色主题青色，于是浅色主题下整块频谱变成亮青底 —— 这正是被 review 抓到的问题。
 *
 * 这里的约定：
 *   · 支持 `#rgb` / `#rgba` / `#rrggbb` / `#rrggbbaa` / `rgb()` / `rgba()`（逗号或空格分隔）；
 *   · 解析不了就返回 `null`，**绝不回落到某个主题的具体色值**；调用方据此决定降级方式。
 */

export type Rgb = [number, number, number];

function channel(token: string): number | null {
  const value = token.trim();
  if (!value) return null;
  if (value.endsWith("%")) {
    const percent = Number(value.slice(0, -1));
    if (!Number.isFinite(percent)) return null;
    return Math.round((Math.min(100, Math.max(0, percent)) / 100) * 255);
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.round(Math.min(255, Math.max(0, numeric)));
}

function fromHex(value: string): Rgb | null {
  if (!/^#?[0-9a-f]+$/i.test(value)) return null;
  const hex = value.replace("#", "");
  if (hex.length === 3 || hex.length === 4) {
    const r = parseInt(hex[0] + hex[0], 16);
    const g = parseInt(hex[1] + hex[1], 16);
    const b = parseInt(hex[2] + hex[2], 16);
    return [r, g, b];
  }
  if (hex.length === 6 || hex.length === 8) {
    return [
      parseInt(hex.slice(0, 2), 16),
      parseInt(hex.slice(2, 4), 16),
      parseInt(hex.slice(4, 6), 16),
    ];
  }
  return null;
}

function fromRgbFunction(value: string): Rgb | null {
  const match = /^rgba?\(([^)]+)\)$/i.exec(value.trim());
  if (!match) return null;
  // `rgb(1, 2, 3)` 与 `rgb(1 2 3 / 50%)` 都拆成同一组通道
  const parts = match[1].split(/[,\s/]+/).filter(Boolean);
  if (parts.length < 3) return null;
  const rgb = parts.slice(0, 3).map(channel);
  if (rgb.some((item) => item == null)) return null;
  return rgb as Rgb;
}

/** 解析任意 CSS 颜色为 RGB；失败返回 null（不猜颜色）。 */
export function parseCssColor(value: string | null | undefined): Rgb | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return fromHex(trimmed) ?? fromRgbFunction(trimmed);
}

/**
 * 频谱矩阵 → RGBA 像素（行优先，bin 从低频到高频自下而上）。
 *
 * 用「底色 → 信号色」线性插值：能量 0 显示底色，能量 255 显示信号色。
 * 底色解析失败时退化为「透明底 + 信号色 alpha」—— canvas 下面就是 `--av-surface-soft`
 * 的 CSS 背景，视觉上仍然是当前主题的底色，而不是写死的某一套。
 */
export function spectrumPixels(
  bytes: Uint8Array,
  bins: number,
  cols: number,
  signal: Rgb,
  surface: Rgb | null,
): Uint8ClampedArray {
  const data = new Uint8ClampedArray(cols * bins * 4);
  for (let col = 0; col < cols; col += 1) {
    for (let bin = 0; bin < bins; bin += 1) {
      const value = bytes[col * bins + bin] ?? 0;
      const ratio = value / 255;
      const offset = ((bins - 1 - bin) * cols + col) * 4;
      if (surface) {
        data[offset] = Math.round(surface[0] + (signal[0] - surface[0]) * ratio);
        data[offset + 1] = Math.round(surface[1] + (signal[1] - surface[1]) * ratio);
        data[offset + 2] = Math.round(surface[2] + (signal[2] - surface[2]) * ratio);
        data[offset + 3] = 255;
      } else {
        data[offset] = signal[0];
        data[offset + 1] = signal[1];
        data[offset + 2] = signal[2];
        data[offset + 3] = Math.round(ratio * 255);
      }
    }
  }
  return data;
}
