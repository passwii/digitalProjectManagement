import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HttpError,
  NetworkError,
  apiGet,
  apiGetScoped,
  apiPost,
  downloadFile,
} from "./api";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("JSON 读取 API 的统一恢复入口", () => {
  it("apiGet 遇 503 后自动恢复，apiPost 不自动重放", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("暂时不可用", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = apiGet<{ ok: boolean }>("/read");
    await vi.advanceTimersByTimeAsync(1000);
    await expect(result).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response("暂时不可用", { status: 503 }));
    await expect(apiPost("/write", {})).rejects.toMatchObject({ status: 503 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("文件下载 raw 请求只发起一次", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("暂时不可用", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(downloadFile("/file", "file.pdf")).rejects.toMatchObject({ status: 503 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("Retry-After 秒数会控制下一次读取等待，且 HttpError 暴露结构化字段", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("暂时不可用", {
          status: 503,
          headers: { "Retry-After": "2" },
        }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = apiGet<{ ok: boolean }>("/retry-after");
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(new HttpError(429, "", "", 2500).retryAfterMs).toBe(2500);
  });

  it("apiGetScoped 同时传递作用域 headers 和 AbortSignal", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    await expect(
      apiGetScoped<{ ok: boolean }>("/scoped", { "X-Account-Book": "main" }, controller.signal),
    ).resolves.toEqual({ ok: true });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.headers).toMatchObject({
      "Content-Type": "application/json",
      "X-Account-Book": "main",
    });
  });

  it("网络错误保留稳定错误名称，AbortError 不被转换成 NetworkError", async () => {
    expect(new NetworkError("连接断开")).toMatchObject({ name: "NetworkError" });

    const fetchMock = vi.fn((_url: string, init: RequestInit) =>
      new Promise<never>((_, reject) => {
        init.signal?.addEventListener("abort", () => {
          const error = new Error("请求已取消");
          error.name = "AbortError";
          reject(error);
        });
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    const abortPromise = apiGet("/network", controller.signal);
    controller.abort();
    await expect(abortPromise).rejects.toMatchObject({ name: "AbortError" });
  });
});
