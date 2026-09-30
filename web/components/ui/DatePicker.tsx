"use client";
/**
 * 样式化日期组件（替代原生 `<input type="date">` / `<input type="month">`）。
 *
 * 导出三个组件，共用同一份月历实现：
 *   · `DatePicker`      —— 单选，值契约 `YYYY-MM-DD`
 *   · `DateRangePicker` —— 区间，值契约 `{ from, to }`
 *   · `MonthPicker`     —— 月粒度，值契约 `YYYY-MM`（服务报表页的按月筛选）
 *
 * 行为对标 `ProjectPicker`：mousedown 外部关闭、Esc 关闭并归还焦点、
 * 弹层 `z-index: 45`（低于 Modal 的 60，在 Dialog 内部打开不会被遮罩吞掉）。
 *
 * 三处与原生输入不同、迁移时需要注意的地方：
 *   1. 触发器是 `<button type="button">`，因为 `Field` 渲染的是 `<label>`，
 *      `<label>` 只把「第一个可交互后代」关联为自身控件，纯 div 会点不动。
 *   2. 错误态（`invalid`）要自己实现边框与焦点环 —— `globals.css` 里那条
 *      `.field [aria-invalid="true"]` 只作用于原生 `input/select/textarea`，
 *      `<button>` 吃不到，不实现就是视觉回归。
 *   3. 月历用 `role="grid"` + roving tabindex，只让当前焦点格 `tabIndex=0`。
 *      Modal 的 Tab 锁定会把弹层内所有可聚焦元素纳入循环，
 *      若 42 个日期格都是可 Tab 的按钮，用户在 Dialog 里按 Tab 要穿过整个月历。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  resolvePopoverPlacement,
  type PopoverPlacement,
  type Rect,
} from "@/lib/datePopoverPosition";
import { MODAL_BODY_ATTR } from "@/lib/modalFocus";
import {
  buildMonthMatrix,
  compareISO,
  endOfMonth,
  formatAriaDate,
  formatDisplayDate,
  formatDisplayMonth,
  formatMonthTitle,
  isCompleteRange,
  isInRange,
  isSameDay,
  isWithinBounds,
  monthKey,
  parseISO,
  QUICK_PRESETS,
  resolveMonth,
  shiftDays,
  startOfMonth,
  startOfWeek,
  addMonths,
  todayISO,
  toISO,
  WEEKDAY_LABELS,
} from "@/lib/dateCore";
import type { QuickPresetKind } from "@/lib/dateCore";
import { registerNestedPopover } from "@/lib/nestedPopover";
import st from "./DatePicker.module.css";

export interface DateRange {
  from?: string | null;
  to?: string | null;
}

/** 三者共有的 props。默认值全部是中文字面量（全站无 i18n 框架）。 */
interface BaseProps {
  /** 表单内宿主用 38px，工具栏内用 32px（对齐 `.toolbar-field` 的既有高度）。 */
  size?: "field" | "toolbar";
  placeholder?: string;
  ariaLabel?: string;
  disabled?: boolean;
  /** 错误态。对应原生输入上的 `aria-invalid`。 */
  invalid?: boolean;
  name?: string;
  className?: string;
  /** 行内排布时的宽度契约（迁移自原生 input 的 `style={{ width: 140 }}`）。 */
  style?: React.CSSProperties;
  /** 是否显示底部快捷选择条（今天 / 本周 / 本月 / 清除）。 */
  quick?: boolean;
  min?: string;
  max?: string;
  /** 弹层头部文案的无障碍标签。 */
  popoverLabel?: string;
}

function isDisabledDay(iso: string, min?: string, max?: string): boolean {
  return !isWithinBounds(iso, min, max);
}

/**
 * 弹层行为：外部点击关闭 + Esc 归还焦点 + 向 Modal 登记嵌套关系。
 *
 * Esc 必须登记到 `nestedPopover` —— Modal 的 Esc 监听在 capture 阶段且先执行，
 * 组件内部无法抢占（详见 `lib/nestedPopover.ts` 顶部的说明）。
 *
 * `triggerRef` 由调用方持有并传进来，而不是在这里 `useRef` 再返回：
 * 调用方的 `close()` 需要把焦点还给触发器，若 ref 在这里创建，
 * `close` 就得定义在 `usePopoverBehavior` 之前去闭包引用一个尚未初始化的
 * `const`（TDZ），并且拿不到它作依赖 —— 改成由外部传入后依赖关系是显式的。
 */
function usePopoverBehavior(
  open: boolean,
  close: (focusTrigger?: boolean) => void,
  triggerRef: React.RefObject<HTMLButtonElement>,
) {
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const release = registerNestedPopover();
    // 用 mousedown 而非 click：click 会等按钮的 onClick 冒泡完，
    // 导致「点触发器关闭弹层」和「点外部关闭弹层」互相打架。
    const onDocDown = (event: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(event.target as Node)) close(false);
    };
    document.addEventListener("mousedown", onDocDown);
    return () => {
      document.removeEventListener("mousedown", onDocDown);
      release();
    };
  }, [open, close]);

  // Esc 挂在弹层容器的 onKeyDown 上（冒泡阶段）。Modal 在 capture 阶段已经
  // 因 hasOpenNestedPopover() 而放行，这里才真正收到事件。
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // stopPropagation 是必要的：日期弹层可能套在项目选择器等嵌套弹层里，
      // 不拦住会一次关掉两层。
      event.stopPropagation();
      close(true);
    },
    [close],
  );

  return { boxRef, onKeyDown };
}

/** 把 `DOMRect` 收窄成本模块定位需要的结构。 */
function toRect(rect: DOMRect): Rect {
  return {
    top: rect.top,
    left: rect.left,
    right: rect.right,
    bottom: rect.bottom,
    width: rect.width,
    height: rect.height,
  };
}

/**
 * 量出弹层可用的边界。
 *
 * 优先取最近的 `[data-modal-body]`（Dialog / Drawer 的正文区）—— 它自带
 * `overflow: auto`，正是裁掉弹层的那一层；不在弹层里时退回文档根。
 * 再按视口夹一次：容器可能比视口还高（移动端全屏 Dialog），
 * 只有两者相交的那块才是真正看得见的空间。
 */
function measureBoundary(root: HTMLElement): Rect {
  const container = root.closest(`[${MODAL_BODY_ATTR}]`) ?? document.documentElement;
  const rect = container.getBoundingClientRect();
  const top = Math.max(0, rect.top);
  const left = Math.max(0, rect.left);
  const right = Math.min(window.innerWidth, rect.right);
  const bottom = Math.min(window.innerHeight, rect.bottom);
  return {
    top,
    left,
    right,
    bottom,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
}

/**
 * 弹层自适应定位：翻上/翻下 + 高度夹取 + 水平夹取。
 *
 * 两趟渲染：打开后第一趟弹层还没被内联样式约束，量到的就是**自然尺寸**；
 * 算出摆放后第二趟才套上 `maxHeight / left / width`。自然尺寸记在 ref 里，
 * 之后 resize / scroll 重算时复用它 —— 此时弹层已被夹过，再量只会越算越小。
 *
 * 刻意不做 portal：弹层留在 `.root` 内，`Modal` 的 Esc / 焦点锁定 /
 * `nestedPopover` 登记与既有无障碍行为都无需改动；`left` 因此是相对触发器左缘的偏移。
 */
function usePopoverPlacement(
  open: boolean,
  rootRef: React.RefObject<HTMLElement>,
): { popRef: React.RefObject<HTMLDivElement>; placement: PopoverPlacement | null } {
  const popRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<PopoverPlacement | null>(null);
  // `null` 表示「还没量到过自然尺寸」：只会在打开后的第一趟里取一次。
  const naturalRef = useRef<{ width: number; height: number } | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      naturalRef.current = null;
      setPlacement(null);
      return;
    }
    const update = () => {
      const root = rootRef.current;
      const pop = popRef.current;
      if (!root || !pop) return;
      const trigger = toRect(root.getBoundingClientRect());
      if (!naturalRef.current) {
        const natural = toRect(pop.getBoundingClientRect());
        naturalRef.current = { width: natural.width, height: natural.height };
      }
      const boundary = measureBoundary(root);
      setPlacement(resolvePopoverPlacement({ trigger, boundary, popover: naturalRef.current }));
    };
    update();
    // capture 阶段的 scroll 才能收到嵌套滚动容器（如 Dialog 正文）的滚动事件。
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open, rootRef]);

  return { popRef, placement };
}

/** 把摆放结果并进 `style`；未算出摆放时交给 CSS 默认值。 */
function placementStyle(placement: PopoverPlacement | null): React.CSSProperties | undefined {
  if (!placement) return undefined;
  return { maxHeight: placement.maxHeight, left: placement.left, width: placement.width };
}

/** 月历头部：上一月 / 标题 / 下一月。 */
function MonthNav({
  viewISO,
  onShift,
  min,
  max,
}: {
  viewISO: string;
  onShift: (delta: number) => void;
  min?: string;
  max?: string;
}) {
  const view = resolveMonth(viewISO);
  const previous = addMonths(viewISO, -1);
  const next = addMonths(viewISO, 1);
  // 边界：整月都不可选时禁用翻页，避免翻到一片灰还翻回来。
  const prevBlocked = min ? compareISO(previous, min) < 0 : false;
  const nextBlocked = max ? compareISO(next, max) > 0 : false;

  return (
    <div className={st.nav}>
      <button
        type="button"
        className={st.navBtn}
        onClick={() => onShift(-1)}
        disabled={prevBlocked}
        aria-label="上一月"
      >
        ‹
      </button>
      <div className={st.navTitle} aria-live="polite">
        {formatMonthTitle(view.year, view.month)}
      </div>
      <button
        type="button"
        className={st.navBtn}
        onClick={() => onShift(1)}
        disabled={nextBlocked}
        aria-label="下一月"
      >
        ›
      </button>
    </div>
  );
}

/**
 * 日粒度月历。
 *
 * `role="grid"` + roving tabindex：整张表只有当前 `focusedISO` 那一格 `tabIndex=0`，
 * 其余全为 -1，用户 Tab 一次即可越过整个月历。方向键在格间移动。
 */
function DayGrid({
  viewISO,
  onViewChange,
  selected,
  range,
  min,
  max,
  onPick,
}: {
  viewISO: string;
  onViewChange: (iso: string) => void;
  selected?: string | null;
  range?: DateRange | null;
  min?: string;
  max?: string;
  onPick: (iso: string) => void;
}) {
  const view = resolveMonth(viewISO);
  const cells = useMemo(() => buildMonthMatrix(view.year, view.month), [view.year, view.month]);
  const today = todayISO();
  // 焦点格优先取已选值，其次今天，最后这个月的 1 号 —— 保证任何时候都有合法落点。
  const [focusedISO, setFocusedISO] = useState(() => selected || today || startOfMonth(viewISO));

  // 值在弹层外被改动（受控组件重新渲染）时，把焦点格跟上，避免键盘落点漂到旧位置。
  useEffect(() => {
    if (selected && parseISO(selected)) setFocusedISO(selected);
  }, [selected]);

  useEffect(() => {
    setFocusedISO((current) => {
      // 翻月后若焦点格还留在这个月，就沿用它；否则落到目标月的 1 号。
      const parsed = parseISO(current);
      if (parsed && parsed.year === view.year && parsed.month === view.month) return current;
      const kept = selected && parseISO(selected) ? selected : today;
      const keptParsed = parseISO(kept);
      if (keptParsed && keptParsed.year === view.year && keptParsed.month === view.month) return kept;
      return toISO(view.year, view.month, 1);
    });
  }, [view.year, view.month, selected, today]);

  const rangeComplete = isCompleteRange(range);

  function moveFocus(deltaDays: number) {
    const next = shiftDays(focusedISO, deltaDays);
    setFocusedISO(next);
    // 翻到别的月时把视野跟过去，否则焦点格会跑到看不见的地方。
    const parsed = parseISO(next);
    if (parsed && (parsed.year !== view.year || parsed.month !== view.month)) onViewChange(next);
  }

  function onGridKeyDown(event: React.KeyboardEvent) {
    const steps: Record<string, number> = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -7,
      ArrowDown: 7,
    };
    const step = steps[event.key];
    if (step !== undefined) {
      event.preventDefault();
      moveFocus(step);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (!isDisabledDay(focusedISO, min, max)) onPick(focusedISO);
    }
  }

  return (
    <div className={st.gridWrap}>
      <div className={st.weekRow} role="row">
        {WEEKDAY_LABELS.map((label) => (
          // 无障碍名称直接取文字内容「一」…「日」；abbr 属性只对 <th> 有意义，
          // 加在 div 上既不合法也不产生任何效果
          <div key={label} className={st.weekCell} role="columnheader" aria-label={`周${label}`}>
            {label}
          </div>
        ))}
      </div>
      <div
        className={st.grid}
        role="grid"
        aria-label="选择日期"
        onKeyDown={onGridKeyDown}
        // 焦点交给容器统一接管，日期格本身 tabIndex=-1，避免 42 个 Tab 停留点。
        tabIndex={-1}
        ref={(node) => node?.focus()}
      >
        {cells.map((cell) => {
          const disabled = isDisabledDay(cell.iso, min, max);
          const isSelected = range ? false : isSameDay(cell.iso, selected);
          const isEdge =
            range && (isSameDay(cell.iso, range.from) || isSameDay(cell.iso, range.to));
          const inRange = rangeComplete && isInRange(cell.iso, range);
          const isToday = isSameDay(cell.iso, today);
          const className = [
            st.day,
            cell.inMonth ? "" : st.dayMuted,
            isToday ? st.dayToday : "",
            isSelected || isEdge ? st.daySelected : "",
            inRange ? st.dayInRange : "",
            disabled ? st.dayDisabled : "",
          ]
            .filter(Boolean)
            .join(" ");
          return (
            /*
             * 必须是 <button> 而不是 <div>：Field 渲染的是 <label>，
             * 点击 label 里的非交互元素时浏览器会补一次「转发点击」给该 label
             * 关联的控件 —— 于是点一下日期格会同时触发触发器的 onClick，
             * 弹层刚打开就被自己关掉（区间选择直接废掉）。
             * 交互元素不参与转发，问题从根上消失，语义也顺带对了。
             */
            <button
              key={cell.iso}
              type="button"
              role="gridcell"
              className={className}
              aria-label={formatAriaDate(cell.iso)}
              aria-selected={isSelected || isEdge || undefined}
              aria-disabled={disabled || undefined}
              tabIndex={cell.iso === focusedISO ? 0 : -1}
              onClick={() => {
                setFocusedISO(cell.iso);
                if (!disabled) onPick(cell.iso);
              }}
            >
              {cell.day}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** 底部快捷选择条。 */
function QuickBar({
  onPick,
  onClear,
  min,
  max,
  isDisabled,
  kinds,
}: {
  onPick: (iso: string) => void;
  onClear: () => void;
  min?: string;
  max?: string;
  isDisabled: boolean;
  /** 允许只渲染其中几条 —— 月粒度下「今天/本周」没有意义。 */
  kinds?: readonly QuickPresetKind[];
}) {
  const today = todayISO();
  return (
    <div className={st.quick}>
      {QUICK_PRESETS.filter((preset) => !kinds || kinds.includes(preset.kind)).map((preset) => {
        if (preset.kind === "clear") {
          return (
            <button
              key={preset.kind}
              type="button"
              className={st.quickBtn}
              onClick={onClear}
              disabled={isDisabled}
            >
              {preset.label}
            </button>
          );
        }
        const target = preset.resolve(today);
        if (!target) return null;
        // 「本周」「本月」落到区间起点，若那个起点越界就整条置灰，
        // 而不是给一个点了没反应却看不出原因的按钮。
        const blocked = isDisabledDay(target, min, max);
        return (
          <button
            key={preset.kind}
            type="button"
            className={st.quickBtn}
            onClick={() => onPick(target)}
            disabled={blocked}
          >
            {preset.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * 触发器 + 弹层外壳，三个组件共用的结构。
 *
 * 关于错误态：这里刻意**不**输出 `aria-invalid`。该属性在 ARIA 规范里只支持
 * `textbox` / `combobox` 等输入角色，`button` 上属于规范外用法（eslint 的
 * jsx-a11y/role-supports-aria-props 会拦）。错误信息改由 `Field` 的
 * `<span role="alert">` 播报 —— 那是项目既有的做法，屏幕阅读器本来就能收到；
 * 触发器这里只负责把错误边框画出来。
 */
function Trigger({
  label,
  placeholder,
  submittedValue,
  ariaLabel,
  disabled,
  invalid,
  size,
  className,
  open,
  onToggle,
  triggerRef,
  children,
  name,
}: {
  label: string;
  placeholder: string;
  /** 随表单提交的值（ISO），与展示用的 `label` 分开。 */
  submittedValue: string;
  ariaLabel: string;
  disabled?: boolean;
  invalid?: boolean;
  size: "field" | "toolbar";
  className?: string;
  open: boolean;
  onToggle: () => void;
  triggerRef: React.RefObject<HTMLButtonElement>;
  children?: React.ReactNode;
  name?: string;
}) {
  return (
    <>
      {/* 触发器是 button，不参与原生表单提交；配一个 hidden 顶替原来的 input。
          值必须是 ISO —— 写 label 会让后端收到 "2026 年 9 月 29 日"。 */}
      {name ? <input type="hidden" name={name} value={submittedValue} readOnly /> : null}
      <button
        type="button"
        ref={triggerRef}
        className={[
          st.trigger,
          size === "toolbar" ? st.triggerToolbar : "",
          invalid ? st.triggerInvalid : "",
          className ? st.triggerHost : "",
        ]
          .filter(Boolean)
          .join(" ")}
        onClick={onToggle}
        disabled={disabled}
        // 触发器用 button + aria-haspopup="dialog"（W3C APG「日期选择对话框」模式）：
        // 它不是可编辑文本框，上 combobox 角色反而不准确。
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={ariaLabel}
        // ISO 原值：展示文案是格式化过的中文，测试与 e2e 需要的是可断言的原值
        data-value={submittedValue}
        title={label === placeholder ? undefined : label}
      >
        <span className={`${st.triggerText}${label === placeholder ? ` ${st.placeholder}` : ""}`}>
          {label}
        </span>
        <span className={st.caret} aria-hidden="true">
          ▾
        </span>
      </button>
      {children}
    </>
  );
}

/** 单选日期。`onChange` 产出精确的 `YYYY-MM-DD`（空值时为 `""`）。 */
export function DatePicker({
  value,
  onChange,
  min,
  max,
  placeholder = "选择日期",
  ariaLabel = "选择日期",
  disabled = false,
  invalid = false,
  size = "field",
  quick = true,
  name,
  className,
  style,
  popoverLabel = "日期选择",
}: BaseProps & {
  value: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [viewISO, setViewISO] = useState(() => value || todayISO());
  const triggerRef = useRef<HTMLButtonElement>(null);
  const close = useCallback(
    (focusTrigger = false) => {
      setOpen(false);
      if (focusTrigger) triggerRef.current?.focus();
    },
    [triggerRef],
  );
  const { boxRef, onKeyDown } = usePopoverBehavior(open, close, triggerRef);
  const { popRef, placement } = usePopoverPlacement(open, boxRef);

  // 打开时把视野对齐到当前值 —— 关掉弹层换了月份再打开，不该停在旧月份。
  useEffect(() => {
    if (open) setViewISO(value || todayISO());
  }, [open, value]);

  const label = value ? formatDisplayDate(value, placeholder) : placeholder;

  return (
    <div
      className={`${st.root}${className ? ` ${st.rootHost}` : ""}`}
      style={style}
      ref={boxRef}
    >
      <Trigger
        label={label}
        placeholder={placeholder}
        submittedValue={value}
        ariaLabel={ariaLabel}
        disabled={disabled}
        invalid={invalid}
        size={size}
        className={className}
        open={open}
        onToggle={() => setOpen((o) => !o)}
        triggerRef={triggerRef}
        name={name}
      />
      {open ? (
        <div
          ref={popRef}
          className={`${st.pop}${placement?.placement === "up" ? ` ${st.popUp}` : ""}`}
          style={placementStyle(placement)}
          role="dialog"
          aria-label={popoverLabel}
          onKeyDown={onKeyDown}
        >
          <MonthNav viewISO={viewISO} onShift={(delta) => setViewISO((v) => addMonths(v, delta))} min={min} max={max} />
          <DayGrid
            viewISO={viewISO}
            onViewChange={setViewISO}
            selected={value}
            min={min}
            max={max}
            onPick={(iso) => {
              onChange(iso);
              close(true);
            }}
          />
          {quick ? (
            <QuickBar
              min={min}
              max={max}
              isDisabled={disabled || !value}
              onPick={(iso) => {
                onChange(iso);
                close(true);
              }}
              onClear={() => {
                onChange("");
                close(true);
              }}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * 日期区间选择。
 *
 * 两段式交互：第一次点定起点，第二次点定终点；终点早于起点时自动对调，
 * 不弹错误提示 —— 用户要的是「一个区间」，不是「按某个顺序输入的两个值」。
 */
export function DateRangePicker({
  value,
  onChange,
  min,
  max,
  placeholder = "选择区间",
  ariaLabel = "选择日期区间",
  disabled = false,
  invalid = false,
  size = "field",
  quick = false,
  name,
  className,
  style,
  popoverLabel = "日期区间选择",
}: BaseProps & {
  value: DateRange;
  onChange: (value: DateRange) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pendingFrom, setPendingFrom] = useState<string | null>(null);
  const [viewISO, setViewISO] = useState(() => value.from || todayISO());
  const triggerRef = useRef<HTMLButtonElement>(null);
  const close = useCallback(
    (focusTrigger = false) => {
      setOpen(false);
      setPendingFrom(null);
      if (focusTrigger) triggerRef.current?.focus();
    },
    [triggerRef],
  );
  const { boxRef, onKeyDown } = usePopoverBehavior(open, close, triggerRef);
  const { popRef, placement } = usePopoverPlacement(open, boxRef);

  // 关掉重开时丢弃未完成的第二段，避免残留一个半截选择。
  useEffect(() => {
    if (open) {
      setPendingFrom(null);
      setViewISO(value.from || todayISO());
    }
  }, [open, value.from]);

  function handlePick(iso: string) {
    if (!pendingFrom) {
      setPendingFrom(iso);
      return;
    }
    const from = compareISO(iso, pendingFrom) <= 0 ? iso : pendingFrom;
    const to = compareISO(iso, pendingFrom) <= 0 ? pendingFrom : iso;
    onChange({ from, to });
    close(true);
  }

  const complete = isCompleteRange(value);
  const preview: DateRange = pendingFrom ? { from: pendingFrom, to: null } : value;
  const label = complete
    ? `${formatDisplayDate(value.from)} — ${formatDisplayDate(value.to)}`
    : value.from
      ? `${formatDisplayDate(value.from)} — ${placeholder}`
      : placeholder;

  return (
    <div
      className={`${st.root}${className ? ` ${st.rootHost}` : ""}`}
      style={style}
      ref={boxRef}
    >
      <Trigger
        label={label}
        // 区间没有「一个」标量值；映射回原生语义就是起始日期。
        placeholder={placeholder}
        submittedValue={value.from || ""}
        ariaLabel={ariaLabel}
        disabled={disabled}
        invalid={invalid}
        size={size}
        className={className}
        open={open}
        onToggle={() => setOpen((o) => !o)}
        triggerRef={triggerRef}
        name={name}
      />
      {open ? (
        <div
          ref={popRef}
          className={`${st.pop}${placement?.placement === "up" ? ` ${st.popUp}` : ""}`}
          style={placementStyle(placement)}
          role="dialog"
          aria-label={popoverLabel}
          onKeyDown={onKeyDown}
        >
          <MonthNav viewISO={viewISO} onShift={(delta) => setViewISO((v) => addMonths(v, delta))} min={min} max={max} />
          <p className={st.hint} aria-live="polite">
            {pendingFrom ? "再选一天作为结束日期" : "选择起始日期"}
          </p>
          <DayGrid
            viewISO={viewISO}
            onViewChange={setViewISO}
            selected={value.from}
            range={preview}
            min={min}
            max={max}
            onPick={handlePick}
          />
          {quick ? (
            <QuickBar
              min={min}
              max={max}
              isDisabled={disabled || (!value.from && !value.to)}
              onPick={(iso) => {
                onChange({ from: startOfWeek(iso), to: iso });
                close(true);
              }}
              onClear={() => {
                onChange({ from: "", to: "" });
                close(true);
              }}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** 月粒度选择，值契约 `YYYY-MM`（对齐原 `<input type="month">`）。 */
export function MonthPicker({
  value,
  onChange,
  min,
  max,
  placeholder = "选择月份",
  ariaLabel = "选择月份",
  disabled = false,
  invalid = false,
  size = "toolbar",
  quick = true,
  name,
  className,
  style,
  popoverLabel = "月份选择",
}: BaseProps & {
  value: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const currentKey = monthKey(value) || monthKey(todayISO());
  const [viewKey, setViewKey] = useState(currentKey);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const close = useCallback(
    (focusTrigger = false) => {
      setOpen(false);
      if (focusTrigger) triggerRef.current?.focus();
    },
    [triggerRef],
  );
  const { boxRef, onKeyDown } = usePopoverBehavior(open, close, triggerRef);
  const { popRef, placement } = usePopoverPlacement(open, boxRef);

  useEffect(() => {
    if (open) setViewKey(monthKey(value) || monthKey(todayISO()));
  }, [open, value]);

  const viewYear = Number(viewKey.slice(0, 4));
  const viewMonth = Number(viewKey.slice(5, 7)) - 1;
  const label = value ? formatDisplayMonth(value, placeholder) : placeholder;

  function shiftMonth(delta: number) {
    const moved = addMonths(`${viewKey}-01`, delta);
    setViewKey(moved.slice(0, 7));
  }

  /**
 * 整个月是否都落在 [min, max] 之外。
 *
 * min/max 与 value 同为 `YYYY-MM` 月份键，**不**是完整日期 —— 这里刻意不
 * 复用 `compareISO`：它只认 `YYYY-MM-DD`，喂给它 `2026-03` 会解析失败并
 * 静默当成「最小值」，结果是 min 完全失效、界外的月份照样能点。
 * `YYYY-MM` 是定宽格式，字典序与时间序天然一致，直接比字符串即可。
 */
function isMonthDisabled(key: string) {
  const minMonth = monthKey(min);
  const maxMonth = monthKey(max);
  if (minMonth && key < minMonth) return true;
  if (maxMonth && key > maxMonth) return true;
  return false;
}

  return (
    <div
      className={`${st.root}${className ? ` ${st.rootHost}` : ""}`}
      style={style}
      ref={boxRef}
    >
      <Trigger
        label={label}
        placeholder={placeholder}
        submittedValue={value}
        ariaLabel={ariaLabel}
        disabled={disabled}
        invalid={invalid}
        size={size}
        className={className}
        open={open}
        onToggle={() => setOpen((o) => !o)}
        triggerRef={triggerRef}
        name={name}
      />
      {open ? (
        <div
          ref={popRef}
          className={`${st.pop} ${st.popMonth}${placement?.placement === "up" ? ` ${st.popUp}` : ""}`}
          style={placementStyle(placement)}
          role="dialog"
          aria-label={popoverLabel}
          onKeyDown={onKeyDown}
        >
          <div className={st.nav}>
            <button type="button" className={st.navBtn} onClick={() => shiftMonth(-12)} aria-label="上一年">
              ‹‹
            </button>
            <button type="button" className={st.navBtn} onClick={() => shiftMonth(-1)} aria-label="上一月">
              ‹
            </button>
            <div className={st.navTitle} aria-live="polite">
              {formatMonthTitle(viewYear, viewMonth)}
            </div>
            <button type="button" className={st.navBtn} onClick={() => shiftMonth(1)} aria-label="下一月">
              ›
            </button>
            <button type="button" className={st.navBtn} onClick={() => shiftMonth(12)} aria-label="下一年">
              ››
            </button>
          </div>
          <div className={st.monthGrid} role="grid" aria-label="选择月份">
            {Array.from({ length: 12 }, (_, month) => {
              const key = `${viewKey.slice(0, 4)}-${String(month + 1).padStart(2, "0")}`;
              const disabled = isMonthDisabled(key);
              const on = key === monthKey(value);
              return (
                <button
                  key={key}
                  type="button"
                  role="gridcell"
                  aria-selected={on || undefined}
                  aria-disabled={disabled || undefined}
                  className={[st.monthCell, on ? st.monthOn : "", disabled ? st.dayDisabled : ""]
                    .filter(Boolean)
                    .join(" ")}
                  disabled={disabled}
                  onClick={() => {
                    onChange(key);
                    close(true);
                  }}
                >
                  {month + 1} 月
                </button>
              );
            })}
          </div>
          {quick ? (
            <QuickBar
              // 月粒度下「今天 / 本周」都落到同一个当月，三个按钮一个行为，
              // 只留「本月 / 清除」。
              kinds={["month", "clear"]}
              isDisabled={disabled || !value}
              onPick={() => {
                onChange(monthKey(todayISO()));
                close(true);
              }}
              onClear={() => {
                onChange("");
                close(true);
              }}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export default DatePicker;
