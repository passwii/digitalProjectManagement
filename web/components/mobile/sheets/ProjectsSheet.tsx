"use client";

// 项目抽屉（BLF-1127 / S4，§3 第二行）：状态筛选 chips + 最近项目卡。
//
// 筛选直接走 `/projects` 列表接口的查询参数（`status` / `owner_id`，与
// `projects/page.tsx` 同一套），抽屉与台账页不共享 URL —— 抽屉里的筛选是
// 局部 state，切走即丢，不污染台账页的 URL 状态。
// 「我负责」用 `useMe().me.id` 做 `owner_id`，与台账页「负责人」筛选同口径。

import { useState } from "react";
import { buildQuery, projectsApi, unwrapPaged, type Project } from "@/lib/api";
import { projectStatusLabel } from "@/lib/labels";
import { useAsyncData } from "@/lib/useAsyncData";
import { useMe, useMeta } from "@/lib/useMeta";
import Empty from "@/components/ui/Empty";
import { LoadFailed, LoadingBlock } from "@/components/ui/PageState";
import SheetCard from "../SheetCard";
import type { SheetContentProps } from "./index";
import s from "./sheets.module.css";

const CHIPS = [
    { code: "", label: "全部" },
    { code: "doing", label: "进行中" },
    { code: "filed", label: "已立项" },
    { code: "paused", label: "暂停" },
    { code: "__mine", label: "我负责" },
] as const;

/** 状态 → 指标语义色：只有需要立刻看见的（暂停）在抽屉里着色 */
function toneFor(status: string): "default" | "brand" | "warn" | "danger" {
    if (status === "paused") return "warn";
    if (status === "doing" || status === "filed") return "brand";
    return "default";
}

export default function ProjectsSheet({
    onSelect,
}: SheetContentProps) {
    const { me } = useMe();
    const { userName } = useMeta();
    const [chip, setChip] = useState("");

    const mineOnly = chip === "__mine";
    const status = mineOnly ? "" : chip;
    const ownerId = mineOnly ? me?.id : undefined;
    // 「我负责」必须等身份确认：不等就按「全部」查，会闪一次别人的项目
    const enabled = !mineOnly || me?.id != null;

    const { data, loading, firstLoad, error, reload } = useAsyncData(
        (signal) =>
            projectsApi.list(
                buildQuery({ page: 1, size: 6, status, owner_id: ownerId }),
                signal,
            ),
        [status, ownerId, enabled],
        { enabled },
    );
    const paged = data ? unwrapPaged<Project>(data) : null;

    return (
        <>
            <div className={s.chips} role="group" aria-label="按状态筛选项目">
                {CHIPS.map((c) => (
                    <button
                        key={c.code}
                        type="button"
                        className={s.chip}
                        aria-pressed={chip === c.code}
                        onClick={() => setChip(c.code)}
                    >
                        {c.label}
                    </button>
                ))}
            </div>
            {paged == null ? (
                <div className={s.full}>
                    {error ? (
                        <LoadFailed message={error} onRetry={reload} />
                    ) : (
                        <LoadingBlock
                            title={false}
                            kpis={0}
                            label="加载项目…"
                        />
                    )}
                </div>
            ) : paged.items.length === 0 ? (
                <div className={s.full}>
                    <Empty
                        title={mineOnly ? "我没有负责的项目" : "暂无项目"}
                        hint={mineOnly ? undefined : "新建项目后会在这里出现。"}
                    />
                </div>
            ) : (
                paged.items.map((p) => (
                    <SheetCard
                        key={p.id}
                        href={`/projects/${p.id}`}
                        title={p.name}
                        note={`${p.code} · ${projectStatusLabel(p.status)} · ${p.owner_name || userName(p.owner_id)}`}
                        tone={toneFor(p.status)}
                        onSelect={onSelect}
                    />
                ))
            )}
            {/* 切 chips 时保留旧列表：loading 只在首屏显示骨架，不闪掉已选内容 */}
            {!firstLoad && loading && <span className="sr-only">筛选中…</span>}
        </>
    );
}
