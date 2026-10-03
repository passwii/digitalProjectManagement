"use client";

const STORAGE_PREFIX = "pm_async_data_v1:";
const MAX_CACHE_CHARS = 256 * 1024;
const MAX_CACHE_ENTRIES = 8;

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

/** Avoid storing raw filters/search text in the localStorage key or cache envelope. */
export function cacheIdentity(key: string, depsKey: string): { key: string; depsKey: string } {
  let hash = 2166136261;
  for (let index = 0; index < depsKey.length; index += 1) {
    hash ^= depsKey.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  const fingerprint = (hash >>> 0).toString(36);
  return { key: `${key}:${fingerprint}`, depsKey: fingerprint };
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
    const entries: { key: string; savedAt: number }[] = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const candidateKey = localStorage.key(index);
      if (!candidateKey?.startsWith(STORAGE_PREFIX)) continue;
      try {
        const savedAt = Number((JSON.parse(localStorage.getItem(candidateKey) ?? "null") as StoredAsyncData | null)?.savedAt);
        entries.push({ key: candidateKey, savedAt: Number.isFinite(savedAt) ? savedAt : 0 });
      } catch {
        entries.push({ key: candidateKey, savedAt: 0 });
      }
    }
    entries.sort((left, right) => right.savedAt - left.savedAt);
    for (const entry of entries.slice(MAX_CACHE_ENTRIES)) {
      localStorage.removeItem(entry.key);
      notify(entry.key);
    }
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
  let expiresAt = now;
  try {
    const entry = parseEntry(localStorage.getItem(itemKey), depsKey, token, maxAgeMs);
    if (entry) {
      value = { data: entry.data as T };
      expiresAt = entry.savedAt + maxAgeMs;
    }
  } catch {
    // A storage read failure is simply a miss.
  }
  snapshots.set(itemKey, { signature, expiresAt, value });
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
