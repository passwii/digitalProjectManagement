# 统一数据读取后台恢复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标：** 将所有 JSON 数据读取统一接入后台 retry，使临时网络/网关故障不打断页面，同时保持写入和文件传输的一次性语义。

**架构：** `web/lib/readRetry.ts` 只保存纯策略，新增 `web/lib/readClient.ts` 提供可取消的 `runReadWithRetry`。`apiGet`/`apiGetScoped` 使用该运行器，写入、上传和文件入口继续调用一次性传输函数；`useAsyncData` 与手动读取页面只负责数据状态、旧数据保留和生命周期取消。

**技术栈：** Next.js 14.2.18、React 18、TypeScript 5.6、Vitest 3、Testing Library、Node test runner。

## 全局约束

- 只对无副作用的 JSON `GET`/`HEAD` 读取做自动 retry；文件、Blob、对象 URL、导出、上传和所有写入请求不得进入该机制。
- 可重试错误为网络连接异常和 HTTP `408/425/429/500/502/503/504`；`400/401/403/404` 不得进入无限 retry。
- 第 1～5 次补偿请求基准间隔均为 `1000ms`，使用 ±20% 抖动；之后为 `2000/4000/8000/16000/30000ms`，客户端计算的等待封顶 `30000ms`。
- 已有数据遇到暂时性读取错误时不得清空；首次没有数据时保持 `firstLoad`，不立即显示网络错误。
- retry 期间同一个读取任务最多一个在途请求和一个等待定时器；AbortSignal、依赖变化、reload、页面卸载都必须停止旧任务。
- `401` 继续执行现有会话清理和登录跳转；`403/404/400` 继续进入现有业务错误流程。
- 读取任务只在页面或全局缓存仍持有时继续；页面销毁后不得创建脱离页面的后台任务。
- 不修改 FastAPI、数据库、Caddy 或生产环境；本计划只改前端读取层和测试。
- 每个实施任务独立运行测试并使用中文 Git 提交标题；不执行生产部署。

---

### 任务 1：更新统一退避策略

**文件：**

- 修改：`web/lib/readRetry.ts`
- 测试：`web/lib/readRetry.test.ts`

**接口：**

- 保持 `RETRYABLE_READ_STATUS`、`isRetryableReadError(error: unknown)`、`getReadRetryDelay(attempt: number, random?: number)` 导出名不变。
- `attempt` 从 `0` 表示第一次失败后的第 1 次补偿请求；`attempt=0..4` 必须返回约 `1000ms` 的延迟。
- 策略模块不得导入 `web/lib/api.ts`，错误判断使用 `status` 和稳定的 `name` 字段。

- [ ] **步骤 1：先更新失败测试**

将 `web/lib/readRetry.test.ts` 的退避断言改为前五次连续约 1 秒，并增加后续档位：

```ts
test("前五次读取 retry 都在约一秒", () => {
  assert.deepEqual(
    [0, 1, 2, 3, 4].map((attempt) => getReadRetryDelay(attempt, 0.5)),
    [1000, 1000, 1000, 1000, 1000],
  );
});

test("第五次之后指数增加并封顶", () => {
  assert.deepEqual(
    [5, 6, 7, 8, 9, 10].map((attempt) => getReadRetryDelay(attempt, 0.5)),
    [2000, 4000, 8000, 16000, 30000, 30000],
  );
});

test("随机抖动不越过每档允许范围", () => {
  assert.equal(getReadRetryDelay(0, 0), 800);
  assert.equal(getReadRetryDelay(0, 1), 1200);
  assert.equal(getReadRetryDelay(5, 0), 1600);
  assert.equal(getReadRetryDelay(5, 1), 2400);
  assert.equal(getReadRetryDelay(99, 0), 24000);
  assert.equal(getReadRetryDelay(99, 1), 30000);
});
```

保留已有错误分类测试，并补一条结构化网络错误断言：

```ts
assert.equal(isRetryableReadError({ name: "NetworkError" }), true);
assert.equal(isRetryableReadError({ name: "AbortError" }), false);
```

- [ ] **步骤 2：运行聚焦测试，确认旧实现失败**

运行：

```bash
cd web
npx tsc -p tsconfig.test.json && node --test .test-dist/lib/readRetry.test.js
```

预期：旧实现的 `1/2/4/8` 退避断言失败，不能因为编译错误以外的原因通过。

- [ ] **步骤 3：实现新退避公式**

将 `getReadRetryDelay` 改为以下等价实现，保留输入保护和 ±20% 抖动：

```ts
export function getReadRetryDelay(attempt: number, random = Math.random()): number {
  const safeAttempt = Math.max(0, Math.floor(attempt));
  const base = safeAttempt < 5
    ? 1000
    : Math.min(1000 * 2 ** (safeAttempt - 4), 30000);
  const safeRandom = Math.min(1, Math.max(0, random));
  return Math.min(30000, Math.round(base * (0.8 + safeRandom * 0.4)));
}
```

将 `isRetryableReadError` 改为只读取稳定字段：数值 `status` 命中 `RETRYABLE_READ_STATUS` 时返回 `true`；`name === "NetworkError"` 时返回 `true`；`AbortError`、普通错误和其他状态返回 `false`。

- [ ] **步骤 4：运行策略测试并确认通过**

运行：

```bash
cd web
npx tsc -p tsconfig.test.json && node --test .test-dist/lib/readRetry.test.js
```

预期：该文件所有测试通过，输出 `0` 失败。

- [ ] **步骤 5：提交策略变更**

```bash
git add web/lib/readRetry.ts web/lib/readRetry.test.ts
git commit -m "前端：调整读取重试退避策略"
```

### 任务 2：新增可取消读取运行器

**文件：**

- 新建：`web/lib/readClient.ts`
- 测试：`web/lib/readClient.vitest.test.ts`

**接口：**

```ts
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

export function runReadWithRetry<T>(
  loader: ReadLoader<T>,
  options?: RunReadOptions,
): Promise<T>;
```

`readClient.ts` 只能依赖 `readRetry.ts` 和浏览器标准 API，不得反向导入 `api.ts`，避免 API 错误类和运行器形成循环依赖。

- [ ] **步骤 1：写运行器失败测试**

在 `web/lib/readClient.vitest.test.ts` 顶部使用 `// @vitest-environment jsdom`，覆盖以下行为：

```ts
it("连续五次失败后仍按约一秒重试并在恢复时返回", async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  let calls = 0;
  const loader = vi.fn(async () => {
    calls += 1;
    if (calls <= 5) throw { name: "NetworkError" };
    return "ready";
  });

  const result = runReadWithRetry(loader);
  for (let i = 0; i < 5; i += 1) {
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  }
  await expect(result).resolves.toBe("ready");
  expect(loader).toHaveBeenCalledTimes(6);
});

it("明确业务错误立即结束，不进入 retry", async () => {
  const loader = vi.fn(async () => { throw { status: 404, name: "HttpError" }; });
  await expect(runReadWithRetry(loader)).rejects.toMatchObject({ status: 404 });
  expect(loader).toHaveBeenCalledTimes(1);
});

it("取消等待中的读取后不再发起下一次请求", async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const loader = vi.fn(async () => { throw { name: "NetworkError" }; });
  const result = runReadWithRetry(loader, { signal: controller.signal });
  await act(async () => {});
  controller.abort();
  await expect(result).rejects.toMatchObject({ name: "AbortError" });
  await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
  expect(loader).toHaveBeenCalledTimes(1);
});
```

另加三条测试：`online`/`focus`/可见性变化会提前唤醒等待、同一运行器不会并发调用 loader、`retryAfterMs` 在 429/503 时采用服务端值但不超过 60 秒。

- [ ] **步骤 2：运行运行器测试，确认符号尚不存在**

运行：

```bash
cd web
npx vitest run lib/readClient.vitest.test.ts
```

预期：因 `web/lib/readClient.ts` 尚未创建而失败。

- [ ] **步骤 3：实现运行器和可唤醒等待**

实现一个内部 `waitForRetry(delayMs, signal)`：创建一个 timer，同时监听 `AbortSignal`、`window.online`、`window.focus` 和可见状态变为 `visible`；任一事件触发都清理 timer/listener 并 resolve。Abort 时以 `name === "AbortError"` 的错误 reject。

`runReadWithRetry` 按以下循环执行，`retryAttempt` 只在确认进入下一次补偿请求时递增：

```ts
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
        return await loader(controller.signal);
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
```

`forwardAbort` 在外部 signal 已经 aborted 时立即 abort 内部 controller；`retryAfterOrPolicy` 只对 `status` 为 429/503 且 `retryAfterMs` 为有限正数的错误生效，并将服务端等待限制在 `0..60000ms`。所有 timer 和 DOM listener 都必须在 resolve、reject、abort 三条路径清理。

- [ ] **步骤 4：运行运行器测试并确认通过**

运行：

```bash
cd web
npx vitest run lib/readClient.vitest.test.ts
```

预期：所有运行器测试通过，且测试输出中包含前五次失败后第六次成功的调用次数断言。

- [ ] **步骤 5：提交读取运行器**

```bash
git add web/lib/readClient.ts web/lib/readClient.vitest.test.ts
git commit -m "前端：新增可取消读取恢复运行器"
```

### 任务 3：接入 API 读取入口并补齐取消信号

**文件：**

- 修改：`web/lib/api.ts`
- 新建：`web/lib/api.read.vitest.test.ts`

**接口变化：**

- `NetworkError` 设置稳定的 `name = "NetworkError"`。
- `HttpError` 增加 `readonly retryAfterMs: number | null`，构造函数保持前三个参数兼容，第四个参数用于测试或传输层注入服务端等待值。
- 内部 `request` 改名为 `requestOnce`；所有写入、上传、文件下载和对象 URL 调用改用 `requestOnce`。
- `apiGet`、`apiGetScoped` 调用 `runReadWithRetry`。
- 所有 JSON 读取方法补充可选 `signal?: AbortSignal`，不改变已有调用的前缀参数顺序。

需要补充 signal 的当前接口包括：`authApi.me`、`metaApi.users/depts/dicts/menus`、`opportunitiesApi.get`、`contactsApi.options/get`、`partnersApi.get`、`notificationsApi.count`、`approvalsApi.pending`、`dashboardApi.summary/weekly`，以及静态盘点发现的其他 JSON GET 方法。已有 signal 参数的 API 保持原签名。

- [ ] **步骤 1：先写传输边界失败测试**

用 `vi.stubGlobal("fetch", vi.fn())` 和 `Response` 构造响应，写出以下断言：

```ts
it("apiGet 遇 503 后自动恢复，apiPost 不自动重放", async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(new Response("暂时不可用", { status: 503 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);

  const result = apiGet<{ ok: boolean }>("/read");
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  await expect(result).resolves.toEqual({ ok: true });
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("文件下载 raw 请求和写入请求只发起一次", async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response("bad", { status: 503 }));
  vi.stubGlobal("fetch", fetchMock);
  await expect(apiPost("/write", {})).rejects.toMatchObject({ status: 503 });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
```

另外验证 `Retry-After: 2` 能进入 `HttpError.retryAfterMs`，并验证 `apiGetScoped` 将 headers 和 AbortSignal 同时传给底层请求。

- [ ] **步骤 2：运行 API 聚焦测试，确认旧入口不满足断言**

运行：

```bash
cd web
npx vitest run lib/api.read.vitest.test.ts
```

预期：旧 `apiGet` 只请求一次，503 测试失败；旧 `request` 没有 `retryAfterMs` 字段，类型或断言失败。

- [ ] **步骤 3：实现一次性传输和读取入口分层**

将底层非 2xx 分支改为读取 header 后构造错误：

```ts
const retryAfterMs = parseRetryAfter(res.headers.get("Retry-After"));
throw new HttpError(res.status, body, res.statusText, retryAfterMs);
```

将 API 读取 helper 改为：

```ts
export const apiGet = <T>(path: string, signal?: AbortSignal) =>
  runReadWithRetry((readSignal) => requestOnce<T>(path, { signal: readSignal }), { signal });

export const apiGetScoped = <T>(
  path: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
) => runReadWithRetry(
  (readSignal) => requestOnce<T>(path, { signal: readSignal, headers }),
  { signal },
);
```

`downloadFile`、`downloadFileScoped`、`fetchObjectUrl` 的 `raw=true` 路径必须继续调用 `requestOnce`；`apiPost`、`apiPut`、`apiPatch`、`apiDelete` 和 `apiUploadWithProgress` 不得调用 `runReadWithRetry`。

为所有缺失 signal 的 JSON GET 方法补充参数，并把参数传到 `apiGet`/`apiGetScoped`；例如：

```ts
export const dashboardApi = {
  summary: (signal?: AbortSignal) => apiGet<DashboardSummary>("/dashboard/summary", signal),
  weekly: (projectId = 0, signal?: AbortSignal) =>
    apiGet<Weekly>(`/dashboard/my-weekly${projectId ? `?project_id=${projectId}` : ""}`, signal),
};
```

- [ ] **步骤 4：运行 API 测试和类型检查**

运行：

```bash
cd web
npx vitest run lib/api.read.vitest.test.ts
npx tsc -p tsconfig.test.json
```

预期：API 边界测试全通过，TypeScript 不报告新增的 signal 参数错误。

- [ ] **步骤 5：提交 API 入口变更**

```bash
git add web/lib/api.ts web/lib/api.read.vitest.test.ts
git commit -m "前端：统一 JSON 读取 API 重试入口"
```

### 任务 4：收敛 `useAsyncData` 页面状态

**文件：**

- 修改：`web/lib/useAsyncData.ts`
- 修改：`web/lib/useAsyncData.dom.vitest.test.tsx`

**接口：** 保持 `useAsyncData(loader, deps, options)` 和 `AsyncData` 返回字段兼容；移除 Hook 内部独立的 retry timer，不改变调用方的 `data/loading/firstLoad/error/reload/setData` 使用方式。

- [ ] **步骤 1：改写 Hook 测试为“promise 挂起时保留状态”**

删除依赖 Hook 内部 fake timer 的旧网络 retry 断言，替换为受控 promise：

```tsx
it("已有数据刷新时，读取 promise 未完成也保留旧数据", async () => {
  let resolveNext!: (value: string) => void;
  let next = false;
  const loader = vi.fn(async () => {
    if (!next) return "old";
    return new Promise<string>((resolve) => { resolveNext = resolve; });
  });
  const { result } = renderHook(() => useAsyncData(loader, []));

  await act(async () => {});
  expect(result.current.data).toBe("old");
  next = true;
  act(() => result.current.reload());
  await act(async () => {});
  expect(result.current.data).toBe("old");
  expect(result.current.error).toBe("");
  act(() => resolveNext("new"));
  await act(async () => {});
  expect(result.current.data).toBe("new");
});
```

保留并调整 400 错误、依赖变化丢弃旧响应、卸载 abort 和 `firstLoad` 骨架测试。读取层的网络 retry 由 `readClient.vitest.test.ts` 和 `api.read.vitest.test.ts` 负责，不在 Hook 内重复测试相同 timer。

- [ ] **步骤 2：运行 Hook 测试，确认旧 retry 假设失败**

运行：

```bash
cd web
npx vitest run lib/useAsyncData.dom.vitest.test.tsx
```

预期：如果只移除 Hook timer，旧的“NetworkError 后 1000ms 自动重试”测试失败，证明测试已覆盖需要删除的旧职责。

- [ ] **步骤 3：移除 Hook 内部 retry 定时器并保留生命周期保护**

在 `useAsyncData.ts` 中删除 `getReadRetryDelay`、`isRetryableReadError`、`timerRef`、`retryAttemptRef`、`needsRecoveryRef`、`wakeRef` 和对应 window/document listener；保留 `seqRef`、`AbortController`、`loaderRef` 和 cleanup。

Effect 内部只启动一个带 controller signal 的 loader：

```ts
const controller = new AbortController();
controllerRef.current = controller;
loaderRef.current(controller.signal)
  .then((value) => {
    if (!active || seqRef.current !== id) return;
    setData(value);
    setError("");
    setLoading(false);
    finishOnce();
  })
  .catch((e) => {
    if (!active || seqRef.current !== id || isAbortError(e)) return;
    setError(errText(e));
    setData(null);
    setLoading(false);
    finishOnce();
  })
  .finally(() => {
    if (controllerRef.current === controller) controllerRef.current = null;
  });
```

`apiGet` 返回的 promise 在暂时性错误期间保持 pending，因此 Hook 会保留数据和空 error；`firstLoad` 继续使用 `loading && data === null`。cleanup 必须 abort controller、递增序号并结束 activity。

- [ ] **步骤 4：运行 Hook 测试和现有前端测试**

运行：

```bash
cd web
npx vitest run lib/useAsyncData.dom.vitest.test.tsx
npm run test:unit
```

预期：Hook 测试和既有 Node 单测全部通过。

- [ ] **步骤 5：提交 Hook 状态变更**

```bash
git add web/lib/useAsyncData.ts web/lib/useAsyncData.dom.vitest.test.tsx
git commit -m "前端：收敛读取 Hook 生命周期"
```

### 任务 5：接入全局缓存和现有 Hook 读取调用

**文件：**

- 修改：`web/lib/useMeta.ts`
- 修改：`web/components/mobile/sheets/DashboardSheet.tsx`
- 修改：`web/components/mobile/sheets/ExpensesSheet.tsx`
- 修改：`web/components/mobile/sheets/ProgressSheet.tsx`
- 修改：`web/components/mobile/sheets/MineSheet.tsx`
- 修改：`web/components/mobile/sheets/ProjectsSheet.tsx`
- 修改：`web/lib/useProjects.ts`
- 修改：`web/lib/useApprovalNotes.ts`
- 修改：`web/app/(dashboard)/reports/page.tsx`

**接口：** 所有 Hook loader 必须接收 `signal: AbortSignal` 并把它传给对应的 API read 方法；全局缓存 loader 继续共享 inflight promise，不用单个组件的 signal 取消共享请求。

- [ ] **步骤 1：先增加 signal 传递回归断言**

在已有 `web/lib/useAsyncData.dom.vitest.test.tsx` 或对应组件测试中，使用一个检查 `signal.aborted` 的 loader，验证卸载时收到 abort；在 `web/lib/projectPicker.vitest.test.tsx` 保留最近项目校验中旧请求被 abort 的断言。

同时用 `rg` 记录待改调用：

```bash
rg -n "dashboardApi\.(summary|weekly)\(\)|approvalsApi\.pending\(\)|reportsApi\.warnings\(\)|notificationsApi\.count\(\)" web
```

- [ ] **步骤 2：补齐全局 API signal 参数使用**

将 `useMeta.ts` 的共享 loader 保持为 `loadMe()`、`loadMeta()`、`loadMenus()`，但确保它们调用已经接入 `apiGet` 的 API 方法；临时错误由 `apiGet` 保持 pending，已有身份快照、菜单和部门缓存不被清空，只有最终非恢复错误才进入现有 `catch`。

将移动端 Hook loader 改为以下形态：

```tsx
const { data } = useAsyncData(async (signal) => {
  const [summary, weekly] = await Promise.all([
    dashboardApi.summary(signal),
    dashboardApi.weekly(0, signal).catch(() => null),
  ]);
  return { summary, weekly };
}, []);
```

`ExpensesSheet`、`ProgressSheet`、`MineSheet` 和其他已有 `useAsyncData` 的读取必须按同样规则传递 signal；`.catch(() => null)` 只能位于 `apiGet` 已经完成 retry 之后，用于可选数据的最终降级。

- [ ] **步骤 3：验证已有 Hook 页面不再遗留无 signal 读取**

运行：

```bash
rg -n -U "useAsyncData\([\s\S]{0,300}?=>[\s\S]{0,300}?(dashboardApi|reportsApi|approvalsApi|notificationsApi)" web/app web/components web/lib
```

逐条确认 loader 形参为 `signal`，API 调用传入同一 signal；对 `useMeta` 的共享缓存调用记录为有意不绑定单组件 signal。

- [ ] **步骤 4：运行移动端和身份相关测试**

运行：

```bash
cd web
npx vitest run lib/useAsyncData.dom.vitest.test.tsx lib/projectPicker.vitest.test.tsx lib/identityRender.dom.vitest.test.tsx
```

预期：移动抽屉、项目选择器、身份快照和权限加载测试通过；临时网络错误不会被测试中的缓存逻辑清空。

- [ ] **步骤 5：提交全局与 Hook 接入**

```bash
git add web/lib/useMeta.ts web/lib/useProjects.ts web/lib/useApprovalNotes.ts \
  web/components/mobile/sheets web/app/'(dashboard)'/reports/page.tsx
git commit -m "前端：接入全局与移动端读取恢复"
```

### 任务 6：改造桌面页的手动读取生命周期

**文件：**

- 修改：`web/app/(dashboard)/dashboard/page.tsx`
- 修改：`web/app/(dashboard)/approvals/page.tsx`
- 修改：`web/app/(dashboard)/projects/[id]/page.tsx`

**接口：** 保留页面既有数据模型和按钮行为；为手动 loader 增加 AbortController、传递 signal、保留已有数据，并把整页骨架条件改为“没有数据时才显示”。

- [ ] **步骤 1：为工作台写临时失败状态测试**

为工作台增加一个 DOM 测试或扩展现有页面测试，验证已有 `data` 时 `load` 进入 pending 不会渲染 `LoadingBlock` 替换 KPI；最终 400/401 错误仍渲染 `err-banner`。

- [ ] **步骤 2：改造工作台加载函数**

将 `dashboardApi.summary()`、`dashboardApi.weekly()` 改为接收同一个 signal；将 loading 语义改为：

```tsx
const firstLoad = loading && data === null;
if (firstLoad) return <LoadingBlock kpis={4} />;
if (err) return <div className="err-banner" role="alert">{err}</div>;
```

在 `load` 中保存当前 `AbortController`，下一次 load 和 cleanup 时 abort；有旧 `data` 时只更新 `loading`/按钮状态，不清空 `data`。`weekly` 的可选 `.catch(() => null)` 保持在 API retry promise 之后。

- [ ] **步骤 3：改造审批中心加载函数**

`approvalsApi.pending(signal)` 使用当前 load 的 controller；保留 `hasLoadedRef`，首次加载显示骨架，刷新和审批提交后的重新读取不清空旧 `data`。新的 load 开始前 abort 上一个 controller，cleanup 时设置 `alive=false` 并 abort，防止迟到响应覆盖新列表。

- [ ] **步骤 4：改造项目详情聚合读取**

`loadAll` 为 `projectsApi.get`、两个 attachments 列表、changes、tasks、expenses 传入同一个 signal；主数据读取仍可用 `Promise.all`。`loading` 只在 `project === null` 时控制整页骨架，已有项目详情在后台恢复期间继续显示。图片缩略图的 `fetchObjectUrl` 仍属于文件读取，不接入自动 retry；其现有 502/404 分层不改变。

- [ ] **步骤 5：运行桌面页聚焦验证**

运行：

```bash
cd web
npx vitest run
npm run test:unit
```

同时执行静态检查：

```bash
rg -n "dashboardApi\.(summary|weekly)\(\)|approvalsApi\.pending\(\)|projectsApi\.(get|attachments|changes)\([^\n]*\)" \
  web/app/'(dashboard)'/dashboard web/app/'(dashboard)'/approvals web/app/'(dashboard)'/projects
```

输出中的读取调用必须要么传 signal，要么是写入/文件路径并已明确排除。

- [ ] **步骤 6：提交桌面页接入**

```bash
git add web/app/'(dashboard)'/dashboard/page.tsx \
  web/app/'(dashboard)'/approvals/page.tsx \
  web/app/'(dashboard)'/projects/'[id]'/page.tsx
git commit -m "前端：改造桌面页面读取生命周期"
```

### 任务 7：改造通知、抽屉和弹窗读取

**文件：**

- 修改：`web/components/ui/Bell.tsx`
- 修改：`web/components/ui/ProjectPicker.tsx`
- 修改：`web/app/(dashboard)/contacts/ContactDrawer.tsx`
- 修改：`web/app/(dashboard)/partners/PartnerDrawer.tsx`
- 修改：`web/app/(dashboard)/costs/ExpenseVouchersDialog.tsx`

**接口：** 所有 JSON 详情、列表和选项读取使用统一 API retry；文件预览和下载保持一次性；弹窗关闭、对象切换和组件卸载取消未完成的 JSON 读取。

- [ ] **步骤 1：为通知和弹窗增加受控取消测试**

测试必须验证：关闭弹窗后 controller 已 abort；通知计数在前一次读取仍 pending 时，60 秒 interval 不创建第二个并发读取；文件预览调用仍只调用 `fetchObjectUrl` 一次。

- [ ] **步骤 2：改造 `Bell`**

增加 `countControllerRef`、`listControllerRef` 和对应的 in-flight guard：

```ts
const countControllerRef = useRef<AbortController | null>(null);
const countInFlightRef = useRef<Promise<void> | null>(null);

const loadCount = useCallback(() => {
  if (countInFlightRef.current) return countInFlightRef.current;
  const controller = new AbortController();
  countControllerRef.current = controller;
  const task = notificationsApi.count(controller.signal)
    .then((r) => setUnread(r.unread))
    .catch(() => {})
    .finally(() => {
      if (countInFlightRef.current === task) countInFlightRef.current = null;
      if (countControllerRef.current === controller) countControllerRef.current = null;
    });
  countInFlightRef.current = task;
  return task;
}, []);
```

列表打开时取消旧 list controller、传入新 signal；已有 `items` 在 retry 期间保留，只有最终不可恢复错误才设置 `err`。组件 cleanup abort count/list controller 并清理 interval。

- [ ] **步骤 3：改造项目选择器和联系人/合作方读取**

保留 `ProjectPicker` 已有的 generation + AbortController 机制，确保 `projectsApi.get`、`projectsApi.options` 都传 signal；网络暂时失败时最近项目保留，不执行“不可再选”的删除逻辑，只有 403/404 才删除。

`ContactDrawer` 和 `PartnerDrawer` 的详情、附件、选项 `Promise.all` 改为共享 controller signal；新对象打开前 abort 旧 controller，成功前不覆盖当前对象状态，关闭时清理 controller。`contactsApi.options`、`contactsApi.get`、`partnersApi.get` 使用任务 3 补齐的 signal 参数。

- [ ] **步骤 4：改造费用票据弹窗的 JSON 列表读取**

为 `ExpenseVouchersDialog.reload` 增加 controller ref，并将 `expensesApi.vouchers(eid, signal)` 传入；`open/eid` 变化、关闭弹窗和卸载时 abort。`fetchObjectUrl`、`downloadVoucher` 和上传队列不进入读取 retry，现有上传失败分层保持不变。

- [ ] **步骤 5：运行组件测试和类型检查**

运行：

```bash
cd web
npx vitest run lib/projectPicker.vitest.test.tsx lib/attachmentPreview.dom.vitest.test.tsx
npx tsc -p tsconfig.test.json
```

预期：项目选择器、文件预览、类型和所有新增取消断言通过；没有将 Blob 读取误接入 retry 的调用。

- [ ] **步骤 6：提交通知与弹窗接入**

```bash
git add web/components/ui/Bell.tsx web/components/ui/ProjectPicker.tsx \
  web/app/'(dashboard)'/contacts/ContactDrawer.tsx \
  web/app/'(dashboard)'/partners/PartnerDrawer.tsx \
  web/app/'(dashboard)'/costs/ExpenseVouchersDialog.tsx
git commit -m "前端：接入通知与弹窗读取恢复"
```

### 任务 8：全量读取边界盘点与完成前验证

**文件：**

- 修改：`web/lib/readRetry.test.ts`、`web/lib/readClient.vitest.test.ts`、`web/lib/api.read.vitest.test.ts`（仅在新增回归断言需要时）
- 复查：`web/lib/api.ts`、`web/lib/useAsyncData.ts`、所有 `web/app`、`web/components`、`web/lib` 读取调用

- [ ] **步骤 1：盘点所有 API 调用入口**

运行：

```bash
rg -n "\brequest<|\brequest\(|apiGet|apiGetScoped|fetchObjectUrl|downloadFile|apiUpload" \
  web/app web/components web/lib -g '*.ts' -g '*.tsx'
```

确认结果满足：

- JSON 数据读取全部通过 `apiGet`/`apiGetScoped`；
- 内部一次性 `requestOnce` 只被写入、文件和上传路径使用；
- `fetchObjectUrl`、`downloadFile`、`apiUpload` 没有调用 `runReadWithRetry`；
- 没有新的 `.catch(() => null)` 位于 JSON API 调用之前；
- 所有 `useAsyncData` loader 都传递 signal，明确共享缓存例外。

- [ ] **步骤 2：运行边界回归测试并核对具体断言**

运行：

```bash
cd web
npx vitest run lib/readClient.vitest.test.ts lib/api.read.vitest.test.ts lib/useAsyncData.dom.vitest.test.tsx
```

逐项确认任务 2～4 已覆盖以下具体断言：

- `apiGet` 在连续网络/503 失败后最终成功，且每次只有一个 loader 在途；
- `apiPost`、`downloadFile`、`fetchObjectUrl`、`apiUploadWithProgress` 在 503 时各自只执行一次；
- `400/401/403/404` 不进入 retry，401 仍触发 `clearSession`；
- AbortSignal、组件卸载和依赖变化后不会再触发下一次读取或遗留 timer。

- [ ] **步骤 3：运行完整前端测试**

运行：

```bash
cd web
npm test
```

预期：`test:unit` 和 `test:motion` 均以退出码 `0` 完成，不能以跳过新增测试作为通过理由。

- [ ] **步骤 4：运行生产构建和差异检查**

运行：

```bash
cd web
npm run build
git diff --check
git status --short
```

预期：Next.js 生产构建退出码为 `0`；允许已有 lint warning，但不得出现新的 TypeScript/build error；工作区只包含本功能计划内的代码和测试变更。

- [ ] **步骤 5：提交最终测试与盘点结果**

```bash
git add web
git commit -m "测试：验证统一数据读取恢复边界"
```

## 完成判定

实施完成前必须逐项确认：

1. `apiGet`/`apiGetScoped` 的 JSON 读取统一进入 `runReadWithRetry`。
2. 前五次补偿请求基准间隔都是约 1 秒，之后逐步增加并封顶。
3. 页面已有数据在暂时性错误期间保留，首次加载不立即报网络错。
4. online、focus、visibilitychange、AbortSignal 和组件 cleanup 行为均有测试。
5. 写入、上传、下载、Blob、图片/PDF 预览和导出没有自动重放。
6. `400/401/403/404` 保持原有业务处理。
7. `npm test`、`npm run build` 和 `git diff --check` 全部通过。
8. 在用户另行确认前不向 VPS 部署。
