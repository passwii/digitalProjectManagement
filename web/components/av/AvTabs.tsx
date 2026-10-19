"use client";

import { useId } from "react";
import { useAvMotion } from "./motion/AvMotionProvider";
import { AvTabSlider } from "./motion/AvCounter";
import s from "./AvUI.module.css";

/**
 * 分段控件（Tab）——唯一需要客户端能力的视觉件，因此单独成文件。
 *
 * 高亮滑块用 `layoutId` 共享布局动画（base + standard）：切换时块**滑过去**，
 * 而不是旧的灭、新的亮。id 按组件实例生成 —— 同页有 3 组筛选（级别 / 场景 /
 * 状态），共用一个 layoutId 会让滑块在几组之间穿越整页飞过去。
 *
 * 为什么从 AvUI.tsx 拆出来：AvUI 要保持在服务端可渲染（无 hook、无函数型 props），
 * 否则 capability / __stress 这些服务端页面会把整层 UI 拖进客户端 bundle。
 *
 * 降级（`?static=1` / 减少动效）时不渲染滑块，`.tabActive` 自己带底色与边框，
 * 与 Stage 2 的静态外观逐像素一致。
 */
export default function AvTabs<T extends string>({
  items,
  value,
  onChange,
  ariaLabel,
}: {
  items: readonly { value: T; label: string; count?: number }[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
}) {
  const groupId = useId();
  const { enabled } = useAvMotion();
  return (
    <div className={s.tabs} role="group" aria-label={ariaLabel}>
      {items.map((item) => {
        const active = item.value === value;
        return (
          <button
            key={item.value}
            type="button"
            className={`${s.tab} ${active ? s.tabActive : ""} ${active && enabled ? s.tabActiveHost : ""}`}
            aria-pressed={active}
            onClick={() => onChange(item.value)}
          >
            {active && <AvTabSlider groupId={groupId} label={item.label} />}
            <span className={s.tabLabel}>
              {item.label}
              {item.count != null && <span className={s.tabCount}>{item.count}</span>}
            </span>
          </button>
        );
      })}
    </div>
  );
}
