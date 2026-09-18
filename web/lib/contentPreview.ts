/**
 * 附件预览决策（纯函数，无 React / DOM 依赖，可直接单测）。
 *
 * 「能不能在页面内点开预览」取决于**浏览器原生能渲染什么**：
 *   · 图片 / PDF —— 浏览器可以内联渲染，放 dialog 里的 `<img>` / `<iframe>`；
 *   · Word / Excel —— 浏览器不能渲染，硬塞 iframe 只会得到空白页或下载弹窗，
 *     因此这里明确归为「需下载」，让 UI 给出可读提示，而不是给一个点开没反应的预览按钮。
 *
 * 判据以**扩展名**为主、`content_type` 作为兜底：后端存的是上传时浏览器给的 type，
 * 某些环境为空；扩展名既可靠又与后端上传白名单同源（见 `lib/uploadLimits`）。
 *
 * ⚠️ 「以扩展名为主」不只是一条排序规则，也是一条**安全**规则：内联预览时 blob 的 MIME
 * 必须由扩展名定，不能听响应头的（见 {@link previewBlobType}）。
 */
import { attachmentExtension } from "./uploadLimits";

/** 预览方式：图片 / PDF 可内联预览，office 与未知类型只能下载。 */
export type PreviewKind = "image" | "pdf" | "office" | "other";

/** 展示为图片的扩展名（白名单外的格式若历史遗留上传，仍按图片渲染）。 */
const IMAGE_EXTENSIONS: readonly string[] = [
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".svg",
];

/** 需要本地应用打开的 office 文档扩展名。 */
const OFFICE_EXTENSIONS: readonly string[] = [
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
];

/** 附件的最小形状（`Attachment` 子集），便于在测试里构造。 */
export interface PreviewableAttachment {
  filename: string;
  content_type?: string;
}

/** 是否按图片渲染：`content_type` 优先，其次看扩展名。 */
export function isImageAttachment(a: PreviewableAttachment): boolean {
  if ((a.content_type || "").toLowerCase().startsWith("image/")) return true;
  return IMAGE_EXTENSIONS.includes(attachmentExtension(a.filename));
}

/** 归类附件的预览方式。 */
export function previewKindOf(a: PreviewableAttachment): PreviewKind {
  if (isImageAttachment(a)) return "image";
  const ext = attachmentExtension(a.filename);
  if (ext === ".pdf") return "pdf";
  if (OFFICE_EXTENSIONS.includes(ext)) return "office";
  return "other";
}

/** 是否可内联预览（决定 UI 是否给出「预览」入口）。 */
export function canPreviewInline(a: PreviewableAttachment): boolean {
  const kind = previewKindOf(a);
  return kind === "image" || kind === "pdf";
}

/**
 * 图片扩展名 → 渲染时**强制**使用的 MIME。
 *
 * 用 `Map` 而不是对象字面量（或 `Record<string, string>`）：后者按 key 取值会命中原型链
 * （`MIME["constructor"]` 拿到 `Object` 构造函数），与 `parseProjectTab` 曾踩过的坑同类。
 */
const IMAGE_MIME: ReadonlyMap<string, string> = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".bmp", "image/bmp"],
  [".svg", "image/svg+xml"],
]);

/**
 * 内联预览这些字节时**强制**使用的 blob MIME；无需强制（不可内联预览、或扩展名不认识）时返回 `null`。
 *
 * 为什么必须强制、不能听下载响应头的 `Content-Type`：
 *   1. 下载接口把上传时**客户端声明**的 type 原样回放（后端只校验扩展名，不校验 type），
 *      所以 `任意.pdf` + `Content-Type: text/html` 能顺利入库并在下载时回放；
 *   2. blob URL 继承创建者的源，而 token 存在 `localStorage`；
 *   3. 于是「扩展名说它是 PDF、响应头说它是 HTML」的文件被塞进 `<iframe>` 时，
 *      浏览器会以 HTML 在**应用同源**下执行它 —— 低权限成员可给管理员种一个在其会话里
 *      执行的载荷（存储型 XSS）。
 *
 * 扩展名是**后端白名单唯一校验过**的那一项，所以让扩展名决定字节如何被解释，攻击链
 * 就在这里断开：类型改由扩展名定权后，一份 HTML 字节只会被交给 PDF 阅读器去解析并失败，
 * 不会被当作文档执行。
 *
 * 注意**不用 `<iframe sandbox>` 代替本函数**：沙箱会同时禁掉插件，而 Chrome / Safari
 * 的内置 PDF 阅读器正是以插件实现的，受限沙箱下 PDF 直接不渲染；而放开 `allow-scripts`
 * 又等于把同源脚本执行原样还回来（`allow-scripts` + 隐式同源 = 本缺陷）。
 */
export function previewBlobType(a: PreviewableAttachment): string | null {
  const ext = attachmentExtension(a.filename);
  if (ext === ".pdf") return "application/pdf";
  return IMAGE_MIME.get(ext) ?? null;
}

/** 文件类型角标文案，例如 `XLSX` / `PDF`；无扩展名时退化为 `FILE`。 */
export function fileTypeLabel(a: PreviewableAttachment): string {
  const ext = attachmentExtension(a.filename);
  if (!ext) return "FILE";
  return ext.slice(1).toUpperCase().slice(0, 5);
}

/**
 * 不可内联预览时的说明文案。
 *
 * 必须说清「为什么没有预览按钮」并给出下一步动作，否则用户会以为功能坏了。
 */
export function previewUnsupportedText(a: PreviewableAttachment): string {
  return previewKindOf(a) === "office"
    ? "Word / Excel 无法在浏览器内渲染，请下载后用本地应用查看。"
    : "该格式暂不支持在线预览，请下载后查看。";
}
