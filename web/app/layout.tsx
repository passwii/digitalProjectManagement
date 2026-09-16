import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "数慧致科OA管理平台",
    template: "%s · 数慧致科OA管理平台",
  },
  description: "数慧致科项目台账、进度、合同与支出一体化管理平台",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
