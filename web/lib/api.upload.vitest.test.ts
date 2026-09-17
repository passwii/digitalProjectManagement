/**
 * 上传通道（`apiUploadWithProgress`）的行为测试。
 *
 * 用 vitest 跑（`test:motion` 的 vitest runner）：本文件需要 mock 浏览器全局
 * （`XMLHttpRequest` / `window` / `document`），而 node:test 那套 tsconfig 只有
 * ES2022 类型，编译不了 `api.ts` 里的 DOM 引用。
 *
 * 重点保护两件容易在「fetch 改写成 XHR」时被弄坏的事：
 *   1. `trackedMutation` 的全局活动条收尾——成功/失败/取消都必须恰好 finish 一次；
 *   2. 鉴权头与 401 清会话，行为要和 `request` 一致。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NetworkError, UnauthorizedError, UploadAbortedError, apiUploadWithProgress } from "./api";
import { setActivityHandler } from "./activityBus";

type ProgressEventLike = { loaded: number; total: number; lengthComputable: boolean };

/** 可控的 XMLHttpRequest 替身：由测试决定何时回调，从而稳定复现各条路径。 */
class FakeXHR {
  static instances: FakeXHR[] = [];
  method = "";
  url = "";
  headers: Record<string, string> = {};
  body: unknown = null;
  status = 0;
  statusText = "";
  responseText = "";
  upload: { onprogress: ((event: ProgressEventLike) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  abortCalled = false;

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(key: string, value: string) {
    this.headers[key] = value;
  }

  send(body: unknown) {
    this.body = body;
    FakeXHR.instances.push(this);
  }

  abort() {
    this.abortCalled = true;
    this.onabort?.();
  }

  /** 触发一次上传进度事件。 */
  emitProgress(loaded: number, total: number, lengthComputable = true) {
    this.upload.onprogress?.({ loaded, total, lengthComputable });
  }

  /** 触发响应。 */
  respond(status: number, text = "", statusText = "") {
    this.status = status;
    this.statusText = statusText;
    this.responseText = text;
    this.onload?.();
  }
}

/** 最近一次创建的 XHR。 */
function latest(): FakeXHR {
  const xhr = FakeXHR.instances.at(-1);
  if (!xhr) throw new Error("尚未创建 XMLHttpRequest");
  return xhr;
}

let finishes: string[] = [];

beforeEach(() => {
  FakeXHR.instances = [];
  finishes = [];
  vi.stubGlobal("XMLHttpRequest", FakeXHR);
  // 活动条替身：记录 label 并返回 finish 回调，用于断言收尾次数
  setActivityHandler((input) => {
    return () => finishes.push(input.label);
  });
  // 让 getToken / clearSession 在 node 下也能跑
  const assign = vi.fn();
  vi.stubGlobal("window", {
    location: { pathname: "/projects", origin: "http://localhost:3001", assign },
    localStorage: { getItem: () => "tok-123", removeItem: () => {} },
  });
  vi.stubGlobal("localStorage", { getItem: () => "tok-123", removeItem: () => {} });
  vi.stubGlobal("document", { cookie: "" });
});

afterEach(() => {
  setActivityHandler(null);
  vi.unstubAllGlobals();
});

describe("上传进度上报", () => {
  it("progress 事件驱动 onProgress，并把已发送字节换算成百分比", async () => {
    const seen: (number | null)[] = [];
    const promise = apiUploadWithProgress<{ ok: boolean }>("/projects/1/attachments", new FormData(), {
      onProgress: (p) => seen.push(p.percent),
    });

    latest().emitProgress(0, 200);
    latest().emitProgress(50, 200);
    latest().emitProgress(200, 200);
    latest().respond(200, JSON.stringify({ ok: true }));

    await expect(promise).resolves.toEqual({ ok: true });
    expect(seen).toEqual([0, 25, 100]);
  });

  it("体积不可知时上报 null（UI 渲染不确定态，而不是伪造 0%）", async () => {
    const seen: (number | null)[] = [];
    const promise = apiUploadWithProgress("/x", new FormData(), {
      onProgress: (p) => seen.push(p.percent),
    });

    latest().emitProgress(1024, 0, false);
    latest().respond(200, "{}");

    await promise;
    expect(seen).toEqual([null]);
  });

  it("未传 onProgress 时不因进度事件抛错", async () => {
    const promise = apiUploadWithProgress("/x", new FormData());
    expect(() => latest().emitProgress(10, 100)).not.toThrow();
    latest().respond(204);
    await promise;
  });
});

describe("全局活动条（trackedMutation）不可因改写而失效", () => {
  it("成功后 finish 恰好调用一次", async () => {
    const promise = apiUploadWithProgress("/x", new FormData());
    latest().respond(200, "{}");
    await promise;
    expect(finishes).toEqual(["上传中"]);
  });

  it("失败（非 2xx）后也 finish 恰好一次", async () => {
    const promise = apiUploadWithProgress("/x", new FormData());
    latest().respond(400, JSON.stringify({ detail: "单文件最大 100MB" }));
    await expect(promise).rejects.toThrow();
    expect(finishes).toEqual(["上传中"]);
  });

  it("网络错误后也 finish 恰好一次", async () => {
    const promise = apiUploadWithProgress("/x", new FormData());
    latest().onerror?.();
    await expect(promise).rejects.toBeInstanceOf(NetworkError);
    expect(finishes).toEqual(["上传中"]);
  });

  it("取消后也 finish 恰好一次", async () => {
    const controller = new AbortController();
    const promise = apiUploadWithProgress("/x", new FormData(), { signal: controller.signal });
    controller.abort();
    await expect(promise).rejects.toBeInstanceOf(UploadAbortedError);
    expect(finishes).toEqual(["上传中"]);
  });
});

describe("取消在途上传", () => {
  it("signal.abort() 会真的 abort XHR，并以 AbortError 收场", async () => {
    const controller = new AbortController();
    const promise = apiUploadWithProgress("/x", new FormData(), { signal: controller.signal });
    const xhr = latest();

    controller.abort();

    expect(xhr.abortCalled).toBe(true);
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
  });

  it("传入已经 abort 的 signal 时不发请求", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      apiUploadWithProgress("/x", new FormData(), { signal: controller.signal }),
    ).rejects.toBeInstanceOf(UploadAbortedError);
    expect(FakeXHR.instances.length).toBe(0);
  });
});

describe("鉴权与错误契约与 request 一致", () => {
  it("带上 Bearer token，且不手动设置 Content-Type（交给浏览器补 boundary）", async () => {
    const promise = apiUploadWithProgress("/x", new FormData());
    const xhr = latest();
    expect(xhr.method).toBe("POST");
    expect(xhr.headers.Authorization).toBe("Bearer tok-123");
    expect(xhr.headers["Content-Type"]).toBeUndefined();
    xhr.respond(200, "{}");
    await promise;
  });

  it("401 抛 UnauthorizedError 并清会话", async () => {
    const promise = apiUploadWithProgress("/x", new FormData());
    latest().respond(401, "unauthorized");
    await expect(promise).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("非 2xx 抛 Error 并带上响应体（errText 可解析出 detail）", async () => {
    const promise = apiUploadWithProgress("/x", new FormData());
    latest().respond(400, JSON.stringify({ detail: "仅允许 ['.pdf']" }));
    await expect(promise).rejects.toThrow(/400/);
    await expect(promise).rejects.toThrow(/仅允许/);
  });

  it("204 与空响应体解析为 undefined", async () => {
    const promise = apiUploadWithProgress("/x", new FormData());
    latest().respond(204);
    await expect(promise).resolves.toBeUndefined();
  });
});
