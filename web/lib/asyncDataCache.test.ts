import assert from "node:assert/strict";
import test from "node:test";
import {
  deleteAsyncDataCache,
  getAsyncDataCacheSnapshot,
  readAsyncDataCache,
  subscribeAsyncDataCache,
  writeAsyncDataCache,
} from "./asyncDataCache";

const prefix = "pm_async_data_v1:";
const key = "dashboard:summary";
const storageKey = `${prefix}${encodeURIComponent(key)}`;

function installStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  const storage = {
    get length() { return values.size; },
    getItem: (item: string) => values.get(item) ?? null,
    setItem: (item: string, value: string) => values.set(item, value),
    removeItem: (item: string) => values.delete(item),
    key: (index: number) => [...values.keys()][index] ?? null,
  };
  (globalThis as unknown as { window: { localStorage: typeof storage } }).window = {
    localStorage: storage,
  };
  return { storage, values };
}

const token = "user-session-token";
const depsKey = JSON.stringify([]);

test("cache snapshot is session-bound, dependency-bound, and time-limited", () => {
  const { storage } = installStorage();
  writeAsyncDataCache(key, depsKey, token, { items: [1, 2] });

  assert.deepEqual(readAsyncDataCache(key, depsKey, token, 60_000), { items: [1, 2] });
  assert.equal(readAsyncDataCache(key, depsKey, "another-user-token", 60_000), null);
  assert.equal(readAsyncDataCache(key, JSON.stringify([2]), token, 60_000), null);
  assert.equal(readAsyncDataCache(key, depsKey, token, 0), null);

  const saved = JSON.parse(storage.getItem(storageKey)!);
  saved.savedAt -= 60_001;
  storage.setItem(storageKey, JSON.stringify(saved));
  assert.equal(readAsyncDataCache(key, depsKey, token, 60_000), null);
});

test("malformed and oversized storage entries are treated as misses", () => {
  const { storage } = installStorage({ [storageKey]: "{broken" });
  assert.equal(readAsyncDataCache(key, depsKey, token, 60_000), null);
  storage.setItem(storageKey, "x".repeat(257 * 1024));
  assert.equal(readAsyncDataCache(key, depsKey, token, 60_000), null);
});

test("writes bound entry count and skip oversized values", () => {
  const { values } = installStorage();
  const originalNow = Date.now;
  let now = originalNow();
  Date.now = () => ++now;
  try {
    for (let index = 0; index < 9; index += 1) {
      writeAsyncDataCache(`entry-${index}`, depsKey, token, index);
    }
  } finally {
    Date.now = originalNow;
  }
  const cacheKeys = [...values.keys()].filter((entry) => entry.startsWith(prefix));
  assert.equal(cacheKeys.length, 8);
  assert.equal(values.has(`${prefix}entry-0`), false);

  writeAsyncDataCache("too-large", depsKey, token, "x".repeat(257 * 1024));
  assert.equal(values.has(`${prefix}too-large`), false);
});

test("cached external-store snapshots expire without a storage event", () => {
  const { storage } = installStorage();
  const originalNow = Date.now;
  let now = originalNow();
  Date.now = () => now;
  try {
    writeAsyncDataCache(key, depsKey, token, { value: 1 });
    expectSnapshot({ value: 1 });
    now += 60_001;
    expectSnapshot(null);
  } finally {
    Date.now = originalNow;
  }

  function expectSnapshot(expected: unknown) {
    assert.deepEqual(getAsyncDataCacheSnapshot(key, depsKey, token, 60_000)?.data ?? null, expected);
  }
});

test("same-tab updates refresh external-store subscribers and support deletion", () => {
  installStorage();
  let updates = 0;
  const unsubscribe = subscribeAsyncDataCache(key, () => { updates += 1; });
  const first = getAsyncDataCacheSnapshot<{ value: number }>(key, depsKey, token, 60_000);
  assert.equal(first, null);
  writeAsyncDataCache(key, depsKey, token, { value: 1 });
  const next = getAsyncDataCacheSnapshot<{ value: number }>(key, depsKey, token, 60_000);
  assert.deepEqual(next?.data, { value: 1 });
  assert.equal(updates, 1);
  deleteAsyncDataCache(key);
  assert.equal(readAsyncDataCache(key, depsKey, token, 60_000), null);
  assert.equal(updates, 2);
  unsubscribe();
});
