"use client";
// 站内通知中心：未读数（全局 Provider）+ 列表 / 已读 / 深链（NotificationSection）。
//
// 之前顶栏有一颗独立的铃铛；用户反馈右上角多一个图标是冗余的，通知能力整体并入
// 账号「我的」菜单（桌面账号浮标 + 手机「更多」sheet 共用同一份组件与状态）。
// 不再渲染任何独立铃铛按钮，但通知能力原样保留：
//   · 未读数在账号入口上以徽标 + 可读描述呈现；
//   · 打开菜单即加载列表，支持逐条标记已读、全部已读、刷新与失败重试；
//   · 点击通知照旧落到具体业务对象（hrefOf，BLF-1093 的深链规则）。
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import { useRouter } from "next/navigation";
import { errText, notificationsApi, type Notification } from "@/lib/api";
import { TARGET_KEY, parseTarget } from "@/lib/deepLink";
import { useMenus } from "@/lib/useMeta";
import { fmtDateTime } from "@/lib/labels";
import { useToast } from "@/components/ui/Toast";
import s from "./NotificationCenter.module.css";

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

interface NotificationFeed {
  unread: number;
  setUnread: Dispatch<SetStateAction<number>>;
  /** 主动刷新未读数（轮询之外的手动路径；失败静默，不阻塞主流程） */
  refresh: () => Promise<void>;
}

/** 没有 Provider 时的降级值：不轮询、不报错，供孤立渲染（测试 / 片段）使用。 */
const EMPTY_FEED: NotificationFeed = {
  unread: 0,
  setUnread: () => {},
  refresh: () => Promise.resolve(),
};

const NotificationContext = createContext<NotificationFeed | null>(null);

/**
 * 全局未读数：整个外壳只轮询一次。
 *
 * 任何时刻最多一个在途请求 —— 上一次还没回来时，每分钟的定时刷新直接复用同一个
 * promise，不会堆出并发读取（旧 Bell 的生命周期用例覆盖的正是这一点）。
 */
export function NotificationProvider({ children }: { children: ReactNode }) {
  const [unread, setUnread] = useState(0);
  const countControllerRef = useRef<AbortController | null>(null);
  const countInFlightRef = useRef<Promise<void> | null>(null);

  const refresh = useCallback(() => {
    if (countInFlightRef.current) return countInFlightRef.current;
    const controller = new AbortController();
    countControllerRef.current = controller;
    const task = notificationsApi
      .count(controller.signal)
      .then((r) => setUnread(r.unread))
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

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 60000); // 每分钟刷新未读数
    return () => {
      clearInterval(timer);
      countControllerRef.current?.abort();
      countControllerRef.current = null;
    };
  }, [refresh]);

  const value = useMemo(() => ({ unread, setUnread, refresh }), [unread, refresh]);

  return <NotificationContext.Provider value={value}>{children}</NotificationContext.Provider>;
}

export function useNotificationUnread(): NotificationFeed {
  return useContext(NotificationContext) ?? EMPTY_FEED;
}

/**
 * 通知区域：标题（可选）+ 列表 + 已读/刷新动作。
 *
 * 在桌面 / 手机的账号菜单里展开显示（showHeader 默认 true）；手机「更多」sheet 里
 * 由「通知」入口展开，标题由入口自己承担，故 showHeader=false。
 */
export function NotificationSection({
  onNavigate,
  headingId,
  showHeader = true,
}: {
  /** 点击通知深链前的收尾动作（关闭菜单 / sheet） */
  onNavigate?: () => void;
  headingId?: string;
  showHeader?: boolean;
}) {
  const router = useRouter();
  const { canApprove } = useMenus();
  const feed = useNotificationUnread();
  const toast = useToast();
  const { unread } = feed;
  const [items, setItems] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [busyId, setBusyId] = useState<number | null>(null);
  const [readAllBusy, setReadAllBusy] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);
  // setUnread 来自 useState，引用稳定；放进 ref 是为了让 loadList 不依赖会随未读数
  // 变化的 context 对象，否则「加载列表 → 更新未读数 → 重新加载列表」会自己转圈。
  const setUnreadRef = useRef(feed.setUnread);

  const loadList = useCallback(() => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setLoading(true);
    return notificationsApi
      .list("?size=12", controller.signal)
      .then((r) => {
        if (controller.signal.aborted) return;
        setItems(r.items ?? []);
        setUnreadRef.current(r.unread);
        setErr("");
      })
      .catch((e) => {
        if (!controller.signal.aborted) setErr(errText(e));
      })
      .finally(() => {
        if (controllerRef.current === controller) {
          controllerRef.current = null;
          setLoading(false);
        }
      });
  }, []);

  useEffect(() => {
    void loadList();
    return () => {
      controllerRef.current?.abort();
      controllerRef.current = null;
    };
  }, [loadList]);

  async function openItem(n: Notification) {
    const href = hrefOf(n, canApprove);
    // 已读失败不阻断跳转，但要如实告知（不再静默吞掉）
    if (!n.read) {
      setBusyId(n.id);
      try {
        await notificationsApi.read(n.id);
        setItems((prev) => prev.map((x) => (x.id === n.id ? { ...x, read: true } : x)));
        setUnreadRef.current((count) => Math.max(0, count - 1));
      } catch (e) {
        toast.err(`标记已读失败：${errText(e)}`);
      } finally {
        setBusyId(null);
      }
    }
    if (href) {
      onNavigate?.();
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
      setUnreadRef.current(0);
      setErr("");
    } catch (e) {
      toast.err(`全部已读失败：${errText(e)}`);
    } finally {
      setReadAllBusy(false);
    }
  }

  return (
    <section
      className={s.section}
      aria-label={showHeader ? undefined : "通知"}
      aria-labelledby={showHeader ? headingId : undefined}
      data-notification-center="true"
    >
      {showHeader && (
        <header className={s.head}>
          <h3 id={headingId}>通知</h3>
          <span className={s.count} aria-live="polite" data-notification-unread>
            {unread > 0 ? `${unread} 条未读` : "无未读"}
          </span>
          <button
            type="button"
            className={s.link}
            onClick={readAll}
            disabled={unread === 0 || readAllBusy}
          >
            {readAllBusy ? "处理中…" : "全部已读"}
          </button>
        </header>
      )}
      <div className={s.list} aria-busy={loading} data-notification-list>
        {err ? (
          <div className={s.empty} role="alert">
            <div>{err}</div>
            <button type="button" className={s.link} onClick={() => void loadList()}>
              重试
            </button>
          </div>
        ) : loading && items.length === 0 ? (
          <div className={s.empty}>加载中…</div>
        ) : items.length === 0 ? (
          <div className={s.empty}>暂无通知</div>
        ) : (
          items.map((n) => {
            const locatable = hasLocator(n) || n.ref_type === "project" || n.ref_type === "";
            return (
              <button
                key={n.id}
                type="button"
                className={`${s.item} ${n.read ? "" : s.unreadItem}`}
                disabled={busyId === n.id}
                onClick={() => void openItem(n)}
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
          })
        )}
      </div>
      <footer className={s.foot}>
        {!showHeader && (
          <button
            type="button"
            className={s.link}
            onClick={readAll}
            disabled={unread === 0 || readAllBusy}
          >
            {readAllBusy ? "处理中…" : "全部已读"}
          </button>
        )}
        <button type="button" className={s.link} onClick={() => void loadList()} disabled={loading}>
          {loading ? "刷新中…" : "刷新"}
        </button>
        {canApprove && (
          <button
            type="button"
            className={s.link}
            onClick={() => {
              onNavigate?.();
              router.push("/approvals");
            }}
          >
            前往审批中心 →
          </button>
        )}
      </footer>
    </section>
  );
}
