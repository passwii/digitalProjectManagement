// @vitest-environment jsdom
/**
 * 上传队列 hook 的**真实 React 行为**测试（BLF-1137 review 建议 1/2/3）。
 *
 * `uploadQueueCore.test.ts` 测的是纯函数的迁移规则；本文件测的是 hook 自己那层
 * 「调用方看得见」的契约 —— 三条都曾经是「只靠 call-site 的 disabled 挡住」的隐式不变量：
 *
 *   1. `exec` resolve 出 `undefined`（例如 204 那类上传）也是**成功**：既不能算失败，
 *      也不能两边都不算 —— 后者会让调用方的 `if (result.ok.length)` 静默跳过刷新；
 *   2. 有在途批次时 `retry()` 必须**被拒**，不能 `abort()` 在途的 controller：那会连带
 *      掐断整批，剩下的文件被静默丢掉；
 *   3. 空批次结果（含 `failures` 数组）每次都是**新实例**，调用方 push 一次不会串味。
 *
 * 走 vitest + jsdom：`renderHook` 需要真实 DOM，且要观察 setState 之后的 `items`。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";

import { HttpError } from "./api";
import { failureFromResponse } from "./uploadErrors";
import { useUploadQueue, type UploadBatchResult } from "./useUploadQueue";

const file = (name: string) => new File(["x"], name, { type: "image/png" });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("上传队列：成功/失败的判定", () => {
  it("exec resolve 出 undefined 也算成功，不会被静默漏掉", async () => {
    const { result } = renderHook(() => useUploadQueue());
    let batch!: UploadBatchResult<undefined>;
    await act(async () => {
      batch = await result.current.start([file("a.png")], async () => undefined);
    });

    expect(batch.ok).toHaveLength(1);
    expect(batch.failed).toBe(0);
    expect(batch.failures).toHaveLength(0);
    // 条目也要落到 success：调用方据此决定「刷新列表」
    expect(result.current.items[0].status).toBe("done");
  });

  it("exec 抛错才算失败，并带上分层结果", async () => {
    const { result } = renderHook(() => useUploadQueue());
    let batch!: UploadBatchResult<unknown>;
    await act(async () => {
      batch = await result.current.start([file("b.png")], async () => {
        throw new HttpError(
          502,
          '{"detail":"文件存储不可用，请稍后重试（R2 上传失败（ClientError））"}',
        );
      });
    });

    expect(batch.ok).toHaveLength(0);
    expect(batch.failed).toBe(1);
    expect(batch.failures[0].kind).toBe("storage_unavailable");
    expect(batch.failures[0].retryable).toBe(true);
  });
});

describe("上传队列：重试与在途批次", () => {
  it("有在途批次时 retry 被拒，且不掐断在途批次", async () => {
    const { result } = renderHook(() => useUploadQueue());

    // 先造一个可重试的失败条目（原文件仍在内存里）
    await act(async () => {
      await result.current.start([file("bad.png")], async () => {
        throw new HttpError(502, '{"detail":"文件存储不可用，请稍后重试"}');
      });
    });
    const failedId = result.current.items[0].id;
    expect(result.current.items[0].status).toBe("error");

    // 第二批：卡在 gate 上，制造「有在途批次」的窗口
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let second!: Promise<UploadBatchResult<{ id: number }>>;
    await act(async () => {
      second = result.current.start([file("slow.png")], async () => {
        await gate;
        return { id: 7 };
      });
    });

    // 在途期间点重试：必须被拒（aborted），不能把在途批次 abort 掉
    let refused!: UploadBatchResult<unknown>;
    await act(async () => {
      refused = await result.current.retry(failedId);
    });
    expect(refused.aborted).toBe(true);
    expect(refused.ok).toHaveLength(0);

    // 在途批次继续跑完，剩余文件没有被丢弃
    release();
    let done!: UploadBatchResult<{ id: number }>;
    await act(async () => {
      done = await second;
    });
    expect(done.aborted).toBe(false);
    expect(done.ok).toEqual([{ id: 7 }]);
  });

  it("无在途批次时 retry 走原文件重传并返回结果", async () => {
    const { result } = renderHook(() => useUploadQueue());
    let fail = true;
    await act(async () => {
      await result.current.start([file("c.png")], async () => {
        if (fail) throw new HttpError(503, '{"detail":"文件存储不可用，请稍后重试"}');
        return { id: 11 };
      });
    });
    const failedId = result.current.items[0].id;

    fail = false;
    let retried!: UploadBatchResult<unknown>;
    await act(async () => {
      retried = await result.current.retry(failedId);
    });
    expect(retried.aborted).toBe(false);
    expect(retried.ok).toEqual([{ id: 11 }]);
    expect(retried.failed).toBe(0);
    expect(result.current.items[0].status).toBe("done");
  });
});

describe("上传队列：空批次结果", () => {
  it("每次空结果的 ok / failures 都是新数组，不会被调用方串味", async () => {
    const { result } = renderHook(() => useUploadQueue());

    let first!: UploadBatchResult<unknown>;
    await act(async () => {
      first = await result.current.start([], async () => ({}));
    });
    // 调用方（例如某个批量入口）往返回数组里 push，不该影响后续任何一次空结果
    first.ok.push("污染");
    first.failures.push(failureFromResponse(502, ""));

    let second!: UploadBatchResult<unknown>;
    await act(async () => {
      second = await result.current.start([], async () => ({}));
    });
    expect(second.ok).toEqual([]);
    expect(second.failures).toEqual([]);
  });
});
