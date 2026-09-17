"use client";

import { useState } from "react";
import st from "./PasswordInput.module.css";

export default function PasswordInput({
  id,
  value,
  onChange,
  placeholder,
  autoComplete,
  disabled,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  autoComplete?: string;
  disabled?: boolean;
}) {
  const [visible, setVisible] = useState(false);

  return (
    <div className={st.wrap}>
      <input
        id={id}
        type={visible ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete={autoComplete}
        disabled={disabled}
      />
      <button
        type="button"
        className={st.toggle}
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? "隐藏密码" : "显示密码"}
        aria-pressed={visible}
        title={visible ? "隐藏密码" : "显示密码"}
        disabled={disabled}
      >
        {visible ? (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3 3l18 18" />
            <path d="M10.6 10.7a2 2 0 0 0 2.7 2.7" />
            <path d="M9.9 4.2A10.4 10.4 0 0 1 12 4c5.5 0 9 6 9 8a10.5 10.5 0 0 1-2.2 3.3" />
            <path d="M6.3 6.3A11.8 11.8 0 0 0 3 12c0 2 3.5 8 9 8a9.8 9.8 0 0 0 4.2-.9" />
          </svg>
        ) : (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3 12s3.5-7 9-7 9 7 9 7-3.5 7-9 7-9-7-9-7z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        )}
      </button>
    </div>
  );
}
