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

/**
 * 三档显示模式选择（BLF-1292）。
 *
 * 三挡是「同一条轨道上的三个位置」，所以选中态不再由 `.option.selected` 自己画背景 +
 * 描边（旧实现是旧高亮消失、新高亮出现，切换时闪两下），而是交给 `.thumb`：一条指示条
 * 从旧挡**平移**到新挡（460ms）。位置由 `data-active-index` → CSS 变量 `--active-index`
 * 驱动，这里只负责把当前挡位如实写上去。
 */
export default function ThemeModePicker({ mode, onChange }: { mode: ThemeMode; onChange: (mode: ThemeMode) => void }) {
  const activeIndex = Math.max(
    0,
    OPTIONS.findIndex((option) => option.value === mode),
  );

  return (
    <div className={styles.picker} role="group" aria-label="显示模式" data-active-index={activeIndex}>
      <div className={styles.title}>显示模式</div>
      <div className={styles.options}>
        <span className={styles.thumb} aria-hidden="true" />
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
              {/* 图标单独包一层：换挡时让图标轻轻转进来，而不是整块文字跟着动 */}
              <span className={styles.icon}>
                <ModeIcon mode={option.value} />
              </span>
              <span>{option.label}</span>
              {selected && <span className={styles.dot} aria-hidden="true" />}
            </button>
          );
        })}
      </div>
    </div>
  );
}
