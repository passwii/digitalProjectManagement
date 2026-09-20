"use client";

/**
 * 手机端卡片流（BLF-1127 §4.2 / 决策 D4）。
 *
 * 项目台账与审批中心的表格在手机端改为卡片流：一屏 2–3 条可读结论
 * （名称 / 编号 / 状态 / 进度条 / 负责人 / 预算或执行率）。两页共用同一套
 * 容器 + 卡片，不各复制一份。
 *
 * 视图切换是**纯 CSS**（与 `(dashboard)/layout.tsx` 双外壳同一手法）：
 * 同一份数据同时渲染表格与卡片流，767px 断点决定谁在场 —— SSR 首帧不依赖
 * JS 断点，不会出现「先闪错误视图」。桌面（≥768px）仍是唯一的 `table.grid`，
 * 列顺序、排序、筛选、分页、行内操作与 PRINT 样式都不动。
 *
 * 触控目标在卡片自己的 CSS 里做到 ≥ `--m-tap`(44px)，**不依赖**
 * `globals.css` 里 640px / `pointer: coarse` 那两处给 `table.grid` 行内按钮
 * 补高度的补丁（卡片按钮不在 `table.grid` 作用域里，补丁本来也够不着）。
 */

import { useEffect, type ReactNode } from "react";
import s from "./CardList.module.css";
import { DesktopTableFrame } from "./ListPageLayout";

/** 卡片内一行「标签—值」结论（如 负责人 / 预算 / 进度）。值可以是任意节点（含进度条）。 */
export interface CardField {
 label: string;
 value: ReactNode;
 /** 等宽数字（金额 / 日期一类，与桌面表格 `.num` 同口径） */
 mono?: boolean;
}

export function CardList({
 label,
 children,
}: {
 label: string;
 children: ReactNode;
}) {
 return (
  <div className={s.cards} data-cardlist={label} role="list">
   {children}
  </div>
 );
}

export interface CardItemProps {
 /** 主结论（名称 / 项目名），表格里对应加粗的那一列 */
 title: ReactNode;
 /** 编号一类 mono 小字（表格 `.mono.tiny` 列的卡片形态） */
 code?: ReactNode;
 /** 状态徽标组（表格 Badge 列的卡片形态） */
 badges?: ReactNode;
 /** 其余关键字段 —— 不得因卡片化丢字段（D4 验收项） */
 fields?: CardField[];
 /** 操作入口 —— 不得因卡片化丢操作（D4 验收项），触控 ≥44px 由 CSS 保证 */
 actions?: ReactNode;
 /** 整卡点击（表格 `clickable-row` 的卡片形态，如点项目进详情抽屉） */
 onSelect?: () => void;
 /** 通知深链定位 id：与表格行相同的 `data-target-id`，见 `useVisibleTargetScroll` */
 targetId?: number;
 /** 是否命中定位目标（表格 `row-target` 的卡片形态） */
 hit?: boolean;
}

export function CardItem({
 title,
 code,
 badges,
 fields,
 actions,
 onSelect,
 targetId,
 hit,
}: CardItemProps) {
 return (
  <article
   className={`${s.card}${hit ? ` ${s.hit}` : ""}${onSelect ? ` ${s.clickable}` : ""}`}
   data-card=""
   data-target-id={targetId}
   data-hit={hit ? "true" : undefined}
   role="listitem"
   onClick={onSelect}
  >
   <div className={s.head}>
    <span className={s.title}>{title}</span>
    {badges && <span className={s.badges}>{badges}</span>}
   </div>
   {code != null && code !== "" && (
    <div className={`${s.code} mono tiny`}>{code}</div>
   )}
   {fields && fields.length > 0 && (
    <dl className={s.fields}>
     {fields.map((f) => (
      <div key={f.label} className={s.frow}>
       <dt>{f.label}</dt>
       <dd className={f.mono ? "mono" : undefined}>{f.value}</dd>
      </div>
     ))}
    </dl>
   )}
   {actions && (
    // 操作区统一截断冒泡：整卡 onSelect（进详情）不能被操作按钮误触发。
    // 表格里是每个按钮各自 stopPropagation，这里收敛到一处，效果一致。
    <div
     className={`${s.actions} no-print`}
     onClick={(e) => e.stopPropagation()}
    >
     {actions}
    </div>
   )}
  </article>
 );
}

/**
 * 桌面表格的手机端退场壳：包住 `table.grid` 的那层 `.table-scroll`。
 * 本身无样式（桌面渲染与原来逐像素一致），只在 ≤767px `display: none`，
 * 把舞台让给同一份数据的卡片流。打印时同样退场（PRINT 沿用桌面表格样式，
 * 卡片流不进打印，见模块 CSS 的 `@media print`）。
 */
export function DesktopTable({ children }: { children: ReactNode }) {
 return <DesktopTableFrame className={s.desktopOnly}>{children}</DesktopTableFrame>;
}

/**
 * 可见视图感知的定位滚动。
 *
 * 同一份数据在表格与卡片流里各有一份 `[data-target-id]`（深链定位用），
 * `querySelector` 只会命中 DOM 顺序的第一份 —— 另一视图隐藏的那份。
 * 对隐藏元素 `scrollIntoView` 是空操作，所以这里挑**当前可见**的那份滚动，
 * 桌面与手机各得其所。`lib/deepLink.ts` 的 `useTargetScroll` 保持原样
 * （桌面行为零回归），调用方在它之后再调这个即可。
 */
export function useVisibleTargetScroll(target: number, ready: boolean) {
 useEffect(() => {
  if (!target || !ready) return;
  const cands = Array.from(
   document.querySelectorAll<HTMLElement>(`[data-target-id="${target}"]`),
  );
  const el = cands.find((e) => e.getClientRects().length > 0) ?? cands[0];
  if (!el) return;
  el.scrollIntoView({ block: "center", behavior: "smooth" });
  // 行本身不可聚焦，交给其中的操作按钮（与 useTargetScroll 同口径）
  el
   .querySelector<HTMLElement>("button, a, input, select")
   ?.focus({ preventScroll: true });
 }, [target, ready]);
}
