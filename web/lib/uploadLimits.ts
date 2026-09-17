/**
 * 附件上传限制的前端单一来源（体积上限 + 扩展名白名单 + 提示文案）。
 *
 * 后端对应常量：`api/routers/projects.py` / `api/routers/contacts.py` / `api/routers/expenses.py`。
 * 改限制时只改这里，页面文案与各上传入口的 `accept` 都由本文件推导，避免文案/实现漂移。
 */

/** 单个附件体积上限（字节）。 */
export const MAX_ATTACHMENT_SIZE = 100 * 1024 * 1024;

/** 体积上限的展示单位，例如 `100MB`。 */
export const MAX_ATTACHMENT_SIZE_LABEL = `${MAX_ATTACHMENT_SIZE / (1024 * 1024)}MB`;

/** 上传区统一提示文案（数字来自 {@link MAX_ATTACHMENT_SIZE}）。 */
export const ATTACHMENT_HINT = `支持 PDF / Word / Excel / 图片，单个文件不超过 ${MAX_ATTACHMENT_SIZE_LABEL}`;

/** 合同附件白名单（与 `api/routers/projects.py` 的 ALLOWED_EXT 一致）。 */
export const CONTRACT_ATTACHMENT_EXTENSIONS = [".pdf", ".docx", ".xlsx", ".png", ".jpg", ".jpeg"] as const;

/** 人员档案附件白名单（与 `api/routers/contacts.py` 的 ALLOWED_EXT 一致，另允许 .doc / .xls）。 */
export const CONTACT_ATTACHMENT_EXTENSIONS = [".pdf", ".doc", ".docx", ".xls", ".xlsx", ".png", ".jpg", ".jpeg"] as const;

/** 由合同附件白名单生成的 `<input accept>` 值。 */
export const CONTRACT_ATTACHMENT_ACCEPT = CONTRACT_ATTACHMENT_EXTENSIONS.join(",");

/** 由人员档案附件白名单生成的 `<input accept>` 值。 */
export const CONTACT_ATTACHMENT_ACCEPT = CONTACT_ATTACHMENT_EXTENSIONS.join(",");
