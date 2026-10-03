import assert from "node:assert/strict";
import test from "node:test";
import {
  cacheIdentity,
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
  const { storage, values } = installStorage();
  const originalGetItem = storage.getItem;
  const reads: string[] = [];
  storage.getItem = (item: string) => {
    reads.push(item);
    return originalGetItem(item);
  };
  const originalNow = Date.now;
  let now = originalNow();
  Date.now = () => ++now;
  try {
    for (let index = 0; index < 8; index += 1) {
      writeAsyncDataCache(`entry-${index}`, depsKey, token, index);
    }
    reads.length = 0;
    writeAsyncDataCache("entry-8", depsKey, token, 8);
    assert.deepEqual(reads, [`${prefix}__index__`]);
  } finally {
    Date.now = originalNow;
  }
  const cacheKeys = [...values.keys()].filter((entry) => entry.startsWith(prefix) && entry !== `${prefix}__index__`);
  assert.equal(cacheKeys.length, 8);
  assert.equal(values.has(`${prefix}entry-0`), false);

  writeAsyncDataCache("too-large", depsKey, token, "x".repeat(257 * 1024));
  assert.equal(values.has(`${prefix}too-large`), false);
});

test("miss snapshots are memoized briefly to avoid repeated storage reads and parsing", () => {
  const missKey = "snapshot-miss-memoization";
  const missStorageKey = `${prefix}${encodeURIComponent(missKey)}`;
  let reads = 0;
  const { storage } = installStorage();
  const originalGetItem = storage.getItem;
  storage.getItem = (item: string) => {
    if (item === missStorageKey) reads += 1;
    return originalGetItem(item);
  };
  const originalNow = Date.now;
  Date.now = () => 123_000;
  try {
    assert.equal(getAsyncDataCacheSnapshot(missKey, depsKey, token, 60_000), null);
    assert.equal(getAsyncDataCacheSnapshot(missKey, depsKey, token, 60_000), null);
    assert.equal(reads, 1);
  } finally {
    Date.now = originalNow;
  }
});

test("expired entries are parsed once per miss window, then can be read again", () => {
  const expiredKey = "expired-miss-window";
  const expiredStorageKey = `${prefix}${encodeURIComponent(expiredKey)}`;
  const { storage } = installStorage({
    [expiredStorageKey]: JSON.stringify({ version: 1, token, depsKey, savedAt: 1_000, data: { value: 1 } }),
  });
  const originalGetItem = storage.getItem;
  const originalNow = Date.now;
  let now = 100_000;
  let reads = 0;
  storage.getItem = (item: string) => {
    if (item === expiredStorageKey) reads += 1;
    return originalGetItem(item);
  };
  Date.now = () => now;
  try {
    for (let render = 0; render < 10; render += 1) {
      assert.equal(getAsyncDataCacheSnapshot(expiredKey, depsKey, token, 60_000), null);
    }
    assert.equal(reads, 1);
    now += 1_001;
    assert.equal(getAsyncDataCacheSnapshot(expiredKey, depsKey, token, 60_000), null);
    assert.equal(reads, 2);
    writeAsyncDataCache(expiredKey, depsKey, token, { value: 2 });
    assert.deepEqual(getAsyncDataCacheSnapshot<{ value: number }>(expiredKey, depsKey, token, 60_000)?.data, { value: 2 });
  } finally {
    Date.now = originalNow;
  }
});

test("cache identities retain the complete dependency key", () => {
  const first = cacheIdentity("projects", '["keyword-a",1]');
  const second = cacheIdentity("projects", '["keyword-b",1]');
  assert.notEqual(first.key, second.key);
  assert.equal(first.depsKey, '["keyword-a",1]');
  assert.equal(second.depsKey, '["keyword-b",1]');
});

test("module snapshot memoization stays bounded across many dependency keys", () => {
  const { storage } = installStorage();
  let reads = 0;
  const originalGetItem = storage.getItem;
  storage.getItem = (item: string) => {
    reads += 1;
    return originalGetItem(item);
  };
  for (let index = 0; index < 70; index += 1) {
    getAsyncDataCacheSnapshot(`many-key-${index}`, depsKey, token, 60_000);
  }
  const before = reads;
  getAsyncDataCacheSnapshot("many-key-0", depsKey, token, 60_000);
  assert.equal(reads, before + 1);
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
