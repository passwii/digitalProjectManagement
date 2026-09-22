/** 读取请求遇到这些状态时，服务端或网络通常仍有机会恢复。 */
export const RETRYABLE_READ_STATUS: ReadonlySet<number> = new Set([
  408,
  425,
  429,
  500,
  502,
  503,
  504,
]);

type ReadRetryErrorLike = {
  name?: unknown;
  status?: unknown;
};

export function isRetryableReadError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;

  const candidate = error as ReadRetryErrorLike;
  if (candidate.name === "AbortError") return false;
  if (candidate.name === "NetworkError") return true;

  return (
    typeof candidate.status === "number" &&
    RETRYABLE_READ_STATUS.has(candidate.status)
  );
}

/**
 * 读取请求的退避：前五次约 1 秒，之后按 2/4/8/16 秒指数增加并封顶 30 秒，
 * 同时加入 +-20% 抖动。
 * `random` 可由测试传入，生产环境省略后使用 Math.random()。
 */
export function getReadRetryDelay(attempt: number, random = Math.random()): number {
  const safeAttempt = Math.max(0, Math.floor(attempt));
  const base =
    safeAttempt < 5
      ? 1000
      : Math.min(1000 * 2 ** (safeAttempt - 4), 30000);
  const safeRandom = Math.min(1, Math.max(0, random));
  return Math.min(30000, Math.round(base * (0.8 + safeRandom * 0.4)));
}
