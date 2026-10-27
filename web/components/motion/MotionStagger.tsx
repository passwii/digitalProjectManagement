"use client";

import { m, useReducedMotion, type Variants } from "framer-motion";
import { AV_EASE, AV_MOTION, AV_STAGGER } from "@/lib/av/motion";

const parent: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: AV_STAGGER.list } },
};

const child: Variants = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: { duration: AV_MOTION.base, ease: AV_EASE.enter } },
};

export default function MotionStagger({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const reduced = useReducedMotion();
  return (
    <m.div
      className={className}
      variants={reduced ? undefined : parent}
      initial={reduced ? false : "hidden"}
      animate="show"
    >
      {Array.isArray(children)
        ? children.map((item, index) => <m.div key={index} variants={reduced ? undefined : child}>{item}</m.div>)
        : children}
    </m.div>
  );
}
