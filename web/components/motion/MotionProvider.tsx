"use client";

import { useEffect, useRef } from "react";
import { LazyMotion, domAnimation } from "framer-motion";
import { usePathname } from "next/navigation";
import { ActivityProvider, useActivity } from "@/lib/useActivity";
import ActivityBar from "./ActivityBar";

function NavigationActivity({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const firstPath = useRef(pathname);
  const finishRef = useRef<(() => void) | null>(null);
  const { beginActivity, active, label } = useActivity();

  useEffect(() => {
    function onClick(event: MouseEvent) {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as Element | null)?.closest("a");
      if (!anchor) return;
      if (anchor.target === "_blank" || anchor.hasAttribute("download")) return;
      const href = anchor.getAttribute("href");
      if (!href || !href.startsWith("/") || href.startsWith("//")) return;
      const next = new URL(href, window.location.origin);
      if (next.pathname === window.location.pathname && next.search === window.location.search) return;
      finishRef.current?.();
      finishRef.current = beginActivity({ label: "页面加载中", scope: "navigation" });
    }

    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [beginActivity]);

  useEffect(() => {
    if (pathname === firstPath.current && finishRef.current === null) return;
    if (finishRef.current) {
      finishRef.current();
      finishRef.current = null;
      return;
    }
    const finish = beginActivity({ label: "页面加载中", scope: "navigation" });
    finish();
  }, [beginActivity, pathname]);

  return (
    <>
      <ActivityBar active={active} label={label} />
      {children}
    </>
  );
}

export default function MotionProvider({ children }: { children: React.ReactNode }) {
  return (
    <ActivityProvider>
      <LazyMotion features={domAnimation} strict>
        <NavigationActivity>{children}</NavigationActivity>
      </LazyMotion>
    </ActivityProvider>
  );
}
