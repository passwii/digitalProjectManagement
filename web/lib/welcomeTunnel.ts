/**
 * Dashboard 欢迎页（透视隧道）的纯逻辑。
 *
 * 这里不引 React、不碰 DOM：卡片文案、进度分段、终点阈值都由组件与测试共用同一份，
 * 避免"草稿一套、实现一套"。数值对齐 docs/prototypes/dashboard-welcome/index.html。
 */

export interface WelcomeCard {
  /** 稳定标识，用于 React key 与测试 */
  readonly id: string;
  /** 卡片左上角的序号，例如 01 */
  readonly order: string;
  /** 卡片左上角的分类标签，例如 台账 */
  readonly tag: string;
  readonly title: string;
  readonly description: string;
}

/**
 * 九张能力卡片。文案与 docs/prototypes/dashboard-welcome/README.md 的「卡片文案」表一致。
 * 顺序决定隧道里的先后位置，不要为了排版随意穿插。
 */
export const WELCOME_CARDS = [
  { id: "ledger", order: "01", tag: "台账", title: "统一台账", description: "项目与客户关系对齐" },
  { id: "progress", order: "02", tag: "进度", title: "进度留痕", description: "每个里程碑可追溯" },
  { id: "cost", order: "03", tag: "成本", title: "支出归集", description: "成本与预算同一条线" },
  { id: "approval", order: "04", tag: "审批", title: "审批协同", description: "决策不脱离业务现场" },
  { id: "delivery", order: "05", tag: "复盘", title: "交付复盘", description: "把经验留在项目里" },
  { id: "contacts", order: "06", tag: "协同", title: "通讯录", description: "角色与职责清晰可见" },
  { id: "reports", order: "07", tag: "报表", title: "项目报表", description: "进度、成本、交付同屏" },
  { id: "spark", order: "08", tag: "站点", title: "云电竞平台", description: "独立站点 · 新窗口" },
  { id: "av", order: "09", tag: "站点", title: "智能音视频", description: "独立站点 · 新窗口" },
] as const satisfies readonly WelcomeCard[];

/** 卡片总数。隧道分段与循环都以它为分母。 */
export const TUNNEL_CARD_COUNT = WELCOME_CARDS.length;

/** 每张卡片在 0..1 进度轴上占据的区间宽度（草稿里的 55%）。 */
export const TUNNEL_CARD_SPAN = 0.55;

/** 每条滚轮像素对应的进度。约 1250px 到底，符合一次长滚动的手感。 */
export const SCROLL_PROGRESS_PER_PIXEL = 0.0008;

/** 触控拖动每像素对应的进度。比滚轮快，手指移动不需要拖满整屏。 */
export const DRAG_PROGRESS_PER_PIXEL = 0.0018;

/** prefers-reduced-motion 下的静态中间帧：不跑隧道，直接停在这里。 */
export const STATIC_FRAME_PROGRESS = 0.42;

/** 终点状态出现的阈值；进度 ≥ 此值时显示「从这里开始。」。 */
export const END_THRESHOLD = 0.86;

/** 终点淡入的进度跨度：从 END_THRESHOLD 到 END_THRESHOLD + END_FADE_SPAN 完全显示。 */
export const END_FADE_SPAN = 0.12;

/** 桌面端卡片的最远 / 最近 z 值与鼠标视差位移。 */
export const DESKTOP_TUNNEL = { farZ: -1700, nearZ: 500, parallax: 45 } as const;
/** 手机端收窄纵深与视差，避免近端卡片过大、边缘卡片被裁掉。 */
export const MOBILE_TUNNEL = { farZ: -1200, nearZ: 350, parallax: 20 } as const;

export interface CardLayout {
  /** 卡片在隧道横截面上的极角（弧度） */
  readonly angle: number;
  /** 横向基准位移（vw），视觉上等于草稿里的 cos(a) * W * rx */
  readonly baseXvw: number;
  /** 纵向基准位移（vh），视觉上等于草稿里的 sin(a) * H * ry */
  readonly baseYvh: number;
  /** 卡片自身的轻微倾斜角度（度） */
  readonly rotation: number;
  /** 卡片出现区间起点（0..1） */
  readonly start: number;
  /** 卡片退场区间终点（0..1） */
  readonly end: number;
}

/** 0..1 的进度（含边界）。NaN / Infinity 一律落回 0，避免样式出现 NaN。 */
export function clampProgress(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** 滚轮位移叠加到进度上并夹在 0..1。 */
export function progressFromScroll(progress: number, deltaY: number): number {
  const delta = Number.isFinite(deltaY) ? deltaY : 0;
  return clampProgress(clampProgress(progress) + delta * SCROLL_PROGRESS_PER_PIXEL);
}

/** 触控拖动位移（向上为正）叠加到进度上并夹在 0..1。 */
export function progressFromDrag(progress: number, deltaY: number): number {
  const delta = Number.isFinite(deltaY) ? deltaY : 0;
  return clampProgress(clampProgress(progress) + delta * DRAG_PROGRESS_PER_PIXEL);
}

function safeIndex(index: number, total: number): number {
  const safeTotal = Number.isFinite(total) && total > 0 ? Math.floor(total) : TUNNEL_CARD_COUNT;
  const raw = Number.isFinite(index) ? Math.floor(index) : 0;
  return Math.min(safeTotal - 1, Math.max(0, raw));
}

/**
 * 第 index 张卡片在进度轴上的出现 / 退场区间。
 *
 * 草稿公式：span = 0.55，start = (i / total) * (1 - span)，end = start + span。
 * 九张卡片从 0 排到 0.4–0.95；最后一张不会越过 1，终点仍留在画面之外。
 */
export function cardWindow(index: number, total: number = TUNNEL_CARD_COUNT): { start: number; end: number } {
  const safeTotal = Number.isFinite(total) && total > 0 ? Math.floor(total) : TUNNEL_CARD_COUNT;
  const i = safeIndex(index, safeTotal);
  const start = (i / safeTotal) * (1 - TUNNEL_CARD_SPAN);
  return { start, end: start + TUNNEL_CARD_SPAN };
}

/** 单张卡片自己的局部进度（0..1），用于淡入淡出与纵深。 */
export function cardLocalProgress(
  progress: number,
  index: number,
  total: number = TUNNEL_CARD_COUNT,
): number {
  const { start, end } = cardWindow(index, total);
  const span = end - start || 1;
  return clampProgress((clampProgress(progress) - start) / span);
}

/**
 * 局部进度对应的透明度。
 *
 * 前 18% 淡入、后 18% 淡出，中段完全显示；和草稿的
 * `lp < .18 ? lp / .18 : lp > .82 ? (1 - lp) / .18 : 1` 等价。
 */
export function cardOpacity(localProgress: number): number {
  const lp = clampProgress(localProgress);
  if (lp <= 0) return 0;
  if (lp < 0.18) return lp / 0.18;
  if (lp <= 0.82) return 1;
  return Math.max(0, (1 - lp) / 0.18);
}

/** 终点淡入透明度：阈值之前为 0，之后在 END_FADE_SPAN 内升到 1。 */
export function endStateOpacity(progress: number): number {
  const p = clampProgress(progress);
  if (p < END_THRESHOLD) return 0;
  return Math.min(1, (p - END_THRESHOLD) / END_FADE_SPAN);
}

/** 是否已经到达终点状态（progress ≥ END_THRESHOLD）。 */
export function isEndStateActive(progress: number): boolean {
  return clampProgress(progress) >= END_THRESHOLD;
}

/**
 * 卡片整体透明度（叠加终点退场）。
 *
 * 终点出现后，隧道里的卡片随终点一起退场，避免文字与高速卡片叠在一起。
 */
export function cardOpacityAt(
  progress: number,
  index: number,
  total: number = TUNNEL_CARD_COUNT,
): number {
  return Math.min(
    cardOpacity(cardLocalProgress(progress, index, total)),
    1 - endStateOpacity(progress),
  );
}

/** 卡片在进度 lp 时的 z 纵深（px）。手机端用更浅的隧道。 */
export function tunnelDepth(localProgress: number, mobile: boolean = false): number {
  const profile = mobile ? MOBILE_TUNNEL : DESKTOP_TUNNEL;
  return profile.farZ + (profile.nearZ - profile.farZ) * clampProgress(localProgress);
}

/** 卡片在隧道横截面里的基准位置与倾斜。 */
export function cardLayout(index: number, total: number = TUNNEL_CARD_COUNT): CardLayout {
  const i = safeIndex(index, total);
  const angle = (i * 137.5 * Math.PI) / 180;
  const radiusX = 0.28 + (i % 3) * 0.08;
  const radiusY = 0.26 + (i % 2) * 0.09;
  return {
    angle,
    baseXvw: Math.cos(angle) * radiusX * 100,
    baseYvh: Math.sin(angle) * radiusY * 100,
    rotation: (i % 2 === 0 ? 1 : -1) * (3 + (i % 5) * 2),
    ...cardWindow(i, total),
  };
}

/** 标题的放大 / 淡出映射：卡片抵达前先放大，随后让位。 */
export function heroFrame(progress: number): { scale: number; opacity: number } {
  const p = clampProgress(progress);
  const scale = 0.82 + Math.min(1, p / 0.5) * 0.28 + (p > 0.5 ? (p - 0.5) * 0.45 : 0);
  const opacity = p < 0.3 ? 1 : Math.min(1, Math.max(0, (0.52 - p) / 0.22));
  return { scale, opacity };
}

/** 底部滚动提示：只在最开头出现。 */
export function scrollCueOpacity(progress: number): number {
  return clampProgress(progress) < 0.12 ? 1 : 0;
}

/** 终点说明相对画面中心的初始偏移（px）：淡入时向上落位。 */
export function endStateOffsetY(progress: number): number {
  return (1 - endStateOpacity(progress)) * 12;
}
