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
    <div className="card" style={{ maxWidth: 560 }}>
      <h3 className="section-title" style={{ marginTop: 0 }}>页面出错了</h3>
      <p className="muted" style={{ fontSize: 13 }}>
        {error.message || "发生了未知错误"}{" "}
        {error.digest && <span className="mono tiny">({error.digest})</span>}
      </p>
      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <button className="btn-primary" style={{ width: "auto" }} onClick={reset}>重试</button>
        <button className="btn-ghost" onClick={() => window.location.assign("/dashboard")}>回到工作台</button>
      </div>
    </div>
  );
}
