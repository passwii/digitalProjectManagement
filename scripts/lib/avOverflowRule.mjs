// BLF-1399 卡片溢出判定的**唯一**口径。
//
// 为什么要有这个文件（而不是把判定写在脚本里）：
//   上一版判定写在 `scripts/av-layout-overflow.mjs` 里，条件是
//     「delta > 1 且 overflow 计算值 ∈ {hidden, clip, auto, scroll}」。
//   而站点里那六个卡片族（.panel / .metric / .channel / .sceneCard /
//   .statusCell / .algoCard）在两份受管 CSS 里**一条 overflow 都没设**
//   —— 默认就是 visible。于是「卡片内容真的溢出盒子」这件事，
//   在脚本里永远判不出来：工具在 83px 的可见溢出面前报绿灯。
//
//   复审要求把判定改成「不依赖 overflow 计算值，正向 delta 即记溢出」，
//   判定本身就被提到了这里，好让 `web/lib/av/avOverflowRule.vitest.test.ts`
//   能对**同一份**代码做行为级守卫（脚本把本文件导出的函数源码原样嵌进
//   浏览器探针里跑，两边不会各自漂移）。
//
// ⚠️ 本文件导出的 `classifyCardBox` 会被 `Function.prototype.toString()`
//    原样嵌进浏览器上下文，所以它**必须自包含**：不许引用模块作用域里的
//    任何标识符（常量、辅助数组都写进函数体里）。守卫里有对应断言。

/**
 * 溢出的像素容差。
 *
 * 为什么是 1px：`scrollHeight` / `clientHeight` 都是**取整**后的整数，
 * 子像素布局下会出现 1px 的假差；真正要抓的溢出是几十像素量级的。
 */
export const OVERFLOW_TOLERANCE_PX = 1;

/**
 * 判定一个卡片盒子的内容有没有超出自己的盒子。
 *
 * 口径（**不依赖 overflow 计算值**）：
 *   · 纵向 delta = scrollHeight - clientHeight，横向 delta = scrollWidth - clientWidth；
 *   · 任一轴的 delta 超过容差 → 记溢出。内容是否**被裁**、**可滚动**
 *     还是**溢出到盒子外**，只影响报告里怎么描述，不影响「算不算溢出」。
 *
 * @param {{scrollHeight:number, clientHeight:number, scrollWidth:number, clientWidth:number, overflowY?:string, overflowX?:string}} box
 * @param {number} tolerance 像素容差
 * @returns {{overflow:boolean, overflowY:number, overflowX:number, overflowedY:boolean, overflowedX:boolean, axisY:string, axisX:string}}
 *          axisX / axisY ∈ "ok" | "clipped" | "scrollable" | "spilled"
 */
export function classifyCardBox(box, tolerance) {
  // 这两个数组写进函数体：函数源码会被嵌进浏览器，不能引用模块作用域。
  const clipping = ["hidden", "clip"];
  const scrolling = ["auto", "scroll"];

  const overflowY = box.scrollHeight - box.clientHeight;
  const overflowX = box.scrollWidth - box.clientWidth;
  const overflowedY = overflowY > tolerance;
  const overflowedX = overflowX > tolerance;

  const label = (value, overflowed) => {
    if (!overflowed) return "ok";
    if (clipping.includes(value)) return "clipped";
    if (scrolling.includes(value)) return "scrollable";
    return "spilled";
  };

  return {
    overflow: overflowedY || overflowedX,
    overflowY,
    overflowX,
    overflowedY,
    overflowedX,
    axisY: label(box.overflowY, overflowedY),
    axisX: label(box.overflowX, overflowedX),
  };
}
