"use client";

// 路由级错误边界：避免单页异常导致整站白屏
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="card route-state" role="alert">
      <h1 className="section-title route-state-title">页面出错了</h1>
      <p className="muted route-state-detail">
        {error.message || "发生了未知错误"}{" "}
        {error.digest && <span className="mono tiny">({error.digest})</span>}
      </p>
      <div className="route-state-actions">
        <button className="btn-primary" onClick={reset}>重试</button>
        <button className="btn-ghost" onClick={() => window.location.assign("/dashboard")}>回到工作台</button>
      </div>
    </div>
  );
}
