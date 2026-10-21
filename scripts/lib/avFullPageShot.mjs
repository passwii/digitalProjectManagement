// 整页截图：先把视口撑到页面内容高度、等图表重排完，再拍稳定的一帧。
//
// 为什么不能直接用 `Page.captureScreenshot({ captureBeyondViewport: true })`：
// 它会在截图**那一瞬间**把视口从 1400 撑到整页高度（这里是 2313）。recharts 的
// `ResponsiveContainer` 量到新尺寸后重排并重播入场动画，截图正好落在“画了一半”
// 或者“还没开始画”的那一帧 —— 实测 /device 的整页图里三张图表全是空白，
// 只剩面板头、图例和环心数字（BLF-1428 交付时踩过：截图看着像图表没渲染，
// 但同一页在视口截图里是全的）。先撑高视口、等一帧动画的时长再拍，就能拍全。
//
// 拍完把度量恢复回调用方的视口：调用方后续还要点行、悬停、量坐标，
// 视口停在全页高度会让那些坐标全错位。

/** 入场动画最长一档（`slow` 600ms）留下的富余：等重排 + 播完。 */
const SETTLE_MS = 1200;

/**
 * 整页截图，返回 PNG buffer。
 *
 * @param {(method: string, params?: object) => Promise<any>} send CDP 调用（各脚本自己的薄封装）
 * @param {{ width?: number, viewportHeight?: number }} viewport 调用方当前生效的视口，拍完恢复
 */
export async function captureFullPage(send, { width = 1440, viewportHeight = 1400 } = {}) {
  const size = await send("Runtime.evaluate", {
    expression: "Math.ceil(Math.max(document.documentElement.scrollHeight, document.body.scrollHeight))",
    returnByValue: true,
  });
  const height = Number(size?.result?.value) || viewportHeight;
  try {
    await send("Emulation.setDeviceMetricsOverride", {
      width,
      height: Math.max(height, viewportHeight),
      deviceScaleFactor: 1,
      mobile: false,
    });
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    return Buffer.from(shot.data, "base64");
  } finally {
    await send("Emulation.setDeviceMetricsOverride", { width, height: viewportHeight, deviceScaleFactor: 1, mobile: false });
    // 恢复视口后给一帧让 recharts 重新量一次，后面的坐标点击才落在正确位置
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}
