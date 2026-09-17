"use client";

import { AnimatePresence, m, useReducedMotion } from "framer-motion";
import { useEffect, useState } from "react";
import styles from "./ActivityBar.module.css";

export default function ActivityBar({ active, label }: { active: boolean; label: string }) {
  const reduced = useReducedMotion();
  const [visible, setVisible] = useState(active);
  const [completing, setCompleting] = useState(false);
  const [lastLabel, setLastLabel] = useState(label);

  useEffect(() => {
    if (!label) return;
    setLastLabel(label);
  }, [label]);

  useEffect(() => {
    if (active) {
      setVisible(true);
      setCompleting(false);
      return;
    }
    if (!visible) return;
    setCompleting(true);
    const timer = window.setTimeout(() => setVisible(false), reduced ? 0 : 220);
    return () => window.clearTimeout(timer);
  }, [active, reduced, visible]);

  return (
    <AnimatePresence>
      {visible && (
        <m.div
          className={styles.bar}
          role="progressbar"
          aria-label={lastLabel || "系统正在处理"}
          initial={reduced ? { opacity: 1 } : { opacity: 0, scaleX: 0 }}
          animate={reduced ? { opacity: 1 } : { opacity: 1, scaleX: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reduced ? 0 : 0.22 }}
        >
          <m.span
            className={styles.track}
            initial={false}
            animate={
              reduced
                ? { scaleX: 1 }
                : completing
                ? { scaleX: 1 }
                : { scaleX: [0.08, 0.72, 0.9] }
            }
            transition={
              reduced
                ? { duration: 0 }
                : completing
                ? { duration: 0.22, ease: "easeOut" }
                : { duration: 1.8, ease: "easeOut" }
            }
          />
        </m.div>
      )}
    </AnimatePresence>
  );
}
