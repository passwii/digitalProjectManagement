"use client";
// 列表工具栏：左侧筛选槽 + 右侧主操作、说明与导出按钮。
//
// 没有传 `onExport` 时**不渲染导出按钮**——之前是一个 `alert("导出占位")`，
// 点下去只弹一个对话框、什么也不发生，属于「无意义的占位导出提示」（BLF-1093）。
import st from "./TableToolbar.module.css";

export default function TableToolbar({
  children,
  action,
  onExport,
  exportLabel = "导出",
  exportHint,
  exportError,
  exporting = false,
}: {
  children?: React.ReactNode;
  /** 页面主操作，例如「新建项目」，渲染在工具栏最右侧 */
  action?: React.ReactNode;
  /** 未传则不显示导出按钮（而不是显示一个点了没反应的占位按钮） */
  onExport?: () => void;
  exportLabel?: string;
  /** 导出前需要满足的条件说明（例如「需先选择项目」），未满足时禁用并说明原因 */
  exportHint?: string;
  /** 上一次导出的失败原因，成功或从未导出时为空 */
  exportError?: string;
  exporting?: boolean;
}) {
  const disabled = !onExport || !!exportHint || exporting;
  return (
    <div className={st.bar}>
      <div className={st.filters}>{children}</div>
      <div className={st.right} data-toolbar-right="true">
        {action && <div className={st.action}>{action}</div>}
        {onExport !== undefined && (
          <button
            type="button"
            className="btn-ghost"
            onClick={onExport}
            disabled={disabled}
            title={exportHint || (exporting ? "正在导出…" : undefined)}
            aria-busy={exporting}
          >
            {exporting ? "导出中…" : exportLabel}
          </button>
        )}
        {exportHint && !exportError && (
          <span className={st.hint} role="status">{exportHint}</span>
        )}
        {exportError && (
          <span className={st.error} role="alert">导出失败：{exportError}</span>
        )}
      </div>
    </div>
  );
}
