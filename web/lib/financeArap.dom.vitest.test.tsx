// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ArapPanel from "../app/(dashboard)/finance/ArapPanel";
import { ArapSettlementDialog } from "../app/(dashboard)/finance/ArapDialogs";
import { financeApi, type FinanceAccount, type FinanceARAPItem, type FinancePeriod } from "./api";
import { selectOption } from "./testing/selectDriver";

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
  voucher_date: "2026-09-01",
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const settlementAccount: FinanceAccount = {
  id: 22, code: "100101", name: "库存现金", level: 2, parent_id: 1,
  direction: "D", category: "资产", subject_version: "2022", aux_flags: {}, is_leaf: true, is_active: true,
};
const settlementParty = { id: 5, kind: "customer" as const, code: "C-005", name: "客户甲", metadata: {}, is_active: true };
const settlementItems: FinanceARAPItem[] = [
  { ...receivable, id: 8, outstanding: "60.00", is_reversing: false },
  { ...receivable, id: 9, transaction_date: "2026-09-02", voucher_date: "2026-09-02", voucher_no: "记-0002", summary: "第二期款", outstanding: "40.00", is_reversing: false },
];

function renderSettlement(items: FinanceARAPItem[] = settlementItems) {
  const onSaved = vi.fn();
  const payment = vi.spyOn(financeApi, "collectReceivable").mockResolvedValue({
    allocations: [], voucher: { voucher_no: "收-0001" } as never,
  });
  const view = render(<ArapSettlementDialog
    open kind="receivable" book="BOOK-A" period={period}
    party={settlementParty} account={accounts[0]} outstanding="100.00"
    documents={items} accounts={[accounts[0], settlementAccount]} cashflows={[]}
    onClose={() => {}} onSaved={onSaved}
  />);
  fireEvent.change(screen.getByLabelText("交易日期"), { target: { value: "2026-09-26" } });
  return { payment, onSaved, ...view };
}

function fillPayment(amount: string) {
  fireEvent.change(screen.getByLabelText("金额"), { target: { value: amount } });
  // 自绘下拉：点开再选，不能再用原生 change
  // 结算科目是 id=22 / 100101 · 库存现金，选项文案为「编码 · 名称」
  selectOption("现金/银行科目", "100101 · 库存现金");
}

describe("往来指定单据核销", () => {
  it("默认 FIFO 提交不带 allocations", async () => {
    const { payment } = renderSettlement();
    expect(screen.getByText("按凭证日期先进先出")).toBeTruthy();
    fillPayment("50");
    fireEvent.click(screen.getByRole("button", { name: "登记收款" }));
    await waitFor(() => expect(payment).toHaveBeenCalledOnce());
    expect(payment.mock.calls[0][1]).toMatchObject({ account_id: 20, customer_id: 5, amount: "50.00" });
    expect(payment.mock.calls[0][1]).not.toHaveProperty("allocations");
  });

  it("指定模式只列出同主体同科目且已过账、未冲销、日期合适、有余额的单据", () => {
    const excluded: FinanceARAPItem[] = [
      { ...settlementItems[0], id: 30, party_id: 6, voucher_no: "排除-主体" },
      { ...settlementItems[0], id: 31, account_id: 99, voucher_no: "排除-科目" },
      { ...settlementItems[0], id: 32, voucher_status: "draft", voucher_no: "排除-草稿" },
      { ...settlementItems[0], id: 33, is_reversing: true, voucher_no: "排除-冲销中" },
      { ...settlementItems[0], id: 34, is_reversed: true, voucher_no: "排除-已冲销" },
      { ...settlementItems[0], id: 35, transaction_date: "2026-10-01", voucher_date: "2026-10-01", voucher_no: "排除-未来" },
      { ...settlementItems[0], id: 36, outstanding: "0.00", voucher_no: "排除-零余额" },
    ];
    renderSettlement([...settlementItems, ...excluded]);
    fireEvent.click(screen.getByLabelText("指定单据"));
    expect(screen.getByText("记-0001")).toBeTruthy();
    expect(screen.getByText("记-0002")).toBeTruthy();
    for (const item of excluded) expect(screen.queryByText(item.voucher_no!)).toBeNull();
  });

  it("按实际凭证日期筛选和展示候选", () => {
    const items: FinanceARAPItem[] = [
      { ...settlementItems[0], id: 40, transaction_date: "2026-09-28", voucher_date: "2026-09-20", voucher_no: "记-可核销" },
      { ...settlementItems[0], id: 41, transaction_date: "2026-09-03", voucher_date: "2026-09-27", voucher_no: "记-凭证未来" },
      { ...settlementItems[0], id: 42, transaction_date: "2026-09-04", voucher_date: null, voucher_no: "记-凭证缺失" },
    ];
    renderSettlement(items);
    fireEvent.click(screen.getByLabelText("指定单据"));
    expect(screen.getByText("记-可核销")).toBeTruthy();
    expect(screen.getByText("2026-09-20")).toBeTruthy();
    expect(screen.queryByText("记-凭证未来")).toBeNull();
    expect(screen.queryByText("记-凭证缺失")).toBeNull();
  });

  it("按实际凭证日期排序指定单据候选", () => {
    const items: FinanceARAPItem[] = [
      { ...settlementItems[0], id: 43, transaction_date: "2026-09-28", voucher_date: "2026-09-20", voucher_no: "记-凭证早" },
      { ...settlementItems[0], id: 44, transaction_date: "2026-09-03", voucher_date: "2026-09-22", voucher_no: "记-凭证晚" },
    ];
    renderSettlement(items);
    fireEvent.click(screen.getByLabelText("指定单据"));
    const labels = screen.getAllByLabelText(/本次核销额/).map((input) => input.closest("label")?.textContent?.trim());
    expect(labels).toEqual(["本次核销额 · 记-凭证早", "本次核销额 · 记-凭证晚"]);
  });

  it("拆分金额合计等于收款额时发送正金额目标明细", async () => {
    const { payment } = renderSettlement();
    fillPayment("75.00");
    fireEvent.click(screen.getByLabelText("指定单据"));
    fireEvent.change(screen.getByLabelText("本次核销额 · 记-0001"), { target: { value: "50.00" } });
    fireEvent.change(screen.getByLabelText("本次核销额 · 记-0002"), { target: { value: "25.00" } });
    expect(screen.getByText(/差额.*0\.00/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "登记收款" }));
    await waitFor(() => expect(payment).toHaveBeenCalledOnce());
    expect(payment.mock.calls[0][1].allocations).toEqual([
      { target_id: 8, amount: "50.00" }, { target_id: 9, amount: "25.00" },
    ]);
  });

  it("指定模式将整数和一位小数输入规范为两位小数的 API 金额", async () => {
    const { payment } = renderSettlement();
    fillPayment("75");
    fireEvent.click(screen.getByLabelText("指定单据"));
    fireEvent.change(screen.getByLabelText("本次核销额 · 记-0001"), { target: { value: "50.0" } });
    fireEvent.change(screen.getByLabelText("本次核销额 · 记-0002"), { target: { value: "25" } });
    fireEvent.click(screen.getByRole("button", { name: "登记收款" }));
    await waitFor(() => expect(payment).toHaveBeenCalledOnce());
    expect(payment.mock.calls[0][1]).toMatchObject({
      amount: "75.00",
      allocations: [
        { target_id: 8, amount: "50.00" },
        { target_id: 9, amount: "25.00" },
      ],
    });
  });

  it("合计不等和超余额时禁用提交并显示原因", () => {
    renderSettlement();
    fillPayment("70.00");
    fireEvent.click(screen.getByLabelText("指定单据"));
    expect(screen.getByRole("button", { name: "登记收款" })).toHaveProperty("disabled", true);
    expect(screen.getByText(/核销合计.*收款金额/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("本次核销额 · 记-0001"), { target: { value: "70.00" } });
    expect(screen.getByRole("button", { name: "登记收款" })).toHaveProperty("disabled", true);
    expect(screen.getByText(/超过.*可核销余额/)).toBeTruthy();
  });

  it("没有符合条件的单据时禁用提交并说明原因", () => {
    renderSettlement([]);
    fillPayment("10.00");
    fireEvent.click(screen.getByLabelText("指定单据"));
    expect(screen.getByRole("button", { name: "登记收款" })).toHaveProperty("disabled", true);
    expect(screen.getByText(/没有可核销单据/)).toBeTruthy();
  });

  it("指定模式未填写收款金额或总余额为零时禁用提交", () => {
    renderSettlement();
    fireEvent.click(screen.getByLabelText("指定单据"));
    expect(screen.getByRole("button", { name: "登记收款" })).toHaveProperty("disabled", true);
    expect(screen.getByText(/请先填写收款金额/)).toBeTruthy();
    cleanup();
    render(<ArapSettlementDialog
      open kind="receivable" book="BOOK-A" period={period}
      party={settlementParty} account={accounts[0]} outstanding="0.00"
      documents={settlementItems} accounts={[accounts[0], settlementAccount]} cashflows={[]}
      onClose={() => {}} onSaved={() => {}}
    />);
    fillPayment("10.00");
    fireEvent.click(screen.getByLabelText("指定单据"));
    expect(screen.getByRole("button", { name: "登记收款" })).toHaveProperty("disabled", true);
    expect(screen.getByText(/没有剩余可核销额度/)).toBeTruthy();
  });

  it("修改交易日期会清空已输入的分配金额", () => {
    renderSettlement();
    fillPayment("60.00");
    fireEvent.click(screen.getByLabelText("指定单据"));
    fireEvent.change(screen.getByLabelText("本次核销额 · 记-0001"), { target: { value: "60.00" } });
    fireEvent.change(screen.getByLabelText("交易日期"), { target: { value: "2026-09-01" } });
    expect(screen.getByLabelText("本次核销额 · 记-0001")).toHaveProperty("value", "");
    expect(screen.queryByText("记-0002")).toBeNull();
  });

  it("接口失败时显示后端错误并保留指定单据输入", async () => {
    const { payment } = renderSettlement();
    payment.mockRejectedValueOnce(new Error("单据余额已变化"));
    fillPayment("50.00");
    fireEvent.click(screen.getByLabelText("指定单据"));
    fireEvent.change(screen.getByLabelText("本次核销额 · 记-0001"), { target: { value: "50.00" } });
    fireEvent.click(screen.getByRole("button", { name: "登记收款" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "单据余额已变化");
    expect(screen.getByLabelText("本次核销额 · 记-0001")).toHaveProperty("value", "50.00");
  });
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
