"use client";

import { m, useReducedMotion } from "framer-motion";

export default function MotionReveal({
  children,
  delay = 0,
  className,
}: {
  children: React.ReactNode;
  delay?: number;
  className?: string;
}) {
  const reduced = useReducedMotion();
  return (
    <m.div
      className={className}
      initial={reduced ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: reduced ? 0 : 0.22, delay: reduced ? 0 : delay, ease: [0.2, 0.72, 0.2, 1] }}
    >
      {children}
    </m.div>
  );
}
