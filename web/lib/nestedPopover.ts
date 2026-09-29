/**
 * 「嵌套弹层」登记簿：让外层 Modal 的 Esc 知道「当前有弹层开着，先让它关」。
 *
 * 要解决的 bug（不是假想，是必然发生）：
 *   `Modal.tsx` 的 Esc 监听是 `document.addEventListener("keydown", onKey, true)`，
 *   在 **capture** 阶段。capture 的执行顺序是 document → … → target，
 *   而 React 18 把事件监听挂在 root container 上 —— 于是 Modal 的 handler
 *   **先**执行，它 `e.stopPropagation()` 之后，事件根本到不了日期弹层的
 *   `onKeyDown`。结果在 Dialog 里按一次 Esc，整个弹窗被关掉，
 *   日期弹层只是被动跟着卸载，用户填了一半的表单状态也没了。
 *
 *   `ProjectPicker` 同样中招：它在 handler 里 `e.stopPropagation()`
 *   是无效的，因为 Modal 早在 capture 阶段就截断了这条事件。
 *   组件内部**无法**靠事件顺序自救 —— 两个都挂在 document 上的 capture
 *   监听按注册先后执行，而 Modal 必然先注册（Dialog 先挂载）。
 *
 * 所以唯一正确的位置是 Modal 自己：让它在处理 Esc 前先问一下「有没有嵌套弹层开着」。
 *
 * 这里用**引用计数**而非布尔开关：多个弹层可能交叠打开/关闭
 * （例如日期弹层还开着，用户又点开了项目选择器），
 * 布尔开关会被后关的那个误清成 false，导致 Modal 提前恢复 Esc 关闭。
 */

type Unregister = () => void;

let openCount = 0;

/**
 * 登记一个已打开的嵌套弹层，返回注销函数。
 *
 * 登记函数会在**注销被重复调用时静默失效** —— React 18 的 StrictMode
 * 与 effect 重跑都可能让同一个弹层登记两次，若注销不做幂等处理，
 * 计数会漂移且永不归零，Modal 的 Esc 就永久失灵。
 */
export function registerNestedPopover(): Unregister {
  openCount += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    // 下限兜底：即便计数因异常路径漂移为负，也不能污染后续判断。
    openCount = Math.max(0, openCount - 1);
  };
}

/** 当前是否有嵌套弹层打开。Modal 的 Esc handler 在关闭前查询它。 */
export function hasOpenNestedPopover(): boolean {
  return openCount > 0;
}

/** 仅供单测：把计数归零，避免用例之间互相污染。 */
export function resetNestedPopoverRegistry(): void {
  openCount = 0;
}
