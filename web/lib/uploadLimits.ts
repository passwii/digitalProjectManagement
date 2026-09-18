/**
 * 附件上传限制的前端单一来源（体积上限 + 扩展名白名单 + 校验 + 提示文案）。
 *
 * 后端对应常量：`api/core/limits.py`（`MAX_ATTACHMENT_SIZE`），
 * 扩展名白名单对应 `api/routers/projects.py` / `contacts.py` 的 `ALLOWED_EXT`。
 * 改限制时只改这里，页面文案、各上传入口的 `accept` 与落文件前的校验都由本文件推导，
 * 前端不再出现第二份阈值真相。
 */

/** 单个附件体积上限（字节）。 */
export const MAX_ATTACHMENT_SIZE = 100 * 1024 * 1024;

/** 把字节上限渲染成展示单位，例如 `100MB`（与后端 `attachment_size_label` 同口径）。 */
export function attachmentSizeLabel(maxSize: number = MAX_ATTACHMENT_SIZE): string {
  return `${maxSize / (1024 * 1024)}MB`;
}

/** 体积上限的展示单位，例如 `100MB`。 */
export const MAX_ATTACHMENT_SIZE_LABEL = attachmentSizeLabel();

/** 上传区统一提示文案（数字来自 {@link MAX_ATTACHMENT_SIZE}）。 */
export const ATTACHMENT_HINT = `支持 PDF / Word / Excel / 图片，单个文件不超过 ${MAX_ATTACHMENT_SIZE_LABEL}`;

/** 合同附件白名单（与 `api/routers/projects.py` 的 ALLOWED_EXT 一致）。 */
export const CONTRACT_ATTACHMENT_EXTENSIONS: readonly string[] = [
  ".pdf",
  ".docx",
  ".xlsx",
  ".png",
  ".jpg",
  ".jpeg",
];

/** 人员档案附件白名单（与 `api/routers/contacts.py` 的 ALLOWED_EXT 一致，另允许 .doc / .xls）。 */
export const CONTACT_ATTACHMENT_EXTENSIONS: readonly string[] = [
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".png",
  ".jpg",
  ".jpeg",
];

/**
 * 图片类附件的可上传扩展名（项目文档 Tab 的图片素材）。
 * 后端附件接口只放行这三种图片格式，历史上 `accept="image/*"` 会放进
 * gif/webp 等必被服务端 400 的格式——这里收敛到真实可用的子集。
 */
export const IMAGE_ATTACHMENT_EXTENSIONS: readonly string[] = [".png", ".jpg", ".jpeg"];

/**
 * 项目文档附件白名单（Excel / Word / PDF + 图片）。
 *
 * 后端 `ALLOWED_EXT` 同一集合（见 `api/routers/projects.py`），
 * `ref_type=""` 的项目级附件即文档附件，与合同附件（`contract`）分开存放。
 */
export const DOCUMENT_ATTACHMENT_EXTENSIONS: readonly string[] = [
  ".xlsx",
  ".docx",
  ".pdf",
  ".png",
  ".jpg",
  ".jpeg",
];

/**
 * 支出票据白名单（与 `api/routers/expenses.py` 的 `VOUCHER_EXT` 一致：发票 PDF 与凭证图片）。
 *
 * 集合上与合同附件相同，但以后端票据接口为准独立命名：票据口径变化时只改这里，
 * 不会误伤合同附件入口。
 */
export const VOUCHER_ATTACHMENT_EXTENSIONS: readonly string[] = [
  ".pdf",
  ".docx",
  ".xlsx",
  ".png",
  ".jpg",
  ".jpeg",
];

/** 支出票据上传区统一提示文案（数字来自 {@link MAX_ATTACHMENT_SIZE}）。 */
export const VOUCHER_ATTACHMENT_HINT = `支持发票 PDF / 凭证图片，单个文件不超过 ${MAX_ATTACHMENT_SIZE_LABEL}`;

/** 由白名单生成 `<input accept>` 值（无空格，顺序与白名单一致）。 */
export function acceptFor(extensions: readonly string[]): string {
  return extensions.join(",");
}

/** 由合同附件白名单生成的 `<input accept>` 值。 */
export const CONTRACT_ATTACHMENT_ACCEPT = acceptFor(CONTRACT_ATTACHMENT_EXTENSIONS);

/** 由支出票据白名单生成的 `<input accept>` 值。 */
export const VOUCHER_ATTACHMENT_ACCEPT = acceptFor(VOUCHER_ATTACHMENT_EXTENSIONS);

/** 由人员档案附件白名单生成的 `<input accept>` 值。 */
export const CONTACT_ATTACHMENT_ACCEPT = acceptFor(CONTACT_ATTACHMENT_EXTENSIONS);

/** 由图片附件白名单生成的 `<input accept>` 值。 */
export const IMAGE_ATTACHMENT_ACCEPT = acceptFor(IMAGE_ATTACHMENT_EXTENSIONS);

/** 取小写扩展名（含点）；无扩展名返回空串。 */
export function attachmentExtension(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot <= 0) return "";
  return filename.slice(dot).toLowerCase();
}

/** 人类可读的文件体积，用于错误提示与列表展示。 */
export function formatFileSize(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return "0 KB";
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

/** 白名单的展示文案，例如 `PDF / DOCX / XLSX`。 */
export function extensionListLabel(extensions: readonly string[]): string {
  return extensions.map((ext) => ext.replace(".", "").toUpperCase()).join(" / ");
}

/**
 * 校验单个文件是否可上传。
 *
 * @returns 通过时返回 `null`，否则返回可直接展示的中文拒绝原因。
 */
export function validateAttachment(
  file: File,
  extensions: readonly string[],
  maxSize: number = MAX_ATTACHMENT_SIZE,
): string | null {
  const ext = attachmentExtension(file.name);
  if (!extensions.includes(ext)) {
    return `不支持的文件类型：${file.name || "(未命名)"}（仅支持 ${extensionListLabel(extensions)}）`;
  }
  if (file.size > maxSize) {
    return `文件过大：${file.name}（${formatFileSize(file.size)}，单个文件不超过 ${attachmentSizeLabel(maxSize)}）`;
  }
  return null;
}
