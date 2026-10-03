// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  users: vi.fn(),
  depts: vi.fn(),
}));

vi.mock("./api", async () => {
  const actual = await vi.importActual<typeof import("./api")>("./api");
  return {
    ...actual,
    metaApi: {
      ...actual.metaApi,
      users: mocks.users,
      depts: mocks.depts,
    },
  };
});

import { HttpError, type Dept, type UserOption } from "./api";
import { cacheIdentity, readAsyncDataCache, writeAsyncDataCache } from "./asyncDataCache";
import { clearMetaCache, loadMeta, useMeta } from "./useMeta";

const token = "meta-test-session";
const metaCache = cacheIdentity("metadata:users-departments", JSON.stringify([]));
const staleUser: UserOption = {
  id: 1,
  username: "stale",
  real_name: "旧快照用户",
  dept_id: null,
  status: "active",
  roles: [],
};
const freshUser: UserOption = { ...staleUser, id: 2, username: "fresh", real_name: "新用户" };
const otherUser: UserOption = { ...staleUser, id: 3, username: "other", real_name: "另一账号" };
const emptyDepts: Dept[] = [];

function installStorage() {
  const values = new Map<string, string>();
  const storage = {
    get length() { return values.size; },
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, String(value)),
    removeItem: (key: string) => values.delete(key),
    key: (index: number) => [...values.keys()][index] ?? null,
  };
  Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
  return storage;
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function seedSnapshot(user: UserOption = staleUser) {
  writeAsyncDataCache(metaCache.key, metaCache.depsKey, token, { users: [user], depts: emptyDepts });
}

beforeEach(() => {
  installStorage();
  localStorage.setItem("pm_access_token", token);
  mocks.users.mockReset().mockResolvedValue([freshUser]);
  mocks.depts.mockReset().mockResolvedValue(emptyDepts);
  clearMetaCache();
});

afterEach(() => {
  cleanup();
  clearMetaCache();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("元数据快照回退与会话边界", () => {
  it("临时 5xx 只短暂回退到快照，之后允许重新请求", async () => {
    vi.useFakeTimers();
    seedSnapshot();
    mocks.users.mockRejectedValueOnce(new HttpError(503, "暂时不可用"));

    const initial = await loadMeta();
    expect(initial.users[0]?.real_name).toBe("旧快照用户");
    await flushPromises();
    expect(readAsyncDataCache<{ users: UserOption[] }>(metaCache.key, metaCache.depsKey, token, 5 * 60_000)?.users[0]?.real_name)
      .toBe("旧快照用户");

    const duringBackoff = await loadMeta();
    expect(duringBackoff.users[0]?.real_name).toBe("旧快照用户");
    expect(mocks.users).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(15_001);
    mocks.users.mockResolvedValueOnce([freshUser]);
    const staleWhileRefreshing = await loadMeta();
    expect(staleWhileRefreshing.users[0]?.real_name).toBe("旧快照用户");
    await flushPromises();
    expect((await loadMeta()).users[0]?.real_name).toBe("新用户");
    expect(mocks.users).toHaveBeenCalledTimes(2);
  });

  it.each([408, 425, 429, 500, 599])("HTTP %i 允许短暂保留快照", async (status) => {
    seedSnapshot();
    mocks.users.mockRejectedValue(new HttpError(status, "临时失败"));
    await loadMeta();
    await flushPromises();
    expect((await loadMeta()).users[0]?.real_name).toBe("旧快照用户");
    expect(mocks.users).toHaveBeenCalledTimes(1);
  });

  it("NetworkError 允许短暂保留快照", async () => {
    seedSnapshot();
    mocks.users.mockRejectedValue(Object.assign(new Error("断网"), { name: "NetworkError" }));
    await loadMeta();
    await flushPromises();
    expect((await loadMeta()).users[0]?.real_name).toBe("旧快照用户");
    expect(mocks.users).toHaveBeenCalledTimes(1);
  });

  it.each([400, 401, 403, 404, 422])("HTTP %i 不保留旧字典快照", async (status) => {
    seedSnapshot();
    mocks.users.mockRejectedValue(new HttpError(status, "拒绝访问"));

    expect((await loadMeta()).users[0]?.real_name).toBe("旧快照用户");
    await flushPromises();
    expect(readAsyncDataCache(metaCache.key, metaCache.depsKey, token, 5 * 60_000)).toBeNull();

    await expect(loadMeta()).rejects.toMatchObject({ status });
    expect(mocks.users).toHaveBeenCalledTimes(2);
  });

  it.each([401, 403])("HTTP %i 清掉已挂载 hook 中展示的快照", async (status) => {
    seedSnapshot();
    let rejectRequest!: (error: unknown) => void;
    mocks.users.mockImplementationOnce(() => new Promise<UserOption[]>((_, reject) => { rejectRequest = reject; }));
    const { result } = renderHook(() => useMeta());
    await waitFor(() => expect(result.current.users[0]?.real_name).toBe("旧快照用户"));
    await act(async () => {
      rejectRequest(new HttpError(status, "拒绝访问"));
      await flushPromises();
    });
    expect(result.current.users).toEqual([]);
    expect(readAsyncDataCache(metaCache.key, metaCache.depsKey, token, 5 * 60_000)).toBeNull();
  });

  it("旧会话在新账号请求完成后返回也不能覆盖字典", async () => {
    let resolveOld!: (users: UserOption[]) => void;
    mocks.users.mockImplementationOnce(() => new Promise<UserOption[]>((resolve) => { resolveOld = resolve; }));
    const oldRequest = loadMeta();
    localStorage.setItem("pm_access_token", "replacement-session");
    mocks.users.mockResolvedValueOnce([otherUser]);
    await loadMeta();
    resolveOld([staleUser]);
    await expect(oldRequest).resolves.toEqual({ users: [], depts: [] });
    expect((await loadMeta()).users[0]?.real_name).toBe("另一账号");
    expect(readAsyncDataCache<{ users: UserOption[] }>(metaCache.key, metaCache.depsKey, "replacement-session", 5 * 60_000)?.users[0]?.real_name)
      .toBe("另一账号");
  });

  it("登出换账号后旧会话的在途响应不会覆盖新账号字典", async () => {
    let resolveOld!: (users: UserOption[]) => void;
    let resolveCurrent!: (users: UserOption[]) => void;
    mocks.users
      .mockImplementationOnce(() => new Promise<UserOption[]>((resolve) => { resolveOld = resolve; }))
      .mockImplementationOnce(() => new Promise<UserOption[]>((resolve) => { resolveCurrent = resolve; }));

    const oldRequest = loadMeta();
    localStorage.setItem("pm_access_token", "replacement-session");
    const currentRequest = loadMeta();

    resolveOld([staleUser]);
    await expect(oldRequest).resolves.toEqual({ users: [], depts: [] });
    resolveCurrent([otherUser]);
    await expect(currentRequest).resolves.toMatchObject({ users: [{ real_name: "另一账号" }] });
    expect((await loadMeta()).users[0]?.real_name).toBe("另一账号");
  });
});
