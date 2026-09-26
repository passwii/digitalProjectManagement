// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ArapPanel from "../app/(dashboard)/finance/ArapPanel";
import type { FinanceAccount, FinancePeriod } from "./api";

const period: FinancePeriod = {
  id: 3,
  year: 2026,
  month: 9,
  period: "2026-09",
  status: "open",
  start_date: "2026-09-01",
  end_date: "2026-09-30",
  version: 1,
};

const accounts: FinanceAccount[] = [
  { id: 20, code: "112201", name: "应收账款", level: 2, parent_id: 1, direction: "D", category: "资产", subject_version: "2022", aux_flags: { customer: true }, is_leaf: true, is_active: true },
  { id: 21, code: "100201", name: "银行存款", level: 2, parent_id: 1, direction: "D", category: "资产", subject_version: "2022", aux_flags: { cashflow: true }, is_leaf: true, is_active: true },
];

const receivable = {
  id: 8,
  period_id: 3,
  transaction_date: "2026-09-01",
  party_id: 5,
  account_id: 20,
  amount: "100.00",
  applied_amount: "40.00",
  outstanding: "60.00",
  summary: "项目阶段款",
  voucher_id: 15,
  voucher_no: "记-0001",
  voucher_status: "posted" as const,
  is_reversed: false,
  is_reversing: true,
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("应收应付账龄与对账单", () => {
  it("按账套查询应收账龄，并从客户明细打开已过账对账单", async () => {
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
    const seen: Array<{ url: URL; init: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init: RequestInit = {}) => {
      const url = new URL(String(input), "http://localhost");
      seen.push({ url, init });
      let result: unknown;
      if (url.pathname.endsWith("/receivables")) {
        result = { total: 1, items: [receivable] };
      } else if (url.pathname.endsWith("/payables")) {
        result = { total: 0, items: [] };
      } else if (url.pathname.endsWith("/auxiliary-items")) {
        result = url.searchParams.get("kind") === "customer"
          ? [{ id: 5, kind: "customer", code: "C-005", name: "客户甲", metadata: {}, is_active: true }]
          : [];
      } else if (url.pathname.endsWith("/receivables/aging") || url.pathname.endsWith("/payables/aging")) {
        result = { as_of: "2026-09-26", age_basis: "voucher_date", total_outstanding: "60.00", buckets: { "0_30": "60.00", "31_60": "0.00", "61_90": "0.00", "90_plus": "0.00" } };
      } else if (url.pathname.endsWith("/receivables/statement")) {
        result = {
          kind: "receivable", party_id: 5, account_id: 20,
          from_date: "2026-09-01", to_date: "2026-09-26",
          opening_balance: "0.00", period_increase: "100.00", period_decrease: "40.00", closing_balance: "60.00",
          total_lines: 2, page: 1, page_size: 50,
          items: [
            { transaction_id: 8, transaction_date: "2026-09-01", voucher_id: 15, voucher_no: "记-0001", event_type: "单据", summary: "项目阶段款", direction: "increase", amount: "100.00", balance_after: "100.00" },
            { transaction_id: 8, transaction_date: "2026-09-12", voucher_id: 16, voucher_no: "收-0001", event_type: "收付款", summary: "收到阶段款", direction: "decrease", amount: "40.00", balance_after: "60.00" },
          ],
        };
      } else {
        result = [];
      }
      return new Response(JSON.stringify(result), { status: 200, headers: { "Content-Type": "application/json" } });
    }));

    render(
      <ArapPanel
        book="BOOK-A"
        period={period}
        accounts={accounts}
        accountsLoading={false}
        accountsError=""
        reloadAccounts={() => {}}
        isAdmin={false}
      />,
    );

    expect((await screen.findAllByText("客户甲")).length).toBeGreaterThan(0);
    expect(await screen.findByText("已过账未结余额")).toBeTruthy();
    expect(screen.getAllByText("冲销处理中").length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: "登记收款" }).every((button) => (button as HTMLButtonElement).disabled)).toBe(true);
    expect(seen.some(({ url, init }) => url.pathname.endsWith("/receivables/aging") && url.searchParams.get("as_of") && (init.headers as Record<string, string>)["X-Account-Book"] === "BOOK-A")).toBe(true);

    fireEvent.click(screen.getAllByRole("button", { name: "对账单" })[0]);
    expect(await screen.findByRole("dialog")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "查询对账单" }));
    expect(await screen.findByText("收到阶段款")).toBeTruthy();
    expect(screen.getAllByText(/暂不含普通手工、模板、导入凭证及期初辅助余额/).length).toBeGreaterThan(0);
    expect(screen.getAllByText("60.00").length).toBeGreaterThan(0);

    await waitFor(() => expect(seen.some(({ url, init }) =>
      url.pathname.endsWith("/receivables/statement") &&
      url.searchParams.get("party_id") === "5" &&
      url.searchParams.get("account_id") === "20" &&
      url.searchParams.get("from_date") === "2026-09-01" &&
      (init.headers as Record<string, string>)["X-Account-Book"] === "BOOK-A",
    )).toBe(true));

    fireEvent.click(screen.getByRole("tab", { name: "应付台账" }));
    expect(await screen.findByText("应付账龄")).toBeTruthy();
    await waitFor(() => expect(seen.some(({ url }) => url.pathname.endsWith("/payables/aging"))).toBe(true));
  });
});
