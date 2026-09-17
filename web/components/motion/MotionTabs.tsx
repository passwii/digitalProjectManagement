"use client";

import { AnimatePresence, m, useReducedMotion } from "framer-motion";
import { useId } from "react";

interface Item<T extends string> {
  id: T;
  label: string;
}

export default function MotionTabs<T extends string>({
  items,
  active,
  onChange,
  children,
}: {
  items: Item<T>[];
  active: T;
  onChange: (next: T) => void;
  children: React.ReactNode;
}) {
  const reduced = useReducedMotion();
  const layoutId = useId();
  return (
    <>
      <div className="tabs detail-tabs" role="tablist">
        {items.map((item) => (
          <button
            key={item.id}
            role="tab"
            aria-selected={active === item.id}
            className={active === item.id ? "active" : ""}
            onClick={() => onChange(item.id)}
          >
            {item.label}
            {active === item.id && !reduced && (
              <m.span
                layoutId={`tab-${layoutId}`}
                style={{ position: "absolute", left: 12, right: 12, bottom: -1, height: 2, background: "var(--brand)" }}
              />
            )}
          </button>
        ))}
      </div>
      <AnimatePresence mode="wait" initial={false}>
        <m.div
          key={active}
          initial={reduced ? false : { opacity: 0, y: 3 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduced ? { opacity: 1 } : { opacity: 0 }}
          transition={{ duration: reduced ? 0 : 0.16 }}
        >
          {children}
        </m.div>
      </AnimatePresence>
    </>
  );
}
