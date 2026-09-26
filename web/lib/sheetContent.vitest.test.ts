import { describe, expect, it } from "vitest";
import { DOCK_SLOTS } from "./mobileNav";
import {
  SHEET_CONTENT,
  SHEET_META,
} from "@/components/mobile/sheets";
import DashboardSheet from "@/components/mobile/sheets/DashboardSheet";
import ExpensesSheet from "@/components/mobile/sheets/ExpensesSheet";
import MineSheet from "@/components/mobile/sheets/MineSheet";
import ProgressSheet from "@/components/mobile/sheets/ProgressSheet";
import ProjectsSheet from "@/components/mobile/sheets/ProjectsSheet";

/**
 * S4 映射的契约测试（BLF-1127 §3 + D1/D3）。
 *
 * 与 `mobileNav.vitest.test.ts` 同一个理由：Dock 位 → 抽屉的对应关系是契约，
 * 靠截图验不出来（开错抽屉在截图上只是一组不同的卡片，很容易看走眼）。
 * 所以映射完整性与 D1 的 costs 归属都钉在纯数据上。
 */
describe("SHEET_CONTENT（§3：5 个位各一份抽屉内容）", () => {
  it("5 个 Dock 位全有映射，不多不少", () => {
    expect(Object.keys(SHEET_CONTENT).sort()).toEqual(
      DOCK_SLOTS.map((s) => s.id).sort(),
    );
  });

  it("D1：costs 位渲染 ExpensesSheet（同时吸收 reports）", () => {
    expect(SHEET_CONTENT.costs).toBe(ExpensesSheet);
    expect(SHEET_CONTENT.costs).not.toBe(ProjectsSheet);
  });

  it("每位各配各的组件", () => {
    expect(SHEET_CONTENT.dashboard).toBe(DashboardSheet);
    expect(SHEET_CONTENT.projects).toBe(ProjectsSheet);
    expect(SHEET_CONTENT.progress).toBe(ProgressSheet);
    expect(SHEET_CONTENT.mine).toBe(MineSheet);
  });
});

describe("SHEET_META（抽屉头）", () => {
  it("5 个位都有副标题，动作为真实站内路由", () => {
    for (const slot of DOCK_SLOTS) {
      const meta = SHEET_META[slot.id];
      expect(meta.subtitle.length).toBeGreaterThan(0);
      if (meta.action) {
        expect(meta.action.label.length).toBeGreaterThan(0);
        expect(meta.action.href.startsWith("/")).toBe(true);
      }
    }
  });

  it("工作台与三个业务分组提供数据失败时仍可用的直达入口", () => {
    for (const id of ["dashboard", "projects", "progress", "costs"] as const) {
      expect(SHEET_META[id].action?.href.startsWith("/")).toBe(true);
    }
  });
});
