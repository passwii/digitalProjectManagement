/**
 * 日期计算的纯逻辑层（样式化日期组件）。
 *
 * 为什么要单独抽一层：日期组件要覆盖闰年、跨月补白、本周边界、min/max 值域，
 * 这些全是纯计算，不该埋在 JSX 里。而项目的单测 runner `test:unit`
 * 用的是 `tsconfig.test.json`（只有 ES2022 类型、**没有 DOM**），
 * 所以这一层不能出现任何 DOM / React 类型，才能被 node:test 直接覆盖。
 *
 * 时区口径（全文件唯一硬约束）：
 *   所有日期一律用 `new Date(y, m, d)` **本地时区**构造，
 *   输出再用 `toISO()` 手工拼 `YYYY-MM-DD`，
 *   绝不调用 `Date.prototype.toISOString()` —— 那是 UTC，
 *   在 UTC+8 的 00:00–08:00 会把「今天」算成「昨天」。
 *   （`labels.ts` 的 `todayISO()` 正是这个隐患，三处调用方各自重复了本地版实现。）
 */

/** 一周的起始日：0=周日 … 1=周一。项目按国内习惯以**周一**为一周起点。 */
export const WEEK_START_MONDAY = 1;

/** 完整的七天表头文案，全中文单字（对齐「直角控制台」的密度语言）。 */
export const WEEKDAY_LABELS = ["一", "二", "三", "四", "五", "六", "日"] as const;

/** 月历固定 6 行 × 7 列：即使某月只需 5 行也保持 6 行，避免切换月份时弹层高度跳动。 */
export const CALENDAR_ROWS = 6;

/** `YYYY-MM-DD` 的宽松正则：只校验形状，真实有效性交给 `parseISO`。 */
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})/;

/** `YYYY-MM`。 */
const ISO_MONTH_RE = /^(\d{4})-(\d{2})/;

export interface YMD {
  year: number;
  /** 0 起（与原生 `Date` 一致），只有对外文案时才 +1。 */
  month: number;
  day: number;
}

/** 把 `YYYY-MM-DD` 拆成三段。容忍尾部的时间部分（`2026-09-29T10:00:00` 这类后端值）。 */
export function parseISO(value?: string | null): YMD | null {
  if (!value) return null;
  const matched = ISO_DATE_RE.exec(value.trim());
  if (!matched) return null;
  const year = Number(matched[1]);
  const month = Number(matched[2]) - 1;
  const day = Number(matched[3]);
  // 形状对但实际不存在的日期（如 2026-02-30）要判为无效，否则 new Date 会静默滚到三月。
  if (month < 0 || month > 11 || day < 1 || day > 31) return null;
  const probe = new Date(year, month, day);
  if (probe.getFullYear() !== year || probe.getMonth() !== month || probe.getDate() !== day) return null;
  return { year, month, day };
}

/** 把三段拼回 `YYYY-MM-DD`（本地口径，不经 UTC）。 */
export function toISO(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** 本地时区的今天。 */
export function todayISO(now: Date = new Date()): string {
  return toISO(now.getFullYear(), now.getMonth(), now.getDate());
}

/**
 * 两个 `YYYY-MM-DD` 的字典序比较。
 *
 * 刻意用字符串比较而不是 `Date`：格式固定为等宽 `YYYY-MM-DD`，
 * 字典序与时间序天然一致，且省掉一次时区换算的出错面。
 * 无法解析的值一律排到最前（视为最久远），避免脏数据卡住范围比较。
 */
export function compareISO(a?: string | null, b?: string | null): number {
  const left = a && parseISO(a) ? a.slice(0, 10) : "";
  const right = b && parseISO(b) ? b.slice(0, 10) : "";
  if (left === right) return 0;
  if (!left) return -1;
  if (!right) return 1;
  return left < right ? -1 : 1;
}

export function isSameDay(a?: string | null, b?: string | null): boolean {
  return compareISO(a, b) === 0;
}

/** `iso` 落在 `[min, max]` 闭区间内；两端 `undefined` 表示不限。 */
export function isWithinBounds(iso: string, min?: string | null, max?: string | null): boolean {
  if (!parseISO(iso)) return false;
  if (min && compareISO(iso, min) < 0) return false;
  if (max && compareISO(iso, max) > 0) return false;
  return true;
}

export interface CalendarCell {
  /** 该格的 `YYYY-MM-DD`。 */
  iso: string;
  day: number;
  /** 是否属于当前展示的月份（false = 上下月补白）。 */
  inMonth: boolean;
}

/**
 * 把 `getDay()` 的 0=周日 换算成「以周一为首」的偏移。
 *
 * `Date.getDay()`：周日=0、周一=1 … 周六=6；
 * 而本项目的周历首列是**周一**：周一=0、周二=1 … 周日=6。
 * 于是偏移 = `weekday - WEEK_START_MONDAY`，再用 `+7` 避免取模前为负。
 *
 * 这里的 +7 不是可选的修饰：直接写 `weekday - WEEK_START_MONDAY` 时，
 * 周日(0) 会得到 -1，`% 7` 在 JS 里保留符号 → 结果是 -1 而非 6，
 * 导致整个月历错位一天、周日跑到第一列。
 */
function weekIndex(weekday: number): number {
  return (weekday + 7 - WEEK_START_MONDAY) % 7;
}

/**
 * 生成某个月的日历矩阵。
 *
 * 固定 6 行 × 7 列并以周一为首列。首行需要补多少天由该月 1 号是周几决定。
 *
 * 固定 6 行是为了让切换月份时弹层不跳高 —— 有些月份 28 天（4 行）、
 * 有些 31 天（5 行），若按需行数渲染，2 月↔3 月会看到弹层高度突变。
 */
export function buildMonthMatrix(year: number, month: number): CalendarCell[] {
  const offset = weekIndex(new Date(year, month, 1).getDay());
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const cells: CalendarCell[] = [];
  // 补白的上月天数：month 为 0 时 Date 会正确滚到上一年 12 月。
  const prevDaysInMonth = new Date(year, month, 0).getDate();

  for (let index = 0; index < CALENDAR_ROWS * 7; index += 1) {
    const dayOffset = index - offset;
    let cellYear = year;
    let cellMonth = month;
    let day: number;
    let inMonth = true;

    if (dayOffset < 0) {
      cellMonth = month - 1;
      if (cellMonth < 0) {
        cellMonth = 11;
        cellYear -= 1;
      }
      day = prevDaysInMonth + dayOffset + 1;
      inMonth = false;
    } else if (dayOffset >= daysInMonth) {
      cellMonth = month + 1;
      if (cellMonth > 11) {
        cellMonth = 0;
        cellYear += 1;
      }
      day = dayOffset - daysInMonth + 1;
      inMonth = false;
    } else {
      day = dayOffset + 1;
    }

    cells.push({ iso: toISO(cellYear, cellMonth, day), day, inMonth });
  }
  return cells;
}

/** 月份标题文案：`2026 年 9 月`。 */
export function formatMonthTitle(year: number, month: number): string {
  return `${year} 年 ${month + 1} 月`;
}

/**
 * 解析日期，失败时回退到「今天」。
 *
 * 单独抽一层是为了让 TypeScript 知道返回值一定非 null：
 * `parseISO(x) ?? parseISO(todayISO())` 的静态类型仍是 `YMD | null`
 * （第二个 `parseISO` 也可能返回 null），每个调用点都要重复一遍断言。
 * `todayISO()` 永远产得出合法日期，所以这里的非空是构造性保证。
 */
export function resolveDate(value?: string | null): YMD {
  const parsed = parseISO(value);
  if (parsed) return parsed;
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth(), day: now.getDate() };
}

/** 同上，但只取年月（渲染月历标题用）。 */
export function resolveMonth(value?: string | null): { year: number; month: number } {
  const { year, month } = resolveDate(value);
  return { year, month };
}

/** 该月第一天（`YYYY-MM-DD`）。 */
export function startOfMonth(value?: string | null): string {
  const parsed = resolveDate(value);
  return toISO(parsed.year, parsed.month, 1);
}

/** 该月最后一天（`YYYY-MM-DD`）。 */
export function endOfMonth(value?: string | null): string {
  const parsed = resolveDate(value);
  return toISO(parsed.year, parsed.month, new Date(parsed.year, parsed.month + 1, 0).getDate());
}

/**
 * 本周周一（`YYYY-MM-DD`）。
 */
export function startOfWeek(value?: string | null): string {
  const parsed = resolveDate(value);
  const back = weekIndex(new Date(parsed.year, parsed.month, parsed.day).getDay());
  return shiftDays(toISO(parsed.year, parsed.month, parsed.day), -back);
}

/** 本周周日（`YYYY-MM-DD`）。 */
export function endOfWeek(value?: string | null): string {
  const parsed = resolveDate(value);
  const weekday = new Date(parsed.year, parsed.month, parsed.day).getDay();
  return shiftDays(toISO(parsed.year, parsed.month, parsed.day), 6 - weekIndex(weekday));
}

/**
 * 平移若干天（`offset` 可负）。
 *
 * 走 `Date.setDate()` 而不是「加毫秒再取日期」：后者在跨月/跨夏令时会差一天，
 * 而 `setDate` 让 `Date` 自己处理进位。
 */
export function shiftDays(iso: string, offset: number): string {
  const parsed = parseISO(iso);
  if (!parsed) return iso;
  const moved = new Date(parsed.year, parsed.month, parsed.day);
  moved.setDate(moved.getDate() + offset);
  return toISO(moved.getFullYear(), moved.getMonth(), moved.getDate());
}

/** 加上若干个月（`offset` 可负），月末日自动收敛到目标月的最后一天。 */
export function addMonths(iso: string, offset: number): string {
  const parsed = parseISO(iso);
  if (!parsed) return iso;
  const target = new Date(parsed.year, parsed.month + offset, 1);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  return toISO(target.getFullYear(), target.getMonth(), Math.min(parsed.day, lastDay));
}

/** 周几中文：星期一 … 星期日。 */
export function weekdayName(iso: string): string {
  const parsed = parseISO(iso);
  if (!parsed) return "";
  const index = weekIndex(new Date(parsed.year, parsed.month, parsed.day).getDay());
  return `星期${WEEKDAY_LABELS[index]}`;
}

/**
 * 完整的无障碍名称：`2026年9月29日 星期二`。
 *
 * 供日期格的 `aria-label` 用 —— 只读「29」对屏幕阅读器毫无意义。
 * 视觉上仍只显示数字，文案只进无障碍树。
 */
export function formatAriaDate(iso: string): string {
  const parsed = parseISO(iso);
  if (!parsed) return iso;
  return `${parsed.year}年${parsed.month + 1}月${parsed.day}日 ${weekdayName(iso)}`;
}

/** `YYYY-MM-DD` → `YYYY-MM`，MonthPicker 用。 */
export function monthKey(value?: string | null): string {
  if (!value) return "";
  const matched = ISO_MONTH_RE.exec(value.trim());
  if (!matched) return "";
  const month = Number(matched[2]);
  if (month < 1 || month > 12) return "";
  return `${matched[1]}-${String(month).padStart(2, "0")}`;
}

/** `YYYY-MM-DD` → `2026 年 9 月 29 日`，触发器上的展示文案。 */
export function formatDisplayDate(value?: string | null, placeholder = "-"): string {
  const parsed = parseISO(value);
  if (!parsed) return placeholder;
  return `${parsed.year} 年 ${parsed.month + 1} 月 ${parsed.day} 日`;
}

/** `YYYY-MM` → `2026 年 9 月`，MonthPicker 触发器的展示文案。 */
export function formatDisplayMonth(value?: string | null, placeholder = "-"): string {
  const key = monthKey(value);
  if (!key) return placeholder;
  const matched = ISO_MONTH_RE.exec(key);
  if (!matched) return placeholder;
  return `${Number(matched[1])} 年 ${Number(matched[2])} 月`;
}

/** 区间是否已凑齐两端（`from` 与 `to` 都有效，且不倒挂）。 */
export function isCompleteRange(range?: { from?: string | null; to?: string | null } | null): boolean {
  if (!range) return false;
  const { from, to } = range;
  if (!parseISO(from) || !parseISO(to)) return false;
  return compareISO(from, to) <= 0;
}

/** `iso` 是否落在区间内（未凑齐两端时只按已有的一端判断）。 */
export function isInRange(iso: string, range?: { from?: string | null; to?: string | null } | null): boolean {
  if (!range) return false;
  const { from, to } = range;
  if (parseISO(from) && compareISO(iso, from) < 0) return false;
  if (parseISO(to) && compareISO(iso, to) > 0) return false;
  return parseISO(from) !== null || parseISO(to) !== null;
}

export type QuickPresetKind = "today" | "week" | "month" | "clear";

export interface QuickPreset {
  kind: QuickPresetKind;
  label: string;
  /** 「清除」不产出值，其余产出 `YYYY-MM-DD`。 */
  resolve: (today: string) => string | null;
}

/**
 * 快捷选择条。
 *
 * 「今天 / 本周 / 本月」以**打开弹层当天**为基准 —— 用户看到月历时，
 * 「本周」指的就是眼前这个月历所在的那一周。
 */
export const QUICK_PRESETS: readonly QuickPreset[] = [
  { kind: "today", label: "今天", resolve: (today) => today },
  { kind: "week", label: "本周", resolve: (today) => startOfWeek(today) },
  { kind: "month", label: "本月", resolve: (today) => startOfMonth(today) },
  { kind: "clear", label: "清除", resolve: () => null },
];
