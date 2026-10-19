/**
 * AV 的 tone → CSS 变量映射。
 *
 * 单独一个模块（而不是放在 AvUI.tsx 里）的原因：AvUI 是客户端组件（动效要 hooks），
 * 而服务端页面（capability / __stress / audio 空态）也要调 `toneVar()` 生成 style。
 * 从 "use client" 模块里 import 函数到服务端组件会在渲染期报错，
 * 所以这个纯函数留在 lib 里，服务端与客户端都能直接 import。
 */
import type { AvTone } from "./labels";

export function toneVar(tone: AvTone): string {
  return `var(--av-tone-${tone})`;
}
