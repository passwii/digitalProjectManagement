/**
 * 智能音视频平台动效令牌 · Stage 3 / BLF-1375
 *
 * 为什么先有这一层：Stage 2 之后全站只有 2 处 transition，逐页补动效的结果一定是
 * 20 种 duration（每组各拍一个数）。这个文件是**唯一真源**：四档时长 + 三条曲线 +
 * 两条错峰步长，页面 / 组件 / CSS 模块全部从这里取，谁也不许再手写 `0.2s`。
 *
 * ── 四档时长（秒，framer-motion 单位） ──────────────────────────────────────
 *   instant 0.09  状态反馈：按钮按下（scale 0.98）、开关、焦点环淡入。
 *                 必须短到「手指还没抬起来就已经到位」，否则会被读成卡顿。
 *   quick   0.16  hover / focus / 徽标变更 / 抽屉关闭 / 当前转写句高亮。
 *                 这是「用户还在操作」的时长档位，超过 200ms 就开始觉得黏。
 *   base    0.24  抽屉打开、面板入场、Tab 切换、列表错峰单元。主力档。
 *   slow    0.42  页面级入场、图表面板入场、KPI 数字滚动、频谱揭示。
 *                 再慢就会在演示里被等；0.5s 是硬上限（见 Stage 3 §五）。
 *
 * ── 三条曲线（cubic-bezier 四元组，与 CSS 里的 var(--av-ease-*) 同值） ────
 *   standard [0.2, 0.72, 0.2, 1]  与项目既有的 --ease-console 完全相同，
 *            用于「原地变化」：高亮位移、颜色、布局 FLIP。
 *   enter    [0.16, 1, 0.3, 1]    先快后缓，元素从画面外进来时用：
 *            起步就要有速度，末尾长尾收住，看起来是「落位」而不是「飘过来」。
 *   exit     [0.4, 0, 1, 1]       先缓后快，元素离场时用。
 *
 * ── 为什么退场比入场快（enter + base 打开 / exit + quick 关闭） ────────────
 * 打开是「把新信息递到用户面前」，用户愿意为它等 240ms；关闭是「用户已经决定不要
 * 了」，此时任何等待都是纯粹的延迟 —— 大脑会把它记成「这个界面有点慢」。所以退场
 * 固定走 quick（160ms）并配 exit 曲线（先缓后快），让元素在用户注意力移开前就消失。
 * 同理，hover-in 用 quick、hover-out 用 instant：指针离开时用户已经不看这块了。
 *
 * ── 与 CSS 的关系 ──────────────────────────────────────────────────────────
 * `AV_MOTION_CSS_VARIABLES` 把同一组值导出成 CSS 自定义属性（`--av-dur-base` 等），
 * globals.css 里落成声明，module.css 一律 `transition: opacity var(--av-dur-base)`。
 * 两边的数值由 `lib/av/motion.vitest.test.ts` 钉死，改一边不改另一边会红。
 *
 * ── 降级 ───────────────────────────────────────────────────────────────────
 * `?static=1`（录屏 / 截图）与 `prefers-reduced-motion: reduce` 下，所有时长在这里
 * 统一归零：`avDurationSeconds()` 返回 0，`avItemMotion()` 直接给 `initial: false`。
 * CSS 侧由 `:root[data-av-motion="off"]` 一次性把 `--av-dur-*` 归零并关掉动画，
 * 属性由 `AV_MOTION_BOOTSTRAP_SCRIPT` 在首帧前挂上（见 app/stream-monitor/layout.tsx）。
 *
 * ⚠️ 本文件必须保持**纯逻辑**（不引 React / 不碰 DOM），这样 node:test 与 vitest
 * 都能直接测，服务端组件也能安全 import。
 */

export const AV_MOTION = {
  instant: 0.09, // 状态反馈：按钮按下、toggle
  quick: 0.16, // hover / focus / 徽标数字跳动
  base: 0.24, // 抽屉开合、卡片展开、Tab 切换
  slow: 0.42, // 页面切换、图表面板入场
} as const;

/**
 * 三条曲线。类型写成可变四元组（不是 readonly）：framer-motion 的 `Transition.ease`
 * 只接受 `number[]`，`as const` 出来的 readonly 元组会在每个 transition 里报错。
 */
export const AV_EASE: Record<"standard" | "enter" | "exit", [number, number, number, number]> = {
  standard: [0.2, 0.72, 0.2, 1], // 与现有 --ease-console / nav 高亮一致
  enter: [0.16, 1, 0.3, 1], // 元素入场（先快后缓）
  exit: [0.4, 0, 1, 1], // 元素退场（比入场快 20%，体感更利落）
};

/**
 * 错峰（stagger）步长与上限。
 *
 * · list 0.03s：前 10 条按 index * 0.03 依次入场（第 10 条 0.27s，仍在 base 内）；
 * · timeline 0.06s：时间线节点更稀疏，步长放大一倍才看得出「逐个点亮」；
 * · max 10：第 11 条之后不再延迟 —— 50 条列表全错峰会让最后一条等 1.5s；
 * · longList 100：超过 100 行直接不做入场错峰（Stage 3 性能硬约束）。
 */
export const AV_STAGGER = {
  list: 0.03,
  timeline: 0.06,
  max: 10,
  longList: 100,
} as const;

/** 一级告警色条呼吸：唯一的持续循环动效，3s 一个来回。 */
export const AV_BREATH_SECONDS = 3;

/** 骨架屏高光扫过一个来回的时长（不是入场动画，所以单独一个值，不进四档）。 */
export const AV_SHIMMER_SECONDS = 1.2;

/** 挂在 <html> 上的开关属性：值为 "off" 时全站动效归零。 */
export const AV_MOTION_ATTRIBUTE = "data-av-motion";

/** 截图 / 录屏开关：`?static=1`（`?static=0` 显式关闭）。 */
export const AV_STATIC_QUERY = "static";

export type AvDurationToken = keyof typeof AV_MOTION;
export type AvEaseToken = keyof typeof AV_EASE;

/** 动效运行状态：`frozen` = `?static=1`，`reduced` = prefers-reduced-motion。 */
export interface AvMotionState {
  reduced: boolean;
  frozen: boolean;
}

export const AV_MOTION_ENABLED: AvMotionState = { reduced: false, frozen: false };

/**
 * `AV_MOTION` / `AV_EASE` / `AV_STAGGER` 的 CSS 版。
 *
 * 键就是 CSS 自定义属性名，值就是 globals.css 里该写的字面量。
 * 顺序固定，守卫测试按这个表逐条比对 globals.css。
 */
export const AV_MOTION_CSS_VARIABLES: Readonly<Record<string, string>> = {
  "--av-dur-instant": `${AV_MOTION.instant * 1000}ms`,
  "--av-dur-quick": `${AV_MOTION.quick * 1000}ms`,
  "--av-dur-base": `${AV_MOTION.base * 1000}ms`,
  "--av-dur-slow": `${AV_MOTION.slow * 1000}ms`,
  "--av-dur-breathe": `${AV_BREATH_SECONDS * 1000}ms`,
  "--av-dur-shimmer": `${AV_SHIMMER_SECONDS * 1000}ms`,
  "--av-stagger-list": `${AV_STAGGER.list * 1000}ms`,
  "--av-stagger-timeline": `${AV_STAGGER.timeline * 1000}ms`,
  "--av-ease-standard": `cubic-bezier(${AV_EASE.standard.join(", ")})`,
  "--av-ease-enter": `cubic-bezier(${AV_EASE.enter.join(", ")})`,
  "--av-ease-exit": `cubic-bezier(${AV_EASE.exit.join(", ")})`,
};

/**
 * 首帧前执行的开关脚本。
 *
 * 必须**同步**跑在 <body> 解析时（不能用 useEffect）：截图 / 录屏场景下，
 * 等 React 水合再关动效，第一帧已经把入场动画录进去了。所以 app/stream-monitor/layout.tsx
 * 把这段以普通 <script> 内联在页面最前面。
 */
export const AV_MOTION_BOOTSTRAP_SCRIPT = `(function(){try{var v=new URLSearchParams(window.location.search).get("${AV_STATIC_QUERY}");var frozen=v!==null&&v!=="0"&&v!=="false";document.documentElement.setAttribute("${AV_MOTION_ATTRIBUTE}",frozen?"off":"on")}catch(e){}})();`;

/** `?static=1` 判定：`?static` / `?static=1` / `?static=true` 都算开；`=0`/`=false` 算关。 */
export function parseStaticMode(search: string): boolean {
  if (!search) return false;
  const query = search.startsWith("?") ? search.slice(1) : search;
  const value = new URLSearchParams(query).get(AV_STATIC_QUERY);
  if (value === null) return false;
  return value !== "0" && value.toLowerCase() !== "false";
}

/** 当前是否允许播放动效（`?static=1` 或减少动效时为 false）。 */
export function isMotionEnabled(state: AvMotionState): boolean {
  return !state.reduced && !state.frozen;
}

/** 时长（秒）：降级状态下一律 0，调用方不需要再写 if。 */
export function avDurationSeconds(token: AvDurationToken, state: AvMotionState = AV_MOTION_ENABLED): number {
  return isMotionEnabled(state) ? AV_MOTION[token] : 0;
}

/** 时长（毫秒）：给 recharts 的 `animationDuration` 这类只吃毫秒的 API。 */
export function avDurationMs(token: AvDurationToken, state: AvMotionState = AV_MOTION_ENABLED): number {
  return avDurationSeconds(token, state) * 1000;
}

/** 曲线：降级时返回线性（时长已经是 0，曲线只影响「瞬时跳变」的观感）。 */
export function avEase(token: AvEaseToken): [number, number, number, number] {
  return AV_EASE[token];
}

/** 列表第 index 项的入场延迟：前 10 项错峰，之后不再延迟；长列表整段关闭。 */
export function avStaggerSeconds(
  index: number,
  total: number = AV_STAGGER.max,
  step: number = AV_STAGGER.list,
): number {
  if (!Number.isFinite(index) || index < 0) return 0;
  if (total > AV_STAGGER.longList) return 0;
  if (index >= AV_STAGGER.max) return 0;
  return index * step;
}

export interface AvItemMotion {
  initial: false | { opacity: number; y: number };
  animate: { opacity: number; y: number };
  transition: { duration: number; delay: number; ease: [number, number, number, number] };
}

/**
 * 列表 / 卡片入场：`opacity 0 → 1` + `y 6 → 0`（只动 transform 与 opacity）。
 *
 * 返回的是 framer-motion 的 props，直接 `{...avItemMotion(index, total)}` 展开到
 * `m.li` / `m.article` 上；组件不必各自算 delay，也不会出现「两套错峰节奏」。
 */
export function avItemMotion(
  index: number,
  total: number = AV_STAGGER.max,
  state: AvMotionState = AV_MOTION_ENABLED,
  options: { token?: AvDurationToken; distance?: number; step?: number } = {},
): AvItemMotion {
  const enabled = isMotionEnabled(state);
  const distance = options.distance ?? 6;
  return {
    initial: enabled ? { opacity: 0, y: distance } : false,
    animate: { opacity: 1, y: 0 },
    transition: {
      duration: avDurationSeconds(options.token ?? "base", state),
      delay: enabled ? avStaggerSeconds(index, total, options.step ?? AV_STAGGER.list) : 0,
      ease: AV_EASE.enter,
    },
  };
}

export interface AvCountSpec {
  prefix: string;
  value: number;
  decimals: number;
  grouped: boolean;
  suffix: string;
}

/**
 * 把 KPI 展示串拆成「可滚动的数字 + 原样保留的前后缀」。
 *
 * 例：`"14,366"` → { value: 14366, grouped: true, decimals: 0 }
 *     `"99.8"`  → { value: 99.8, decimals: 1 }
 *     `"3.2"` 配合 unit "%"（unit 在 JSX 里另渲染，不参与解析）
 *
 * 解析失败返回 null —— 调用方保持静态文本，绝不把「—」滚成「0」。
 */
export function parseCountValue(text: string): AvCountSpec | null {
  const match = /^([^0-9]*)(\d[\d,]*(?:\.\d+)?)(.*)$/.exec(text.trim());
  if (!match) return null;
  const [, prefix, raw, suffix] = match;
  const grouped = raw.includes(",");
  const normalized = grouped ? raw.replace(/,/g, "") : raw;
  const value = Number(normalized);
  if (!Number.isFinite(value)) return null;
  const [, fraction = ""] = normalized.split(".");
  const decimals = fraction.length;
  return { prefix, value, decimals, grouped, suffix };
}

/** `parseCountValue` 的逆运算：按原串的小数位 / 千分位还原。 */
export function formatCountValue(next: number, shape: AvCountSpec): string {
  const fixed = next.toFixed(shape.decimals);
  if (!shape.grouped) return `${shape.prefix}${fixed}${shape.suffix}`;
  const [whole, fraction] = fixed.split(".");
  const withSeparators = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${shape.prefix}${withSeparators}${fraction ? `.${fraction}` : ""}${shape.suffix}`;
}
