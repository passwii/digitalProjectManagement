import type { Metadata } from "next";
import SparkShell from "@/components/spark/SparkShell";

export const metadata: Metadata = {
  title: { absolute: "云电竞管理平台" },
  description: "云电竞管理平台运营、门店、算力和安全管理 mock 演示站",
};

export default function SparkLayout({ children }: { children: React.ReactNode }) {
  return <SparkShell>{children}</SparkShell>;
}
