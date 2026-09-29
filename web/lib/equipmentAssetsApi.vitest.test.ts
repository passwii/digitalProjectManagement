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

  it("checks delete eligibility and sends confirmed permanent deletion payload", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ allowed: true, asset_id: 12, code: "EQ-12", reason: null, event_count: 1, protected_actions: [] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, id: 12, code: "EQ-12" })));
    vi.stubGlobal("fetch", fetch);

    await equipmentAssetsApi.deleteCheck(12);
    await equipmentAssetsApi.remove(12, { confirm_code: "EQ-12", reason: "重复录入" });

    expect(String(fetch.mock.calls[0][0])).toContain("/equipment-assets/12/delete-check");
    expect((fetch.mock.calls[1][1] as RequestInit).method).toBe("DELETE");
    expect(JSON.parse((fetch.mock.calls[1][1] as RequestInit).body as string)).toEqual({ confirm_code: "EQ-12", reason: "重复录入" });
  });

  it("uploads a file with either a new-batch selection or an existing batch id", async () => {
    const requests: { url: string; body: FormData }[] = [];
    vi.stubGlobal("XMLHttpRequest", class {
      static latest: InstanceType<typeof this>;
      upload = {};
      status = 200;
      statusText = "";
      responseText = JSON.stringify({ batch_id: 5, batch_name: "九月入库", created: 1 });
      onload?: () => void;
      onerror?: () => void;
      onabort?: () => void;
      open(_method: string, url: string) { (this as unknown as { url: string }).url = url; }
      setRequestHeader() {}
      send(body: FormData) {
        const url = (this as unknown as { url: string }).url;
        requests.push({ url, body });
        this.onload?.();
      }
      constructor() { (this.constructor as typeof XMLHttpRequest & { latest: unknown }).latest = this; }
    });
    const file = new File(["data"], "assets.csv", { type: "text/csv" });
    await equipmentAssetsApi.upload(file, { batch_id: 5 });
    await equipmentAssetsApi.upload(file, { name: "九月入库", acceptance_status: "pending_acceptance" });

    expect(requests[0].url).toContain("/equipment-assets/import");
    expect(requests[0].body.get("batch_id")).toBe("5");
    expect(requests[0].body.get("batch_name")).toBeNull();
    expect(requests[1].body.get("batch_name")).toBe("九月入库");
    expect(requests[1].body.get("acceptance_status")).toBe("pending_acceptance");
  });

  it("exposes batch acceptance, category maintenance, and import/export routes", async () => {
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({})))) as ReturnType<typeof vi.fn>;
    vi.stubGlobal("fetch", fetch);
    await equipmentAssetsApi.acceptBatch(5, { note: "核验完成" });
    await equipmentAssetsApi.createCategory({ code: "tool", label: "工具仪器" });
    await equipmentAssetsApi.batches({ keyword: "9月", page: 2, size: 20 });
    await equipmentAssetsApi.renameBatch(5, { name: "九月入库" });
    await equipmentAssetsApi.removeBatch(6);
    await equipmentAssetsApi.inbound({ name: "新批次", items: [{ name: "电脑", category_code: "computer" }] });
    await equipmentAssetsApi.inbound({ batch_id: 5, items: [{ name: "显示器", category_code: "monitor" }] });
    expect(fetch.mock.calls[0][0]).toContain("/equipment-assets/batches/5/accept");
    expect(fetch.mock.calls[1][0]).toContain("/equipment-assets/categories");
    expect(String(fetch.mock.calls[2][0])).toContain("keyword=9%E6%9C%88&page=2&size=20");
    expect(String(fetch.mock.calls[3][0])).toContain("/equipment-assets/batches/5");
    expect(JSON.parse((fetch.mock.calls[3][1] as RequestInit).body as string)).toEqual({ name: "九月入库" });
    expect(String(fetch.mock.calls[4][0])).toContain("/equipment-assets/batches/6");
    expect((fetch.mock.calls[4][1] as RequestInit).method).toBe("DELETE");
    expect(JSON.parse((fetch.mock.calls[5][1] as RequestInit).body as string)).toMatchObject({ name: "新批次" });
    expect(JSON.parse((fetch.mock.calls[6][1] as RequestInit).body as string)).toMatchObject({ batch_id: 5 });
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
