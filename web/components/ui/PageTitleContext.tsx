"use client";

import { createContext, useContext, useEffect } from "react";

export const PageTitleContext = createContext<((title: string) => void) | null>(null);

/** Publish the page's existing heading to the shared app bar. */
export function useRegisterPageTitle(title: string) {
  const registerTitle = useContext(PageTitleContext);

  useEffect(() => {
    registerTitle?.(title);
  }, [registerTitle, title]);
}
