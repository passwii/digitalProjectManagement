"use client";
// 轻量 Toast：ToastProvider + useToast()。右上角堆叠，4s 自动消失。
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import st from "./Toast.module.css";

export type ToastKind = "ok" | "err" | "info";
interface Item {
  id: number;
  kind: ToastKind;
  text: string;
}

interface ToastApi {
  ok: (text: string) => void;
  err: (text: string) => void;
  info: (text: string) => void;
}

const Ctx = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<Item[]>([]);
  const seq = useRef(0);

  const push = useCallback((kind: ToastKind, text: string) => {
    const id = ++seq.current;
    setItems((prev) => [...prev, { id, kind, text }]);
    setTimeout(() => setItems((prev) => prev.filter((t) => t.id !== id)), 4000);
  }, []);

  const api = useMemo<ToastApi>(
    () => ({
      ok: (t) => push("ok", t),
      err: (t) => push("err", t),
      info: (t) => push("info", t),
    }),
    [push]
  );

  return (
    <Ctx.Provider value={api}>
      {children}
      <div className={st.stack} role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`${st.toast} ${st[t.kind]}`} onClick={() => setItems((p) => p.filter((x) => x.id !== t.id))}>
            <span className={st.icon} aria-hidden>
              {t.kind === "ok" ? "✓" : t.kind === "err" ? "!" : "i"}
            </span>
            <span className={st.text}>{t.text}</span>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

/** 无 Provider 时降级为 no-op，避免测试/孤立渲染报错 */
export function useToast(): ToastApi {
  const ctx = useContext(Ctx);
  const fallback = useRef<ToastApi>({
    ok: () => {},
    err: () => {},
    info: () => {},
  }).current;
  useEffect(() => {
    if (!ctx && typeof window !== "undefined") {
      // 仅开发期提示，不影响运行
    }
  }, [ctx]);
  return ctx ?? fallback;
}
