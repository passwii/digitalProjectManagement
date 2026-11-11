"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { ShellNavItem } from "@/lib/globalNav";

/**
 * 手机外壳共享状态：同一份权限投影（`navItems`）与「打开更多 sheet」动作。
 *
 * 为什么需要 context：移动首页（`components/dashboard/MobileHome`）既不是
 * 导航组件也不该自己再取一遍菜单；布局已经算好 `navItems`，这里把它交给
 * 首页消费，保证「桌面药丸 / 手机 dock / 首页入口卡」永远读同一份权限投影。
 */
interface MobileShellContextValue {
  navItems: ShellNavItem[];
  openMore: () => void;
}

const NOOP = () => {};

const MobileShellContext = createContext<MobileShellContextValue>({
  navItems: [],
  openMore: NOOP,
});

export function MobileShellProvider({
  navItems,
  openMore,
  children,
}: MobileShellContextValue & { children: ReactNode }) {
  return (
    <MobileShellContext.Provider value={{ navItems, openMore }}>
      {children}
    </MobileShellContext.Provider>
  );
}

export function useMobileShell(): MobileShellContextValue {
  return useContext(MobileShellContext);
}
