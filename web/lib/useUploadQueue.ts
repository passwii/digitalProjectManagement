"use client";
/**
 * 上传队列：把「逐文件进度 + 取消在途上传 + 单文件重试」收敛到一处，供 4 个上传入口复用。
 *
 * 解决的重复问题：每个入口都要维护「哪些文件在传、各自多少、谁失败了」，
 * 以及「弹层关掉 / 页面切走后要 abort」——写 4 遍必然漂移。
 *
 * 状态迁移全部委托给 `uploadQueueCore`（纯函数、可单测），本 hook 只负责
 * 持有 `AbortController`、把结果 `setState`、以及在卸载时收尾。
 *
 * 失败分层（BLF-1137）：失败原因不再只是一句话，而是 `uploadErrors` 分出的
 * 5xx（可重试）/ 404（文件已丢失）/ 400（不合规）等档位。只有 `retryable` 的条目
 * 才允许 `retry()` 原样重传 —— 文件还在浏览器里，重传不用用户再选一遍。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { classifyTransferFailure, type TransferFailure } from "./uploadErrors";
import { isAbortError } from "./useAsyncData";
import type { UploadProgress } from "./uploadZone";
import {
  applyFailure,
  applyProgress,
  applyRetry,
  applySuccess,
  hasUploading,
  initialItems,
  removeItem,
  type UploadItem,
} from "./uploadQueueCore";

export type UploadExecOptions = {
  signal: AbortSignal;
  onProgress: (progress: UploadProgress) => void;
};

export interface UploadBatchResult<T> {
  /** 上传成功的结果，顺序与入参一致（失败项不在其中）。 */
  ok: T[];
  /** 失败文件数（不含主动取消）。 */
  failed: number;
  /** 是否因取消而中断；为 true 时调用方不应再提示成功或刷新列表。 */
  aborted: boolean;
  /** 失败项的分层结果（不含主动取消）：调用方据此给 502/404/400 不同的提示。 */
  failures: TransferFailure[];
}

export interface UploadQueue {
  /** 当前批次的条目（进度 / 结果），直接交给 `FileDropZone` 渲染。 */
  items: UploadItem[];
  /** 是否有文件正在上传。 */
  uploading: boolean;
  /**
   * 顺序上传一批文件，逐个更新进度。
   *
   * 单个文件失败不会中断整批：其余文件继续传，失败项在自己那行给出原因
   * （多文件时能看出是哪一个失败了）。主动取消则立即停止并返回 `aborted: true`。
   */
  start: <T>(
    files: File[],
    exec: (file: File, options: UploadExecOptions) => Promise<T>,
  ) => Promise<UploadBatchResult<T>>;
  /**
   * 重试一个失败条目（原文件仍在内存里，不需要用户重新选择）。
   *
   * 只对 `failure.retryable` 的条目有意义：存储不可用（502）值得重试，
   * 文件已丢失（404）或不合规（400）重试也没用，调用方按 `retryable` 决定是否给入口。
   * 上传结果的类型由调用方给（`retry<Attachment>(id)`）—— 同一条上传通道只有它知道。
   */
  retry: <T = unknown>(id: number) => Promise<UploadBatchResult<T>>;
  /** 中止在途上传（关闭弹层 / 切换对象时调用）。 */
  abort: () => void;
  /** 清空条目并取消在途上传。 */
  reset: () => void;
}

type Executor = (file: File, options: UploadExecOptions) => Promise<unknown>;

/** 一个文件的跑批结果：**三态互斥**，调用方不可能把「成功」与「失败」看串。 */
type RunOutcome<T> =
  | { status: "ok"; value: T }
  | { status: "failed"; failure: TransferFailure }
  | { status: "aborted" };

/**
 * 空批次结果。**每次新建**：`failures` 是数组，共用同一个实例的话，
 * 某个调用方往里 push 一次就会污染后续所有空结果。
 */
function emptyResult<T>(): UploadBatchResult<T> {
  return { ok: [], failed: 0, aborted: false, failures: [] };
}

export function useUploadQueue(): UploadQueue {
  const [items, setItems] = useState<UploadItem[]>([]);
  const controllerRef = useRef<AbortController | null>(null);
  const seqRef = useRef(0);
  /** 条目 id → 原文件：重试要原样重传，不能要求用户再选一次文件。 */
  const filesRef = useRef(new Map<number, File>());
  /** 最近一次 `start()` 的执行器：重试走同一条上传通道（含鉴权与进度回调）。 */
  const execRef = useRef<Executor | null>(null);
  /** 组件卸载后不再 setState，避免 React 警告与切换对象时的错位渲染。 */
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      controllerRef.current?.abort();
      controllerRef.current = null;
      filesRef.current.clear();
    };
  }, []);

  const settle = useCallback((updater: (prev: UploadItem[]) => UploadItem[]) => {
    if (!aliveRef.current) return;
    setItems(updater);
  }, []);

  const abort = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
  }, []);

  const reset = useCallback(() => {
    abort();
    filesRef.current.clear();
    settle(() => []);
  }, [abort, settle]);

  /**
   * 跑一个文件：成功/失败/取消三条路径都在这里收口，`start` 与 `retry` 共用。
   * 返回 `aborted: true` 时调用方要立刻停止后续文件（用户取消 ≠ 失败）。
   */
  const runOne = useCallback(
    async <T,>(
      id: number,
      file: File,
      exec: Executor,
      controller: AbortController,
    ): Promise<RunOutcome<T>> => {
      try {
        const value = (await exec(file, {
          signal: controller.signal,
          onProgress: (progress) => settle((prev) => applyProgress(prev, id, progress)),
        })) as T;
        settle((prev) => applySuccess(prev, id));
        // `exec` resolve 出 `undefined`（例如 204 那类上传）也是**成功**：
        // 用「值是不是 undefined」判成败会让它既不算 ok 也不算 failed，
        // 调用方的 `if (result.ok.length)` 于是静默跳过刷新。
        return { status: "ok", value };
      } catch (e) {
        if (isAbortError(e)) {
          // 主动取消：把这条从列表抹掉，不当作失败呈现给用户
          settle((prev) => removeItem(prev, id));
          return { status: "aborted" };
        }
        const failure = classifyTransferFailure(e);
        settle((prev) => applyFailure(prev, id, failure));
        return { status: "failed", failure };
      }
    },
    [settle],
  );

  const start = useCallback(
    async <T,>(
      files: File[],
      exec: (file: File, options: UploadExecOptions) => Promise<T>,
    ): Promise<UploadBatchResult<T>> => {
      if (!files.length) return emptyResult<T>();

      // 新批次开始时取消上一批，避免两次上传的进度互相覆盖
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      execRef.current = exec as Executor;
      filesRef.current.clear();

      const ids = files.map(() => ++seqRef.current);
      const entries = files.map((file, index) => ({ id: ids[index], file }));
      for (const entry of entries) filesRef.current.set(entry.id, entry.file);
      settle(() => initialItems(files, ids));

      const ok: T[] = [];
      const failures: TransferFailure[] = [];

      for (const { id, file } of entries) {
        if (controller.signal.aborted) break;
        const outcome = await runOne<T>(id, file, exec as Executor, controller);
        if (outcome.status === "aborted") {
          controllerRef.current = null;
          return { ok, failed: failures.length, aborted: true, failures };
        }
        if (outcome.status === "failed") failures.push(outcome.failure);
        else ok.push(outcome.value);
      }

      controllerRef.current = null;
      return { ok, failed: failures.length, aborted: controller.signal.aborted, failures };
    },
    [runOne, settle],
  );

  const retry = useCallback(
    async <T = unknown,>(id: number): Promise<UploadBatchResult<T>> => {
      // 有在途批次时**直接拒绝本次重试**，不碰在途的那条 controller：
      // abort 它会让 `start` 的循环收到 aborted 就提前结束，把整批剩下的文件静默丢掉。
      // 返回 `aborted: true` 表示「本次重试没跑」（调用方按取消处理：不提示成功、不刷新）。
      if (controllerRef.current) return { ok: [], failed: 0, aborted: true, failures: [] };

      const file = filesRef.current.get(id);
      const exec = execRef.current;
      // 文件或执行器已经不在（组件重挂载 / 已 reset）：无可重试，静默返回
      if (!file || !exec) return emptyResult<T>();

      const controller = new AbortController();
      controllerRef.current = controller;
      settle((prev) => applyRetry(prev, id));

      const outcome = await runOne<T>(id, file, exec, controller);
      controllerRef.current = null;
      if (outcome.status === "aborted") return { ok: [], failed: 0, aborted: true, failures: [] };
      if (outcome.status === "ok") {
        return { ok: [outcome.value], failed: 0, aborted: false, failures: [] };
      }
      return { ok: [], failed: 1, aborted: false, failures: [outcome.failure] };
    },
    [runOne, settle],
  );

  // `items` / `uploading` 每次进度更新都会变，但下面四个回调是稳定引用：
  // 调用方需要放进 useEffect 依赖（关闭时 abort、切换对象时 reset）时，
  // 必须解构出这些回调来依赖，**不要**把整个返回对象放进依赖数组——
  // 那会让 effect 在每次进度更新时重跑（reset 的 setState 还会形成死循环）。
  return {
    items,
    uploading: hasUploading(items),
    start,
    retry,
    abort,
    reset,
  };
}
