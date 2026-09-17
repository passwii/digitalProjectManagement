"use client";

import { Suspense, useEffect, useRef } from "react";
import { LazyMotion, domAnimation } from "framer-motion";
import { usePathname, useSearchParams } from "next/navigation";
import { routeActivityKey } from "@/lib/activityCore";
import { ActivityProvider, useActivity } from "@/lib/useActivity";
import ActivityBar from "./ActivityBar";

function NavigationActivity({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const routeKey = routeActivityKey(pathname, searchParams.toString());
  const firstRouteKey = useRef(routeKey);
  const { beginActivity, active, label } = useActivity();

  useEffect(() => {
    if (routeKey === firstRouteKey.current) return;
    const finish = beginActivity({ label: "页面加载中", scope: "navigation" });
    finish();
  }, [beginActivity, routeKey]);

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
        <Suspense fallback={children}>
          <NavigationActivity>{children}</NavigationActivity>
        </Suspense>
      </LazyMotion>
    </ActivityProvider>
  );
}
