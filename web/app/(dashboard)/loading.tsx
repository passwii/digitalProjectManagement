// 路由切换骨架屏：避免白屏等待
export default function Loading() {
  return (
    <div>
      <div className="skel skel-title" />
      <div className="skel-row">
        {[0, 1, 2, 3].map((i) => <div key={i} className="skel skel-kpi" />)}
      </div>
      <div className="skel skel-bar" />
      <div className="skel skel-table" />
    </div>
  );
}
