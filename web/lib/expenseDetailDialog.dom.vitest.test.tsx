// @vitest-environment jsdom
/**
 * 支出详情弹层（只读）的 DOM 行为测试。
 *
 * 只测「接线」：给定一笔支出与票据列表，弹层把人员 / 金额 / 状态 / 说明 / 审批意见
 * 如实渲染出来，并真的按支出 id 去取票据。`@/lib/api` 被替换成替身，避免真实网络。
 * 走 vitest + jsdom 与 `attachmentPreview.dom.vitest.test.tsx` 同一理由：弹层经
 * createPortal 挂到 `document.body`，需要真实 DOM 查询。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { Expense } from "./api";

const mocks = vi.hoisted(() => ({
  vouchers: vi.fn(),
  downloadVoucher: vi.fn(),
}));

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("./api")>("./api");
  return {
    ...actual,
    expensesApi: {
      ...actual.expensesApi,
      vouchers: mocks.vouchers,
      downloadVoucher: mocks.downloadVoucher,
    },
  };
});

import ExpenseDetailDialog from "../app/(dashboard)/costs/ExpenseDetailDialog";

const expense: Expense = {
  id: 42,
  project_id: 7,
  subject: "差旅费",
  amount: 1200,
  exp_date: "2026-09-12",
  note: "出差机票",
  status: "rejected",
  by_id: 1,
  decision_reason: "缺少发票",
  decided_at: "2026-09-13T10:00:00",
};

beforeEach(() => {
  // framer-motion 的 useReducedMotion 会读 matchMedia；jsdom 不实现，装上替身。
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({
      matches: false,
      media: "(prefers-reduced-motion: reduce)",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
  mocks.vouchers.mockReset().mockResolvedValue([
    { id: 1, filename: "发票.pdf", size: 2048, uploaded_by: 1, uploaded_at: null },
  ]);
  mocks.downloadVoucher.mockReset();
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("ExpenseDetailDialog（支出详情）", () => {
  it("渲染金额 / 状态 / 费用说明，并按支出 id 取票据", async () => {
    render(<ExpenseDetailDialog open expense={expense} onClose={() => {}} />);

    expect(screen.getByText("1,200 元")).toBeTruthy();
    expect(screen.getByText("已驳回")).toBeTruthy();
    expect(screen.getByText("出差机票")).toBeTruthy();
    expect(screen.getByText("缺少发票")).toBeTruthy();

    await waitFor(() => expect(mocks.vouchers).toHaveBeenCalledWith(42, expect.any(AbortSignal)));
    expect(await screen.findByText("发票.pdf")).toBeTruthy();
  });

  it("被驳回的单据给出「重新提交」并把原单回调给页面", async () => {
    const onResubmit = vi.fn();
    render(<ExpenseDetailDialog open expense={expense} onClose={() => {}} onResubmit={onResubmit} />);

    fireEvent.click(screen.getByRole("button", { name: "重新提交" }));

    expect(onResubmit).toHaveBeenCalledWith(expense);
  });

  it("已通过的正常单据不出现「重新提交」入口", async () => {
    render(
      <ExpenseDetailDialog
        open
        expense={{ ...expense, status: "approved", decision_reason: "同意" }}
        onClose={() => {}}
        onResubmit={() => {}}
      />,
    );

    expect(screen.queryByRole("button", { name: "重新提交" })).toBeNull();
  });
});
