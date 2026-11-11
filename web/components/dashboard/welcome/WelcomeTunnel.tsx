"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  m,
  useMotionValue,
  useMotionValueEvent,
  useReducedMotion,
  useTransform,
  type MotionValue,
} from "framer-motion";
import { AV_EASE, AV_MOTION } from "@/lib/av/motion";
import { useMe } from "@/lib/useMeta";
import { useIsMobile } from "@/lib/useIsMobile";
import {
  DESKTOP_TUNNEL,
  MOBILE_TUNNEL,
  STATIC_FRAME_PROGRESS,
  WELCOME_CARDS,
  cardLayout,
  cardLocalProgress,
  cardOpacityAt,
  endStateOpacity,
  heroFrame,
  isEndStateActive,
  progressFromDrag,
  progressFromKey,
  progressFromScroll,
  scrollCueOpacity,
  tunnelDepth,
  type WelcomeCard,
} from "@/lib/welcomeTunnel";
import s from "./WelcomeTunnel.module.css";

const CARD_ACCENTS = [
  s.accent1,
  s.accent2,
  s.accent3,
  s.accent4,
  s.accent5,
  s.accent6,
  s.accent7,
  s.accent8,
  s.accent9,
];

/** 轮次的 deltaMode：1 行、2 页，其他按像素。 */
function wheelDeltaPixels(event: WheelEvent): number {
  if (event.deltaMode === 1) return event.deltaY * 16;
  if (event.deltaMode === 2) return event.deltaY * window.innerHeight;
  return event.deltaY;
}

/** 键盘 Enter 落在按钮 / 链接上时交给浏览器原生行为，不重复触发。 */
function isInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof Element &&
    Boolean(target.closest("a, button, input, textarea, select, [contenteditable='true']"));
}

function TunnelCard({
  card,
  index,
  progress,
  mobile,
}: {
  card: WelcomeCard;
  index: number;
  progress: MotionValue<number>;
  mobile: boolean;
}) {
  const geometry = cardLayout(index);
  const opacity = useTransform(progress, (value) => cardOpacityAt(value, index));
  const transform = useTransform(progress, (value) => {
    const local = cardLocalProgress(value, index);
    const depth = tunnelDepth(local, mobile);
    return `translate3d(calc(-50% + ${geometry.baseXvw.toFixed(2)}vw), calc(-50% + ${geometry.baseYvh.toFixed(2)}vh), ${depth.toFixed(1)}px) rotateZ(${geometry.rotation}deg)`;
  });

  return (
    <m.article
      className={`${s.card} ${CARD_ACCENTS[index]}`}
      data-welcome-card={index}
      style={{ opacity, transform, zIndex: index + 1 }}
    >
      <span className={s.cardGrid} aria-hidden="true" />
      <span className={s.cardMeta}>
        <span>{card.order}</span>
        <span>{card.tag}</span>
      </span>
      <div className={s.cardCopy}>
        <h2>{card.title}</h2>
        <p>{card.description}</p>
      </div>
    </m.article>
  );
}

/**
 * Dashboard 欢迎页：滚轮 / 触控拖动驱动的 3D 透视隧道。
 *
 * 视觉基准是 docs/prototypes/dashboard-welcome/index.html；页面只负责欢迎这一屏，
 * 导航与账号区由 (dashboard)/layout.tsx 浮在上层，这里不预留顶栏高度。
 */
export default function WelcomeTunnel() {
  const { displayName } = useMe();
  const reduced = Boolean(useReducedMotion());
  const mobile = useIsMobile();

  /**
   * 首帧一律从 0 开始：服务端渲染时读不到 prefers-reduced-motion，若首帧就写 0.42
   * 会在水合时与 SSR 的样式对不上。静态中间帧改在 effect 里瞬时落位（没有动画）。
   */
  const progress = useMotionValue(0);
  const pointerX = useMotionValue(0);
  const pointerY = useMotionValue(0);
  const [endActive, setEndActive] = useState(false);

  const stageRef = useRef<HTMLElement | null>(null);
  const targetRef = useRef(0);
  const smoothRef = useRef(0);
  const pointerTargetRef = useRef({ x: 0, y: 0 });
  const pointerRef = useRef({ x: 0, y: 0 });

  const heroScale = useTransform(progress, (value) => heroFrame(value).scale);
  const heroOpacity = useTransform(progress, (value) => heroFrame(value).opacity);
  const cueOpacity = useTransform(progress, scrollCueOpacity);
  const veilOpacity = useTransform(progress, endStateOpacity);
  const spaceX = useTransform(pointerX, (value) => -value * (mobile ? MOBILE_TUNNEL.parallax : DESKTOP_TUNNEL.parallax));
  const spaceY = useTransform(pointerY, (value) => -value * (mobile ? MOBILE_TUNNEL.parallax : DESKTOP_TUNNEL.parallax));

  useMotionValueEvent(progress, "change", (value) => {
    setEndActive(isEndStateActive(value));
  });

  const reset = useCallback(() => {
    targetRef.current = 0;
    smoothRef.current = 0;
    pointerTargetRef.current = { x: 0, y: 0 };
    pointerRef.current = { x: 0, y: 0 };
    pointerX.set(0);
    pointerY.set(0);
    progress.set(0);
  }, [pointerX, pointerY, progress]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;

    let frame = 0;
    let disposed = false;
    let dragY: number | null = null;

    // prefers-reduced-motion：直接落到静态中间帧，隧道不播放过渡；
    // 滚轮 / 键盘仍可瞬时换帧，否则终点里的「进入项目台账」永远不可达。
    if (reduced) {
      targetRef.current = STATIC_FRAME_PROGRESS;
      smoothRef.current = STATIC_FRAME_PROGRESS;
      pointerRef.current = { x: 0, y: 0 };
      pointerTargetRef.current = { x: 0, y: 0 };
      progress.set(STATIC_FRAME_PROGRESS);
    }

    const tick = () => {
      frame = 0;
      if (disposed) return;
      const target = targetRef.current;
      const smooth = reduced ? target : smoothRef.current + (target - smoothRef.current) * 0.12;
      smoothRef.current = smooth;
      progress.set(smooth);

      const pointerTarget = pointerTargetRef.current;
      const px = reduced ? pointerTarget.x : pointerRef.current.x + (pointerTarget.x - pointerRef.current.x) * 0.08;
      const py = reduced ? pointerTarget.y : pointerRef.current.y + (pointerTarget.y - pointerRef.current.y) * 0.08;
      pointerRef.current = { x: px, y: py };
      pointerX.set(px);
      pointerY.set(py);

      const moving = Math.abs(target - smooth) > 0.0006 ||
        Math.abs(pointerTarget.x - px) > 0.001 ||
        Math.abs(pointerTarget.y - py) > 0.001;
      if (moving) frame = window.requestAnimationFrame(tick);
    };

    const wake = () => {
      if (disposed || frame) return;
      frame = window.requestAnimationFrame(tick);
    };

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      targetRef.current = progressFromScroll(targetRef.current, wheelDeltaPixels(event));
      wake();
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType === "mouse") return;
      if (isInteractiveTarget(event.target)) return;
      dragY = event.clientY;
    };

    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerType === "mouse") {
        pointerTargetRef.current = {
          x: (event.clientX / window.innerWidth - 0.5) * 2,
          y: (event.clientY / window.innerHeight - 0.5) * 2,
        };
        wake();
        return;
      }
      if (dragY === null) return;
      if (isInteractiveTarget(event.target)) return;
      const delta = dragY - event.clientY;
      if (delta === 0) return;
      dragY = event.clientY;
      targetRef.current = progressFromDrag(targetRef.current, delta);
      wake();
    };

    const stopDrag = () => {
      dragY = null;
    };

    const onPointerLeave = (event: PointerEvent) => {
      stopDrag();
      if (event.pointerType !== "mouse") return;
      pointerTargetRef.current = { x: 0, y: 0 };
      wake();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      // 只接管落在隧道画面（或页面空白处）的按键：导航、账号菜单等浮层的键盘行为
      // 由 layout 负责，不能被这里的 Esc / Home 抢走。
      const target = event.target;
      const insideStage = target instanceof Node && stage.contains(target);
      if (!insideStage && target !== document.body) return;

      // Home / Esc 一律回到开头：终点或中途都可以撤回。
      if (event.key === "Escape" || event.key === "Home") {
        event.preventDefault();
        reset();
        return;
      }
      const next = progressFromKey(targetRef.current, event.key);
      if (next !== null) {
        if (isInteractiveTarget(event.target)) return;
        event.preventDefault();
        targetRef.current = next;
        wake();
        return;
      }

      if (event.key !== "Enter") return;
      if (!isEndStateActive(targetRef.current)) return;
      if (isInteractiveTarget(event.target)) return;
      event.preventDefault();
      // 终点主按钮是 Next Link：直接点它，保留 Link 的预取与客户端导航行为。
      stage.querySelector<HTMLAnchorElement>("[data-end-primary]")?.click();
    };

    stage.addEventListener("wheel", onWheel, { passive: false });
    stage.addEventListener("pointerdown", onPointerDown);
    stage.addEventListener("pointermove", onPointerMove);
    stage.addEventListener("pointerup", stopDrag);
    stage.addEventListener("pointercancel", stopDrag);
    stage.addEventListener("pointerleave", onPointerLeave);
    window.addEventListener("keydown", onKeyDown);

    return () => {
      disposed = true;
      if (frame) window.cancelAnimationFrame(frame);
      stage.removeEventListener("wheel", onWheel);
      stage.removeEventListener("pointerdown", onPointerDown);
      stage.removeEventListener("pointermove", onPointerMove);
      stage.removeEventListener("pointerup", stopDrag);
      stage.removeEventListener("pointercancel", stopDrag);
      stage.removeEventListener("pointerleave", onPointerLeave);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [progress, pointerX, pointerY, reduced, reset]);

  return (
    <section
      ref={stageRef}
      className={s.stage}
      aria-labelledby="welcome-hello"
      data-welcome-tunnel="true"
    >
      <span className={s.gridLayer} aria-hidden="true" />
      <span className={s.glow} aria-hidden="true" />
      <span className={s.rings} aria-hidden="true">
        <i /><i />
      </span>

      <h1 className={s.srOnly} id="welcome-hello">
        {displayName ? `你好，${displayName}` : "你好"}
      </h1>

      <div className={s.hero} aria-hidden="true">
        {/* 缩放 / 淡出走内层：外层用 CSS translate 居中，避免两种 transform 互相覆盖 */}
        <m.div className={s.heroInner} style={{ scale: heroScale, opacity: heroOpacity }}>
          <span className={s.hello}>你好</span>
          {displayName ? <span className={s.name}>{displayName}</span> : null}
        </m.div>
      </div>

      <m.div className={s.space} style={{ x: spaceX, y: spaceY }} aria-hidden="true">
        {WELCOME_CARDS.map((card, index) => (
          <TunnelCard key={card.id} card={card} index={index} progress={progress} mobile={mobile} />
        ))}
      </m.div>

      <ul className={s.srOnly} aria-label="能力概览">
        {WELCOME_CARDS.map((card) => (
          <li key={card.id}>
            <strong>{card.title}</strong>
            <span>{card.description}</span>
          </li>
        ))}
      </ul>

      <m.div className={s.cue} style={{ opacity: cueOpacity }} aria-hidden="true">
        <i />
      </m.div>

      <m.div className={s.endVeil} style={{ opacity: veilOpacity }} aria-hidden="true" />

      {endActive && (
        <div className={s.endState} data-end-state="true">
          <m.div
            className={s.endInner}
            initial={reduced ? false : { opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: reduced ? 0 : AV_MOTION.base, ease: AV_EASE.enter }}
          >
            <h2 className={s.endTitle}>从这里开始。</h2>
            <p className={s.endNote}>项目、进度、支出与审批，在同一个工作空间。</p>
            <div className={s.endActions}>
              <Link href="/projects" className={s.endPrimary} data-end-primary="true">
                进入项目台账
                <span className={s.endArrow} aria-hidden="true">→</span>
              </Link>
              <button type="button" className={s.endGhost} onClick={reset}>
                重新浏览
              </button>
            </div>
          </m.div>
        </div>
      )}

    </section>
  );
}
