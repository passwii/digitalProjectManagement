import type { ResolvedTheme } from "../components/theme/theme";

/**
 * 主题切换过场（BLF-1292）。
 *
 * 背景：明暗切换原本是「硬切」——一次样式重算把所有颜色直接换掉，用户反馈太生硬，
 * 要求更柔和、更慢、带过场动画。这里把一次切换拆成三件事，全部由挂在 `<html>` 上的
 * `data-theme-transition="to-dark|to-light"` 驱动（样式见 globals.css 的「主题切换过场」段）：
 *
 *   ① 挂属性 —— 让 CSS 把颜色类属性接管到 `--motion-theme` 的曲线上（慢速插值，主体）；
 *   ② 同一属性触发 body::after 的方向性光晕（过场动画）；
 *   ③ 落主题（dataset.theme / color-scheme）——**必须**发生在属性挂上、并且强制过一次
 *      样式计算之后：浏览器把「before-change style」定义为上一个样式变更事件的结果，
 *      若在同一个事件里既开 transition 又改颜色，这次改动不会被过渡（就是那个硬切）。
 *
 * 属性是临时的：THEME_SWAP_HOLD_MS 后摘掉。这一点和「更慢」同样重要——过场只该慢一次，
 * 不能把整个应用平时 140ms 的 hover / focus 过渡一起拖成 680ms。
 *
 * 减少动效偏好（prefers-reduced-motion: reduce）下不做任何过场，但主题照落：CSS 的
 * reduce 段只能关掉动画，关不掉「切换」本身，得在这里判。
 */

/** `<html>` 上的过场标记；值表示切换方向，CSS 靠它决定光晕是「压暗」还是「提亮」。 */
export const THEME_TRANSITION_ATTRIBUTE = "data-theme-transition";

/**
 * 过场时长（颜色插值 + 光晕动画）。globals.css 里的同名令牌 `--motion-theme` 是它的
 * 兜底副本，这里的常量是唯一真源：startThemeSwap() 会在过场期间把真实值以内联变量写上去，
 * lib/themeTransition.test.ts 守着两边不漂移。
 */
export const THEME_SWAP_MS = 680;

/** 摘掉过场属性前多留的收尾时间：光晕要播完再摘，否则会看到它「啪」地消失。 */
export const THEME_SWAP_HOLD_BUFFER_MS = 60;

/** 过场属性的存活时长（= 过场时长 + 收尾缓冲）。 */
export const THEME_SWAP_HOLD_MS = THEME_SWAP_MS + THEME_SWAP_HOLD_BUFFER_MS;

/** 过场期间写到 `<html>` 上的内联 CSS 变量名。 */
export const THEME_MOTION_VARIABLE = "--motion-theme";

/** 跟随系统主题时监听的媒体查询；bootstrap 脚本也用这一个定义，避免两处写死。 */
export const MEDIA_QUERY = "(prefers-color-scheme: dark)";

/** 减少动效偏好的媒体查询。 */
export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/**
 * 过场只需要元素上这几样东西，所以这里用**最小结构接口**而不是 HTMLElement：
 *   · `document.documentElement` 天然满足它（调用方不用转型）；
 *   · `node:test` 那套（tsconfig.test.json 里没有 DOM lib）也能构造假元素跑真实逻辑。
 */
export interface ThemeSwapRoot {
  readonly dataset: Record<string, string | undefined>;
  readonly style: {
    colorScheme: string;
    setProperty(name: string, value: string): void;
    removeProperty(name: string): void;
  };
  /** 只读一次，用来强制样式计算（见文件头 ③）。 */
  readonly offsetHeight: number;
  readonly ownerDocument: { readonly defaultView?: ThemeSwapView | null } | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

export interface ThemeSwapView {
  matchMedia?(query: string): { matches: boolean };
}

export interface ThemeSwapOptions {
  root: ThemeSwapRoot;
  /** 目标主题：同时决定光晕方向与落下的 dataset.theme。 */
  direction: ResolvedTheme;
  /** 真正落主题的写操作；startThemeSwap 保证它发生在属性挂上、样式计算之后。 */
  apply: () => void;
  /** 覆盖过场时长（默认 THEME_SWAP_MS）；主要给测试用。 */
  durationMs?: number;
  /** 覆盖「减少动效」判定（默认读 root 所属 window）；主要给测试用。 */
  reduced?: boolean;
}

/** 把解析后的主题翻译成过场属性值。 */
export function themeTransitionValue(theme: ResolvedTheme): "to-dark" | "to-light" {
  return theme === "dark" ? "to-dark" : "to-light";
}

/** 当前真正落在 `<html>` 上的主题（首屏由 themeBootstrapScript 写的就是它）。 */
export function readAppliedTheme(root: Pick<ThemeSwapRoot, "dataset">): ResolvedTheme | null {
  const value = root.dataset.theme;
  return value === "light" || value === "dark" ? value : null;
}

/** 落主题：数据属性供 CSS 选令牌，color-scheme 让原生控件与滚动条跟上。 */
export function applyTheme(root: Pick<ThemeSwapRoot, "dataset" | "style">, theme: ResolvedTheme): void {
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
}

/** 读一次减少动效偏好；环境没有 matchMedia（如未 mock 的 jsdom）时按「不减少」处理。 */
export function prefersReducedMotion(view: ThemeSwapView | null | undefined): boolean {
  if (!view || typeof view.matchMedia !== "function") return false;
  return view.matchMedia(REDUCED_MOTION_QUERY).matches;
}

/**
 * 跑一次主题切换过场，返回「立刻收尾」的句柄（连续快速切换时用得上）。
 *
 * 返回的句柄只负责提前收尾；就算没人调用它，定时器到时也会把过场属性摘掉，
 * 所以调用方卸载组件也不会把「全站 680ms 过渡」这种属性永久留在页面上。
 */
export function startThemeSwap(options: ThemeSwapOptions): () => void {
  const { root, direction, apply } = options;
  const view = root.ownerDocument?.defaultView ?? null;

  if (options.reduced ?? prefersReducedMotion(view)) {
    apply();
    return () => {};
  }

  const durationMs = options.durationMs ?? THEME_SWAP_MS;

  root.style.setProperty(THEME_MOTION_VARIABLE, `${durationMs}ms`);
  root.setAttribute(THEME_TRANSITION_ATTRIBUTE, themeTransitionValue(direction));
  // 关键的一行：让「带 transition 的样式」先落地成一次独立的样式变更事件，
  // 下面的 apply() 才有「上一帧」可以过渡（否则就是硬切）。
  void root.offsetHeight;
  apply();

  let handle: ReturnType<typeof setTimeout> | null = null;
  const release = () => {
    if (handle === null) return;
    clearTimeout(handle);
    handle = null;
    root.removeAttribute(THEME_TRANSITION_ATTRIBUTE);
    root.style.removeProperty(THEME_MOTION_VARIABLE);
  };

  handle = setTimeout(release, durationMs + THEME_SWAP_HOLD_BUFFER_MS);
  return release;
}
