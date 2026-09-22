// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  options: vi.fn(),
}));

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    projectsApi: {
      ...actual.projectsApi,
      get: mocks.get,
      options: mocks.options,
    },
  };
});

vi.mock("@/lib/useAsyncData", () => ({
  useAsyncData: () => ({
    data: { items: [], total: 0 },
    loading: false,
    firstLoad: false,
    error: "",
    reload: vi.fn(),
    setData: vi.fn(),
  }),
}));

vi.mock("@/lib/useDebouncedValue", () => ({
  useDebouncedValue: (value: string) => value,
}));

import ProjectPicker from "../components/ui/ProjectPicker";
import { HttpError } from "./api";

const STORAGE_KEY = "pm_recent_projects_v1";

function seedRecent(projects: Array<{ id: number; code: string; name: string }>) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(projects));
}

function installStorage() {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
  };
  Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
}

function openPicker() {
  fireEvent.click(screen.getByRole("button", { name: "选择项目" }));
}

beforeEach(() => {
  installStorage();
  mocks.get.mockReset();
  mocks.options.mockReset();
  mocks.options.mockResolvedValue({ items: [], total: 0 });
});

afterEach(() => {
  cleanup();
});

describe("项目选择器 Recent 服务端校验", () => {
  it("使用项目详情接口返回的最新编号和名称更新列表与本地快照", async () => {
    seedRecent([{ id: 12, code: "PJ-OLD-001", name: "项目旧名称" }]);
    mocks.get.mockResolvedValue({ id: 12, code: "SHZK-NEW-001", name: "项目新名称" });

    render(<ProjectPicker value="" onChange={() => {}} />);
    openPicker();

    await waitFor(() => {
      expect(screen.getByText("SHZK-NEW-001")).toBeTruthy();
      expect(screen.getByText("项目新名称")).toBeTruthy();
    });

    expect(screen.queryByText("PJ-OLD-001")).toBeNull();
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null")).toEqual([
      { id: 12, code: "SHZK-NEW-001", name: "项目新名称" },
    ]);
    expect(mocks.get).toHaveBeenCalledWith(12, expect.any(AbortSignal));
  });

  it("项目已删除或无权访问时，从 Recent 列表和快照中移除", async () => {
    seedRecent([{ id: 12, code: "PJ-OLD-001", name: "项目旧名称" }]);
    mocks.get.mockRejectedValue(new HttpError(404, "项目不存在"));

    render(<ProjectPicker value="" onChange={() => {}} />);
    openPicker();

    await waitFor(() => expect(screen.getByText(/没有匹配/)).toBeTruthy());

    expect(screen.queryByText("PJ-OLD-001")).toBeNull();
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("[]");
  });

  it("临时网络失败时保留旧 Recent 记录，避免误删", async () => {
    const stored = { id: 12, code: "PJ-OLD-001", name: "项目旧名称" };
    seedRecent([stored]);
    mocks.get.mockRejectedValue(new Error("network unavailable"));

    render(<ProjectPicker value="" onChange={() => {}} />);
    openPicker();

    await waitFor(() => expect(screen.getByText("PJ-OLD-001")).toBeTruthy());
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null")).toEqual([stored]);
  });
});
