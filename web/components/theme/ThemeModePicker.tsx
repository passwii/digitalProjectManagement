import styles from "./ThemeModePicker.module.css";
import type { ThemeMode } from "./theme";

const OPTIONS: Array<{ value: ThemeMode; label: string; detail: string }> = [
  { value: "light", label: "浅色", detail: "明亮工作面" },
  { value: "dark", label: "深色", detail: "夜间工作面" },
  { value: "system", label: "跟随系统", detail: "按设备偏好" },
];

function ModeIcon({ mode }: { mode: ThemeMode }) {
  if (mode === "light") {
    return (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
      </svg>
    );
  }
  if (mode === "dark") {
    return (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M20.5 15.3A8.5 8.5 0 0 1 8.7 3.5 8.6 8.6 0 1 0 20.5 15.3z" />
      </svg>
    );
  }
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 9h18M8 4v16" />
    </svg>
  );
}

export default function ThemeModePicker({ mode, onChange }: { mode: ThemeMode; onChange: (mode: ThemeMode) => void }) {
  return (
    <div className={styles.picker} role="group" aria-label="显示模式">
      <div className={styles.title}>显示模式</div>
      <div className={styles.options}>
        {OPTIONS.map((option) => {
          const selected = mode === option.value;
          return (
            <button
              key={option.value}
              type="button"
              role="menuitemradio"
              aria-checked={selected}
              aria-label={option.label}
              title={option.detail}
              className={`${styles.option} ${selected ? styles.selected : ""}`}
              onClick={() => onChange(option.value)}
            >
              <ModeIcon mode={option.value} />
              <span>{option.label}</span>
              {selected && <span className={styles.dot} aria-hidden="true" />}
            </button>
          );
        })}
      </div>
    </div>
  );
}
