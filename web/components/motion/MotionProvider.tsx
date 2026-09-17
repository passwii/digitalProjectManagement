"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef } from "react";
import { LazyMotion, domAnimation } from "framer-motion";
import { usePathname } from "next/navigation";
import { ActivityProvider, useActivity } from "@/lib/useActivity";

export interface NavigationActivityContextValue {
  startNavigation: (label?: string, href?: string) => () => void;
}

export const NavigationActivityContext = createContext<NavigationActivityContextValue | undefined>(undefined);

export function useNavigationActivity(): NavigationActivityContextValue {
  const context = useContext(NavigationActivityContext);
  if (!context) {
    throw new Error("useNavigationActivity must be used within MotionProvider");
  }
  return context;
}

function NavigationActivity({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const lastPathnameRef = useRef<string | null>(null);
  const pendingNavigationRef = useRef(new Map<() => void, string>());
  const { beginActivity } = useActivity();

  const startNavigation = useCallback((label = "页面加载中", href?: string) => {
    const target = href
      ? new URL(href, window.location.origin).pathname
      : pathname;
    const finishActivity = beginActivity({ label, scope: "navigation" });
    let finished = false;
    let timer = 0;
    let finish: () => void = () => {};

    finish = () => {
      if (finished) return;
      finished = true;
      window.clearTimeout(timer);
      pendingNavigationRef.current.delete(finish);
      finishActivity();
    };
    timer = window.setTimeout(finish, 10_000);
    pendingNavigationRef.current.set(finish, target);
    return finish;
  }, [beginActivity, pathname]);

  useEffect(() => {
    const previousPathname = lastPathnameRef.current;
    lastPathnameRef.current = pathname;
    if (previousPathname === null || previousPathname === pathname) {
      return;
    }
    const pending = pendingNavigationRef.current;
    let matched = false;
    pending.forEach((target, finish) => {
      if (target === pathname) {
        matched = true;
        finish();
      }
    });
    if (!matched) {
      const finish = startNavigation();
      finish();
    }
  }, [pathname, startNavigation]);

  useEffect(
    () => () => {
      pendingNavigationRef.current.forEach((_, finish) => finish());
      pendingNavigationRef.current.clear();
    },
    [],
  );

  const value = useMemo<NavigationActivityContextValue>(
    () => ({ startNavigation }),
    [startNavigation],
  );

  return (
    <NavigationActivityContext.Provider value={value}>
      {children}
    </NavigationActivityContext.Provider>
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
