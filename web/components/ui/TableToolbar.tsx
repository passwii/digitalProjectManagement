"use client";

import st from "./TableToolbar.module.css";

export default function TableToolbar({
  children,
  onExport,
  exportLabel = "导出",
}: {
  children?: React.ReactNode;
  onExport?: () => void;
  exportLabel?: string;
}) {
  return (
    <div className={st.bar}>
      <div className={st.filters}>{children}</div>
      <div className={st.right}>
        <span className={st.density} title="密度：紧凑（固定行高 40px，本期唯一密度）">紧凑</span>
        <button className="btn-ghost" onClick={onExport ?? (() => alert("导出占位：与报表口径对齐后接入"))}>
          {exportLabel}
        </button>
      </div>
    </div>
  );
}
