// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ProjectExpensePanel from "../app/(dashboard)/finance/ProjectExpensePanel";
import type { FinanceAccount, FinanceBook, FinancePeriod } from "./api";

const book: FinanceBook = { id: 8, code: "BOOK-A", name: "研发账套", base_currency: "CNY", currencies: ["CNY"], status: "active" };
const periods: FinancePeriod[] = [{ id: 3, year: 2026, month: 9, period: "2026-09", status: "open", start_date: "2026-09-01", end_date: "2026-09-30", version: 1 }];
const account = (id: number, code: string, name: string): FinanceAccount => ({ id, code, name, level: 2, parent_id: 1, direction: "D", category: "损益", subject_version: "2022", aux_flags: {}, is_leaf: true, is_active: true });
const accounts = [account(10, "660201", "项目费用"), account(11, "100201", "银行存款")];
const expense = { id: 42, project_id: 7, subject: "材料采购", amount: "1234.50", exp_date: "2026-09-12", note: "设备耗材", status: "approved", by_id: 1, approved_by: 2, project: { id: 7, code: "P-007", name: "火星项目" }, source_voucher_summary: null };

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("项目支出入账", () => {
  it("展示来源并用只读金额生成待审核过账的草稿凭证", async () => {
    vi.stubGlobal("localStorage", { getItem: () => null });
    const requests: Array<{ path: string; init: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string, init: RequestInit = {}) => {
      const path = new URL(input).pathname;
      requests.push({ path, init });
      const result = path.endsWith("/project-expenses")
        ? { total: 1, page: 1, size: 20, items: [expense] }
        : path.endsWith("/auxiliary-items")
          ? []
          : { id: 99, voucher_no: "记-0001", status: "draft", summary: "材料采购" };
      return new Response(JSON.stringify(result), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
    const onVoucherCreated = vi.fn();
    render(<ProjectExpensePanel book={book} periods={periods} accounts={accounts} onVoucherCreated={onVoucherCreated} />);

    const generate = await screen.findByRole("button", { name: "生成凭证" });
    expect(generate.closest("tr")?.textContent).toContain("火星项目");
    expect(generate.closest("tr")?.textContent).toContain("材料采购");
    expect(generate.closest("tr")?.textContent).toContain("1,234.50");
    fireEvent.click(generate);
    expect(screen.getByText("研发账套")).toBeTruthy();
    expect(screen.getByText("设备耗材")).toBeTruthy();
    const amount = screen.getByLabelText("来源金额") as HTMLInputElement;
    expect(amount.readOnly).toBe(true);
    expect(amount.value).toBe("1,234.50");
    fireEvent.change(screen.getByLabelText("借方科目"), { target: { value: "10" } });
    fireEvent.change(screen.getByLabelText("贷方科目"), { target: { value: "11" } });
    const confirm = screen.getByRole("button", { name: "确认生成草稿凭证" }) as HTMLButtonElement;
    await waitFor(() => expect(confirm.disabled).toBe(false));
    fireEvent.click(confirm);

    await waitFor(() => expect(onVoucherCreated).toHaveBeenCalledTimes(1));
    const submitted = requests.find((request) => request.path.endsWith("/project-expenses/42/voucher"));
    expect(submitted).toBeTruthy();
    expect(submitted?.init.headers).toMatchObject({ "X-Account-Book": "BOOK-A" });
    expect(JSON.parse(String(submitted?.init.body))).toEqual({ period_id: 3, voucher_date: expect.any(String), summary: "材料采购", debit: { account_id: 10, aux_detail: {} }, credit: { account_id: 11, aux_detail: {} } });
    expect(JSON.parse(String(submitted?.init.body))).not.toHaveProperty("amount");
    expect(JSON.parse(String(submitted?.init.body))).not.toHaveProperty("account_book_id");
    expect(await screen.findByText(/草稿凭证已生成，需继续审核和过账/)).toBeTruthy();
  });
});
