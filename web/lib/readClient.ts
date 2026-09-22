import { getReadRetryDelay, isRetryableReadError } from "./readRetry";

export type ReadLoader<T> = (signal: AbortSignal) => Promise<T>;

export interface ReadRetryInfo {
  attempt: number;
  delayMs: number;
  error: unknown;
}

export interface RunReadOptions {
  signal?: AbortSignal;
  onRetry?: (info: ReadRetryInfo) => void;
}

type RetryAfterError = {
  name?: unknown;
  status?: unknown;
  retryAfterMs?: unknown;
};

const MAX_RETRY_AFTER_MS = 60_000;

function abortError(): Error {
  const error = new Error("读取已取消");
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "name" in error && error.name === "AbortError");
}

function forwardAbort(source: AbortSignal | undefined, target: AbortController): () => void {
  if (!source) return () => {};

  const onAbort = () => target.abort();
  if (source.aborted) {
    target.abort();
    return () => {};
  }

  source.addEventListener("abort", onAbort, { once: true });
  return () => source.removeEventListener("abort", onAbort);
}

function retryAfterOrPolicy(error: unknown, attempt: number): number {
  const candidate = error as RetryAfterError;
  const status = candidate?.status;
  const retryAfterMs = candidate?.retryAfterMs;

  if (
    (status === 429 || status === 503) &&
    typeof retryAfterMs === "number" &&
    Number.isFinite(retryAfterMs) &&
    retryAfterMs > 0
  ) {
    return Math.min(retryAfterMs, MAX_RETRY_AFTER_MS);
  }

  return getReadRetryDelay(attempt);
}

function waitForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError());

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const windowTarget = typeof window === "undefined" ? null : window;
    const documentTarget = typeof document === "undefined" ? null : document;

    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      windowTarget?.removeEventListener("online", wake);
      windowTarget?.removeEventListener("focus", wake);
      documentTarget?.removeEventListener("visibilitychange", wakeOnVisible);
    };

    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };

    const fail = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(abortError());
    };

    const wake = () => finish();
    const wakeOnVisible = () => {
      if (documentTarget?.visibilityState === "visible") finish();
    };
    const onAbort = () => fail();
    const timer = setTimeout(finish, Math.max(0, delayMs));

    signal.addEventListener("abort", onAbort, { once: true });
    windowTarget?.addEventListener("online", wake);
    windowTarget?.addEventListener("focus", wake);
    documentTarget?.addEventListener("visibilitychange", wakeOnVisible);
  });
}

export async function runReadWithRetry<T>(
  loader: ReadLoader<T>,
  options: RunReadOptions = {},
): Promise<T> {
  const controller = new AbortController();
  const detach = forwardAbort(options.signal, controller);
  let retryAttempt = 0;

  try {
    while (true) {
      if (controller.signal.aborted) throw abortError();

      try {
        const value = await loader(controller.signal);
        if (controller.signal.aborted) throw abortError();
        return value;
      } catch (error) {
        if (controller.signal.aborted || isAbortError(error)) throw abortError();
        if (!isRetryableReadError(error)) throw error;

        const delayMs = retryAfterOrPolicy(error, retryAttempt);
        retryAttempt += 1;
        options.onRetry?.({ attempt: retryAttempt, delayMs, error });
        await waitForRetry(delayMs, controller.signal);
      }
    }
  } finally {
    detach();
  }
}
