"use client";
// 表单字段：label + 必填标记 + 错误/hint。与 globals.css 的 .form-grid / .field 配套。
export default function Field({
  label,
  required,
  error,
  hint,
  span,
  children,
}: {
  label: string;
  required?: boolean;
  error?: string;
  hint?: string;
  /** true = 占满整行（.span-2） */
  span?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className={`field ${span ? "span-2" : ""}`}>
      <span className="field-label">
        {label}
        {required && <b className="field-req" aria-hidden>*</b>}
      </span>
      {children}
      {error ? (
        <span className="field-err" role="alert">{error}</span>
      ) : hint ? (
        <span className="field-hint">{hint}</span>
      ) : null}
    </label>
  );
}
