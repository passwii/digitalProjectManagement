"use client";
// 顶栏通知铃铛：未读数 + 下拉面板 + 已读 + 点击跳转对应条目
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { errText, notificationsApi, type Notification } from "@/lib/api";
import { fmtDateTime } from "@/lib/labels";
import s from "./Bell.module.css";

const TYPE_LABEL: Record<string, string> = {
  overdue_task: "逾期",
  milestone: "里程碑",
  stagnant: "停滞",
  budget: "预算",
  followup: "提醒",
  approval: "审批",
  expense: "支出",
};

function hrefOf(n: Notification): string | null {
  if (n.ref_type === "task" && n.project_id) return `/progress?project_id=${n.project_id}`;
  if (n.ref_type === "milestone" && n.project_id) return `/progress?project_id=${n.project_id}`;
  if (n.ref_type === "expense") return `/costs${n.project_id ? `?project_id=${n.project_id}` : ""}`;
  if (n.ref_type === "budget_adjust") return `/approvals`;
  if (n.type === "approval") return "/approvals";
  if (n.project_id) return `/projects/${n.project_id}`;
  return null;
}

export default function Bell() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const [items, setItems] = useState<Notification[]>([]);
  const [err, setErr] = useState("");
  const boxRef = useRef<HTMLDivElement | null>(null);

  const loadCount = useCallback(async () => {
    try {
      const r = await notificationsApi.count();
      setUnread(r.unread);
    } catch {
      /* 静默：通知不影响主流程 */
    }
  }, []);

  const loadList = useCallback(async () => {
    try {
      const r = await notificationsApi.list("?size=12");
      setItems(r.items ?? []);
      setUnread(r.unread);
      setErr("");
    } catch (e) {
      setErr(errText(e));
    }
  }, []);

  useEffect(() => {
    loadCount();
    const t = setInterval(loadCount, 60000); // 每分钟刷新未读数
    return () => clearInterval(t);
  }, [loadCount]);

  useEffect(() => {
    if (!open) return;
    loadList();
    function onDown(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, loadList]);

  async function openItem(n: Notification) {
    if (!n.read) {
      try {
        await notificationsApi.read(n.id);
        setItems((prev) => prev.map((x) => (x.id === n.id ? { ...x, read: true } : x)));
        setUnread((u) => Math.max(0, u - 1));
      } catch {
        /* 忽略 */
      }
    }
    const href = hrefOf(n);
    if (href) {
      setOpen(false);
      router.push(href);
    }
  }

  async function readAll() {
    try {
      await notificationsApi.readAll();
      setItems((prev) => prev.map((x) => ({ ...x, read: true })));
      setUnread(0);
    } catch (e) {
      setErr(errText(e));
    }
  }

  return (
    <div className={s.wrap} ref={boxRef}>
      <button className={s.bell} onClick={() => setOpen((v) => !v)} aria-label="通知" aria-expanded={open}>
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.7 21a2 2 0 0 1-3.4 0" />
        </svg>
        {unread > 0 && <span className={s.dot}>{unread > 99 ? "99+" : unread}</span>}
      </button>

      {open && (
        <div className={s.panel} role="dialog" aria-label="通知列表">
          <div className={s.head}>
            <b>通知</b>
            <span className={s.headRight}>
              <span className="tiny">未读 {unread}</span>
              <button className={s.link} onClick={readAll} disabled={unread === 0}>全部已读</button>
            </span>
          </div>
          <div className={s.list}>
            {err && <div className={s.empty}>{err}</div>}
            {!err && items.length === 0 && <div className={s.empty}>暂无通知</div>}
            {items.map((n) => (
              <button key={n.id} className={`${s.item} ${n.read ? "" : s.unreadItem}`} onClick={() => openItem(n)}>
                <span className={s.tag}>{TYPE_LABEL[n.type] ?? n.type}</span>
                <span className={s.itemBody}>
                  <span className={s.title}>{n.title}</span>
                  {n.body && <span className={s.desc}>{n.body}</span>}
                  <span className={s.time}>{fmtDateTime(n.created_at)}</span>
                </span>
              </button>
            ))}
          </div>
          <div className={s.foot}>
            <button className={s.link} onClick={() => { setOpen(false); router.push("/approvals"); }}>
              前往审批中心 →
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
