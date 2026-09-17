/**
 * 弹层「初始聚焦落点」的纯逻辑层（BLF-1123）。
 *
 * 解决的 bug：`Dialog` / `Drawer` / `Confirm` 的初始聚焦用了一个并集选择器
 * `input…, select, textarea, button, [href], …` + `querySelector`。并集选择器
 * 会命中**文档序**第一个匹配任一子句的元素，而弹层 DOM 顺序是
 * `header`（标题 + 关闭按钮）在 `body`（表单字段）之前 —— 于是焦点落在
 * 右上角的关闭叉叉上，「新建项目」时项目名称输入框拿不到焦点。
 *
 * 本模块只做「选谁」，不碰 React 与计时：
 *   · 与 Tab 循环共用同一份可聚焦选择器（MOdal 内的 Tab 锁定也用它）；
 *   · 排除弹层自身 chrome（关闭按钮）与不适合作落点的元素；
 *   · 优先正文，其次页脚等非 chrome 控件，都没有则由调用方退回 panel 自身。
 *
 * 类型刻意用结构化接口而非 `Element`（与 `uploadZone.ts` 同样的理由）：
 * `tsconfig.test.json` 那套 node:test 只有 ES2022 类型、没有 DOM，
 * 结构化接口让真实 DOM 元素与单测替身都能满足，逻辑因此可以脱离浏览器单测。
 */

/**
 * 弹层内可聚焦元素的选择器。
 *
 * 注意它是**子句的并集**：`input:not([type=hidden])` 会命中 `tabindex="-1"` 的
 * input（例如上传区那个 `sr-only` 的 `<input type="file">`），
 * `button` 也会命中关闭按钮 —— 所以光靠选择器无法表达「排除」，必须再过一遍
 * `isInitialFocusCandidate`。
 */
export const MODAL_FOCUSABLE_SELECTOR =
  "input:not([type=hidden]), select, textarea, button, [href], [tabindex]:not([tabindex='-1'])";

/** 标记弹层的正文区（表单字段所在）：初始聚焦优先在这里找落点。 */
export const MODAL_BODY_ATTR = "data-modal-body";

/** 标记弹层 chrome（关闭按钮）：初始聚焦必须跳过，避免焦点落在叉叉上。 */
export const MODAL_CLOSE_ATTR = "data-modal-close";

/** 只需要「能按选择器查子元素」这一种能力（真实 DOM 的 Element 天然满足）。 */
export interface FocusScopeLike {
  querySelectorAll?: (selector: string) => ArrayLike<unknown>;
  querySelector?: (selector: string) => unknown;
}

/** 只需要判定与聚焦用到的最小成员（真实 DOM 元素与单测替身都满足）。 */
export interface FocusElementLike {
  getAttribute?: (name: string) => string | null;
  disabled?: boolean;
  focus?: () => void;
}

function toArray<T>(list: ArrayLike<T> | null | undefined): T[] {
  if (!list) return [];
  return Array.prototype.slice.call(list) as T[];
}

function collect(scope: FocusScopeLike | null | undefined, selector: string): FocusElementLike[] {
  if (!scope || typeof scope.querySelectorAll !== "function") return [];
  return toArray(scope.querySelectorAll(selector) as ArrayLike<unknown>) as FocusElementLike[];
}

/**
 * 这个元素能不能作为弹层打开时的初始落点。
 *
 * 排除项与理由：
 *   · `data-modal-close`  —— 弹层 chrome（关闭按钮），正是本 bug 的错误落点；
 *   · `aria-hidden="true"` —— 不进无障碍树，不是给用户输入的地方
 *     （上传区把它自己的 `<input type="file">` 标成 aria-hidden）；
 *   · `tabindex="-1"`      —— 应用主动把它移出 Tab 序列，就不该被程序抢着聚焦；
 *   · `disabled`           —— 不可交互。
 */
export function isInitialFocusCandidate(element: FocusElementLike | null | undefined): boolean {
  if (!element) return false;
  if (!element.focus) return false;
  if (element.disabled === true) return false;
  const getAttribute = element.getAttribute;
  if (!getAttribute) return false;
  if (getAttribute.call(element, MODAL_CLOSE_ATTR) !== null) return false;
  if (getAttribute.call(element, "aria-hidden") === "true") return false;
  if (getAttribute.call(element, "tabindex") === "-1") return false;
  return true;
}

/** 在给定范围内按文档序取第一个合格落点；没有则返回 null。 */
export function pickInitialFocus(scope: FocusScopeLike | null | undefined): FocusElementLike | null {
  for (const node of collect(scope, MODAL_FOCUSABLE_SELECTOR)) {
    if (isInitialFocusCandidate(node)) return node;
  }
  return null;
}

/**
 * 弹层打开时的初始聚焦落点，按优先级：
 *
 *   1. 正文（`[data-modal-body]`）里第一个非 chrome 可聚焦控件 —— 表单字段的主场；
 *   2. 弹层内其余非 chrome 控件 —— 例如 `Confirm` 的页脚按钮（正文只有一句文案）；
 *   3. null —— 调用方退回聚焦 panel 自身（`Confirm` 之类的弹层不能丢焦点）。
 *
 * 不做 `offsetParent` 可见性过滤：初始聚焦发生在弹层刚插入 DOM 时，
 * 此时布局可能尚未完成（jsdom 更没有布局，恒为 null），过滤会把正常落点也滤掉。
 * Tab 循环那条路径的可见性过滤保持原样，不在本模块内。
 */
export function resolveInitialFocus(panel: FocusScopeLike | null | undefined): FocusElementLike | null {
  if (!panel?.querySelector) return null;
  const body = panel.querySelector(`[${MODAL_BODY_ATTR}]`) as FocusScopeLike | null;
  const inBody = pickInitialFocus(body);
  if (inBody) return inBody;
  return pickInitialFocus(panel);
}
