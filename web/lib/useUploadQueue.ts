"use client";
/**
 * 上传队列：把「逐文件进度 + 取消在途上传」收敛到一处，供 4 个上传入口复用。
 *
 * 解决的重复问题：每个入口都要维护「哪些文件在传、各自多少、谁失败了」，
 * 以及「弹层关掉 / 页面切走后要 abort」——写 4 遍必然漂移。
 *
 * 状态迁移全部委托给 `uploadQueueCore`（纯函数、可单测），本 hook 只负责
 * 持有 `AbortController`、把结果 `setState`、以及在卸载时收尾。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { errText } from "./api";
import { isAbortError } from "./useAsyncData";
import type { UploadProgress } from "./uploadZone";
import {
  applyFailure,
  applyProgress,
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
  /** 中止在途上传（关闭弹层 / 切换对象时调用）。 */
  abort: () => void;
  /** 清空条目并取消在途上传。 */
  reset: () => void;
}

export function useUploadQueue(): UploadQueue {
  const [items, setItems] = useState<UploadItem[]>([]);
  const controllerRef = useRef<AbortController | null>(null);
  const seqRef = useRef(0);
  /** 组件卸载后不再 setState，避免 React 警告与切换对象时的错位渲染。 */
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      controllerRef.current?.abort();
      controllerRef.current = null;
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
    settle(() => []);
  }, [abort, settle]);

  const start = useCallback(
    async <T,>(
      files: File[],
      exec: (file: File, options: UploadExecOptions) => Promise<T>,
    ): Promise<UploadBatchResult<T>> => {
      if (!files.length) return { ok: [], failed: 0, aborted: false };

      // 新批次开始时取消上一批，避免两次上传的进度互相覆盖
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;

      const ids = files.map(() => ++seqRef.current);
      const entries = files.map((file, index) => ({ id: ids[index], file }));
      settle(() => initialItems(files, ids));

      const ok: T[] = [];
      let failed = 0;

      for (const { id, file } of entries) {
        if (controller.signal.aborted) break;
        try {
          const value = await exec(file, {
            signal: controller.signal,
            onProgress: (progress) => settle((prev) => applyProgress(prev, id, progress)),
          });
          ok.push(value);
          settle((prev) => applySuccess(prev, id));
        } catch (e) {
          if (isAbortError(e)) {
            // 主动取消：把这条从列表抹掉，不当作失败呈现给用户
            settle((prev) => removeItem(prev, id));
            controllerRef.current = null;
            return { ok, failed, aborted: true };
          }
          failed += 1;
          settle((prev) => applyFailure(prev, id, errText(e)));
        }
      }

      controllerRef.current = null;
      return { ok, failed, aborted: controller.signal.aborted };
    },
    [settle],
  );

  // `items` / `uploading` 每次进度更新都会变，但下面三个回调是稳定引用：
  // 调用方需要放进 useEffect 依赖（关闭时 abort、切换对象时 reset）时，
  // 必须解构出这些回调来依赖，**不要**把整个返回对象放进依赖数组——
  // 那会让 effect 在每次进度更新时重跑（reset 的 setState 还会形成死循环）。
  return {
    items,
    uploading: hasUploading(items),
    start,
    abort,
    reset,
  };
}
