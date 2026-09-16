"use client";
import st from "./Pagination.module.css";

export default function Pagination({
  page,
  size,
  total,
  onChange,
  onSizeChange,
}: {
  page: number;
  size: number;
  total: number;
  onChange: (page: number) => void;
  onSizeChange?: (size: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / size));
  const from = total === 0 ? 0 : (page - 1) * size + 1;
  const to = Math.min(page * size, total);

  return (
    <div className={st.wrap}>
      <span className={st.info}>
        共 <b className="mono">{total}</b> 条，当前 {from}-{to}
      </span>
      <div className={st.right}>
        {onSizeChange && (
          <select className={st.size} value={size} onChange={(e) => onSizeChange(Number(e.target.value))} aria-label="每页条数">
            {[20, 50, 100].map((s) => <option key={s} value={s}>{s} 条/页</option>)}
          </select>
        )}
        <button className={st.btn} disabled={page <= 1} onClick={() => onChange(1)} aria-label="首页">«</button>
        <button className={st.btn} disabled={page <= 1} onClick={() => onChange(page - 1)}>上一页</button>
        <span className={st.page}>
          <span className="mono">{page}</span> / <span className="mono">{pages}</span>
        </span>
        <button className={st.btn} disabled={page >= pages} onClick={() => onChange(page + 1)}>下一页</button>
        <button className={st.btn} disabled={page >= pages} onClick={() => onChange(pages)} aria-label="末页">»</button>
      </div>
    </div>
  );
}
