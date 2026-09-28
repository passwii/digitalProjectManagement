// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const { api, me, users, isAdmin } = vi.hoisted(() => ({
  api: {
    overview: vi.fn(), categories: vi.fn(), batches: vi.fn(), overdue: vi.fn(), statistics: vi.fn(),
    list: vi.fn(), get: vi.fn(), events: vi.fn(), batch: vi.fn(), acceptBatch: vi.fn(),
    inbound: vi.fn(), claim: vi.fn(), borrow: vi.fn(), return: vi.fn(), transition: vi.fn(), update: vi.fn(),
    deleteCheck: vi.fn(), remove: vi.fn(),
    upload: vi.fn(), export: vi.fn(), createCategory: vi.fn(), updateCategory: vi.fn(), deleteCategory: vi.fn(),
  },
  me: vi.fn(),
  users: [{ id: 42, real_name: "张三" }],
  isAdmin: vi.fn(() => true),
}));

vi.mock("@/lib/api", () => ({
  equipmentAssetsApi: api,
  authApi: { me },
  errText: (error: unknown) => error instanceof Error ? error.message : String(error),
  equipmentAssetActions: (asset: { status: string; holder_id: number | null }, isAdmin: boolean, currentUser?: number) => ({
    canClaim: asset.status === "available" && !isAdmin,
    canBorrow: asset.status === "available" && !isAdmin,
    canReturn: asset.status === "borrowed" && (isAdmin || asset.holder_id === currentUser),
  }),
}));
vi.mock("@/lib/useMeta", () => ({ useMenus: () => ({ isAdmin: isAdmin() }), useMeta: () => ({ users: [{ id: 42, real_name: "张三" }, ...users.filter((user) => user.id !== 42)] }) }));

import AssetsPage from "../app/(dashboard)/assets/page";

const asset = (overrides: Record<string, unknown> = {}) => ({
  id: 1, code: "EQ-001", name: "测试笔记本", category_code: "computer", serial_number: null,
  brand: null, model: null, location: "A 座", note: null, purchase_date: null, purchase_price: null,
  status: "available", holder_id: null, due_date: null, batch_id: null, created_by: 1,
  created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", ...overrides,
});
const page = <T,>(items: T[], total = items.length, current = 1, size = 20) => ({ items, total, page: current, size });

function setup({ batchTotal = 1, overdueTotal = 1 }: { batchTotal?: number; overdueTotal?: number } = {}) {
  api.overview.mockResolvedValue({ total: 1, by_status: { available: 1 }, overdue: overdueTotal });
  api.categories.mockResolvedValue([{ code: "computer", label: "电脑", sort: 1 }]);
  api.batches.mockImplementation(async (current: number, size: number) => page(current === 1 ? [{ id: 10, source: "采购", supplier: "供方", purchase_order_no: null, invoice_no: null, acceptance_status: "accepted" }] : [{ id: 11, source: "采购", supplier: "供方", purchase_order_no: null, invoice_no: null, acceptance_status: "accepted" }], batchTotal, current, size));
  api.overdue.mockImplementation(async (current: number, size: number) => page(current === 1 ? [asset({ id: 20, status: "borrowed", holder_id: 42, due_date: "2026-01-01" })] : [asset({ id: 21, status: "borrowed", holder_id: 42, due_date: "2026-01-02" })], overdueTotal, current, size));
  api.statistics.mockResolvedValue({ by_category: [], by_status: [], by_month: [], by_holder: [] });
  api.list.mockResolvedValue(page([asset()]));
  api.get.mockImplementation(async (id: number) => asset({ id, holder_id: 42, status: "borrowed", due_date: "2026-12-31" }));
  api.events.mockResolvedValue({ items: [] });
  api.deleteCheck.mockResolvedValue({ allowed: true, asset_id: 1, code: "EQ-001", reason: null, event_count: 1, protected_actions: [] });
  api.remove.mockResolvedValue({ ok: true, id: 1, code: "EQ-001" });
  api.batch.mockResolvedValue({ id: 10, acceptance_status: "accepted", items: [asset()] });
  me.mockResolvedValue({ id: 42 });
  return render(<AssetsPage />);
}

beforeEach(() => {
  vi.clearAllMocks();
  users.splice(0, users.length, { id: 42, real_name: "张三" });
  isAdmin.mockReturnValue(true);
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  setup();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("资产页面分页和刷新", () => {
  it("使用项目详情页共享标签控件并同步移动端分区选择", async () => {
    const mobileSection = await screen.findByLabelText("选择页面分区");

    fireEvent.change(mobileSection, { target: { value: "ledger" } });

    expect(screen.getByRole("tab", { name: "设备台账" }).getAttribute("aria-selected")).toBe("true");
    expect(await screen.findByPlaceholderText("编号、名称、序列号…")).toBeTruthy();
  });

  it("批次与逾期分别按服务端 total/page/size 翻页，并保持每页不超过 100", async () => {
    cleanup();
    setup({ batchTotal: 101, overdueTotal: 101 });
    fireEvent.click(await screen.findByRole("tab", { name: "入库批次" }));
    expect(await screen.findByText("批次 #10")).toBeTruthy();
    expect(document.querySelector(".asset-pagination span")?.textContent).toBe("第 1 页 · 共 101 批");
    fireEvent.click(screen.getByRole("button", { name: "下一页批次" }));
    expect(await screen.findByText("批次 #11")).toBeTruthy();
    await waitFor(() => expect(api.batches).toHaveBeenLastCalledWith(2, 100, expect.any(AbortSignal)));

    fireEvent.click(screen.getByRole("tab", { name: "逾期借用" }));
    expect(document.querySelector(".asset-pagination span")?.textContent).toBe("第 1 页 · 共 101 件");
    fireEvent.click(screen.getByRole("button", { name: "下一页逾期" }));
    await waitFor(() => expect(api.overdue).toHaveBeenLastCalledWith(2, 100, expect.any(AbortSignal)));
  });

  it("成功借用后重新加载台账并显示更新的持有人、状态和到期日", async () => {
    isAdmin.mockReturnValue(false);
    expect(users.find((user) => user.id === 42)?.real_name).toBe("张三");
    let current = asset();
    api.list.mockImplementation(async () => page([current]));
    api.get.mockImplementation(async () => current);
    api.borrow.mockImplementation(async () => { current = asset({ status: "borrowed", holder_id: 42, due_date: "2026-12-31" }); });
    fireEvent.click(await screen.findByRole("tab", { name: "设备台账" }));
    fireEvent.click(await screen.findByRole("button", { name: "查看" }));
    fireEvent.change(screen.getByLabelText("借用到期日"), { target: { value: "2026-12-31" } });
    fireEvent.click(screen.getByRole("button", { name: "借用" }));
    await waitFor(() => expect(api.list).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
    const detail = screen.getByRole("dialog");
    await waitFor(() => {
      expect(detail.textContent).toContain("借用中");
      expect(detail.textContent).toContain("张三");
      expect(detail.textContent).toContain("2026-12-31");
    });
    await waitFor(() => expect(document.querySelector(".grid tbody tr td:nth-child(3)")?.textContent).toBe("借用中"));
    expect(document.querySelector(".grid tbody tr td:nth-child(4)")?.textContent).toBe("张三");
    expect(document.querySelector(".grid tbody tr td:nth-child(5)")?.textContent).toBe("2026-12-31");
  });

  it("批次详情失败时显示可见错误且不产生未处理拒绝", async () => {
    api.batch.mockRejectedValue(new Error("批次服务不可用"));
    fireEvent.click(await screen.findByRole("tab", { name: "入库批次" }));
    fireEvent.click(await screen.findByRole("button", { name: "查看设备" }));
    expect((await screen.findByRole("alert")).textContent).toContain("批次服务不可用");
  });

  it("映射详情持有人姓名，找不到目录用户时回退到用户编号", async () => {
    api.list.mockResolvedValue(page([asset({ holder_id: 42, status: "claimed" })]));
    fireEvent.click(await screen.findByRole("tab", { name: "设备台账" }));
    fireEvent.click(await screen.findByRole("button", { name: "查看" }));
    expect(await screen.findByRole("button", { name: "编辑档案" })).toBeTruthy();
    expect(await screen.findByText("张三")).toBeTruthy();
    cleanup();
    users.splice(0, users.length);
    setup();
    api.list.mockResolvedValue(page([asset({ holder_id: 99, status: "claimed" })]));
    api.get.mockResolvedValue(asset({ holder_id: 99, status: "claimed" }));
    fireEvent.click(await screen.findByRole("tab", { name: "设备台账" }));
    fireEvent.click(await screen.findByRole("button", { name: "查看" }));
    expect(await screen.findByText("用户 99")).toBeTruthy();
  });

  it("报废需要二次确认，取消不提交，最终确认才进入报废流程", async () => {
    cleanup();
    setup();
    api.get.mockResolvedValue(asset({ status: "available" }));

    fireEvent.click(await screen.findByRole("tab", { name: "设备台账" }));
    fireEvent.click(await screen.findByRole("button", { name: "查看" }));
    fireEvent.click(await screen.findByRole("button", { name: "报废" }));

    let heading = await screen.findByRole("heading", { name: "确认报废设备" });
    let dialog = heading.closest('[role="dialog"]') as HTMLElement;
    expect(within(dialog).getByText("EQ-001")).toBeTruthy();
    expect(within(dialog).getByText("测试笔记本")).toBeTruthy();
    expect(within(dialog).getByText("可用")).toBeTruthy();
    expect(within(dialog).getByText(/不能恢复或编辑档案/)).toBeTruthy();
    expect(within(dialog).queryByText(/清空该设备的使用人和到期日/)).toBeNull();
    expect(api.transition).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "确认报废设备" })).toBeNull());
    expect(api.transition).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "报废" }));
    heading = await screen.findByRole("heading", { name: "确认报废设备" });
    dialog = heading.closest('[role="dialog"]') as HTMLElement;
    fireEvent.click(within(dialog).getByRole("button", { name: "确认报废" }));

    await waitFor(() => expect(api.transition).toHaveBeenCalledWith(1, "scrap", { note: "" }));
    expect(api.transition).toHaveBeenCalledTimes(1);
  });

  it("作废确认说明不可逆后果，并在借用状态提示清空使用人和到期日", async () => {
    cleanup();
    setup();
    api.get.mockResolvedValue(asset({ status: "borrowed", holder_id: 42, due_date: "2026-12-31" }));

    fireEvent.click(await screen.findByRole("tab", { name: "设备台账" }));
    fireEvent.click(await screen.findByRole("button", { name: "查看" }));
    fireEvent.click(await screen.findByRole("button", { name: "作废" }));

    const heading = await screen.findByRole("heading", { name: "确认作废设备" });
    const dialog = heading.closest('[role="dialog"]') as HTMLElement;
    expect(within(dialog).getByText("EQ-001")).toBeTruthy();
    expect(within(dialog).getByText("测试笔记本")).toBeTruthy();
    expect(within(dialog).getByText("借用中")).toBeTruthy();
    expect(within(dialog).getByText(/不能恢复或编辑档案/)).toBeTruthy();
    expect(within(dialog).getByText(/清空.*使用人和到期日/)).toBeTruthy();
    expect(within(dialog).queryByText("2026-12-31")).toBeNull();
    expect(api.transition).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "确认作废设备" })).toBeNull());
    expect(api.transition).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "作废" }));
    const reopenedHeading = await screen.findByRole("heading", { name: "确认作废设备" });
    const reopenedDialog = reopenedHeading.closest('[role="dialog"]') as HTMLElement;
    fireEvent.click(within(reopenedDialog).getByRole("button", { name: "确认作废" }));
    await waitFor(() => expect(api.transition).toHaveBeenCalledWith(1, "void", { note: "" }));
    expect(api.transition).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["claimed", "已领用"],
    ["borrowed", "借用中"],
  ] as const)("从%s状态作废时说明会清空使用人和到期日", async (status, label) => {
    cleanup();
    setup();
    api.get.mockResolvedValue(asset({ status, holder_id: 42, due_date: "2026-12-31" }));

    fireEvent.click(await screen.findByRole("tab", { name: "设备台账" }));
    fireEvent.click(await screen.findByRole("button", { name: "查看" }));
    fireEvent.click(await screen.findByRole("button", { name: "作废" }));

    const heading = await screen.findByRole("heading", { name: "确认作废设备" });
    const dialog = heading.closest('[role="dialog"]') as HTMLElement;
    expect(within(dialog).getByText(label)).toBeTruthy();
    expect(within(dialog).getByText(/清空.*使用人和到期日/)).toBeTruthy();
    expect(api.transition).not.toHaveBeenCalled();
  });

  it("维修与恢复操作仍不增加二次确认", async () => {
    cleanup();
    setup();
    api.get.mockResolvedValue(asset({ status: "available" }));

    fireEvent.click(await screen.findByRole("tab", { name: "设备台账" }));
    fireEvent.click(await screen.findByRole("button", { name: "查看" }));
    fireEvent.click(await screen.findByRole("button", { name: "送修" }));

    await waitFor(() => expect(api.transition).toHaveBeenCalledWith(1, "maintenance", { note: "" }));
    expect(screen.queryByRole("heading", { name: "确认送修设备" })).toBeNull();
  });

  it("管理员仅在后端允许时通过编号和原因二次确认永久删除", async () => {
    fireEvent.click(await screen.findByRole("tab", { name: "设备台账" }));
    fireEvent.click(await screen.findByRole("button", { name: "查看" }));

    const deleteButton = await screen.findByRole("button", { name: "删除资产" });
    expect(api.deleteCheck).toHaveBeenCalledWith(1);
    fireEvent.click(deleteButton);

    const permanentButton = screen.getByRole("button", { name: "永久删除" });
    expect((permanentButton as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("输入设备编号确认删除"), { target: { value: "EQ-001" } });
    fireEvent.change(screen.getByLabelText("删除原因"), { target: { value: "重复录入" } });
    expect((permanentButton as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(permanentButton);

    await waitFor(() => expect(api.remove).toHaveBeenCalledWith(1, { confirm_code: "EQ-001", reason: "重复录入" }));
    expect(await screen.findByText("资产 EQ-001 已永久删除")).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("管理员在有真实生命周期流水时看到警告但仍可强制删除", async () => {
    api.deleteCheck.mockResolvedValue({
      allowed: false, asset_id: 1, code: "EQ-001", event_count: 3,
      reason: "该设备已有借用、归还等业务记录，删除将永久丢失这些历史",
      protected_actions: ["borrow", "return"],
    });
    fireEvent.click(await screen.findByRole("tab", { name: "设备台账" }));
    fireEvent.click(await screen.findByRole("button", { name: "查看" }));

    expect(await screen.findByText(/该设备已有借用、归还等业务记录/)).toBeTruthy();
    const forceButton = await screen.findByRole("button", { name: "强制删除" });
    expect((forceButton as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(forceButton);

    // 强制删除仍要求编号确认 + 原因，保持二次确认防线
    const dialogTitle = await screen.findByRole("heading", { name: "强制删除资产" });
    const dialog = dialogTitle.closest('[role="dialog"]') as HTMLElement;
    const confirmButton = within(dialog).getByRole("button", { name: "强制删除" });
    expect((confirmButton as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("输入设备编号确认删除"), { target: { value: "EQ-001" } });
    fireEvent.change(screen.getByLabelText("删除原因"), { target: { value: "测试数据清理" } });
    expect((confirmButton as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(confirmButton);

    await waitFor(() => expect(api.remove).toHaveBeenCalledWith(1, { confirm_code: "EQ-001", reason: "测试数据清理" }));
    expect(await screen.findByText("资产 EQ-001 已永久删除")).toBeTruthy();
  });

  it("普通用户不显示删除入口，也不请求删除资格", async () => {
    cleanup();
    isAdmin.mockReturnValue(false);
    setup();
    fireEvent.click(await screen.findByRole("tab", { name: "设备台账" }));
    fireEvent.click(await screen.findByRole("button", { name: "查看" }));

    await waitFor(() => expect(api.get).toHaveBeenCalledWith(1));
    expect(screen.queryByText("危险操作")).toBeNull();
    expect(api.deleteCheck).not.toHaveBeenCalled();
  });
});
