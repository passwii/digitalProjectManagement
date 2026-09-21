# 前端读取后台恢复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让前端幂等读取请求在网络抖动时保留旧数据并后台持续恢复，同时不自动重放写入请求。

**Architecture:** 新增一个无 React 依赖的读取 retry 策略模块，集中定义可重试状态码、退避上限和带抖动的延迟；`useAsyncData` 负责把该策略接入请求生命周期、取消旧请求、监听在线/前台事件并保留已有数据。页面继续消费原有 `data/loading/firstLoad/error/reload/setData` 接口，不逐页改造。

**Tech Stack:** Next.js 14、React 18、TypeScript、Vitest、Testing Library、Node test runner。

## Global Constraints

- 只对 GET 等幂等读取请求做后台 retry；POST、PATCH、DELETE、XHR 上传和导出写入路径不得接入无限自动重试。
- 已有数据遇到可恢复网络错误时不得清空；不可恢复错误仍按现有页面错误语义处理。
- retry 使用指数退避，约为 1/2/4/8 秒，后续不超过约 30 秒，并加入小幅随机抖动。
- `AbortError`、依赖变化、手动 reload、组件卸载必须停止旧请求和旧 timer。
- 401 继续走现有会话清理与登录跳转；403/404/400 不进入无限 retry。
- 保留现有 `scripts/deploy_vps.py` 未提交修改，不格式化、不重置、不提交该文件。
- 所有 Git 提交标题使用中文；本任务不创建 PR、不部署生产。

---

### Task 1: 建立可测试的读取 retry 策略

**Files:**
- Create: `web/lib/readRetry.ts`
- Test: `web/lib/readRetry.test.ts`

**Interfaces:**
- Produces `RETRYABLE_READ_STATUS: ReadonlySet<number>`、`isRetryableReadError(error: unknown): boolean`、`getReadRetryDelay(attempt: number, random?: number): number`。
- `attempt` 从 0 开始，返回值基于 1000、2000、4000、8000 毫秒指数退避并封顶 30000 毫秒；`random` 仅供确定性测试，生产默认使用 `Math.random()`。

- [x] **Step 1: Write the failing tests**

在 `web/lib/readRetry.test.ts` 中覆盖：网络错误可重试；408/425/429/500/502/503/504 可重试；400/401/403/404 和普通错误不可重试；退避序列在 `random=0.5` 时为 1000/2000/4000/8000/16000/30000；随机值不会让结果低于 0 或超过 30000。

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { HttpError, NetworkError } from "./api";
import { getReadRetryDelay, isRetryableReadError } from "./readRetry";

test("网络错误和网关/限流状态可进入读取 retry", () => {
  assert.equal(isRetryableReadError(new NetworkError("无法连接后端")), true);
  for (const status of [408, 425, 429, 500, 502, 503, 504]) {
    assert.equal(isRetryableReadError(new HttpError(status, "")), true, String(status));
  }
});

test("参数、会话、权限、资源错误不进入读取 retry", () => {
  for (const status of [400, 401, 403, 404]) {
    assert.equal(isRetryableReadError(new HttpError(status, "")), false, String(status));
  }
  assert.equal(isRetryableReadError(new Error("响应不是 JSON")), false);
});

test("读取 retry 使用指数退避并封顶", () => {
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5].map((attempt) => getReadRetryDelay(attempt, 0.5)),
    [1000, 2000, 4000, 8000, 16000, 30000],
  );
});

test("读取 retry 的随机抖动始终保持在合法范围", () => {
  assert.equal(getReadRetryDelay(0, 0), 800);
  assert.equal(getReadRetryDelay(0, 1), 1200);
  assert.equal(getReadRetryDelay(99, 0), 24000);
  assert.equal(getReadRetryDelay(99, 1), 30000);
});
```

- [x] **Step 2: Run the focused test and verify it fails**

Run: `cd web && npx tsc -p tsconfig.test.json && node --test .test-dist/lib/readRetry.test.js`

Expected: FAIL because `web/lib/readRetry.ts` does not exist yet.

- [x] **Step 3: Implement the minimal retry policy**

在 `web/lib/readRetry.ts` 中导出状态集合和两个函数。错误判定优先识别现有 `NetworkError` / `HttpError`，并按结构化 `status` 兼容未来等价错误；普通错误不重试。延迟公式使用 `base * (0.8 + random * 0.4)`，base 为 `Math.min(1000 * 2 ** attempt, 30000)`，最终取整并限制在 `0..30000`。

- [x] **Step 4: Run the focused test and verify it passes**

Run: `cd web && npm run test:unit -- --test-name-pattern='读取 retry'`（若脚本不接受额外参数，则运行 `npx tsc -p tsconfig.test.json && node --test .test-dist/lib/readRetry.test.js`）。

Expected: PASS，且失败原因不再来自缺失模块或类型错误。

- [x] **Step 5: Commit the policy unit**

```bash
git add web/lib/readRetry.ts web/lib/readRetry.test.ts
git commit -m "前端：新增读取请求重试策略"
```

### Task 2: 把 retry 接入 `useAsyncData`

**Files:**
- Modify: `web/lib/useAsyncData.ts`
- Test: `web/lib/useAsyncData.dom.vitest.test.tsx`

**Interfaces:**
- `useAsyncData` 保持现有公开字段和调用签名兼容。
- 可恢复读取失败时保持 `data`、清空页面级 `error`、保持 `loading` 为 true，并安排下一次请求。
- 非可恢复错误继续设置 `error`、清空数据并结束 loading；401 的既有 `clearSession()` 行为由 API 层继续负责。

- [x] **Step 1: Write failing Hook tests**

新增 jsdom 测试文件，使用 `renderHook`、`vi.useFakeTimers()` 和一个可控 loader，覆盖：首次请求失败后不显示 error 且 1000ms 后重试；已有数据失败时数据仍保留并在恢复成功后更新；400 不重试并暴露 error；卸载后 timer 不会再次调用 loader；同一时间只允许一个 loader 在途。

```tsx
// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpError, NetworkError } from "./api";
import { useAsyncData } from "./useAsyncData";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useAsyncData 后台读取恢复", () => {
  it("网络失败后静默 retry，并在恢复时更新数据", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const loader = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new NetworkError("断联");
      return "ready";
    });
    const { result } = renderHook(() => useAsyncData(loader, []));

    await act(async () => {});
    expect(result.current.error).toBe("");
    expect(result.current.data).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(loader).toHaveBeenCalledTimes(2);
    expect(result.current.data).toBe("ready");
    expect(result.current.loading).toBe(false);
  });

  it("已有数据遇到网络失败时保留旧数据", async () => {
    vi.useFakeTimers();
    let mode: "ok" | "down" = "ok";
    const loader = vi.fn(async () => {
      if (mode === "down") throw new NetworkError("断联");
      return "latest";
    });
    const { result } = renderHook(() => useAsyncData(loader, []));
    await act(async () => {});
    expect(result.current.data).toBe("latest");
    mode = "down";
    act(() => result.current.reload());
    await act(async () => {});
    expect(result.current.data).toBe("latest");
    expect(result.current.error).toBe("");
  });

  it("不可恢复错误不进入无限 retry", async () => {
    vi.useFakeTimers();
    const loader = vi.fn(async () => { throw new HttpError(400, "参数错误"); });
    const { result } = renderHook(() => useAsyncData(loader, []));
    await act(async () => {});
    expect(result.current.error).toContain("参数错误");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30000);
    });
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("卸载后不会执行等待中的 retry", async () => {
    vi.useFakeTimers();
    const loader = vi.fn(async () => { throw new NetworkError("断联"); });
    const { unmount } = renderHook(() => useAsyncData(loader, []));
    await act(async () => {});
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30000);
    });
    expect(loader).toHaveBeenCalledTimes(1);
  });
});
```

- [x] **Step 2: Run the Hook tests and verify they fail**

Run: `cd web && npx vitest run lib/useAsyncData.dom.vitest.test.tsx`

Expected: FAIL because the current Hook clears data and has no retry timer.

- [x] **Step 3: Implement one-request/one-timer lifecycle**

在 `useAsyncData` 中增加 `timerRef`、`inFlightRef`、`retryAttemptRef`、`needsRecoveryRef` 和 `wakeRef`。把单次 loader 调用收敛到 effect 内的 `startRequest()`：

- 每次调用先清除旧 timer，创建新的 `AbortController`，设置 `inFlightRef.current = true`。
- 成功时只在当前序号有效时写入数据、清空 error、结束 loading，并重置 retry 计数。
- 可恢复错误时不清空 data/error，保持 loading，设置 `needsRecoveryRef.current = true`，按 `getReadRetryDelay()` 安排唯一 timer。
- 非可恢复错误时设置 `errText(e)`、清空 data、结束 loading，并关闭恢复标记。
- cleanup 中 abort 当前 controller、清除 timer、递增序号、释放 activity。

保持 `resetOnDepChange` 的现有语义：只有依赖变化且该选项为 true 时清空旧数据；后台 retry 和手动 reload 不清空旧数据。

- [x] **Step 4: Run Hook tests and focused frontend tests**

Run: `cd web && npx vitest run lib/useAsyncData.dom.vitest.test.tsx lib/api.upload.vitest.test.ts lib/uploadErrors.test.ts`

Expected: 新增 Hook 测试通过，现有 API 上传和错误分层测试保持通过。

- [x] **Step 5: Commit Hook integration**

```bash
git add web/lib/useAsyncData.ts web/lib/useAsyncData.dom.vitest.test.tsx
git commit -m "前端：读取请求失败时后台自动恢复"
```

### Task 3: 接入在线/前台恢复事件并完成回归验证

**Files:**
- Modify: `web/lib/useAsyncData.ts`
- Modify: `web/lib/useAsyncData.dom.vitest.test.tsx`
- Optional Modify: `web/components/ui/PageState.tsx` only if tests show an existing-data page still renders a strong failure state

**Interfaces:**
- `online`、可见性恢复和 `focus` 事件通过 `wakeRef` 触发当前 Hook 的即时恢复。
- 事件触发不能中断正在进行的请求，也不能创建第二个并发请求。
- 没有等待中的可恢复失败时，事件不应给每个页面制造无意义的请求。

- [x] **Step 1: Add failing lifecycle-event tests**

在现有 jsdom 测试中增加：第一次请求抛出 `NetworkError` 后，派发 `window` 的 `online` 事件会立即调用第二次 loader；`document.visibilityState = "visible"` 后派发 `visibilitychange` 会立即恢复；请求尚未结束时派发多个事件，loader 调用次数仍为 1；成功后再 focus 不会无条件重复请求。

- [x] **Step 2: Run lifecycle tests and verify they fail**

Run: `cd web && npx vitest run lib/useAsyncData.dom.vitest.test.tsx`

Expected: FAIL because the current Hook has no online/visibility/focus listeners.

- [x] **Step 3: Implement event listeners**

在 Hook 内增加浏览器生命周期监听，统一调用 `wakeRef.current`：

- `online`：直接唤醒。
- `focus`：直接唤醒。
- `visibilitychange`：仅当 `document.visibilityState === "visible"` 时唤醒。

`wakeRef` 只在 `needsRecoveryRef.current` 为 true 时工作；如果 `inFlightRef.current` 为 true 则跳过；若存在 timer 则清理 timer、重置当前退避计数并立刻调用 `startRequest()`。事件监听 effect 的 cleanup 必须移除全部监听器。

- [x] **Step 4: Run complete frontend verification**

Run serially:

```bash
cd web
npm run test:unit
npm run test:motion
npm run build
```

Expected: 三个命令均成功；Vitest 输出包含 `useAsyncData.dom.vitest.test.tsx`，构建无 TypeScript 或 Next.js 错误。

- [x] **Step 5: Review the final diff and working tree**

Run: `git diff --check && git status --short && git diff --stat HEAD~2..HEAD`

确认只包含 retry 策略、Hook、相关测试和本计划/提交；确认 `scripts/deploy_vps.py` 仍是用户原有未提交修改，不在本任务提交中。

- [x] **Step 6: Commit lifecycle and verification changes**

```bash
git add web/lib/useAsyncData.ts web/lib/useAsyncData.dom.vitest.test.tsx
git commit -m "前端：网络恢复时立即重试读取请求"
```
