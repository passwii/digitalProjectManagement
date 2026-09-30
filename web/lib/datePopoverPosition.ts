/**
 * 日期弹层定位的纯逻辑层。
 *
 * 要解决的 bug：弹层原来固定挂在触发器正下方（`top: calc(100% + 4px)`），
 * 而 `Dialog` / `Drawer` 的正文区（`[data-modal-body]`，`overflow: auto`）会把它裁掉——
 *   · 竖直方向：窄屏下 `@media (max-width: 767px)` 把日期格撑到 44px，
 *     整个弹层约 400px 高，Dialog 正文放不下，底部快捷条被切成半个；
 *   · 水平方向：两栏 `.form-grid` 里右列的日期字段，触发器左边缘已深入面板约 288px，
 *     固定 300px 宽的弹层于是从面板右缘顶出去。
 *
 * 这里只算「摆在哪、截多高、左移多少」，完全不碰 DOM：与 `dateCore.ts` /
 * `modalFocus.ts` 一样用结构化接口，好让 `tsconfig.test.json` 那套没有 DOM 的
 * node:test 直接覆盖。真实浏览器里的量取（`getBoundingClientRect`）与事件监听
 * 留在 `DatePicker.tsx` 的组件层。
 *
 * 一条硬约束：弹层**不做 portal**，仍留在触发器的 `.root` 内（`position: absolute`），
 * 这样 `Modal` 的 Esc / 焦点锁定 / `nestedPopover` 登记与既有无障碍行为都不受影响。
 * 因此 `left` 是相对触发器左缘的偏移量，而不是视口坐标。
 */

/** 一个不含 DOM 类型的矩形（`DOMRect` 与测试替身都能满足）。 */
export interface Rect {
  top: number;
  left: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

/** 求解弹层摆放所需的三组量。 */
export interface PopoverMetrics {
  /** 触发器（组件里量的是触发器容器 `.root`，它恰好等于触发器的框）。 */
  trigger: Rect;
  /** 容器的可见框，调用方已按视口夹取过（见 `DatePicker.tsx`）。 */
  boundary: Rect;
  /** 弹层的**自然**尺寸：尚未被夹取时量到的宽高。 */
  popover: { width: number; height: number };
  /** 弹层与触发器之间的间距。默认 4。 */
  gap?: number;
  /** 弹层与容器边缘至少保留的间距。默认 8。 */
  inset?: number;
  /** 弹层最大高度的上限，避免在超高容器里铺张。默认 480。 */
  maxHeightCap?: number;
}

export interface PopoverPlacement {
  /** `up` = 翻到触发器上方，`down` = 挂在下方。 */
  placement: "down" | "up";
  /** 可用空间不足时用于内部滚动的最大高度。 */
  maxHeight: number;
  /** 相对触发器左缘的水平偏移（可为负：向左溢出再拉回）。 */
  left: number;
  /** 夹取后的宽度。 */
  width: number;
}

/** 弹层与触发器的默认间距（与 CSS `top: calc(100% + 4px)` 对齐）。 */
export const POPOVER_GAP = 4;
/** 弹层与容器边缘的默认安全间距。 */
export const POPOVER_INSET = 8;
/** 弹层最大高度的默认上限。 */
export const POPOVER_MAX_HEIGHT_CAP = 480;

/**
 * 求解弹层最终摆放。
 *
 * 竖直方向：
 *   · `availableBelow = boundary.bottom - trigger.bottom - gap - inset`
 *     —— 触发器下缘到容器下缘之间、扣掉间距与安全边后的净空间；
 *   · `availableAbove = trigger.top - boundary.top - gap - inset` —— 同上，取上方；
 *   · 仅当「下方连弹层自然高度都放不下（或放不下上限高度）」且「上方确实更宽裕」
 *     时才向上翻（`placeUp`）。两个条件缺一不可：只满足前者会在上下都逼仄时
 *     无谓地翻上去，反而更难看；
 *   · `space` 取所选方向上的净空间（不为负）；
 *   · `maxHeight = min(自然高度, 上限, space)` —— 放不下就让弹层内部滚动。
 *
 * 水平方向：
 *   · 宽度先夹到容器可用宽度内（`boundary.width - inset*2`），且不为负；
 *   · `left` 默认 0，即与触发器左缘对齐；
 *   · 若右缘顶出容器，就整块左移到恰好贴住容器右缘；
 *   · 左移过头（连容器左缘都越过了）再拉回左缘 —— 这一步只在容器本身
 *     比弹层还窄的退化情形下才会命中，保证结果永远落在两侧 inset 之内。
 */
export function resolvePopoverPlacement(m: PopoverMetrics): PopoverPlacement {
  const gap = m.gap ?? POPOVER_GAP;
  const inset = m.inset ?? POPOVER_INSET;
  const cap = m.maxHeightCap ?? POPOVER_MAX_HEIGHT_CAP;

  const availableBelow = m.boundary.bottom - m.trigger.bottom - gap - inset;
  const availableAbove = m.trigger.top - m.boundary.top - gap - inset;

  const placeUp =
    availableBelow < Math.min(m.popover.height, cap) && availableAbove > availableBelow;
  const space = Math.max(0, placeUp ? availableAbove : availableBelow);
  const maxHeight = Math.min(m.popover.height, cap, space);

  // 宽度不能为负：容器比两侧 inset 之和还窄时夹到 0。
  const width = Math.max(0, Math.min(m.popover.width, m.boundary.width - inset * 2));

  // 先与触发器左缘对齐，再按容器右/左缘依次修正。
  let left = 0;
  if (m.trigger.left + left + width > m.boundary.right - inset) {
    left = m.boundary.right - inset - width - m.trigger.left;
  }
  if (m.trigger.left + left < m.boundary.left + inset) {
    left = m.boundary.left + inset - m.trigger.left;
  }

  return { placement: placeUp ? "up" : "down", maxHeight, left, width };
}
