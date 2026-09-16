// 页面级状态：加载骨架 / 加载失败重试 / 无权限提示。
// 用于管理、审批等受限页面对非管理员给出明确反馈，而不是让用户点到必然 403 的按钮。
import Link from "next/link";
import st from "./PageState.module.css";

/** 页面级加载骨架（对齐路由级 loading.tsx 的视觉） */
export function LoadingBlock({
  title = true,
  kpis = 4,
  label = "加载中…",
}: {
  title?: boolean;
  kpis?: number;
  label?: string;
}) {
  return (
    <div className={st.skelWrap} role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">{label}</span>
      {title && <div className="skel skel-title" />}
      {kpis > 0 && (
        <div className="skel-row">
          {Array.from({ length: kpis }, (_, i) => <div key={i} className="skel skel-kpi" />)}
        </div>
      )}
      <div className="skel skel-table" />
    </div>
  );
}

/** 加载失败 + 重试（权限同步失败时不误判为无权限） */
export function LoadFailed({
  message = "加载失败，请重试",
  onRetry,
}: {
  message?: string;
  onRetry?: () => void;
}) {
  return (
    <div className={`${st.wrap} ${st.danger}`} role="alert">
      <div className={st.icon} aria-hidden="true">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round">
          <path d="M12 8v5M12 16.5h.01" />
          <circle cx="12" cy="12" r="9" />
        </svg>
      </div>
      <div className={st.title}>加载失败</div>
      <div className={st.hint}>{message}</div>
      <div className={st.actions}>
        {onRetry && <button className="btn-primary" onClick={onRetry}>重试</button>}
        <Link className="btn-ghost" href="/dashboard">回到工作台</Link>
      </div>
    </div>
  );
}

/** 无权限：明确的说明 + 可继续使用的入口，避免用户以为系统出错 */
export function NoAccess({
  title = "无访问权限",
  hint,
  backHref = "/dashboard",
  backText = "回到工作台",
  extra,
}: {
  title?: string;
  hint?: React.ReactNode;
  backHref?: string;
  backText?: string;
  extra?: React.ReactNode;
}) {
  return (
    <div className={st.wrap}>
      <div className={st.icon} aria-hidden="true">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
          <rect x="4" y="10" width="16" height="10" rx="2" />
          <path d="M8 10V7a4 4 0 0 1 8 0v3" />
        </svg>
      </div>
      <div className={st.title}>{title}</div>
      {hint && <div className={st.hint}>{hint}</div>}
      <div className={st.actions}>
        <Link className="btn-ghost" href={backHref}>{backText}</Link>
        {extra}
      </div>
    </div>
  );
}
