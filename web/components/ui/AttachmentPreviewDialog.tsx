"use client";

/**
 * 公共附件预览弹层：图片与 PDF 内联渲染，Word / Excel 给出下载引导。
 *
 * 各业务模块只需要提供附件、鉴权后的对象 URL 加载函数和下载回调即可复用。
 * 对象 URL 的生命周期严格收在本组件内：打开 / 切换 / 关闭 / 卸载时 revoke。
 */
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import type { Attachment } from "@/lib/api";
import { classifyTransferFailure, failureLine, type TransferFailure } from "@/lib/uploadErrors";
import {
  canPreviewInline,
  fileTypeLabel,
  previewKindOf,
  previewUnsupportedText,
} from "@/lib/contentPreview";
import { formatFileSize } from "@/lib/uploadLimits";
import { Dialog } from "@/components/ui/Modal";

const PdfPreview = dynamic(() => import("./PdfPreview"), {
  ssr: false,
  loading: () => <div className="preview-note" role="status">正在加载 PDF 预览…</div>,
});

const EMPTY_URL_FAILURE: TransferFailure = {
  kind: "unknown",
  status: null,
  message: "无法取到预览内容",
  label: "预览加载失败",
  hint: "可点击下方「下载」用本地应用打开",
  retryable: false,
};

export default function AttachmentPreviewDialog({
  attachment,
  loadUrl,
  onClose,
  onDownload,
}: {
  /** 当前预览的附件；`null` 表示关闭。 */
  attachment: Attachment | null;
  /** 业务模块提供的鉴权对象 URL 加载函数；失败时可抛出原始 HTTP 错误。 */
  loadUrl: (attachment: Attachment) => Promise<string>;
  onClose: () => void;
  onDownload: (attachment: Attachment) => void;
}) {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<TransferFailure | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [imageZoomed, setImageZoomed] = useState(false);

  const kind = attachment ? previewKindOf(attachment) : "other";
  const inline = attachment ? canPreviewInline(attachment) : false;

  const closeDialog = () => {
    if (imageZoomed) {
      setImageZoomed(false);
      return;
    }
    onClose();
  };

  useEffect(() => {
    setImageZoomed(false);
  }, [attachment?.id]);

  useEffect(() => {
    if (!attachment || !inline) {
      setUrl("");
      setFailure(null);
      setLoading(false);
      return;
    }
    let alive = true;
    let owned = "";
    setUrl("");
    setFailure(null);
    setLoading(true);
    loadUrl(attachment)
      .then((next) => {
        if (!alive) {
          if (next) URL.revokeObjectURL(next);
          return;
        }
        owned = next;
        if (!next) setFailure(EMPTY_URL_FAILURE);
        setUrl(next);
      })
      .catch((error) => {
        if (alive) setFailure(classifyTransferFailure(error));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
      if (owned) URL.revokeObjectURL(owned);
    };
  }, [attachment, inline, loadUrl, attempt]);

  return (
    <Dialog
      open={!!attachment}
      onClose={closeDialog}
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
            <button className="btn-primary" onClick={closeDialog}>关闭</button>
          </span>
        </>
      }
    >
      {attachment && (
        <div className="preview-body">
          {!inline && <div className="preview-note" role="status">{previewUnsupportedText(attachment)}</div>}
          {inline && loading && <div className="preview-note" role="status">正在加载预览…</div>}
          {inline && !loading && failure && (
            <div className="preview-note preview-note-error" role="alert">
              <span className={`chip ${failure.retryable ? "warn" : "danger"}`}>{failure.label}</span>
              <span>{failureLine(failure)}</span>
              {failure.retryable && (
                <button type="button" className="btn-ghost btn-xs" onClick={() => setAttempt((value) => value + 1)}>
                  重试
                </button>
              )}
            </div>
          )}
          {inline && !failure && url && kind === "image" && (
            <button
              type="button"
              className="image-preview-trigger"
              aria-label={`放大预览 ${attachment.filename}`}
              onClick={() => setImageZoomed(true)}
            >
              <img className="image-preview" src={url} alt={attachment.filename} />
            </button>
          )}
          {inline && !failure && url && kind === "pdf" && (
            <PdfPreview
              key={`${attachment.id}-${attempt}`}
              url={url}
              filename={attachment.filename}
              onRetry={() => setAttempt((value) => value + 1)}
            />
          )}
          {imageZoomed && url && kind === "image" && (
            <div
              className="image-lightbox"
              role="dialog"
              aria-modal="true"
              aria-label={`${attachment.filename} 放大预览`}
              onClick={() => setImageZoomed(false)}
            >
              <button
                type="button"
                className="image-lightbox-close"
                aria-label="关闭图片放大预览"
                onClick={() => setImageZoomed(false)}
              >
                关闭
              </button>
              <img
                className="image-lightbox-image"
                src={url}
                alt={attachment.filename}
                onClick={(event) => event.stopPropagation()}
              />
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}
