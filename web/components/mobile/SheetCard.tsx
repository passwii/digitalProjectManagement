"use client";

// 抽屉里的一张卡（BLF-1127 §4 / §4.1 + 决策 D2）。
//
// 「预览卡」与「列表卡」是**同一张卡的两个形态**，不是两个组件（S3 交付物表就写作
// 「单选组件（S4 复用同一份）」）：
//   · `preview` —— peek 档的主角：2 列平铺，一眼看清「有什么、要不要进去」；
//   · `list`    —— half / full 档的行：整宽、一行一条，密度换可比较性。
// 同一份数据在 peek / half 之间切换形态，是因为 §4 的「抽屉里放卡片」本来就是
// 「抽屉管纵向层级、卡片管横向信息密度」这一对约束的搭配，而不是两套内容。
//
// 卡片是**导航落点**（点卡片进入模块或详情），所以用 `<Link>` 而不是 button：
// 中键 / 长按「新标签页打开」照常可用，也不需要自己重写键盘行为。

import Link from "next/link";
import s from "./SheetCard.module.css";

export type SheetCardVariant = "preview" | "list";

export interface SheetCardProps {
    /** 形态：`preview`（peek 平铺）/ `list`（half / full 行）。默认 `preview` */
    variant?: SheetCardVariant;
    /** 落点：模块或详情页 */
    href: string;
    /** 可选浏览上下文名称；相同名称的入口会复用同一个标签页 */
    target?: React.HTMLAttributeAnchorTarget;
    /** 主文案（模块名 / 记录标题） */
    title: string;
    /** 第二行说明（列表卡的元信息：编号 / 负责人 / 口径） */
    note?: string;
    /**
     * 预览卡的指标值（如「待办 12」「逾期 3」「本月支出 ¥38.6万」）。
     * S3 只渲染模块卡，用不到它；S4 填各 Dock 位的预览卡时直接传值，
     * 不用为此再造一个「指标卡」组件。
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
    variant = "preview",
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
            data-sheet-card={variant}
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
