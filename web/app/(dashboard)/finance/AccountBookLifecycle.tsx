"use client";

import { useState } from "react";
import { Dialog } from "@/components/ui/Modal";
import Empty from "@/components/ui/Empty";
import { LoadFailed } from "@/components/ui/PageState";
import { useToast } from "@/components/ui/Toast";
import { errText, financeApi, type FinanceBook, type FinanceDeletedBook } from "@/lib/api";
import { useAsyncData } from "@/lib/useAsyncData";
import fm from "./finance.module.css";

export function MoveBookToRecycleBinDialog({
  open,
  book,
  onClose,
  onDeleted,
}: {
  open: boolean;
  book: FinanceBook | null;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [confirmTarget, setConfirmTarget] = useState(false);
  const [confirmRetention, setConfirmRetention] = useState(false);
  const [confirmationCode, setConfirmationCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function close() {
    setStep(1);
    setConfirmTarget(false);
    setConfirmRetention(false);
    setConfirmationCode("");
    setError("");
    onClose();
  }

  async function moveToRecycleBin() {
    if (!book || confirmationCode !== book.code || !confirmTarget || !confirmRetention) return;
    setBusy(true);
    setError("");
    try {
      await financeApi.books.moveToRecycleBin(book.id, confirmationCode);
      close();
      onDeleted();
    } catch (cause) {
      setError(errText(cause));
    } finally {
      setBusy(false);
    }
  }

  if (!book) return null;

  return (
    <Dialog
      open={open}
      onClose={close}
      title={`移入账套回收站 · 第 ${step} 步（共 3 步）`}
      size="md"
      maskClosable={false}
      footer={
        <>
          <button className="btn-ghost" onClick={close} disabled={busy}>取消</button>
          {step > 1 && <button className="btn-ghost" onClick={() => setStep((value) => (value - 1) as 1 | 2 | 3)} disabled={busy}>上一步</button>}
          {step === 1 && <button className="btn-ghost btn-danger-outline" onClick={() => setStep(2)} disabled={!confirmTarget}>继续确认</button>}
          {step === 2 && <button className="btn-ghost btn-danger-outline" onClick={() => setStep(3)} disabled={!confirmRetention}>继续输入账套编码</button>}
          {step === 3 && <button className="btn-danger" onClick={moveToRecycleBin} disabled={busy || confirmationCode !== book.code}>{busy ? "处理中…" : "移入回收站"}</button>}
        </>
      }
    >
      <div className="card" style={{ borderColor: "var(--line-danger)", marginBottom: 16 }}>
        <div className="kpi-foot">即将操作的账套</div>
        <strong>{book.name}</strong>
        <span className="mono" style={{ marginLeft: 10 }}>{book.code}</span>
      </div>
      {step === 1 && <>
        <p>移入回收站后，该账套会从日常账套列表中隐藏，用户无法继续访问其中的凭证、科目、期间和报表。</p>
        <label className="field" style={{ display: "flex", alignItems: "flex-start", gap: 10, marginTop: 18 }}>
          <input type="checkbox" checked={confirmTarget} onChange={(event) => setConfirmTarget(event.target.checked)} />
          <span>我确认要将「{book.name} · {book.code}」移入回收站。</span>
        </label>
      </>}
      {step === 2 && <>
        <p>这不是物理删除。数据库会保留账套及其所有业务数据；系统管理员可从回收站恢复，恢复后原数据和成员关系继续可用。该账套编码在恢复前也不能重复使用。</p>
        <label className="field" style={{ display: "flex", alignItems: "flex-start", gap: 10, marginTop: 18 }}>
          <input type="checkbox" checked={confirmRetention} onChange={(event) => setConfirmRetention(event.target.checked)} />
          <span>我了解数据会保留在数据库中，但移入回收站期间无法正常访问。</span>
        </label>
      </>}
      {step === 3 && <>
        <p>最后一步：输入账套完整编码 <strong className="mono">{book.code}</strong>。系统会在服务端再次核验此编码和数据保留确认。</p>
        <label className="field">
          <span className="field-label">账套编码</span>
          <input autoComplete="off" spellCheck={false} value={confirmationCode} onChange={(event) => setConfirmationCode(event.target.value)} placeholder={book.code} />
        </label>
        {confirmationCode && confirmationCode !== book.code && <div className="field-err" role="alert">输入的编码与当前账套不一致。</div>}
      </>}
      {error && <div className="field-err" role="alert">{error}</div>}
    </Dialog>
  );
}

export function AccountBookRecycleBinDialog({
  open,
  onClose,
  onRestored,
}: {
  open: boolean;
  onClose: () => void;
  onRestored: () => void;
}) {
  const toast = useToast();
  const [restoringId, setRestoringId] = useState<number | null>(null);
  const books = useAsyncData(
    (signal) => financeApi.books.recycleBin(signal),
    [],
    { enabled: open },
  );

  async function restore(book: FinanceDeletedBook) {
    setRestoringId(book.id);
    try {
      await financeApi.books.restore(book.id);
      toast.ok(`已恢复账套「${book.name}」`);
      books.reload();
      onRestored();
    } catch (cause) {
      toast.err(errText(cause));
    } finally {
      setRestoringId(null);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="账套回收站"
      size="lg"
      footer={<button className="btn-ghost" onClick={onClose}>关闭</button>}
    >
      <p className="tiny muted">拥有财务管理模块的用户可查看并恢复账套。恢复后，账套及其业务数据会重新开放；账套成员记录仅作为历史数据保留，不参与权限判断。</p>
      {books.firstLoad ? <p className="muted">正在加载回收站…</p> : books.error ? <LoadFailed message={books.error} onRetry={books.reload} /> : !books.data?.length ? <Empty title="回收站为空" hint="移入回收站的账套会保留在这里，拥有财务管理模块的用户可以恢复。" /> : (
        <div className="table-scroll">
          <table className={`grid ${fm.scrollTable} ${fm.recycleBinTable}`}>
            <thead><tr><th>账套名称</th><th>编码</th><th>状态</th><th>移入时间</th><th>操作</th></tr></thead>
            <tbody>{books.data.map((book) => (
              <tr key={book.id}>
                <td>{book.name}</td>
                <td className="mono">{book.code}</td>
                <td>{book.status === "active" ? "使用中" : "已归档"}</td>
                <td>{formatDeletedAt(book.deleted_at)}</td>
                <td><button className="btn-ghost" disabled={restoringId !== null} onClick={() => void restore(book)}>{restoringId === book.id ? "恢复中…" : "恢复账套"}</button></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </Dialog>
  );
}

function formatDeletedAt(value: string): string {
  // 后端 DateTime 按项目约定返回 Asia/Shanghai 的 naive 墙钟值，直接展示避免浏览器时区二次换算。
  return value.replace("T", " ").slice(0, 16);
}
