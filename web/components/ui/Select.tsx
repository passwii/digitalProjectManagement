"use client";

import {
  Children,
  Fragment,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import styles from "./Select.module.css";

export type SelectProps = {
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  name?: string;
  required?: boolean;
  disabled?: boolean;
  "aria-label"?: string;
  title?: string;
  className?: string;
  surface?: "console" | "spark";
  children: ReactNode;
};

type Option = { value: string; label: string; disabled: boolean };
type Position = { top: number; left: number; width: number; maxHeight: number };

function optionText(children: ReactNode): string {
  return Children.toArray(children).map((child) => {
    if (typeof child === "string" || typeof child === "number") return String(child);
    if (isValidElement<{ children?: ReactNode }>(child)) return optionText(child.props.children);
    return "";
  }).join("");
}

function readOptions(children: ReactNode): Option[] {
  const options: Option[] = [];
  function visit(nodes: ReactNode) {
    Children.forEach(nodes, (child) => {
      if (!isValidElement<{ children?: ReactNode; value?: string | number; disabled?: boolean }>(child)) return;
      if (child.type === Fragment) {
        visit(child.props.children);
      } else if (child.type === "option") {
        const label = optionText(child.props.children);
        options.push({
          value: child.props.value == null ? label : String(child.props.value),
          label,
          disabled: !!child.props.disabled,
        });
      }
    });
  }
  visit(children);
  return options;
}

export default function Select({
  value,
  defaultValue,
  onChange,
  name,
  required = false,
  disabled = false,
  "aria-label": ariaLabel,
  title,
  className,
  surface = "console",
  children,
}: SelectProps) {
  const options = useMemo(() => readOptions(children), [children]);
  const [ownValue, setOwnValue] = useState<string | undefined>(defaultValue);
  const currentValue = value !== undefined ? value : ownValue ?? options.find((option) => !option.disabled)?.value ?? "";
  const selected = options.find((option) => option.value === currentValue);
  const enabledIndices = options.flatMap((option, index) => option.disabled ? [] : [index]);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [invalid, setInvalid] = useState(false);
  const [position, setPosition] = useState<Position | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const typeaheadRef = useRef({ query: "", at: 0 });
  const id = useId().replace(/:/g, "");
  const listId = `select-list-${id}`;
  const optionId = (index: number) => `select-option-${id}-${index}`;

  const close = useCallback(() => {
    setOpen(false);
    typeaheadRef.current = { query: "", at: 0 };
  }, []);

  const show = useCallback(() => {
    if (disabled || enabledIndices.length === 0) return;
    const selectedIndex = options.findIndex((option) => option.value === currentValue && !option.disabled);
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : enabledIndices[0]);
    setOpen(true);
  }, [currentValue, disabled, enabledIndices, options]);

  const choose = useCallback((index: number) => {
    const option = options[index];
    if (!option || option.disabled) return;
    if (value === undefined) setOwnValue(option.value);
    if (option.value !== currentValue) onChange?.(option.value);
    setInvalid(false);
    close();
    triggerRef.current?.focus();
  }, [close, currentValue, onChange, options, value]);

  function move(direction: 1 | -1) {
    if (enabledIndices.length === 0) return;
    const current = enabledIndices.indexOf(activeIndex);
    const next = (current + direction + enabledIndices.length) % enabledIndices.length;
    setActiveIndex(enabledIndices[next]);
  }

  function search(key: string) {
    const now = Date.now();
    const previous = typeaheadRef.current;
    const query = now - previous.at < 700 ? previous.query + key.toLocaleLowerCase() : key.toLocaleLowerCase();
    typeaheadRef.current = { query, at: now };
    const needle = query.split("").every((letter) => letter === query[0]) ? query[0] : query;
    const start = Math.max(0, enabledIndices.indexOf(activeIndex) + 1);
    const cycle = [...enabledIndices.slice(start), ...enabledIndices.slice(0, start)];
    const match = cycle.find((index) => options[index].label.trim().toLocaleLowerCase().startsWith(needle));
    if (match !== undefined) setActiveIndex(match);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (disabled) return;
    if (event.key === "Tab") {
      close();
      return;
    }
    if (event.key === "Escape") {
      if (open) {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) show();
      else move(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      if (!open) show();
      setActiveIndex(event.key === "Home" ? enabledIndices[0] ?? -1 : enabledIndices[enabledIndices.length - 1] ?? -1);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (open) choose(activeIndex);
      else show();
      return;
    }
    if (event.key.length === 1 && !event.altKey && !event.ctrlKey && !event.metaKey && event.key !== " ") {
      if (!open) show();
      search(event.key);
    }
  }

  // Modal listens for Escape on document capture. Window capture lets the open
  // listbox consume the first Escape and leaves the next one for its dialog.
  useEffect(() => {
    if (!open) return;
    const onEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      close();
      triggerRef.current?.focus();
    };
    window.addEventListener("keydown", onEscape, true);
    return () => window.removeEventListener("keydown", onEscape, true);
  }, [close, open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !listRef.current?.contains(target)) close();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [close, open]);

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    let frame = 0;
    const update = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const viewport = window.visualViewport;
      const edgeLeft = viewport?.offsetLeft ?? 0;
      const edgeTop = viewport?.offsetTop ?? 0;
      const edgeRight = edgeLeft + (viewport?.width ?? window.innerWidth);
      const edgeBottom = edgeTop + (viewport?.height ?? window.innerHeight);
      const gap = 4;
      const inset = 8;
      const below = edgeBottom - rect.bottom - gap - inset;
      const above = rect.top - edgeTop - gap - inset;
      const flip = below < Math.min(220, above) && above > below;
      const maxHeight = Math.max(44, Math.min(320, flip ? above : below));
      const width = Math.min(rect.width, edgeRight - edgeLeft - inset * 2);
      const left = Math.max(edgeLeft + inset, Math.min(rect.left, edgeRight - inset - width));
      const top = flip ? Math.max(edgeTop + inset, rect.top - gap - maxHeight) : Math.min(rect.bottom + gap, edgeBottom - inset - maxHeight);
      setPosition({ top, left, width, maxHeight });
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    window.visualViewport?.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("scroll", schedule);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      window.visualViewport?.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("scroll", schedule);
    };
  }, [open]);

  useEffect(() => {
    if (open && activeIndex >= 0) {
      document.getElementById(optionId(activeIndex))?.scrollIntoView({ block: "nearest" });
    }
  }, [activeIndex, open]);

  useEffect(() => {
    if (disabled) close();
  }, [close, disabled]);

  useEffect(() => {
    if (!open || (activeIndex >= 0 && options[activeIndex] && !options[activeIndex].disabled)) return;
    const selectedIndex = options.findIndex((option) => option.value === currentValue && !option.disabled);
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : enabledIndices[0] ?? -1);
  }, [activeIndex, currentValue, enabledIndices, open, options]);

  useEffect(() => {
    const form = triggerRef.current?.closest("form");
    if (!form) return;
    const reset = () => {
      setOwnValue(defaultValue);
      setInvalid(false);
      close();
    };
    form.addEventListener("reset", reset);
    return () => form.removeEventListener("reset", reset);
  }, [close, defaultValue]);

  useEffect(() => {
    if (currentValue) setInvalid(false);
  }, [currentValue]);

  return (
    <span className={`${styles.root}${className ? ` ${className}` : ""}`}>
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-controls={listId}
        aria-expanded={open}
        aria-activedescendant={open && activeIndex >= 0 ? optionId(activeIndex) : undefined}
        aria-label={ariaLabel}
        aria-invalid={invalid || undefined}
        aria-required={required || undefined}
        title={title}
        disabled={disabled}
        className={`${styles.trigger} ${surface === "spark" ? styles.spark : styles.console}`}
        onClick={() => open ? close() : show()}
        onKeyDown={handleKeyDown}
      >
        <span className={styles.label}>{selected?.label ?? ""}</span>
        <svg className={styles.chevron} width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
          <path d="m3 5 4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {(name || required) && (
        <input
          className={styles.proxy}
          type="text"
          tabIndex={-1}
          aria-hidden="true"
          name={name}
          value={currentValue}
          required={required}
          disabled={disabled}
          readOnly
          onInvalid={(event) => {
            event.preventDefault();
            setInvalid(true);
            triggerRef.current?.focus();
            requestAnimationFrame(() => triggerRef.current?.focus());
          }}
        />
      )}
      {open && position && createPortal(
        <div
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label={ariaLabel}
          className={`${styles.listbox} ${surface === "spark" ? styles.spark : styles.console}`}
          style={position}
          onMouseDown={(event) => event.preventDefault()}
        >
          {options.map((option, index) => (
            <div
              key={`${index}-${option.value}`}
              id={optionId(index)}
              role="option"
              aria-selected={option.value === currentValue}
              aria-disabled={option.disabled || undefined}
              className={`${styles.option}${index === activeIndex ? ` ${styles.active}` : ""}${option.value === currentValue ? ` ${styles.selected}` : ""}${option.disabled ? ` ${styles.optionDisabled}` : ""}`}
              onPointerMove={() => { if (!option.disabled) setActiveIndex(index); }}
              onClick={() => choose(index)}
            >
              <span className={styles.optionText}>{option.label}</span>
              {option.value === currentValue && <span className={styles.check} aria-hidden="true">✓</span>}
            </div>
          ))}
        </div>,
        document.body,
      )}
    </span>
  );
}
