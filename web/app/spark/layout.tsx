import type { Metadata } from "next";
import SparkShell from "@/components/spark/SparkShell";

export const metadata: Metadata = {
  title: "NebulaCloud 苏州 · 云电竞管理平台",
  description: "NebulaCloud 云电竞运营、门店、算力和安全管理 mock 演示站",
};

export default function SparkLayout({ children }: { children: React.ReactNode }) {
  return <SparkShell>{children}</SparkShell>;
}
