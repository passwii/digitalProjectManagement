"use client";

const STORAGE_PREFIX = "pm_async_data_v1:";
const MAX_CACHE_CHARS = 256 * 1024;
const MAX_CACHE_ENTRIES = 8;
const MAX_SNAPSHOT_ENTRIES = 64;
const CACHE_MISS_TTL_MS = 1_000;
const STORAGE_INDEX_KEY = `${STORAGE_PREFIX}__index__`;

interface StoredAsyncData {
  version: 1;
  token: string;
  depsKey: string;
  savedAt: number;
  data: unknown;
}

export interface AsyncDataCacheSnapshot<T> {
  data: T;
}

type CacheStorage = {
  length: number;
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
  key: (index: number) => string | null;
};

type CacheWindow = {
  localStorage?: CacheStorage;
  addEventListener?: (type: string, listener: (event: Event) => void) => void;
  removeEventListener?: (type: string, listener: (event: Event) => void) => void;
};

const snapshots = new Map<string, {
  signature: string;
  expiresAt: number;
  value: AsyncDataCacheSnapshot<unknown> | null;
}>();
const listeners = new Map<string, Set<() => void>>();

/** Keep the complete dependency key so distinct requests cannot collide. */
export function cacheIdentity(key: string, depsKey: string): { key: string; depsKey: string } {
  return { key: `${key}:${depsKey}`, depsKey };
}

function storageKey(key: string): string {
  return `${STORAGE_PREFIX}${encodeURIComponent(key)}`;
}

function storage(): CacheStorage | null {
  try {
    return (globalThis as typeof globalThis & { window?: CacheWindow }).window?.localStorage ?? null;
  } catch {
    return null;
  }
}

function notify(key: string): void {
  snapshots.delete(key);
  listeners.get(key)?.forEach((listener) => listener());
}

function setSnapshot(
  key: string,
  snapshot: { signature: string; expiresAt: number; value: AsyncDataCacheSnapshot<unknown> | null },
): void {
  const now = Date.now();
  snapshots.forEach((cached, cachedKey) => {
    if (cached.expiresAt < now) snapshots.delete(cachedKey);
  });
  snapshots.delete(key);
  while (snapshots.size >= MAX_SNAPSHOT_ENTRIES) {
    const oldestKey = snapshots.keys().next().value as string | undefined;
    if (oldestKey === undefined) break;
    snapshots.delete(oldestKey);
  }
  snapshots.set(key, snapshot);
}

function readCacheIndex(localStorage: CacheStorage): Record<string, number> | null {
  try {
    const raw = localStorage.getItem(STORAGE_INDEX_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return Object.fromEntries(
      Object.entries(parsed).filter(([key, savedAt]) =>
        key.startsWith(STORAGE_PREFIX) && key !== STORAGE_INDEX_KEY && typeof savedAt === "number" && Number.isFinite(savedAt),
      ),
    );
  } catch {
    return null;
  }
}

/** One-time migration for caches written before the small savedAt index existed. */
function rebuildCacheIndex(localStorage: CacheStorage): Record<string, number> {
  const index: Record<string, number> = {};
  for (let position = 0; position < localStorage.length; position += 1) {
    const key = localStorage.key(position);
    if (!key?.startsWith(STORAGE_PREFIX) || key === STORAGE_INDEX_KEY) continue;
    try {
      const entry = JSON.parse(localStorage.getItem(key) ?? "null") as Partial<StoredAsyncData> | null;
      if (typeof entry?.savedAt === "number" && Number.isFinite(entry.savedAt)) index[key] = entry.savedAt;
    } catch {
      index[key] = 0;
    }
  }
  return index;
}

function updateCacheIndex(localStorage: CacheStorage, key: string, savedAt?: number): void {
  const index = readCacheIndex(localStorage) ?? rebuildCacheIndex(localStorage);
  if (savedAt === undefined) delete index[key];
  else index[key] = savedAt;

  const entries = Object.entries(index);
  if (entries.length > MAX_CACHE_ENTRIES) {
    entries.sort((left, right) => left[1] - right[1]);
    for (const [expiredKey] of entries.slice(0, entries.length - MAX_CACHE_ENTRIES)) {
      localStorage.removeItem(expiredKey);
      delete index[expiredKey];
      notify(expiredKey);
    }
  }
  localStorage.setItem(STORAGE_INDEX_KEY, JSON.stringify(index));
}

function parseEntry(
  raw: string | null,
  depsKey: string,
  token: string | null,
  maxAgeMs: number,
): StoredAsyncData | null {
  if (!raw || raw.length > MAX_CACHE_CHARS || !token || maxAgeMs <= 0) return null;
  try {
    const entry = JSON.parse(raw) as Partial<StoredAsyncData> | null;
    const now = Date.now();
    if (
      !entry ||
      entry.version !== 1 ||
      entry.token !== token ||
      entry.depsKey !== depsKey ||
      typeof entry.savedAt !== "number" ||
      now - entry.savedAt < 0 ||
      now - entry.savedAt > maxAgeMs ||
      !Object.hasOwn(entry, "data")
    ) {
      return null;
    }
    return entry as StoredAsyncData;
  } catch {
    return null;
  }
}

/** Read a short-lived, session-bound display snapshot. Invalid data is a cache miss. */
export function readAsyncDataCache<T>(
  key: string,
  depsKey: string,
  token: string | null,
  maxAgeMs: number,
): T | null {
  const localStorage = storage();
  if (!localStorage || !token) return null;
  try {
    const entry = parseEntry(localStorage.getItem(storageKey(key)), depsKey, token, maxAgeMs);
    return entry ? (entry.data as T) : null;
  } catch {
    return null;
  }
}

/** Persist a bounded JSON display snapshot; quota/private-mode errors are ignored. */
export function writeAsyncDataCache<T>(
  key: string,
  depsKey: string,
  token: string | null,
  data: T,
): void {
  const localStorage = storage();
  if (!localStorage || !token) return;
  const itemKey = storageKey(key);
  try {
    const candidate: StoredAsyncData = {
      version: 1,
      token,
      depsKey,
      savedAt: Date.now(),
      data,
    };
    const serialized = JSON.stringify(candidate);
    if (serialized.length > MAX_CACHE_CHARS) {
      localStorage.removeItem(itemKey);
      updateCacheIndex(localStorage, itemKey);
      notify(itemKey);
      return;
    }
    localStorage.setItem(itemKey, serialized);
    updateCacheIndex(localStorage, itemKey, candidate.savedAt);
    notify(itemKey);
  } catch {
    // Storage can be disabled or full; the network remains the source of truth.
  }
}

export function deleteAsyncDataCache(key: string): void {
  const localStorage = storage();
  const itemKey = storageKey(key);
  try {
    localStorage?.removeItem(itemKey);
    if (localStorage) updateCacheIndex(localStorage, itemKey);
  } catch {
    // Cache deletion should not affect the caller's state update.
  }
  notify(itemKey);
}

/** Stable external-store snapshot for hydration-safe local cache restoration. */
export function getAsyncDataCacheSnapshot<T>(
  key: string,
  depsKey: string,
  token: string | null,
  maxAgeMs: number,
): AsyncDataCacheSnapshot<T> | null {
  const localStorage = storage();
  if (!localStorage || !token || maxAgeMs <= 0) return null;
  const itemKey = storageKey(key);
  const signature = `${depsKey}\u0000${token}\u0000${maxAgeMs}`;
  const now = Date.now();
  const existing = snapshots.get(itemKey);
  if (existing?.signature === signature && existing.expiresAt >= now) {
    return existing.value as AsyncDataCacheSnapshot<T> | null;
  }
  let value: AsyncDataCacheSnapshot<T> | null = null;
  let expiresAt = now + CACHE_MISS_TTL_MS;
  try {
    const entry = parseEntry(localStorage.getItem(itemKey), depsKey, token, maxAgeMs);
    if (entry) {
      value = { data: entry.data as T };
      expiresAt = entry.savedAt + maxAgeMs;
    }
  } catch {
    // A storage read failure is simply a miss.
  }
  setSnapshot(itemKey, { signature, expiresAt, value });
  return value;
}

export function subscribeAsyncDataCache(key: string, listener: () => void): () => void {
  const itemKey = storageKey(key);
  const subscribers = listeners.get(itemKey) ?? new Set<() => void>();
  subscribers.add(listener);
  listeners.set(itemKey, subscribers);
  const browser = (globalThis as typeof globalThis & { window?: CacheWindow }).window;
  const onStorage = (rawEvent: Event) => {
    const event = rawEvent as StorageEvent;
    if (event.key !== itemKey && event.key !== "pm_access_token") return;
    snapshots.delete(itemKey);
    listener();
  };
  const onSessionEvent = () => {
    snapshots.delete(itemKey);
    listener();
  };
  browser?.addEventListener?.("storage", onStorage);
  browser?.addEventListener?.("pm:session-changed", onSessionEvent);
  return () => {
    subscribers.delete(listener);
    if (subscribers.size === 0) listeners.delete(itemKey);
    browser?.removeEventListener?.("storage", onStorage);
    browser?.removeEventListener?.("pm:session-changed", onSessionEvent);
  };
}

export function clearAsyncDataCache(): void {
  const localStorage = storage();
  snapshots.clear();
  if (!localStorage) return;
  try {
    for (let index = localStorage.length - 1; index >= 0; index -= 1) {
      const key = localStorage.key(index);
      if (key?.startsWith(STORAGE_PREFIX)) {
        localStorage.removeItem(key);
        notify(key);
      }
    }
  } catch {
    // Session cleanup must not depend on optional cache storage.
  }
}
