/**
 * 上传交互的纯逻辑层：拖拽/粘贴的取文件与准入判断、进度换算。
 *
 * 这里刻意不依赖 DOM 与 React——`FileDropZone` 只做事件绑定与渲染，
 * 判断逻辑全部放在本模块，便于用 node 环境单测覆盖
 * 「拖拽拒绝非白名单」「粘贴不劫持全局」这类回归点。
 */
import { MAX_ATTACHMENT_SIZE, validateAttachment } from "./uploadLimits";

/** 拖拽/粘贴事件里我们关心的最小形态（便于测试注入，无需真实 DataTransfer）。 */
export interface TransferLike {
  files?: ArrayLike<File> | null;
  items?: ArrayLike<DataTransferItemLike> | null;
  types?: ArrayLike<string> | null;
}

export interface DataTransferItemLike {
  kind?: string;
  type?: string;
  getAsFile?: () => File | null;
}

export interface Rejection {
  name: string;
  reason: string;
}

/**
 * 上传进度快照。`percent` 为 `null` 表示本次上传的体积不可知
 * （`xhr.upload.lengthComputable === false`），UI 应渲染不确定态而非伪造 0%。
 *
 * 定义在这里（而非 `api.ts`）是为了让 `uploadQueueCore` 等纯逻辑模块只依赖
 * 无 DOM 的模块：`api.ts` 依赖浏览器 API，把它拉进单测会把 DOM 类型一起带进来。
 */
export interface UploadProgress {
  loaded: number;
  total: number;
  percent: number | null;
}

export interface PartitionResult {
  accepted: File[];
  rejected: Rejection[];
}

/** 把类数组安全转成数组（DataTransfer.files / items 都是类数组）。 */
function toArray<T>(list: ArrayLike<T> | null | undefined): T[] {
  if (!list) return [];
  return Array.prototype.slice.call(list) as T[];
}

/** 是否是「拖了文件进来」——只带文本/链接的拖拽不该触发上传区高亮。 */
export function isFileDrag(types: ArrayLike<string> | null | undefined): boolean {
  return toArray(types).includes("Files");
}

/**
 * 从拖拽事件里取出文件。
 *
 * `dataTransfer.files` 在部分浏览器（尤其拖入文件夹、或跨窗口拖拽）可能为空，
 * 此时退回到 `items` 里 kind==="file" 的条目，避免「拖了却没反应」。
 */
export function filesFromTransfer(transfer: TransferLike | null | undefined): File[] {
  const direct = toArray(transfer?.files);
  if (direct.length) return direct;
  return toArray(transfer?.items).flatMap((item) => {
    if (item?.kind !== "file") return [];
    const file = item.getAsFile?.() ?? null;
    return file ? [file] : [];
  });
}

/**
 * 从粘贴事件里取出图片文件（截图粘贴的主路径）。
 *
 * 只认 `kind === "file"` 且 MIME 为图片的条目：在输入框里粘贴纯文本/HTML
 * 不会命中，因此不会顺手触发上传。没有图片条目时退回到 `files`。
 */
export function filesFromPaste(transfer: TransferLike | null | undefined): File[] {
  const images = toArray(transfer?.items).flatMap((item) => {
    if (item?.kind !== "file" || !(item.type ?? "").startsWith("image/")) return [];
    const file = item.getAsFile?.() ?? null;
    return file ? [file] : [];
  });
  if (images.length) return images;
  return toArray(transfer?.files).filter((file) => (file.type ?? "").startsWith("image/"));
}

/** 可容性判断的最小形态（DOM `Node` 天然满足；测试可传轻量替身）。 */
export interface ContainerLike {
  contains?: (node: never) => boolean;
}

/**
 * 只按结构判定所需的「事件目标」形状。
 *
 * 不用 `EventTarget`：这里如实只需要 `tagName` / `type` / `isContentEditable`，
 * 而真实事件目标（DOM 元素）和单测里的轻量替身都满足本接口；
 * 声明成 `EventTarget` 反而会要求替身补齐 addEventListener 等无关成员。
 */
export interface TargetLike {
  tagName?: string;
  type?: string;
  isContentEditable?: boolean;
}

/** 非文本编辑类 input：这些控件拿到焦点时，粘贴仍应交给上传区。 */
const NON_TEXT_INPUT_TYPES = new Set([
  "file",
  "checkbox",
  "radio",
  "button",
  "submit",
  "reset",
  "image",
  "range",
  "color",
]);

/**
 * 文本编辑目标（输入框、文本域、contenteditable）：粘贴事件在这些位置必须放行。
 *
 * 注意 `input` 要看 `type`：上传区自己的隐藏 `<input type="file">` 也位于
 * 上传容器内，它并不是用户输入文字的地方，不应因此把粘贴放行掉。
 */
export function isEditableTarget(target: TargetLike | EventTarget | null): boolean {
  if (!target || typeof target !== "object") return false;
  const element = target as TargetLike;
  const tag = element.tagName?.toLowerCase?.();
  if (tag === "input") {
    return !NON_TEXT_INPUT_TYPES.has((element.type ?? "text").toLowerCase());
  }
  if (tag === "textarea" || tag === "select") return true;
  if (element.isContentEditable) return true;
  // 兜底：没有 tagName 的合成事件对象不当作可编辑，交给 zone 包含关系判断
  return false;
}

/**
 * 是否应该由上传区接管这次粘贴。
 *
 * 两条都必须满足，否则放行给页面：
 *   1. 事件目标位于上传区内（焦点不在上传区时，事件根本不会冒泡到这里）；
 *   2. 事件目标不是输入框/文本域/contenteditable（区内也不抢输入焦点）。
 *
 * 这样「焦点不在上传区不拦截」「输入框内粘贴不受影响」都有确定行为，
 * 而不是依赖“页面上碰巧没有别的 paste 监听”这种巧合。
 */
export function shouldHandlePaste(
  target: TargetLike | EventTarget | null,
  zone: ContainerLike | null | undefined,
): boolean {
  if (!zone || typeof zone.contains !== "function") return false;
  if (isEditableTarget(target)) return false;
  if (!target || typeof target !== "object") return false;
  const contains = zone.contains as (node: unknown) => boolean;
  return contains.call(zone, target);
}

/**
 * 按白名单与体积上限切分文件，返回可上传与被拒两类（被拒项带可读原因）。
 *
 * 不做「静默丢弃」：每个被拒文件都对应一条可直接展示的提示。
 */
export function partitionFiles(
  files: readonly File[],
  extensions: readonly string[],
  maxSize: number = MAX_ATTACHMENT_SIZE,
): PartitionResult {
  const accepted: File[] = [];
  const rejected: Rejection[] = [];
  for (const file of files) {
    const reason = validateAttachment(file, extensions, maxSize);
    if (reason) rejected.push({ name: file.name, reason });
    else accepted.push(file);
  }
  return { accepted, rejected };
}

/**
 * 上传进度百分比。
 *
 * `lengthComputable === false` 或 total <= 0 时返回 `null`，表示「进度不可知」——
 * 调用方应渲染不确定态进度条，而不是伪造一个数字（0% 会让人以为卡住了）。
 */
export function uploadPercent(loaded: number, total: number, lengthComputable = true): number | null {
  if (!lengthComputable || !Number.isFinite(total) || total <= 0) return null;
  const ratio = loaded / total;
  if (!Number.isFinite(ratio)) return null;
  return Math.max(0, Math.min(100, Math.round(ratio * 100)));
}
