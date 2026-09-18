/**
 * 上传队列的纯状态层：逐文件条目与状态迁移。
 *
 * 抽出来的原因：`useUploadQueue` 里真正容易写错的是「进度回调怎么改条目」
 * ——重复 id、乱序回调、成功后又被迟到的进度覆盖、失败后还显示百分比。
 * 这些迁移不依赖 React，放在这里可以用 node 环境直接单测；
 * hook 只负责把结果 `setState`，组件只负责渲染。
 */
import type { UploadProgress } from "./uploadZone";
// 只取类型（`import type`）：本模块要保持「纯状态层」，运行时不得依赖 api / 网络模块
import type { TransferFailure } from "./uploadErrors";

/** 单个文件的上传状态（`FileDropZone` 逐行渲染的依据）。 */
export interface UploadItem {
  /** 批次内稳定 id（进度回调按它定位条目）。 */
  id: number;
  name: string;
  size?: number;
  /** 0–100；`null` 表示体积不可知（渲染不确定态）。 */
  progress: number | null;
  status: "uploading" | "done" | "error";
  /** status 为 error 时的可读原因（= `failure.message`，保留旧字段避免调用方大改）。 */
  message?: string;
  /**
   * status 为 error 时的**分层结果**（BLF-1137）：徽标、是否可重试都在里面，
   * 上传行据此决定要不要给「重试」按钮 —— 502 给，404/400 不给。
   */
  failure?: TransferFailure;
}

export type { UploadProgress };

/** 由文件生成初始条目：体积已知，因此起点是确定的 0% 而不是「未知」。 */
export function initialItems(files: readonly File[], ids: readonly number[]): UploadItem[] {
  return files.map((file, index) => ({
    id: ids[index],
    name: file.name,
    size: file.size,
    progress: 0,
    status: "uploading" as const,
  }));
}

/**
 * 进度回调 → 条目更新。
 *
 * 只影响仍在 `uploading` 的条目：迟到的进度事件不能把已完成/已失败的条目
 * 拉回「上传中」，否则用户会看到「已完成」跳回百分比。
 */
export function applyProgress(
  items: readonly UploadItem[],
  id: number,
  progress: UploadProgress | number | null,
): UploadItem[] {
  const percent = typeof progress === "object" && progress !== null ? progress.percent : progress;
  return items.map((item) =>
    item.id === id && item.status === "uploading" ? { ...item, progress: percent } : item,
  );
}

/** 单个文件上传成功：进度补满 100 并标记完成（清掉可能残留的错误原因与分层结果）。 */
export function applySuccess(items: readonly UploadItem[], id: number): UploadItem[] {
  return items.map((item) =>
    item.id === id
      ? { ...item, progress: 100, status: "done" as const, message: undefined, failure: undefined }
      : item,
  );
}

/** 单个文件上传失败：进度置 null（不再显示一个骗人的百分比），并附上分层结果。 */
export function applyFailure(
  items: readonly UploadItem[],
  id: number,
  failure: TransferFailure,
): UploadItem[] {
  return items.map((item) =>
    item.id === id
      ? { ...item, status: "error" as const, progress: null, message: failure.message, failure }
      : item,
  );
}

/**
 * 重试一个失败条目：回到「上传中、0%」并清掉上一轮的原因。
 *
 * 只对失败条目生效（成功/在传的条目原样返回）：重试按钮只在 error 行渲染，
 * 但状态迁移仍要自己守住这条不变量，避免迟到的点击把已完成的行拉回上传中。
 */
export function applyRetry(items: readonly UploadItem[], id: number): UploadItem[] {
  return items.map((item) =>
    item.id === id && item.status === "error"
      ? { ...item, status: "uploading" as const, progress: 0, message: undefined, failure: undefined }
      : item,
  );
}

/** 主动取消：把该条目整行移除——取消不是失败，不该留下红行。 */
export function removeItem(items: readonly UploadItem[], id: number): UploadItem[] {
  return items.filter((item) => item.id !== id);
}

/** 是否还有文件在上传（父级按钮的禁用/文案依据）。 */
export function hasUploading(items: readonly UploadItem[]): boolean {
  return items.some((item) => item.status === "uploading");
}
