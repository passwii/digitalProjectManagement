"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef } from "react";
import { LazyMotion, domAnimation } from "framer-motion";
import { usePathname } from "next/navigation";
import { ActivityProvider, useActivity } from "@/lib/useActivity";

interface NavigationActivityContextValue {
  startNavigation: (label?: string) => () => void;
}

export const NavigationActivityContext = createContext<NavigationActivityContextValue | null>(null);

const fallback: NavigationActivityContextValue = {
  startNavigation: () => () => {},
};

export function useNavigationActivity(): NavigationActivityContextValue {
  return useContext(NavigationActivityContext) ?? fallback;
}

function NavigationActivity({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const lastPathnameRef = useRef<string | null>(null);
  const pendingNavigationRef = useRef(new Set<() => void>());
  const { beginActivity } = useActivity();

  const startNavigation = useCallback((label = "页面加载中") => {
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
    pendingNavigationRef.current.add(finish);
    return finish;
  }, [beginActivity]);

  useEffect(() => {
    if (lastPathnameRef.current === null) {
      lastPathnameRef.current = pathname;
      return;
    }
    if (lastPathnameRef.current === pathname) return;

    const pending = pendingNavigationRef.current;
    if (pending.size > 0) {
      pending.forEach((finish) => finish());
    } else {
      const finish = startNavigation();
      finish();
    }
    lastPathnameRef.current = pathname;
  }, [pathname, startNavigation]);

  useEffect(
    () => () => {
      pendingNavigationRef.current.forEach((finish) => finish());
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
