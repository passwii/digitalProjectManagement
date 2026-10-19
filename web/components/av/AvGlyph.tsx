import type { AvIconName } from "@/lib/av/navigation";

const PATHS: Record<AvIconName, React.ReactNode> = {
  overview: (
    <>
      <rect x="3" y="3" width="7.5" height="7.5" />
      <rect x="13.5" y="3" width="7.5" height="4.5" />
      <rect x="13.5" y="11" width="7.5" height="10" />
      <rect x="3" y="14" width="7.5" height="7" />
    </>
  ),
  monitor: (
    <>
      <rect x="3" y="5" width="12" height="10" />
      <path d="M15 8.5 21 5v14l-6-3.5z" />
    </>
  ),
  alarm: (
    <>
      <path d="M6 9a6 6 0 0 1 12 0c0 4 1.5 5.5 1.5 5.5H4.5S6 13 6 9Z" />
      <path d="M9.5 18a2.5 2.5 0 0 0 5 0" />
    </>
  ),
  event: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  device: (
    <>
      <rect x="3" y="4" width="18" height="12" />
      <path d="M8 20h8M12 16v4" />
      <path d="M7 10.5h2M11 8.5v4M15 10.5h2" />
    </>
  ),
  capability: (
    <>
      <rect x="7" y="7" width="10" height="10" />
      <path d="M10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4" />
    </>
  ),
  wave: (
    <>
      <path d="M3 12h2l1.5-5 2 10 2-13 2 16 2-11 1.5 3H21" />
    </>
  ),
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  back: (
    <>
      <path d="M10 5 4 12l6 7" />
      <path d="M4 12h16" />
    </>
  ),
  collapse: <path d="m14 6-6 6 6 6" />,
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4.5 4.5" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7v5l3.5 2" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 20a7 7 0 0 1 14 0" />
    </>
  ),
  chip: (
    <>
      <rect x="6" y="6" width="12" height="12" />
      <rect x="10" y="10" width="4" height="4" />
      <path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3" />
    </>
  ),
};

export default function AvGlyph({
  name,
  size = 18,
  className,
}: {
  name: AvIconName;
  size?: number;
  className?: string;
}) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
