"use client";
// 进度填报弹窗：完成比例 + 说明 + 剩余工期 + 填报历史
import { useEffect, useState } from "react";
import { buildQuery, errText, progressApi, unwrapPaged, type ProgressLog, type Task } from "@/lib/api";
import { useMeta } from "@/lib/useMeta";
import { useForm } from "@/lib/useForm";
import { fmtDateTime } from "@/lib/labels";
import { Dialog } from "@/components/ui/Modal";
import Field from "@/components/ui/Field";

interface Values {
  progress: string;
  note: string;
  remaining_days: string;
}

/** 填报历史在弹窗里只展示最近这些条（服务端分页上限内），超出时明确标注范围 */
const HISTORY_SIZE = 20;

export default function ReportDialog({
  open,
  onClose,
  task,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  task: Task | null;
  onSaved: () => void;
}) {
  const { userName } = useMeta();
  const [logs, setLogs] = useState<ProgressLog[]>([]);
  const [logsTotal, setLogsTotal] = useState(0);
  const [err, setErr] = useState("");

  const form = useForm<Values>({ progress: "0", note: "", remaining_days: "" }, {
    progress: {
      required: "请填写完成比例",
      label: "完成比例",
      custom: (v) => {
        const n = Number(v);
        if (!Number.isFinite(n)) return "完成比例须为数字";
        return n >= 0 && n <= 100 ? null : "完成比例须在 0-100 之间";
      },
    },
    remaining_days: {
      label: "剩余工期",
      custom: (v) => (!v || Number(v) >= 0 ? null : "剩余工期不能为负"),
    },
  });

  useEffect(() => {
    if (!open || !task) return;
    setErr("");
    form.reset({ progress: String(task.progress ?? 0), note: "", remaining_days: "" });
    let alive = true;
    // Stage 3A：历史也走分页信封；弹窗只展示最近一页，超出时在下方明确标注范围
    progressApi
      .logs(buildQuery({ task_id: task.id, page: 1, size: HISTORY_SIZE, sort: "-id" }))
      .then((d) => {
        if (!alive) return;
        const paged = unwrapPaged<ProgressLog>(d);
        setLogs(paged.items);
        setLogsTotal(paged.total);
      })
      .catch(() => {
        if (!alive) return;
        setLogs([]);
        setLogsTotal(0);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, task?.id]);

  async function submit() {
    if (!task || !form.validate()) return;
    setErr("");
    try {
      await progressApi.report({
        task_id: task.id,
        progress: Number(form.values.progress),
        note: form.values.note.trim(),
        remaining_days: form.values.remaining_days === "" ? null : Number(form.values.remaining_days),
      });
      onSaved();
      onClose();
    } catch (e) {
      setErr(errText(e));
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      dirty={form.dirty}
      title={`填报进度 · ${task?.name ?? ""}`}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>取消</button>
          <button className="btn-primary" onClick={submit}>提交填报</button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="完成比例（%）" required error={form.errors.progress}>
          <input
            type="number"
            min={0}
            max={100}
            value={form.values.progress}
            aria-invalid={!!form.errors.progress}
            onChange={(e) => form.set("progress", e.target.value)}
          />
        </Field>
        <Field label="剩余工期（天）" error={form.errors.remaining_days}>
          <input
            type="number"
            min={0}
            value={form.values.remaining_days}
            onChange={(e) => form.set("remaining_days", e.target.value)}
            placeholder="可选"
          />
        </Field>
        <Field label="进度说明" span>
          <textarea
            rows={2}
            value={form.values.note}
            onChange={(e) => form.set("note", e.target.value)}
            placeholder="本次进展与问题"
          />
        </Field>
      </div>

      <p className="tiny">仅任务负责人、项目负责人或管理员可填报，越权将由后端拒绝。</p>
      {err && <div className="err" role="alert">{err}</div>}

      {logs.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>填报历史</div>
          <ul className="timeline">
            {logs.map((l) => (
              <li key={l.id}>
                <span className="t mono">{fmtDateTime(l.created_at)}</span>
                <span>
                  <b className="mono">{l.progress}%</b>
                  {l.note ? ` · ${l.note}` : ""}
                  {l.remaining_days != null ? <span className="tiny"> · 剩余 {l.remaining_days} 天</span> : null}
                  <span className="tiny"> · {userName(l.user_id)}</span>
                </span>
              </li>
            ))}
          </ul>
          {logsTotal > logs.length && (
            <p className="tiny" style={{ marginTop: 6 }}>
              共 {logsTotal} 条填报历史，此处显示最近 {logs.length} 条。
            </p>
          )}
        </div>
      )}
    </Dialog>
  );
}
