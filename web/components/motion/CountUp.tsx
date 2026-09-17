"use client";

import { animate, useReducedMotion } from "framer-motion";
import { useEffect, useRef, useState } from "react";

export default function CountUp({
  value,
  format = (next) => String(Math.round(next)),
}: {
  value: number;
  format?: (value: number) => string;
}) {
  const reduced = useReducedMotion();
  const previous = useRef(0);
  const [display, setDisplay] = useState(reduced ? value : 0);

  useEffect(() => {
    if (reduced) {
      previous.current = value;
      setDisplay(value);
      return;
    }
    const controls = animate(previous.current, value, {
      duration: 0.42,
      ease: "easeOut",
      onUpdate: setDisplay,
    });
    previous.current = value;
    return () => controls.stop();
  }, [reduced, value]);

  return <span className="mono">{format(display)}</span>;
}
