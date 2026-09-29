// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const { api, me, users, isAdmin } = vi.hoisted(() => ({
  api: {
    overview: vi.fn(), categories: vi.fn(), batches: vi.fn(), overdue: vi.fn(), statistics: vi.fn(),
    list: vi.fn(), get: vi.fn(), events: vi.fn(), batch: vi.fn(), acceptBatch: vi.fn(),
    inbound: vi.fn(), renameBatch: vi.fn(), removeBatch: vi.fn(), claim: vi.fn(), borrow: vi.fn(), return: vi.fn(), transition: vi.fn(), update: vi.fn(),
    deleteCheck: vi.fn(), remove: vi.fn(),
    upload: vi.fn(), export: vi.fn(), createCategory: vi.fn(), updateCategory: vi.fn(), deleteCategory: vi.fn(),
  },
  me: vi.fn(),
  users: [{ id: 42, real_name: "张三" }],
  isAdmin: vi.fn(() => true),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    equipmentAssetsApi: api,
    authApi: { me },
    errText: (error: unknown) => error instanceof Error ? error.message : String(error),
    equipmentAssetActions: (asset: { status: string; holder_id: number | null }, isAdmin: boolean, currentUser?: number) => ({
      canClaim: asset.status === "available" && !isAdmin,
      canBorrow: asset.status === "available" && !isAdmin,
      canReturn: asset.status === "borrowed" && (isAdmin || asset.holder_id === currentUser),
    }),
  };
});
vi.mock("@/lib/useMeta", () => ({ useMenus: () => ({ isAdmin: isAdmin() }), useMeta: () => ({ users: [{ id: 42, real_name: "张三" }, ...users.filter((user) => user.id !== 42)] }) }));

import AssetsPage from "../app/(dashboard)/assets/page";
import { openSelect, selectOption } from "./testing/selectDriver";
import { dateValue, setDate } from "./testing/dateDriver";

const asset = (overrides: Record<string, unknown> = {}) => ({
  id: 1, code: "EQ-001", name: "测试笔记本", category_code: "computer", serial_number: null,
  brand: null, model: null, location: "A 座", note: null, purchase_date: null, purchase_price: null,
  status: "available", holder_id: null, due_date: null, batch_id: null, created_by: 1,
  created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", ...overrides,
});
const page = <T,>(items: T[], total = items.length, current = 1, size = 20) => ({ items, total, page: current, size });

function setup({ batchTotal = 1, overdueTotal = 1, batchItems }: { batchTotal?: number; overdueTotal?: number; batchItems?: Record<string, unknown>[] } = {}) {
  api.overview.mockResolvedValue({ total: 1, by_status: { available: 1 }, overdue: overdueTotal });
  api.categories.mockResolvedValue([{ code: "computer", label: "电脑", sort: 1 }]);
  api.batches.mockImplementation(async (params: { page?: number; size?: number } = {}) => page(batchItems ?? (params.page === 1 ? [{ id: 10, name: "9月设备批次", asset_count: 2, source: "采购", supplier: "供方", purchase_order_no: null, invoice_no: null, acceptance_status: "accepted" }] : [{ id: 11, name: "8月设备批次", asset_count: 0, source: "采购", supplier: "供方", purchase_order_no: null, invoice_no: null, acceptance_status: "accepted" }]), batchTotal, params.page ?? 1, params.size ?? 20));
  api.overdue.mockImplementation(async (current: number, size: number) => page(current === 1 ? [asset({ id: 20, status: "borrowed", holder_id: 42, due_date: "2026-01-01" })] : [asset({ id: 21, status: "borrowed", holder_id: 42, due_date: "2026-01-02" })], overdueTotal, current, size));
  api.statistics.mockResolvedValue({ by_category: [], by_status: [], by_month: [], by_holder: [] });
  api.list.mockResolvedValue(page([asset()]));
  api.get.mockImplementation(async (id: number) => asset({ id, holder_id: 42, status: "borrowed", due_date: "2026-12-31" }));
  api.events.mockResolvedValue({ items: [] });
  api.deleteCheck.mockResolvedValue({ allowed: true, asset_id: 1, code: "EQ-001", reason: null, event_count: 1, protected_actions: [] });
  api.remove.mockResolvedValue({ ok: true, id: 1, code: "EQ-001" });
  api.batch.mockResolvedValue({ id: 10, name: "9月设备批次", asset_count: 1, acceptance_status: "accepted", items: [asset()] });
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
  it("保留分区标题与批次搜索，同时隐藏复述列表用途的说明", async () => {
    fireEvent.click(await screen.findByRole("tab", { name: "入库批次" }));

    expect(screen.getByRole("heading", { name: "入库批次" })).toBeTruthy();
    expect(screen.getByLabelText("搜索批次列表")).toBeTruthy();
    expect(screen.queryByText("按名称查找批次，查看设备数量、来源、验收情况和设备明细")).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "逾期借用" }));
    expect(screen.getByRole("heading", { name: "逾期借用" })).toBeTruthy();
    expect(screen.queryByText("仅展示超过归还日期的设备")).toBeNull();
  });

  it("使用项目详情页共享标签控件并同步移动端分区选择", async () => {
    // 移动端分区选择器是自绘下拉（MotionTabs 内部的 Select），不能对原生 select 做 change
    selectOption("选择页面分区", "设备台账");

    expect(screen.getByRole("tab", { name: "设备台账" }).getAttribute("aria-selected")).toBe("true");
    expect(await screen.findByPlaceholderText("编号、名称、序列号…")).toBeTruthy();
  });

  it("批次与逾期分别按服务端 total/page/size 翻页，并保持每页不超过 100", async () => {
    cleanup();
    setup({ batchTotal: 101, overdueTotal: 101 });
    fireEvent.click(await screen.findByRole("tab", { name: "入库批次" }));
    expect(await screen.findByText("9月设备批次 · 批次 #10")).toBeTruthy();
    expect(document.querySelector(".asset-pagination span")?.textContent).toBe("第 1 页 · 共 101 批");
    fireEvent.click(screen.getByRole("button", { name: "下一页批次" }));
    expect(await screen.findByText("8月设备批次 · 批次 #11")).toBeTruthy();
    await waitFor(() => expect(api.batches).toHaveBeenLastCalledWith({ keyword: "", page: 2, size: 100 }, expect.any(AbortSignal)));

    fireEvent.click(screen.getByRole("tab", { name: "逾期借用" }));
    expect(document.querySelector(".asset-pagination span")?.textContent).toBe("第 1 页 · 共 101 件");
    fireEvent.click(screen.getByRole("button", { name: "下一页逾期" }));
    await waitFor(() => expect(api.overdue).toHaveBeenLastCalledWith(2, 100, expect.any(AbortSignal)));
  });

  it("导入台账时选择已有批次并将整份文件上传到该批次", async () => {
    cleanup();
    setup();
    api.upload.mockResolvedValue({ batch_id: 10, batch_name: "9月设备批次", created: 2 });
    fireEvent.click(await screen.findByRole("button", { name: "导入台账" }));
    selectOption("导入批次方式", "加入已有批次");
    fireEvent.change(screen.getByLabelText("搜索导入目标批次"), { target: { value: "9月" } });
    const batchListbox = openSelect("选择导入批次");
    await waitFor(() => expect(within(batchListbox).getByRole("option", { name: /9月设备批次 · 批次 #10/ })).toBeTruthy());
    fireEvent.click(within(batchListbox).getByRole("option", { name: /9月设备批次 · 批次 #10/ }));
    const file = new File(["设备名称,设备分类\n电脑,电脑"], "devices.csv", { type: "text/csv" });
    fireEvent.change(screen.getByLabelText("选择 CSV 或 Excel 台账文件"), { target: { files: [file] } });

    await waitFor(() => expect(api.upload).toHaveBeenCalledWith(file, { batch_id: 10 }));
  });

  it("导入时可新建自定义批次并将文件名作为默认来源", async () => {
    cleanup();
    setup();
    api.upload.mockResolvedValue({ batch_id: 12, batch_name: "导入批次9月", created: 1 });
    fireEvent.click(await screen.findByRole("button", { name: "导入台账" }));
    fireEvent.change(screen.getByLabelText("导入新批次名称"), { target: { value: "导入批次9月" } });
    const file = new File(["设备名称,设备分类\n电脑,电脑"], "设备清单.csv", { type: "text/csv" });
    fireEvent.change(screen.getByLabelText("选择 CSV 或 Excel 台账文件"), { target: { files: [file] } });

    await waitFor(() => expect(api.upload).toHaveBeenCalledWith(file, {
      name: "导入批次9月", source: "导入 设备清单.csv", supplier: "", purchase_order_no: "",
      invoice_no: "", acceptance_status: "accepted", note: "",
    }));
  });

  it("重命名成功后关闭对话框并在列表显示新名称", async () => {
    cleanup();
    let batchName = "旧批次名称";
    setup({ batchTotal: 1, batchItems: [
      { id: 10, name: "旧批次名称", asset_count: 0, source: "", supplier: "", acceptance_status: "accepted" },
    ] });
    api.renameBatch.mockImplementation(async (_id: number, body: { name: string }) => {
      batchName = body.name;
      return { id: 10, name: body.name, asset_count: 0, acceptance_status: "accepted" };
    });
    api.batches.mockImplementation(async (params: { page?: number; size?: number } = {}) => page([
      { id: 10, name: batchName, asset_count: 0, source: "", supplier: "", acceptance_status: "accepted" },
    ], 1, params.page ?? 1, params.size ?? 100));
    fireEvent.click(await screen.findByRole("tab", { name: "入库批次" }));
    expect(await screen.findByText("旧批次名称 · 批次 #10")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "重命名" }));
    fireEvent.change(screen.getByLabelText("修改批次名称"), { target: { value: "新批次名称" } });
    fireEvent.click(screen.getByRole("button", { name: "保存名称" }));
    await waitFor(() => expect(api.renameBatch).toHaveBeenCalledWith(10, { name: "新批次名称" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await screen.findByText("新批次名称 · 批次 #10")).toBeTruthy();
  });

  it("重命名名称冲突时在对话框内显示错误", async () => {
    cleanup();
    setup({ batchItems: [
      { id: 10, name: "旧批次名称", asset_count: 0, source: "", supplier: "", acceptance_status: "accepted" },
    ] });
    api.renameBatch.mockRejectedValue(new Error("批次名称已存在，请选择已有批次或更换名称"));
    fireEvent.click(await screen.findByRole("tab", { name: "入库批次" }));
    fireEvent.click(await screen.findByRole("button", { name: "重命名" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("修改批次名称"), { target: { value: "重复名称" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存名称" }));
    await waitFor(() => expect(api.renameBatch).toHaveBeenCalledWith(10, { name: "重复名称" }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain("批次名称已存在");
  });

  it("批次列表显示名称和设备数，并对空批次提供重命名与确认删除", async () => {
    cleanup();
    setup({ batchTotal: 2, batchItems: [
      { id: 10, name: "9月设备批次", asset_count: 2, source: "采购", supplier: "供方", acceptance_status: "accepted" },
      { id: 11, name: "空批次", asset_count: 0, source: "调拨", supplier: "", acceptance_status: "accepted" },
    ] });
    api.renameBatch.mockResolvedValue({ id: 11, name: "已更名批次", asset_count: 0, acceptance_status: "accepted" });
    api.removeBatch.mockResolvedValue({ ok: true, id: 11 });
    fireEvent.click(await screen.findByRole("tab", { name: "入库批次" }));
    expect(await screen.findByText("9月设备批次 · 批次 #10")).toBeTruthy();
    expect(screen.getByText(/2 件设备/)).toBeTruthy();
    expect(screen.getAllByRole("article")[1].textContent).toContain("空批次");

    fireEvent.click(screen.getAllByRole("button", { name: "重命名" })[1]);
    fireEvent.change(screen.getByLabelText("修改批次名称"), { target: { value: "已更名批次" } });
    fireEvent.click(screen.getByRole("button", { name: "保存名称" }));
    await waitFor(() => expect(api.renameBatch).toHaveBeenCalledWith(11, { name: "已更名批次" }));

    fireEvent.click(screen.getByRole("button", { name: "删除空批次" }));
    expect(await screen.findByRole("heading", { name: "删除空批次" })).toBeTruthy();
    const dialogs = screen.getAllByRole("dialog");
    fireEvent.click(within(dialogs[dialogs.length - 1]).getByRole("button", { name: "取消" }));
    expect(api.removeBatch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "删除空批次" }));
    fireEvent.click(await screen.findByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(api.removeBatch).toHaveBeenCalledWith(11));
  });

  it("删除空批次遇到遗留流水冲突时在确认对话框内显示错误", async () => {
    cleanup();
    setup({ batchTotal: 1, batchItems: [
      { id: 10, name: "有遗留流水", asset_count: 0, source: "", supplier: "", acceptance_status: "accepted" },
    ] });
    api.removeBatch.mockRejectedValue(new Error("批次仍有关联设备或流水，不能删除"));
    fireEvent.click(await screen.findByRole("tab", { name: "入库批次" }));
    fireEvent.click(await screen.findByRole("button", { name: "删除空批次" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(api.removeBatch).toHaveBeenCalledWith(10));
    expect((await within(dialog).findByRole("alert")).textContent).toContain("仍有关联设备或流水");
  });

  it("入库表单可选择已有批次并将单件或多件设备加入该批次", async () => {
    cleanup();
    setup();
    fireEvent.click(await screen.findByRole("tab", { name: "入库" }));
    selectOption("批次录入方式", "加入已有批次");

    fireEvent.change(screen.getByLabelText("搜索并选择已有批次"), { target: { value: "9月设备" } });
    const firstBatchListbox = openSelect("选择入库批次");
    await waitFor(() => expect(within(firstBatchListbox).getByRole("option", { name: /9月设备批次 · 批次 #10/ })).toBeTruthy());
    fireEvent.click(within(firstBatchListbox).getByRole("option", { name: /9月设备批次 · 批次 #10/ }));
    fireEvent.change(screen.getByLabelText("搜索并选择已有批次"), { target: { value: "其他批次" } });
    expect(screen.getByRole("button", { name: "登记 1 件设备" }).hasAttribute("disabled")).toBe(true);
    fireEvent.change(screen.getByLabelText("搜索并选择已有批次"), { target: { value: "9月设备" } });
    const secondBatchListbox = openSelect("选择入库批次");
    await waitFor(() => expect(within(secondBatchListbox).getByRole("option", { name: /9月设备批次 · 批次 #10/ })).toBeTruthy());
    fireEvent.click(within(secondBatchListbox).getByRole("option", { name: /9月设备批次 · 批次 #10/ }));
    fireEvent.change(screen.getByLabelText("设备件数"), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText("名称", { selector: "input" }), { target: { value: "新设备" } });
    fireEvent.click(screen.getByRole("button", { name: "登记 1 件设备" }));

    await waitFor(() => expect(api.inbound).toHaveBeenCalledWith({ batch_id: 10, items: [expect.objectContaining({ name: "新设备" })] }));
  });

  it("新建批次后立即刷新已有批次选择器，可继续选择刚建批次", async () => {
    cleanup();
    setup();
    let created = false;
    api.inbound.mockImplementation(async (body: { name?: string }) => {
      created = true;
      return { id: 12, batch_id: 12, name: body.name, batch_name: body.name, asset_count: 1, acceptance_status: "accepted", items: [] };
    });
    api.batches.mockImplementation(async (params: { page?: number; size?: number; keyword?: string } = {}) => page(
      created ? [{ id: 12, name: "刚创建批次", asset_count: 1, source: "采购", acceptance_status: "accepted" }] : [],
      created ? 1 : 0, params.page ?? 1, params.size ?? 20,
    ));

    fireEvent.click(await screen.findByRole("tab", { name: "入库" }));
    fireEvent.change(screen.getByLabelText("新批次名称"), { target: { value: "刚创建批次" } });
    fireEvent.change(screen.getByLabelText("名称", { selector: "input" }), { target: { value: "第一台" } });
    fireEvent.click(screen.getByRole("button", { name: "登记 1 件设备" }));
    await waitFor(() => expect(api.inbound).toHaveBeenCalled());

    selectOption("批次录入方式", "加入已有批次");
    fireEvent.change(screen.getByLabelText("搜索并选择已有批次"), { target: { value: "刚创建" } });
    const refreshedBatchListbox = openSelect("选择入库批次");
    await waitFor(() => expect(within(refreshedBatchListbox).getByRole("option", { name: /刚创建批次 · 批次 #12/ })).toBeTruthy());
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
    setDate("借用到期日", "2026-12-31");
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
    fireEvent.click(within(dialog).getByRole("button", { name: "关闭" }));
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

  it("送修与恢复可用仍直接执行，不增加二次确认", async () => {
    cleanup();
    setup();
    let status = "available";
    api.get.mockImplementation(async () => asset({ status }));
    api.transition.mockImplementation(async (_id: number, action: string) => {
      status = action === "maintenance" ? "maintenance" : action === "restore" ? "available" : status;
    });

    fireEvent.click(await screen.findByRole("tab", { name: "设备台账" }));
    fireEvent.click(await screen.findByRole("button", { name: "查看" }));
    fireEvent.click(await screen.findByRole("button", { name: "送修" }));

    await waitFor(() => expect(api.transition).toHaveBeenCalledWith(1, "maintenance", { note: "" }));
    expect(await screen.findByRole("button", { name: "恢复可用" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "确认送修设备" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "恢复可用" }));
    await waitFor(() => expect(api.transition).toHaveBeenLastCalledWith(1, "restore", { note: "" }));
    expect(screen.queryByRole("heading", { name: "确认恢复可用设备" })).toBeNull();
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

/*
 * 入库表单是全站唯一一处「非受控原生 form + FormData」的地方，也是 DatePicker
 * 唯一依赖 `name` 隐藏域的调用点。触发器是 button，不参与原生提交，所以这条路径
 * 必须单独钉住 —— 否则 hidden 里写错值（比如写成展示文案「2026 年 9 月 18 日」）
 * 不会有任何测试报警，后端只会收到一个解析不了的日期。
 */
describe("入库表单的购置日期随 FormData 提交", () => {
  it("提交的是 ISO 原值，不是 DatePicker 展示用的中文文案", async () => {
    api.inbound.mockResolvedValue({ id: 10, acceptance_status: "accepted", items: [asset()] });
    selectOption("选择页面分区", "入库");
    fireEvent.change(screen.getByLabelText("新批次名称"), { target: { value: "日期回归批次" } });
    fireEvent.change((await screen.findByText("登记设备入库")).closest("form")!.querySelector("input[name=\"name-0\"]")!, { target: { value: "测试笔记本" } });
    setDate("设备 1 购置日期", "2026-09-18");
    expect(dateValue("设备 1 购置日期")).toBe("2026-09-18");

    fireEvent.click(screen.getByRole("button", { name: "登记 1 件设备" }));
    await waitFor(() => expect(api.inbound).toHaveBeenCalledOnce());
    expect(api.inbound.mock.calls[0][0]).toMatchObject({
      items: [{ name: "测试笔记本", purchase_date: "2026-09-18" }],
    });
  });

  it("没选日期时 purchase_date 为 undefined，而不是空串", async () => {
    api.inbound.mockResolvedValue({ id: 10, acceptance_status: "accepted", items: [asset()] });
    selectOption("选择页面分区", "入库");
    fireEvent.change(screen.getByLabelText("新批次名称"), { target: { value: "空日期回归批次" } });
    fireEvent.change((await screen.findByText("登记设备入库")).closest("form")!.querySelector("input[name=\"name-0\"]")!, { target: { value: "测试笔记本" } });

    fireEvent.click(screen.getByRole("button", { name: "登记 1 件设备" }));
    await waitFor(() => expect(api.inbound).toHaveBeenCalledOnce());
    expect(api.inbound.mock.calls[0][0].items[0].purchase_date).toBeUndefined();
  });
});

describe("设备流水中文展示", () => {
  const ACTION_CASES: [string, string][] = [
    ["create", "建档"], ["inbound", "入库"], ["import", "批量导入"], ["acceptance", "验收通过"],
    ["update", "档案更新"], ["claim", "领用"], ["borrow", "借用"], ["return", "归还"],
    ["maintenance", "送修"], ["restore", "恢复可用"], ["scrap", "报废"], ["void", "作废"],
  ];

  const event = (id: number, action: string) => ({
    id, asset_id: 1, batch_id: 10, action, from_status: null, to_status: null,
    actor_id: 42, holder_id: null, due_date: null, note: null, created_at: "2026-01-01T00:00:00Z",
  });

  it("后端写入的每个 action 都渲染为中文，不把英文值直接暴露给用户", async () => {
    api.events.mockResolvedValue(page(ACTION_CASES.map(([action], index) => event(index + 1, action))));
    fireEvent.click(await screen.findByRole("tab", { name: "设备台账" }));
    fireEvent.click(await screen.findByRole("button", { name: "查看" }));

    const list = (await screen.findByText("设备流水")).closest("section") as HTMLElement;
    for (const [action, label] of ACTION_CASES) {
      expect(within(list).getByText(label), `action=${action} 应显示为「${label}」`).toBeTruthy();
    }
    // 流水区里不能再出现任何一个后端英文 action 值
    for (const [action] of ACTION_CASES) {
      expect(within(list).queryByText(action), `不应残留英文 ${action}`).toBeNull();
    }
  });

  it("未知 action 保留原值兜底，不显示成空白", async () => {
    api.events.mockResolvedValue(page([event(1, "future_action")]));
    fireEvent.click(await screen.findByRole("tab", { name: "设备台账" }));
    fireEvent.click(await screen.findByRole("button", { name: "查看" }));

    expect(await screen.findByText("future_action")).toBeTruthy();
  });

  it("状态流转与动作一起以中文呈现", async () => {
    api.events.mockResolvedValue(page([{
      ...event(1, "claim"), from_status: "available", to_status: "claimed",
    }]));
    fireEvent.click(await screen.findByRole("tab", { name: "设备台账" }));
    fireEvent.click(await screen.findByRole("button", { name: "查看" }));

    expect(await screen.findByText("领用")).toBeTruthy();
    expect(await screen.findByText("可用 → 已领用")).toBeTruthy();
  });
});
