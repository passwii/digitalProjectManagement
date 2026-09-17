"use client";

import { forwardRef, useId, useState } from "react";
import st from "./PasswordInput.module.css";

type PasswordInputProps = {
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: "current-password" | "new-password";
  enterKeyHint: "go" | "next" | "done";
  error?: string;
  hint?: string;
  disabled?: boolean;
};

const PasswordInput = forwardRef<HTMLInputElement, PasswordInputProps>(function PasswordInput({
  label,
  value,
  onChange,
  autoComplete,
  enterKeyHint,
  error,
  hint,
  disabled,
}, ref) {
  const id = useId();
  const [visible, setVisible] = useState(false);

  return (
    <div className={`field ${st.field}`}>
      <label className="field-label" htmlFor={id}>{label}</label>
      <div className={st.control}>
        <input
          ref={ref}
          id={id}
          type={visible ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete={autoComplete}
          enterKeyHint={enterKeyHint}
          disabled={disabled}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
        />
        <button
          type="button"
          className={st.toggle}
          aria-label={visible ? `隐藏${label}` : `显示${label}`}
          disabled={disabled}
          onClick={() => setVisible((v) => !v)}
        >
          {visible ? "隐藏" : "显示"}
        </button>
      </div>
      {error ? (
        <span id={`${id}-error`} className="field-err" role="alert">{error}</span>
      ) : hint ? (
        <span id={`${id}-hint`} className="field-hint">{hint}</span>
      ) : null}
    </div>
  );
});

export default PasswordInput;
