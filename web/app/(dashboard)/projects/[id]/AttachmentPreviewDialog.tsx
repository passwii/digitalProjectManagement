"use client";
/**
 * 附件预览弹层：图片与 PDF 内联渲染，Word / Excel 给出下载引导。
 *
 * 对象 URL 的生命周期严格收在本组件内：打开时按当前附件重新取一次，关闭 / 切换附件 /
 * 卸载时 revoke。**不复用父级的缩略图 URL**——共用会让「谁负责 revoke」变得不确定，
 * 父级刷新列表时撤销，弹层里正打开的图片就会变成破图。
 *
 * 不在这里做类型判断：可预览与否由 `lib/contentPreview` 的纯函数决定（有单测）。
 *
 * ⚠️ 内联预览的安全边界不在本组件，而在**传入的 `loadUrl`**：父级必须强制按扩展名定 blob 的
 * MIME（`fetchObjectUrl(path, previewBlobType(a))`）。本组件只负责把拿到的 URL 交给
 * `<img>` / `<iframe>`，无法判断那份字节是什么类型 —— 详见下面 iframe 处的注释。
 */
import { useEffect, useState } from "react";
import type { Attachment } from "@/lib/api";
import {
  canPreviewInline,
  fileTypeLabel,
  previewKindOf,
  previewUnsupportedText,
} from "@/lib/contentPreview";
import { formatFileSize } from "@/lib/uploadLimits";
import { Dialog } from "@/components/ui/Modal";

export default function AttachmentPreviewDialog({
  attachment,
  loadUrl,
  onClose,
  onDownload,
}: {
  /** 当前预览的附件；`null` 表示关闭。 */
  attachment: Attachment | null;
  /** 取附件的对象 URL；失败时返回空串（由本组件呈现可读错误）。 */
  loadUrl: (attachment: Attachment) => Promise<string>;
  onClose: () => void;
  onDownload: (attachment: Attachment) => void;
}) {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  const kind = attachment ? previewKindOf(attachment) : "other";
  const inline = attachment ? canPreviewInline(attachment) : false;

  // 对象 URL 的归属：本次 effect 运行取回的那份由本次运行唯一负责撤销。
  // 用闭包变量而不是 state/ref：cleanup 必须拿到「本次运行取回的 URL」，
  // 而 state 在 cleanup 时读到的可能是新值（旧 URL 就永远泄漏了）。
  useEffect(() => {
    if (!attachment || !inline) {
      setUrl("");
      setFailed(false);
      setLoading(false);
      return;
    }
    let alive = true;
    let owned = "";
    setUrl("");
    setFailed(false);
    setLoading(true);
    loadUrl(attachment)
      .then((next) => {
        // 迟到响应（已关闭 / 已切换附件）不能污染新状态，但取回的 URL 必须自己撤掉
        if (!alive) {
          if (next) URL.revokeObjectURL(next);
          return;
        }
        owned = next;
        if (!next) setFailed(true);
        setUrl(next);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
      if (owned) URL.revokeObjectURL(owned);
    };
  }, [attachment, inline, loadUrl]);

  return (
    <Dialog
      open={!!attachment}
      onClose={onClose}
      size="lg"
      title={attachment?.filename || "附件预览"}
      footer={
        <>
          {attachment && (
            <span className="preview-meta tiny">
              {fileTypeLabel(attachment)} · {formatFileSize(attachment.size)}
            </span>
          )}
          <span className="preview-foot-actions">
            {attachment && (
              <button className="btn-ghost" onClick={() => onDownload(attachment)}>下载</button>
            )}
            <button className="btn-primary" onClick={onClose}>关闭</button>
          </span>
        </>
      }
    >
      {attachment && (
        <div className="preview-body">
          {!inline && (
            <div className="preview-note" role="status">{previewUnsupportedText(attachment)}</div>
          )}
          {inline && loading && <div className="preview-note" role="status">正在加载预览…</div>}
          {inline && !loading && failed && (
            <div className="preview-note preview-note-error" role="alert">
              预览加载失败，可点击下方「下载」用本地应用打开。
            </div>
          )}
          {inline && !failed && url && kind === "image" && (
            <img className="image-preview" src={url} alt={attachment.filename} />
          )}
          {inline && !failed && url && kind === "pdf" && (
            /*
             * 不加 `sandbox`：这里曾被认为是「最小硬化」，但实测不可行 ——
             * Chrome / Safari 的内置 PDF 阅读器是以**插件**实现的，而沙箱会禁掉插件，
             * 即使把权限全开也不渲染（whatwg/html#3958、chromium#413851）；
             * 而补上 `allow-scripts` 又等于把同源脚本执行原样还给 iframe
             * （`allow-scripts` + 同源正是本类缺陷的成因），等于没有防护。
             *
             * 因此防线放在**上游定权**：`loadUrl` 保证这份 blob 的 type 是 application/pdf
             * （见 `lib/contentPreview` 的 `previewBlobType` 与 `lib/fetchObjectUrl.vitest.test.ts`），
             * 于是即使响应头谎报 text/html，字节也只会被交给 PDF 解析器并失败，不会被当文档执行。
             */
            <iframe className="preview-frame" src={url} title={attachment.filename} />
          )}
        </div>
      )}
    </Dialog>
  );
}
