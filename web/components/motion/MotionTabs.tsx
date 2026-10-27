"use client";

import { AnimatePresence, m, useReducedMotion } from "framer-motion";
import { useId, useRef, type KeyboardEvent } from "react";
import Select from "@/components/ui/Select";
import { AV_EASE, AV_MOTION } from "@/lib/av/motion";
import s from "./MotionTabs.module.css";

interface Item<T extends string> {
  id: T;
  label: string;
}

export default function MotionTabs<T extends string>({
  items,
  active,
  onChange,
  panelOffset = 3,
  children,
}: {
  items: Item<T>[];
  active: T;
  onChange: (next: T) => void;
  panelOffset?: number;
  children: React.ReactNode;
}) {
  const reduced = useReducedMotion();
  const layoutId = useId();
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);

  function onTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next = index;
    if (event.key === "ArrowRight") next = (index + 1) % items.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + items.length) % items.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = items.length - 1;
    else return;
    event.preventDefault();
    buttons.current[next]?.focus();
    buttons.current[next]?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    onChange(items[next].id);
  }

  return (
    <>
      <div className={s.mobileSelect}>
        <Select
          surface="console"
          aria-label="选择页面分区"
          value={active}
          onChange={(value) => onChange(value as T)}
        >
          {items.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
        </Select>
      </div>
      <div className={`tabs detail-tabs ${s.tabList}`} role="tablist" aria-label="页面分区">
        {items.map((item, index) => (
          <button
            key={item.id}
            ref={(node) => { buttons.current[index] = node; }}
            id={`${layoutId}-tab-${index}`}
            type="button"
            role="tab"
            aria-selected={active === item.id}
            aria-controls={`${layoutId}-panel`}
            tabIndex={active === item.id ? 0 : -1}
            className={active === item.id ? "active" : ""}
            onClick={() => onChange(item.id)}
            onKeyDown={(event) => onTabKeyDown(event, index)}
          >
            {item.label}
            {active === item.id && !reduced && (
              <m.span
                layoutId={`tab-${layoutId}`}
                transition={{ duration: AV_MOTION.quick, ease: AV_EASE.standard }}
                style={{ position: "absolute", left: 12, right: 12, bottom: -1, height: 2, background: "var(--brand)" }}
              />
            )}
          </button>
        ))}
      </div>
      <AnimatePresence mode="wait" initial={false}>
        <m.div
          key={active}
          id={`${layoutId}-panel`}
          role="tabpanel"
          aria-labelledby={`${layoutId}-tab-${items.findIndex((item) => item.id === active)}`}
          aria-label={items.find((item) => item.id === active)?.label}
          initial={reduced ? false : { opacity: 0, y: panelOffset }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduced ? { opacity: 1 } : { opacity: 0 }}
          transition={{ duration: reduced ? 0 : AV_MOTION.quick, ease: AV_EASE.standard }}
        >
          {children}
        </m.div>
      </AnimatePresence>
    </>
  );
}
