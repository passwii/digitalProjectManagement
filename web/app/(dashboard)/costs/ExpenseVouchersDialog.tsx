"use client";
// 支出票据管理弹窗（BLF-1151）：已建单据的票据证明——上传 / 预览 / 下载 / 删除。
//
// 权限边界：列表与下载要求单据可见（后端 `_expense_for_read` 卡）；上传要求项目可写，
// 删除要求上传者本人或管理员（后端 403 卡）。前端按同一口径隐藏删除入口，
// 不可见项目的人根本进不到成本页（`pid` 守卫），因此无额外前端路由守卫。
import { useCallback, useEffect, useState } from "react";
import {
  errText, expensesApi, fetchObjectUrl,
  type Attachment, type Expense, type ExpenseVoucher,
} from "@/lib/api";
import { batchFailureToast } from "@/lib/uploadErrors";
import { canPreviewInline, previewBlobType } from "@/lib/contentPreview";
import { fmtDateTime } from "@/lib/labels";
import { VOUCHER_ATTACHMENT_EXTENSIONS, VOUCHER_ATTACHMENT_HINT, formatFileSize } from "@/lib/uploadLimits";
import { useUploadQueue } from "@/lib/useUploadQueue";
import { useMe, useMenus, useMeta } from "@/lib/useMeta";
import { Confirm, Dialog } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import Empty from "@/components/ui/Empty";
import FileDropZone from "@/components/ui/FileDropZone";
import AttachmentPreviewDialog from "@/components/ui/AttachmentPreviewDialog";

export default function ExpenseVouchersDialog({
  open,
  onClose,
  expense,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  expense: Expense | null;
  /** 票据增删后通知父级刷新（如需更新计数） */
  onChanged?: () => void;
}) {
  const toast = useToast();
  const uploads = useUploadQueue();
  const { userName } = useMeta();
  const { me } = useMe();
  const { isAdmin } = useMenus();
  const [rows, setRows] = useState<ExpenseVoucher[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadErr, setLoadErr] = useState("");
  const [preview, setPreview] = useState<Attachment | null>(null);
  const [deleting, setDeleting] = useState<ExpenseVoucher | null>(null);
  const [busy, setBusy] = useState(false);

  const eid = expense?.id ?? 0;

  const reload = useCallback(async () => {
    if (!eid) return;
    setLoading(true);
    setLoadErr("");
    try {
      setRows(await expensesApi.vouchers(eid));
    } catch (e) {
      setLoadErr(errText(e));
    } finally {
      setLoading(false);
    }
  }, [eid]);

  useEffect(() => {
    if (!open || !eid) return;
    uploads.reset();
    setPreview(null);
    setDeleting(null);
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, eid]);

  // 弹层关闭即中止在途上传：避免「关掉弹层还在传」
  useEffect(() => {
    if (!open) uploads.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, uploads.abort]);

  /** 选定即传：单据已存在，无需暂存；成功即刷新列表，失败 Toast + 留行内重试 */
  async function uploadPicked(files: File[]) {
    if (!eid || !files.length) return;
    const result = await uploads.start<ExpenseVoucher>(files, (file, options) =>
      expensesApi.uploadVoucher(eid, file, options),
    );
    if (result.aborted) return;
    if (result.failed) {
      toast.err(batchFailureToast(result.failures));
      return;
    }
    toast.ok(`票据已上传 ${result.ok.length} 份`);
    await reload();
    onChanged?.();
  }

  async function retryUpload(id: number) {
    const result = await uploads.retry<ExpenseVoucher>(id);
    if (result.aborted) return;
    if (result.failed) {
      toast.err(batchFailureToast(result.failures));
      return;
    }
    toast.ok("票据已补传成功");
    await reload();
    onChanged?.();
  }

  const fetchPreviewUrl = useCallback(
    async (a: Attachment): Promise<string> =>
      // 强制按扩展名定 blob MIME：这份 URL 会交给 <img> / <iframe>，
      // 不能让上传时客户端声明的 Content-Type 决定字节怎么被解释（存储型 XSS）。
      fetchObjectUrl(
        `/expenses/${eid}/vouchers/${a.id}/download`,
        previewBlobType(a) ?? undefined,
      ),
    [eid],
  );

  async function download(v: ExpenseVoucher) {
    try {
      await expensesApi.downloadVoucher(eid, v.id, v.filename);
    } catch (e) {
      toast.err(errText(e));
    }
  }

  async function confirmDelete() {
    if (!deleting) return;
    setBusy(true);
    try {
      await expensesApi.deleteVoucher(eid, deleting.id);
      toast.ok("票据已删除");
      setDeleting(null);
      await reload();
      onChanged?.();
    } catch (e) {
      toast.err(errText(e));
    } finally {
      setBusy(false);
    }
  }

  /** 删除入口与后端一致：仅上传者本人或管理员可见，其余人走后端 403 兜底 */
  const canDelete = (v: ExpenseVoucher) =>
    isAdmin || (me != null && v.uploaded_by === me.id);

  return (
    <>
      <Dialog
        open={open}
        onClose={onClose}
        dirty={uploads.uploading}
        size="lg"
        title={expense ? `票据证明 · ${expense.subject} ${expense.amount} 元` : "票据证明"}
        footer={<button className="btn-primary" onClick={onClose}>关闭</button>}
      >
        <div className="form-section">
          <div className="form-section-head">
            <h3>上传票据</h3>
          </div>
          <FileDropZone
            extensions={VOUCHER_ATTACHMENT_EXTENSIONS}
            items={uploads.items}
            label="选择发票 PDF / 凭证图片"
            hint="点击选择，或把文件拖到这里；也可直接粘贴截图"
            onFiles={(picked) => void uploadPicked(picked)}
            onRetry={(id) => void retryUpload(id)}
          />
          <span className="field-hint">{VOUCHER_ATTACHMENT_HINT}</span>
        </div>

        <div className="form-section">
          <div className="form-section-head">
            <h3>已上传票据{rows.length > 0 && `（${rows.length}）`}</h3>
          </div>
          {loading ? (
            <p className="tiny">加载票据…</p>
          ) : loadErr ? (
            <div className="err-banner" role="alert">
              {loadErr}
              <button type="button" className="linklike" onClick={() => void reload()}>重试</button>
            </div>
          ) : rows.length === 0 ? (
            <Empty title="暂无票据" hint="上传发票 PDF 或凭证图片后，会在这里统一归档。" />
          ) : (
            <div className="attachment-list">
              {rows.map((v) => (
                <div className="attachment-row" key={v.id}>
                  <span className="attachment-name" title={v.filename}>{v.filename}</span>
                  <span className="tiny">
                    {formatFileSize(v.size)} · {userName(v.uploaded_by)} · {fmtDateTime(v.uploaded_at)}
                  </span>
                  {canPreviewInline(v) && (
                    <button
                      type="button"
                      className="linklike"
                      onClick={() => setPreview(v)}
                    >
                      预览
                    </button>
                  )}
                  <button type="button" className="linklike" onClick={() => void download(v)}>
                    下载
                  </button>
                  {canDelete(v) && (
                    <button
                      type="button"
                      className="linklike danger-link"
                      onClick={() => setDeleting(v)}
                    >
                      删除
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </Dialog>

      <AttachmentPreviewDialog
        attachment={preview}
        loadUrl={fetchPreviewUrl}
        onClose={() => setPreview(null)}
        onDownload={(a) => {
          const v = rows.find((x) => x.id === a.id);
          if (v) void download(v);
        }}
      />

      <Confirm
        open={!!deleting}
        danger
        loading={busy}
        title={`删除票据「${deleting?.filename ?? ""}」？`}
        text="删除后不可恢复，如需保留请先下载备份。"
        okText="确认删除"
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleting(null)}
      />
    </>
  );
}
