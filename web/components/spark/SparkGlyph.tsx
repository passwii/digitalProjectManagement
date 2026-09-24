import type { ReactNode } from "react";
import type { SparkIconName } from "@/lib/spark/navigation";

const GLYPHS: Record<SparkIconName, ReactNode> = {
  spark: <><path d="m13 2-3 8h7l-6 12 2-9H6l7-11Z" /></>,
  menu: <><path d="M4 6h16M4 12h16M4 18h16" /></>,
  back: <><path d="m14 18-6-6 6-6" /><path d="M8 12h12" /></>,
  collapse: <><path d="m14 6-6 6 6 6" /><path d="M19 4v16" /></>,
  dashboard: <><rect x="3" y="3" width="8" height="8" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" /><rect x="14" y="11" width="7" height="10" rx="1.5" /><rect x="3" y="14" width="8" height="7" rx="1.5" /></>,
  store: <><path d="M3 10h18l-1.5-6h-15L3 10Z" /><path d="M5 10v10h14V10M9 20v-6h6v6" /></>,
  compute: <><rect x="6" y="6" width="12" height="12" rx="2" /><path d="M9 2v4m6-4v4M9 18v4m6-4v4M2 9h4m-4 6h4m12-6h4m-4 6h4M10 10h4v4h-4z" /></>,
  billing: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 10h18m-13 5h3" /></>,
  content: <><path d="M6 8h12a3 3 0 0 1 2.9 2.2l1 4A2.3 2.3 0 0 1 19.7 17h-1.1l-2.2-2h-8l-2.2 2H5a2.3 2.3 0 0 1-2.2-2.8l1-4A3 3 0 0 1 6 8Z" /><path d="M7 11v3m-1.5-1.5h3M16.5 12h.01M18.5 14h.01" /></>,
  security: <><path d="M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11Z" /><path d="m9 12 2 2 4-4" /></>,
  ops: <><path d="M14.7 6.3a5 5 0 0 0-6.4 6.4L3 18l3 3 5.3-5.3a5 5 0 0 0 6.4-6.4L15 13l-4-4 3.7-2.7Z" /></>,
  permission: <><circle cx="8" cy="15" r="4" /><path d="m11 12 8-8 3 3-2 2-2-1-2 2-1-1-3 3" /></>,
};

export default function SparkGlyph({ name, size = 18, className }: { name: SparkIconName; size?: number; className?: string }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {GLYPHS[name]}
    </svg>
  );
}
