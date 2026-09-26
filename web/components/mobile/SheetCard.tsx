"use client";

// Dock 入口面板里的整宽导航卡。点按直接进入模块或详情。
//
// 卡片是**导航落点**（点卡片进入模块或详情），所以用 `<Link>` 而不是 button：
// 中键 / 长按「新标签页打开」照常可用，也不需要自己重写键盘行为。

import Link from "next/link";
import s from "./SheetCard.module.css";

export interface SheetCardProps {
    /** 落点：模块或详情页 */
    href: string;
    /** 可选浏览上下文名称；相同名称的入口会复用同一个标签页 */
    target?: React.HTMLAttributeAnchorTarget;
    /** 主文案（模块名 / 记录标题） */
    title: string;
    /** 第二行说明（列表卡的元信息：编号 / 负责人 / 口径） */
    note?: string;
    /**
     * 指标值（如待办数、本月支出）；没有指标的入口留空。
     */
    value?: string;
    /** 指标语义色（超期 / 超预算一类需要立刻看见的口径） */
    tone?: "default" | "brand" | "warn" | "danger";
    /** 卡片图标；缺省时不占位 */
    icon?: React.ReactNode;
    /**
     * 点击回调（导航**之前**调用）。
     * 抽屉是导航的第二入口：进了模块就不该留在屏上，所以这里用来收起抽屉。
     */
    onSelect?: () => void;
}

export default function SheetCard({
    href,
    target,
    title,
    note,
    value,
    tone = "default",
    icon,
    onSelect,
}: SheetCardProps) {
    return (
        <Link
            href={href}
            target={target}
            className={s.card}
            data-sheet-card="list"
            data-tone={tone}
            onClick={onSelect}
        >
            {icon && (
                <span className={s.icon} aria-hidden="true">
                    {icon}
                </span>
            )}
            <span className={s.text}>
                <span className={s.title}>{title}</span>
                {note && <span className={s.note}>{note}</span>}
            </span>
            {value && <span className={s.value}>{value}</span>}
            <svg
                className={s.chev}
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.4"
                strokeLinecap="round"
                aria-hidden="true"
            >
                <path d="M9 5l7 7-7 7" />
            </svg>
        </Link>
    );
}
