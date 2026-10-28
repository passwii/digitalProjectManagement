"use client";

import { animate, useReducedMotion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { AV_EASE, AV_MOTION } from "@/lib/av/motion";

export default function CountUp({
  value,
  format = (next) => String(Math.round(next)),
}: {
  value: number;
  format?: (value: number) => string;
}) {
  const reduced = useReducedMotion();
  const initial = reduced ? value : 0;
  const displayRef = useRef(initial);
  const [display, setDisplay] = useState(initial);

  useEffect(() => {
    if (reduced) {
      displayRef.current = value;
      setDisplay(value);
      return;
    }
    const controls = animate(displayRef.current, value, {
      duration: AV_MOTION.slow,
      ease: AV_EASE.standard,
      onUpdate: (next) => {
        displayRef.current = next;
        setDisplay(next);
      },
    });
    return () => controls.stop();
  }, [reduced, value]);

  return <span className="mono">{format(display)}</span>;
}
