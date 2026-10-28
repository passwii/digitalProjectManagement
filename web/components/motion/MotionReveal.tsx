"use client";

import { m, useReducedMotion } from "framer-motion";
import { AV_EASE, AV_MOTION } from "@/lib/av/motion";

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
      transition={{ duration: reduced ? 0 : AV_MOTION.base, delay: reduced ? 0 : delay, ease: AV_EASE.enter }}
    >
      {children}
    </m.div>
  );
}
