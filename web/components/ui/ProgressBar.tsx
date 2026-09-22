import st from "./ProgressBar.module.css";

export type BarTone = "auto" | "brand" | "warn" | "danger" | "done";

/** 列表内联 4px 进度条；auto 按阈值三色：<60 蓝 / 60–80 琥珀 / >80 红（含 80% 预警口径） */
export default function ProgressBar({ value, tone = "auto" }: { value: number; tone?: BarTone }) {
  const v = Math.max(0, Math.min(100, Math.round(value)));
  const cls = tone === "auto" ? (v >= 80 ? st.danger : v >= 60 ? st.warn : st.brand) : st[tone];
  return (
    <span className={st.wrap} role="progressbar" aria-valuenow={v} aria-valuemin={0} aria-valuemax={100} title={`${v}%`}>
      <span className={`${st.track}`}>
        <span className={`${st.fill} ${cls}`} style={{ transform: `scaleX(${v / 100})` }} />
      </span>
      <span className={`mono ${st.label}`}>{v}%</span>
    </span>
  );
}
