// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  payments: vi.fn(),
  createPayment: vi.fn(),
  updatePayment: vi.fn(),
  removePayment: vi.fn(),
  ok: vi.fn(),
  err: vi.fn(),
}));

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    projectsApi: {
      ...actual.projectsApi,
      receivables: mocks.list,
      createReceivable: mocks.create,
      updateReceivable: mocks.update,
      deleteReceivable: mocks.remove,
      receivablePayments: mocks.payments,
      createReceivablePayment: mocks.createPayment,
      updateReceivablePayment: mocks.updatePayment,
      deleteReceivablePayment: mocks.removePayment,
    },
  };
});

vi.mock("@/components/ui/Toast", () => ({
  useToast: () => ({ ok: mocks.ok, err: mocks.err, info: vi.fn() }),
}));

vi.mock("@/components/ui/DatePicker", () => ({
  DatePicker: ({ value, onChange, ariaLabel }: {
    value: string;
    onChange: (value: string) => void;
    ariaLabel: string;
  }) => (
    <input
      type="date"
      aria-label={ariaLabel}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));

import ProjectReceivablesPanel from "../app/(dashboard)/projects/[id]/ProjectReceivablesPanel";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const projectId = 41;
const receivable = {
  id: 7,
  project_id: projectId,
  name: "一期款",
  amount: "1000.00",
  received_amount: "300.00",
  outstanding_amount: "700.00",
  receivable_date: "2026-01-01",
  due_date: "2026-12-31",
  note: "合同首期款",
  status: "partial",
  payment_count: 1,
};

function readyPanel({ canWrite = true, canDelete = false } = {}) {
  mocks.list.mockResolvedValue({
    total: 1,
    page: 1,
    size: 100,
    items: [receivable],
    summary: { amount: "1000.00", received_amount: "300.00", outstanding_amount: "700.00" },
  });
  mocks.payments.mockResolvedValue({
    total: 1,
    page: 1,
    size: 100,
    items: [{ id: 9, amount: "300.00", payment_date: "2026-02-01", note: "首笔到账" }],
  });
  return render(
    <ProjectReceivablesPanel projectId={projectId} canWrite={canWrite} canDelete={canDelete} />,
  );
}

async function getReceivableCards(): Promise<HTMLElement> {
  await screen.findAllByText("一期款");
  const list = document.querySelector('[data-cardlist="项目应收"]');
  if (!(list instanceof HTMLElement)) throw new Error("项目应收卡片列表未渲染");
  return list;
}

describe("项目应收面板", () => {
  it("展示应收汇总、状态和记录，并可展开逐笔回款", async () => {
    readyPanel();

    const cards = await getReceivableCards();
    expect(await within(cards).findByText("一期款")).toBeTruthy();
    expect(within(cards).getByText("部分回款")).toBeTruthy();
    const summary = document.querySelector('[aria-label="应收汇总"]') as HTMLElement;
    expect(summary.textContent).toContain("1,000.00");
    expect(summary.textContent).toContain("300.00");
    expect(summary.textContent).toContain("700.00");

    fireEvent.click(within(cards).getByRole("button", { name: "回款记录" }));
    expect(await screen.findAllByText("首笔到账")).toHaveLength(4);
    expect(mocks.payments).toHaveBeenCalledWith(projectId, receivable.id, expect.any(AbortSignal));
  });

  it("新增应收时提交日期、金额和说明", async () => {
    readyPanel();
    mocks.create.mockResolvedValue({ ...receivable, id: 8 });
    fireEvent.click(await screen.findByRole("button", { name: /新增应收/ }));

    fireEvent.change(screen.getByLabelText("款项名称", { exact: false }), { target: { value: "验收尾款" } });
    fireEvent.change(screen.getByLabelText("应收金额（元）", { exact: false }), { target: { value: "2500.00" } });
    fireEvent.change(screen.getByLabelText("应收日期"), { target: { value: "2026-03-01" } });
    fireEvent.change(screen.getByLabelText("到期日"), { target: { value: "2026-04-01" } });
    fireEvent.change(screen.getByLabelText("说明"), { target: { value: "验收后支付" } });
    fireEvent.click(screen.getByRole("button", { name: "保存应收" }));

    await waitFor(() => expect(mocks.create).toHaveBeenCalledWith(projectId, {
      name: "验收尾款",
      amount: "2500.00",
      receivable_date: "2026-03-01",
      due_date: "2026-04-01",
      note: "验收后支付",
    }));
    expect(mocks.ok).toHaveBeenCalled();
  });

  it("可登记逐笔回款并在未结清金额上保留回款历史", async () => {
    readyPanel();
    mocks.createPayment.mockResolvedValue({ id: 10 });
    const cards = await getReceivableCards();
    fireEvent.click(within(cards).getByRole("button", { name: "登记回款" }));

    fireEvent.change(screen.getByLabelText("回款金额（元）", { exact: false }), { target: { value: "200.00" } });
    fireEvent.change(screen.getByLabelText("回款日期"), { target: { value: "2026-03-02" } });
    fireEvent.change(screen.getByLabelText("备注"), { target: { value: "第二笔到账" } });
    fireEvent.click(screen.getByRole("button", { name: "保存回款" }));

    await waitFor(() => expect(mocks.createPayment).toHaveBeenCalledWith(projectId, receivable.id, {
      amount: "200.00",
      payment_date: "2026-03-02",
      note: "第二笔到账",
    }));
  });

  it("普通成员可录入但不能删除，且无写权限时隐藏录入操作", async () => {
    const { rerender } = readyPanel({ canWrite: true, canDelete: false });
    const cards = await getReceivableCards();
    expect(screen.getByRole("button", { name: /新增应收/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "删除应收" })).toBeNull();
    expect(screen.queryByRole("button", { name: "删除回款" })).toBeNull();

    rerender(<ProjectReceivablesPanel projectId={projectId} canWrite={false} canDelete={false} />);
    await waitFor(() => expect(screen.queryByRole("button", { name: /新增应收/ })).toBeNull());
    expect(within(cards).queryByRole("button", { name: "登记回款" })).toBeNull();
  });

  it("管理员可查看删除动作入口", async () => {
    readyPanel({ canWrite: true, canDelete: true });
    const rows = await screen.findAllByText("一期款");
    const row = rows[0];
    const card = row.closest("article");
    expect(card && within(card).getByRole("button", { name: "删除应收" })).toBeTruthy();
    fireEvent.click(within(card as HTMLElement).getByRole("button", { name: "回款记录" }));
    const paymentDeleteButtons = await screen.findAllByRole("button", { name: "删除回款" });
    expect(paymentDeleteButtons.length).toBeGreaterThan(0);
  });
});
