"use client";
// 项目成员管理弹窗：多选 + 搜索，负责人固定保留
import { useEffect, useMemo, useState } from "react";
import { projectsApi, type Project } from "@/lib/api";
import { useMeta } from "@/lib/useMeta";
import { Dialog } from "@/components/ui/Modal";
import Avatar from "@/components/ui/Avatar";

export default function MembersDialog({
  open,
  onClose,
  project,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  project: Project | null;
  onSaved: (p: Project) => void;
}) {
  const { users, depts } = useMeta();
  const [picked, setPicked] = useState<number[]>([]);
  const [q, setQ] = useState("");
  const [err, setErr] = useState("");

  useEffect(() => {
    if (open && project) {
      setPicked(project.member_ids ?? []);
      setQ("");
      setErr("");
    }
  }, [open, project?.id]);

  const initial = useMemo(() => new Set(project?.member_ids ?? []), [project]);
  const dirty = useMemo(
    () => picked.length !== initial.size || picked.some((id) => !initial.has(id)),
    [picked, initial]
  );

  const list = users.filter(
    (u) =>
      !q.trim() ||
      u.real_name.includes(q.trim()) ||
      u.username.toLowerCase().includes(q.trim().toLowerCase())
  );

  function toggle(id: number) {
    if (project?.owner_id === id) return; // 负责人固定
    setPicked((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  async function submit() {
    if (!project) return;
    setErr("");
    try {
      const saved = await projectsApi.setMembers(project.id, picked);
      onSaved(saved);
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "保存失败");
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      dirty={dirty}
      title="管理项目成员"
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>取消</button>
          <button className="btn-primary" onClick={submit}>保存成员</button>
        </>
      }
    >
      <div style={{ marginBottom: 10 }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索姓名或账号…" aria-label="搜索成员" />
      </div>
      <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
        已选 <b className="mono">{picked.length}</b> 人 · 负责人自动保留，不可移除
      </div>
      <div className="member-list">
        {list.length === 0 ? (
          <p className="muted" style={{ fontSize: 13 }}>没有匹配的用户</p>
        ) : (
          list.map((u) => {
            const on = picked.includes(u.id);
            const fixed = project?.owner_id === u.id;
            return (
              <label key={u.id} className={`member-row ${on ? "on" : ""}`}>
                <input type="checkbox" checked={on} disabled={fixed} onChange={() => toggle(u.id)} />
                <Avatar name={u.real_name} size={22} />
                <span className="member-name">{u.real_name}</span>
                <span className="tiny mono">{u.username}</span>
                <span className="tiny">{depts.find((d) => d.id === u.dept_id)?.name ?? ""}</span>
                {fixed && <span className="chip">负责人</span>}
              </label>
            );
          })
        )}
      </div>
      {err && <div className="err" role="alert">{err}</div>}
    </Dialog>
  );
}
