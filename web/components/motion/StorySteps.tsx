"use client";
/**
 * 登录页「统一台账 / 进度留痕 / 支出归集」三段式进度动效。
 *
 * 设计意图：三条横线不是装饰，而是**顺序进度条**——按 01 → 02 → 03 逐条推进，
 * 每条线填满后它对应的编号与文案才浮现，把「先立台账、再留进度、后归集支出」
 * 的业务顺序可视化。因此：
 *   · 线用 `scaleX` 从左侧推满（不是 opacity 渐显），方向与阅读方向一致；
 *   · 文本的入场比线**晚**一点点（`LABEL_DELAY`），线到、字现，才有「推进到这一步」的感觉；
 *   · 三条线串行（`STEP_STAGGER` ≈ 单条线的时长），节奏由下面两级 `staggerChildren` 编排，
 *     组件内部不写死 delay，以后增删步骤只改数据，节奏自动重排。
 *
 * 两级编排（都靠 variant 传递，不手写 delay）：
 *   `.steps`（m.div）      —— 一步步来，每条线依次启动；
 *   `.step`（m.div）       —— 本条线先推，编号与文案紧随其后。
 * 因此每个步骤必须自己是一个 motion 组件：若用普通 `<div>` 包，
 * 内外两层 motion 会成为同一个编排组的兄弟节点，线/字交错推进，不是设计要的顺序。
 *
 * 无障碍：进度条本身纯装饰（对应信息在 DOM 里有真实文本），
 * 因此动效层 `aria-hidden`，步骤文本保持可读；`prefers-reduced-motion` 下
 * 直接落在终态，不做任何演进。
 */
import { motion as m, useReducedMotion, type Variants } from "framer-motion";
import st from "./StorySteps.module.css";

/** 单个步骤（编号 + 文案），由调用方提供，组件不写死业务词。 */
export interface StoryStep {
  /** 序号文案，如 `01`。 */
  no: string;
  /** 步骤名，如 `统一台账`。 */
  label: string;
}

/** 一条线推进的时长；缓动与全站 `--ease-console` 同款。 */
const LINE_DURATION = 0.48;
/** 线走完到文字出现之间的间隔：先有线，再有字。 */
const LABEL_DELAY = 0.16;
/** 相邻两条线的启动间隔，略短于单条线时长，衔接顺滑但不抢拍。 */
const STEP_STAGGER = 0.46;

const stepsVariants: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: STEP_STAGGER, delayChildren: 0.12 } },
};

/** 单个步骤内部：线先行，文字随后（`staggerChildren` = 线到字的间隔）。 */
const stepVariants: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: LABEL_DELAY } },
};

const lineVariants: Variants = {
  hidden: { scaleX: 0 },
  show: { scaleX: 1, transition: { duration: LINE_DURATION, ease: [0.2, 0.72, 0.2, 1] } },
};

const metaVariants: Variants = {
  hidden: { opacity: 0, y: 6 },
  show: { opacity: 1, y: 0, transition: { duration: 0.34, ease: [0.2, 0.72, 0.2, 1] } },
};

export default function StorySteps({ steps }: { steps: readonly StoryStep[] }) {
  const reduced = useReducedMotion();
  return (
    <m.div
      className={st.steps}
      variants={reduced ? undefined : stepsVariants}
      initial={reduced ? false : "hidden"}
      animate="show"
    >
      {steps.map((step) => (
        <m.div
          className={st.step}
          key={step.no}
          variants={reduced ? undefined : stepVariants}
        >
          {/* 装饰层：线本身没有语义，进度信息由下面的文本承担 */}
          <span className={st.track} aria-hidden="true">
            <m.span className={st.fill} variants={reduced ? undefined : lineVariants} />
          </span>
          <m.span className={st.meta} variants={reduced ? undefined : metaVariants}>
            <b className={st.no}>{step.no}</b>
            <span className={st.label}>{step.label}</span>
          </m.span>
        </m.div>
      ))}
    </m.div>
  );
}
