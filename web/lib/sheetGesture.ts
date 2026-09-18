/**
 * 三态抽屉的手势判定（BLF-1127 §4 + 决策 D2）。
 *
 * 为什么单独成文件：`96px`（下甩降档 / 关闭）与 `56px`（上拖升档）是**契约值**，
 * 不是随手调的手感参数 —— §4 白纸黑字写了「下甩 96px 以上降档 / 关闭」，
 * 原型也按同一对阈值跑。把它做成不依赖 DOM 的纯函数，vitest 直接钉住
 * （`lib/sheetGesture.vitest.test.ts`），浏览器里只剩「采集指针位移 + 应用结果」，
 * 和人眼手感无关的部分不许漂移。
 *
 * 与 `lib/mobileNav.ts` / `lib/modalFocus.ts` 同样的理由：契约做成纯函数，
 * 才能脱离浏览器单测；组件里的逻辑越薄越好。
 */

/** 抽屉的停靠档位：peek（不打断当前页）/ half / full（§4 表） */
export type SheetStop = "peek" | "half" | "full";

/** §4：下甩 96px 以上降档 / 关闭 */
export const SWIPE_DOWN = 96;
/** 上拖升档阈值（原型同值）：低于它视为手抖，不改档 */
export const SWIPE_UP = 56;
/** 指针位移超过它才算「拖拽」而不是「点按」——否则点一下卡片就成了拖拽 */
export const DRAG_SLOP = 6;
/** 拖动时至少留在屏上的高度：不许把面板拖到顶部以上（原型 `max(dy, -h + 80)`） */
export const DRAG_KEEP_VISIBLE = 80;

export type DragOutcome =
 /** 位移不够 / 已到顶：保持原档（不动就是正确的反应，不是「点了没反应」） */
 { kind: "none" } | { kind: "close" } | { kind: "stop"; stop: SheetStop };

/**
 * 松手时该去哪一档。
 *
 * 下甩（`dy > 96`）：peek → 关闭；half → peek；full → half（逐档降，不跳档）；
 * 上拖（`dy < -56`）：peek → half；half → full；full 已到顶 → 不动。
 *
 * 刻意不做「拖多少距离就跨几档」：iOS 地图 / Safari 的手势语义是**一次一档**，
 * 跨档会让用户在第 3 档和第 1 档之间失去可预期性。
 */
export function resolveDragOutcome(from: SheetStop, dy: number): DragOutcome {
 if (dy > SWIPE_DOWN) {
  if (from === "peek") return { kind: "close" };
  return { kind: "stop", stop: from === "full" ? "half" : "peek" };
 }
 if (dy < -SWIPE_UP) {
  if (from === "full") return { kind: "none" };
  return { kind: "stop", stop: from === "peek" ? "half" : "full" };
 }
 return { kind: "none" };
}

/**
 * 拖拽过程中的视觉位移上限（下拖不设限：关闭时本来就要滑出屏）。
 *
 * 上拖封顶 `-(面板高度 - 80)`：面板至少留 80px 在屏上，否则用户把抽屉拖没了
 * 就再也没有可抓的地方了。
 */
export function clampDragOffset(
 dy: number,
 panelHeight: number,
 keepVisible = DRAG_KEEP_VISIBLE,
): number {
 if (dy >= 0) return dy;
 return Math.max(dy, -(panelHeight - keepVisible));
}
