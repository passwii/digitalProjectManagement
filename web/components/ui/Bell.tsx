"use client";
// 顶栏通知铃铛：未读数 + 下拉面板 + 已读 + 点击跳转对应条目（BLF-1093 精确定位）
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { errText, notificationsApi, type Notification } from "@/lib/api";
import { TARGET_KEY, parseTarget } from "@/lib/deepLink";
import { useMenus } from "@/lib/useMeta";
import { fmtDateTime } from "@/lib/labels";
import { useToast } from "@/components/ui/Toast";
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

/** 通知的定位参数名（`ref_type` → URL 参数）；未知类型返回空串 */
function targetKeyOf(refType: string): string {
  return (TARGET_KEY as Record<string, string>)[refType] ?? "";
}

/**
 * 通知跳转：把 `ref_type` / `ref_id` / `project_id` 三件套拼成带定位参数的链接，
 * 落到具体业务对象（任务/里程碑/支出/跟进），而不是模块首页。
 *
 * · 审批类与项目级通知没有子对象可定位，退回项目详情（立项审批的 ref 就是项目本身）；
 * · 预算调整/支出对有审批模块的用户指向审批中心并高亮对应待办行，对申请人指向成本页。
 */
export function hrefOf(n: Notification, canApprove: boolean): string | null {
  const costs = (q = "") => `/costs?project_id=${n.project_id}${q}`;
  const progress = (q = "") => `/progress?project_id=${n.project_id}${q}`;
  const key = targetKeyOf(n.ref_type);
  const hasTarget = !!key && parseTarget(String(n.ref_id ?? "")) > 0;
  const target = hasTarget ? `&${key}=${n.ref_id}` : "";

  if (!n.project_id) {
    // 无项目归属：仅审批类通知可落到审批中心
    return n.type === "approval" && canApprove ? "/approvals" : null;
  }
  if (n.ref_type === "task") return progress(target);
  if (n.ref_type === "milestone") return progress(target);
  if (n.ref_type === "expense") {
    return canApprove ? `/approvals?expense=${n.ref_id}` : costs(target);
  }
  if (n.ref_type === "budget_adjust") {
    return canApprove ? `/approvals?adjust=${n.ref_id}` : costs(target);
  }
  if (n.ref_type === "followup") return `/projects/${n.project_id}?tab=跟进${target}`;
  if (n.type === "approval") {
    // 立项审批：ref 就是项目自身，有审批模块去审批中心高亮该行
    return canApprove ? `/approvals?filing=${n.project_id}` : `/projects/${n.project_id}`;
  }
  // 预算预警 / 停滞等以项目为对象
  return `/projects/${n.project_id}`;
}

/** 跳转目标是否存在定位参数：决定点击后是否需要二次手工查找（用于面板提示） */
function hasLocator(n: Notification): boolean {
  const key = targetKeyOf(n.ref_type);
  return !!key && parseTarget(String(n.ref_id ?? "")) > 0;
}

export default function Bell() {
  const router = useRouter();
  const { canApprove } = useMenus();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const [items, setItems] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [busyId, setBusyId] = useState<number | null>(null);
  const [readAllBusy, setReadAllBusy] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const bellRef = useRef<HTMLButtonElement | null>(null);
  const countControllerRef = useRef<AbortController | null>(null);
  const countInFlightRef = useRef<Promise<void> | null>(null);
  const listControllerRef = useRef<AbortController | null>(null);
  const listInFlightRef = useRef<Promise<void> | null>(null);

  const loadCount = useCallback(() => {
    if (countInFlightRef.current) return countInFlightRef.current;
    const controller = new AbortController();
    countControllerRef.current = controller;
    const task = notificationsApi
      .count(controller.signal)
      .then((r) => {
        setUnread(r.unread);
      })
      .catch(() => {
        /* 静默：通知不影响主流程 */
      })
      .finally(() => {
        if (countInFlightRef.current === task) countInFlightRef.current = null;
        if (countControllerRef.current === controller) countControllerRef.current = null;
      });
    countInFlightRef.current = task;
    return task;
  }, []);

  const loadList = useCallback(() => {
    listControllerRef.current?.abort();
    const controller = new AbortController();
    listControllerRef.current = controller;
    setLoading(true);
    const task = notificationsApi
      .list("?size=12", controller.signal)
      .then((r) => {
        if (controller.signal.aborted) return;
        setItems(r.items ?? []);
        setUnread(r.unread);
        setErr("");
      })
      .catch((e) => {
        if (!controller.signal.aborted) setErr(errText(e));
      })
      .finally(() => {
        if (listInFlightRef.current === task) {
          listInFlightRef.current = null;
          setLoading(false);
        }
        if (listControllerRef.current === controller) listControllerRef.current = null;
      });
    listInFlightRef.current = task;
    return task;
  }, []);

  useEffect(() => {
    void loadCount();
    const t = setInterval(() => void loadCount(), 60000); // 每分钟刷新未读数
    return () => {
      clearInterval(t);
      countControllerRef.current?.abort();
      countControllerRef.current = null;
    };
  }, [loadCount]);

  useEffect(() => {
    if (!open) return;
    void loadList();
    function onDown(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      // Esc 关闭并把焦点还给铃铛按钮（键盘用户不丢失位置）
      if (e.key === "Escape") {
        setOpen(false);
        bellRef.current?.focus();
      }
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      listControllerRef.current?.abort();
      listControllerRef.current = null;
    };
  }, [open, loadList]);

  async function openItem(n: Notification) {
    const href = hrefOf(n, canApprove);
    // 已读失败不阻断跳转，但要如实告知（不再静默吞掉）
    if (!n.read) {
      setBusyId(n.id);
      try {
        await notificationsApi.read(n.id);
        setItems((prev) => prev.map((x) => (x.id === n.id ? { ...x, read: true } : x)));
        setUnread((u) => Math.max(0, u - 1));
      } catch (e) {
        toast.err(`标记已读失败：${errText(e)}`);
      } finally {
        setBusyId(null);
      }
    }
    if (href) {
      setOpen(false);
      router.push(href);
    } else {
      toast.info("该通知没有可跳转的业务对象");
    }
  }

  async function readAll() {
    setReadAllBusy(true);
    try {
      await notificationsApi.readAll();
      setItems((prev) => prev.map((x) => ({ ...x, read: true })));
      setUnread(0);
      setErr("");
    } catch (e) {
      setErr(errText(e));
    } finally {
      setReadAllBusy(false);
    }
  }

  return (
    <div className={s.wrap} ref={boxRef}>
      <button
        ref={bellRef}
        className={s.bell}
        onClick={() => setOpen((v) => !v)}
        aria-label={unread > 0 ? `通知，${unread} 条未读` : "通知，无未读"}
        aria-expanded={open}
        aria-haspopup="dialog"
      >
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
              <button className={s.link} onClick={readAll} disabled={unread === 0 || readAllBusy}>
                {readAllBusy ? "处理中…" : "全部已读"}
              </button>
            </span>
          </div>
          <div className={s.list} aria-busy={loading}>
            {err && (
              <div className={s.empty} role="alert">
                <div>{err}</div>
                <button className={s.link} onClick={loadList}>重试</button>
              </div>
            )}
            {!err && loading && items.length === 0 && <div className={s.empty}>加载中…</div>}
            {!err && !loading && items.length === 0 && <div className={s.empty}>暂无通知</div>}
            {!err && items.map((n) => {
              const locatable = hasLocator(n) || n.ref_type === "project" || n.ref_type === "";
              return (
                <button
                  key={n.id}
                  className={`${s.item} ${n.read ? "" : s.unreadItem}`}
                  disabled={busyId === n.id}
                  onClick={() => openItem(n)}
                  title={locatable ? "点击定位到对应业务对象" : "点击查看"}
                >
                  <span className={s.tag}>{TYPE_LABEL[n.type] ?? n.type}</span>
                  <span className={s.itemBody}>
                    <span className={s.title}>{n.title}</span>
                    {n.body && <span className={s.desc}>{n.body}</span>}
                    <span className={s.time}>
                      {fmtDateTime(n.created_at)}
                      {!n.read && <span className={s.unreadTag}>未读</span>}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
          <div className={s.foot}>
            <button className={s.link} onClick={loadList} disabled={loading}>
              {loading ? "刷新中…" : "刷新"}
            </button>
            {canApprove && (
              <button className={s.link} onClick={() => { setOpen(false); router.push("/approvals"); }}>
                前往审批中心 →
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
