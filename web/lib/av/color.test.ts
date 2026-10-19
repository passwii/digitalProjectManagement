import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseCssColor, spectrumPixels } from "./color";

/**
 * 频谱 canvas 取色回归（review 缺陷 2）。
 *
 * 背景：浅色主题下 `--av-surface` 的 computed value 是 3 位缩写 `#fff`，旧的
 * `hexToRgb` 只认 6 位，于是回落到写死的深色主题青色，整块频谱在浅色下变成亮青。
 * 这里把「解析」与「像素合成」拆成纯函数，直接断言两种主题下的输出。
 */
describe("CSS 颜色解析", () => {
  it("支持 3 / 4 / 6 / 8 位 hex", () => {
    assert.deepEqual(parseCssColor("#fff"), [255, 255, 255]);
    assert.deepEqual(parseCssColor("#0d1d2c"), [13, 29, 44]);
    assert.deepEqual(parseCssColor("#6cf3ff"), [108, 243, 255]);
    assert.deepEqual(parseCssColor("#17617d"), [23, 97, 125]);
    assert.deepEqual(parseCssColor("#8888"), [136, 136, 136]);
    assert.deepEqual(parseCssColor("#11223344"), [17, 34, 51]);
    assert.deepEqual(parseCssColor("fff"), [255, 255, 255]);
  });

  it("支持 rgb()/rgba()，两种分隔写法都行", () => {
    assert.deepEqual(parseCssColor("rgb(18, 52, 86)"), [18, 52, 86]);
    assert.deepEqual(parseCssColor("rgb(18 52 86)"), [18, 52, 86]);
    assert.deepEqual(parseCssColor("rgba(18, 52, 86, 0.5)"), [18, 52, 86]);
    assert.deepEqual(parseCssColor("rgb(10% 20% 30%)"), [26, 51, 77]);
  });

  it("解析不了就返回 null，不回落到某个主题的写死色值", () => {
    assert.equal(parseCssColor(""), null);
    assert.equal(parseCssColor(null), null);
    assert.equal(parseCssColor("var(--av-signal)"), null);
    assert.equal(parseCssColor("hsl(180 100% 50%)"), null);
  });
});

describe("频谱像素合成", () => {
  const bytes = new Uint8Array([0, 255, 128, 64]); // 2 × 2
  const signal: [number, number, number] = [23, 97, 125];

  it("浅色主题（3 位缩写底色）能量为 0 时必须是浅底，而不是写死的青色", () => {
    const pixels = spectrumPixels(bytes, 2, 2, signal, parseCssColor("#fff"));
    // 像素行序：bin 0 在**底部**（offset 8..15）。col 0 / bin 0 对应 bytes[0] = 0 → 纯底色
    assert.deepEqual(Array.from(pixels.slice(8, 11)), [255, 255, 255]);
    assert.equal(pixels[11], 255);
    assert.notDeepEqual(Array.from(pixels.slice(8, 11)), [108, 243, 255]);
  });

  it("深色主题：0 能量是深色底，255 能量是信号色", () => {
    const dark = parseCssColor("#0d1d2c");
    const pixels = spectrumPixels(new Uint8Array([0, 255]), 1, 2, signal, dark);
    // 单行图（bins = 1）：col 0 值 0 → 深色底，col 1 值 255 → 信号色
    assert.deepEqual(Array.from(pixels.slice(0, 3)), [13, 29, 44]);
    assert.deepEqual(Array.from(pixels.slice(4, 7)), [23, 97, 125]);
  });

  it("底色解析失败时用透明底 + 信号色 alpha，不猜主题", () => {
    const pixels = spectrumPixels(new Uint8Array([0, 255]), 1, 2, signal, null);
    assert.deepEqual(Array.from(pixels.slice(0, 4)), [23, 97, 125, 0]);
    assert.deepEqual(Array.from(pixels.slice(4, 8)), [23, 97, 125, 255]);
  });

  it("行序：bin 0 落在图像底部（canvas 坐标 y 向下）", () => {
    const pixels = spectrumPixels(new Uint8Array([255, 0, 0, 0]), 2, 2, signal, parseCssColor("#fff"));
    // 2 × 2：bin 0 在底部两格（offset 8..15），col 0 / bin 0 = bytes[0] = 255 → 信号色
    assert.deepEqual(Array.from(pixels.slice(8, 11)), [23, 97, 125]);
  });
});
