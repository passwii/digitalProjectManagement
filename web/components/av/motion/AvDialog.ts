"use client";

/**
 * 原生 `<dialog>` 抽屉的开合动画（AlarmView / DeviceView 共用）。
 *
 * 为什么不能只靠 CSS：`dialog.close()` 是**同步**的 —— 元素立刻 `display:none`，
 * 退出动画一帧都播不出来。所以退场必须由 JS 排队：先挂 `data-closing`，
 * 等动画结束（或读 `--av-dur-quick` 兜底）再真的 close()。
 *
 * 入场反过来是安全的：`showModal()` 之后元素就可见了，CSS 的 `animation:
 * avDrawerIn ...` 会自己播；这里只保证把上一次残留的 `data-closing` 清掉
 * （否则第二次打开会直接是"正在关闭"的状态）。
 *
 * 时长不写死：从计算样式的 `--av-dur-quick` 读，`?static=1` / 减少动效下它是 0ms，
 * 于是 `close()` 立刻执行，不会有「等了 160ms 才关」的假延迟。
 */

/** 读一个 CSS 自定义属性并解析成毫秒（`160ms` / `0.16s` 都认）。 */
export function readDurationMs(element: Element, variable: string, fallback: number): number {
  const raw = getComputedStyle(element).getPropertyValue(variable).trim();
  if (!raw) return fallback;
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value)) return fallback;
  return raw.endsWith("ms") ? value : value * 1000;
}

/** 打开抽屉：清掉残留的关闭态，再 showModal。 */
export function openDialogWithMotion(dialog: HTMLDialogElement | null): void {
  if (!dialog) return;
  delete dialog.dataset.closing;
  if (!dialog.open) dialog.showModal();
}

/**
 * 关闭抽屉：先播退场（quick），结束后再真正 close()。
 *
 * `onClose` 由调用方提供（清 state、还原 URL 等），保证只在动画真的结束时执行一次。
 */
export function closeDialogWithMotion(
  dialog: HTMLDialogElement | null,
  onClose: () => void,
): void {
  if (!dialog || !dialog.open) {
    onClose();
    return;
  }
  const duration = readDurationMs(dialog, "--av-dur-quick", 0);
  if (duration <= 0) {
    dialog.close();
    onClose();
    return;
  }
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    dialog.removeEventListener("animationend", onEnd);
    delete dialog.dataset.closing;
    dialog.close();
    onClose();
  };
  const onEnd = (event: AnimationEvent) => {
    // 只认 dialog 自己的动画：backdrop 的 animationend 会冒泡到 dialog 上，
    // 两者时长不同，先到的那个不能算数
    if (event.target !== dialog) return;
    finish();
  };
  dialog.addEventListener("animationend", onEnd);
  dialog.dataset.closing = "true";
  // 兜底：动效被系统关掉 / 动画事件没触发时也要收尾（duration + 1 帧）
  window.setTimeout(finish, duration + 32);
}
