import { afterEach, describe, expect, it, vi } from "vitest";
import { equipmentAssetActions, equipmentAssetsApi, type EquipmentAsset } from "./api";

describe("equipmentAssetsApi", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends ledger filters and pagination using the equipment API contract", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ total: 0, page: 2, size: 10, items: [] })));
    vi.stubGlobal("fetch", fetch);
    await equipmentAssetsApi.list({ keyword: "笔记本", category_code: "computer", status: "available", holder_id: 8, page: 2, size: 10 });
    expect(fetch.mock.calls[0][0]).toContain("/equipment-assets?keyword=%E7%AC%94%E8%AE%B0%E6%9C%AC&category_code=computer&status=available&holder_id=8&page=2&size=10");
  });

  it("uses API lifecycle routes and payloads for claim, borrow, and return", async () => {
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(new Response("{}")));
    vi.stubGlobal("fetch", fetch);
    await equipmentAssetsApi.claim(12, { note: "工位使用" });
    await equipmentAssetsApi.borrow(12, { due_date: "2026-10-01", note: "出差" });
    await equipmentAssetsApi.return(12, { note: "已归还" });
    expect(fetch.mock.calls.map(([url, init]) => [String(url).split("/api/v1").at(-1), JSON.parse((init as RequestInit).body as string)])).toEqual([
      ["/equipment-assets/12/claim", { note: "工位使用" }],
      ["/equipment-assets/12/borrow", { due_date: "2026-10-01", note: "出差" }],
      ["/equipment-assets/12/return", { note: "已归还" }],
    ]);
  });

  it("exposes batch acceptance, category maintenance, and import/export routes", async () => {
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({})))) as ReturnType<typeof vi.fn>;
    vi.stubGlobal("fetch", fetch);
    await equipmentAssetsApi.acceptBatch(5, { note: "核验完成" });
    await equipmentAssetsApi.createCategory({ code: "tool", label: "工具仪器" });
    expect(fetch.mock.calls[0][0]).toContain("/equipment-assets/batches/5/accept");
    expect(fetch.mock.calls[1][0]).toContain("/equipment-assets/categories");
    expect(equipmentAssetsApi.upload).toBeTypeOf("function");
    expect(equipmentAssetsApi.export).toBeTypeOf("function");
  });

  it("shows only allowed lifecycle actions for the role and asset state", () => {
    const asset = (status: EquipmentAsset["status"], holder_id: number | null): EquipmentAsset => ({
      id: 7, code: "EQ-2026-1", name: "电脑", category_code: "computer", serial_number: null,
      brand: null, model: null, location: null, note: null, purchase_date: null, purchase_price: null,
      status, holder_id, due_date: null, batch_id: null, created_by: 1, created_at: "", updated_at: "",
    });
    expect(equipmentAssetActions(asset("available", null), false, 2)).toMatchObject({ canClaim: true, canBorrow: true, canReturn: false });
    expect(equipmentAssetActions(asset("pending_acceptance", null), false, 2)).toMatchObject({ canClaim: false, canBorrow: false });
    expect(equipmentAssetActions(asset("borrowed", 2), false, 2).canReturn).toBe(true);
    expect(equipmentAssetActions(asset("borrowed", 3), false, 2).canReturn).toBe(false);
    expect(equipmentAssetActions(asset("claimed", 3), true, 2)).toMatchObject({ canReturn: true, canManage: true });
  });
});
