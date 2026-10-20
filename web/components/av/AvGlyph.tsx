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
  /*
   * 主题切换图标（BLF-1398）。
   *
   * 两条硬约束：
   *   · **几何风格与既有图标一致**：24×24 viewBox、stroke="currentColor"、
   *     strokeWidth 1.7、圆头圆角，**直角几何**（不画填充的太阳、不画圆点云）；
   *   · **语义方向是「点击后要去的那个主题」** —— 深色下显示 `sun`（点了去浅色），
   *     浅色下显示 `moon`（点了去深色）。图标与 aria-label 同向，读屏用户听到的
   *     与看到的相反是这一类控件最容易犯的错。
   */
  sun: (
    <>
      <circle cx="12" cy="12" r="4.5" />
      <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3" />
      <path d="m5.3 5.3 2.1 2.1M16.6 16.6l2.1 2.1M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1" />
    </>
  ),
  moon: (
    <>
      {/*
        月牙：两段圆弧拼成的月牙（一段大弧 + 一段内弧），不是「圆盘挖一块」。
        起止点选在 12 点的正上方，这样它在 16px 的方按钮里是**光学居中**的
        —— 月牙的图形重心偏左下，但视觉上居中；用几何中心去摆会看着偏右下。
      */}
      <path d="M12 3.2a8.8 8.8 0 1 0 8.8 8.8A6.9 6.9 0 0 1 12 3.2Z" />
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
