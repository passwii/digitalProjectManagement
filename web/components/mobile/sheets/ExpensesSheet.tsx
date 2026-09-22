"use client";

// 支出抽屉（BLF-1127 / S4，§3 第四行 + D1）：本月支出口径卡 + 「支出记录」「支出报表」两张模块卡。
//
// D1 的两条锁死在这里：
//   · 这一位同时吸收 `costs` 与 `reports` —— 两张模块卡的落点分别是 `/costs` 与
//     `/reports`，Dock 位只占 1 格（路由键仍是 `costs`）；
//   · 支出口径提示放在抽屉里，不藏进报表页：「已支出只统计已通过 / 特批通过，
//     与财务账存在差异」。
// 本月支出与桌面工作台 KPI 同源（`dashboard/summary.kpi.month_spent`）；
// 「支出记录」卡的待审批笔数走 `/expenses?status=pending` 的分页 total
// （与 `costs/page.tsx` 的待审批口径一致）。两处统计都失败也不影响导航：
// 模块卡与口径提示是静态的，永远可点，抽屉不会变空白。

import {
  buildQuery,
  dashboardApi,
  expensesApi,
  unwrapPaged,
  type Expense,
} from "@/lib/api";
import { fmtMoney } from "@/lib/labels";
import { useAsyncData } from "@/lib/useAsyncData";
import { LoadFailed, LoadingBlock } from "@/components/ui/PageState";
import SheetCard from "../SheetCard";
import type { SheetContentProps } from "./index";
import s from "./sheets.module.css";

/** D1 口径：与 issue 验收口径逐字一致 */
export const COST_CALIBER =
  "已支出只统计「已通过 / 特批通过」，与财务账存在差异。";

export default function ExpensesSheet({
  variant,
  onSelect,
}: SheetContentProps) {
  const { data, firstLoad, error, reload } = useAsyncData(async (signal) => {
    const [summary, pending] = await Promise.all([
      dashboardApi.summary(signal),
      expensesApi
        .list(buildQuery({ status: "pending", page: 1, size: 1 }), signal)
        .then((r) => unwrapPaged<Expense>(r).total)
        .catch(() => null),
    ]);
    return { summary, pendingTotal: pending };
  }, []);

  const k = data?.summary.kpi;

  return (
    <>
      {k == null ? (
        <div className={s.full}>
          {error ? (
            <LoadFailed message={error} onRetry={reload} />
          ) : (
            firstLoad && (
              <LoadingBlock title={false} kpis={2} label="加载支出…" />
            )
          )}
        </div>
      ) : (
        <SheetCard
          variant={variant}
          href="/reports"
          title={`${k.month}支出`}
          note="按已通过支出统计"
          value={`¥${fmtMoney(k.month_spent)}`}
          tone="brand"
          onSelect={onSelect}
        />
      )}
      <SheetCard
        variant={variant}
        href="/costs"
        title="支出记录"
        note={
          data?.pendingTotal == null
            ? "登记与审批"
            : `待审批 ${data.pendingTotal} 笔 · 登记与审批`
        }
        onSelect={onSelect}
      />
      <SheetCard
        variant={variant}
        href="/reports"
        title="支出报表"
        note="科目 / 人员 / 项目维度"
        onSelect={onSelect}
      />
      <div className={s.note} data-sheet-note="caliber">
        <span>
          <b>口径提示：</b>
          {COST_CALIBER}
        </span>
      </div>
    </>
  );
}
