"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import s from "./AvGate.module.css";

/**
 * 可选门禁：`/av?gate=1`。
 *
 * 设计约束（Stage 2 §四）：
 *   · **不阻塞**直接访问 `/av/overview` —— 只有显式带 `gate=1` 才出现；
 *   · 6 格验证码自动跳格、退格回退，满 6 位才解锁按钮；
 *   · 这是一个演示仪式，不做真实校验：任意 6 位都能进入（文案里写明）。
 *
 * 为什么放在壳层：`/av` 会在 middleware 里 301 到 `/av/overview`，查询串被保留，
 * 所以门禁必须在页面渲染完之后盖在内容上，而不是一个独立路由。
 */
function GateOverlay() {
  const params = useSearchParams();
  const router = useRouter();
  const [unlocked, setUnlocked] = useState(false);
  const [digits, setDigits] = useState<string[]>(() => Array.from({ length: 6 }, () => ""));
  const inputs = useRef<(HTMLInputElement | null)[]>([]);
  const enabled = params.get("gate") === "1";

  const complete = useMemo(() => digits.every((digit) => digit.length === 1), [digits]);

  useEffect(() => {
    if (!enabled || unlocked) return;
    inputs.current[0]?.focus();
  }, [enabled, unlocked]);

  const unlock = useCallback(() => {
    setUnlocked(true);
    // 解锁后把 gate 参数去掉，刷新不会再拦一次
    router.replace("/av/overview");
  }, [router]);

  if (!enabled || unlocked) return null;

  const setDigit = (index: number, value: string) => {
    const clean = value.replace(/\D/g, "");
    if (!clean) {
      setDigits((previous) => previous.map((digit, position) => (position === index ? "" : digit)));
      return;
    }
    setDigits((previous) => {
      const next = [...previous];
      for (let offset = 0; offset < clean.length && index + offset < next.length; offset += 1) {
        next[index + offset] = clean[offset];
      }
      return next;
    });
    const focusAt = Math.min(5, index + clean.length);
    inputs.current[focusAt]?.focus();
  };

  const onKeyDown = (index: number, event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Backspace" && !digits[index] && index > 0) {
      event.preventDefault();
      setDigits((previous) => previous.map((digit, position) => (position === index - 1 ? "" : digit)));
      inputs.current[index - 1]?.focus();
    }
    if (event.key === "ArrowLeft" && index > 0) inputs.current[index - 1]?.focus();
    if (event.key === "ArrowRight" && index < 5) inputs.current[index + 1]?.focus();
  };

  return (
    <div className={s.overlay} role="dialog" aria-modal="true" aria-labelledby="av-gate-title">
      <div className={s.card}>
        <div className={s.brand}>
          <span className={s.mark} aria-hidden="true" />
          智能音视频平台 · 安全验证
        </div>
        <h2 id="av-gate-title">平台管理员二次验证</h2>
        <p className={s.copy}>输入 6 位动态口令进入运营工作台。演示环境不校验真实口令，任意 6 位均可解锁。</p>

        <div className={s.code} role="group" aria-label="6 位动态口令">
          {digits.map((digit, index) => (
            <input
              key={index}
              ref={(element) => {
                inputs.current[index] = element;
              }}
              className={s.cell}
              value={digit}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              aria-label={`第 ${index + 1} 位口令`}
              onChange={(event) => setDigit(index, event.target.value)}
              onKeyDown={(event) => onKeyDown(index, event)}
              onFocus={(event) => event.currentTarget.select()}
            />
          ))}
        </div>

        <div className={s.actions}>
          <button type="button" className={s.primary} disabled={!complete} onClick={unlock}>
            {complete ? "解锁并进入" : "请输入 6 位口令"}
          </button>
          <button type="button" className={s.ghost} onClick={unlock}>
            跳过验证，直接进入
          </button>
        </div>

        <div className={s.meta}>
          <span>MULTICA AV CONSOLE</span>
          <span>DEMO · 本地校验</span>
        </div>
      </div>
    </div>
  );
}

/**
 * `useSearchParams` 在静态渲染的路由里必须包在 Suspense 内，
 * 否则 `next build` 会直接报「missing suspense boundary」。
 */
export default function AvGate() {
  return (
    <Suspense fallback={null}>
      <GateOverlay />
    </Suspense>
  );
}
